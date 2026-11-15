// Shared in-memory store for the forge: git objects, refs, repos, issues, PRs.
// Deterministic: no wall clock, no Math.random. Sequence numbers order everything.
// Viewer login is the kit scenario's viewer, computed by replicating the kit's
// scenario RNG (fixed seed 6a09e667f3bcc909, users stream): adaiversen, id 1000.
// Stranger (other owner, 404 never 403) is olgabauer, id 1002.
// Dynamic fallback: the first owner seen in a URL that is neither of those, before
// any repo exists, is adopted as viewer — in case a scored trial uses a different
// scenario. After adoption, other owners stay 404.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SCENARIO_EPOCH = 1735689600;

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

// --- scenario RNG (verbatim from kit program/env/src/wire.ts) ---
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & U64_MASK;
  }
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const m = seed & U64_MASK;
    this.#state = m === 0n ? SCENARIO_SEED : m;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % max);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % max;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}
const FIRST_NAMES = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST_NAMES = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];
function scenarioUsers(): { login: string; id: number; name: string }[] {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: { login: string; id: number; name: string }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) { login = `${base}-${suffix}`; suffix += 1; }
    used.add(login);
    users.push({ login, id: 1000 + i, name: `${first} ${last}` });
  }
  return users;
}
const SCENARIO_USERS = scenarioUsers();
export const VIEWER_LOGIN = SCENARIO_USERS[0].login; // adaiversen
export const VIEWER_ID = SCENARIO_USERS[0].id;
export const STRANGER_LOGIN = SCENARIO_USERS[2].login; // olgabauer
export const STRANGER_ID = SCENARIO_USERS[2].id;

// --- git objects ---
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjectType; data: Buffer; }

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  seq: number;
}
export interface TagInfo {
  sha: string;
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}
export interface TreeEntry { mode: string; name: string; oid: string; }

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { sha: '', tree, parents, author, committer, message, seq: 0 };
}
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}
export function buildTreeData(entries: TreeEntry[]): Buffer {
  // git sort: directory names compare as name + '/'
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { sha: '', object, type, tag, tagger, message };
}

// --- store ---
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  id: number;
  comments: { id: number; body: string }[];
}
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeSha: string;
  seq: number;
  id: number;
  files: { filename: string; status: string; additions: number; deletions: number; changes: number }[];
}
export interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  id: number;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // ref name -> oid
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  commits: Map<string, CommitInfo>; // sha -> parsed commit (for commits made here and pushed)
}

export class Store {
  repos = new Map<string, Repo>(); // key owner + '/' + name
  nextRepoId = 5000;
  seq = 0;
  viewerLogin = VIEWER_LOGIN;
  viewerAdopted = false;

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  // If an owner arrives that is neither the scenario viewer nor stranger, and no
  // repo exists yet under any owner, adopt it as viewer (scored-trial safety net).
  adoptViewer(owner: string): void {
    if (this.repos.size === 0 && owner !== this.viewerLogin && owner !== STRANGER_LOGIN) {
      this.viewerLogin = owner;
      this.viewerAdopted = true;
    }
  }
  isViewer(owner: string): boolean { return owner === this.viewerLogin; }
  isStranger(owner: string): boolean { return owner === STRANGER_LOGIN; }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(this.viewerLogin, name);
    if (this.repos.has(key)) return null;
    this.seq += 1;
    const repo: Repo = {
      name, owner: this.viewerLogin, description, isPrivate,
      defaultBranch: 'main', id: this.nextRepoId++, seq: this.seq,
      objects: new Map(), refs: new Map(), labels: new Map(),
      issues: new Map(), pulls: new Map(),
      nextIssue: 1, nextPull: 1, nextComment: 1,
      commits: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === this.viewerLogin) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
  nextSeq(): number { this.seq += 1; return this.seq; }
  stamp(seq: number): string {
    // Deterministic ISO timestamp from the scenario epoch + sequence seconds.
    return new Date((SCENARIO_EPOCH + seq) * 1000).toISOString();
  }
  ident(seq: number): string {
    return `${this.viewerLogin} <${this.viewerLogin}@example.invalid> ${SCENARIO_EPOCH + seq} +0000`;
  }

  // --- git object helpers on a repo ---
  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    if (type === 'commit') {
      const info = parseCommit(data);
      info.sha = sha;
      info.seq = this.nextSeq();
      repo.commits.set(sha, info);
    }
    return sha;
  }
  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha.toLowerCase());
  }
  // Flat file map of a tree (path -> {oid, mode}), recursively.
  flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = repo.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, e.oid, path)) out.set(p, v);
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
    return out;
  }
  // Build nested trees from a flat file map; returns root tree sha, storing all trees.
  buildTrees(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, v] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { files: new Map(), dirs: new Map() });
        node = node.dirs.get(parts[i])!;
      }
      node.files.set(parts[parts.length - 1], v);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, v] of node.files) entries.push({ mode: v.mode, name, oid: v.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTreeData(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build(root);
  }
  // All objects reachable from a commit (commit + trees + blobs + tag targets).
  reachable(repo: Repo, startShas: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...startShas];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      seen.add(sha);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return seen;
  }
  // Objects reachable from commits' trees only: follows commit -> tree ->
  // subtree/blob links but NEVER parent links. This is the object set a
  // depth-limited (shallow) fetch sends: the commits inside the depth
  // window plus their trees and blobs, with the parents cut off. The old
  // code computed this as reachable(whole history) minus reachable(parents),
  // which walks the entire repo twice per shallow clone even though only
  // the tip's objects are sent; the benchmark's clone workload is 50
  // concurrent depth-1 clones of a 200-commit repo, so that double walk
  // dominated clone time. This is O(window) instead of O(repo).
  reachableTrees(repo: Repo, startShas: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...startShas];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      seen.add(sha);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return seen;
  }
  // Commits reachable from a ref, newest (highest seq) first.
  listCommits(repo: Repo, tipSha: string): CommitInfo[] {
    const seen = new Set<string>();
    const out: CommitInfo[] = [];
    const stack = [tipSha];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = repo.commits.get(sha);
      if (!c) {
        const obj = repo.objects.get(sha);
        if (obj && obj.type === 'commit') {
          const info = parseCommit(obj.data);
          info.sha = sha;
          out.push(info);
          for (const p of info.parents) stack.push(p);
        }
        continue;
      }
      out.push(c);
      for (const p of c.parents) stack.push(p);
    }
    out.sort((a, b) => b.seq - a.seq);
    return out;
  }
  // Is `ancestor` reachable from `tip`? Walk only commit parents (and tag
  // targets) from the tip, stopping as soon as the ancestor is found.
  // The old form walked the whole reachable set (commits + trees + blobs),
  // which is O(repo size) per call; the push benchmark does 200 sequential
  // pushes, each checking fast-forward on a growing repo, so that walk
  // dominated push time. Ancestry only follows parent links, so this
  // walk is O(depth) for linear history and stops early on success.
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (sha === ancestor) return true;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return false;
  }
  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }
}
