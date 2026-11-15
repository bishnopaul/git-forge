// gitobj.ts: git objects, packs, and commit-graph walks, in memory and from scratch.
//
// Objects are content-addressed exactly as git defines them: sha1("<type> <size>\0" + bytes).
// Packs are read (versions 2 and 3, plain objects plus OFS/REF deltas) and written (plain
// objects, zlib per object, sha1 trailer). On top of the store sit the walks the protocol and
// the API need: ancestry, merge bases, tree flattening/editing, three-way tree merges and
// line-level diff counts. Nothing here shells out to a git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_ID: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TO_TYPE: Record<number, ObjType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta',
};

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface StoredObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

/** The forge's one object database: every repository's objects, keyed by oid. */
export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name bytes, directories compared as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file under a tree, as path -> {mode, oid}; directories are walked, not listed. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** The immediate entries of the subtree at `segments` (or of the root for []). */
export function listTreeAt(store: ObjectStore, treeOid: string, segments: readonly string[]): TreeEntry[] | null {
  let current = treeOid;
  for (const segment of segments) {
    const tree = store.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const tree = store.get(current);
  if (tree === undefined || tree.type !== 'tree') return null;
  return parseTree(tree.data);
}

/** The entry at an exact path, walking subtrees; null when any hop is missing. */
export function entryAtPath(store: ObjectStore, treeOid: string, segments: readonly string[]): TreeEntry | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = store.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * A new tree with the leaf at `segments` set to `leaf` (or removed when leaf is null), rebuilding
 * the path from `baseTreeOid` (null = the empty tree). Empty subtrees are pruned, as git does.
 */
export function updateTree(store: ObjectStore, baseTreeOid: string | null, segments: readonly string[], leaf: TreeEntry | null): string {
  const entries: TreeEntry[] = baseTreeOid === null ? [] : parseTree((store.get(baseTreeOid) as StoredObject).data);
  const [head, ...rest] = segments as [string, ...string[]];
  const index = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    if (leaf === null) {
      if (index >= 0) entries.splice(index, 1);
    } else if (index >= 0) entries[index] = leaf;
    else entries.push(leaf);
  } else {
    const existing = index >= 0 ? entries[index] : undefined;
    const childBase = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
    const childOid = updateTree(store, childBase, rest, leaf);
    const childTree = store.get(childOid) as StoredObject;
    if (parseTree(childTree.data).length === 0) {
      if (index >= 0) entries.splice(index, 1);
    } else if (index >= 0) entries[index] = { mode: '40000', name: head, oid: childOid };
    else entries.push({ mode: '40000', name: head, oid: childOid });
  }
  return store.put('tree', buildTree(entries));
}

/** A tree built from a flat path -> blob map (the merge result's shape). */
export function treeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  let root: string | null = null;
  // Insert deepest paths first is unnecessary: updateTree builds parents on demand.
  for (const [path, leaf] of flat) {
    root = updateTree(store, root, path.split('/'), { mode: leaf.mode, name: path.split('/').pop() as string, oid: leaf.oid });
  }
  if (root === null) root = store.put('tree', buildTree([]));
  return root;
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
}

function parseIdentity(line: string): { name: string; email: string; time: number } {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', time: 0 };
  return { name: match[1] as string, email: match[2] as string, time: Number(match[3]) };
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = { name: '', email: '', time: 0 };
  let committer = { name: '', email: '', time: 0 };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  return {
    tree,
    parents,
    message,
    authorName: author.name,
    authorEmail: author.email,
    authorTime: author.time,
    committerName: committer.name,
    committerEmail: committer.email,
    committerTime: committer.time,
  };
}

export interface Identity {
  name: string;
  email: string;
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: Identity;
  committer: Identity;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author.name} <${input.author.email}> ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer.name} <${input.committer.email}> ${input.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** The commit a ref ultimately names, following annotated tags; null when it is not a commit. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/** The oid an annotated tag peels to (its commit), or null for non-tags. */
export function peeledOf(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(store, oid);
}

// ---------------------------------------------------------------- graph walks

export function commitOf(store: ObjectStore, oid: string): CommitInfo | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Ancestors of `tip` (itself included), breadth-first, tip first. */
export function ancestorsOf(store: ObjectStore, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    const commit = commitOf(store, current);
    if (commit === null) continue;
    seen.add(current);
    order.push(current);
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return order;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = commitOf(store, current);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return false;
}

/** A best common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set(ancestorsOf(store, a));
  if (ancestorsA.has(b)) return b;
  if (new Set(ancestorsOf(store, b)).has(a)) return a;
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (ancestorsA.has(current)) return current;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = commitOf(store, current);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Every object reachable from a commit: the commit chain plus all trees and blobs. */
export function closureOfCommits(store: ObjectStore, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    const tree = store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  for (const tip of tips) {
    for (const commitOid of ancestorsOf(store, tip)) {
      if (out.has(commitOid)) continue;
      out.add(commitOid);
      const commit = commitOf(store, commitOid);
      if (commit !== null) walkTree(commit.tree);
    }
  }
  return out;
}

// ---------------------------------------------------------------- packs

/**
 * Inflate the zlib stream starting at `offset`, finding its exact end: inflate succeeds for any
 * prefix that covers the stream (trailing bytes are ignored) and throws for a shorter one, so
 * success is monotone in prefix length and a binary search lands on the stream's last byte.
 */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; nextOffset: number } {
  const rest = buf.subarray(offset);
  let lo = 0;
  let hi = Math.min(rest.length, 32);
  for (;;) {
    try {
      inflateSync(rest.subarray(0, hi));
      break;
    } catch {
      lo = hi;
      if (hi >= rest.length) throw new Error('pack object does not inflate');
      hi = Math.min(rest.length, hi * 2);
    }
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(rest.subarray(0, hi)), nextOffset: offset + hi };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset] as number; offset += 1; }
      if (op & 0x02) { copyOffset |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= (delta[offset] as number) << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= (delta[offset] as number) << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset] as number; offset += 1; }
      if (op & 0x20) { copySize |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x40) { copySize |= (delta[offset] as number) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface PackEntry {
  offset: number;
  kind: ObjType | 'ofs-delta' | 'ref-delta';
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  oid?: string;
  resolved?: StoredObject;
}

/**
 * Read a whole pack into `store` (resolving deltas against the pack itself and the store) and
 * return the oids it carried. Throws on any structural problem; the caller decides the refusal.
 */
export function unpackPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let offset = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const kindId = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const kind = ID_TO_TYPE[kindId];
    if (kind === undefined) throw new Error(`pack object type ${kindId} unknown`);
    const entry: PackEntry = { offset: start, kind, size, data: Buffer.alloc(0) };
    if (kind === 'ofs-delta') {
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = start - back;
    } else if (kind === 'ref-delta') {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    entry.data = inflated.data;
    offset = inflated.nextOffset;
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const resolve = (entry: PackEntry): StoredObject => {
    if (entry.resolved !== undefined) return entry.resolved;
    let resolved: StoredObject;
    if (entry.kind === 'ofs-delta' || entry.kind === 'ref-delta') {
      const baseEntry = entry.kind === 'ofs-delta' ? byOffset.get(entry.baseOffset as number) : entries.find((c) => c.oid === entry.baseOid);
      let base: StoredObject | undefined;
      if (baseEntry !== undefined) base = resolve(baseEntry);
      else if (entry.baseOid !== undefined) base = store.get(entry.baseOid);
      if (base === undefined) throw new Error('delta base not found');
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: entry.kind, data: entry.data };
    }
    entry.resolved = resolved;
    entry.oid = hashObject(resolved.type, resolved.data);
    return resolved;
  };
  const oids: string[] = [];
  for (const entry of entries) {
    const resolved = resolve(entry);
    const oid = hashObject(resolved.type, resolved.data);
    if (!store.objects.has(oid)) store.objects.set(oid, resolved);
    oids.push(oid);
  }
  return oids;
}

/** A pack carrying `objects` as plain (undeltified) entries, with the sha1 trailer. */
export function writePack(objects: readonly StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const bytes: number[] = [];
    let first = (TYPE_TO_ID[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- diffs and merges

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function countLines(data: Buffer): number {
  return splitLines(data.toString('utf8')).length;
}

/** Added/deleted line counts between two blob versions, by longest common subsequence. */
export function lineDiffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = splitLines(oldData.toString('utf8'));
  const newLines = splitLines(newData.toString('utf8'));
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp: number[] = new Array(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      const above = dp[j] as number;
      if (oldLines[i - 1] === newLines[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j] as number, dp[j - 1] as number);
      diagonal = above;
    }
  }
  const common = dp[newLines.length] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

/** The per-file changes between two trees (merge-base tree -> head tree, for pull requests). */
export function diffTrees(store: ObjectStore, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(store, fromTree);
  const to = toTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(store, toTree);
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    if (before === undefined && after !== undefined) {
      const blob = store.get(after.oid);
      changes.push({ path, status: 'added', additions: blob === undefined ? 0 : countLines(blob.data), deletions: 0 });
    } else if (before !== undefined && after === undefined) {
      const blob = store.get(before.oid);
      changes.push({ path, status: 'removed', additions: 0, deletions: blob === undefined ? 0 : countLines(blob.data) });
    } else if (before !== undefined && after !== undefined) {
      const oldBlob = store.get(before.oid);
      const newBlob = store.get(after.oid);
      const counts = lineDiffCounts(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

/**
 * A three-way merge of flattened trees: a path changed on only one side takes that side, a path
 * changed identically on both takes it too, anything else is a conflict (its path is returned).
 */
export function mergeFlatTrees(
  base: ReadonlyMap<string, { mode: string; oid: string }>,
  ours: ReadonlyMap<string, { mode: string; oid: string }>,
  theirs: ReadonlyMap<string, { mode: string; oid: string }>,
): { merged: Map<string, { mode: string; oid: string }> } | { conflict: string } {
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: { mode: string; oid: string } | undefined, y: { mode: string; oid: string } | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { merged };
}
