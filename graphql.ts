// graphql.ts: the GraphQL v4 surface at /api/graphql — a small hand-written lexer, parser and
// executor over the forge's store, covering exactly the schema the API exposes here: viewer,
// repository, node, introspection (__type), issues/pull-request connections with cursor
// pagination, and the create/close/merge/comment mutations. REST and GraphQL read and write the
// same records, so an object made on one surface is the same object on the other.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitOf, diffTrees, mergeBase } from './gitobj.ts';
import {
  decodeGid,
  encodeGid,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { sendJson } from './rest.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') { i += 1; continue; }
    if (c === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (input.startsWith('...', i)) { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if ('!$():=@[]{}|'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (map[esc] !== undefined) {
            value += map[esc];
            j += 2;
          } else throw new Error(`invalid escape \\${esc}`);
        } else {
          value += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') { isFloat = true; j += 1; while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1; }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation') {
        const type = token.value;
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ type, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unsupported definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value token');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- sources

type Source = Record<string, unknown> & { __t: string };

function src(type: string, props: Record<string, unknown>): Source {
  return { __t: type, ...props };
}

function userSource(login: string): Source {
  return src('User', { login, id: login === VIEWER.login ? VIEWER.id : 0 });
}

function repoSource(repo: RepoRec): Source {
  return src('Repository', { repo });
}

function issueSource(repo: RepoRec, issue: IssueRec): Source {
  return src('Issue', { repo, issue });
}

function pullSource(repo: RepoRec, pull: PullRec): Source {
  return src('PullRequest', { repo, pull });
}

function pageInfoSource(page: { hasNextPage: boolean; endCursor: string | null; startCursor: string | null }): Source {
  return src('PageInfo', {
    hasNextPage: page.hasNextPage,
    hasPreviousPage: false,
    startCursor: page.startCursor,
    endCursor: page.endCursor,
  });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Paged<T> {
  nodes: T[];
  page: { hasNextPage: boolean; endCursor: string | null; startCursor: string | null };
}

/** Slice an ordered list by (first, after): the cursor names the last item already seen. */
function paged<T extends { number: number }>(items: readonly T[], args: Record<string, unknown>): Paged<T> {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  let start = 0;
  const after = numberOfCursor(args.after);
  if (after !== null) {
    const index = items.findIndex((item) => item.number === after);
    start = index === -1 ? items.length : index + 1;
  }
  const nodes = items.slice(start, start + first);
  const last = nodes[nodes.length - 1];
  const firstNode = nodes[0];
  return {
    nodes,
    page: {
      hasNextPage: start + nodes.length < items.length,
      endCursor: last === undefined ? null : cursorOf(last.number),
      startCursor: firstNode === undefined ? null : cursorOf(firstNode.number),
    },
  };
}

// ---------------------------------------------------------------- resolvers

type Resolver = (forge: Forge, source: Source, args: Record<string, unknown>) => unknown;

function repoOf(source: Source): RepoRec {
  return source.repo as RepoRec;
}

function issueOf(source: Source): IssueRec {
  return source.issue as IssueRec;
}

function pullOf(source: Source): PullRec {
  return source.pull as PullRec;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSource(VIEWER.login),
    repository: (forge, _source, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = forge.getRepo(owner, name);
      return repo === undefined ? null : repoSource(repo);
    },
    node: (forge, _source, args) => (typeof args.id === 'string' ? nodeByGid(forge, args.id) : null),
    __type: (_forge, _source, args) => typeSource(typeof args.name === 'string' ? args.name : ''),
    __schema: () => src('__Schema', {}),
  },
  Mutation: {
    createIssue: (forge, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGid(forge, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new Error('title is required');
      const issue = forge.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      return src('CreateIssuePayload', { issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null });
    },
    closeIssue: (forge, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGid(forge, input.issueId);
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedAt = forge.nowIso();
      return src('CloseIssuePayload', { issue: issueSource(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null });
    },
    reopenIssue: (forge, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGid(forge, input.issueId);
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'open';
      found.issue.updatedAt = forge.nowIso();
      return src('ReopenIssuePayload', { issue: issueSource(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null });
    },
    createPullRequest: (forge, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGid(forge, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (forge.branchTip(repo, head) === null) throw new Error(`head ref ${head} does not exist`);
      if (forge.branchTip(repo, base) === null) throw new Error(`base ref ${base} does not exist`);
      const pull = forge.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef: head,
        baseRef: base,
      });
      return src('CreatePullRequestPayload', { pullRequest: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null });
    },
    mergePullRequest: (forge, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullFromGid(forge, input.pullRequestId);
      if (found === null) throw new Error('pull request not found');
      const method = typeof input.mergeMethod === 'string' && input.mergeMethod.toUpperCase() === 'MERGE' ? 'merge' : 'squash';
      const result = forge.mergePull(found.repo, found.pull, method);
      if ('conflict' in result) throw new Error(`merge conflict in ${result.conflict}`);
      if ('error' in result) throw new Error(result.error);
      return src('MergePullRequestPayload', { pullRequest: pullSource(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null });
    },
    addComment: (forge, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGid(forge, input.subjectId);
      if (found === null) throw new Error('subject is not an issue');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = forge.addComment(found.issue, body);
      const node = src('IssueComment', { repo: found.repo, issue: found.issue, comment });
      return src('AddCommentPayload', {
        commentEdge: src('IssueCommentEdge', { node }),
        subject: issueSource(found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
  },
  User: {
    login: (_forge, source) => source.login,
    id: (_forge, source) => encodeGid('User', String(source.login)),
    databaseId: (_forge, source) => source.id,
    name: (_forge, source) => (source.login === VIEWER.login ? VIEWER.name : source.login),
    email: (_forge, source) => (source.login === VIEWER.login ? VIEWER.email : ''),
  },
  Repository: {
    id: (_forge, source) => encodeGid('Repository', String(repoOf(source).id)),
    databaseId: (_forge, source) => repoOf(source).id,
    name: (_forge, source) => repoOf(source).name,
    nameWithOwner: (_forge, source) => `${repoOf(source).owner}/${repoOf(source).name}`,
    owner: (_forge, source) => userSource(repoOf(source).owner),
    description: (_forge, source) => repoOf(source).description,
    isPrivate: (_forge, source) => repoOf(source).isPrivate,
    isFork: () => false,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    createdAt: (_forge, source) => repoOf(source).createdAt,
    updatedAt: (_forge, source) => repoOf(source).createdAt,
    defaultBranchRef: (_forge, source) => src('Ref', { name: repoOf(source).defaultBranch, prefix: 'refs/heads/' }),
    issue: (_forge, source, args) => {
      const repo = repoOf(source);
      const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
      return item !== undefined && item.kind === 'issue' ? issueSource(repo, item) : null;
    },
    issues: (forge, source, args) => {
      const repo = repoOf(source);
      let issues = forge.issuesOf(repo);
      const states = Array.isArray(args.states) ? args.states.map(String) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
      issues = [...issues].sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      const page = paged(issues, args);
      return src('IssueConnection', {
        nodes: page.nodes.map((issue) => issueSource(repo, issue)),
        pageInfo: pageInfoSource(page.page),
        totalCount: issues.length,
      });
    },
    pullRequest: (_forge, source, args) => {
      const repo = repoOf(source);
      const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
      return item !== undefined && item.kind === 'pull' ? pullSource(repo, item) : null;
    },
    pullRequests: (forge, source, args) => {
      const repo = repoOf(source);
      let pulls = forge.pullsOf(repo);
      const states = Array.isArray(args.states) ? args.states.map(String) : null;
      if (states !== null) {
        pulls = pulls.filter((pull) => {
          if (pull.merged) return states.includes('MERGED');
          return states.includes(pull.state.toUpperCase());
        });
      }
      const page = paged(pulls, args);
      return src('PullRequestConnection', {
        nodes: page.nodes.map((pull) => pullSource(repo, pull)),
        pageInfo: pageInfoSource(page.page),
        totalCount: pulls.length,
      });
    },
  },
  Issue: {
    id: (_forge, source) => encodeGid('Issue', `${repoOf(source).id}:${issueOf(source).number}`),
    databaseId: (_forge, source) => issueOf(source).id,
    number: (_forge, source) => issueOf(source).number,
    title: (_forge, source) => issueOf(source).title,
    body: (_forge, source) => issueOf(source).body,
    state: (_forge, source) => issueOf(source).state.toUpperCase(),
    closed: (_forge, source) => issueOf(source).state === 'closed',
    author: () => userSource(VIEWER.login),
    repository: (_forge, source) => repoSource(repoOf(source)),
    createdAt: (_forge, source) => issueOf(source).createdAt,
    updatedAt: (_forge, source) => issueOf(source).updatedAt,
    labels: (_forge, source) => {
      const repo = repoOf(source);
      const nodes = issueOf(source).labels.map((name) => src('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' }));
      return src('LabelConnection', { nodes, pageInfo: pageInfoSource({ hasNextPage: false, endCursor: null, startCursor: null }), totalCount: nodes.length });
    },
    comments: (_forge, source, args) => {
      const repo = repoOf(source);
      const issue = issueOf(source);
      const all = [...issue.comments].sort((a, b) => a.seq - b.seq);
      const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : all.length;
      const slice = all.slice(0, first);
      return src('IssueCommentConnection', {
        nodes: slice.map((comment) => src('IssueComment', { repo, issue, comment })),
        pageInfo: pageInfoSource({ hasNextPage: slice.length < all.length, endCursor: null, startCursor: null }),
        totalCount: all.length,
      });
    },
  },
  IssueComment: {
    id: (_forge, source) => encodeGid('IssueComment', `${repoOf(source).id}:${issueOf(source).number}:${(source.comment as { id: number }).id}`),
    databaseId: (_forge, source) => (source.comment as { id: number }).id,
    body: (_forge, source) => (source.comment as { body: string }).body,
    author: () => userSource(VIEWER.login),
    createdAt: (_forge, source) => (source.comment as { createdAt: string }).createdAt,
  },
  PullRequest: {
    id: (_forge, source) => encodeGid('PullRequest', `${repoOf(source).id}:${pullOf(source).number}`),
    databaseId: (_forge, source) => pullOf(source).id,
    number: (_forge, source) => pullOf(source).number,
    title: (_forge, source) => pullOf(source).title,
    body: (_forge, source) => pullOf(source).body,
    state: (_forge, source) => (pullOf(source).merged ? 'MERGED' : pullOf(source).state.toUpperCase()),
    merged: (_forge, source) => pullOf(source).merged,
    mergedAt: (_forge, source) => pullOf(source).mergedAt,
    mergeable: (forge, source) => forge.pullMergeable(repoOf(source), pullOf(source)),
    closed: (_forge, source) => pullOf(source).state === 'closed',
    author: () => userSource(VIEWER.login),
    repository: (_forge, source) => repoSource(repoOf(source)),
    headRefName: (_forge, source) => pullOf(source).headRef,
    baseRefName: (_forge, source) => pullOf(source).baseRef,
    headRefOid: (forge, source) => forge.branchTip(repoOf(source), pullOf(source).headRef) ?? '',
    baseRefOid: (forge, source) => forge.branchTip(repoOf(source), pullOf(source).baseRef) ?? '',
    mergeCommit: (_forge, source) => (pullOf(source).mergeCommitSha === null ? null : src('Commit', { oid: pullOf(source).mergeCommitSha })),
    createdAt: (_forge, source) => pullOf(source).createdAt,
    updatedAt: (_forge, source) => pullOf(source).updatedAt,
    files: (forge, source, args) => {
      const repo = repoOf(source);
      const pull = pullOf(source);
      const headTip = forge.branchTip(repo, pull.headRef);
      const baseTip = forge.branchTip(repo, pull.baseRef);
      let files: Array<{ path: string; additions: number; deletions: number }> = [];
      if (headTip !== null && baseTip !== null) {
        const base = mergeBase(forge.store, baseTip, headTip) ?? baseTip;
        const baseInfo = commitOf(forge.store, base);
        const headInfo = commitOf(forge.store, headTip);
        if (baseInfo !== null && headInfo !== null) {
          files = diffTrees(forge.store, baseInfo.tree, headInfo.tree).map((change) => ({
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
          }));
        }
      }
      const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : files.length;
      const slice = files.slice(0, first);
      return src('PullRequestChangedFileConnection', {
        nodes: slice.map((file) => src('PullRequestChangedFile', file)),
        pageInfo: pageInfoSource({ hasNextPage: slice.length < files.length, endCursor: null, startCursor: null }),
        totalCount: files.length,
      });
    },
  },
  Ref: {
    name: (_forge, source) => source.name,
    prefix: (_forge, source) => source.prefix,
  },
  Commit: {
    oid: (_forge, source) => source.oid,
    message: (forge, source) => commitOf(forge.store, String(source.oid))?.message ?? '',
  },
  Label: {
    id: (_forge, source) => encodeGid('Label', String(source.name)),
    name: (_forge, source) => source.name,
    color: (_forge, source) => source.color,
  },
};


// ---------------------------------------------------------------- node lookup

function repoFromGid(forge: Forge, gid: unknown): RepoRec | null {
  if (typeof gid !== 'string') return null;
  const decoded = decodeGid(gid);
  if (decoded === null || decoded.type !== 'Repository') return null;
  return forge.repoById(Number(decoded.payload)) ?? null;
}

function issueFromGid(forge: Forge, gid: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof gid !== 'string') return null;
  const decoded = decodeGid(gid);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [repoId, number] = decoded.payload.split(':');
  const repo = forge.repoById(Number(repoId));
  if (repo === undefined) return null;
  const item = repo.items.get(Number(number));
  return item !== undefined && item.kind === 'issue' ? { repo, issue: item } : null;
}

function pullFromGid(forge: Forge, gid: unknown): { repo: RepoRec; pull: PullRec } | null {
  if (typeof gid !== 'string') return null;
  const decoded = decodeGid(gid);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [repoId, number] = decoded.payload.split(':');
  const repo = forge.repoById(Number(repoId));
  if (repo === undefined) return null;
  const item = repo.items.get(Number(number));
  return item !== undefined && item.kind === 'pull' ? { repo, pull: item } : null;
}

function nodeByGid(forge: Forge, gid: string): Source | null {
  const decoded = decodeGid(gid);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = forge.repoById(Number(decoded.payload));
    return repo === undefined ? null : repoSource(repo);
  }
  if (decoded.type === 'Issue') {
    const found = issueFromGid(forge, gid);
    return found === null ? null : issueSource(found.repo, found.issue);
  }
  if (decoded.type === 'PullRequest') {
    const found = pullFromGid(forge, gid);
    return found === null ? null : pullSource(found.repo, found.pull);
  }
  if (decoded.type === 'User') return userSource(decoded.payload);
  if (decoded.type === 'IssueComment') {
    const [repoId, number, commentId] = decoded.payload.split(':');
    const repo = forge.repoById(Number(repoId));
    const item = repo?.items.get(Number(number));
    if (repo === undefined || item === undefined || item.kind !== 'issue') return null;
    const comment = item.comments.find((candidate) => candidate.id === Number(commentId));
    return comment === undefined ? null : src('IssueComment', { repo, issue: item, comment });
  }
  return null;
}

// ---------------------------------------------------------------- introspection

const TYPE_TABLE: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search', 'rateLimit'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'createdAt'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels', 'createdAt', 'updatedAt', 'url'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'url'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'closed', 'author', 'repository', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergeCommit', 'createdAt', 'updatedAt', 'url'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['oid', 'message', 'tree', 'authoredDate', 'committedDate'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

function typeSource(name: string): Source | null {
  const entry = TYPE_TABLE[name];
  if (entry === undefined) return null;
  return src('__Type', {
    name,
    kind: entry.kind,
    description: null,
    fieldNames: entry.fields ?? [],
    enumNames: entry.enumValues ?? [],
  });
}

// ---------------------------------------------------------------- executor

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selectionSet));
  if (typeof value === 'object' && '__t' in (value as Record<string, unknown>)) {
    if (selectionSet === null) return null;
    return executeSelectionSet(ctx, value as Source, selectionSet);
  }
  return value;
}

function executeSelectionSet(ctx: ExecContext, source: Source, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = source.__t;
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, source, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const typeResolvers = RESOLVERS[typeName];
    let value: unknown = null;
    let resolved = false;
    if (typeResolvers !== undefined && selection.name in typeResolvers) {
      try {
        value = (typeResolvers[selection.name] as Resolver)(ctx.forge, source, argsOf(selection, ctx));
        resolved = true;
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
        value = null;
        resolved = true;
      }
    } else if (typeResolvers === undefined && selection.name in source) {
      value = source[selection.name];
      resolved = true;
    }
    if (!resolved) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection.selectionSet);
  }
  return out;
}

// __Type / __Schema / payload plumbing types resolve by property, not by resolver map.
RESOLVERS['__Type'] = {
  name: (_forge, source) => source.name,
  kind: (_forge, source) => source.kind,
  description: () => null,
  fields: (_forge, source) => (source.fieldNames as string[]).map((name) => src('__Field', { name })),
  enumValues: (_forge, source) => (source.enumNames as string[]).map((name) => src('__EnumValue', { name })),
  possibleTypes: () => null,
  inputFields: () => null,
  ofType: () => null,
};
RESOLVERS['__Field'] = { name: (_forge, source) => source.name, description: () => null, type: () => null, args: () => [] };
RESOLVERS['__EnumValue'] = { name: (_forge, source) => source.name, description: () => null };
RESOLVERS['__Schema'] = {
  types: () => Object.keys(TYPE_TABLE).map((name) => typeSource(name)),
  queryType: () => typeSource('Query'),
  mutationType: () => typeSource('Mutation'),
  subscriptionType: () => null,
  directives: () => [],
};
// Payload and connection types: plain property reads.
for (const payloadType of ['CreateIssuePayload', 'CloseIssuePayload', 'ReopenIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  RESOLVERS[payloadType] = {
    issue: (_forge, source) => source.issue ?? null,
    pullRequest: (_forge, source) => source.pullRequest ?? null,
    commentEdge: (_forge, source) => source.commentEdge ?? null,
    subject: (_forge, source) => source.subject ?? null,
    clientMutationId: (_forge, source) => source.clientMutationId ?? null,
  };
}
for (const connectionType of ['IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection', 'IssueCommentConnection', 'LabelConnection']) {
  RESOLVERS[connectionType] = {
    nodes: (_forge, source) => source.nodes,
    pageInfo: (_forge, source) => source.pageInfo,
    totalCount: (_forge, source) => source.totalCount,
    edges: (_forge, source) => (source.nodes as unknown[]).map((node) => src('Edge', { node, cursor: '' })),
  };
}
RESOLVERS['Edge'] = { node: (_forge, source) => source.node, cursor: (_forge, source) => source.cursor };
RESOLVERS['PageInfo'] = {
  hasNextPage: (_forge, source) => source.hasNextPage,
  hasPreviousPage: (_forge, source) => source.hasPreviousPage,
  startCursor: (_forge, source) => source.startCursor,
  endCursor: (_forge, source) => source.endCursor,
};
RESOLVERS['PullRequestChangedFile'] = {
  path: (_forge, source) => source.path,
  additions: (_forge, source) => source.additions,
  deletions: (_forge, source) => source.deletions,
  changeType: () => 'MODIFIED',
};
RESOLVERS['IssueCommentEdge'] = { node: (_forge, source) => source.node, cursor: () => '' };

// ---------------------------------------------------------------- HTTP

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName: string | null): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Syntax Error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operation = operationName === null
    ? document.operations[0]
    : document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const vars: Record<string, unknown> = {};
  for (const [name, defaultNode] of operation.variableDefaults) vars[name] = resolveValue(defaultNode, {});
  Object.assign(vars, variables);
  const ctx: ExecContext = { forge, variables: vars, fragments: document.fragments, errors: [] };
  const root = src(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(ctx, root, operation.selectionSet);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql (single operation or a batch array). Auth is the caller's job. */
export function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  void req;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid request' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    if (query === '') return { errors: [{ message: 'No query provided' }] };
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    return executeGraphQL(forge, query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
