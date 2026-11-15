// mcp.ts: the Model Context Protocol endpoint at /mcp — JSON-RPC 2.0 over Streamable HTTP.
// The forge speaks the current revision (server/discover, no session) and the handshake era
// (initialize + notifications/initialized) alike; every request is answered with one JSON body.
// The six tools act on the same store as REST and GraphQL, and their results carry the REST
// shapes, so an object created here reads back identically over /api/v3.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  issueJson,
  pullJson,
  repoJson,
  type Forge,
  type RepoRec,
} from './store.ts';
import { VIEWER } from './scenario.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function requireArgs(args: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function findRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  const owner = stringArg(args, 'owner') ?? VIEWER.login;
  const repo = stringArg(args, 'repo');
  if (repo === undefined) throw new ToolError('repo is required');
  const found = forge.getRepo(owner, repo);
  if (found === undefined) throw new ToolError(`repository ${owner}/${repo} not found`);
  return found;
}

class ToolError extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = stringArg(args, 'name');
      if (name === undefined) throw new ToolError('name is required');
      const repo = forge.createRepo(VIEWER.login, name, {
        description: stringArg(args, 'description') ?? '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      if (repo === null) throw new ToolError(`repository ${name} already exists`);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => repoJson(findRepo(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const title = stringArg(args, 'title');
      if (title === undefined) throw new ToolError('title is required');
      const issue = forge.createIssue(repo, { title, body: stringArg(args, 'body') ?? '' });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const state = stringArg(args, 'state') ?? 'open';
      let issues = forge.issuesOf(repo);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === undefined || head === undefined || base === undefined) throw new ToolError('title, head and base are required');
      if (forge.branchTip(repo, head) === null) throw new ToolError(`head branch ${head} does not exist`);
      if (forge.branchTip(repo, base) === null) throw new ToolError(`base branch ${base} does not exist`);
      const pull = forge.createPull(repo, { title, body: stringArg(args, 'body') ?? '', headRef: head, baseRef: base });
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'squash or merge (default squash).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const item = Number.isSafeInteger(number) ? repo.items.get(number) : undefined;
      if (item === undefined || item.kind !== 'pull') throw new ToolError(`pull request ${String(args.pull_number)} not found`);
      const method = stringArg(args, 'merge_method')?.toLowerCase() === 'merge' ? 'merge' : 'squash';
      const result = forge.mergePull(repo, item, method);
      if ('conflict' in result) throw new ToolError(`merge conflict in ${result.conflict}`);
      if ('error' in result) throw new ToolError(result.error);
      return pullJson(forge, repo, item);
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function handleRpc(forge: Forge, message: Record<string, unknown>): RpcOutcome {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        payload: rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO, 'io.modelcontextprotocol/protocolVersion': SUPPORTED_VERSIONS[0] },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return { status: 200, payload: rpcResult(id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO }) };
    }
    case 'ping':
      return { status: 200, payload: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, payload: rpcResult(id, { tools: TOOL_LIST }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return { status: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      const missing = requireArgs(args, required);
      if (missing !== null) return { status: 200, payload: rpcError(id, -32602, `Missing required argument: ${missing}`) };
      try {
        const result = tool.run(forge, args);
        return {
          status: 200,
          payload: rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          }),
        };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { status: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
      }
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/** Handle one POST /mcp. Auth is the caller's job (a missing token must answer 401 before this). */
export function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const send = (status: number, payload: Record<string, unknown> | null): void => {
    if (payload === null) {
      res.writeHead(status, { 'content-length': '0' });
      res.end();
      return;
    }
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (req.method === 'GET' || req.method === 'DELETE') {
    send(405, rpcError(null, -32601, 'Method not allowed'));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    send(400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const outcome = handleRpc(forge, entry as Record<string, unknown>);
      if (outcome.payload !== null) answers.push(outcome.payload);
    }
    const text = JSON.stringify(answers);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    send(400, rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const outcome = handleRpc(forge, parsed as Record<string, unknown>);
  send(outcome.status, outcome.payload);
}
