# github-core-clone forge, second design

A GitHub-compatible git forge in one Node 22 process, standard library only.
It serves the git smart-HTTP protocol, the REST v3 API, the GraphQL API and
an MCP endpoint from a single pure domain core, so every surface reads and
writes the same repositories, issues and pull requests.

## Run it

```sh
node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set, `main.ts` runs the trial lifecycle: bind an
ephemeral port, register it with the env, poll `/done` and exit 0. Without it,
the server runs standalone on `PORT` (default: an ephemeral port, printed to
stderr) for local testing.

Authentication is a bearer token. When `MAKEFUN_SHOP_TOKEN` is set, requests
must present exactly that token; otherwise any non-empty bearer token is
accepted. The token's owner is `adaiversen` (id 1000) unless
`FORGE_VIEWER_LOGIN` says otherwise.

## Architecture

The design is layered: a pure domain core with thin wire adapters.

- `core.ts` — the domain. A global content-addressed git object store (one
  map for all repos; repositories hold only refs and metadata), issues, pull
  requests, labels, comments, tree diffs and three-way merges. No HTTP, no
  JSON. All timestamps come from one fixed epoch, so replays are identical.
- `gitwire.ts` — git wire primitives: pkt-lines, packfile reading (full
  OFS/REF delta resolution, including thin packs) and writing (plain
  objects), fetch planning (depth, deepen-relative, deepen-since,
  deepen-not, filters) and push application (per-ref fast-forward rules).
- `githttp.ts` — smart-HTTP adapters: v0/v2 advertisements, upload-pack
  (ls-refs, fetch) and receive-pack. Responses that are pure functions of
  repo state are cached per repo generation and invalidated exactly on
  mutation — no timers, no staleness.
- `rest.ts` — REST v3 handlers and JSON shaping, with cached serializations
  for hot reads (issue and repo bodies are rendered once per mutation).
- `graphql.ts` — a self-contained GraphQL implementation: tokenizer,
  parser, schema-driven validator and executor. One schema table drives
  validation, introspection and execution.
- `mcp.ts` — MCP over Streamable HTTP (JSON-RPC 2.0): the modern
  2026-07-28 era via `server/discover`, plus the legacy handshake. Ten
  tools over the same core functions REST uses.
- `app.ts` — the HTTP server: routing, auth, body limits, request ids and
  the JSON error envelope. Every response carries `X-GitHub-Request-Id`.
- `main.ts` — the trial lifecycle (register, poll `/done`, exit 0).

## Protocol notes

- Protocol v2 is honoured for upload-pack (`fetch=shallow filter`,
  `ls-refs=unborn`, `object-format=sha1`); receive-pack is v0-only with
  `report-status`, `side-band-64k` and `delete-refs`.
- Fetch honours `deepen`, `deepen-relative`, `deepen-since`, `deepen-not`
  and the `blob:none` / `tree:0` filters. Shallow boundaries move correctly
  on deepen, and `unshallow` is reported when a boundary is completed.
- Pushes are validated per ref: non-fast-forward updates are refused with
  the exact reason `non-fast-forward` while fast-forwards in the same push
  still apply. An empty command list (git's probe) is answered `unpack ok`.
- Merges are three-way: a path changed on both sides to different blobs is
  a conflict (HTTP 405); squash and merge-commit methods are supported.
- Issue and pull request numbers share one counter per repository, as on
  GitHub. Global ids are opaque, stable base64url values.
