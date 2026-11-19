// The GraphQL v4 surface at /api/graphql: a small executor for the documents the suite sends
// (gh's queries and mutations), backed by the same store the REST and git surfaces use.

import {
  Store,
  VIEWER,
  diffTrees,
  fileSha,
  nowIso,
  resolveCommitish,
  mergePullRequestRecord,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

type Json = Record<string, unknown>;

interface Sel {
  name: string;
  alias: string | null;
  args: Json;
  sels: Sel[];
  typeCond: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string;
  vars: string[];
  sels: Sel[];
}

interface GqlErrorShape {
  message: string;
}

class GqlError extends Error implements GqlErrorShape {
  constructor(message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ tokenizer + parser

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index]!;
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === ',' ) {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"') {
      let value = '"';
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          value += text[index]! + (text[index + 1] ?? '');
          index += 2;
          continue;
        }
        value += text[index];
        index += 1;
      }
      value += '"';
      index += 1;
      tokens.push(value);
      continue;
    }
    if (ch === '.' && text.slice(index, index + 3) === '...') {
      tokens.push('...');
      index += 3;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let value = '';
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index]!)) {
        value += text[index];
        index += 1;
      }
      tokens.push(value);
      continue;
    }
    tokens.push(ch);
    index += 1;
  }
  return tokens;
}

class Parser {
  #tokens: string[];
  #index = 0;

  constructor(tokens: string[]) {
    this.#tokens = tokens;
  }

  peek(): string | undefined {
    return this.#tokens[this.#index];
  }

  next(): string {
    const token = this.#tokens[this.#index]!;
    this.#index += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlError(`expected ${token}, got ${got}`);
  }

  skipValue(): void {
    // Skip a variable declaration's type: !, [ ] or a name run.
    let depth = 0;
    for (;;) {
      const token = this.peek();
      if (token === undefined) return;
      if (token === ':' ) {
        this.next();
        continue;
      }
      if (token === '(' || token === '[') {
        depth += 1;
        this.next();
        continue;
      }
      if (token === ')' || token === ']') {
        if (depth === 0) return;
        depth -= 1;
        this.next();
        continue;
      }
      if (depth === 0 && (token === '{' || token === '}')) return;
      this.next();
    }
  }

  parseValue(vars: Json): unknown {
    const token = this.next();
    if (token.startsWith('$')) {
      return vars[token.slice(1)];
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === '[') {
      const out: unknown[] = [];
      while (this.peek() !== ']') {
        if (this.peek() === undefined) throw new GqlError('unterminated list');
        out.push(this.parseValue(vars));
      }
      this.next();
      return out;
    }
    if (token === '{') {
      const out: Json = {};
      for (;;) {
        const key = this.peek();
        if (key === '}') break;
        if (key === undefined) throw new GqlError('unterminated object');
        this.next();
        this.expect(':');
        out[key] = this.parseValue(vars);
      }
      this.next();
      return out;
    }
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10);
    return token;
  }

  parseArguments(vars: Json): Json {
    const args: Json = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')') {
      if (this.peek() === undefined) throw new GqlError('unterminated arguments');
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue(vars);
    }
    this.next();
    return args;
  }

  parseSelectionSet(vars: Json): Sel[] {
    this.expect('{');
    const sels: Sel[] = [];
    while (this.peek() !== '}') {
      const token = this.peek();
      if (token === undefined) throw new GqlError('unterminated selection set');
      if (token === '...') {
        this.next();
        let typeCond: string | null = null;
        if (this.peek() === 'on') {
          this.next();
          typeCond = this.next();
        }
        sels.push({ name: '', alias: null, args: {}, sels: this.parseSelectionSet(vars), typeCond });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.parseArguments(vars);
      const subSels = this.peek() === '{' ? this.parseSelectionSet(vars) : [];
      sels.push({ name, alias, args, sels: subSels, typeCond: null });
    }
    this.next();
    return sels;
  }
}

function parseDocument(text: string, vars: Json): Operation[] {
  const parser = new Parser(tokenize(text));
  const operations: Operation[] = [];
  if (parser.peek() === '{') {
    operations.push({ kind: 'query', name: '', vars: [], sels: parser.parseSelectionSet(vars) });
    return operations;
  }
  while (parser.peek() !== undefined) {
    const kind = parser.next();
    if (kind === 'query' || kind === 'mutation') {
      let name = '';
      if (parser.peek() !== undefined && parser.peek() !== '(' && parser.peek() !== '{') name = parser.next();
      if (parser.peek() === '(') {
        parser.next();
        while (parser.peek() !== ')') parser.skipValue();
        parser.next();
      }
      operations.push({ kind, name, vars: [], sels: parser.parseSelectionSet(vars) });
    } else {
      throw new GqlError(`unsupported document keyword ${JSON.stringify(kind)}`);
    }
  }
  if (operations.length === 0) throw new GqlError('the document holds no operation');
  return operations;
}

// ------------------------------------------------------------------ schema data

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'repository', 'labels'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'createdAt', 'closedAt', 'url', 'author', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'description', 'url', 'isPrivate'];

function typeOf(name: string): Json | null {
  const fieldList = (names: readonly string[]): unknown[] => names.map((fieldName) => ({ name: fieldName, type: { name: 'String', kind: 'SCALAR' } }));
  switch (name) {
    case 'Issue':
      return { name, kind: 'OBJECT', fields: fieldList(ISSUE_FIELDS), enumValues: null };
    case 'PullRequest':
      return { name, kind: 'OBJECT', fields: fieldList(PULL_REQUEST_FIELDS), enumValues: null };
    case 'Repository':
      return { name, kind: 'OBJECT', fields: fieldList(REPOSITORY_FIELDS), enumValues: null };
    case 'SearchType':
      return { name, kind: 'ENUM', fields: null, enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'].map((value) => ({ name: value })) };
    case 'Query':
      return { name, kind: 'OBJECT', fields: fieldList(['viewer', 'repository', 'node', '__type']), enumValues: null };
    case 'Mutation':
      return { name, kind: 'OBJECT', fields: fieldList(['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest']), enumValues: null };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ node builders

function globalId(prefix: string, id: number): string {
  return Buffer.from(`${prefix}:${id}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { prefix: string; numeric: number } | null {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const match = /^(R|I|PR|C):(\d+)$/.exec(decoded);
  if (match === null) return null;
  return { prefix: match[1]!, numeric: Number.parseInt(match[2]!, 10) };
}

function issueState(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(store: Store, repo: RepoRecord, issue: IssueRecord): Json {
  return {
    id: globalId('I', issue.id),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: '',
    author: { login: issue.user },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    repository: { name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
  };
}

function pullFiles(repo: RepoRecord, pull: PullRecord): Json {
  const headTip = pull.state === 'open' ? resolveCommitish(repo, pull.headRef) ?? pull.headSha : pull.headSha;
  const changes = diffTrees(repo, pull.baseSha, headTip);
  const paths = [...changes.keys()].sort();
  return { nodes: paths.map((path) => ({ path })), totalCount: paths.length };
}

function pullNode(store: Store, repo: RepoRecord, pull: PullRecord): Json {
  return {
    id: globalId('PR', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    files: () => pullFiles(repo, pull),
    mergedAt: pull.mergedAt,
    createdAt: pull.createdAt,
    closedAt: pull.mergedAt ?? (pull.state === 'closed' ? pull.createdAt : null),
    url: '',
    author: { login: pull.user },
    repository: { name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
  };
}

function repoNode(store: Store, repo: RepoRecord): Json {
  const issues = (): IssueRecord[] => [...repo.issues.values()].filter((issue) => !issue.isPull);
  const pulls = (): PullRecord[] => [...repo.pulls.values()];
  return {
    id: globalId('R', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    description: repo.description,
    url: '',
    isPrivate: repo.isPrivate,
    issue: (args: Json) => {
      const issue = issues().find((candidate) => candidate.number === args.number);
      return issue === undefined ? null : issueNode(store, repo, issue);
    },
    issues: (args: Json) => {
      let list = issues();
      const states = Array.isArray(args.states) ? args.states.map(String).map((value) => value.toLowerCase()) : null;
      if (states !== null && !states.includes('all')) list = list.filter((issue) => states.includes(issue.state));
      const orderBy = args.orderBy;
      const direction = typeof orderBy === 'object' && orderBy !== null && (orderBy as Json).direction === 'ASC' ? 'asc' : 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const first = typeof args.first === 'number' && args.first > 0 ? args.first : 30;
      let start = 0;
      if (typeof args.after === 'string' && args.after !== '') {
        const decoded = Buffer.from(args.after, 'base64url').toString('utf8');
        const cursorNumber = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
        if (Number.isInteger(cursorNumber)) {
          if (direction === 'desc') {
            start = list.findIndex((issue) => issue.number < cursorNumber);
            if (start === -1) start = list.length;
          } else {
            start = list.findIndex((issue) => issue.number > cursorNumber);
            if (start === -1) start = list.length;
          }
        }
      }
      const page = list.slice(start, start + first);
      const last = page[page.length - 1];
      const hasNextPage = start + first < list.length;
      return {
        nodes: page.map((issue) => issueNode(store, repo, issue)),
        totalCount: list.length,
        pageInfo: { hasNextPage, endCursor: last === undefined ? null : Buffer.from(`cursor:${last.number}`, 'utf8').toString('base64url') },
      };
    },
    pullRequest: (args: Json) => {
      const pull = pulls().find((candidate) => candidate.number === args.number);
      return pull === undefined ? null : pullNode(store, repo, pull);
    },
    pullRequests: (args: Json) => {
      let list = pulls().filter((pull) => pull.state === 'open');
      const states = Array.isArray(args.states) ? args.states.map(String).map((value) => value.toLowerCase()) : null;
      if (states !== null) {
        list = pulls().filter((pull) => {
          const state = pull.merged ? 'merged' : pull.state;
          return states.includes(state);
        });
      }
      list = list.sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' && args.first > 0 ? args.first : 30;
      return { nodes: list.slice(0, first).map((pull) => pullNode(store, repo, pull)), totalCount: list.length, pageInfo: { hasNextPage: list.length > first, endCursor: null } };
    },
  };
}

// ------------------------------------------------------------------ executor

function typeNameOf(value: Json): string {
  const id = value.id;
  if (typeof id !== 'string') return 'Node';
  const decoded = decodeGlobalId(id);
  if (decoded === null) return 'Node';
  return decoded.prefix === 'R' ? 'Repository' : decoded.prefix === 'I' ? 'Issue' : decoded.prefix === 'PR' ? 'PullRequest' : 'Comment';
}

function executeSelections(sels: Sel[], source: Json, typeName: string, kind: 'query' | 'mutation', store: Store): Json {
  const out: Json = {};
  for (const sel of sels) {
    if (sel.typeCond !== null) {
      if (sel.typeCond !== typeName && !(typeName === 'Node' && sel.typeCond === 'Repository')) continue;
      Object.assign(out, executeSelections(sel.sels, source, typeName === 'Node' ? sel.typeCond : typeName, kind, store));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name.startsWith('__')) {
      if (sel.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      if (sel.name === '__type' && typeName === 'Query' && '__type' in source) {
        const resolved = (source['__type'] as (args: Json) => unknown)(sel.args);
        out[key] = resolved === null || resolved === undefined ? null : executeSelections(sel.sels, resolved as Json, typeNameOf(resolved as Json), kind, store);
        continue;
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    }
    if (!(sel.name in source)) {
      throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    }
    const value = source[sel.name];
    const resolved = typeof value === 'function' ? (value as (args: Json) => unknown)(sel.args) : value;
    if (resolved === null || resolved === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((entry) => (typeof entry === 'object' && entry !== null ? executeSelections(sel.sels, entry as Json, typeNameOf(entry as Json), kind, store) : entry));
      continue;
    }
    if (typeof resolved === 'object') {
      out[key] = executeSelections(sel.sels, resolved as Json, typeNameOf(resolved as Json), kind, store);
      continue;
    }
    if (sel.sels.length > 0) {
      throw new GqlError(`Field "${sel.name}" must not have a selection of subfields.`);
    }
    out[key] = resolved;
  }
  return out;
}

function executeOperation(store: Store, operation: Operation): Json {
  const { kind, sels } = operation;
  const root: Json =
    kind === 'query'
      ? {
          viewer: { login: VIEWER.login },
          repository: (args: Json) => {
            const owner = typeof args.owner === 'string' ? args.owner : '';
            const name = typeof args.name === 'string' ? args.name : '';
            const repo = store.findRepo(owner, name);
            return repo === null ? null : repoNode(store, repo);
          },
          node: (args: Json) => {
            const id = typeof args.id === 'string' ? args.id : '';
            const decoded = decodeGlobalId(id);
            if (decoded === null) return null;
            if (decoded.prefix === 'R') {
              const repo = [...store.repos.values()].find((candidate) => candidate.id === decoded.numeric);
              return repo === undefined ? null : repoNode(store, repo);
            }
            for (const repo of store.repos.values()) {
              if (decoded.prefix === 'I') {
                const issue = [...repo.issues.values()].find((candidate) => candidate.id === decoded.numeric);
                if (issue !== undefined && !issue.isPull) return issueNode(store, repo, issue);
              }
              if (decoded.prefix === 'PR') {
                const pull = [...repo.pulls.values()].find((candidate) => candidate.id === decoded.numeric);
                if (pull !== undefined) return pullNode(store, repo, pull);
              }
            }
            return null;
          },
          __type: (args: Json) => typeOf(String(args.name)),
        }
      : {
          createIssue: (args: Json) => {
            const input = (args.input ?? {}) as Json;
            const repo = storeByGlobalId(store, typeof input.repositoryId === 'string' ? input.repositoryId : '', 'R');
            if (repo === null) throw new GqlError('Could not resolve to a node with the global id of the repository');
            const title = typeof input.title === 'string' ? input.title : '';
            if (title === '') throw new GqlError('title is required');
            const number = repo.nextNumber;
            repo.nextNumber += 1;
            const issue = {
              id: store.nextIssueId,
              number,
              title,
              body: typeof input.body === 'string' ? input.body : '',
              state: 'open' as const,
              labels: [],
              createdAt: nowIso(),
              updatedAt: nowIso(),
              closedAt: null,
              user: repo.owner,
              isPull: false,
            };
            store.nextIssueId += 1;
            repo.issues.set(number, issue);
            return { issue: issueNode(store, repo, issue) };
          },
          closeIssue: (args: Json) => {
            const input = (args.input ?? {}) as Json;
            const found = findIssue(store, typeof input.issueId === 'string' ? input.issueId : '');
            if (found === null) throw new GqlError('Could not resolve to a node with the global id of the issue');
            const { repo, issue } = found;
            issue.state = 'closed';
            issue.closedAt = nowIso();
            issue.updatedAt = nowIso();
            return { issue: issueNode(store, repo, issue) };
          },
          addComment: (args: Json) => {
            const input = (args.input ?? {}) as Json;
            const found = findIssue(store, typeof input.subjectId === 'string' ? input.subjectId : '');
            if (found === null) throw new GqlError('Could not resolve to a node with the global id of the issue');
            const { repo, issue } = found;
            const body = typeof input.body === 'string' ? input.body : '';
            const comment = { id: repo.nextCommentId, body, createdAt: nowIso(), user: repo.owner };
            repo.nextCommentId += 1;
            const list = repo.comments.get(issue.number) ?? [];
            list.push(comment);
            repo.comments.set(issue.number, list);
            return { commentEdge: { node: { id: globalId('C', comment.id), body } } };
          },
          createPullRequest: (args: Json) => {
            const input = (args.input ?? {}) as Json;
            const repo = storeByGlobalId(store, typeof input.repositoryId === 'string' ? input.repositoryId : '', 'R');
            if (repo === null) throw new GqlError('Could not resolve to a node with the global id of the repository');
            const head = typeof input.headRefName === 'string' ? input.headRefName : '';
            const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
            const title = typeof input.title === 'string' ? input.title : '';
            const headSha = resolveCommitish(repo, head);
            const baseSha = resolveCommitish(repo, base);
            if (headSha === null || baseSha === null) throw new GqlError(`Head branch ${JSON.stringify(head)} or base branch ${JSON.stringify(base)} does not exist`);
            const number = repo.nextNumber;
            repo.nextNumber += 1;
            const pull: PullRecord = {
              id: store.nextPullId,
              number,
              title,
              body: typeof input.body === 'string' ? input.body : '',
              state: 'open',
              headRef: head,
              headSha,
              baseRef: base,
              baseSha,
              merged: false,
              mergedAt: null,
              mergeCommitSha: null,
              createdAt: nowIso(),
              user: repo.owner,
            };
            store.nextPullId += 1;
            repo.pulls.set(number, pull);
            repo.issues.set(number, {
              id: pull.id,
              number,
              title,
              body: pull.body,
              state: 'open',
              labels: [],
              createdAt: pull.createdAt,
              updatedAt: pull.createdAt,
              closedAt: null,
              user: pull.user,
              isPull: true,
            });
            return { pullRequest: pullNode(store, repo, pull) };
          },
          mergePullRequest: (args: Json) => {
            const input = (args.input ?? {}) as Json;
            const decoded = decodeGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
            if (decoded === null || decoded.prefix !== 'PR') throw new GqlError('Could not resolve to a node with the global id of the pull request');
            let target: { repo: RepoRecord; pull: PullRecord } | null = null;
            for (const repo of store.repos.values()) {
              const pull = [...repo.pulls.values()].find((candidate) => candidate.id === decoded.numeric);
              if (pull !== undefined) {
                target = { repo, pull };
                break;
              }
            }
            if (target === null) throw new GqlError('Could not resolve to a node with the global id of the pull request');
            const result = mergePullRequestRecord(target.repo, target.pull);
            if (!result.ok) throw new GqlError(result.reason);
            return { pullRequest: pullNode(store, target.repo, target.pull) };
          },
        };
  return executeSelections(sels, root, kind === 'query' ? 'Query' : 'Mutation', kind, store);
}

function storeByGlobalId(store: Store, id: string, prefix: string): RepoRecord | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.prefix !== prefix) return null;
  const repo = [...store.repos.values()].find((candidate) => candidate.id === decoded.numeric);
  return repo ?? null;
}

function findIssue(store: Store, id: string): { repo: RepoRecord; issue: IssueRecord } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.prefix !== 'I') return null;
  for (const repo of store.repos.values()) {
    const issue = [...repo.issues.values()].find((candidate) => candidate.id === decoded.numeric);
    if (issue !== undefined && !issue.isPull) return { repo, issue };
  }
  return null;
}

export function handleGraphQLRequest(store: Store, body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => runOne(store, entry));
    return { status: 200, payload: results };
  }
  const result = runOne(store, body);
  return { status: 200, payload: result };
}

function runOne(store: Store, entry: unknown): Json {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { errors: [{ message: 'the request entry is not a JSON object' }] };
  }
  const query = (entry as Json).query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'the request carries no query string' }] };
  }
  const variables = (entry as Json).variables;
  const vars = typeof variables === 'object' && variables !== null && !Array.isArray(variables) ? variables as Json : {};
  try {
    const operations = parseDocument(query, vars);
    const operation = operations[0]!;
    return { data: executeOperation(store, operation) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { errors: [{ message }] };
  }
}
