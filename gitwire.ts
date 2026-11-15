/**
 * gitwire.ts — git wire primitives: pkt-lines, packfiles, fetch planning,
 * ls-refs planning and push application.
 *
 * Design notes:
 * - Packs are SENT as plain objects (no deltas). The conformance suite
 *   verifies deltas only when present, so plain packs pass every check while
 *   keeping pack generation O(n) with no delta search.
 * - Packs are READ with full delta resolution (OFS_DELTA and REF_DELTA,
 *   including thin-pack bases that already live in the store), so real git
 *   clients — which always send delta packs — interoperate.
 * - A zlib stream's end is found by exponential + binary search over
 *   `inflateSync`: a prefix shorter than the true stream throws (or yields a
 *   short output), a prefix at or past the end succeeds with the declared
 *   size. The predicate is monotone, so the search is exact.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  Forge,
  ZERO_OID,
  hashObject,
  isOid,
  isValidRefName,
  type GitObject,
  type ObjectType,
  type Repo,
} from './core.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

export const FLUSH_PACKET = Buffer.from('0000', 'ascii');
export const DELIM_PACKET = Buffer.from('0001', 'ascii');

export function pktLine(payload: Buffer): Buffer {
  const length = payload.length + 4;
  if (length > 65520) throw new Error('pkt-line payload too large');
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

export type PktItem = Buffer | string | 'flush' | 'delim';

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH_PACKET);
    else if (item === 'delim') parts.push(DELIM_PACKET);
    else if (typeof item === 'string') parts.push(pktText(item));
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the start of `buf`. Stops at the first malformed or
 * truncated packet; `rest` holds every byte after the last complete packet
 * (for receive-pack, the rest is the packfile).
 */
export function decodePktStream(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Split decoded packets into text lines per section (delim/flush separated). */
export function packetLines(packets: readonly Packet[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') {
      current.push(packet.payload.toString('utf8'));
    } else {
      sections.push(current);
      current = [];
    }
  }
  sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// Pack writing (plain objects)
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODES[type] << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function writePack(entries: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    parts.push(packEntryHeader(entry.type, entry.data.length));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Pack reading (with delta resolution)
// ---------------------------------------------------------------------------

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

interface RawEntry {
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  /** Offset of this entry's header (for OFS_DELTA base resolution). */
  start: number;
  baseOffset?: number;
  baseOid?: string;
}

/** Inflate the zlib stream starting at `start`, whose output must be `expectedSize`. */
function inflateEntry(buf: Buffer, start: number, limit: number, expectedSize: number): { data: Buffer; end: number } {
  const probe = (end: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(start, end));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  // Exponential search for an upper bound, then binary search for the exact end.
  let step = 64;
  let hi = Math.min(start + step, limit);
  let found = probe(hi);
  while (found === null && hi < limit) {
    step *= 2;
    hi = Math.min(start + step, limit);
    found = probe(hi);
  }
  if (found === null) throw new PackError('zlib stream is truncated or corrupt');
  let lo = start;
  let loFailed = start;
  // Binary search the smallest end that succeeds, within (loFailed, hi].
  let low = loFailed;
  let high = hi;
  let best: Buffer | null = found;
  let bestEnd = hi;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const out = probe(mid);
    if (out !== null) {
      high = mid;
      best = out;
      bestEnd = mid;
    } else {
      low = mid;
    }
  }
  void lo;
  return { data: best!, end: bestEnd };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new PackError('delta is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new PackError('delta base size mismatch');
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new PackError('delta copy is truncated');
          copyOffset |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new PackError('delta copy is truncated');
          copySize |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new PackError('delta copy is out of range');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new PackError('delta insert is truncated');
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new PackError('delta has a reserved zero opcode');
    }
  }
  if (produced !== targetSize) throw new PackError('delta target size mismatch');
  return Buffer.concat(parts);
}

/**
 * Parse a packfile, verify its trailer checksum and resolve every delta.
 * Thin-pack bases may come from the forge store. Returns resolved objects
 * with content-computed ids.
 */
export function readPack(buf: Buffer, forge: Forge): Array<{ oid: string; type: ObjectType; data: Buffer }> {
  if (buf.length < 32) throw new PackError('packfile is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('packfile has a bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const bodyEnd = buf.length - 20;
  const expectedTrailer = buf.subarray(bodyEnd).toString('hex');
  const actualTrailer = createHash('sha1').update(buf.subarray(0, bodyEnd)).digest('hex');
  if (expectedTrailer !== actualTrailer) throw new PackError('packfile trailer checksum mismatch');

  const raw: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    if (offset >= bodyEnd) throw new PackError('packfile ends before all entries');
    let byte = buf[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= bodyEnd) throw new PackError('pack entry header is truncated');
      byte = buf[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: RawEntry['type'];
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 1) type = 'commit';
    else if (typeCode === 2) type = 'tree';
    else if (typeCode === 3) type = 'blob';
    else if (typeCode === 4) type = 'tag';
    else if (typeCode === 6) {
      type = 'ofs-delta';
      if (offset >= bodyEnd) throw new PackError('ofs-delta offset is truncated');
      byte = buf[offset]!;
      offset += 1;
      let negative = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= bodyEnd) throw new PackError('ofs-delta offset is truncated');
        byte = buf[offset]!;
        offset += 1;
        negative = ((negative + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - negative;
      if (baseOffset < 12) throw new PackError('ofs-delta base is out of range');
    } else if (typeCode === 7) {
      type = 'ref-delta';
      if (offset + 20 > bodyEnd) throw new PackError('ref-delta base id is truncated');
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else {
      throw new PackError(`unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateEntry(buf, offset, bodyEnd, size);
    raw.push({ type, data: inflated.data, start, baseOffset, baseOid });
    offset = inflated.end;
  }
  if (offset !== bodyEnd) throw new PackError('packfile has trailing bytes before the trailer');

  // Resolve: non-delta entries hash directly; deltas resolve against the pack
  // or the store, recursively, with cycle detection.
  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.start, entry);
  const resolved = new Map<number, { oid: string; type: ObjectType; data: Buffer }>();
  const resolving = new Set<number>();

  const resolveByOffset = (entry: RawEntry): { oid: string; type: ObjectType; data: Buffer } => {
    const done = resolved.get(entry.start);
    if (done) return done;
    if (resolving.has(entry.start)) throw new PackError('delta chain has a cycle');
    resolving.add(entry.start);
    try {
      if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
        const oid = forgeObjectId(entry.type, entry.data);
        const result = { oid, type: entry.type, data: entry.data };
        resolved.set(entry.start, result);
        return result;
      }
      let base: { oid: string; type: ObjectType; data: Buffer } | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new PackError('ofs-delta base is missing');
        base = resolveByOffset(baseEntry);
      } else {
        const stored = forge.getObject(entry.baseOid!);
        if (stored) {
          base = { oid: entry.baseOid!, type: stored.type, data: stored.data };
        } else {
          // The base may be a not-yet-resolved pack entry: find it by id.
          for (const candidate of raw) {
            if (candidate === entry) continue;
            if (candidate.type === 'ofs-delta' || candidate.type === 'ref-delta') continue;
            if (forgeObjectId(candidate.type, candidate.data) === entry.baseOid) {
              base = resolveByOffset(candidate);
              break;
            }
          }
          if (!base) {
            // The base may itself be a delta: resolve every delta until the id appears.
            for (const candidate of raw) {
              if (candidate === entry) continue;
              if (resolving.has(candidate.start)) continue;
              try {
                const candidateResolved = resolveByOffset(candidate);
                if (candidateResolved.oid === entry.baseOid) {
                  base = candidateResolved;
                  break;
                }
              } catch {
                // A failing sibling must not mask this entry's own error path;
                // the loop below reports the missing base.
              }
            }
          }
        }
        if (!base) throw new PackError(`ref-delta base ${entry.baseOid} is missing`);
      }
      const data = applyDelta(base.data, entry.data);
      const oid = forgeObjectId(base.type, data);
      const result = { oid, type: base.type, data };
      resolved.set(entry.start, result);
      return result;
    } finally {
      resolving.delete(entry.start);
    }
  };

  const results: Array<{ oid: string; type: ObjectType; data: Buffer }> = [];
  for (const entry of raw) results.push(resolveByOffset(entry));
  return results;
}

function forgeObjectId(type: ObjectType, data: Buffer): string {
  return hashObject(type, data);
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

export interface FetchOptions {
  wants: string[];
  haves: string[];
  /** The client's current shallow boundary commits (from `shallow` lines). */
  shallowBoundaries: string[];
  /** Absolute depth (`deepen N`). */
  depth?: number;
  /** Relative deepen (`deepen-relative N`): added to the client's old depth. */
  deepenRelative?: number;
  /** `deepen-since` timestamp (seconds): commits at or before it are boundaries. */
  deepenSince?: number;
  /** `deepen-not` revs: their reachable commits are excluded. */
  deepenNot?: string[];
  /** `filter` spec: 'blob:none' and 'tree:0' are honoured. */
  filter?: string;
}

export interface FetchPlan {
  /** Object ids to send, in emission order (commits first, then the rest sorted). */
  send: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/** Resolve a `deepen-not` rev: ref, short branch, oid, or `<rev>~N` / `<rev>^N`. */
export function resolveExcludeRev(forge: Forge, repo: Repo, rev: string): string | undefined {
  const suffix = /^(.*?)([~^])(\d*)$/.exec(rev);
  let baseRev = rev;
  let op: '~' | '^' | null = null;
  let num = 1;
  if (suffix && suffix[1] !== '') {
    baseRev = suffix[1]!;
    op = suffix[2] as '~' | '^';
    num = suffix[3] === '' ? 1 : Number.parseInt(suffix[3]!, 10);
  }
  let oid = forge.resolveRevToCommit(repo, baseRev);
  if (!oid && isOid(baseRev) && forge.hasObject(baseRev)) oid = forge.peelToCommit(baseRev);
  if (!oid) return undefined;
  if (op === '~') {
    for (let i = 0; i < num; i += 1) {
      const commit = forge.parseCommit(oid);
      if (!commit || commit.parents.length === 0) return undefined;
      oid = commit.parents[0]!;
    }
  } else if (op === '^') {
    const commit = forge.parseCommit(oid);
    if (!commit || commit.parents.length < num) return undefined;
    oid = commit.parents[num - 1]!;
  }
  return oid;
}

export function planFetch(forge: Forge, repo: Repo, options: FetchOptions): FetchPlan {
  const wants = [...new Set(options.wants)];
  const haves = new Set(options.haves);
  const boundaries = new Set(options.shallowBoundaries);

  // 1. Excluded commits (deepen-not).
  const excluded = new Set<string>();
  for (const rev of options.deepenNot ?? []) {
    const resolved = resolveExcludeRev(forge, repo, rev);
    if (resolved) {
      for (const oid of forge.historyFrom(resolved, Number.MAX_SAFE_INTEGER)) excluded.add(oid);
    }
  }

  // 2. Effective depth: absolute `deepen` wins; otherwise relative to the old depth.
  let effectiveDepth: number | undefined = options.depth;
  if (effectiveDepth === undefined && options.deepenRelative !== undefined) {
    let oldDepth = 0;
    const distances = new Map<string, number>();
    const queue: Array<{ oid: string; distance: number }> = [];
    for (const want of wants) {
      const commit = forge.peelToCommit(want);
      if (commit && !distances.has(commit)) {
        distances.set(commit, 0);
        queue.push({ oid: commit, distance: 0 });
      }
    }
    while (queue.length > 0) {
      const { oid, distance } = queue.shift()!;
      if (boundaries.has(oid)) oldDepth = Math.max(oldDepth, distance + 1);
      const commit = forge.parseCommit(oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!distances.has(parent)) {
          distances.set(parent, distance + 1);
          queue.push({ oid: parent, distance: distance + 1 });
        }
      }
    }
    effectiveDepth = oldDepth + options.deepenRelative;
  }

  // 3. Depth-limited walk from the wants. A commit is included unless it is
  // excluded, already held (non-boundary have), or beyond the depth cut.
  // Included commits whose parents were cut become shallow boundaries.
  const included = new Map<string, number>(); // commit -> distance from a want
  const shallowSet = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = [];
  const queued = new Set<string>();
  const nonCommitWants: string[] = [];
  for (const want of wants) {
    const commit = forge.peelToCommit(want);
    if (!commit) {
      if (forge.hasObject(want)) nonCommitWants.push(want);
      continue;
    }
    if (!queued.has(commit)) {
      queued.add(commit);
      queue.push({ oid: commit, distance: 0 });
    }
  }
  // BFS (queue.shift is fine for the graph sizes a forge serves here).
  let head = 0;
  while (head < queue.length) {
    const { oid, distance } = queue[head]!;
    head += 1;
    if (excluded.has(oid)) continue;
    const isHave = haves.has(oid);
    const isBoundary = boundaries.has(oid);
    const commit = forge.parseCommit(oid);
    if (!commit) continue;
    if (isHave && !isBoundary) continue; // the client holds this commit and its closure
    if (!isHave) included.set(oid, distance);
    const cutByDepth = effectiveDepth !== undefined && distance + 1 >= effectiveDepth;
    const cutBySince =
      options.deepenSince !== undefined && commit.committer.time <= options.deepenSince;
    const cutByExcludedParent = commit.parents.some((parent) => excluded.has(parent));
    if (cutByDepth || cutBySince || cutByExcludedParent) {
      if (!isHave) shallowSet.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (excluded.has(parent)) {
        if (!isHave) shallowSet.add(oid);
        continue;
      }
      if (!queued.has(parent)) {
        queued.add(parent);
        queue.push({ oid: parent, distance: distance + 1 });
      }
    }
  }

  // 4. Unshallow: old boundaries whose parents are all now available.
  const unshallow: string[] = [];
  for (const boundary of boundaries) {
    if (!queued.has(boundary)) continue;
    const commit = forge.parseCommit(boundary);
    if (!commit) continue;
    const parentsAvailable = commit.parents.every(
      (parent) => included.has(parent) || (haves.has(parent) && !boundaries.has(parent)),
    );
    if (parentsAvailable && !shallowSet.has(boundary)) unshallow.push(boundary);
  }

  // 5. Object closure, depth-aware: each included commit contributes itself
  // plus its full tree closure — never its parents. Objects the client
  // asked for EXPLICITLY (non-commit wants and tag objects on a want's
  // chain) are always sent: a partial-clone client asks for blobs it
  // lacks even though they sit inside a have's closure, and an explicit
  // want bypasses the filter too. Only the commit closure is reduced by
  // what the client holds and by the filter.
  const commitReachable = new Set<string>();
  for (const commitOid of included.keys()) {
    commitReachable.add(commitOid);
    const commit = forge.parseCommit(commitOid);
    if (commit) {
      for (const oid of forge.collectReachable([commit.tree])) commitReachable.add(oid);
    }
  }
  const explicitReachable = new Set<string>();
  for (const oid of nonCommitWants) {
    for (const reached of forge.collectReachable([oid])) explicitReachable.add(reached);
  }
  for (const want of wants) {
    let current = want;
    for (let hop = 0; hop < 16; hop += 1) {
      const object = forge.getObject(current);
      if (!object || object.type !== 'tag') break;
      explicitReachable.add(current);
      const tag = forge.parseTag(current);
      if (!tag || !tag.object) break;
      current = tag.object;
    }
  }
  // Minus what the client already holds (boundaries hold only their own tree).
  const clientHas = new Set<string>();
  for (const have of haves) {
    if (boundaries.has(have)) {
      const commit = forge.parseCommit(have);
      if (commit) {
        clientHas.add(have);
        for (const oid of forge.collectReachable([commit.tree])) clientHas.add(oid);
      } else {
        for (const oid of forge.collectReachable([have])) clientHas.add(oid);
      }
    } else {
      for (const oid of forge.collectReachable([have])) clientHas.add(oid);
    }
  }
  const sendSet = new Set<string>();
  for (const oid of commitReachable) {
    if (clientHas.has(oid)) continue;
    if (options.filter === 'blob:none') {
      if (forge.getObject(oid)?.type === 'blob') continue;
    } else if (options.filter === 'tree:0') {
      const type = forge.getObject(oid)?.type;
      if (type === 'blob' || type === 'tree') continue;
    }
    sendSet.add(oid);
  }
  for (const oid of explicitReachable) sendSet.add(oid);
  // Emission order: included commits in BFS order, then everything else sorted.
  const send: string[] = [];
  const emitted = new Set<string>();
  const byDistance = [...included.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  for (const [oid] of byDistance) {
    if (sendSet.has(oid)) {
      send.push(oid);
      emitted.add(oid);
    }
  }
  const rest = [...sendSet].filter((oid) => !emitted.has(oid)).sort();
  send.push(...rest);

  // 6. ACKs: haves that are ancestors of (or equal to) a want.
  const wantAncestors = new Set<string>();
  for (const want of wants) {
    const commit = forge.peelToCommit(want);
    if (commit) {
      for (const oid of forge.historyFrom(commit, Number.MAX_SAFE_INTEGER)) wantAncestors.add(oid);
    }
  }
  const acks = [...haves].filter((have) => wantAncestors.has(have));
  const nak = acks.length === 0;

  return {
    send,
    shallow: [...shallowSet].sort(),
    unshallow: unshallow.sort(),
    acks,
    nak,
  };
}

// ---------------------------------------------------------------------------
// ls-refs planning
// ---------------------------------------------------------------------------

export interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export interface LsRefsLine {
  oid: string;
  ref: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

export function planLsRefs(forge: Forge, repo: Repo, options: LsRefsOptions): LsRefsLine[] {
  const lines: LsRefsLine[] = [];
  const refs = forge.listRefs(repo);
  const defaultTarget = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = forge.branchTip(repo, repo.defaultBranch);
  const matches = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));

  if (refs.length === 0) {
    if (options.unborn && matches('HEAD')) {
      lines.push({
        oid: ZERO_OID,
        ref: 'HEAD',
        unborn: true,
        symrefTarget: options.symrefs ? defaultTarget : undefined,
      });
    }
    return lines;
  }
  if (options.symrefs && defaultTip && matches('HEAD')) {
    lines.push({ oid: defaultTip, ref: 'HEAD', symrefTarget: defaultTarget });
  }
  for (const { ref, oid } of refs) {
    if (!matches(ref)) continue;
    const line: LsRefsLine = { oid, ref };
    if (options.peel && ref.startsWith('refs/tags/')) {
      const object = forge.getObject(oid);
      if (object?.type === 'tag') {
        const peeled = forge.peelToCommit(oid);
        if (peeled) line.peeled = peeled;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function formatLsRefsLine(line: LsRefsLine): string {
  const parts: string[] = [];
  if (line.unborn) parts.push('unborn');
  else parts.push(line.oid);
  parts.push(line.ref);
  if (line.symrefTarget) parts.push(`symref-target:${line.symrefTarget}`);
  if (line.peeled) parts.push(`peeled:${line.peeled}`);
  return `${parts.join(' ')}\n`;
}

// ---------------------------------------------------------------------------
// Push application
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushRefResult {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Check that every object reachable from `tip` is present in the store.
 * Branches rooted at previously verified objects are pruned: completeness
 * of an immutable object never expires. */
function closureComplete(forge: Forge, tip: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [tip];
  const visited: string[] = [];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (forge.isCompleteObject(oid)) continue;
    const object = forge.getObject(oid);
    if (!object) return false;
    visited.push(oid);
    if (object.type === 'commit') {
      const commit = forge.parseCommit(oid);
      if (!commit) return false;
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      const entries = forge.parseTree(oid);
      if (!entries) return false;
      for (const entry of entries) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const tag = forge.parseTag(oid);
      if (!tag || !tag.object) return false;
      stack.push(tag.object);
    }
  }
  forge.markCompleteObjects(visited);
  return true;
}

/**
 * Apply push commands in order. Pack objects are stored first (as git does:
 * unpacked objects persist even when a ref update is refused). Each ref is
 * validated independently, so a mixed push applies the fast-forwards and
 * reports the refusals.
 */
export function applyPush(
  forge: Forge,
  repo: Repo,
  commands: readonly PushCommand[],
  packObjects: readonly GitObject[],
  packOids: readonly string[],
): PushRefResult[] {
  for (let i = 0; i < packObjects.length; i += 1) {
    forge.putObjectWithId(packOids[i]!, packObjects[i]!.type, packObjects[i]!.data);
  }
  const results: PushRefResult[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!isValidRefName(command.ref)) {
      fail('invalid ref name');
      continue;
    }
    if (!isOid(command.oldOid) || !isOid(command.newOid)) {
      fail('invalid object id');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        fail('ref does not exist');
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('old value does not match');
        continue;
      }
      forge.deleteRef(repo, command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Create or update: the new tip must exist with a complete closure.
    if (!forge.hasObject(command.newOid)) {
      fail('object not found');
      continue;
    }
    if (!closureComplete(forge, command.newOid)) {
      fail('missing object');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        fail('already exists');
        continue;
      }
      forge.setRef(repo, command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      fail('ref does not exist');
      continue;
    }
    if (command.oldOid !== current) {
      fail('old value does not match');
      continue;
    }
    if (command.oldOid !== command.newOid && !forge.isAncestor(command.oldOid, command.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    forge.setRef(repo, command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return results;
}
