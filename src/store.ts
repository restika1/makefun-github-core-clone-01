// The one in-memory forge store every surface (REST, git smart HTTP, GraphQL, MCP) reads and
// writes. Object ids are deterministic counters; every timestamp comes from MAKEFUN_TRIAL_NOW.

import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { viewerUser } from './scenario.ts';

export interface GitObject {
  type: 'blob' | 'tree' | 'commit';
  data: Uint8Array;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
  isPull: boolean;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdAt: string;
  user: string;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  user: string;
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string | null;
}

export interface RepoRecord {
  id: number;
  name: string;
  owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  comments: Map<number, CommentRecord[]>;
  pulls: Map<number, PullRecord>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

const NOW = (process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00.000Z').replace(/^\s+|\s+$/g, '');

export function nowIso(): string {
  return NOW;
}

export const VIEWER = viewerUser();

export class Store {
  repos = new Map<string, RepoRecord>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;

  findRepo(owner: string, name: string): RepoRecord | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  createRepo(name: string, options: { description?: string | null; isPrivate?: boolean; defaultBranch?: string } = {}): RepoRecord {
    const repo: RepoRecord = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description: options.description ?? null,
      isPrivate: options.isPrivate ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      comments: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }
}

// ------------------------------------------------------------------ git objects

export function hashObject(repo: RepoRecord, type: GitObject['type'], data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = createHash('sha1').update(header).update(data).digest('hex');
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: RepoRecord, sha: string): GitObject | null {
  return repo.objects.get(sha.toLowerCase()) ?? null;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function encodeTree(entries: TreeEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return new Uint8Array(Buffer.concat(parts));
}

function decodeTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space += 1;
    let nul = space;
    while (nul < data.length && data[nul] !== 0) nul += 1;
    const mode = Buffer.from(data.subarray(offset, space)).toString('utf8');
    const name = Buffer.from(data.subarray(space + 1, nul)).toString('utf8');
    const sha = Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

interface CommitParsed {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
}

export function writeCommit(
  repo: RepoRecord,
  options: { tree: string; parents: string[]; message: string; authorName?: string; authorEmail?: string; timestamp?: string },
): string {
  const name = options.authorName ?? VIEWER.name;
  const email = options.authorEmail ?? VIEWER.email;
  const when = options.timestamp ?? nowIso();
  const lines: string[] = [`tree ${options.tree}`];
  for (const parent of options.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${name} <${email}> ${when}`);
  lines.push(`committer ${name} <${email}> ${when}`);
  const body = Buffer.from(`${lines.join('\n')}\n\n${options.message}\n`, 'utf8');
  const sha = hashObject(repo, 'commit', new Uint8Array(body));
  return sha;
}

export function parseCommit(repo: RepoRecord, sha: string): CommitParsed | null {
  const object = getObject(repo, sha);
  if (object === null || object.type !== 'commit') return null;
  const text = Buffer.from(object.data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
  }
  const match = /^(.*) <([^>]*)> (.*)$/.exec(author);
  return {
    tree,
    parents,
    message,
    authorName: match?.[1] ?? VIEWER.name,
    authorEmail: match?.[2] ?? VIEWER.email,
    timestamp: match?.[3] ?? nowIso(),
  };
}

function refTip(repo: RepoRecord, ref: string): string | null {
  return repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? null;
}

/** Resolve a branch name, a full ref, or a 40-char sha to a commit sha. */
export function resolveCommitish(repo: RepoRecord, value: string): string | null {
  const tip = refTip(repo, value);
  if (tip !== null) return tip;
  if (/^[0-9a-f]{40}$/.test(value) && getObject(repo, value) !== null) return value.toLowerCase();
  return null;
}

type FileMap = Map<string, string>;

function treeToFiles(repo: RepoRecord, treeSha: string, prefix = ''): FileMap {
  const files: FileMap = new Map();
  const object = getObject(repo, treeSha);
  if (object === null || object.type !== 'tree') return files;
  for (const entry of decodeTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      for (const [key, value] of treeToFiles(repo, entry.sha, path)) files.set(key, value);
    } else {
      files.set(path, entry.sha);
    }
  }
  return files;
}

function filesToTree(repo: RepoRecord, files: FileMap): string {
  const dirs = new Map<string, FileMap>();
  const root: FileMap = new Map();
  for (const [path, sha] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      root.set(path, sha);
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let bucket = dirs.get(dir);
      if (bucket === undefined) {
        bucket = new Map();
        dirs.set(dir, bucket);
      }
      bucket.set(rest, sha);
    }
  }
  const entries: TreeEntry[] = [];
  for (const [name, sha] of root) entries.push({ mode: '100644', name, sha });
  for (const [name, bucket] of dirs) {
    entries.push({ mode: '40000', name, sha: filesToTree(repo, bucket) });
  }
  entries.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  return hashObject(repo, 'tree', encodeTree(entries));
}

/** The blob sha at `path` in `commitSha`'s tree, or null when it is not there. */
export function fileSha(repo: RepoRecord, commitSha: string, path: string): string | null {
  const commit = parseCommit(repo, commitSha);
  if (commit === null) return null;
  return treeToFiles(repo, commit.tree).get(path) ?? null;
}

/**
 * Commit a whole file map to `ref` (creating the ref when unborn) and return the commit sha.
 * `changes` maps path -> blob sha or null (a deletion).
 */
export function commitFiles(
  repo: RepoRecord,
  ref: string,
  changes: ReadonlyMap<string, string | null>,
  options: { message: string; parents?: string[] },
): string {
  const tip = refTip(repo, ref);
  const baseTip = options.parents !== undefined ? options.parents[0] ?? null : tip;
  const files: FileMap = baseTip === null ? new Map() : treeToFiles(repo, parseCommit(repo, baseTip)!.tree);
  for (const [path, sha] of changes) {
    if (sha === null) files.delete(path);
    else files.set(path, sha);
  }
  const tree = filesToTree(repo, files);
  const parents = tip === null ? [] : [tip];
  const commitSha = writeCommit(repo, { tree, parents, message: options.message });
  repo.refs.set(ref, commitSha);
  return commitSha;
}

/** One changed path: null sha means deleted. */
export function diffTrees(repo: RepoRecord, fromCommit: string | null, toCommit: string | null): Map<string, string | null> {
  const before: FileMap = fromCommit === null ? new Map() : treeToFiles(repo, parseCommit(repo, fromCommit)!.tree);
  const after: FileMap = toCommit === null ? new Map() : treeToFiles(repo, parseCommit(repo, toCommit)!.tree);
  const out = new Map<string, string | null>();
  for (const [path, sha] of before) {
    const next = after.get(path);
    if (next === undefined) out.set(path, null);
    else if (next !== sha) out.set(path, next);
  }
  for (const [path, sha] of after) {
    if (!before.has(path)) out.set(path, sha);
  }
  return out;
}

/** The nearest common ancestor of two commits, or null. */
export function mergeBase(repo: RepoRecord, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (ancestors.has(sha)) continue;
    ancestors.add(sha);
    const commit = parseCommit(repo, sha);
    if (commit === null) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  const seen = new Set<string>();
  let queue = [b];
  while (queue.length > 0) {
    const next: string[] = [];
    for (const sha of queue) {
      if (ancestors.has(sha)) return sha;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = parseCommit(repo, sha);
      if (commit === null) continue;
      next.push(...commit.parents);
    }
    queue = next;
  }
  return null;
}

export function commitHistory(repo: RepoRecord, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const next: string[] = [];
    for (const sha of queue) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = parseCommit(repo, sha);
      if (commit === null) continue;
      out.push(sha);
      next.push(...commit.parents);
    }
    queue = next;
  }
  return out;
}

export function listBranches(repo: RepoRecord): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  return out;
}

export function treeEntry(repo: RepoRecord, treeSha: string, name: string): TreeEntry | null {
  const object = getObject(repo, treeSha);
  if (object === null || object.type !== 'tree') return null;
  for (const entry of decodeTree(object.data)) {
    if (entry.name === name) return entry;
  }
  return null;
}

/** Look up `path` under a commit's tree: a blob sha for files, 'dir' for directories. */
export function lookupPath(repo: RepoRecord, commitSha: string, path: string): { type: 'file' | 'dir'; sha: string } | null {
  const commit = parseCommit(repo, commitSha);
  if (commit === null) return null;
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') return { type: 'dir', sha: commit.tree };
  let current = commit.tree;
  const segments = clean.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const entry = treeEntry(repo, current, segments[i]!);
    if (entry === null) return null;
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    if (i === segments.length - 1) return { type: isDir ? 'dir' : 'file', sha: entry.sha };
    if (!isDir) return null;
    current = entry.sha;
  }
  return null;
}

export function listTree(repo: RepoRecord, treeSha: string, prefix: string): { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number | null }[] {
  const object = getObject(repo, treeSha);
  if (object === null || object.type !== 'tree') return [];
  const out: { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number | null }[] = [];
  for (const entry of decodeTree(object.data)) {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    let size: number | null = null;
    if (!isDir) {
      const blob = getObject(repo, entry.sha);
      size = blob === null ? null : blob.data.length;
    }
    out.push({ type: isDir ? 'dir' : 'file', name: entry.name, path, sha: entry.sha, size });
  }
  out.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  return out;
}

export function packObject(object: GitObject): Buffer {
  const header = Buffer.from(`${object.type} ${object.data.length}\0`, 'utf8');
  return deflateRawSync(Buffer.concat([header, Buffer.from(object.data)]));
}

export function unpackObject(raw: Uint8Array): { type: string; data: Uint8Array } | null {
  try {
    const inflated = inflateRawSync(raw);
    const nul = inflated.indexOf(0);
    if (nul === -1) return null;
    const header = Buffer.from(inflated.subarray(0, nul)).toString('utf8');
    const space = header.indexOf(' ');
    if (space === -1) return null;
    return { type: header.slice(0, space), data: inflated.subarray(nul + 1) };
  } catch {
    return null;
  }
}

/** Count line additions and deletions between two blob texts (a simple multiset line diff). */
export function lineCounts(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const counts = new Map<string, number>();
  for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of afterLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const value of counts.values()) deletions += value;
  return { additions, deletions };
}
