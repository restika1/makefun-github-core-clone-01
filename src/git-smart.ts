// The git smart-HTTP surface: pkt-line framing, packfile read/write, upload-pack (protocol v2 with
// a v0 fallback) and receive-pack (v0, report-status / side-band-64k / delete-refs), served from the
// store's own object graph with no git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { RepoRecord, GitObject } from './store.ts';
import { getObject, parseCommit } from './store.ts';

// ------------------------------------------------------------------ pkt-line

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from(body.length + 4 === 4 ? '0004' : (body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
  end: number;
}

function decodePktLines(bytes: Uint8Array, options: { stopAtFlush?: boolean } = {}): Pkt[] {
  const pkts: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const hex = Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length prefix ${JSON.stringify(hex)}`);
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      pkts.push({ kind: 'flush', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      if (options.stopAtFlush === true) break;
      continue;
    }
    if (length === 1) {
      pkts.push({ kind: 'delim', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) throw new Error(`pkt-line length ${length} out of range at ${offset}`);
    pkts.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + length)), end: offset + length });
    offset += length;
  }
  return pkts;
}

function lineText(pkt: Pkt): string {
  return pkt.payload.toString('utf8').replace(/\n$/, '');
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: string, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODE[type]! << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A packfile over full objects only (no deltas), version 2, sha1 trailer. */
export function writePack(objects: Iterable<{ type: string; data: Uint8Array }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(Buffer.from(object.data)));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readDeltaSize(bytes: Buffer, offset: number): { size: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = offset;
  for (;;) {
    if (next >= bytes.length) throw new Error('delta size varint truncated');
    const byte = bytes[next]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    next += 1;
    if (!(byte & 0x80)) break;
  }
  return { size: value, next };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const db = Buffer.from(delta);
  let offset = 0;
  const sourceSize = readDeltaSize(db, offset);
  if (sourceSize.size !== base.length) throw new Error(`delta base size ${sourceSize.size} != ${base.length}`);
  offset = sourceSize.next;
  const targetSize = readDeltaSize(db, offset);
  offset = targetSize.next;
  const out = Buffer.allocUnsafe(targetSize.size);
  let written = 0;
  while (offset < db.length) {
    const op = db[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += db[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += db[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      db.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize.size) throw new Error(`delta wrote ${written} of ${targetSize.size}`);
  return out;
}

interface PackEntry {
  oid: string;
  type: string;
  data: Buffer;
}

/**
 * Read a packfile, resolving ofs-delta/ref-delta entries against entries in the pack and objects
 * already in the repo. Returns every resolved object keyed by its id.
 */
export function readPack(pack: Uint8Array, lookupBase: (oid: string) => GitObject | null): PackEntry[] {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack shorter than its header and trailer');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack signature missing');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOid = new Map<string, PackEntry>();
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = buffer[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6) {
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buffer[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const raw = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      offset += raw.engine.bytesWritten;
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not in pack');
      const data = applyDelta(base.data, raw.buffer);
      const type = base.type;
      const oid = objectOid(type, data);
      const entry = { oid, type, data };
      entries.push(entry);
      byOid.set(oid, entry);
      byOffset.set(entryOffset, entry);
    } else if (typeCode === 7) {
      const baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const raw = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      offset += raw.engine.bytesWritten;
      const base = byOid.get(baseOid) ?? lookupBase(baseOid);
      if (base === null) throw new Error(`ref-delta base ${baseOid} unknown`);
      const data = applyDelta(base.data, raw.buffer);
      const type = base.type;
      const oid = objectOid(type, data);
      const entry = { oid, type, data };
      entries.push(entry);
      byOid.set(oid, entry);
      byOffset.set(entryOffset, entry);
    } else {
      const type = ['commit', 'tree', 'blob', 'tag'][typeCode - 1];
      if (type === undefined) throw new Error(`pack object type ${typeCode}`);
      const raw = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      offset += raw.engine.bytesWritten;
      if (raw.buffer.length !== size) throw new Error(`object size ${size} != inflated ${raw.buffer.length}`);
      const oid = objectOid(type, raw.buffer);
      const entry = { oid, type, data: raw.buffer };
      entries.push(entry);
      byOid.set(oid, entry);
      byOffset.set(entryOffset, entry);
    }
  }
  return entries;
}

function objectOid(type: string, data: Uint8Array): string {
  return createHash('sha1').update(Buffer.from(`${type} ${data.length}\0`, 'utf8')).update(data).digest('hex');
}

// ------------------------------------------------------------------ graph walk

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTreeEntries(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space += 1;
    let nul = space;
    while (nul < data.length && data[nul] !== 0) nul += 1;
    entries.push({
      mode: Buffer.from(data.subarray(offset, space)).toString('utf8'),
      name: Buffer.from(data.subarray(space + 1, nul)).toString('utf8'),
      oid: Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function commitParents(repo: RepoRecord, oid: string): string[] | null {
  const object = getObject(repo, oid);
  if (object === null || object.type !== 'commit') return null;
  const parents: string[] = [];
  for (const line of Buffer.from(object.data).toString('utf8').split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return parents;
}

interface FetchPlan {
  send: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Choose the objects a fetch delivers: commits from `wants` down to the depth limit or the client's
 * `haves`/`shallow` boundaries, each commit with its full tree and blob closure.
 */
export function planFetch(repo: RepoRecord, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (held.has(oid)) continue;
    held.add(oid);
    const parents = commitParents(repo, oid);
    if (parents !== null && !clientShallow.includes(oid)) stack.push(...parents);
  }

  const gen = new Map<string, number>();
  const queue: string[] = [];
  const sendCommits = new Set<string>();
  const seeds: string[] = [];
  for (const want of wants) {
    const peeled = peelToCommit(repo, want);
    seeds.push(peeled ?? want);
  }
  if (depth === null) {
    for (const seed of seeds) {
      if (held.has(seed)) continue;
      if (gen.has(seed)) continue;
      gen.set(seed, 1);
      queue.push(seed);
    }
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (sendCommits.has(oid)) continue;
      sendCommits.add(oid);
      const parents = commitParents(repo, oid);
      if (parents === null) continue;
      if (clientShallow.includes(oid)) continue;
      for (const parent of parents) {
        if (held.has(parent) || gen.has(parent)) continue;
        gen.set(parent, 1);
        queue.push(parent);
      }
    }
  } else {
    const frontier: Array<{ oid: string; depth: number }> = [];
    for (const seed of seeds) {
      frontier.push({ oid: seed, depth: 1 });
    }
    while (frontier.length > 0) {
      const { oid, depth: at } = frontier.shift()!;
      if (sendCommits.has(oid)) continue;
      sendCommits.add(oid);
      gen.set(oid, at);
      const parents = commitParents(repo, oid);
      if (parents === null) continue;
      if (at >= depth) continue;
      for (const parent of parents) {
        if (held.has(parent)) continue;
        frontier.push({ oid: parent, depth: at + 1 });
      }
    }
  }

  const send: GitObject[] = [];
  const seen = new Set<string>();
  const addClosure = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object === null) return;
    send.push({ type: object.type, data: object.data });
    if (object.type === 'tree') {
      for (const entry of parseTreeEntries(object.data)) addClosure(entry.oid);
    } else if (object.type === 'tag') {
      const text = Buffer.from(object.data).toString('utf8');
      const target = /^object ([0-9a-f]{40})$/m.exec(text)?.[1];
      if (target !== undefined) addClosure(target);
    }
  };
  for (const oid of sendCommits) {
    if (held.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null) continue;
    send.push({ type: object.type, data: object.data });
    seen.add(oid);
    const tree = /^tree ([0-9a-f]{40})$/m.exec(Buffer.from(object.data).toString('utf8'))?.[1];
    if (tree !== undefined) addClosure(tree);
  }
  for (const want of wants) {
    const object = getObject(repo, want);
    if (object !== null && object.type === 'tag' && !seen.has(want)) {
      const target = /^object ([0-9a-f]{40})$/m.exec(Buffer.from(object.data).toString('utf8'))?.[1];
      if (target !== undefined && sendCommits.has(target)) {
        send.push({ type: object.type, data: object.data });
        seen.add(want);
      }
    }
  }

  const shallow: string[] = [];
  for (const oid of sendCommits) {
    if (held.has(oid)) continue;
    const parents = commitParents(repo, oid);
    if (parents === null || parents.length === 0) continue;
    if (parents.some((parent) => !sendCommits.has(parent) && !held.has(parent))) {
      shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const parents = commitParents(repo, oid);
    if (parents !== null && parents.length > 0 && parents.every((parent) => sendCommits.has(parent) || held.has(parent))) {
      unshallow.push(oid);
    }
  }
  return { send, shallow, unshallow };
}

function isAncestor(repo: RepoRecord, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const stack = [descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const parents = commitParents(repo, oid);
    if (parents !== null) stack.push(...parents);
  }
  return false;
}

// ------------------------------------------------------------------ side-band framing

function sidebandChunks(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const max = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += max) {
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + max)])));
  }
  if (data.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return chunks;
}

// ------------------------------------------------------------------ upload-pack

const V2_CAPS = ['agent=makefun-forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

export function infoRefsUploadPack(repo: RepoRecord, v2: boolean): { status: number; body: Buffer } {
  if (v2) {
    const body = Buffer.concat([pktLine('version 2\n'), ...V2_CAPS.map((cap) => pktLine(`${cap}\n`)), FLUSH]);
    return { status: 200, body };
  }
  const caps = `multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta shallow agent=makefun-forge/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
    });
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (head !== undefined) parts.push(pktLine(`${head} HEAD\n`));
    else parts.push(pktLine(`${'0'.repeat(40)} HEAD\n`));
  }
  parts.push(FLUSH);
  return { status: 200, body: Buffer.concat(parts) };
}

export function infoRefsReceivePack(repo: RepoRecord): { status: number; body: Buffer } {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
    });
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (head !== undefined) parts.push(pktLine(`${head} HEAD\n`));
  }
  parts.push(FLUSH);
  return { status: 200, body: Buffer.concat(parts) };
}

function sortedRefs(repo: RepoRecord): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => {
    const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
    return rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return out;
}

/** POST /git-upload-pack: protocol v2 (ls-refs, fetch) or the v0 fallback. */
export function uploadPack(repo: RepoRecord, body: Uint8Array, v2: boolean): { status: number; body: Buffer } {
  return v2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
}

function uploadPackV2(repo: RepoRecord, body: Uint8Array): { status: number; body: Buffer } {
  const pkts = decodePktLines(body);
  let command = '';
  for (const pkt of pkts) {
    if (pkt.kind !== 'data') break;
    const line = lineText(pkt);
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      break;
    }
  }
  if (command === 'ls-refs') return lsRefsV2(repo, pkts);
  if (command === 'fetch') return fetchV2(repo, pkts);
  const empty = Buffer.concat([FLUSH]);
  return { status: 200, body: empty };
}

function lsRefsV2(repo: RepoRecord, pkts: Pkt[]): { status: number; body: Buffer } {
  let delimSeen = false;
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const pkt of pkts) {
    if (pkt.kind === 'delim') {
      delimSeen = true;
      continue;
    }
    if (!delimSeen || pkt.kind !== 'data') continue;
    const line = lineText(pkt);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head !== undefined) {
    if (matches('HEAD')) parts.push(pktLine(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  } else if (matches('HEAD')) {
    parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    if (symrefs && ref.name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return { status: 200, body: Buffer.concat(parts) };
}

function peelToCommit(repo: RepoRecord, oid: string): string | null {
  let current = oid;
  for (let hop = 0; hop < 10; hop += 1) {
    const object = getObject(repo, current);
    if (object === null) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = /^object ([0-9a-f]{40})$/m.exec(Buffer.from(object.data).toString('utf8'))?.[1];
    if (target === undefined) return null;
    current = target;
  }
  return null;
}

function fetchV2(repo: RepoRecord, pkts: Pkt[]): { status: number; body: Buffer } {
  const { wants, haves, shallow, depth } = parseFetchRequest(pkts);
  return buildFetchResponse(repo, wants, haves, shallow, depth, true);
}

function parseFetchRequest(pkts: Pkt[]): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let delimSeen = false;
  for (const pkt of pkts) {
    if (pkt.kind === 'delim') {
      delimSeen = true;
      continue;
    }
    if (!delimSeen || pkt.kind !== 'data') continue;
    const line = lineText(pkt);
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  return { wants, haves, shallow, depth };
}

function buildFetchResponse(repo: RepoRecord, wants: string[], haves: string[], clientShallow: string[], depth: number | null, v2: boolean): { status: number; body: Buffer } {
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const pack = writePack(plan.send);
  const contentType = 'application/x-git-upload-pack-result';
  if (v2) {
    const prelude: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      prelude.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) prelude.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) prelude.push(pktLine(`unshallow ${oid}\n`));
      prelude.push(FLUSH);
    }
    return { status: 200, body: Buffer.concat([...prelude, pktLine('packfile\n'), ...sidebandChunks(pack), FLUSH]) };
  }
  const prelude: Buffer[] = [];
  for (const oid of plan.shallow) prelude.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) prelude.push(pktLine(`unshallow ${oid}\n`));
  prelude.push(pktLine('NAK\n'));
  return { status: 200, body: Buffer.concat([...prelude, ...sidebandChunks(pack), FLUSH]) };
}

function uploadPackV0(repo: RepoRecord, body: Uint8Array): { status: number; body: Buffer } {
  const pkts = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') {
      section += 1;
      continue;
    }
    if (pkt.kind !== 'data' || section > 1) continue;
    const line = lineText(pkt);
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      wants.push(space === -1 ? rest : rest.slice(0, space));
    } else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  return buildFetchResponse(repo, wants, haves, shallow, depth, false);
}

// ------------------------------------------------------------------ receive-pack

export function receivePack(repo: RepoRecord, body: Uint8Array, storeObject: (type: string, data: Uint8Array) => string): { status: number; body: Buffer } {
  const pkts = decodePktLines(body, { stopAtFlush: true });
  const commands: Array<{ old: string; new: string; ref: string }> = [];
  let sideband = false;
  let reportStatus = true;
  let first = true;
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        const caps = line.slice(nul + 1).replace(/\n$/, '').split(' ').filter(Boolean);
        sideband = caps.includes('side-band-64k');
        reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
        line = line.slice(0, nul);
      }
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0]!, new: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  const flushPkt = pkts.find((pkt) => pkt.kind === 'flush');
  const packBytes = flushPkt === undefined ? new Uint8Array(0) : body.subarray(flushPkt.end);

  let unpackOk = true;
  const received: PackEntry[] = [];
  const updatesRef = commands.some((command) => command.new !== '0'.repeat(40));
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const entry of parsed) {
        storeObject(entry.type, entry.data);
        received.push(entry);
      }
    } catch {
      unpackOk = false;
    }
  } else if (updatesRef) {
    unpackOk = false;
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : 'unpacker error'}\n`];
  if (unpackOk) {
    for (const command of commands) {
      const zero = '0'.repeat(40);
      if (command.new === zero) {
        const current = repo.refs.get(command.ref);
        if (current === undefined) report.push(`ng ${command.ref} nothing to delete\n`);
        else if (command.old !== zero && current !== command.old) report.push(`ng ${command.ref} non-fast-forward\n`);
        else {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      const known = received.some((entry) => entry.oid === command.new) || getObject(repo, command.new) !== null;
      if (!known) {
        report.push(`ng ${command.ref} missing necessary objects\n`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.old === zero) {
        if (current !== undefined) {
          report.push(`ng ${command.ref} reference already exists\n`);
          continue;
        }
        repo.refs.set(command.ref, command.new);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      if (current !== command.old || !isAncestor(repo, command.old, command.new)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.new);
      report.push(`ok ${command.ref}\n`);
    }
  }

  const reportPkt = Buffer.concat([...report.map((line) => pktLine(line)), FLUSH]);
  let out: Buffer;
  if (sideband && reportStatus) {
    out = Buffer.concat([...sidebandChunks(reportPkt), FLUSH]);
  } else if (reportStatus) {
    out = reportPkt;
  } else {
    out = FLUSH;
  }
  return { status: 200, body: out };
}
