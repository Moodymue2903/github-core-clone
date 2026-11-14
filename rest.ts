// REST v3 handlers. All routes under /api/v3. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry {message}. Auth is checked by
// the caller (app.ts) except for the routes listed there.
import { Store, ZERO_OID, parseCommit, parseTree } from './store.ts';
import type { Repo } from './store.ts';

export interface Ctx {
  store: Store;
  reqId: string;
  host: string;
  method: string;
  path: string;
  query: URLSearchParams;
  bodyText: string;
  body: any;
}
export interface Reply { status: number; json: any; headers?: Record<string, string>; }

export function err(status: number, message: string): Reply {
  return { status, json: { message } };
}
export function ok(status: number, json: any, headers?: Record<string, string>): Reply {
  return { status, json, headers };
}
export function notFound(message = 'Not Found'): Reply { return err(404, message); }

export function globalId(kind: string, n: number): string {
  return Buffer.from(`${kind}:${n}`).toString('base64url');
}
export function repoJson(store: Store, repo: Repo): any {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === store.viewerLogin ? 1000 : 1002, type: 'User' },
    private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    created_at: store.stamp(repo.seq), updated_at: store.stamp(repo.seq),
    fork: false, archived: false, disabled: false,
  };
}
export function issueJson(store: Store, repo: Repo, issue: any): any {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, labels: issue.labels.map((name: string) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: store.viewerLogin, id: 1000 }, assignee: null, assignees: [], milestone: null,
    locked: false, comments: issue.comments.length,
    created_at: store.stamp(issue.seq), updated_at: store.stamp(issue.seq), closed_at: issue.state === 'closed' ? store.stamp(issue.seq) : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
export function pullJson(store: Store, repo: Repo, pr: any): any {
  return {
    id: pr.id, number: pr.number, title: pr.title, body: pr.body, state: pr.state,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}`, user: { login: repo.owner } },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}`, user: { login: repo.owner } },
    merged: pr.merged, merged_at: pr.merged ? pr.mergedAt : null, merge_commit_sha: pr.merged ? pr.mergeSha : null,
    mergeable: pr.merged ? false : mergeableState(store, repo, pr),
    user: { login: store.viewerLogin, id: 1000 }, draft: false, locked: false,
    created_at: store.stamp(pr.seq), updated_at: store.stamp(pr.seq), closed_at: pr.state === 'closed' ? store.stamp(pr.seq) : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}
export function mergeableState(store: Store, repo: Repo, pr: any): boolean {
  return !wouldConflict(store, repo, pr);
}
// Three-way conflict test: a path changed head-vs-base, whose current base
// version differs from both the original base version and the head version.
export function wouldConflict(store: Store, repo: Repo, pr: any): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!baseTip) return false;
  const baseCommit = repo.commits.get(pr.baseSha) ?? (repo.objects.get(pr.baseSha) ? parseCommit(repo.objects.get(pr.baseSha)!.data) : null);
  const headCommit = repo.commits.get(pr.headSha) ?? (repo.objects.get(pr.headSha) ? parseCommit(repo.objects.get(pr.headSha)!.data) : null);
  const curCommit = repo.commits.get(baseTip) ?? (repo.objects.get(baseTip) ? parseCommit(repo.objects.get(baseTip)!.data) : null);
  if (!baseCommit || !headCommit || !curCommit) return false;
  if (baseTip === pr.baseSha) return false;
  const baseFiles = store.flattenTree(repo, baseCommit.tree);
  const headFiles = store.flattenTree(repo, headCommit.tree);
  const curFiles = store.flattenTree(repo, curCommit.tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const p of paths) {
    const b = baseFiles.get(p)?.oid;
    const h = headFiles.get(p)?.oid;
    if (b === h) continue;
    const c = curFiles.get(p)?.oid;
    if (c !== b && c !== h) return true;
  }
  return false;
}
export function diffFiles(store: Store, repo: Repo, baseSha: string, headSha: string): any[] {
  const baseCommit = repo.commits.get(baseSha) ?? (repo.objects.get(baseSha) ? parseCommit(repo.objects.get(baseSha)!.data) : null);
  const headCommit = repo.commits.get(headSha) ?? (repo.objects.get(headSha) ? parseCommit(repo.objects.get(headSha)!.data) : null);
  if (!baseCommit || !headCommit) return [];
  const baseFiles = store.flattenTree(repo, baseCommit.tree);
  const headFiles = store.flattenTree(repo, headCommit.tree);
  const out: any[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const p of paths) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (b?.oid === h?.oid) continue;
    let additions = 0;
    let deletions = 0;
    let status = 'modified';
    const blobText = (oid?: string): string => {
      if (!oid) return '';
      const o = repo.objects.get(oid);
      return o ? o.data.toString('utf8') : '';
    };
    if (!b) { status = 'added'; additions = blobText(h?.oid).split('\n').filter((l) => l.length > 0).length || 1; }
    else if (!h) { status = 'removed'; deletions = blobText(b.oid).split('\n').filter((l) => l.length > 0).length || 1; }
    else {
      const bl = blobText(b.oid).split('\n');
      const hl = blobText(h.oid).split('\n');
      // LCS-based line diff (files here are small).
      const m = bl.length; const n = hl.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = m - 1; i >= 0; i -= 1) for (let j = n - 1; j >= 0; j -= 1) dp[i][j] = bl[i] === hl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      let i = 0; let j = 0;
      while (i < m && j < n) {
        if (bl[i] === hl[j]) { i += 1; j += 1; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { deletions += 1; i += 1; }
        else { additions += 1; j += 1; }
      }
      deletions += m - i; additions += n - j;
      if (additions === 0 && deletions === 0) { additions = 1; }
    }
    out.push({ filename: p, status, additions, deletions, changes: additions + deletions });
  }
  out.sort((a, b) => a.filename < b.filename ? -1 : 1);
  return out;
}
// Create a commit on a branch from a flat file map.
export function commitFiles(store: Store, repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const treeSha = store.buildTrees(repo, files);
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const seq = store.nextSeq();
  const author = store.ident(seq);
  const lines = [`tree ${treeSha}`];
  if (parent) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${author}`, '', message);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  const sha = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}
function branchTipFiles(store: Store, repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const c = repo.commits.get(tip) ?? (repo.objects.get(tip) ? parseCommit(repo.objects.get(tip)!.data) : null);
  if (!c) return new Map();
  return store.flattenTree(repo, c.tree);
}
function linkHeader(ctx: Ctx, basePath: string, page: number, perPage: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const next = `http://${ctx.host}${basePath}?per_page=${perPage}&page=${page + 1}`;
  return { link: `<${next}>; rel="next"` };
}

export function handleRest(ctx: Ctx): Reply | null {
  const { store } = ctx;
  const p = ctx.path;
  if (!p.startsWith('/api/v3')) return null;
  const rest = p.slice('/api/v3'.length) || '/';
  const m = ctx.method;
  const q = ctx.query;

  // GET /api/v3/  (also handled in app.ts starter route; keep here for parity)
  if (m === 'GET' && (rest === '/' || rest === '')) {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (m === 'GET' && rest === '/meta') return ok(200, { installed_version: '1.0.0' });
  if (m === 'GET' && rest === '/user') {
    return ok(200, { login: store.viewerLogin, id: 1000, type: 'User', name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid` });
  }
  if (m === 'GET' && rest === '/rate_limit') return ok(200, { rate: { limit: 5000, remaining: 4999, reset: 1735689600 } });

  // POST /user/repos ; GET /user/repos
  if (rest === '/user/repos') {
    if (m === 'POST') {
      const name = ctx.body?.name;
      if (typeof name !== 'string' || !name) return err(422, 'name is required');
      if (store.getRepo(store.viewerLogin, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, typeof ctx.body?.description === 'string' ? ctx.body.description : '', ctx.body?.private === true)!;
      return ok(201, repoJson(store, repo));
    }
    if (m === 'GET') {
      const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
      const all = store.listViewerRepos();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const hasNext = page * perPage < all.length;
      return ok(200, slice.map((r) => repoJson(store, r)), linkHeader(ctx, '/api/v3/user/repos', page, perPage, hasNext));
    }
    return err(405, 'Method Not Allowed');
  }

  // /repos/{owner}/{repo}...
  const repoMatch = rest.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/);
  if (!repoMatch) return null;
  const [, owner, repoName, tail] = repoMatch;
  store.adoptViewer(owner);
  if (!store.isViewer(owner)) return notFound('Not Found');
  const repo = store.getRepo(owner, repoName);
  if (tail === '' || tail === '/') {
    if (m === 'GET') {
      if (!repo) return notFound();
      return ok(200, repoJson(store, repo));
    }
    if (m === 'PATCH') {
      if (!repo) return notFound();
      if (typeof ctx.body?.description === 'string') repo.description = ctx.body.description;
      return ok(200, repoJson(store, repo));
    }
    if (m === 'DELETE') {
      if (!repo) return notFound();
      store.deleteRepo(owner, repoName);
      return { status: 204, json: null };
    }
    return err(405, 'Method Not Allowed');
  }
  if (!repo) return notFound();

  // git refs
  if (tail === '/git/refs' && m === 'POST') {
    const ref = ctx.body?.ref;
    const sha = ctx.body?.sha;
    if (typeof ref !== 'string' || typeof sha !== 'string') return err(422, 'ref and sha are required');
    if (!repo.objects.has(sha.toLowerCase()) && !repo.commits.has(sha.toLowerCase())) return err(422, 'sha does not exist');
    repo.refs.set(ref, sha.toLowerCase());
    return ok(201, { ref, sha: sha.toLowerCase(), object: { sha: sha.toLowerCase() }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}` });
  }
  const refGet = tail.match(/^\/git\/refs\/(.+)$/);
  if (refGet && m === 'GET') {
    const ref = decodeURIComponent(refGet[1]);
    const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
    if (!sha) return notFound();
    return ok(200, { ref: ref.startsWith('refs/') ? ref : `refs/${ref}`, sha, object: { sha }, commit: { sha } });
  }
  if (tail === '/branches' && m === 'GET') {
    const out: any[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      const name = ref.slice('refs/heads/'.length);
      const c = repo.commits.get(sha);
      out.push({ name, commit: { sha, commit: c ? { message: c.message } : { message: '' } }, protected: false });
    }
    out.sort((a, b) => a.name < b.name ? -1 : 1);
    return ok(200, out);
  }
  const branchGet = tail.match(/^\/branches\/([^/]+)$/);
  if (branchGet && m === 'GET') {
    const name = decodeURIComponent(branchGet[1]);
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (!sha) return notFound();
    const c = repo.commits.get(sha);
    return ok(200, { name, commit: { sha, commit: c ? { message: c.message } : { message: '' } }, protected: false });
  }
  if (tail === '/commits' && m === 'GET') {
    const refName = q.get('sha');
    const branch = refName ? (refName.startsWith('refs/heads/') ? refName.slice(11) : refName) : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? (repo.objects.has(refName ?? '') ? refName : undefined);
    if (!tip) return ok(200, []);
    const commits = store.listCommits(repo, tip);
    return ok(200, commits.map((c) => ({
      sha: c.sha, commit: { message: c.message, author: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: store.stamp(c.seq) }, committer: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: store.stamp(c.seq) } },
      author: { login: store.viewerLogin }, committer: { login: store.viewerLogin },
      parents: c.parents.map((s) => ({ sha: s })), tree: { sha: c.tree },
    })));
  }

  // contents
  if (tail.startsWith('/contents/')) {
    const rawPath = decodeURIComponent(tail.slice('/contents/'.length));
    const path = rawPath.replace(/^\/+/, '');
    const refName = q.get('ref');
    const branch = refName ? (refName.startsWith('refs/heads/') ? refName.slice(11) : refName) : repo.defaultBranch;
    if (m === 'GET') {
      const files = branchTipFiles(store, repo, branch);
      // Exact file?
      const f = files.get(path);
      if (f) {
        const blob = repo.objects.get(f.oid);
        const content = blob ? blob.data.toString('base64') : '';
        return ok(200, { type: 'file', encoding: 'base64', size: blob ? blob.data.length : 0, name: path.split('/').pop(), path, content, sha: f.oid });
      }
      // Directory?
      const prefix = path === '' ? '' : `${path}/`;
      const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
      for (const [fp, v] of files) {
        if (!fp.startsWith(prefix)) continue;
        const restPath = fp.slice(prefix.length);
        const first = restPath.split('/')[0];
        if (restPath.includes('/')) {
          if (!children.has(first)) children.set(first, { oid: '', mode: '40000', isDir: true });
        } else {
          children.set(first, { oid: v.oid, mode: v.mode, isDir: false });
        }
      }
      if (children.size === 0) return notFound();
      const out: any[] = [];
      for (const [name, v] of children) {
        let sha = v.oid;
        if (v.isDir) {
          const sub = new Map<string, { oid: string; mode: string }>();
          for (const [fp, fv] of files) if (fp.startsWith(`${prefix}${name}/`)) sub.set(fp.slice(`${prefix}${name}/`.length), fv);
          sha = store.buildTrees(repo, sub);
        }
        out.push({ type: v.isDir ? 'dir' : 'file', name, path: prefix + name, sha, size: v.isDir ? 0 : (repo.objects.get(v.oid)?.data.length ?? 0) });
      }
      out.sort((a, b) => a.name < b.name ? -1 : 1);
      return ok(200, out);
    }
    if (m === 'PUT') {
      if (typeof ctx.body?.content !== 'string' || typeof ctx.body?.message !== 'string') return err(422, 'message and content are required');
      const content = Buffer.from(ctx.body.content.replace(/\s/g, ''), 'base64');
      const files = branchTipFiles(store, repo, ctx.body?.branch ? String(ctx.body.branch) : branch);
      const targetBranch = ctx.body?.branch ? String(ctx.body.branch) : branch;
      const existing = files.get(path);
      if (ctx.body?.sha) {
        if (!existing || existing.oid.toLowerCase() !== String(ctx.body.sha).toLowerCase()) return err(409, 'sha does not match the current file');
      }
      const blobSha = store.putObject(repo, 'blob', content);
      const nextFiles = new Map(files);
      nextFiles.set(path, { oid: blobSha, mode: '100644' });
      const commitSha = commitFiles(store, repo, targetBranch, nextFiles, ctx.body.message);
      return ok(existing ? 200 : 201, { content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64' }, commit: { sha: commitSha } });
    }
    if (m === 'DELETE') {
      const files = branchTipFiles(store, repo, branch);
      const existing = files.get(path);
      if (!existing) return notFound();
      if (ctx.body?.sha && String(ctx.body.sha).toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
      const nextFiles = new Map(files);
      nextFiles.delete(path);
      const commitSha = commitFiles(store, repo, branch, nextFiles, typeof ctx.body?.message === 'string' ? ctx.body.message : 'Delete file');
      return ok(200, { commit: { sha: commitSha } });
    }
    return err(405, 'Method Not Allowed');
  }

  // labels
  if (tail === '/labels') {
    if (m === 'POST') {
      const name = ctx.body?.name;
      if (typeof name !== 'string' || !name) return err(422, 'name is required');
      const color = typeof ctx.body?.color === 'string' ? ctx.body.color : 'ededed';
      repo.labels.set(name, { name, color });
      return ok(201, { name, color });
    }
    if (m === 'GET') return ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    return err(405, 'Method Not Allowed');
  }

  // issues
  if (tail === '/issues' && m === 'POST') {
    const labels: string[] = Array.isArray(ctx.body?.labels) ? ctx.body.labels : [];
    for (const l of labels) if (!repo.labels.has(l)) return err(422, `label ${l} does not exist`);
    const seq = store.nextSeq();
    const issue: any = { number: repo.nextIssue++, title: ctx.body?.title ?? '', body: ctx.body?.body ?? '', state: 'open', labels, seq, id: seq, comments: [] };
    repo.issues.set(issue.number, issue);
    return ok(201, issueJson(store, repo, issue));
  }
  if (tail === '/issues' && m === 'GET') {
    let list = [...repo.issues.values()];
    const state = q.get('state');
    if (state && state !== 'all') list = list.filter((i) => i.state === state);
    const sort = q.get('sort') ?? 'created';
    const dir = q.get('direction') ?? 'desc';
    if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.seq - b.seq : b.seq - a.seq);
    else list.sort((a, b) => dir === 'asc' ? a.number - b.number : b.number - a.number);
    const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
    const slice = list.slice((page - 1) * perPage, page * perPage);
    return ok(200, slice.map((i) => issueJson(store, repo, i)), linkHeader(ctx, `/api/v3/repos/${owner}/${repoName}/issues`, page, perPage, page * perPage < list.length));
  }
  const issueMatch = tail.match(/^\/issues\/(\d+)(\/comments)?$/);
  if (issueMatch) {
    const n = parseInt(issueMatch[1], 10);
    const issue: any = repo.issues.get(n);
    if (!issue) return notFound();
    if (issueMatch[2] === '/comments') {
      if (m === 'POST') {
        const id = repo.nextComment++;
        const comment = { id, body: ctx.body?.body ?? '' };
        issue.comments.push(comment);
        return ok(201, { id, body: comment.body, user: { login: store.viewerLogin, id: 1000 }, created_at: store.stamp(store.nextSeq()) });
      }
      if (m === 'GET') return ok(200, issue.comments.map((c: any) => ({ id: c.id, body: c.body, user: { login: store.viewerLogin, id: 1000 } })));
      return err(405, 'Method Not Allowed');
    }
    if (m === 'GET') return ok(200, issueJson(store, repo, issue));
    if (m === 'PATCH') {
      if (ctx.body?.state === 'open' || ctx.body?.state === 'closed') issue.state = ctx.body.state;
      if (typeof ctx.body?.title === 'string') issue.title = ctx.body.title;
      if (typeof ctx.body?.body === 'string') issue.body = ctx.body.body;
      return ok(200, issueJson(store, repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }

  // pulls
  if (tail === '/pulls' && m === 'POST') {
    const head = String(ctx.body?.head ?? '');
    const base = String(ctx.body?.base ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
    const seq = store.nextSeq();
    const pr: any = {
      number: repo.nextPull++, title: ctx.body?.title ?? '', body: ctx.body?.body ?? '', state: 'open',
      head, base, headSha, baseSha, merged: false, mergedAt: '', mergeSha: '', seq, id: seq,
      files: diffFiles(store, repo, baseSha, headSha),
    };
    repo.pulls.set(pr.number, pr);
    return ok(201, pullJson(store, repo, pr));
  }
  if (tail === '/pulls' && m === 'GET') {
    let list = [...repo.pulls.values()];
    const state = q.get('state');
    if (!state || state === 'open') list = list.filter((p) => p.state === 'open');
    else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
    list.sort((a, b) => b.seq - a.seq);
    return ok(200, list.map((p) => pullJson(store, repo, p)));
  }
  const pullMatch = tail.match(/^\/pulls\/(\d+)(\/(files|merge))?$/);
  if (pullMatch) {
    const n = parseInt(pullMatch[1], 10);
    const pr: any = repo.pulls.get(n);
    if (!pr) return notFound();
    if (pullMatch[3] === 'files' && m === 'GET') return ok(200, pr.files);
    if (pullMatch[3] === 'merge' && m === 'PUT') {
      if (pr.merged) return err(405, 'Pull request already merged');
      if (wouldConflict(store, repo, pr)) return err(405, 'Merge conflict');
      // Squash: apply head's changes onto current base tip.
      const baseTip = repo.refs.get(`refs/heads/${pr.base}`)!;
      const baseCommit = repo.commits.get(baseTip) ?? parseCommit(repo.objects.get(baseTip)!.data);
      const headCommit = repo.commits.get(pr.headSha) ?? parseCommit(repo.objects.get(pr.headSha)!.data);
      const origBaseCommit = repo.commits.get(pr.baseSha) ?? parseCommit(repo.objects.get(pr.baseSha)!.data);
      const baseFiles = store.flattenTree(repo, baseCommit.tree);
      const origFiles = store.flattenTree(repo, origBaseCommit.tree);
      const headFiles = store.flattenTree(repo, headCommit.tree);
      const mergedFiles = new Map(baseFiles);
      for (const [path, v] of headFiles) if (origFiles.get(path)?.oid !== v.oid) mergedFiles.set(path, v);
      for (const path of origFiles.keys()) if (!headFiles.has(path) && origFiles.get(path)) mergedFiles.delete(path);
      const mergeSha = commitFiles(store, repo, pr.base, mergedFiles, `Merge pull request #${pr.number} from ${pr.head}`);
      const seq = store.nextSeq();
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = store.stamp(seq);
      pr.mergeSha = mergeSha;
      return ok(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    }
    if (!pullMatch[3] && m === 'GET') return ok(200, pullJson(store, repo, pr));
    return err(405, 'Method Not Allowed');
  }

  return null;
}
