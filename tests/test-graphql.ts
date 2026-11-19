// GraphQL surface test: replays the suite's fixture flow (REST repo + git-pushed branches +
// REST issues) and the 20 check bodies' assertions, using the kit's own documents.
// Run: PORT=18083 TOK=testtoken node --experimental-strip-types tests/test-graphql.ts
const kit = process.env.MAKEFUN_KIT ?? '/home/hatch/workspace/makefun/github-core-clone-01-kit';
const { GRAPHQL_DOCUMENTS } = await import(`${kit}/program/env/src/checks-graphql.ts`);
const { buildScenario } = await import(`${kit}/program/env/src/wire.ts`);
const { GitClient, buildCommit, buildTree, collectReachable, hashObject, ZERO_OID } = await import(`${kit}/program/env/src/git-client.ts`);

const PORT = process.env.PORT ?? '18083';
const TOK = process.env.TOK ?? 'testtoken';
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'adaiversen';

const scenario = buildScenario();
const repo0 = scenario.repos[0]!;
const NAMES = {
  repository: `${repo0.name}-graphql`,
  pagesRepository: `${repo0.name}-graphql-pages`,
  unknownRepository: `${repo0.name}-graphql-missing`,
  baseBranch: repo0.defaultBranch,
  headBranch: scenario.pulls[0]!.head,
  createBranch: scenario.pulls[1]!.head,
  mergeBranch: scenario.pulls[2]!.head,
  filePath: scenario.blobs[0]!.path,
  baseFilePath: scenario.blobs[1]!.path,
  titlePrefix: scenario.issues[0]!.title,
  body: scenario.issues[0]!.body,
  comment: scenario.issues[1]!.body,
  pageSize: 5,
  pageCount: 7,
};

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const git = new GitClient({ baseUrl: BASE, token: TOK, timeoutMs: 10_000 });

async function gql<T = Json>(document: string, variables: Json = {}, token: string | null = TOK): Promise<{ status: number; body: T; errors: string[] }> {
  const res = await fetch(`${BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ query: document, variables }),
  });
  const body = (await res.json()) as Json;
  const errors = Array.isArray(body.errors) ? (body.errors as Json[]).map((e) => String(e.message)) : [];
  return { status: res.status, body: body as T, errors };
}

type Json = Record<string, unknown>;
const at = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Json)[key];
  }
  return current;
};

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/api/v3${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

// The fixture adapter: build one commit on `branch` (rooted at `from`) and push it.
const localObjects = new Map<string, { type: string; data: Uint8Array }>();
function put(type: string, data: Uint8Array): string {
  const oid = hashObject(type as 'blob', data);
  localObjects.set(oid, { type, data });
  return oid;
}

function parseTreeEntries(data: Uint8Array): { mode: string; name: string; oid: string }[] {
  const out: { mode: string; name: string; oid: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (data[space] !== 0x20) space += 1;
    let nul = space;
    while (data[nul] !== 0) nul += 1;
    out.push({
      mode: Buffer.from(data.subarray(offset, space)).toString('utf8'),
      name: Buffer.from(data.subarray(space + 1, nul)).toString('utf8'),
      oid: Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex'),
    });
    offset = nul + 21;
  }
  return out;
}

async function fetchCommitFiles(commitOid: string): Promise<Map<string, string>> {
  const fetched = await git.fetch(OWNER, NAMES.repository, { wants: [commitOid], parse: true });
  const commitData = fetched.objects.get(commitOid)!;
  const treeOid = /^tree ([0-9a-f]{40})$/m.exec(Buffer.from(commitData.data).toString('utf8'))?.[1]!;
  const files = new Map<string, string>();
  const walk = (tree: string, prefix: string): void => {
    const object = fetched.objects.get(tree);
    if (object === undefined) return;
    for (const entry of parseTreeEntries(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return files;
}

async function pushBranch(branch: string, from: string | undefined, path: string, content: string, message: string): Promise<void> {
  await git.createRepo(OWNER, NAMES.repository);
  const listed = await git.lsRefs(OWNER, NAMES.repository, { prefixes: [`refs/heads/${branch}`, ...(from === undefined ? [] : [`refs/heads/${from}`])] });
  const branchTip = listed.refs.find((r) => r.name === `refs/heads/${branch}`)?.oid;
  if (branchTip !== undefined) return;
  const fromTip = from === undefined ? undefined : listed.refs.find((r) => r.name === `refs/heads/${from}`)?.oid;
  if (from !== undefined && fromTip === undefined) throw new Error(`branch ${from} does not exist`);
  const parent = branchTip ?? fromTip ?? null;
  const files = parent === null ? new Map<string, string>() : await fetchCommitFiles(parent);

  // rewrite the flat map with the new path, then build nested trees recursively
  files.set(path, put('blob', Buffer.from(content, 'utf8')));
  const nested = (list: Map<string, string>): string => {
    const dirs = new Map<string, Map<string, string>>();
    const fileEntries: { mode: string; name: string; oid: string }[] = [];
    for (const [p, oid] of list) {
      const slash = p.indexOf('/');
      if (slash === -1) fileEntries.push({ mode: '100644', name: p, oid });
      else {
        const dir = p.slice(0, slash);
        let bucket = dirs.get(dir);
        if (bucket === undefined) {
          bucket = new Map();
          dirs.set(dir, bucket);
        }
        bucket.set(p.slice(slash + 1), oid);
      }
    }
    const entries = [...fileEntries, ...[...dirs].map(([name, bucket]) => ({ mode: '40000', name, oid: nested(bucket) }))];
    return put('tree', buildTree(entries));
  };
  const tree = nested(files);
  const commit = put('commit', buildCommit({ tree, parents: parent === null ? [] : [parent], message }));
  const reachable = collectReachable([commit], (oid) => localObjects.get(oid));
  const advertisement = await git.advertisement(OWNER, NAMES.repository, 'git-receive-pack');
  const serverTips = advertisement.refs.map((r) => r.oid).filter((o) => o !== ZERO_OID);
  const onServer = new Set<string>();
  for (const tip of serverTips) {
    const fetched = await git.fetch(OWNER, NAMES.repository, { wants: [tip], parse: true });
    for (const oid of fetched.objects.keys()) onServer.add(oid);
  }
  const objects = [...reachable].filter((oid) => !onServer.has(oid)).map((oid) => localObjects.get(oid)!);
  const pushed = await git.push(
    OWNER,
    NAMES.repository,
    [{ oldOid: branchTip ?? ZERO_OID, newOid: commit, ref: `refs/heads/${branch}` }],
    { objects },
  );
  if (pushed.report === null || !pushed.report.unpackOk || !pushed.report.refs[0]?.ok) {
    throw new Error(`push ${branch} failed: ${JSON.stringify(pushed.report)}`);
  }
}

async function main(): Promise<void> {
  // fixture: repo + branches
  await rest('POST', '/user/repos', { name: NAMES.repository, private: true, description: 'graphql checks' });
  await pushBranch(NAMES.baseBranch, undefined, NAMES.baseFilePath, `# ${NAMES.repository}\n\n${NAMES.body}\n`, `fixture: first commit on ${NAMES.baseBranch}`);
  await pushBranch(NAMES.headBranch, NAMES.baseBranch, NAMES.filePath, `${NAMES.body}\n`, `fixture: add ${NAMES.filePath}`);
  await pushBranch(NAMES.createBranch, NAMES.baseBranch, `${NAMES.filePath}.create`, `${NAMES.body}\n`, 'fixture: create branch');
  await pushBranch(NAMES.mergeBranch, NAMES.baseBranch, `${NAMES.filePath}.merge`, `${NAMES.body}\n`, 'fixture: merge branch');

  // 1. viewer-login
  {
    const r = await gql(GRAPHQL_DOCUMENTS.viewerLogin);
    ck('viewer-login', r.status === 200 && at(r.body, 'data', 'viewer', 'login') === OWNER, JSON.stringify(r.body));
  }

  // 2. repository-fields
  let repoId = '';
  {
    const r = await gql(GRAPHQL_DOCUMENTS.repositoryFields, { owner: OWNER, name: NAMES.repository });
    repoId = String(at(r.body, 'data', 'repository', 'id') ?? '');
    ck('repository-fields', r.status === 200
      && repoId !== ''
      && Number.isInteger(at(r.body, 'data', 'repository', 'databaseId'))
      && at(r.body, 'data', 'repository', 'name') === NAMES.repository
      && at(r.body, 'data', 'repository', 'owner', 'login') === OWNER
      && at(r.body, 'data', 'repository', 'defaultBranchRef', 'name') === NAMES.baseBranch
      && ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(String(at(r.body, 'data', 'repository', 'viewerPermission')))
      && at(r.body, 'data', 'repository', 'hasIssuesEnabled') === true, JSON.stringify(r.body));
  }

  // 3-4. introspection
  {
    const r = await gql(GRAPHQL_DOCUMENTS.issueFields);
    const names = ((at(r.body, 'data', 'Issue', 'fields') as Json[]) ?? []).map((f) => f.name);
    ck('introspection-issue', ['id', 'number', 'title', 'state', 'body'].every((n) => names.includes(n)), names.join(','));
  }
  {
    const r = await gql(GRAPHQL_DOCUMENTS.typeFields);
    const prNames = ((at(r.body, 'data', 'PullRequest', 'fields') as Json[]) ?? []).map((f) => f.name);
    const repoNames = ((at(r.body, 'data', 'Repository', 'fields') as Json[]) ?? []).map((f) => f.name);
    ck('introspection-pr', ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((n) => prNames.includes(n)), prNames.join(','));
    ck('introspection-repo', ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((n) => repoNames.includes(n)), repoNames.join(','));
    const s = await gql(GRAPHQL_DOCUMENTS.searchTypeEnumValues);
    const enums = ((at(s.body, 'data', 'SearchType', 'enumValues') as Json[]) ?? []).map((f) => f.name);
    ck('searchtype-enum', enums.includes('ISSUE'), enums.join(','));
  }

  // issues fixture
  const openNumbers: number[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = await rest('POST', `/repos/${OWNER}/${NAMES.repository}/issues`, { title: `${NAMES.titlePrefix} open ${i}`, body: NAMES.body });
    openNumbers.push((r.body as Json).number as number);
  }
  const closedR = await rest('POST', `/repos/${OWNER}/${NAMES.repository}/issues`, { title: `${NAMES.titlePrefix} closed`, body: NAMES.body });
  const closedNumber = (closedR.body as Json).number as number;
  await rest('PATCH', `/repos/${OWNER}/${NAMES.repository}/issues/${closedNumber}`, { state: 'closed' });

  // 5. issues-open-order
  {
    const r = await gql(GRAPHQL_DOCUMENTS.openIssues, { owner: OWNER, name: NAMES.repository, first: 10 });
    const nodes = (at(r.body, 'data', 'repository', 'issues', 'nodes') as Json[]) ?? [];
    const numbers = nodes.map((n) => n.number);
    const okOrder = numbers.every((n, i) => i === 0 || (numbers[i - 1] as number) >= (n as number));
    ck('issues-open-order', nodes.length > 0 && nodes.length <= 10 && okOrder && !numbers.includes(closedNumber) && openNumbers.every((n) => numbers.includes(n)) && nodes.every((n) => n.state === 'OPEN' && typeof n.title === 'string' && typeof n.id === 'string' && n.id !== ''), JSON.stringify(numbers));
  }

  // 6. issue-by-number
  {
    const r = await gql(GRAPHQL_DOCUMENTS.issueByNumber, { owner: OWNER, name: NAMES.repository, number: openNumbers[0] });
    ck('issue-by-number', at(r.body, 'data', 'repository', 'issue', 'number') === openNumbers[0]
      && at(r.body, 'data', 'repository', 'issue', 'state') === 'OPEN'
      && at(r.body, 'data', 'repository', 'issue', 'title') === `${NAMES.titlePrefix} open 1`
      && at(r.body, 'data', 'repository', 'issue', 'body') === NAMES.body
      && typeof at(r.body, 'data', 'repository', 'issue', 'id') === 'string', JSON.stringify(r.body));
  }
  const issueId = String(at((await gql(GRAPHQL_DOCUMENTS.issueByNumber, { owner: OWNER, name: NAMES.repository, number: openNumbers[0] })).body, 'data', 'repository', 'issue', 'id'));

  // 7. create-issue
  {
    const title = `${NAMES.titlePrefix} created over graphql`;
    const r = await gql(GRAPHQL_DOCUMENTS.createIssue, { input: { repositoryId: repoId, title, body: NAMES.body } });
    const number = at(r.body, 'data', 'createIssue', 'issue', 'number');
    const read = await rest('GET', `/repos/${OWNER}/${NAMES.repository}/issues/${number}`);
    ck('create-issue', Number.isInteger(number) && typeof at(r.body, 'data', 'createIssue', 'issue', 'id') === 'string'
      && (read.body as Json).title === title && (read.body as Json).state === 'open', JSON.stringify(r.body));
  }

  // 8. close-issue
  {
    const created = await rest('POST', `/repos/${OWNER}/${NAMES.repository}/issues`, { title: `${NAMES.titlePrefix} closed over graphql`, body: NAMES.body });
    const number = (created.body as Json).number as number;
    const idRead = await gql(GRAPHQL_DOCUMENTS.issueByNumber, { owner: OWNER, name: NAMES.repository, number });
    const id = at(idRead.body, 'data', 'repository', 'issue', 'id');
    const r = await gql(GRAPHQL_DOCUMENTS.closeIssue, { input: { issueId: id } });
    const read = await rest('GET', `/repos/${OWNER}/${NAMES.repository}/issues/${number}`);
    ck('close-issue', at(r.body, 'data', 'closeIssue', 'issue', 'number') === number
      && at(r.body, 'data', 'closeIssue', 'issue', 'state') === 'CLOSED'
      && (read.body as Json).state === 'closed', JSON.stringify(r.body));
  }

  // PR fixtures over REST (branches already pushed)
  const prR = await rest('POST', `/repos/${OWNER}/${NAMES.repository}/pulls`, { title: `${NAMES.titlePrefix} fixture pull request`, body: NAMES.body, head: NAMES.headBranch, base: NAMES.baseBranch });
  const prNumber = (prR.body as Json).number as number;

  // 9. pull-requests-list
  {
    const r = await gql(GRAPHQL_DOCUMENTS.pullRequests, { owner: OWNER, name: NAMES.repository, first: 5 });
    const nodes = (at(r.body, 'data', 'repository', 'pullRequests', 'nodes') as Json[]) ?? [];
    const node = nodes.find((n) => n.number === prNumber);
    ck('pull-requests-list', nodes.length <= 5 && node !== undefined
      && node.headRefName === NAMES.headBranch && node.baseRefName === NAMES.baseBranch
      && node.state === 'OPEN' && ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(String(node.mergeable)), JSON.stringify(nodes));
  }

  // 10. pull-request-files
  {
    const r = await gql(GRAPHQL_DOCUMENTS.pullRequestFiles, { owner: OWNER, name: NAMES.repository, number: prNumber });
    const paths = ((at(r.body, 'data', 'repository', 'pullRequest', 'files', 'nodes') as Json[]) ?? []).map((n) => n.path);
    ck('pull-request-files', at(r.body, 'data', 'repository', 'pullRequest', 'number') === prNumber && paths.includes(NAMES.filePath), paths.join(','));
  }

  // 11. create-pull-request
  {
    const title = `${NAMES.titlePrefix} created over graphql`;
    const r = await gql(GRAPHQL_DOCUMENTS.createPullRequest, { input: { repositoryId: repoId, baseRefName: NAMES.baseBranch, headRefName: NAMES.createBranch, title } });
    const number = at(r.body, 'data', 'createPullRequest', 'pullRequest', 'number');
    const read = await rest('GET', `/repos/${OWNER}/${NAMES.repository}/pulls/${number}`);
    ck('create-pull-request', Number.isInteger(number)
      && at(r.body, 'data', 'createPullRequest', 'pullRequest', 'state') === 'OPEN'
      && at(r.body, 'data', 'createPullRequest', 'pullRequest', 'headRefName') === NAMES.createBranch
      && at(r.body, 'data', 'createPullRequest', 'pullRequest', 'baseRefName') === NAMES.baseBranch
      && at(read.body, 'head', 'ref') === NAMES.createBranch && at(read.body, 'base', 'ref') === NAMES.baseBranch, JSON.stringify(r.body));
  }

  // 12. merge-pull-request
  {
    const mergePr = await rest('POST', `/repos/${OWNER}/${NAMES.repository}/pulls`, { title: `${NAMES.titlePrefix} merge pull request`, body: NAMES.body, head: NAMES.mergeBranch, base: NAMES.baseBranch });
    const number = (mergePr.body as Json).number as number;
    const idRead = await gql(GRAPHQL_DOCUMENTS.pullRequestId, { owner: OWNER, name: NAMES.repository, number });
    const id = at(idRead.body, 'data', 'repository', 'pullRequest', 'id');
    const r = await gql(GRAPHQL_DOCUMENTS.mergePullRequest, { input: { pullRequestId: id, mergeMethod: 'SQUASH' } });
    const read = await rest('GET', `/repos/${OWNER}/${NAMES.repository}/pulls/${number}`);
    ck('merge-pull-request', at(r.body, 'data', 'mergePullRequest', 'pullRequest', 'merged') === true
      && (read.body as Json).merged === true && (read.body as Json).state === 'closed', JSON.stringify(r.body));
  }

  // 13. add-comment
  {
    const created = await rest('POST', `/repos/${OWNER}/${NAMES.repository}/issues`, { title: `${NAMES.titlePrefix} commented over graphql`, body: NAMES.body });
    const number = (created.body as Json).number as number;
    const idRead = await gql(GRAPHQL_DOCUMENTS.issueByNumber, { owner: OWNER, name: NAMES.repository, number });
    const id = at(idRead.body, 'data', 'repository', 'issue', 'id');
    const r = await gql(GRAPHQL_DOCUMENTS.addComment, { input: { subjectId: id, body: NAMES.comment } });
    const list = await rest('GET', `/repos/${OWNER}/${NAMES.repository}/issues/${number}/comments`);
    ck('add-comment', at(r.body, 'data', 'addComment', 'commentEdge', 'node', 'body') === NAMES.comment
      && typeof at(r.body, 'data', 'addComment', 'commentEdge', 'node', 'id') === 'string'
      && (list.body as Json[]).some((c) => c.body === NAMES.comment), JSON.stringify(r.body));
  }

  // 14. invalid-field
  {
    const r = await gql(GRAPHQL_DOCUMENTS.invalidField);
    ck('invalid-field', r.status === 200 && r.errors.some((e) => e.includes('noSuchFieldOnViewer')), JSON.stringify(r.body));
  }

  // 15. unauthenticated
  {
    const r = await gql(GRAPHQL_DOCUMENTS.viewerLogin, {}, null);
    ck('unauthenticated', r.status === 401, String(r.status));
  }

  // 16. node-repository
  {
    const r = await gql(GRAPHQL_DOCUMENTS.nodeRepository, { id: repoId });
    ck('node-repository', at(r.body, 'data', 'node', 'id') === repoId
      && at(r.body, 'data', 'node', 'name') === NAMES.repository
      && at(r.body, 'data', 'node', 'nameWithOwner') === `${OWNER}/${NAMES.repository}`, JSON.stringify(r.body));
  }

  // 17. unknown-repository
  {
    const r = await gql(GRAPHQL_DOCUMENTS.repositoryFields, { owner: OWNER, name: NAMES.unknownRepository });
    ck('unknown-repository', r.status === 200 && at(r.body, 'data', 'repository') === null && r.errors.length === 0, JSON.stringify(r.body));
  }

  // 18. batched-operations
  {
    const res = await fetch(`${BASE}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
      body: JSON.stringify([{ query: GRAPHQL_DOCUMENTS.viewerLogin }, { query: GRAPHQL_DOCUMENTS.issueFields }]),
    });
    const body = await res.json();
    const ok = res.status === 200 && Array.isArray(body) && body.length === 2
      && at(body[0], 'data', 'viewer', 'login') === OWNER
      && ((at(body[1], 'data', 'Issue', 'fields') as Json[]) ?? []).length > 0;
    ck('batched-operations', ok, JSON.stringify(body).slice(0, 200));
  }

  // 19. global-id-stability
  {
    const a = await gql(GRAPHQL_DOCUMENTS.repositoryFields, { owner: OWNER, name: NAMES.repository });
    const b = await gql(GRAPHQL_DOCUMENTS.repositoryFields, { owner: OWNER, name: NAMES.repository });
    const id1 = String(at(a.body, 'data', 'repository', 'id'));
    const id2 = String(at(b.body, 'data', 'repository', 'id'));
    const dbId = String(at(a.body, 'data', 'repository', 'databaseId'));
    const ia = await gql(GRAPHQL_DOCUMENTS.issueByNumber, { owner: OWNER, name: NAMES.repository, number: openNumbers[0] });
    const ib = await gql(GRAPHQL_DOCUMENTS.issueByNumber, { owner: OWNER, name: NAMES.repository, number: openNumbers[0] });
    const i1 = String(at(ia.body, 'data', 'repository', 'issue', 'id'));
    const i2 = String(at(ib.body, 'data', 'repository', 'issue', 'id'));
    ck('global-id-stability', id1 === id2 && id1 !== dbId && i1 === i2 && i1 !== String(openNumbers[0]), `${id1} vs ${dbId}, ${i1} vs ${openNumbers[0]}`);
  }

  // 20. issues-pagination
  {
    await rest('POST', '/user/repos', { name: NAMES.pagesRepository, private: false });
    const pageNumbers: number[] = [];
    for (let i = 1; i <= NAMES.pageCount; i += 1) {
      const r = await rest('POST', `/repos/${OWNER}/${NAMES.pagesRepository}/issues`, { title: `${NAMES.titlePrefix} page ${i}`, body: NAMES.body });
      pageNumbers.push((r.body as Json).number as number);
    }
    const p1 = await gql(GRAPHQL_DOCUMENTS.issuesPage, { owner: OWNER, name: NAMES.pagesRepository, first: NAMES.pageSize, after: null });
    const c1 = at(p1.body, 'data', 'repository', 'issues') as Json;
    const n1 = (c1.nodes as Json[]) ?? [];
    const cursor = at(c1, 'pageInfo', 'endCursor');
    const p2 = await gql(GRAPHQL_DOCUMENTS.issuesPage, { owner: OWNER, name: NAMES.pagesRepository, first: NAMES.pageSize, after: cursor });
    const c2 = at(p2.body, 'data', 'repository', 'issues') as Json;
    const n2 = (c2.nodes as Json[]) ?? [];
    const seen = new Set([...n1, ...n2].map((n) => n.number));
    ck('issues-pagination', n1.length === NAMES.pageSize
      && at(c1, 'pageInfo', 'hasNextPage') === true && typeof cursor === 'string' && cursor !== ''
      && n2.length === NAMES.pageCount - NAMES.pageSize
      && at(c2, 'pageInfo', 'hasNextPage') === false
      && seen.size === NAMES.pageCount
      && pageNumbers.every((n) => seen.has(n)), JSON.stringify({ n1: n1.length, n2: n2.length, seen: [...seen] }));
  }

  console.log(`GRAPHQL: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});
