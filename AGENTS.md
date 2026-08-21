# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## What this is

`@studyzy/dsh-web-remote-access` is an out-of-tree **dsh bundle** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it enables `dsh web` remote access (`--host 0.0.0.0`) and gates the whole Web UI behind a `--web_token` access token. The harness source is never modified — everything is implemented as a Cordis bundle (patch layer) that disables stock `web`-profile rows and mounts this package's forked plugins in their place. Bundle layering: `dsh-base` → `dsh-web-app` → `@studyzy/dsh-web-remote-access`.

## Commands

Requires Node ≥ 18 and [pnpm](https://pnpm.io/).

```sh
pnpm install                        # install dependencies
pnpm build                          # tsc -p tsconfig.json → lib/ (ESM output, from src/)
pnpm test                           # vitest run (all tests)
pnpm vitest run tests/webserver.spec.ts    # single test file
pnpm vitest run tests/webserver.spec.ts -t "401"   # single test by name filter
```

CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` on Node 18/20/22.

To test the package inside a real dsh harness, install it into the `web` profile: `dsh plugin --profile web add <path-or-npm-spec>` (see README).

## Architecture

The patch layer lives in `cordis.patch.yml`. It disables the stock `web-startup`, `webserver`, and `web-runtime` rows by id, then inserts four plugins (mounted under new ids). Each is a Cordis plugin:

- **`src/startup.ts`** — fork of `@deepseek-ai/dsh-web-app/startup`. Parses the `dsh --profile web` flag family (`--host`, `--port`, `--no-open`, `--trusted-host`, `--web_token`) via a vendored `parseCmdline` (ported from `@deepseek-ai/dsh-cmdline`, MIT) that wires commander output through the harness's bounded-exit `ctx.appExit`. Provides the `webStartup` service (constant `WEB_STARTUP_SERVICE`), whose `webToken` always exists: explicit `--web_token` wins, then `$DSH_WEB_TOKEN`, then a random token minted at startup (`randomBytes(32)` → base64url). Exposes `internals` (mintRandomToken / envWebToken / stdout / stderr) as test seams. The token is required when binding `0.0.0.0` — a random token is minted rather than allowing an unauthenticated bind.
- **`src/webserver.ts`** — fork of `@deepseek-ai/dsh-host-webserver`, a Cordis `Service` named `webServer`. Adds the token gate **before route matching** so it covers every surface: SPA fallback, `/api` RPC bridge, and the WebSocket downlink. Otherwise preserves the upstream service contract (below). This is the core security surface — read it carefully before editing.
- **`src/url.ts`** — prints the URL line at boot with the `?web_token=` grant embedded (`dsh web: http://127.0.0.1:<port>/?web_token=... (LAN: ...)`). Replaces the stock token-less URL print. Waits on the Loader (`ctx.get('loader')?.await()`) so it prints only after boot settles; computes LAN addresses from `os.networkInterfaces()` when bound to `0.0.0.0`.
- **`src/polyfill.ts`** — registers an index tap injecting a `crypto.randomUUID` polyfill (built on `crypto.getRandomValues`) before `</head>`. `randomUUID` is secure-context-only and undefined over plain HTTP on a LAN IP, which would throw in client bundles (RPC ids, attachment ids) and break the WebSocket readiness handshake. Only active when a token is set.

`src/index.ts` is just a self-describing entry re-exporting `WEB_STARTUP_SERVICE`/`WebStartupValues`. `src/injections.ts` is vendored verbatim from the upstream webserver (do not diverge it unnecessarily).

### The `webServer` service contract (must keep when editing the fork)

The composition resolves `ctx.webServer` unchanged, so upstream rows keep working. Contract:

- `register(route)` / `registerUpgrade(route)` — exact + prefix route tables; duplicate `(kind, path)` throws.
- `registerFallback(handler)` — a single fallback seat (the SPA dist server); a second registration throws.
- `tapIndex(transform)` — raw html→html transforms applied in registration order.
- `renderIndex(html)` — structured injection table first (`webserver/index-inject` emit, rows from `src/injections.ts`), then raw taps. Called by the upstream `frontend-static` fallback owner on every index response.
- `port` / `host` getters; the listening port (OS-assigned when configured 0).

Routing is exact-map first, then longest-prefix-wins over the prefix table, then the fallback seat.

### Token gate (`src/webserver.ts`)

- Constant-time comparison: sha256 hash both sides, then `timingSafeEqual` — never leaks length or content.
- Cookie `dsh_web_token`, attributes `Path=/; HttpOnly; SameSite=Lax`, session-scoped.
- `?web_token=` query grants once: 302 to the clean pathname + `Set-Cookie`, so the token leaves the address bar and the browser follows the cookie.
- `/manifest.webmanifest` is exempt for GET/HEAD only (browsers fetch the PWA manifest without the session cookie).
- WebSocket upgrade requires the cookie directly (the WS handshake can't carry the query flow); denial answers `401` with a text body, never a bare socket close.
- `authorizeApiAsLoopback` rewrites the Host/origin of an already-authenticated `/api` request to `127.0.0.1:<port>` so it passes the harness's downstream trust fence (privileged methods like `settings.*`, `credentials.*`, `llm.discoverModels`). This is safe only because the gate already admitted a cookie-bearing same-site client.
- Per-request errors never kill the process: `handle()` rejection is caught, logged, and answered `400` (or destroys the socket if headers are sent). Upgraded sockets are tracked and destroyed on teardown (Node's `closeAllConnections()` misses them).

## Testing conventions

- Tests import source directly (`../src/webserver.ts`) — no compiled `lib/` involvement.
- `tests/webserver.spec.ts` boots a **real composition**: a test-only `cordis.yml` through the vendored `@deepseek-ai/cordis-plugin-loader` plus `cordis-plugin-include`, then asserts against the live HTTP surface (routing precedence, index taps, fallback-seat semantics, error containment, teardown) and the gate behavior (401 denial, `?web_token=` 302 + cookie, cookie pass, `/api` loopback presentation, manifest exemption, upgrade 401). The other specs (`startup`, `url`, `polyfill`) test their modules in isolation.
- Every behavior change must come with a test that passes via `pnpm test`.

## Coding conventions

- TypeScript `strict`, target ES2022, NodeNext resolution, ESM (`"type": "module"`).
- Keep the zero-runtime-dependency restraint: use Node builtins or already-present deps (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/cordis-plugin-loader`, `commander`) before adding anything.
- Code comments in English; user-facing docs (README, CHANGELOG) in Chinese.
- Commits follow Conventional Commits; behavior/API changes must update `CHANGELOG.md` and README.
- When changing a forked file, preserve the upstream contract (services, route/tap/fallback semantics) unless the PR explains why the contract must evolve.
