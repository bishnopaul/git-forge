// githttp.ts: git smart HTTP — info/refs advertisements, upload-pack (protocol v2 ls-refs and
// fetch, plus v0 fetch for other clients), and receive-pack (v0 with report-status). The forge
// serves all of it from its own object store; no git binary is involved anywhere.
//
// The fetch set arithmetic, in one place: a fetch delivers the objects reachable from the wants
// (bounded by the deepen limit when one is sent), minus what the client already holds — the full
// closure of each have, except that a have the client lists as shallow contributes only itself
// and its trees, never its parents (that is what makes deepen deliver the parent generation).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  ancestorsOf,
  commitOf,
  isAncestor,
  parseTree,
  peelToCommit,
  peeledOf,
  unpackPack,
  writePack,
  type ObjectStore,
  type StoredObject,
} from './gitobj.ts';
import { DELIM, FLUSH, pktLine, pktTexts, readPkts, sidebandPackets, type Pkt } from './pktline.ts';
import type { Forge, RepoRec } from './store.ts';

const AGENT = 'forge/1.0.0';
export const UPLOAD_CAPS = `side-band-64k ofs-delta shallow agent=${AGENT}`;
export const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

/** Every ref line a repo advertises: HEAD's target first (handled by the caller), then sorted refs. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- advertisements

function advertisementV0(forge: Forge, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:${headTarget(repo)}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headOid = forge.branchTip(repo, repo.defaultBranch);
    if (headOid !== null) {
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
      const peeled = peeledOf(forge.store, oid);
      if (peeled !== null && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- fetch computation

export interface FetchPlan {
  objects: StoredObject[];
  shallow: string[];
  unshallow: string[];
}

/** Add a commit's whole tree hierarchy (every subtree and blob) to `into`. */
function treeClosure(store: ObjectStore, commitOid: string, into: Set<string>): void {
  const commit = commitOf(store, commitOid);
  if (commit === null) return;
  const addTree = (treeOid: string): void => {
    if (into.has(treeOid)) return;
    const tree = store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    into.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else into.add(entry.oid);
    }
  };
  addTree(commit.tree);
}

/**
 * The objects a fetch must deliver and the shallow bookkeeping to report.
 * wants/haves are commit oids (already peeled); clientShallow is the client's shallow list.
 */
export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  deepen: number | null,
  deepenSince: number | null,
  deepenRelative = false,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // What the client already holds: from each have, everything reachable without crossing a
  // shallow commit's parent edge (a shallow commit itself is held, its parents are not), plus
  // the tree closure of every held commit.
  const held = new Set<string>();
  {
    const heldCommits = new Set<string>();
    for (const have of haves) {
      const queue: string[] = [have];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (!store.has(oid)) continue;
        heldCommits.add(oid);
        if (shallowSet.has(oid)) continue;
        const commit = commitOf(store, oid);
        if (commit !== null) queue.push(...commit.parents);
      }
    }
    for (const oid of heldCommits) {
      held.add(oid);
      treeClosure(store, oid, held);
    }
  }
  // Minimal depth of every commit reachable from the wants (want tips are depth 1). The walk is
  // capped at the effective limit: for an absolute deepen that is the limit itself; for a
  // relative deepen the cap settles once every shallow commit's depth is known.
  const depthOf = new Map<string, number>();
  {
    let cap = deepen === null ? Number.POSITIVE_INFINITY : deepenRelative ? Number.POSITIVE_INFINITY : deepen;
    let shallowPending = deepenRelative ? new Set(clientShallow) : new Set<string>();
    let boundaryDepth = 0;
    const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 1 }));
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      const commit = commitOf(store, oid);
      if (commit === null) continue;
      const known = depthOf.get(oid);
      if (known !== undefined && known <= depth) continue;
      depthOf.set(oid, depth);
      if (shallowPending.has(oid)) {
        shallowPending.delete(oid);
        if (depth > boundaryDepth) boundaryDepth = depth;
        if (shallowPending.size === 0 && deepen !== null) cap = boundaryDepth + deepen;
      }
      if (depth >= cap) continue;
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  // The effective depth limit: 'deepen N' is absolute from the wants, except with
  // 'deepen-relative', where it reaches N generations past the client's shallow boundary.
  let limit = deepen;
  if (deepen !== null && deepenRelative) {
    let boundaryDepth = 0;
    for (const oid of clientShallow) {
      const depth = depthOf.get(oid);
      if (depth !== undefined && depth > boundaryDepth) boundaryDepth = depth;
    }
    if (boundaryDepth > 0) limit = boundaryDepth + deepen;
  }
  const included = new Set<string>();
  for (const [oid, depth] of depthOf) {
    if (limit !== null && depth > limit) continue;
    const commit = commitOf(store, oid);
    if (commit === null) continue;
    if (deepenSince !== null && commit.committerTime <= deepenSince) continue;
    included.add(oid);
  }
  const deliver = new Set<string>();
  for (const oid of included) {
    if (!held.has(oid)) deliver.add(oid);
    const closure = new Set<string>();
    treeClosure(store, oid, closure);
    for (const entry of closure) if (!held.has(entry)) deliver.add(entry);
  }
  // Tag objects named directly as wants ride along (their commits are walked above).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (limit !== null || deepenSince !== null) {
    for (const oid of included) {
      const commit = commitOf(store, oid);
      if (commit === null || commit.parents.length === 0) continue;
      const atLimit = limit !== null && depthOf.get(oid) === limit;
      const parentCut = commit.parents.some((parent) => !included.has(parent));
      if ((atLimit || parentCut) && !shallowSet.has(oid)) shallow.push(oid);
    }
    for (const oid of clientShallow) {
      if (included.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
    }
  }
  const objects: StoredObject[] = [];
  for (const oid of deliver) {
    const object = store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(forge: Forge, repo: RepoRec, packets: readonly Pkt[]): Buffer {
  const lines = pktTexts(packets);
  const args = lines.slice(1); // lines[0] is the command line; capability lines end at the delim
  // pktTexts flattens data packets across the delim; capability lines (agent=, object-format=)
  // come before args. Args are the known ls-refs verbs; filter to them.
  const argLines = args.filter((line) => line === 'peel' || line === 'symrefs' || line === 'unborn' || line.startsWith('ref-prefix '));
  const wantPeel = argLines.includes('peel');
  const wantSymrefs = argLines.includes('symrefs');
  const wantUnborn = argLines.includes('unborn');
  const prefixes = argLines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headOid = forge.branchTip(repo, repo.defaultBranch);
  if (matches('HEAD')) {
    if (headOid !== null) {
      out.push(pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    } else if (wantUnborn) {
      out.push(pktLine(`unborn HEAD symref-target:${headTarget(repo)}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const peeled = peeledOf(forge.store, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch (v2 and v0)

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenRelative: boolean;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], deepen: null, deepenSince: null, deepenRelative: false, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line === 'done') args.done = true;
  }
  return args;
}

function resolveWants(forge: Forge, repo: RepoRec, rawWants: readonly string[]): { commits: string[]; extra: StoredObject[] } | null {
  const commits: string[] = [];
  const extra: StoredObject[] = [];
  for (const raw of rawWants) {
    const object = forge.store.get(raw);
    if (object === undefined) return null;
    if (object.type === 'tag') {
      extra.push(object);
      const commit = peelToCommit(forge.store, raw);
      if (commit === null) return null;
      commits.push(commit);
    } else if (object.type === 'commit') {
      commits.push(raw);
    } else {
      return null;
    }
  }
  void repo;
  return { commits, extra };
}

function handleFetchV2(forge: Forge, repo: RepoRec, packets: readonly Pkt[]): Buffer {
  const lines = pktTexts(packets);
  const args = parseFetchArgs(lines.slice(1));
  const resolved = resolveWants(forge, repo, args.wants);
  if (resolved === null) {
    return Buffer.concat([pktLine(`ERR fetch failed: unknown object\n`), FLUSH]);
  }
  const haves = args.haves.map((have) => peelToCommit(forge.store, have) ?? have);
  if (!args.done) {
    // Negotiation round: acknowledge a common have when there is one, ask for more otherwise.
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    const common = args.haves.find((have) => {
      const commit = peelToCommit(forge.store, have);
      return commit !== null && resolved.commits.some((want) => want === commit || isAncestor(forge.store, commit, want));
    });
    parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const plan = planFetch(forge.store, resolved.commits, haves, args.clientShallow, args.deepen, args.deepenSince, args.deepenRelative);
  const pack = writePack([...resolved.extra, ...plan.objects]);
  // With 'done' sent, git's own upload-pack answers with the packfile directly (no
  // acknowledgments section); the shallow-info section precedes it when there is news.
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(pack, 1));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPackV0(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  // Want lines up to the first flush, then have lines up to the second flush (or end of body).
  const first = readPkts(body);
  const wantLines = pktTexts(first.packets);
  const caps = new Set<string>();
  const wants: string[] = [];
  for (const line of wantLines) {
    if (!line.startsWith('want ')) continue;
    const rest = line.slice(5);
    const space = rest.indexOf(' ');
    if (space === -1) wants.push(rest.trim());
    else {
      wants.push(rest.slice(0, space).trim());
      for (const cap of rest.slice(space + 1).split(' ')) if (cap !== '') caps.add(cap);
    }
  }
  let haveLines: string[] = [];
  if (first.rest.length > 0) {
    try {
      haveLines = pktTexts(readPkts(first.rest).packets);
    } catch {
      haveLines = [];
    }
  }
  const args = parseFetchArgs(haveLines);
  const resolved = resolveWants(forge, repo, wants);
  if (resolved === null) return Buffer.concat([pktLine('ERR unknown object\n'), FLUSH]);
  const haves = args.haves.map((have) => peelToCommit(forge.store, have) ?? have);
  const plan = planFetch(forge.store, resolved.commits, haves, args.clientShallow, args.deepen, args.deepenSince, args.deepenRelative);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.find((have) => {
    const commit = peelToCommit(forge.store, have);
    return commit !== null && resolved.commits.some((want) => want === commit || isAncestor(forge.store, commit, want));
  });
  parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  const pack = writePack([...resolved.extra, ...plan.objects]);
  if (caps.has('side-band-64k') || caps.has('side-band')) {
    parts.push(sidebandPackets(pack, 1));
    parts.push(FLUSH);
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

function handleUploadPackV2(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const { packets } = readPkts(body);
  const firstData = packets.find((packet) => packet.kind === 'data');
  const command = firstData !== undefined && firstData.kind === 'data' ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
  if (command === 'command=ls-refs') return handleLsRefs(forge, repo, packets);
  if (command === 'command=fetch') return handleFetchV2(forge, repo, packets);
  return Buffer.concat([pktLine(`ERR unknown command\n`), FLUSH]);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  let packets: Pkt[];
  let packBytes: Buffer;
  try {
    const parsed = readPkts(body);
    packets = parsed.packets;
    packBytes = parsed.rest;
  } catch {
    // A malformed command stream must never take the server down; answer a minimal refusal.
    return Buffer.concat([pktLine('unpack error: malformed request\n'), FLUSH]);
  }
  const lines = pktTexts(packets);
  const commands: PushCommand[] = [];
  let caps = new Set<string>();
  lines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        caps = new Set(text.slice(nul + 1).split(' ').filter((cap) => cap !== ''));
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  });
  const reportStatus = caps.has('report-status');
  const sideband = caps.has('side-band-64k');
  const hasUpdate = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (hasUpdate && packBytes.length > 0) {
    try {
      unpackPack(forge.store, packBytes);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      fail('invalid ref');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) fail('reference not found');
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) fail('stale info');
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === ZERO_OID && command.oldOid !== ZERO_OID) {
      fail('reference not found');
      continue;
    }
    if (current !== ZERO_OID && command.oldOid === ZERO_OID) {
      fail('already exists');
      continue;
    }
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    const newObject = forge.store.get(command.newOid);
    if (newObject === undefined) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID && command.newOid !== current) {
      const newCommit = peelToCommit(forge.store, command.newOid);
      const oldCommit = peelToCommit(forge.store, current);
      if (newCommit === null || oldCommit === null || !isAncestor(forge.store, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (!reportStatus) return Buffer.alloc(0);
  const reportLines: string[] = [unpackError !== null ? `unpack ${unpackError.replace(/\s+/g, ' ')}` : 'unpack ok'];
  for (const result of results) reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  // The report is a complete pkt-line stream (flush-terminated); with side-band-64k that whole
  // stream rides inside band-1 packets and the sideband then gets a flush of its own.
  const reportBody = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  if (sideband) return Buffer.concat([sidebandPackets(reportBody, 1), FLUSH]);
  return reportBody;
}

// ---------------------------------------------------------------- entry point

/** Route one git smart-HTTP request. `segments` is the decoded path after the host root. */
export function handleGitHttp(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  if (segments.length < 2) return false;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return false;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const tail = segments.slice(2).join('/');
  const method = req.method ?? 'GET';
  const repo = forge.getRepo(owner, repoName);

  if (method === 'GET' && tail === 'info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendText(res, 400, 'service not understood\n');
      return true;
    }
    if (repo === undefined) {
      sendText(res, 404, 'repository not found\n');
      return true;
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (service === 'git-upload-pack' && wantsV2) {
      send(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV2());
    } else {
      const contentType = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
      send(res, 200, contentType, advertisementV0(forge, repo, service));
    }
    return true;
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    if (repo === undefined) {
      sendText(res, 404, 'repository not found\n');
      return true;
    }
    try {
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const out = wantsV2 ? handleUploadPackV2(forge, repo, body) : handleUploadPackV0(forge, repo, body);
      send(res, 200, 'application/x-git-upload-pack-result', out);
    } catch (error) {
      sendText(res, 500, `upload-pack failed: ${error instanceof Error ? error.message : 'error'}\n`);
    }
    return true;
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    if (repo === undefined) {
      sendText(res, 404, 'repository not found\n');
      return true;
    }
    try {
      const out = handleReceivePack(forge, repo, body);
      send(res, 200, 'application/x-git-receive-pack-result', out);
    } catch (error) {
      sendText(res, 500, `receive-pack failed: ${error instanceof Error ? error.message : 'error'}\n`);
    }
    return true;
  }

  return false;
}
