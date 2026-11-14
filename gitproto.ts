// Git wire protocol helpers: pkt-lines, packfiles, sideband.
// Stdlib only: node:zlib, node:crypto.
import { inflateSync, deflateSync } from 'node:zlib';
import { sha1 } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), payload]);
}
export const pktFlush = Buffer.from('0000', 'utf8');
export const pktDelim = Buffer.from('0001', 'utf8');
export const pktEnd = Buffer.from('0002', 'utf8');

export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }

// Parse a whole buffer into pkt-lines. Malformed input yields data packets as-is
// where possible; callers that need strictness check lengths themselves.
export function parsePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.subarray(i, i + 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}
export function pktLinesToText(pkts: Pkt[]): string[] {
  return pkts.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// --- packfiles ---
export interface PackObject { type: string; data: Buffer; }
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodePackObject(type: string, data: Buffer): Buffer {
  const code = TYPE_CODE[type];
  // Fastest compression level: packfile writes are on the hot path for
  // clone/fetch, and the ~15% larger output is cheap on a local socket.
  const compressed = deflateSync(data, { level: 1 });
  // varint header: low 4 bits size, then 7-bit chunks, type in bits 4-6 of first byte
  let size = data.length;
  const header: number[] = [];
  let first = (size & 0x0f) | (code << 4);
  size >>= 4;
  if (size > 0) first |= 0x80;
  header.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    header.push(b);
  }
  return Buffer.concat([Buffer.from(header), compressed]);
}

export function writePack(objects: { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0);
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const o of objects) parts.push(encodePackObject(o.type, o.data));
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

interface PackEntry { type: string; data: Buffer; offset: number; }
function readVarint(buf: Buffer, off: number): { type: number; size: number; next: number } {
  let b = buf[off];
  const type = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (b & 0x80) {
    b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { type, size, next: i };
}
// Apply a git delta (copy/insert stream) to a base buffer.
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const tgtSize = readVar();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) off |= delta[i++] << (bit * 8);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) size |= delta[i++] << (bit * 8);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      outLen += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      outLen += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgtSize || outLen !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult { objects: Map<string, PackObject>; deltaCount: number; }

// Decompress one zlib object starting at `start` and return the data plus
// the offset just past the stream. A single inflateSync with info:true
// reports exactly how many compressed bytes it consumed
// (engine.bytesWritten), so one decompression replaces the old binary
// search that re-inflated the object ~log2(pack) times. Falls back to
// the binary search if the engine does not report a usable length.
function inflateEnd(pack: Buffer, start: number): { data: Buffer; next: number } {
  try {
    const { buffer, engine } = inflateSync(pack.subarray(start), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten?: number } };
    const used = engine?.bytesWritten;
    if (typeof used === 'number' && used > 0 && start + used <= pack.length) {
      return { data: buffer, next: start + used };
    }
  } catch {
    // fall through to the binary search below
  }
  let lo = start;
  let hi = pack.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(pack.subarray(start, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(pack.subarray(start, lo));
  return { data, next: lo };
}

// Read a packfile; resolveBase supplies objects for thin-pack REF_DELTA bases
// the client already holds (by oid). OFS_DELTA bases come from this pack.
export function readPack(pack: Buffer, resolveBase?: (oid: string) => PackObject | undefined): ReadPackResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, PackObject>();
  const bySha = new Map<string, PackObject>();
  let deltaCount = 0;
  let off = 12;
  interface Delta { offset: number; baseOff?: number; baseOid?: string; delta: Buffer; }
  const deltas: Delta[] = [];
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const { type, size, next } = readVarint(pack, off);
    off = next;
    if (type === 6) {
      let b = pack[off++];
      let baseOff = b & 0x7f;
      while (b & 0x80) { b = pack[off++]; baseOff = ((baseOff + 1) << 7) | (b & 0x7f); }
      const baseOffset = start - baseOff;
      const { data, next: after } = inflateEnd(pack, off);
      off = after;
      deltas.push({ offset: start, baseOff: baseOffset, delta: data });
      deltaCount += 1;
      void size;
      continue;
    }
    if (type === 7) {
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data, next: after } = inflateEnd(pack, off);
      off = after;
      deltas.push({ offset: start, baseOid, delta: data });
      deltaCount += 1;
      void size;
      continue;
    }
    const typeName = CODE_TYPE[type];
    if (!typeName) throw new Error(`unknown pack object type ${type}`);
    const { data, next: after } = inflateEnd(pack, off);
    off = after;
    if (data.length !== size) throw new Error('pack object size mismatch');
    const obj: PackObject = { type: typeName, data };
    const sha = hashObject(typeName, data);
    objects.set(sha, obj);
    byOffset.set(start, obj);
    bySha.set(sha, obj);
  }
  const resolveOne = (d: Delta): PackObject | undefined => {
    let base: PackObject | undefined;
    if (d.baseOff !== undefined) base = byOffset.get(d.baseOff);
    else if (d.baseOid !== undefined) base = bySha.get(d.baseOid) ?? resolveBase?.(d.baseOid);
    if (!base) return undefined;
    const data = applyDelta(base.data, d.delta);
    return { type: base.type, data };
  };
  let remaining = deltas;
  for (let round = 0; round < deltas.length + 2 && remaining.length; round += 1) {
    const nextRemaining: Delta[] = [];
    for (const d of remaining) {
      const resolved = resolveOne(d);
      if (!resolved) { nextRemaining.push(d); continue; }
      const sha = hashObject(resolved.type, resolved.data);
      objects.set(sha, resolved);
      byOffset.set(d.offset, resolved);
      bySha.set(sha, resolved);
    }
    remaining = nextRemaining;
  }
  if (remaining.length) throw new Error('unresolved pack deltas');
  return { objects, deltaCount };
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}
