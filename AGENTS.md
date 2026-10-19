# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## What this is

`@studyzy/dsh-web-remote-access` is an out-of-tree **dsh bundle** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it enables `dsh web` remote access (`--host 0.0.0.0`), which upstream refuses as a wildcard bind, by resolving the wildcard to a concrete interface address. Remote browsers are gated by the harness's own launch-token session cookie (`?token=`), not by a token of this package's. The harness source is never modified — everything is implemented as a Cordis bundle (patch layer) that swaps the stock `web-startup` row and mounts this package's plugins. Bundle layering: `dsh-base` → `dsh-web-app` → `@studyzy/dsh-web-remote-access`.

## Commands

Requires Node ≥ 18 and [pnpm](https://pnpm.io/).

```sh
pnpm install                        # install dependencies
pnpm build                          # tsc -p tsconfig.json → lib/ (ESM output, from src/)
pnpm test                           # vitest run (all tests)
pnpm test:e2e                       # browser e2e against a REAL dsh CLI (needs global dsh + Playwright chromium)
pnpm test:e2e:local                 # browser e2e against the developer's real ~/.dsh web profile
pnpm vitest run tests/startup.spec.ts    # single test file
pnpm vitest run tests/startup.spec.ts -t "wildcard"   # single test by name filter
```

CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` on Node 18/20/22, plus an `e2e` job that installs the latest `@deepseek-ai/dsh@next` and runs `pnpm test:e2e` (see `tests/e2e/remote-access.e2e.ts`).

To test the package inside a real dsh harness, install it into the `web` profile: `dsh plugin --profile web add <path-or-npm-spec>` (see README).

## Architecture

The patch layer lives in `cordis.patch.yml`. It disables the stock `web-startup` row and overrides `web-runtime`'s URL print, then inserts three plugins (mounted under new ids). Each is a Cordis plugin:

- **`src/startup.ts`** — fork of `@deepseek-ai/dsh-web-app/startup`. Parses the `dsh --profile web` flag family (`--host`, `--port`, `--no-open`, `--trusted-host`) via a vendored `parseCmdline` (ported from `@deepseek-ai/dsh-cmdline`, MIT) that wires commander output through the harness's bounded-exit `ctx.appExit`. Provides the `webStartup` service (constant `WEB_STARTUP_SERVICE`): a wildcard `--host` (`0.0.0.0`, `::`) is resolved to this machine's first non-internal IPv4 address — upstream rejects wildcard binds outright because they would expose remote code execution to the network — and `remote` reports whether the resolved address is non-loopback. Exposes `internals` (lanAddresses / stdout / stderr) as test seams.
- The stock `webserver` row (`@deepseek-ai/dsh-host-webserver`) is **not** forked: binding a concrete address needs no patch, and the harness `/api` fence (`isTrustedApiRequest`) accepts the bind address on its own, so no LAN `trustedHosts` entries are needed.
- **`src/url.ts`** — prints the URL line at boot naming the address actually bound, with the harness launch token embedded (`dsh web: http://<bound>:<port>/?token=...`), read structurally from `ctx.get('connection').authenticatedUrl`. Replaces the stock URL print (which names the composed host rather than the address a wildcard resolved to). Waits on the Loader (`ctx.get('loader')?.await()`) so it prints only after boot settles.
- **`src/polyfill.ts`** — registers an index tap injecting a `crypto.randomUUID` polyfill (built on `crypto.getRandomValues`) before `</head>`. `randomUUID` is secure-context-only and undefined over plain HTTP on a LAN IP, which would throw in client bundles (RPC ids, attachment ids) and break the WebSocket readiness handshake. Active only on a non-loopback bind (`remote`).

`src/index.ts` is just a self-describing entry re-exporting `WEB_STARTUP_SERVICE`/`WebStartupValues`. `src/loopback.ts` flips the client's `connection.isLoopback` for remote browsers; its row is currently commented out in the patch layer pending diagnosis of a documentpreview activation failure.

### Two rules to keep when editing this bundle

- **Never rewrite a request's authority.** Since dsh 0.2.x the harness session cookie is authority-bound (`dsh-auth-<sha256(authority)>`, payload `authority` must equal the request Host), so presenting `/api` as loopback hides that cookie and the fence answers 401.
- **Never bind a wildcard address.** Resolve it to a concrete interface address instead; that is also what makes the harness trust fence accept the browser's Host without extra `--trusted-host` entries.

## Testing conventions

- Tests import source directly (`../src/startup.ts`) — no compiled `lib/` involvement.
- `tests/startup.spec.ts` boots a **real composition**: a test-only `cordis.yml` through the vendored `@deepseek-ai/cordis-plugin-loader` plus `cordis-plugin-include`, then asserts the published service (flag parsing, wildcard resolution, `remote`, bounded exits). The other specs (`url`, `polyfill`, `loopback`) test their modules in isolation.
- Every behavior change must come with a test that passes via `pnpm test`.

## Coding conventions

- TypeScript `strict`, target ES2022, NodeNext resolution, ESM (`"type": "module"`).
- Keep the zero-runtime-dependency restraint: use Node builtins or already-present deps (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/cordis-plugin-loader`, `commander`) before adding anything.
- Code comments in English; user-facing docs (README, CHANGELOG) in Chinese.
- Commits follow Conventional Commits; behavior/API changes must update `CHANGELOG.md` and README.
- When changing a forked file, preserve the upstream contract (services, route/tap/fallback semantics) unless the PR explains why the contract must evolve.
