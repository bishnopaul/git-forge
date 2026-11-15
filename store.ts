// store.ts: the forge's state — repositories, their refs, issues, pull requests, labels and
// comments — plus the serializers every surface (REST, GraphQL, MCP) shares, so an object created
// over one surface is byte-for-byte the same object over the others.
//
// Determinism matters (a trial is replayed and the export must match): nothing here reads a wall
// clock or a random source. Timestamps come from an internal tick over a fixed epoch, ids from
// counters, and ordering from creation sequence numbers.

import {
  ObjectStore,
  buildCommit,
  commitOf,
  flattenTree,
  mergeBase,
  mergeFlatTrees,
  peelToCommit,
  treeFromFlat,
  type Identity,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';

export const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);
export const DEFAULT_BRANCH = 'main';

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export type ItemRec = IssueRec | PullRec;

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  seq: number;
  createdAt: string;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  private repoIdCounter = 0;
  private itemIdCounter = 0;
  private commentIdCounter = 0;
  private labelIdCounter = 0;
  private seqCounter = 0;
  private tickCounter = 0;

  /** A deterministic timestamp: the fixed epoch plus one second per call, in call order. */
  nowIso(): string {
    this.tickCounter += 1;
    return new Date(EPOCH_MS + this.tickCounter * 1000).toISOString();
  }

  /** The same clock in unix seconds, for git commit timestamps. */
  nowSec(): number {
    return Math.floor(EPOCH_MS / 1000) + this.tickCounter;
  }

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  viewerIdentity(): Identity {
    return { name: VIEWER.name, email: VIEWER.email };
  }

  // -------------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, input: { description?: string; isPrivate?: boolean }): RepoRec | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    this.repoIdCounter += 1;
    const repo: RepoRec = {
      id: this.repoIdCounter,
      owner,
      name,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
      createdAt: this.nowIso(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  repoById(id: number): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  // -------------------------------------------------------------- refs and commits

  /** The commit a branch names (tags peeled), or null for an unborn/missing branch. */
  branchTip(repo: RepoRec, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return null;
    return peelToCommit(this.store, oid);
  }

  setBranch(repo: RepoRec, branch: string, commitOid: string): void {
    repo.refs.set(`refs/heads/${branch}`, commitOid);
  }

  /** Create a commit authored by the viewer at the forge's deterministic clock. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const identity = this.viewerIdentity();
    const data = buildCommit({
      tree,
      parents,
      message,
      author: identity,
      committer: identity,
      timestamp: this.nowSec(),
    });
    return this.store.put('commit', data);
  }

  // -------------------------------------------------------------- issues and pulls

  createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
    this.itemIdCounter += 1;
    const now = this.nowIso();
    const issue: IssueRec = {
      kind: 'issue',
      id: this.itemIdCounter,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      seq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: RepoRec, input: { title: string; body?: string; headRef: string; baseRef: string }): PullRec {
    this.itemIdCounter += 1;
    const now = this.nowIso();
    const pull: PullRec = {
      kind: 'pull',
      id: this.itemIdCounter,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      seq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  addComment(issue: IssueRec, body: string): CommentRec {
    this.commentIdCounter += 1;
    const comment: CommentRec = { id: this.commentIdCounter, body, seq: this.nextSeq(), createdAt: this.nowIso() };
    issue.comments.push(comment);
    return comment;
  }

  createLabel(repo: RepoRec, input: { name: string; color?: string; description?: string | null }): LabelRec | null {
    if (repo.labels.has(input.name)) return null;
    this.labelIdCounter += 1;
    const label: LabelRec = {
      id: this.labelIdCounter,
      name: input.name,
      color: (input.color ?? 'ededed').replace(/^#/, ''),
      description: input.description ?? null,
    };
    repo.labels.set(label.name, label);
    return label;
  }

  issuesOf(repo: RepoRec): IssueRec[] {
    return [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue').sort((a, b) => a.seq - b.seq);
  }

  pullsOf(repo: RepoRec): PullRec[] {
    return [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull').sort((a, b) => a.seq - b.seq);
  }

  /**
   * Merge a pull request into its base branch: three-way merge of the flattened trees between
   * the merge base, the base tip and the head tip. Returns the merge commit's sha, or a conflict
   * marker. Squash collapses to one commit on the base tip; merge keeps both parents.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): { sha: string } | { conflict: string } | { error: string } {
    if (pull.merged) return { error: 'already merged' };
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return { error: 'a branch is missing' };
    const base = mergeBase(this.store, baseTip, headTip) ?? baseTip;
    const baseCommit = commitOf(this.store, base);
    const baseTipCommit = commitOf(this.store, baseTip);
    const headCommit = commitOf(this.store, headTip);
    if (baseCommit === null || baseTipCommit === null || headCommit === null) return { error: 'commit missing' };
    const result = mergeFlatTrees(
      flattenTree(this.store, baseCommit.tree),
      flattenTree(this.store, baseTipCommit.tree),
      flattenTree(this.store, headCommit.tree),
    );
    if ('conflict' in result) return { conflict: result.conflict };
    const tree = treeFromFlat(this.store, result.merged);
    let sha: string;
    if (method === 'squash') {
      const message = pull.body === '' ? `${pull.title}\n` : `${pull.title}\n\n${pull.body}\n`;
      sha = this.makeCommit(tree, [baseTip], message);
    } else {
      sha = this.makeCommit(tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n`);
    }
    this.setBranch(repo, pull.baseRef, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { sha };
  }

  /** Whether a pull's head still merges cleanly into its base (GraphQL's mergeable). */
  pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged) return 'MERGEABLE';
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return 'UNKNOWN';
    const base = mergeBase(this.store, baseTip, headTip);
    if (base === null) return 'UNKNOWN';
    const baseCommit = commitOf(this.store, base);
    const baseTipCommit = commitOf(this.store, baseTip);
    const headCommit = commitOf(this.store, headTip);
    if (baseCommit === null || baseTipCommit === null || headCommit === null) return 'UNKNOWN';
    const result = mergeFlatTrees(
      flattenTree(this.store, baseCommit.tree),
      flattenTree(this.store, baseTipCommit.tree),
      flattenTree(this.store, headCommit.tree),
    );
    return 'conflict' in result ? 'CONFLICTING' : 'MERGEABLE';
  }
}

// ---------------------------------------------------------------- global ids (GraphQL)

/** GitHub-style opaque node ids: base64 of a versioned type payload. Never the bare number. */
export function encodeGid(type: string, payload: string): string {
  return Buffer.from(`01:${type}:${payload}`, 'utf8').toString('base64');
}

export function decodeGid(gid: string): { type: string; payload: string } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const match = /^01:([A-Za-z]+):([\s\S]*)$/.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, payload: match[2] as string };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- serializers (REST shapes)

export function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeGid('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGid('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: 'ededed', description: null } : labelJson(label);
    }),
    user: userJson(VIEWER.login, VIEWER.id),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: encodeGid('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(VIEWER.login, VIEWER.id),
    head: { ref: pull.headRef, sha: headTip ?? '', label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseTip ?? '', label: `${repo.owner}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}
