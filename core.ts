/**
 * core.ts — the pure domain layer of the forge.
 *
 * This module knows nothing about HTTP, JSON, pkt-lines or GraphQL. It owns:
 *   - the global content-addressed git object store (one map for all repos),
 *   - repositories, refs, issues, pull requests, labels and comments,
 *   - git object parsing/building, history walks, tree diffs and merges,
 *   - deterministic identity (fixed epoch, opaque global ids).
 *
 * Everything here is synchronous and deterministic: the same sequence of
 * operations always produces the same state, which is what makes live/replay
 * exports identical. Timestamps emitted by the forge all come from the fixed
 * scenario epoch — wall-clock time never leaks into stored or served data.
 */

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The scenario's day one (2025-01-01T00:00:00Z): every timestamp the forge emits. */
export const FORGE_EPOCH_SEC = 1_735_689_600;
export const FORGE_EPOCH_ISO = '2025-01-01T00:00:00Z';
/** SHA-1 of `tree 0\0` — the well-known empty tree, valid even if never stored. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const DEFAULT_BRANCH = 'main';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** An error carrying the HTTP status the wire layers should answer with. */
export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
  }
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Object parsing (defensive: malformed objects yield defaults, never throws)
// ---------------------------------------------------------------------------

export interface Identity {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  /** Message bytes after the first blank line, verbatim. */
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: Identity | null;
  message: string;
}

const EMPTY_IDENTITY: Identity = { name: '', email: '', time: 0, tz: '+0000' };

function parseIdentity(text: string): Identity {
  const lt = text.indexOf('<');
  const gt = lt >= 0 ? text.indexOf('>', lt + 1) : -1;
  if (lt < 0 || gt < 0) return { ...EMPTY_IDENTITY, name: text.trim() };
  const name = text.slice(0, lt).trim();
  const email = text.slice(lt + 1, gt);
  const rest = text.slice(gt + 1).trim().split(/\s+/);
  const time = rest.length > 0 ? Number.parseInt(rest[0]!, 10) : 0;
  return {
    name,
    email,
    time: Number.isFinite(time) ? time : 0,
    tz: rest.length > 1 ? rest[1]! : '+0000',
  };
}

function splitHeaders(data: Buffer): { headers: string[]; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  if (blank < 0) return { headers: text.split('\n'), message: '' };
  return { headers: text.slice(0, blank).split('\n'), message: text.slice(blank + 2) };
}

export function parseCommit(data: Buffer): CommitInfo {
  const { headers, message } = splitHeaders(data);
  let tree = '';
  const parents: string[] = [];
  let author: Identity = { ...EMPTY_IDENTITY };
  let committer: Identity = { ...EMPTY_IDENTITY };
  for (const line of headers) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header (e.g. gpgsig)
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function parseTag(data: Buffer): TagInfo {
  const { headers, message } = splitHeaders(data);
  let object = '';
  let type = '';
  let tag = '';
  let tagger: Identity | null = null;
  for (const line of headers) {
    if (line.startsWith(' ')) continue;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = parseIdentity(line.slice(7));
  }
  return { object, type, tag, tagger, message };
}

/** Git tree-entry sort: names compared byte-wise, directories as if suffixed with '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(aKey, 'utf8'), Buffer.from(bKey, 'utf8'));
}

export function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommitBytes(info: {
  tree: string;
  parents: readonly string[];
  author: Identity;
  committer: Identity;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  const fmt = (who: Identity, role: string): string =>
    `${role} ${who.name} <${who.email}> ${who.time} ${who.tz}`;
  lines.push(fmt(info.author, 'author'));
  lines.push(fmt(info.committer, 'committer'));
  return Buffer.concat([
    Buffer.from(`${lines.join('\n')}\n\n`, 'utf8'),
    Buffer.from(info.message, 'utf8'),
  ]);
}

// ---------------------------------------------------------------------------
// Validation (git-check-ref-format subset + GitHub repo naming)
// ---------------------------------------------------------------------------

export function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  if (ref.length < 6 || ref.length > 255) return false;
  if (ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  if (ref.includes('..') || ref.includes('//')) return false;
  if (ref.includes('@{') || ref === '@') return false;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
    const ch = ref[i]!;
    if (ch === ' ' || ch === '~' || ch === '^' || ch === ':' || ch === '?' || ch === '*' || ch === '[' || ch === '\\') {
      return false;
    }
  }
  for (const component of ref.split('/')) {
    if (component === '' || component === '.' || component === '..' || component.startsWith('.')) return false;
    if (component.endsWith('.lock')) return false;
  }
  return true;
}

export function isValidRepoName(name: string): boolean {
  if (name.length < 1 || name.length > 100) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  if (name.endsWith('.git')) return false;
  return true;
}

/** Split a contents path into segments; rejects empty, '.', '..' and empty segments. */
export function splitContentPath(path: string): string[] | null {
  if (path === '') return [];
  if (path.startsWith('/') || path.endsWith('/')) return null;
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  authorLogin: string;
  seq: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  closedAt: string | null;
  /** Cached REST JSON rendering; cleared on any mutation of this issue. */
  jsonCache: Buffer | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  /** Bumped on every mutation; wire caches key off it. */
  gen: number;
  createdSeq: number;
  /** Cached REST JSON rendering; cleared on any mutation of this repo's fields. */
  jsonCache: Buffer | null;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** A materialised tree: full path -> blob entry. Treat as read-only (cached). */
export type FlatTree = ReadonlyMap<string, FlatEntry>;

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

// ---------------------------------------------------------------------------
// The forge
// ---------------------------------------------------------------------------

const CACHE_LIMIT = 4096;

export class Forge {
  readonly viewerLogin: string;
  readonly viewerId = 1000;

  /** Global content-addressed object store: every repo shares it. */
  private readonly objects = new Map<string, GitObject>();
  private readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private seq = 0;

  /** Immutable-object caches: parse/flatten results never go stale. */
  private readonly commitCache = new Map<string, CommitInfo>();
  private readonly treeCache = new Map<string, readonly TreeEntry[]>();
  private readonly flatCache = new Map<string, FlatTree>();
  /** Objects whose full closure has been verified present. Never goes stale:
   * objects are immutable and the store only grows. */
  private readonly completeObjects = new Set<string>();

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  viewerEmail(): string {
    return `${this.viewerLogin}@example.invalid`;
  }

  viewerIdentity(): Identity {
    return { name: this.viewerLogin, email: this.viewerEmail(), time: FORGE_EPOCH_SEC, tz: '+0000' };
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // -- object store -----------------------------------------------------------

  hasObject(oid: string): boolean {
    return oid === EMPTY_TREE_OID || this.objects.has(oid);
  }

  getObject(oid: string): GitObject | undefined {
    if (oid === EMPTY_TREE_OID) return { type: 'tree', data: Buffer.alloc(0) };
    return this.objects.get(oid);
  }

  /** Store an object, computing its id from content. Returns the id. */
  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (pack ingestion). */
  putObjectWithId(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  objectCount(): number {
    return this.objects.size;
  }

  isCompleteObject(oid: string): boolean {
    return this.completeObjects.has(oid);
  }

  markCompleteObjects(oids: Iterable<string>): void {
    for (const oid of oids) {
      if (this.completeObjects.size >= 100_000) this.completeObjects.clear();
      this.completeObjects.add(oid);
    }
  }

  // -- cached parsing ---------------------------------------------------------

  parseCommit(oid: string): CommitInfo | undefined {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const object = this.getObject(oid);
    if (!object || object.type !== 'commit') return undefined;
    const info = parseCommit(object.data);
    if (this.commitCache.size >= CACHE_LIMIT) this.commitCache.clear();
    this.commitCache.set(oid, info);
    return info;
  }

  parseTree(oid: string): readonly TreeEntry[] | undefined {
    if (oid === EMPTY_TREE_OID) return [];
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const object = this.getObject(oid);
    if (!object || object.type !== 'tree') return undefined;
    const entries = parseTree(object.data);
    if (this.treeCache.size >= CACHE_LIMIT) this.treeCache.clear();
    this.treeCache.set(oid, entries);
    return entries;
  }

  parseTag(oid: string): TagInfo | undefined {
    const object = this.getObject(oid);
    if (!object || object.type !== 'tag') return undefined;
    return parseTag(object.data);
  }

  /** Follow tag objects to the underlying object (max 16 hops, cycle-safe). */
  peel(oid: string): { oid: string; type: ObjectType } | undefined {
    let current = oid;
    const seen = new Set<string>();
    for (let hop = 0; hop < 16; hop += 1) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      const object = this.getObject(current);
      if (!object) return undefined;
      if (object.type !== 'tag') return { oid: current, type: object.type };
      const tag = parseTag(object.data);
      if (!tag.object) return undefined;
      current = tag.object;
    }
    return undefined;
  }

  /** Peel to a commit, or undefined when the target is not a commit. */
  peelToCommit(oid: string): string | undefined {
    const peeled = this.peel(oid);
    return peeled && peeled.type === 'commit' ? peeled.oid : undefined;
  }

  /** Flatten a tree to path -> entry, memoised per tree id (trees are immutable). */
  flatten(treeOid: string): FlatTree | undefined {
    const cached = this.flatCache.get(treeOid);
    if (cached) return cached;
    const entries = this.parseTree(treeOid);
    if (entries === undefined) return undefined;
    const flat = new Map<string, FlatEntry>();
    for (const entry of entries) {
      if (entry.mode === '40000') {
        const sub = this.flatten(entry.oid);
        if (sub === undefined) return undefined;
        for (const [path, value] of sub) flat.set(`${entry.name}/${path}`, value);
      } else {
        flat.set(entry.name, { oid: entry.oid, mode: entry.mode });
      }
    }
    if (this.flatCache.size >= CACHE_LIMIT) this.flatCache.clear();
    this.flatCache.set(treeOid, flat);
    return flat;
  }

  /** Build (and store) the tree objects for a flat path map; returns the root tree id. */
  buildTree(flat: ReadonlyMap<string, FlatEntry>): string {
    interface DirNode {
      files: TreeEntry[];
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]!;
        let child = node.dirs.get(segment);
        if (!child) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
    }
    const emit = (node: DirNode): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: emit(child) });
      }
      return this.putObject('tree', buildTreeBytes(entries));
    };
    return emit(root);
  }

  /** Create and store a commit object; returns its id. */
  createCommit(tree: string, parents: readonly string[], message: string): string {
    const identity = this.viewerIdentity();
    return this.putObject(
      'commit',
      buildCommitBytes({ tree, parents, author: identity, committer: identity, message }),
    );
  }

  // -- history walks ------------------------------------------------------------

  /** Iterative pre-order DFS over commit parents (tip first, visited once). */
  historyFrom(tip: string, limit: number): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0 && result.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.parseCommit(oid);
      if (!commit) continue;
      result.push(oid);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return result;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.parseCommit(oid);
      if (!commit) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** First common ancestor by DFS from `a` over the ancestor set of `b`. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfB = new Set<string>();
    const stack: string[] = [b];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (ancestorsOfB.has(oid)) continue;
      ancestorsOfB.add(oid);
      const commit = this.parseCommit(oid);
      if (!commit) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    const seen = new Set<string>();
    const walk: string[] = [a];
    while (walk.length > 0) {
      const oid = walk.pop()!;
      if (ancestorsOfB.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.parseCommit(oid);
      if (!commit) continue;
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) walk.push(commit.parents[i]!);
    }
    return null;
  }

  /** Every object reachable from the tips (commits, trees, blobs, tags; gitlinks skipped). */
  collectReachable(tips: readonly string[]): Set<string> {
    const found = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (found.has(oid)) continue;
      const object = this.getObject(oid);
      if (!object) continue;
      found.add(oid);
      if (object.type === 'commit') {
        const commit = this.parseCommit(oid);
        if (commit) {
          stack.push(commit.tree);
          for (const parent of commit.parents) stack.push(parent);
        }
      } else if (object.type === 'tree') {
        const entries = this.parseTree(oid);
        if (entries) {
          for (const entry of entries) {
            if (entry.mode === '160000') continue; // gitlink: lives in another repo
            stack.push(entry.oid);
          }
        }
      } else if (object.type === 'tag') {
        const tag = parseTag(object.data);
        if (tag.object) stack.push(tag.object);
      }
    }
    return found;
  }

  // -- repositories -------------------------------------------------------------

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    if (!isValidRepoName(name)) {
      throw new ForgeError(422, `Invalid repository name ${JSON.stringify(name)}`);
    }
    for (const existing of this.repos.values()) {
      if (existing.name.toLowerCase() === name.toLowerCase()) {
        throw new ForgeError(422, `Repository ${name} already exists`);
      }
    }
    const repo: Repo = {
      id: this.nextId,
      name,
      owner: this.viewerLogin,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      gen: 0,
      createdSeq: this.nextSeq(),
      jsonCache: null,
    };
    this.nextId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== this.viewerLogin.toLowerCase()) return undefined;
    const exact = this.repos.get(name);
    if (exact) return exact;
    for (const repo of this.repos.values()) {
      if (repo.name.toLowerCase() === name.toLowerCase()) return repo;
    }
    return undefined;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  updateRepo(repo: Repo, patch: { name?: string; description?: string; isPrivate?: boolean }): void {
    if (patch.name !== undefined && patch.name !== repo.name) {
      if (!isValidRepoName(patch.name)) {
        throw new ForgeError(422, `Invalid repository name ${JSON.stringify(patch.name)}`);
      }
      for (const existing of this.repos.values()) {
        if (existing !== repo && existing.name.toLowerCase() === patch.name.toLowerCase()) {
          throw new ForgeError(422, `Repository ${patch.name} already exists`);
        }
      }
      this.repos.delete(repo.name);
      repo.name = patch.name;
      this.repos.set(repo.name, repo);
    }
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.isPrivate !== undefined) repo.isPrivate = patch.isPrivate;
    repo.gen += 1;
    repo.jsonCache = null;
  }

  // -- refs ---------------------------------------------------------------------

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(repo: Repo): string | undefined {
    return this.branchTip(repo, repo.defaultBranch);
  }

  /** Resolve a rev: 'HEAD', a full ref, a short branch/tag name, or a 40-hex id. */
  resolveRev(repo: Repo, rev: string): string | undefined {
    if (rev === 'HEAD') return this.defaultTip(repo);
    if (rev.startsWith('refs/')) return repo.refs.get(rev);
    if (isOid(rev)) return this.hasObject(rev) ? rev : undefined;
    const branch = repo.refs.get(`refs/heads/${rev}`);
    if (branch) return branch;
    return repo.refs.get(`refs/tags/${rev}`);
  }

  /** Resolve a rev to a commit id (peeling tags), or undefined. */
  resolveRevToCommit(repo: Repo, rev: string): string | undefined {
    const oid = this.resolveRev(repo, rev);
    if (!oid) return undefined;
    return this.peelToCommit(oid);
  }

  createRef(repo: Repo, ref: string, oid: string): void {
    if (!isValidRefName(ref)) throw new ForgeError(422, `Invalid ref name ${JSON.stringify(ref)}`);
    if (repo.refs.has(ref)) throw new ForgeError(422, `Reference ${ref} already exists`);
    if (!this.hasObject(oid)) throw new ForgeError(422, `Object ${oid} does not exist`);
    repo.refs.set(ref, oid);
    repo.gen += 1;
    repo.jsonCache = null;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const deleted = repo.refs.delete(ref);
    if (deleted) {
      repo.gen += 1;
      repo.jsonCache = null;
    }
    return deleted;
  }

  /** Unconditional ref write (push/merge/contents paths validate first). */
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.gen += 1;
    repo.jsonCache = null;
  }

  /** Branch names in sorted order. */
  listBranches(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** All refs sorted by name. */
  listRefs(repo: Repo): Array<{ ref: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([ref, oid]) => ({ ref, oid }))
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  // -- labels -------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (!name) throw new ForgeError(422, 'Label name is required');
    if (repo.labels.has(name)) throw new ForgeError(422, `Label ${name} already exists`);
    const label: Label = { id: this.nextId, name, color };
    this.nextId += 1;
    repo.labels.set(name, label);
    repo.gen += 1;
    return label;
  }

  // -- issues -------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    if (!title) throw new ForgeError(422, 'Issue title is required');
    const labels: string[] = [];
    for (const name of labelNames) {
      if (!repo.labels.has(name)) throw new ForgeError(422, `Label ${name} does not exist`);
      if (!labels.includes(name)) labels.push(name);
    }
    const seq = this.nextSeq();
    const issue: Issue = {
      id: this.nextId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labelNames: labels,
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
      closedAt: null,
      jsonCache: null,
    };
    this.nextId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    repo.gen += 1;
    return issue;
  }

  patchIssue(
    repo: Repo,
    issue: Issue,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; labelNames?: readonly string[] },
  ): Issue {
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? FORGE_EPOCH_ISO : null;
    }
    if (patch.labelNames !== undefined) {
      const labels: string[] = [];
      for (const name of patch.labelNames) {
        if (!repo.labels.has(name)) throw new ForgeError(422, `Label ${name} does not exist`);
        if (!labels.includes(name)) labels.push(name);
      }
      issue.labelNames = labels;
    }
    issue.updatedSeq = this.nextSeq();
    issue.jsonCache = null;
    repo.gen += 1;
    return issue;
  }

  addIssueComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextId, body, authorLogin: this.viewerLogin, seq: this.nextSeq() };
    this.nextId += 1;
    issue.comments.push(comment);
    issue.updatedSeq = this.nextSeq();
    issue.jsonCache = null;
    repo.gen += 1;
    return comment;
  }

  // -- pull requests --------------------------------------------------------------

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest {
    if (!title) throw new ForgeError(422, 'Pull request title is required');
    if (headRef === baseRef) {
      throw new ForgeError(422, 'No commits between the head and base branches');
    }
    const headTip = this.branchTip(repo, headRef);
    if (!headTip) throw new ForgeError(422, `Head branch ${headRef} does not exist`);
    const baseTip = this.branchTip(repo, baseRef);
    if (!baseTip) throw new ForgeError(422, `Base branch ${baseRef} does not exist`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        throw new ForgeError(422, 'A pull request already exists for this head and base');
      }
    }
    const seq = this.nextSeq();
    const pull: PullRequest = {
      id: this.nextId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headShaAtCreate: headTip,
      baseShaAtCreate: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.nextId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    repo.gen += 1;
    return pull;
  }

  /** Live branch tips, falling back to the creation-time shas when a branch is gone. */
  pullTips(repo: Repo, pull: PullRequest): { head: string; base: string } {
    return {
      head: this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate,
      base: this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate,
    };
  }

  addPullComment(repo: Repo, pull: PullRequest, body: string): Comment {
    const comment: Comment = { id: this.nextId, body, authorLogin: this.viewerLogin, seq: this.nextSeq() };
    this.nextId += 1;
    pull.comments.push(comment);
    pull.updatedSeq = this.nextSeq();
    repo.gen += 1;
    return comment;
  }

  // -- diffs and merges -------------------------------------------------------------

  private countLines(data: Buffer): string[] {
    if (data.length === 0) return [];
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private lineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
    const oldLines = oldData ? this.countLines(oldData) : [];
    const newLines = newData ? this.countLines(newData) : [];
    const counts = new Map<string, number>();
    for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const remaining = counts.get(line) ?? 0;
      if (remaining > 0) counts.set(line, remaining - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const remaining of counts.values()) deletions += remaining;
    return { additions, deletions };
  }

  /** Two-tree diff, sorted by filename. */
  diffTrees(baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = this.flatten(baseTreeOid);
    const head = this.flatten(headTreeOid);
    if (!base || !head) throw new ForgeError(404, 'Tree not found');
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of paths) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry && newEntry && oldEntry.oid === newEntry.oid && oldEntry.mode === newEntry.mode) continue;
      const oldData = oldEntry ? this.getObject(oldEntry.oid)?.data : undefined;
      const newData = newEntry ? this.getObject(newEntry.oid)?.data : undefined;
      const { additions, deletions } = this.lineDiff(oldData, newData);
      changes.push({
        filename: path,
        status: !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    changes.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return changes;
  }

  /** Three-dot diff for a pull request: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const { head, base } = this.pullTips(repo, pull);
    const base0 = this.mergeBase(head, base);
    const baseTree = base0 ? (this.parseCommit(base0)?.tree ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
    const headTree = this.parseCommit(head)?.tree;
    if (!headTree) throw new ForgeError(404, 'Head commit not found');
    return this.diffTrees(baseTree, headTree);
  }

  /** Mergeability: 'MERGEABLE', 'CONFLICTING', or 'UNKNOWN' (closed PRs are UNKNOWN). */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    try {
      const plan = this.planMerge(repo, pull);
      return plan.conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
    } catch {
      return 'UNKNOWN';
    }
  }

  private planMerge(
    repo: Repo,
    pull: PullRequest,
  ): { conflicts: string[]; merged: Map<string, FlatEntry>; baseTip: string; headTip: string } {
    const { head: headTip, base: baseTip } = this.pullTips(repo, pull);
    const base0 = this.mergeBase(headTip, baseTip);
    const base0Tree = base0 ? (this.parseCommit(base0)?.tree ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
    const headTree = this.parseCommit(headTip)?.tree;
    const baseTree = this.parseCommit(baseTip)?.tree;
    if (!headTree || !baseTree) throw new ForgeError(404, 'Commit not found');
    const flat0 = this.flatten(base0Tree);
    const flatHead = this.flatten(headTree);
    const flatBase = this.flatten(baseTree);
    if (!flat0 || !flatHead || !flatBase) throw new ForgeError(404, 'Tree not found');
    const merged = new Map<string, FlatEntry>(flatBase);
    const conflicts: string[] = [];
    const paths = new Set<string>([...flat0.keys(), ...flatHead.keys()]);
    for (const path of paths) {
      const from0 = flat0.get(path);
      const fromHead = flatHead.get(path);
      const fromBase = flatBase.get(path);
      const headChanged = (fromHead?.oid ?? null) !== (from0?.oid ?? null);
      if (!headChanged) continue;
      const baseChanged = (fromBase?.oid ?? null) !== (from0?.oid ?? null);
      const baseMatchesHead = (fromBase?.oid ?? null) === (fromHead?.oid ?? null);
      if (baseChanged && !baseMatchesHead) {
        conflicts.push(path);
        continue;
      }
      if (fromHead) merged.set(path, { oid: fromHead.oid, mode: fromHead.mode });
      else merged.delete(path);
    }
    return { conflicts: conflicts.sort(), merged, baseTip, headTip };
  }

  mergePull(repo: Repo, pull: PullRequest, method: 'squash' | 'merge'): { sha: string } {
    if (pull.state !== 'open' || pull.merged) {
      throw new ForgeError(405, 'Pull request is not open');
    }
    const plan = this.planMerge(repo, pull);
    if (plan.conflicts.length > 0) {
      throw new ForgeError(405, `Merge conflict in ${plan.conflicts.join(', ')}`);
    }
    const tree = this.buildTree(plan.merged);
    const message =
      method === 'squash'
        ? pull.body
          ? `${pull.title} (#${pull.number})\n\n${pull.body}`
          : `${pull.title} (#${pull.number})`
        : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const parents = method === 'squash' ? [plan.baseTip] : [plan.baseTip, plan.headTip];
    const sha = this.createCommit(tree, parents, message);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FORGE_EPOCH_ISO;
    pull.mergeCommitSha = sha;
    pull.updatedSeq = this.nextSeq();
    repo.gen += 1;
    return { sha };
  }

  // -- contents (file API) -----------------------------------------------------------

  /**
   * Write a file on a branch, creating the branch from the default tip when it
   * does not exist yet. Returns the new blob id, commit id and whether the
   * path is newly created.
   */
  writeContents(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha: string | undefined,
  ): { blobOid: string; commitOid: string; created: boolean } {
    const segments = splitContentPath(path);
    if (segments === null) throw new ForgeError(422, `Invalid path ${JSON.stringify(path)}`);
    if (!isValidRefName(`refs/heads/${branch}`)) {
      throw new ForgeError(422, `Invalid branch name ${JSON.stringify(branch)}`);
    }
    let tip = this.branchTip(repo, branch);
    if (tip === undefined) {
      tip = this.defaultTip(repo);
      if (tip !== undefined && branch !== repo.defaultBranch) {
        // New branch starts at the default tip; the write below moves it.
      }
    }
    const baseTree = tip ? (this.parseCommit(tip)?.tree ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
    const baseFlat = this.flatten(baseTree);
    if (!baseFlat) throw new ForgeError(404, 'Tree not found');
    const flat = new Map<string, FlatEntry>(baseFlat);
    const existing = flat.get(path);
    if (expectedSha !== undefined) {
      if (!existing || existing.oid !== expectedSha) {
        throw new ForgeError(409, 'The blob sha does not match the current file');
      }
    } else if (existing) {
      throw new ForgeError(422, 'sha is required to update an existing file');
    }
    // No file may sit at a prefix of the new path, and the path may not be a directory.
    for (const other of flat.keys()) {
      if (other === path) continue;
      if (path.startsWith(`${other}/`)) {
        throw new ForgeError(422, `Path ${path} conflicts with existing file ${other}`);
      }
      if (other.startsWith(`${path}/`)) {
        throw new ForgeError(422, `Path ${path} is a directory`);
      }
    }
    const blobOid = this.putObject('blob', content);
    flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const tree = this.buildTree(flat);
    const commitOid = this.createCommit(tree, tip ? [tip] : [], message);
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
    return { blobOid, commitOid, created: !existing };
  }

  deleteContents(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
    expectedSha: string | undefined,
  ): { commitOid: string } {
    const segments = splitContentPath(path);
    if (segments === null) throw new ForgeError(422, `Invalid path ${JSON.stringify(path)}`);
    const tip = this.branchTip(repo, branch);
    if (!tip) throw new ForgeError(404, 'Branch not found');
    const baseTree = this.parseCommit(tip)?.tree ?? EMPTY_TREE_OID;
    const baseFlat = this.flatten(baseTree);
    if (!baseFlat) throw new ForgeError(404, 'Tree not found');
    const existing = baseFlat.get(path);
    if (!existing) throw new ForgeError(404, 'File not found');
    if (expectedSha === undefined) throw new ForgeError(422, 'sha is required to delete a file');
    if (existing.oid !== expectedSha) {
      throw new ForgeError(409, 'The blob sha does not match the current file');
    }
    const flat = new Map<string, FlatEntry>(baseFlat);
    flat.delete(path);
    const tree = this.buildTree(flat);
    const commitOid = this.createCommit(tree, [tip], message);
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
    return { commitOid };
  }

  /** Read a path at a rev: a file, a directory listing, or undefined. */
  readContents(
    repo: Repo,
    rev: string | undefined,
    path: string,
  ): (
    | { kind: 'file'; oid: string; mode: string; name: string; size: number }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string; isDir: boolean }> }
    | undefined
  ) {
    const commitOid = this.resolveRevToCommit(repo, rev ?? repo.defaultBranch);
    if (!commitOid) return undefined;
    const commit = this.parseCommit(commitOid);
    if (!commit) return undefined;
    const segments = path === '' ? [] : splitContentPath(path);
    if (segments === null) return undefined;
    let treeOid = commit.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.parseTree(treeOid);
      if (!entries) return undefined;
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (!entry) return undefined;
      const last = i === segments.length - 1;
      if (entry.mode === '40000') {
        if (!last) {
          treeOid = entry.oid;
          continue;
        }
        const dirEntries = this.parseTree(entry.oid);
        if (!dirEntries) return undefined;
        return {
          kind: 'dir',
          entries: dirEntries.map((child) => ({
            name: child.name,
            path: `${path}/${child.name}`,
            oid: child.oid,
            mode: child.mode,
            isDir: child.mode === '40000',
          })),
        };
      }
      if (!last) return undefined;
      const object = this.getObject(entry.oid);
      return {
        kind: 'file',
        oid: entry.oid,
        mode: entry.mode,
        name: entry.name,
        size: object?.data.length ?? 0,
      };
    }
    const entries = this.parseTree(treeOid);
    if (!entries) return undefined;
    return {
      kind: 'dir',
      entries: entries.map((child) => ({
        name: child.name,
        path: child.name,
        oid: child.oid,
        mode: child.mode,
        isDir: child.mode === '40000',
      })),
    };
  }

  // -- global ids (GraphQL) ----------------------------------------------------------

  encodeGlobalId(kind: string, parts: readonly string[]): string {
    const raw = `forge-v2:${kind}:${parts.join(':')}`;
    return Buffer.from(raw, 'utf8').toString('base64url');
  }

  decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
    let raw: string;
    try {
      raw = Buffer.from(id, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    if (!raw.startsWith('forge-v2:')) return null;
    const segments = raw.slice('forge-v2:'.length).split(':');
    const kind = segments[0];
    if (!kind) return null;
    return { kind, parts: segments.slice(1) };
  }

  repoGlobalId(repo: Repo): string {
    return this.encodeGlobalId('Repository', [repo.name]);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.encodeGlobalId('Issue', [repo.name, String(issue.number)]);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return this.encodeGlobalId('PullRequest', [repo.name, String(pull.number)]);
  }

  userGlobalId(login: string): string {
    return this.encodeGlobalId('User', [login]);
  }

  commentGlobalId(repo: Repo, ownerNumber: number, comment: Comment): string {
    return this.encodeGlobalId('Comment', [repo.name, String(ownerNumber), String(comment.id)]);
  }
}
