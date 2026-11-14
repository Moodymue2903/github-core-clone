// MCP over streamable HTTP: POST /mcp. JSON-RPC 2.0.
// Supports both the modern 2026-07-28 era (server/discover, no session) and the
// legacy initialize era. Tools operate on the same store as REST/GraphQL/git.
import { Store } from './store.ts';
import { diffFiles, commitFiles, wouldConflict } from './rest.ts';
import { parseCommit } from './store.ts';

const TOOLS = [
  { name: 'create_repo', description: 'Create a repository for the authenticated user', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with squash', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const ALIASES: Record<string, string> = {
  create_repository: 'create_repo', get_repository: 'get_repo', issue_create: 'create_issue',
  issues_list: 'list_issues', create_pr: 'create_pull_request', pr_merge: 'merge_pull_request',
  list_pull_requests: 'create_pull_request',
};
function resolveTool(name: string): any | undefined {
  const lower = String(name).toLowerCase();
  for (const t of TOOLS) if (t.name === lower) return t;
  if (ALIASES[lower]) return TOOLS.find((t) => t.name === ALIASES[lower]);
  for (const t of TOOLS) if (lower.endsWith(t.name) || lower.endsWith(`__${t.name}`)) return t;
  return undefined;
}
function pickArg(args: any, names: string[]): any {
  for (const n of names) if (args && args[n] !== undefined) return args[n];
  return undefined;
}
function toolResult(obj: any): any {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}
function toolError(message: string): any {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function callTool(store: Store, name: string, args: any): any {
  const tool = resolveTool(name);
  if (!tool) return { error: { code: -32602, message: `unknown tool ${name}` } };
  const owner = pickArg(args, ['owner', 'owner_login', 'org', 'login']);
  const repoName = pickArg(args, ['repo', 'repository', 'repo_name']);
  const title = pickArg(args, ['title', 'issue_title', 'pr_title']);
  const body = pickArg(args, ['body', 'description', 'content']);
  switch (tool.name) {
    case 'create_repo': {
      const repoNameArg = pickArg(args, ['name', 'repo', 'repository']);
      if (!repoNameArg) return { result: toolError('name is required') };
      const existing = store.getRepo(store.viewerLogin, String(repoNameArg));
      if (existing) return { result: toolResult({ id: existing.id, name: existing.name, full_name: `${existing.owner}/${existing.name}`, private: existing.isPrivate, default_branch: existing.defaultBranch }) };
      const repo = store.createRepo(String(repoNameArg), typeof body === 'string' ? body : '', args?.private === true)!;
      return { result: toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.isPrivate, default_branch: repo.defaultBranch }) };
    }
    case 'get_repo': {
      if (!owner || !repoName) return { result: toolError('owner and repo are required') };
      const repo = store.getRepo(String(owner), String(repoName));
      if (!repo) return { result: toolError('Repository not found') };
      return { result: toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.isPrivate, default_branch: repo.defaultBranch, description: repo.description }) };
    }
    case 'create_issue': {
      if (!owner || !repoName || !title) return { result: toolError('owner, repo and title are required') };
      const repo = store.getRepo(String(owner), String(repoName));
      if (!repo) return { result: toolError('Repository not found') };
      const seq = store.nextSeq();
      const issue: any = { number: repo.nextIssue++, title: String(title), body: typeof body === 'string' ? body : '', state: 'open', labels: [], seq, id: seq, comments: [] };
      repo.issues.set(issue.number, issue);
      return { result: toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: 'open' }) };
    }
    case 'list_issues': {
      if (!owner || !repoName) return { result: toolError('owner and repo are required') };
      const repo = store.getRepo(String(owner), String(repoName));
      if (!repo) return { result: toolError('Repository not found') };
      const state = pickArg(args, ['state']);
      let list = [...repo.issues.values()];
      if (state && state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return { result: toolResult(list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }))) };
    }
    case 'create_pull_request': {
      const head = pickArg(args, ['head', 'head_branch', 'source_branch']);
      const base = pickArg(args, ['base', 'base_branch', 'target']);
      if (!owner || !repoName || !title || !head || !base) return { result: toolError('owner, repo, title, head and base are required') };
      const repo = store.getRepo(String(owner), String(repoName));
      if (!repo) return { result: toolError('Repository not found') };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { result: toolError('head or base branch does not exist') };
      const seq = store.nextSeq();
      const pr: any = { number: repo.nextPull++, title: String(title), body: typeof body === 'string' ? body : '', state: 'open', head: String(head), base: String(base), headSha, baseSha, merged: false, mergedAt: '', mergeSha: '', seq, id: seq, files: diffFiles(store, repo, baseSha, headSha) };
      repo.pulls.set(pr.number, pr);
      return { result: toolResult({ id: pr.id, number: pr.number, title: pr.title, state: 'open', head: pr.head, base: pr.base, headRef: pr.head, baseRef: pr.base }) };
    }
    case 'merge_pull_request': {
      const num = pickArg(args, ['pull_number', 'pr_number', 'number']);
      if (!owner || !repoName || num === undefined) return { result: toolError('owner, repo and pull_number are required') };
      const repo = store.getRepo(String(owner), String(repoName));
      if (!repo) return { result: toolError('Repository not found') };
      const pr: any = repo.pulls.get(Number(num));
      if (!pr) return { result: toolError('Pull request not found') };
      if (pr.merged) return { result: toolError('Pull request already merged') };
      if (wouldConflict(store, repo, pr)) return { result: toolError('Merge conflict') };
      const baseTip = repo.refs.get(`refs/heads/${pr.base}`)!;
      const baseCommit = repo.commits.get(baseTip) ?? parseCommit(repo.objects.get(baseTip)!.data);
      const headCommit = repo.commits.get(pr.headSha) ?? parseCommit(repo.objects.get(pr.headSha)!.data);
      const origBaseCommit = repo.commits.get(pr.baseSha) ?? parseCommit(repo.objects.get(pr.baseSha)!.data);
      const baseFiles = store.flattenTree(repo, baseCommit.tree);
      const origFiles = store.flattenTree(repo, origBaseCommit.tree);
      const headFiles = store.flattenTree(repo, headCommit.tree);
      const mergedFiles = new Map(baseFiles);
      for (const [path, v] of headFiles) if (origFiles.get(path)?.oid !== v.oid) mergedFiles.set(path, v);
      for (const path of origFiles.keys()) if (!headFiles.has(path)) mergedFiles.delete(path);
      const mergeSha = commitFiles(store, repo, pr.base, mergedFiles, `Merge pull request #${pr.number} from ${pr.head}`);
      const seq = store.nextSeq();
      pr.state = 'closed'; pr.merged = true; pr.mergedAt = store.stamp(seq); pr.mergeSha = mergeSha;
      return { result: toolResult({ number: pr.number, pull_number: pr.number, merged: true, state: 'closed', sha: mergeSha }) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool ${name}` } };
  }
}

export interface McpReply { status: number; json: any; }
export function handleMcp(store: Store, body: any, headers: Record<string, string | undefined>): McpReply {
  if (!body || typeof body !== 'object') return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  const method = String(body.method ?? '');
  const id = body.id ?? null;
  const params = body.params ?? {};
  const ok = (result: any): McpReply => ({ status: 200, json: { jsonrpc: '2.0', id, result } });
  const err = (code: number, message: string): McpReply => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });
  if (method === 'server/discover') {
    return ok({ supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], serverInfo: { name: 'makefun-forge', version: '1.0.0' }, capabilities: { tools: {} } });
  }
  if (method === 'initialize') {
    const version = String(params.protocolVersion ?? '2026-07-28');
    if (!['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(version)) {
      return err(-32022, `Unsupported protocol version ${version}`);
    }
    return ok({ protocolVersion: version, serverInfo: { name: 'makefun-forge', version: '1.0.0' }, capabilities: { tools: {} } });
  }
  if (method === 'notifications/initialized') {
    return { status: 200, json: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'tools/list') {
    return ok({ tools: TOOLS, nextCursor: null });
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = params.arguments ?? {};
    const out = callTool(store, name, args);
    if (out.error) return err(out.error.code, out.error.message);
    return ok(out.result);
  }
  if (method === 'ping') return ok({});
  return err(-32601, `Method not found: ${method}`);
}
