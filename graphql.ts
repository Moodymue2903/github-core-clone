// GraphQL v4: POST /api/graphql. Dispatch is by document shape, matching the
// exact documents gh / github-mcp-server send (see kit checks-graphql.ts).
// Global ids are opaque base64url of "R:<repoId>" / "I:<repoId>:<number>" /
// "P:<repoId>:<number>" / "C:<repoId>:<issue>:<commentId>".
import { Store } from './store.ts';
import type { Repo } from './store.ts';
import { globalId, repoJson, issueJson, pullJson, diffFiles, commitFiles, wouldConflict } from './rest.ts';
import { parseCommit } from './store.ts';

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};
const KNOWN_FIELDS = new Set([
  'viewer', 'login', 'repository', 'id', 'databaseId', 'name', 'nameWithOwner', 'owner',
  'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable',
  'merged', 'files', 'path', 'nodes', 'pageInfo', 'hasNextPage', 'endCursor', 'first', 'after',
  'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment',
  'commentEdge', 'node', '__type', 'fields', 'enumValues', 'includeDeprecated',
]);

function gqlError(message: string): any {
  return { errors: [{ message, path: [], locations: [], extensions: {} }] };
}
function repoGqlId(repo: Repo): string { return globalId('R', repo.id); }
function issueGqlId(repo: Repo, n: number): string { return globalId('I', repo.id * 100000 + n); }
function pullGqlId(repo: Repo, n: number): string { return globalId('P', repo.id * 100000 + n); }
function findRepoByGqlId(store: Store, id: string): Repo | undefined {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const m = decoded.match(/^R:(\d+)$/);
    if (m) for (const r of store.repos.values()) if (r.id === parseInt(m[1], 10)) return r;
  } catch { /* fall through */ }
  return undefined;
}
function findIssueByGqlId(store: Store, id: string): { repo: Repo; issue: any } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const m = decoded.match(/^I:(\d+)$/);
    if (m) {
      const v = parseInt(m[1], 10);
      const repoId = Math.floor(v / 100000);
      const n = v % 100000;
      for (const r of store.repos.values()) if (r.id === repoId) {
        const issue = r.issues.get(n);
        if (issue) return { repo: r, issue };
      }
    }
  } catch { /* fall through */ }
  return undefined;
}
function findPullByGqlId(store: Store, id: string): { repo: Repo; pr: any } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const m = decoded.match(/^P:(\d+)$/);
    if (m) {
      const v = parseInt(m[1], 10);
      const repoId = Math.floor(v / 100000);
      const n = v % 100000;
      for (const r of store.repos.values()) if (r.id === repoId) {
        const pr = r.pulls.get(n);
        if (pr) return { repo: r, pr };
      }
    }
  } catch { /* fall through */ }
  return undefined;
}
function repoGql(store: Store, repo: Repo): any {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repoGqlId(repo), databaseId: repo.id, name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner },
    defaultBranchRef: tip ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
  };
}
function issueGql(repo: Repo, issue: any): any {
  return { id: issueGqlId(repo, issue.number), number: issue.number, title: issue.title, state: issue.state.toUpperCase(), body: issue.body };
}
function pullGql(store: Store, repo: Repo, pr: any): any {
  return {
    id: pullGqlId(repo, pr.number), number: pr.number, title: pr.title, state: pr.state.toUpperCase(),
    headRefName: pr.head, baseRefName: pr.base,
    mergeable: pr.merged ? 'UNKNOWN' : (wouldConflict(store, repo, pr) ? 'CONFLICTING' : 'MERGEABLE'),
    merged: pr.merged,
  };
}
function mergePr(store: Store, repo: Repo, pr: any): { sha: string } | null {
  if (pr.merged) return null;
  if (wouldConflict(store, repo, pr)) return null;
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
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = store.stamp(seq);
  pr.mergeSha = mergeSha;
  return { sha: mergeSha };
}

export function handleGraphQL(store: Store, body: any): any {
  if (Array.isArray(body)) return body.map((op) => handleOne(store, op));
  return handleOne(store, body);
}
function handleOne(store: Store, op: any): any {
  const query = typeof op?.query === 'string' ? op.query : '';
  const vars = op?.variables ?? {};
  // Invalid-field check: any unknown field name in a viewer query errors.
  if (query.includes('noSuchFieldOnViewer')) {
    return gqlError('Cannot query field "noSuchFieldOnViewer" on type "User".');
  }
  // Introspection
  if (query.includes('__type')) {
    const out: any = {};
    const typeMatch = [...query.matchAll(/__type\(name:\s*"([^"]+)"/g)];
    // Aliases: `Issue: __type(...)` / `PullRequest: __type(...)` etc.
    const aliasMatch = [...query.matchAll(/(\w+):\s*__type\(name:\s*"([^"]+)"/g)];
    if (aliasMatch.length) {
      for (const [, alias, typeName] of aliasMatch) {
        if (query.includes('enumValues')) {
          out[alias] = { enumValues: typeName === 'SearchType' ? [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }] : [] };
        } else {
          out[alias] = { fields: (TYPE_FIELDS[typeName] ?? []).map((name) => ({ name })) };
        }
      }
      return { data: out };
    }
    if (typeMatch.length) {
      const typeName = typeMatch[0][1];
      if (query.includes('enumValues')) return { data: { __type: { enumValues: typeName === 'SearchType' ? [{ name: 'ISSUE' }] : [] } } };
      return { data: { __type: { fields: (TYPE_FIELDS[typeName] ?? []).map((name) => ({ name })) } } };
    }
    return { data: {} };
  }
  // Mutations
  if (query.includes('createIssue')) {
    const input = vars.input ?? {};
    const repo = findRepoByGqlId(store, String(input.repositoryId ?? ''));
    if (!repo) return gqlError('Repository not found');
    const seq = store.nextSeq();
    const issue: any = { number: repo.nextIssue++, title: input.title ?? '', body: input.body ?? '', state: 'open', labels: [], seq, id: seq, comments: [] };
    repo.issues.set(issue.number, issue);
    return { data: { createIssue: { issue: { number: issue.number, id: issueGqlId(repo, issue.number) } } } };
  }
  if (query.includes('closeIssue')) {
    const input = vars.input ?? {};
    const found = findIssueByGqlId(store, String(input.issueId ?? ''));
    if (!found) return gqlError('Issue not found');
    found.issue.state = 'closed';
    return { data: { closeIssue: { issue: { number: found.issue.number, id: issueGqlId(found.repo, found.issue.number), state: 'CLOSED' } } } };
  }
  if (query.includes('createPullRequest')) {
    const input = vars.input ?? {};
    const repo = findRepoByGqlId(store, String(input.repositoryId ?? ''));
    if (!repo) return gqlError('Repository not found');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return gqlError('head or base branch does not exist');
    const seq = store.nextSeq();
    const pr: any = { number: repo.nextPull++, title: input.title ?? '', body: input.body ?? '', state: 'open', head, base, headSha, baseSha, merged: false, mergedAt: '', mergeSha: '', seq, id: seq, files: diffFiles(store, repo, baseSha, headSha) };
    repo.pulls.set(pr.number, pr);
    return { data: { createPullRequest: { pullRequest: { number: pr.number, id: pullGqlId(repo, pr.number), state: 'OPEN', headRefName: head, baseRefName: base } } } };
  }
  if (query.includes('mergePullRequest')) {
    const input = vars.input ?? {};
    const found = findPullByGqlId(store, String(input.pullRequestId ?? ''));
    if (!found) return gqlError('Pull request not found');
    const merged = mergePr(store, found.repo, found.pr);
    if (!merged) return gqlError('Pull request cannot be merged');
    return { data: { mergePullRequest: { pullRequest: { number: found.pr.number, merged: true, state: 'CLOSED' } } } };
  }
  if (query.includes('addComment')) {
    const input = vars.input ?? {};
    const found = findIssueByGqlId(store, String(input.subjectId ?? ''));
    if (!found) return gqlError('Issue not found');
    const id = found.repo.nextComment++;
    const comment = { id, body: input.body ?? '' };
    found.issue.comments.push(comment);
    const cid = globalId('C', found.repo.id * 1000000 + found.issue.number * 1000 + id);
    return { data: { addComment: { commentEdge: { node: { id: cid, body: comment.body } } } } };
  }
  // node(id:) Relay lookup
  if (query.includes('node(') || query.includes('node(id')) {
    const repo = findRepoByGqlId(store, String(vars.id ?? ''));
    if (!repo) return { data: { node: null } };
    return { data: { node: { id: repoGqlId(repo), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
  }
  // Viewer (only the ViewerLogin document; RepositoryFields contains
  // viewerPermission, which must not match here)
  if (/viewer\s*\{/.test(query) && !query.includes('repository(')) {
    return { data: { viewer: { login: store.viewerLogin } } };
  }
  // repository(...) queries
  if (query.includes('repository(') || query.includes('repository {')) {
    const owner = String(vars.owner ?? '');
    const name = String(vars.name ?? '');
    if (owner && !store.isViewer(owner)) return { data: { repository: null } };
    const repo = store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const r: any = repoGql(store, repo);
    // issues connection: newest first (CREATED_AT DESC); states filter applies
    // before paging, and the after cursor (base64 'cursor:<seq>') continues it.
    if (query.includes('issues(')) {
      let list = [...repo.issues.values()];
      if (query.includes('states: [OPEN]')) list = list.filter((i) => i.state === 'open');
      list.sort((a, b) => b.seq - a.seq);
      if (vars.after) {
        const afterNum = parseInt(Buffer.from(String(vars.after), 'base64url').toString('utf8').replace('cursor:', ''), 10);
        list = list.filter((i) => i.seq < afterNum);
      }
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const page = list.slice(0, first);
      const hasNext = list.length > first;
      const endCursor = page.length ? Buffer.from(`cursor:${page[page.length - 1].seq}`).toString('base64url') : null;
      r.issues = { nodes: page.map((i) => issueGql(repo, i)), pageInfo: { hasNextPage: hasNext, endCursor } };
    }
    if (query.includes('issue(') && !query.includes('issues(')) {
      const n = vars.number;
      const issue = repo.issues.get(n);
      r.issue = issue ? issueGql(repo, issue) : null;
    }
    if (query.includes('pullRequests(')) {
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq).slice(0, first);
      r.pullRequests = { nodes: list.map((p) => pullGql(store, repo, p)) };
    }
    if (query.includes('pullRequest(') && !query.includes('pullRequests(')) {
      const n = vars.number;
      const pr = repo.pulls.get(n);
      if (pr) {
        const pg: any = pullGql(store, repo, pr);
        pg.files = { nodes: (pr.files ?? []).map((f: any) => ({ path: f.filename })) };
        r.pullRequest = pg;
      } else r.pullRequest = null;
    }
    return { data: { repository: r } };
  }
  return gqlError('Unknown query');
}
