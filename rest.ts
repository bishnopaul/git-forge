// rest.ts: the REST v3 API under /api/v3 — repositories, contents, git data, branches, commits,
// labels, issues, comments and pull requests. Every answer is JSON with a request id; errors are
// JSON with a message, as GitHub's own API answers. The handlers share the serializers in
// store.ts with the GraphQL and MCP surfaces, so objects agree across surfaces.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ancestorsOf,
  commitOf,
  diffTrees,
  entryAtPath,
  listTreeAt,
  mergeBase,
  updateTree,
} from './gitobj.ts';
import {
  commentJson,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
  userJson,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { VIEWER } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  requestCounter += 1;
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'x-github-request-id': requestCounter.toString(16).toUpperCase().padStart(8, '0'),
    ...extra,
  };
  if (body !== null) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message, errors: [{ message }] });
}

interface JsonBody {
  ok: boolean;
  value: Record<string, unknown>;
}

function parseBody(body: Buffer): JsonBody {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, value: {} };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): Page<T> {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (items.length > perPage) {
    const host = req.headers.host ?? 'localhost';
    const build = (target: number): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('per_page', String(perPage));
      params.set('page', String(target));
      return `<http://${host}${url.pathname}?${params.toString()}>`;
    };
    const parts: string[] = [];
    if (page < totalPages) parts.push(`${build(page + 1)}; rel="next"`, `${build(totalPages)}; rel="last"`);
    if (page > 1) parts.push(`${build(1)}; rel="first"`, `${build(page - 1)}; rel="prev"`);
    link = parts.join(', ');
  }
  return { items: slice, link };
}

function sendList<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly T[]): void {
  const page = paginate(req, url, items);
  sendJson(res, 200, page.items, page.link === null ? {} : { link: page.link });
}

// ---------------------------------------------------------------- repositories

function handleCreateRepo(forge: Forge, res: ServerResponse, body: Buffer): void {
  const parsed = parseBody(body);
  if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
  const name = str(parsed.value.name);
  if (name === undefined || name === '') return unprocessable(res, 'name is required');
  const repo = forge.createRepo(VIEWER.login, name, {
    description: str(parsed.value.description) ?? '',
    isPrivate: bool(parsed.value.private) ?? false,
  });
  if (repo === null) return unprocessable(res, 'name already exists on this account');
  return sendJson(res, 201, repoJson(repo));
}

function handleRepo(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const method = req.method ?? 'GET';
  if (method === 'GET') return sendJson(res, 200, repoJson(repo));
  if (method === 'DELETE') {
    forge.deleteRepo(repo.owner, repo.name);
    return sendJson(res, 204, null);
  }
  if (method === 'PATCH') {
    const parsed = parseBody(body);
    if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const description = str(parsed.value.description);
    if (description !== undefined) repo.description = description;
    const isPrivate = bool(parsed.value.private);
    if (isPrivate !== undefined) repo.isPrivate = isPrivate;
    const name = str(parsed.value.name);
    if (name !== undefined && name !== '' && name !== repo.name) {
      forge.repos.delete(forge.repoKey(repo.owner, repo.name));
      repo.name = name;
      forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
    }
    return sendJson(res, 200, repoJson(repo));
  }
  return notFound(res);
}

// ---------------------------------------------------------------- contents

function resolveCommit(forge: Forge, repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return forge.branchTip(repo, repo.defaultBranch);
  const byBranch = forge.branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  const object = forge.store.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

function handleContentsGet(forge: Forge, res: ServerResponse, repo: RepoRec, path: string, url: URL): void {
  const commit = resolveCommit(forge, repo, url.searchParams.get('ref') ?? undefined);
  if (commit === null) return notFound(res);
  const info = commitOf(forge.store, commit);
  if (info === null) return notFound(res);
  const segments = path === '' ? [] : path.split('/');
  if (segments.length === 0) {
    const entries = listTreeAt(forge.store, info.tree, []);
    if (entries === null) return notFound(res);
    return sendJson(res, 200, entries.map((entry) => dirEntryJson(forge, entry, entry.name)));
  }
  const entry = entryAtPath(forge.store, info.tree, segments);
  if (entry === null) return notFound(res);
  if (entry.mode === '40000') {
    const entries = listTreeAt(forge.store, info.tree, segments);
    if (entries === null) return notFound(res);
    return sendJson(res, 200, entries.map((child) => dirEntryJson(forge, child, `${path}/${child.name}`)));
  }
  const blob = forge.store.get(entry.oid);
  const data = blob?.data ?? Buffer.alloc(0);
  return sendJson(res, 200, {
    type: entry.mode === '160000' ? 'submodule' : 'file',
    name: segments[segments.length - 1],
    path,
    sha: entry.oid,
    size: data.length,
    encoding: 'base64',
    content: data.toString('base64'),
  });
}

function dirEntryJson(forge: Forge, entry: { mode: string; name: string; oid: string }, path: string): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const blob = forge.store.get(entry.oid);
  return {
    type: isDir ? 'dir' : entry.mode === '160000' ? 'submodule' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: isDir || blob === undefined ? 0 : blob.data.length,
  };
}

function handleContentsPut(forge: Forge, res: ServerResponse, repo: RepoRec, path: string, body: Buffer): void {
  const parsed = parseBody(body);
  if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
  const contentB64 = str(parsed.value.content);
  if (contentB64 === undefined) return unprocessable(res, 'content is required');
  const message = str(parsed.value.message) ?? `Update ${path}`;
  const branch = str(parsed.value.branch) ?? repo.defaultBranch;
  const segments = path.split('/');
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');

  const branchRef = `refs/heads/${branch}`;
  const branchExists = repo.refs.has(branchRef);
  // An existing branch builds on its tip; a new one forks from the default branch's tip
  // (null when the repository is still unborn, which makes this commit a root).
  const baseTip: string | null = branchExists ? forge.branchTip(repo, branch) : forge.branchTip(repo, repo.defaultBranch);
  const baseCommit = baseTip === null ? null : commitOf(forge.store, baseTip);
  const existing = baseCommit === null ? null : entryAtPath(forge.store, baseCommit.tree, segments);
  const givenSha = str(parsed.value.sha);
  if (existing !== null) {
    if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return sendJson(res, 409, { message: `sha does not match the current blob (${existing.oid})` });
    }
  } else if (givenSha !== undefined) {
    return sendJson(res, 409, { message: 'sha was given but the file does not exist' });
  }
  const blobOid = forge.store.put('blob', data);
  const leaf = { mode: '100644', name: segments[segments.length - 1] as string, oid: blobOid };
  const tree = updateTree(forge.store, baseCommit?.tree ?? null, segments, leaf);
  // The message is stored verbatim: the API echoes it back exactly as the caller sent it.
  const commit = forge.makeCommit(tree, baseTip === null ? [] : [baseTip], message);
  forge.setBranch(repo, branch, commit);
  const status = existing !== null ? 200 : 201;
  return sendJson(res, status, {
    content: { name: leaf.name, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commit, message },
  });
}

function handleContentsDelete(forge: Forge, res: ServerResponse, repo: RepoRec, path: string, body: Buffer): void {
  const parsed = parseBody(body);
  if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
  const message = str(parsed.value.message) ?? `Delete ${path}`;
  const branch = str(parsed.value.branch) ?? repo.defaultBranch;
  const segments = path.split('/');
  const baseTip = forge.branchTip(repo, branch);
  const baseCommit = baseTip === null ? null : commitOf(forge.store, baseTip);
  if (baseCommit === null || baseTip === null) return notFound(res);
  const existing = entryAtPath(forge.store, baseCommit.tree, segments);
  if (existing === null) return notFound(res);
  const givenSha = str(parsed.value.sha);
  if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    return sendJson(res, 409, { message: 'sha does not match the current blob' });
  }
  const tree = updateTree(forge.store, baseCommit.tree, segments, null);
  const commit = forge.makeCommit(tree, [baseTip], message);
  forge.setBranch(repo, branch, commit);
  return sendJson(res, 200, { content: null, commit: { sha: commit, message } });
}

// ---------------------------------------------------------------- git data, branches, commits

function handleCreateRef(forge: Forge, res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const parsed = parseBody(body);
  if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
  const ref = str(parsed.value.ref);
  const sha = str(parsed.value.sha);
  if (ref === undefined || sha === undefined) return unprocessable(res, 'ref and sha are required');
  if (!ref.startsWith('refs/')) return unprocessable(res, 'ref must start with refs/');
  const object = forge.store.get(sha);
  if (object === undefined) return unprocessable(res, 'sha does not name an object');
  if (repo.refs.has(ref)) return unprocessable(res, 'Reference already exists');
  repo.refs.set(ref, sha);
  return sendJson(res, 201, { ref, node_id: '', object: { sha, type: object.type } });
}

function handleCommits(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec, url: URL): void {
  const ref = url.searchParams.get('sha') ?? undefined;
  const tip = resolveCommit(forge, repo, ref);
  if (tip === null) return sendJson(res, 200, []);
  const chain = ancestorsOf(forge.store, tip)
    .map((oid) => ({ oid, info: commitOf(forge.store, oid) }))
    .filter((entry) => entry.info !== null)
    .sort((a, b) => (b.info?.committerTime ?? 0) - (a.info?.committerTime ?? 0));
  const all = chain.map(({ oid, info }) => ({
    sha: oid,
    commit: {
      message: (info as NonNullable<typeof info>).message,
      author: {
        name: (info as NonNullable<typeof info>).authorName,
        email: (info as NonNullable<typeof info>).authorEmail,
        date: new Date(((info as NonNullable<typeof info>).authorTime) * 1000).toISOString(),
      },
      committer: {
        name: (info as NonNullable<typeof info>).committerName,
        email: (info as NonNullable<typeof info>).committerEmail,
        date: new Date(((info as NonNullable<typeof info>).committerTime) * 1000).toISOString(),
      },
      tree: { sha: (info as NonNullable<typeof info>).tree },
    },
    parents: (info as NonNullable<typeof info>).parents.map((parent) => ({ sha: parent })),
  }));
  return sendList(req, res, url, all);
}

// ---------------------------------------------------------------- issues

function validateLabels(repo: RepoRec, labels: unknown): string[] | null {
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) return null;
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name);
    if (name === undefined || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

function handleIssues(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec, rest: string[], body: Buffer, url: URL): void {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = forge.issuesOf(repo);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendList(req, res, url, issues.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = str(parsed.value.title);
      if (title === undefined || title === '') return unprocessable(res, 'title is required');
      const labels = validateLabels(repo, parsed.value.labels);
      if (labels === null) return unprocessable(res, 'one or more labels do not exist on this repository');
      const issue = forge.createIssue(repo, { title, body: str(parsed.value.body) ?? '', labels });
      return sendJson(res, 201, issueJson(repo, issue));
    }
    return notFound(res);
  }
  const number = Number(rest[0]);
  const item = Number.isSafeInteger(number) ? repo.items.get(number) : undefined;
  const issue = item !== undefined && item.kind === 'issue' ? item : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const state = str(parsed.value.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = str(parsed.value.title);
      if (title !== undefined) issue.title = title;
      const bodyText = str(parsed.value.body);
      if (bodyText !== undefined) issue.body = bodyText;
      if (parsed.value.labels !== undefined) {
        const labels = validateLabels(repo, parsed.value.labels);
        if (labels === null) return unprocessable(res, 'one or more labels do not exist on this repository');
        issue.labels = labels;
      }
      issue.updatedAt = forge.nowIso();
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return notFound(res);
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') return sendList(req, res, url, issue.comments.map(commentJson));
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const text = str(parsed.value.body);
      if (text === undefined) return unprocessable(res, 'body is required');
      const comment = forge.addComment(issue, text);
      return sendJson(res, 201, commentJson(comment));
    }
    return notFound(res);
  }
  return notFound(res);
}

// ---------------------------------------------------------------- pull requests

function cleanRefName(value: string): string {
  let name = value;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.indexOf(':');
  if (colon !== -1 && !name.slice(0, colon).includes('/')) name = name.slice(colon + 1);
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  return name;
}

function handlePulls(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec, rest: string[], body: Buffer, url: URL): void {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = forge.pullsOf(repo);
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      return sendList(req, res, url, pulls.map((pull) => pullJson(forge, repo, pull)));
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = str(parsed.value.title);
      const headRaw = str(parsed.value.head);
      const baseRaw = str(parsed.value.base);
      if (title === undefined || headRaw === undefined || baseRaw === undefined) return unprocessable(res, 'title, head and base are required');
      const head = cleanRefName(headRaw);
      const base = cleanRefName(baseRaw);
      if (forge.branchTip(repo, head) === null) return unprocessable(res, `head ref ${head} does not exist`);
      if (forge.branchTip(repo, base) === null) return unprocessable(res, `base ref ${base} does not exist`);
      if (head === base) return unprocessable(res, 'head and base must differ');
      const duplicate = forge.pullsOf(repo).find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return unprocessable(res, `A pull request already exists for ${head} into ${base}`);
      const pull = forge.createPull(repo, { title, body: str(parsed.value.body) ?? '', headRef: head, baseRef: base });
      return sendJson(res, 201, pullJson(forge, repo, pull));
    }
    return notFound(res);
  }
  const number = Number(rest[0]);
  const item = Number.isSafeInteger(number) ? repo.items.get(number) : undefined;
  const pull: PullRec | undefined = item !== undefined && item.kind === 'pull' ? item : undefined;
  if (rest.length === 1) {
    if (pull === undefined) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, pullJson(forge, repo, pull));
    return notFound(res);
  }
  if (pull === undefined) return notFound(res);
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = forge.branchTip(repo, pull.headRef);
    const baseTip = forge.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return sendJson(res, 200, []);
    const base = mergeBase(forge.store, baseTip, headTip) ?? baseTip;
    const baseInfo = commitOf(forge.store, base);
    const headInfo = commitOf(forge.store, headTip);
    if (baseInfo === null || headInfo === null) return sendJson(res, 200, []);
    const changes = diffTrees(forge.store, baseInfo.tree, headInfo.tree);
    return sendList(req, res, url, changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })));
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const parsed = parseBody(body);
    if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const methodName = (str(parsed.value.merge_method) ?? 'merge').toLowerCase();
    if (pull.merged) return sendJson(res, 405, { message: 'Pull Request already merged', merged: false });
    if (pull.state !== 'open') return sendJson(res, 405, { message: 'Pull Request is not mergeable', merged: false });
    const result = forge.mergePull(repo, pull, methodName === 'merge' ? 'merge' : 'squash');
    if ('conflict' in result) return sendJson(res, 405, { message: `Pull Request is not mergeable: ${result.conflict} conflicts`, merged: false });
    if ('error' in result) return sendJson(res, 405, { message: `Pull Request is not mergeable: ${result.error}`, merged: false });
    return sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound(res);
}


// ---------------------------------------------------------------- router

/** Handle one request under /api/v3. `segments` are the decoded path segments after /api/v3. */
export function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  url: URL,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  const [first, second] = segments;

  if (segments.length === 0) {
    if (method === 'GET') {
      return (sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' }), true);
    }
    return (notFound(res), true);
  }
  if (first === 'meta' && segments.length === 1 && method === 'GET') {
    return (sendJson(res, 200, { installed_version: '1.0.0', enterprise: false }), true);
  }
  if (first === 'user' && segments.length === 1 && method === 'GET') {
    return (sendJson(res, 200, { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email }), true);
  }
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'POST') return (handleCreateRepo(forge, res, body), true);
    if (method === 'GET') return (sendList(req, res, url, forge.reposOf(VIEWER.login).map(repoJson)), true);
    return (notFound(res), true);
  }
  if (first === 'rate_limit' && segments.length === 1 && method === 'GET') {
    return (sendJson(res, 200, { rate: { limit: 5000, remaining: 4999, reset: 1893456000 }, resources: {} }), true);
  }
  if (first !== 'repos' || second === undefined || segments.length < 3) return (notFound(res), true);

  const owner = second;
  const repoName = segments[2] as string;
  const repo = forge.getRepo(owner, repoName);
  const tail = segments.slice(3);

  if (tail.length === 0) {
    if (repo === undefined) return (notFound(res), true);
    return (handleRepo(forge, req, res, repo, body), true);
  }
  if (repo === undefined) return (notFound(res), true);

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return (handleContentsGet(forge, res, repo, path, url), true);
    if (method === 'PUT') return (handleContentsPut(forge, res, repo, path, body), true);
    if (method === 'DELETE') return (handleContentsDelete(forge, res, repo, path, body), true);
    return (notFound(res), true);
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') {
    return (handleCreateRef(forge, res, repo, body), true);
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && tail.length >= 4 && method === 'GET') {
    const branch = tail.slice(3).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return (notFound(res), true);
    return (sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: 'commit' } }), true);
  }
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return (sendJson(res, 200, branches), true);
  }
  if (tail[0] === 'branches' && tail.length >= 2 && method === 'GET') {
    const branch = tail.slice(1).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return (notFound(res), true);
    return (sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false }), true);
  }
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    return (handleCommits(forge, req, res, repo, url), true);
  }
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') return (sendJson(res, 200, [...repo.labels.values()].map(labelJson)), true);
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return (sendJson(res, 400, { message: 'Problems parsing JSON' }), true);
      const name = str(parsed.value.name);
      if (name === undefined || name === '') return (unprocessable(res, 'name is required'), true);
      const label = forge.createLabel(repo, { name, color: str(parsed.value.color), description: str(parsed.value.description) ?? null });
      if (label === null) return (unprocessable(res, 'name has already been taken'), true);
      return (sendJson(res, 201, labelJson(label)), true);
    }
    return (notFound(res), true);
  }
  if (tail[0] === 'issues') return (handleIssues(forge, req, res, repo, tail.slice(1), body, url), true);
  if (tail[0] === 'pulls') return (handlePulls(forge, req, res, repo, tail.slice(1), body, url), true);
  return (notFound(res), true);
}
