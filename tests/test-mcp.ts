// MCP surface test: drives /mcp through the kit's own McpClient and replays the 15 check bodies.
// Run: PORT=18085 TOK=testtoken node --experimental-strip-types tests/test-mcp.ts
const kit = process.env.MAKEFUN_KIT ?? '/home/hatch/workspace/makefun/github-core-clone-01-kit';
const { McpClient, JSON_RPC_INVALID_PARAMS, JSON_RPC_PARSE_ERROR } = await import(`${kit}/program/env/src/mcp-client.ts`);
const { buildScenario } = await import(`${kit}/program/env/src/wire.ts`);

const PORT = process.env.PORT ?? '18085';
const TOK = process.env.TOK ?? 'testtoken';
const BASE = `http://127.0.0.1:${PORT}`;

const scenario = buildScenario();
const tag = scenario.seed.slice(0, 8);
const slug = (part: string): string => part.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
const DATA = {
  repo: (part: string): string => `mcp-${tag}-${slug(part)}`,
  branch: (part: string): string => `mcp-head-${tag}-${slug(part)}`,
  filePath: (part: string, which: string): string => `mcp-${tag}-${slug(part)}-${slug(which)}.txt`,
  issue: (i: number): { title: string; body: string } => scenario.issues[i % scenario.issues.length]!,
  pull: (i: number): { title: string; body: string } => scenario.pulls[i % scenario.pulls.length]!,
  blob: (i: number): { base64: string } => scenario.blobs[i % scenario.blobs.length]!,
  commitMessage: (i: number): string => scenario.commits[i % scenario.commits.length]!.message,
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

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}/api/v3${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.trim() === '' ? null : JSON.parse(text) };
}

function resultText(result: unknown): string {
  if (!isRecord(result)) return '';
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

function resultJson(result: unknown): unknown {
  if (!isRecord(result)) return null;
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const text = resultText(result).trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numberFrom(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const found = value[key];
    if (typeof found === 'number' && Number.isInteger(found)) return found;
    if (typeof found === 'string' && /^\d+$/.test(found)) return Number(found);
  }
  return null;
}

const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};
function findTool(tools: Json[], canonical: string): Json | null {
  const wanted = new Set([canonical, ...(ALIASES[canonical] ?? [])].map(normalizeName));
  for (const tool of tools) if (typeof tool.name === 'string' && wanted.has(normalizeName(tool.name))) return tool;
  for (const tool of tools) {
    if (typeof tool.name !== 'string') continue;
    const name = normalizeName(tool.name);
    for (const suffix of wanted) if (name.length > suffix.length && name.endsWith(suffix)) return tool;
  }
  return null;
}

const SYN: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'user', 'login'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name'],
  repo_full_name: ['full_name', 'repo_full_name', 'fullName'],
  title: ['title', 'issue_title', 'pr_title'],
  body: ['body', 'description', 'content'],
  head: ['head', 'head_branch', 'branch'],
  base: ['base', 'base_branch'],
  pull_number: ['pull_number', 'number', 'issue_number'],
  name: ['name', 'repo'],
  description: ['description', 'about', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};
function mapArguments(tool: Json, semantic: Json): { args: Json; missing: string[] } {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : null;
  const properties = schema !== null && isRecord(schema.properties) ? schema.properties : null;
  if (properties === null) return { args: { ...semantic }, missing: [] };
  const byNorm = new Map<string, string>();
  for (const p of Object.keys(properties)) byNorm.set(normalizeName(p), p);
  const propFor = (key: string): string | null => {
    for (const syn of SYN[key] ?? [key]) {
      const prop = byNorm.get(normalizeName(syn));
      if (prop !== undefined) return prop;
    }
    return null;
  };
  const args: Json = {};
  for (const [key, value] of Object.entries(semantic)) {
    if (value === undefined) continue;
    const prop = propFor(key);
    if (prop !== null) args[prop] = value;
  }
  const fullProp = propFor('repo_full_name');
  if (propFor('repo') === null && fullProp !== null && typeof semantic.owner === 'string' && typeof semantic.repo === 'string') {
    args[fullProp] = `${semantic.owner}/${semantic.repo}`;
  }
  const required = schema !== null && Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return { args, missing: required.filter((name) => !(name in args)) };
}

const client = new McpClient({ baseUrl: BASE, token: TOK, timeoutMs: 10_000 });

async function callToolByName(tools: Json[], canonical: string, semantic: Json, options: Json = {}): Promise<Json> {
  const tool = findTool(tools, canonical);
  if (tool === null) return { toolFound: false, toolName: canonical, args: {}, missing: [], outcome: null };
  const mapped = mapArguments(tool, semantic);
  const name = String(tool.name ?? canonical);
  if (mapped.missing.length > 0 && options.allowMissing !== true) return { toolFound: true, toolName: name, args: mapped.args, missing: mapped.missing, outcome: null };
  const outcome = await client.callTool(name, mapped.args, {});
  return { toolFound: true, toolName: name, args: mapped.args, missing: mapped.missing, outcome };
}

async function createSetupRepo(name: string): Promise<{ owner: string; repo: string; defaultBranch: string }> {
  const user = await rest('GET', '/user');
  const owner = isRecord(user.json) && typeof user.json.login === 'string' ? user.json.login : 'adaiversen';
  const created = await rest('POST', '/user/repos', { name, private: true, description: 'mcp setup' });
  if (created.status < 200 || created.status >= 300) throw new Error(`create repo ${name}: ${created.status}`);
  const defaultBranch = isRecord(created.json) && typeof created.json.default_branch === 'string' ? created.json.default_branch : 'main';
  return { owner, repo: name, defaultBranch };
}

async function preparePullRequest(setup: { owner: string; repo: string; defaultBranch: string }, part: string): Promise<{ owner: string; repo: string; base: string; head: string }> {
  const base = setup.defaultBranch;
  const basePath = DATA.filePath(part, 'base');
  const baseWrite = await rest('PUT', `/repos/${setup.owner}/${setup.repo}/contents/${basePath}`, { message: DATA.commitMessage(0), content: DATA.blob(0).base64 });
  if (baseWrite.status >= 300) throw new Error(`base write: ${baseWrite.status}`);
  const head = DATA.branch(part);
  const baseSha = isRecord(baseWrite.json) && isRecord((baseWrite.json as Json).commit) ? String((baseWrite.json as Json).commit.sha ?? '') : null;
  if (baseSha !== null && baseSha !== '') {
    const ref = await rest('POST', `/repos/${setup.owner}/${setup.repo}/git/refs`, { ref: `refs/heads/${head}`, sha: baseSha });
    if (ref.status >= 300) throw new Error(`ref create: ${ref.status}`);
  }
  const headWrite = await rest('PUT', `/repos/${setup.owner}/${setup.repo}/contents/${DATA.filePath(part, 'head')}`, { message: DATA.commitMessage(1), content: DATA.blob(1).base64, branch: head });
  if (headWrite.status >= 300) throw new Error(`head write: ${headWrite.status}`);
  return { owner: setup.owner, repo: setup.repo, base, head };
}

async function main(): Promise<void> {
  // 1-2. initialize + server-discover
  {
    const info = await client.connect();
    ck('initialize', typeof info.serverInfo?.name === 'string' && info.serverInfo.name.trim() !== ''
      && typeof info.serverInfo?.version === 'string' && info.serverInfo.version.trim() !== ''
      && isRecord(info.capabilities.tools), JSON.stringify({ era: info.era, v: info.protocolVersion }));
    ck('server-discover', info.era === 'modern' ? info.supportedVersions.length > 0 : true, `era=${info.era}`);
  }

  // 3-4. tools-list + tool-schemas
  const tools = await client.listTools();
  {
    ck('tools-list', tools.length >= 6, String(tools.length));
    for (const canonical of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
      ck(`tools-list:${canonical}`, findTool(tools, canonical) !== null);
    }
    let bad = 0;
    for (const tool of tools) {
      if (typeof tool.description !== 'string' || tool.description.trim() === '') bad += 1;
      if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') bad += 1;
    }
    ck('tool-schemas', bad === 0, `${bad} bad of ${tools.length}`);
  }

  // 5. create-issue
  {
    const setup = await createSetupRepo(DATA.repo('issue-create'));
    const issue = DATA.issue(0);
    const call = await callToolByName(tools, 'create_issue', { owner: setup.owner, repo: setup.repo, title: issue.title, body: issue.body });
    const outcome = call.outcome as Json | null;
    const failed = outcome !== null && (outcome.error !== undefined || outcome.isError === true);
    const listed = await rest('GET', `/repos/${setup.owner}/${setup.repo}/issues?state=all&per_page=100`);
    const found = Array.isArray(listed.json) ? (listed.json as Json[]).find((e) => e.title === issue.title) : undefined;
    ck('create-issue', !failed && found !== undefined, JSON.stringify(outcome?.error ?? outcome?.toolResult?.isError ?? null));
  }

  // 6. list-issues
  {
    const setup = await createSetupRepo(DATA.repo('issue-list'));
    const issue = DATA.issue(1);
    const created = await rest('POST', `/repos/${setup.owner}/${setup.repo}/issues`, { title: issue.title, body: issue.body });
    const number = isRecord(created.json) ? created.json.number : null;
    const call = await callToolByName(tools, 'list_issues', { owner: setup.owner, repo: setup.repo, state: 'open' });
    const text = resultText((call.outcome as Json | null)?.toolResult ?? null);
    ck('list-issues', text.includes(issue.title) || (number !== null && new RegExp(`"number"\\s*:\\s*${number}(?!\\d)`).test(text)), text.slice(0, 200));
  }

  // 7. create-pull-request
  {
    const setup = await createSetupRepo(DATA.repo('pr-create'));
    const prepared = await preparePullRequest(setup, 'pr-create');
    const template = DATA.pull(0);
    const call = await callToolByName(tools, 'create_pull_request', { owner: prepared.owner, repo: prepared.repo, title: template.title, body: template.body, head: prepared.head, base: prepared.base });
    const outcome = call.outcome as Json | null;
    const failed = outcome !== null && (outcome.error !== undefined || outcome.isError === true);
    const number = numberFrom(resultJson(outcome?.toolResult ?? null), ['number', 'pull_number']);
    let pull: Json | null = null;
    if (number !== null) {
      const read = await rest('GET', `/repos/${prepared.owner}/${prepared.repo}/pulls/${number}`);
      pull = isRecord(read.json) ? read.json : null;
    }
    ck('create-pull-request', !failed && pull !== null && (pull.head as Json)?.ref === prepared.head && (pull.base as Json)?.ref === prepared.base, JSON.stringify(outcome?.error ?? pull?.head ?? null));
  }

  // 8. merge-pull-request
  {
    const setup = await createSetupRepo(DATA.repo('pr-merge'));
    const prepared = await preparePullRequest(setup, 'pr-merge');
    const template = DATA.pull(1);
    const created = await rest('POST', `/repos/${prepared.owner}/${prepared.repo}/pulls`, { title: template.title, head: prepared.head, base: prepared.base });
    const number = isRecord(created.json) ? created.json.number : null;
    const call = await callToolByName(tools, 'merge_pull_request', { owner: prepared.owner, repo: prepared.repo, pull_number: number });
    const outcome = call.outcome as Json | null;
    const failed = outcome !== null && (outcome.error !== undefined || outcome.isError === true);
    const read = await rest('GET', `/repos/${prepared.owner}/${prepared.repo}/pulls/${number}`);
    ck('merge-pull-request', !failed && isRecord(read.json) && read.json.merged === true, JSON.stringify(outcome?.error ?? read.json?.merged ?? null));
  }

  // 9. unknown-tool
  {
    const outcome = await client.request('tools/call', { name: `mcp_no_such_tool_${tag}`, arguments: {} });
    ck('unknown-tool', outcome.status !== 500 && outcome.error !== undefined && (outcome.error.code === JSON_RPC_INVALID_PARAMS || outcome.error.code === -32601), `HTTP ${outcome.status}, code ${outcome.error?.code}`);
  }

  // 10. parse-error
  {
    const answer = await client.postRaw('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"', { methodHeader: 'tools/list', expectedId: 424242 });
    const code = answer.rpc?.error?.code ?? null;
    ck('parse-error', code === JSON_RPC_PARSE_ERROR && (answer.status === 400 || answer.status === 200), `HTTP ${answer.status}, code ${code}`);
  }

  // 11. missing-arguments
  {
    const call = await callToolByName(tools, 'create_issue', {}, { allowMissing: true });
    const outcome = call.outcome as Json | null;
    const ok = outcome !== null && (outcome.error !== undefined ? outcome.error.code === JSON_RPC_INVALID_PARAMS : outcome.isError === true || (isRecord(outcome.toolResult) && outcome.toolResult.isError === true));
    ck('missing-arguments', ok, JSON.stringify(outcome?.error ?? outcome?.toolResult?.isError ?? null));
  }

  // 12. concurrent-calls
  {
    const left = await createSetupRepo(DATA.repo('concurrent-left'));
    const right = await createSetupRepo(DATA.repo('concurrent-right'));
    const tool = findTool(tools, 'get_repo');
    const leftMapped = tool ? mapArguments(tool, { owner: left.owner, repo: left.repo }) : null;
    const rightMapped = tool ? mapArguments(tool, { owner: right.owner, repo: right.repo }) : null;
    const leftId = `concurrent-left-${tag}`;
    const rightId = `concurrent-right-${tag}`;
    const [la, ra] = await Promise.all([
      client.callTool(String(tool?.name ?? 'get_repo'), leftMapped!.args, { id: leftId }),
      client.callTool(String(tool?.name ?? 'get_repo'), rightMapped!.args, { id: rightId }),
    ]);
    const leftText = resultText(la.toolResult);
    const rightText = resultText(ra.toolResult);
    ck('concurrent-calls', la.matchedId === leftId && ra.matchedId === rightId && la.error === undefined && ra.error === undefined && leftText.includes(left.repo) && rightText.includes(right.repo), JSON.stringify([la.matchedId, ra.matchedId]));
  }

  // 13. tools-list-idempotent
  {
    const first = await client.listTools();
    const second = await client.listTools();
    ck('tools-list-idempotent', JSON.stringify(first) === JSON.stringify(second));
  }

  // 14. rest-parity
  {
    const repoName = DATA.repo('parity');
    const createdRepo = await callToolByName(tools, 'create_repo', { owner: 'adaiversen', name: repoName, description: scenario.repos[0]!.description, private: true });
    const outcome = createdRepo.outcome as Json | null;
    const failed = outcome !== null && (outcome.error !== undefined || outcome.isError === true);
    const repoJson = resultJson(outcome?.toolResult ?? null) as Json | null;
    let owner = 'adaiversen';
    let repo = repoName;
    if (repoJson !== null && typeof repoJson.full_name === 'string') {
      const [namedOwner, namedRepo] = repoJson.full_name.split('/', 2);
      if (namedOwner !== '' && namedRepo !== '') {
        owner = namedOwner;
        repo = namedRepo;
      }
    }
    const firstRepo = await rest('GET', `/repos/${owner}/${repo}`);
    const secondRepo = await rest('GET', `/repos/${owner}/${repo}`);
    const issue = DATA.issue(2);
    const createdIssue = await callToolByName(tools, 'create_issue', { owner, repo, title: issue.title, body: issue.body });
    const issueOutcome = createdIssue.outcome as Json | null;
    let number = numberFrom(resultJson(issueOutcome?.toolResult ?? null), ['number']);
    if (number === null) {
      const listed = await rest('GET', `/repos/${owner}/${repo}/issues?state=all&per_page=100`);
      if (Array.isArray(listed.json)) for (const e of listed.json as Json[]) if (e.title === issue.title && typeof e.number === 'number') number = e.number;
    }
    const firstIssue = await rest('GET', `/repos/${owner}/${repo}/issues/${number}`);
    const secondIssue = await rest('GET', `/repos/${owner}/${repo}/issues/${number}`);
    ck('rest-parity', !failed && firstRepo.status === 200 && secondRepo.status === 200
      && isRecord(firstRepo.json) && isRecord(secondRepo.json) && String(firstRepo.json.id) === String(secondRepo.json.id)
      && number !== null && firstIssue.status === 200 && secondIssue.status === 200
      && isRecord(firstIssue.json) && isRecord(secondIssue.json) && String(firstIssue.json.id) === String(secondIssue.json.id)
      && firstIssue.json.title === issue.title, JSON.stringify({ repoStatus: firstRepo.status, number, issueStatus: firstIssue.status }));
  }

  // 15. auth-required
  {
    const issue = DATA.issue(3);
    const name = String(findTool(tools, 'create_issue')?.name ?? 'create_issue');
    const outcome = await client.callTool(name, { owner: 'no-auth', repo: `no-auth-${tag}`, title: issue.title, body: issue.body }, { omitAuth: true });
    ck('auth-required', outcome.status === 401, `HTTP ${outcome.status}`);
  }

  console.log(`MCP: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});
