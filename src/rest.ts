// The REST v3 surface under /api/v3, shaped as the suite's checks expect: JSON everywhere, an
// X-GitHub-Request-Id on every reply, bearer-token auth, exact statuses per the wire contract.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  VIEWER,
  commitFiles,
  commitHistory,
  diffTrees,
  fileSha,
  getObject,
  hashObject,
  lineCounts,
  listBranches,
  listTree,
  lookupPath,
  mergeBase,
  nowIso,
  parseCommit,
  resolveCommitish,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${(requestCounter % 0xffffffff).toString(16).padStart(8, '0')}-${(requestCounter % 0xffff).toString(16).padStart(4, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': requestId() });
  res.end();
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function ownerObject(login: string): Record<string, unknown> {
  return { login, id: VIEWER.id, type: 'User', site_admin: false };
}

function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: ownerObject(repo.owner),
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: repo.objects.size,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open' && !issue.isPull).length,
    has_issues: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    permissions: { admin: true, push: true, pull: true },
  };
}

function issueJson(repo: RepoRecord, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null; user: string }): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ id: 0, name, color: repo.labels.get(name)?.color ?? 'ededed', default: false })),
    user: ownerObject(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    url: '',
    html_url: '',
  };
}

function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headSha = pull.state === 'open' ? repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha : pull.headSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? true : null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    closed_at: pull.state === 'closed' ? pull.mergedAt ?? pull.createdAt : null,
    user: ownerObject(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.mergedAt ?? pull.createdAt,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    labels: [],
    draft: false,
    requested_reviewers: [],
    url: '',
    html_url: '',
  };
}

function labelJson(repo: RepoRecord, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: 1_000_000 + [...repo.labels.keys()].indexOf(name),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
    url: '',
  };
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, token: string | null, expectedToken: string | null, store: Store): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (expectedToken === null) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  if (token !== expectedToken) {
    sendError(res, 401, 'Bad credentials');
    return;
  }

  const segments = path.split('/').filter((segment) => segment !== '');
  const s = segments.slice(2);

  let body: unknown = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    const text = raw.toString('utf8').trim();
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
    }
  }

  const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

  // GET /api/v3/ (root)
  if (s.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (s[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '3.0.0-makefun', verifiable_password_authentication: true });
    return;
  }

  if (s[0] === 'user' && s[1] === undefined && method === 'GET') {
    sendJson(res, 200, { ...ownerObject(VIEWER.login), name: VIEWER.name, email: VIEWER.email, created_at: nowIso() });
    return;
  }

  if (s[0] === 'user' && s[1] === 'repos' && s[2] === undefined) {
    if (method === 'POST') {
      const input = object(body);
      const name = asString(input.name).trim();
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendError(res, 422, `Repository creation failed. Validation failed: name is invalid`);
        return;
      }
      if (store.repos.has(name)) {
        sendError(res, 422, 'name already exists on this account');
        return;
      }
      const repo = store.createRepo(name, {
        description: typeof input.description === 'string' ? input.description : null,
        isPrivate: input.private === true,
        defaultBranch: typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const nextUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        nextUrl.searchParams.set('page', String(page + 1));
        nextUrl.searchParams.set('per_page', String(perPage));
        headers.link = `<${nextUrl.toString()}>; rel="next", <${nextUrl.toString()}>; rel="last"`;
      }
      sendJson(res, 200, slice.map(repoJson), headers);
      return;
    }
    sendError(res, 405, `Method Not Allowed`);
    return;
  }

  if (s[0] === 'repos' && typeof s[1] === 'string' && typeof s[2] === 'string') {
    const repo = store.findRepo(s[1], s[2]);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
    const kind = s[3];
    const sub = s[4];
    const subSub = s[5];

    if (kind === undefined) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const input = object(body);
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.name === 'string' && input.name !== '' && input.name !== repo.name && /^[A-Za-z0-9._-]+$/.test(input.name) && !store.repos.has(input.name)) {
          store.repos.delete(repo.name);
          repo.name = input.name;
          store.repos.set(repo.name, repo);
        }
        if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.repos.delete(repo.name);
        sendEmpty(res, 204);
        return;
      }
      sendError(res, 405, `Method Not Allowed: ${method} ${base}`);
      return;
    }

    if (kind === 'branches' && sub === undefined && method === 'GET') {
      sendJson(res, 200, listBranches(repo).map((branch) => ({
        name: branch.name,
        commit: { sha: branch.sha, url: '' },
        protected: false,
      })));
      return;
    }

    if (kind === 'git' && sub === 'refs' && subSub === undefined) {
      if (method === 'POST') {
        const input = object(body);
        const ref = asString(input.ref);
        const sha = asString(input.sha).toLowerCase();
        if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
          sendError(res, 422, 'Reference creation failed. ref must be refs/heads/<branch>');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, `Reference already exists (${ref})`);
          return;
        }
        if (getObject(repo, sha)?.type !== 'commit') {
          sendError(res, 422, `Object does not exist (${sha})`);
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: '', url: '', object: { sha, type: 'commit', url: '' } });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: '', url: '', object: { sha, type: 'commit', url: '' } })));
        return;
      }
      sendError(res, 405, `Method Not Allowed: ${method} ${base}/git/refs`);
      return;
    }

    if (kind === 'commits' && sub === undefined && method === 'GET') {
      const refValue = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveCommitish(repo, refValue);
      if (tip === null) {
        sendError(res, 404, `No commit found for SHA: ${refValue}`);
        return;
      }
      const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const history = commitHistory(repo, tip, perPage * page);
      const slice = history.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, slice.map((sha) => {
        const commit = parseCommit(repo, sha)!;
        return {
          sha,
          node_id: '',
          commit: {
            message: commit.message,
            author: { name: commit.authorName, email: commit.authorEmail, date: commit.timestamp },
            committer: { name: commit.authorName, email: commit.authorEmail, date: commit.timestamp },
            tree: { sha: commit.tree },
            url: '',
          },
          author: ownerObject(repo.owner),
          committer: ownerObject(repo.owner),
          parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
          html_url: '',
          url: '',
        };
      }));
      return;
    }

    if (kind === 'contents') {
      const filePath = s.slice(4).join('/');
      handleContents(res, repo, store, method, query, filePath, body, object, asString);
      return;
    }

    if (kind === 'labels' && subSub === undefined) {
      if (method === 'POST' && sub === undefined) {
        const input = object(body);
        const name = asString(input.name).trim();
        if (name === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.has(name)) {
          sendError(res, 422, `Label already exists (${name})`);
          return;
        }
        repo.labels.set(name, { name, color: asString(input.color) || 'ededed', description: typeof input.description === 'string' ? input.description : null });
        sendJson(res, 201, labelJson(repo, name));
        return;
      }
      if (method === 'GET' && sub === undefined) {
        sendJson(res, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (kind === 'issues') {
      if (sub === undefined) {
        if (method === 'POST') {
          const input = object(body);
          const title = asString(input.title);
          if (title === '') {
            sendError(res, 422, 'Validation Failed: title is required');
            return;
          }
          const labels = Array.isArray(input.labels) ? input.labels.map(asString).filter((name) => name !== '') : [];
          for (const name of labels) {
            if (!repo.labels.has(name)) {
              sendError(res, 422, `Validation Failed: label ${JSON.stringify(name)} does not exist`);
              return;
            }
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const issue = {
            id: store.nextIssueId,
            number,
            title,
            body: asString(input.body),
            state: 'open' as const,
            labels,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            closedAt: null,
            user: repo.owner,
            isPull: false,
          };
          store.nextIssueId += 1;
          repo.issues.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          issues.sort((a, b) => a.number - b.number);
          if (direction === 'asc') issues.reverse();
          if (sort === 'updated') issues.sort((a, b) => (a.updatedAt === b.updatedAt ? b.number - a.number : a.updatedAt < b.updatedAt ? 1 : -1));
          const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
          const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
          sendJson(res, 200, issues.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(repo, issue)));
          return;
        }
        sendError(res, 405, `Method Not Allowed: ${method} ${base}/issues`);
        return;
      }

      const number = Number.parseInt(sub ?? '', 10);
      if (!Number.isInteger(number) || number <= 0 || !repo.issues.has(number)) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const issue = repo.issues.get(number)!;

      if (subSub === undefined) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const input = object(body);
          if (input.state === 'open' || input.state === 'closed') {
            issue.state = input.state;
            issue.closedAt = input.state === 'closed' ? nowIso() : null;
            issue.updatedAt = nowIso();
          }
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (Array.isArray(input.labels)) {
            const labels = input.labels.map(asString).filter((name) => name !== '');
            for (const name of labels) {
              if (!repo.labels.has(name)) {
                sendError(res, 422, `Validation Failed: label ${JSON.stringify(name)} does not exist`);
                return;
              }
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        sendError(res, 405, `Method Not Allowed: ${method} ${base}/issues/${number}`);
        return;
      }

      if (subSub === 'comments') {
        if (method === 'POST') {
          const input = object(body);
          const commentBody = asString(input.body);
          if (commentBody === '') {
            sendError(res, 422, 'Validation Failed: body is required');
            return;
          }
          const comment = { id: repo.nextCommentId, body: commentBody, createdAt: nowIso(), user: repo.owner };
          repo.nextCommentId += 1;
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          sendJson(res, 201, {
            id: comment.id,
            node_id: '',
            body: comment.body,
            user: ownerObject(comment.user),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            html_url: '',
            url: '',
          });
          return;
        }
        if (method === 'GET') {
          const list = repo.comments.get(number) ?? [];
          sendJson(res, 200, list.map((comment) => ({
            id: comment.id,
            node_id: '',
            body: comment.body,
            user: ownerObject(comment.user),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            html_url: '',
            url: '',
          })));
          return;
        }
        sendError(res, 405, `Method Not Allowed: ${method} ${base}/issues/${number}/comments`);
        return;
      }

      sendError(res, 404, 'Not Found');
      return;
    }

    if (kind === 'pulls') {
      if (sub === undefined) {
        if (method === 'POST') {
          const input = object(body);
          const head = asString(input.head);
          const base = asString(input.base);
          const title = asString(input.title);
          if (title === '') {
            sendError(res, 422, 'Validation Failed: title is required');
            return;
          }
          const headSha = resolveCommitish(repo, head);
          const baseSha = resolveCommitish(repo, base);
          if (headSha === null || baseSha === null) {
            sendError(res, 422, `Validation Failed: head ${JSON.stringify(head)} or base ${JSON.stringify(base)} does not exist`);
            return;
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const pull: PullRecord = {
            id: store.nextPullId,
            number,
            title,
            body: asString(input.body),
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
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => a.number - b.number);
          pulls.reverse();
          const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
          const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
          sendJson(res, 200, pulls.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(repo, pull)));
          return;
        }
        sendError(res, 405, `Method Not Allowed: ${method} ${base}/pulls`);
        return;
      }

      const number = Number.parseInt(sub ?? '', 10);
      const pull = repo.pulls.get(number);
      if (!Number.isInteger(number) || number <= 0 || pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }

      if (subSub === undefined) {
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (method === 'PATCH') {
          const input = object(body);
          if (input.state === 'open' || input.state === 'closed') {
            pull.state = input.state;
            const issue = repo.issues.get(number);
            if (issue !== undefined) {
              issue.state = input.state;
              issue.closedAt = input.state === 'closed' ? nowIso() : null;
            }
          }
          if (typeof input.title === 'string') pull.title = input.title;
          if (typeof input.body === 'string') pull.body = input.body;
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        sendError(res, 405, `Method Not Allowed: ${method} ${base}/pulls/${number}`);
        return;
      }

      if (subSub === 'files' && method === 'GET') {
        const files: Record<string, unknown>[] = [];
        const changes = diffTrees(repo, pull.baseSha, pull.headSha);
        for (const [path, sha] of changes) {
          const beforeSha = fileSha(repo, pull.baseSha, path);
          const beforeBlob = beforeSha === null ? null : getObject(repo, beforeSha);
          const afterBlob = sha === null ? null : getObject(repo, sha);
          const before = beforeBlob === null ? '' : Buffer.from(beforeBlob.data).toString('utf8');
          const after = afterBlob === null ? '' : Buffer.from(afterBlob.data).toString('utf8');
          const counts = lineCounts(before, after);
          files.push({
            sha: sha ?? '',
            filename: path,
            status: sha === null ? 'removed' : beforeBlob === null ? 'added' : 'modified',
            additions: counts.additions,
            deletions: counts.deletions,
            changes: counts.additions + counts.deletions,
            blob_url: '',
            raw_url: '',
          });
        }
        sendJson(res, 200, files);
        return;
      }

      if (subSub === 'merge' && method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) {
          sendError(res, 405, `Pull Request ${number} is not mergeable`);
          return;
        }
        const baseTip = resolveCommitish(repo, pull.baseRef);
        const headTip = resolveCommitish(repo, pull.headRef);
        if (baseTip === null || headTip === null) {
          sendError(res, 405, `Pull Request ${number} is not mergeable`);
          return;
        }
        const mb = mergeBase(repo, baseTip, headTip);
        const baseChanges = diffTrees(repo, mb, baseTip);
        const headChanges = diffTrees(repo, mb, headTip);
        for (const [path, sha] of headChanges) {
          if (baseChanges.has(path) && baseChanges.get(path) !== sha) {
            sendError(res, 405, `Pull Request ${number} has conflicts`);
            return;
          }
        }
        const merged = commitFiles(repo, `refs/heads/${pull.baseRef}`, headChanges, {
          message: `${pull.title} (#${number})`,
          parents: [baseTip],
        });
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = nowIso();
        pull.mergeCommitSha = merged;
        const issue = repo.issues.get(number);
        if (issue !== undefined) {
          issue.state = 'closed';
          issue.closedAt = pull.mergedAt;
        }
        sendJson(res, 200, { sha: merged, merged: true, message: 'Pull Request successfully merged' });
        return;
      }

      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleContents(
  res: ServerResponse,
  repo: RepoRecord,
  store: Store,
  method: string,
  query: URLSearchParams,
  filePath: string,
  body: unknown,
  object: (value: unknown) => Record<string, unknown>,
  asString: (value: unknown) => string,
): void {
  void store;
  if (method === 'GET') {
    const branch = resolveCommitish(repo, query.get('ref') ?? repo.defaultBranch);
    if (branch === null) {
      sendError(res, 404, 'No commit found for the ref');
      return;
    }
    const found = lookupPath(repo, branch, filePath);
    if (found === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (found.type === 'dir') {
      const prefix = filePath.replace(/^\/+|\/+$/g, '');
      sendJson(res, 200, listTree(repo, found.sha, prefix).map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
        encoding: null,
        url: '',
        git_url: '',
      })));
      return;
    }
    const blob = getObject(repo, found.sha);
    if (blob === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: found.sha,
      size: blob.data.length,
      encoding: 'base64',
      content: Buffer.from(blob.data).toString('base64'),
      url: '',
      download_url: '',
      git_url: '',
    });
    return;
  }

  if (method === 'PUT') {
    const input = object(body);
    const contentB64 = asString(input.content);
    const message = asString(input.message);
    if (message === '') {
      sendError(res, 422, 'Validation Failed: message is required');
      return;
    }
    const bytes = Buffer.from(contentB64, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== contentB64.replace(/=+$/, '')) {
      sendError(res, 422, 'Validation Failed: content is not valid base64');
      return;
    }
    const branchName = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const tip = resolveCommitish(repo, branchName);
    const existingSha = tip === null ? null : fileSha(repo, tip, filePath);
    const providedSha = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;

    if (existingSha !== null && providedSha === null) {
      sendError(res, 422, `sha wasn't supplied`);
      return;
    }
    if (providedSha !== null && existingSha !== providedSha) {
      sendError(res, 409, `${filePath} does not match ${providedSha}`);
      return;
    }

    const blobSha = hashObject(repo, 'blob', new Uint8Array(bytes));
    const commitSha = commitFiles(repo, `refs/heads/${branchName}`, new Map([[filePath, blobSha]]), { message });
    sendJson(res, existingSha === null ? 201 : 200, {
      content: {
        type: 'file',
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        sha: blobSha,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
        url: '',
        download_url: '',
        git_url: '',
      },
      commit: {
        sha: commitSha,
        node_id: '',
        url: '',
        html_url: '',
        author: {},
        committer: {},
        message,
        tree: { sha: '' },
        parents: [],
      },
    });
    return;
  }

  if (method === 'DELETE') {
    const input = object(body);
    const branchName = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const tip = resolveCommitish(repo, branchName);
    const existingSha = tip === null ? null : fileSha(repo, tip, filePath);
    if (existingSha === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const providedSha = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;
    if (providedSha !== null && providedSha !== existingSha) {
      sendError(res, 409, `${filePath} does not match ${providedSha}`);
      return;
    }
    const message = asString(input.message) || `Delete ${filePath}`;
    const commitSha = commitFiles(repo, `refs/heads/${branchName}`, new Map([[filePath, null]]), { message });
    sendJson(res, 200, {
      content: null,
      commit: { sha: commitSha, node_id: '', url: '', html_url: '', author: {}, committer: {}, message, tree: { sha: '' }, parents: [] },
    });
    return;
  }

  sendError(res, 405, `Method Not Allowed: ${method}`);
}
