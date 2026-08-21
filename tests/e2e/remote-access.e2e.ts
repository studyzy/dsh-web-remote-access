/**
 * Full browser e2e for dsh-web-remote-access through the REAL dsh CLI chain:
 *
 *   1.  an isolated $DSH_HOME is created (never touches the user's ~/.dsh);
 *   2.  `dsh plugin --profile web add <this repo>` installs the bundle — the
 *       cordis.patch.yml disables the stock web rows and mounts the forked
 *       startup/webserver/url/polyfill plugins;
 *   3.  `dsh web --host 0.0.0.0 --web_token <token> --no-open --port <free>`
 *       is spawned against that home;
 *   4.  assertions against the real server prove the remote-access bundle
 *       works on the latest dsh: the boot line embeds the grant URL, every
 *       surface (/, /api, WebSocket upgrade) answers 401 without the cookie or
 *       a matching `?web_token=`, the query flow grants a session cookie via a
 *       302, the SPA index is served behind the cookie with the randomUUID
 *       polyfill injected, `/manifest.webmanifest` stays public, and the same
 *       gate holds over the advertised LAN interface;
 *   5.  Playwright boots the WebUI through the advertised LAN interface (not
 *       loopback) with the granted cookie and asserts the SPA renders into
 *       `#root` with zero page errors — over plain HTTP on a non-loopback
 *       origin `crypto.randomUUID` is undefined, so the injected polyfill is
 *       what keeps the client bundles from throwing (loopback is a secure
 *       context where this LAN-only bug could never surface).
 *
 * Run: `pnpm test:e2e` (requires `dsh` on PATH; skipped otherwise).
 * Excluded from the default `pnpm test` via vitest.e2e.config.ts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  expectTokenGate, lanUrlFromLine, localUrlFromLine, probeFreePort, rawRequest, resolvePnpmBinDir,
  saveFailureShot, runDSH, waitForReadyLine,
} from './helpers.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
/** Deterministic token so the grant flow can be asserted byte-for-byte. */
const TOKEN = 'ci-e2e-token-0123456789abcdef'

/** The e2e needs the real dsh CLI; skip gracefully (with a hint) when absent. */
function dshAvailable(): boolean {
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}

describe.skipIf(!dshAvailable())('dsh-web-remote-access browser e2e (real dsh CLI)', () => {
  let child: ChildProcess
  let home: string
  let baseUrl: string
  let browserUrl: string
  let readyLine: string
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const webLog: string[] = []

  beforeAll(async () => {
    // Isolated world: never touches the real ~/.dsh.
    home = mkdtempSync(join(tmpdir(), 'dsh-remote-e2e-'))
    // dsh manages a profile's plugins with `pnpm` resolved from PATH. The
    // vitest process is launched by `pnpm run`, which pins PATH to this repo's
    // package-manager (pnpm@9 in CI) — and pnpm 9 rejects adding to a workspace
    // root. Prepend a pnpm ≥10 bin dir so dsh's pnpm installs cleanly.
    const spawnEnv = { ...process.env, DSH_HOME: home }
    const pnpmBin = resolvePnpmBinDir()
    if (pnpmBin !== '') spawnEnv.PATH = `${pnpmBin}:${spawnEnv.PATH ?? ''}`
    // Install the bundle into a fresh profile via the real dsh CLI.
    await runDSH(['plugin', '--profile', 'web', 'add', REPO_ROOT], home, spawnEnv)

    // Boot the real web server with the bundle mounted and the gate enabled.
    const port = await probeFreePort()
    child = spawn('dsh', [
      'web',
      '--no-open', '--host', '0.0.0.0', '--port', String(port), '--web_token', TOKEN,
    ], {
      cwd: home,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', chunk => webLog.push(chunk.toString()))
    child.stderr?.on('data', chunk => webLog.push(chunk.toString()))
    readyLine = await waitForReadyLine(child)
    baseUrl = localUrlFromLine(readyLine)
    // The browser goes through the LAN interface the bundle advertises
    // (falling back to loopback only when the runner has no non-internal IPv4
    // to advertise). Over plain HTTP on a non-loopback address the origin is
    // insecure — crypto.randomUUID is undefined — so the injected polyfill
    // actually runs; loopback is a secure context where LAN-only bugs would
    // never surface.
    browserUrl = lanUrlFromLine(readyLine) ?? baseUrl

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(`${message.type()}: ${message.text()}`)
    })
  }, 240_000)

  afterAll(async () => {
    await browser?.close()
    if (child !== undefined && child.exitCode === null) {
      const gone = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 10_000).unref())])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  it('prints a boot line that embeds the grant URL (remote access over 0.0.0.0)', () => {
    // The bundle's URL plugin advertises the token grant so a remote user can
    // open the printed URL directly — the LAN fragment proves the all-interfaces
    // bind actually advertised reachable addresses.
    expect(readyLine).toMatch(/^dsh web: http:\/\/127\.0\.0\.1:\d+\/\?web_token=/)
    expect(readyLine).toContain(`?web_token=${TOKEN}`)
    const lan = lanUrlFromLine(readyLine)
    if (lan !== undefined) expect(lan).toContain(`?web_token=${TOKEN}`)
  })

  it('denies every surface without the cookie or a matching token, then grants a session cookie', async () => {
    await expectTokenGate(baseUrl, TOKEN)
  })

  it('keeps the same gate over the advertised LAN interface', async () => {
    const lan = lanUrlFromLine(readyLine)
    if (lan === undefined) return // loopback-only environment: nothing to assert
    expect((await rawRequest(lan, '/')).status).toBe(401)
    const granted = await rawRequest(lan, `/?web_token=${TOKEN}`)
    expect(granted.status).toBe(302)
    expect(granted.headers['set-cookie']).toContain('dsh_web_token=')
  })

  it('boots the WebUI with the granted cookie without page errors', async () => {
    onTestFailed(async () => {
      // Failure evidence: a screenshot + page-state JSON, plus the frontend's
      // own errors and the host's stdout/stderr — together they distinguish a
      // crashed React tree, a gated request, and a never-finished boot.
      saveFailureShot(page, 'remote-access-e2e').catch((error: unknown) => {
        console.error(`--- saveFailureShot failed: ${String(error)} ---`)
      })
      console.error(`--- browser console errors (${consoleErrors.length}) ---`)
      for (const line of consoleErrors) console.error(line)
      console.error(`--- page errors (${pageErrors.length}) ---`)
      for (const line of pageErrors) console.error(line)
      const hostLog = webLog.join('').split('\n').filter(Boolean)
      console.error(`--- dsh web log tail (${hostLog.length} lines) ---\n${hostLog.slice(-80).join('\n')}`)
    })

    // Navigate exactly like a real remote user opening the printed LAN URL: it
    // already carries `?web_token=<token>`, the server 302s to the clean
    // pathname with a session cookie, Playwright stores it, and the SPA boots
    // over the insecure LAN origin — the path that actually exercises the
    // injected polyfill (without it, the client bundles throw while minting
    // RPC ids and the page errors surface here).
    await page.goto(browserUrl, { waitUntil: 'load', timeout: 90_000 })
    // The SPA renders into #root; a cold world mounts the first-run onboarding.
    await page.waitForFunction(
      () => (document.querySelector('#root')?.children.length ?? 0) > 0,
      undefined,
      { timeout: 90_000 },
    )
    expect(pageErrors).toEqual([])
  }, 180_000)
})
