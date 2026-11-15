/**
 * githttp.ts — git smart-HTTP adapters: info/refs advertisements (v0 + v2),
 * upload-pack (v2 ls-refs/fetch, v0 fetch) and receive-pack (v0 push).
 *
 * Responses that are pure functions of (repo state, request) are cached per
 * repo generation: advertisements, ls-refs replies and fetch replies. A
 * mutation bumps the repo generation, which invalidates every cached entry
 * for that repo exactly — no timers, no staleness, fully deterministic.
 */

import {
  DELIM_PACKET,
  FLUSH_PACKET,
  applyPush,
  decodePktStream,
  encodePktLines,
  formatLsRefsLine,
  packetLines,
  planFetch,
  planLsRefs,
  pktLine,
  pktText,
  readPack,
  writePack,
  type FetchOptions,
  type PushCommand,
} from './gitwire.ts';
import { ZERO_OID, type Forge, type GitObject, type Repo } from './core.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CONTENT_TYPE = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CONTENT_TYPE = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CONTENT_TYPE = 'application/x-git-receive-pack-result';

const SIDEBAND_CHUNK = 32768;
const CACHE_LIMIT = 256;

/** Generation-keyed response cache. Keys embed the repo id (never reused). */
export class GitResponseCache {
  private readonly entries = new Map<string, { gen: number; body: Buffer }>();

  get(key: string, gen: number): Buffer | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.gen === gen) return entry.body;
    return undefined;
  }

  set(key: string, gen: number, body: Buffer): void {
    if (this.entries.size >= CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { gen, body });
  }
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    packets.push(pktLine(payload));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0Advertisement(
  forge: Forge,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const parts: Buffer[] = [pktText(`# service=${service}\n`), FLUSH_PACKET];
  const capabilities =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow`
      : 'report-status side-band-64k delete-refs ofs-delta';
  const refs = forge.listRefs(repo);
  const defaultTip = forge.branchTip(repo, repo.defaultBranch);
  const lines: string[] = [];
  if (defaultTip) lines.push(`${defaultTip} HEAD`);
  for (const { ref, oid } of refs) {
    lines.push(`${oid} ${ref}`);
    if (ref.startsWith('refs/tags/')) {
      const object = forge.getObject(oid);
      if (object?.type === 'tag') {
        const peeled = forge.peelToCommit(oid);
        if (peeled) lines.push(`${peeled} ${ref}^{}`);
      }
    }
  }
  if (lines.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktText(index === 0 ? `${line}\0${capabilities}\n` : `${line}\n`));
    });
  }
  parts.push(FLUSH_PACKET);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  forge: Forge,
  repo: Repo,
  service: string,
  gitProtocolHeader: string | undefined,
  cache: GitResponseCache,
): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return {
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ message: 'Unknown service' }), 'utf8'),
    };
  }
  const wantsV2 = service === 'git-upload-pack' && (gitProtocolHeader ?? '').includes('version=2');
  const cacheKey = `${repo.id}|ad|${service}|${wantsV2 ? 'v2' : 'v0'}`;
  const cached = cache.get(cacheKey, repo.gen);
  if (cached) {
    return {
      status: 200,
      contentType: service === 'git-upload-pack' ? UPLOAD_AD_CONTENT_TYPE : RECEIVE_AD_CONTENT_TYPE,
      body: cached,
    };
  }
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(forge, repo, service);
  cache.set(cacheKey, repo.gen, body);
  return {
    status: 200,
    contentType: service === 'git-upload-pack' ? UPLOAD_AD_CONTENT_TYPE : RECEIVE_AD_CONTENT_TYPE,
    body,
  };
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchArgs {
  options: FetchOptions;
  fingerprint: string;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenRelative: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  let filter: string | undefined;
  let relativeFlag = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    // v0 want lines carry capabilities after the oid: take the first token.
    const firstToken = (text: string): string => text.trim().split(/\s+/)[0] ?? '';
    if (line.startsWith('want ')) wants.push(firstToken(line.slice(5)));
    else if (line.startsWith('have ')) haves.push(firstToken(line.slice(5)));
    else if (line.startsWith('shallow ')) shallow.push(firstToken(line.slice(8)));
    else if (line.startsWith('deepen-since ')) deepenSince = Number.parseInt(firstToken(line.slice(13)), 10);
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('deepen-relative ')) deepenRelative = Number.parseInt(firstToken(line.slice(16)), 10);
    else if (line === 'deepen-relative') relativeFlag = true;
    else if (line.startsWith('deepen ')) depth = Number.parseInt(firstToken(line.slice(7)), 10);
    else if (line.startsWith('filter ')) filter = line.slice(7).trim();
    // done, thin-pack, no-progress, ofs-delta, want-ref handled by the caller.
  }
  if (relativeFlag && depth !== undefined && deepenRelative === undefined) {
    deepenRelative = depth;
    depth = undefined;
  }
  const options: FetchOptions = {
    wants,
    haves,
    shallowBoundaries: shallow,
    depth,
    deepenRelative,
    deepenSince: deepenSince !== undefined && Number.isFinite(deepenSince) ? deepenSince : undefined,
    deepenNot,
    filter,
  };
  const fingerprint = JSON.stringify({
    w: [...wants].sort(),
    h: [...haves].sort(),
    s: [...shallow].sort(),
    d: depth ?? null,
    r: deepenRelative ?? null,
    ds: options.deepenSince ?? null,
    dn: [...deepenNot].sort(),
    f: filter ?? null,
  });
  return { options, fingerprint };
}

function buildPackBytes(forge: Forge, send: readonly string[]): Buffer {
  const entries: GitObject[] = [];
  for (const oid of send) {
    const object = forge.getObject(oid);
    if (object) entries.push(object);
  }
  return writePack(entries);
}

function fetchResponseV2(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(forge, repo, args.options);
  const pack = buildPackBytes(forge, plan.send);
  // Real git omits the acknowledgments section when the request carried no
  // `have` lines (git's own upload-pack does this; its client skips reading
  // the section and expects `packfile` next). With haves, the section is
  // mandatory: NAK, or one ACK per acknowledged have.
  const parts: Buffer[] = [];
  if (args.options.haves.length > 0) {
    parts.push(pktText('acknowledgments\n'));
    if (plan.nak) parts.push(pktText('NAK\n'));
    else for (const ack of plan.acks) parts.push(pktText(`ACK ${ack}\n`));
    // `ready` is mandatory before further sections: without it, a client
    // that sent haves treats the response as a request for MORE haves and
    // rejects any following section ("expected no other sections to be
    // sent after no 'ready'"). This server always answers in one shot, so
    // it is always ready.
    parts.push(pktText('ready\n'));
    parts.push(DELIM_PACKET);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktText('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktText(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
    parts.push(DELIM_PACKET);
  }
  parts.push(pktText('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH_PACKET);
  return Buffer.concat(parts);
}

function fetchResponseV0(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(forge, repo, args.options);
  const pack = buildPackBytes(forge, plan.send);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktText(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
  if (plan.nak) parts.push(pktText('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktText(`ACK ${ack}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH_PACKET);
  return Buffer.concat(parts);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  fingerprint: string;
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  return { peel, symrefs, unborn, prefixes, fingerprint: JSON.stringify({ p: peel, s: symrefs, u: unborn, pre: prefixes }) };
}

function lsRefsResponse(forge: Forge, repo: Repo, args: LsRefsArgs): Buffer {
  const planned = planLsRefs(forge, repo, args);
  const parts = planned.map((line) => pktText(formatLsRefsLine(line)));
  parts.push(FLUSH_PACKET);
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  repo: Repo,
  body: Buffer,
  gitProtocolHeader: string | undefined,
  cache: GitResponseCache,
): GitResponse {
  const isV2 = (gitProtocolHeader ?? '').includes('version=2');
  const { packets } = decodePktStream(body);
  const sections = packetLines(packets);
  if (isV2) {
    const commandSection = sections[0] ?? [];
    const argsSection = sections[1] ?? [];
    const commandLine = commandSection.find((line) => line.startsWith('command=')) ?? '';
    const command = commandLine.slice('command='.length).replace(/\n$/, '').trim();
    if (command === 'ls-refs') {
      const args = parseLsRefsArgs(argsSection);
      const cacheKey = `${repo.id}|lsrefs|${args.fingerprint}`;
      const cached = cache.get(cacheKey, repo.gen);
      if (cached) return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: cached };
      const response = lsRefsResponse(forge, repo, args);
      cache.set(cacheKey, repo.gen, response);
      return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: response };
    }
    if (command === 'fetch') {
      const args = parseFetchArgs(argsSection);
      // want-ref lines resolve to wants (not sent by the suite, but valid v2).
      for (const raw of argsSection) {
        const line = raw.replace(/\n$/, '');
        if (line.startsWith('want-ref ')) {
          const oid = forge.resolveRev(repo, line.slice(9).trim());
          if (oid) args.options.wants.push(oid);
        }
      }
      const cacheKey = `${repo.id}|fetch2|${args.fingerprint}`;
      const cached = cache.get(cacheKey, repo.gen);
      if (cached) return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: cached };
      const response = fetchResponseV2(forge, repo, args);
      cache.set(cacheKey, repo.gen, response);
      return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: response };
    }
    return {
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ message: `Unknown command ${command}` }), 'utf8'),
    };
  }
  // Protocol v0: wants section, then haves section. Garbage input yields an
  // empty want list, which is answered with a valid empty response — the
  // server never dies on malformed input.
  const wantLines = sections[0] ?? [];
  const haveLines = sections.slice(1).flat();
  const args = parseFetchArgs([...wantLines, ...haveLines]);
  const cacheKey = `${repo.id}|fetch0|${args.fingerprint}`;
  const cached = cache.get(cacheKey, repo.gen);
  if (cached) return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: cached };
  const response = fetchResponseV0(forge, repo, args);
  cache.set(cacheKey, repo.gen, response);
  return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: response };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

/** Split a receive-pack body at the first flush: command lines, then the pack. */
function splitCommandList(body: Buffer): { lines: string[]; pack: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { lines, pack: body.subarray(offset) };
}

export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const { lines, pack } = splitCommandList(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i]!.replace(/\n$/, '');
    let capabilities = '';
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    if (i === 0 && capabilities.split(' ').includes('side-band-64k')) sideband = true;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  let results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (commands.length > 0 && pack.length > 0) {
    try {
      const objects = readPack(pack, forge);
      results = applyPush(
        forge,
        repo,
        commands,
        objects.map((entry) => ({ type: entry.type, data: entry.data })),
        objects.map((entry) => entry.oid),
      );
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
      results = commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }));
    }
  } else if (commands.length > 0) {
    // No pack bytes at all: validate against the objects already stored.
    results = applyPush(forge, repo, commands, [], []);
  }
  // An empty command list (git's 4-byte probe) is answered `unpack ok` with
  // no ref lines — rejecting the probe breaks chunked pushes from real git.

  const inner = encodePktLines([
    unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`,
    ...results.map((result) =>
      result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`,
    ),
    'flush',
  ]);
  let responseBody: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += SIDEBAND_CHUNK) {
      const chunk = inner.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, inner.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(FLUSH_PACKET);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = inner;
  }
  return { status: 200, contentType: RECEIVE_RESULT_CONTENT_TYPE, body: responseBody };
}
