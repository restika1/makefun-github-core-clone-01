// The MCP surface at /mcp: JSON-RPC 2.0 over the Streamable HTTP transport, speaking revision
// 2026-07-28 via server/discover and the legacy initialize handshake, with the github-mcp-server
// tool names acting on the same store as REST and GraphQL.

import {
  Store,
  VIEWER,
  mergePullRequestRecord,
  nowIso,
  resolveCommitish,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: '',
    url: '',
  };
}

function pullJson(pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${pull.user}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${pull.user}:${pull.baseRef}` },
    user: { login: pull.user },
    created_at: pull.createdAt,
    html_url: '',
    url: '',
  };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toolDefs(): ToolDef[] {
  const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
    type: 'object',
    properties,
    required,
  });
  const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
  const boolean = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
  const integer = (description: string): Record<string, unknown> => ({ type: 'integer', description });
  return [
    {
      name: 'create_repo',
      description: `Create a new repository owned by the authenticated account ${VIEWER.login}`,
      inputSchema: objectSchema({ name: str('The repository name'), description: str('The repository description'), private: boolean('Whether the repository is private') }, ['name']),
    },
    {
      name: 'get_repo',
      description: `Get one repository's metadata (owner is ${VIEWER.login})`,
      inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name') }, ['owner', 'repo']),
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository',
      inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name'), title: str('The issue title'), body: str('The issue body') }, ['owner', 'repo', 'title']),
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository, open ones by default',
      inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name'), state: str('Filter by state: open, closed or all') }, ['owner', 'repo']),
    },
    {
      name: 'create_pull_request',
      description: 'Open a pull request from a head branch into a base branch',
      inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name'), title: str('The pull request title'), body: str('The pull request body'), head: str('The head branch name'), base: str('The base branch name') }, ['owner', 'repo', 'title', 'head', 'base']),
    },
    {
      name: 'merge_pull_request',
      description: 'Squash-merge an open pull request into its base branch',
      inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name'), pull_number: integer('The pull request number') }, ['owner', 'repo', 'pull_number']),
    },
    {
      name: 'get_issue',
      description: 'Read one issue from a repository',
      inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name'), issue_number: integer('The issue number') }, ['owner', 'repo', 'issue_number']),
    },
    {
      name: 'list_pull_requests',
      description: 'List pull requests in a repository, open ones by default',
      inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name'), state: str('Filter by state: open, closed or all') }, ['owner', 'repo']),
    },
  ];
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function findRepo(store: Store, args: Record<string, unknown>): RepoRecord {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  const found = store.findRepo(owner, repo);
  if (found === null) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = toolDefs().find((tool) => tool.name === name);
  if (schema === undefined) throw new ParamsError(`unknown tool: ${name}`);
  const required = Array.isArray(schema.inputSchema.required) ? schema.inputSchema.required as string[] : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return toolError(`missing required argument: ${key}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolError(`invalid repository name: ${repoName}`);
      const existing = store.repos.get(repoName);
      if (existing !== undefined) return toolResult(repoJson(existing));
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        isPrivate: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      return toolResult(repoJson(findRepo(store, args)));
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      const title = String(args.title);
      if (title === '') return toolError('title must not be empty');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        id: store.nextIssueId,
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(issueJson(issue));
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map(issueJson));
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      const head = String(args.head);
      const base = String(args.base);
      const title = String(args.title);
      const headSha = resolveCommitish(repo, head);
      const baseSha = resolveCommitish(repo, base);
      if (headSha === null || baseSha === null) return toolError(`head ${head} or base ${base} does not exist`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRecord = {
        id: store.nextPullId,
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullJson(pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`pull request ${number} not found`);
      const result = mergePullRequestRecord(repo, pull);
      if (!result.ok) return toolError(result.reason);
      return toolResult({ merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    }
    case 'get_issue': {
      const repo = findRepo(store, args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined || issue.isPull) return toolError(`issue ${String(args.issue_number)} not found`);
      return toolResult(issueJson(issue));
    }
    case 'list_pull_requests': {
      const repo = findRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      return toolResult(pulls.map(pullJson));
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

class ParamsError extends Error {}

/** One POST /mcp body, already authorized; answers the JSON-RPC response text (empty for notifications). */
export function handleMcpBody(store: Store, bodyText: string): { status: number; body: string } {
  let request: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined || id === null;
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params) ? request.params as Record<string, unknown> : {};

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' && SUPPORTED_REVISIONS.includes(params.protocolVersion)
      ? params.protocolVersion
      : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge.',
      }),
    };
  }
  if (method === 'notifications/initialized') {
    return { status: 202, body: '' };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge.',
      }),
    };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: toolDefs() }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
    if (name === '' || toolDefs().every((tool) => tool.name !== name)) {
      return { status: 200, body: rpcError(id, -32602, `unknown tool: ${name || '(none)'}`) };
    }
    try {
      return { status: 200, body: rpcResult(id, callTool(store, name, args)) };
    } catch (err) {
      if (err instanceof ParamsError) return { status: 200, body: rpcError(id, -32602, err.message) };
      return { status: 200, body: rpcResult(id, toolError(err instanceof Error ? err.message : String(err))) };
    }
  }
  if (isNotification) {
    return { status: 202, body: '' };
  }
  return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
}
