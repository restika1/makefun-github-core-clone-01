# makefun-github-core-clone-01

A GitHub-compatible git forge built for the make.fun competition
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01): one Node 22 process, standard
library only, serving four surfaces from one in-memory store with no git binary and no network:

- **Git smart HTTP** — `/{owner}/{repo}.git` with upload-pack protocol v2 (plus a v0 fallback) and
  receive-pack v0 (report-status, side-band-64k, delete-refs), a hand-rolled pkt-line framing and
  packfile reader/writer, shallow `deepen` support, and fast-forward-only pushes refused per ref.
- **REST v3** — `/api/v3` for repositories, contents, labels, issues, comments, branches, commits and
  pull requests with squash merge; GitHub statuses (201/204/400/401/404/405/409/422),
  `X-GitHub-Request-Id` and `X-OAuth-Scopes` headers, and Link-header pagination.
- **GraphQL v4** — `/api/graphql` with introspection for the types gh feature-detects, issue and
  pull-request queries with ordering/cursor pagination, Relay `node(id:)` reads, and the
  createIssue/closeIssue/addComment/createPullRequest/mergePullRequest mutations; batched operations
  and opaque, stable global ids.
- **MCP** — `/mcp` speaking JSON-RPC 2.0 over the Streamable HTTP transport in revision 2026-07-28
  (`server/discover`) and the legacy initialize handshake, listing the github-mcp-server tool names
  (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request, …).

Deterministic by construction: ids come from counters, every timestamp from `MAKEFUN_TRIAL_NOW`, and
the scenario's seeded logins are derived exactly as the suite derives them. Tests in `tests/` drive
the forge through the kit's own conformance clients.

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/restika1/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/restika1/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, POSTs it to `$MAKEFUN_ENV_URL/register`, long-polls
`GET $MAKEFUN_ENV_URL/done`, and exits 0 when the env says the trial is over. There is nothing to
install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only.

## Layout

- `main.ts` — the entry ↔ env lifecycle (kept as the starter ships it)
- `app.ts` — the HTTP server and route dispatch
- `src/store.ts` — the one store: repos, issues, pulls, labels, git objects, refs
- `src/rest.ts` — the REST v3 surface
- `src/git-smart.ts` — pkt-line, packfiles, upload-pack and receive-pack
- `src/graphql.ts` — the GraphQL v4 executor
- `src/mcp.ts` — the MCP endpoint and tools
- `src/scenario.ts` — the deterministic replica of the suite's seeded scenario
- `tests/` — conformance tests driving the forge through the kit's own clients

## License

MIT — see [LICENSE](LICENSE).
