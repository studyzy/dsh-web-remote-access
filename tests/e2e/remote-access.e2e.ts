/**
 * Full browser e2e for dsh-web-remote-access through the REAL dsh CLI chain:
 *
 *   1.  an isolated $DSH_HOME is created (never touches the user's ~/.dsh);
 *   2.  `dsh plugin --profile web add <this repo>` installs the bundle — the
 *       cordis.patch.yml swaps the stock startup row for this bundle's fork and
 *       mounts the url/polyfill rows;
 *   3.  `dsh web --host 0.0.0.0 --no-open --port <free>` is spawned against
 *       that home (the stock startup rejects that wildcard bind outright);
 *   4.  assertions against the real server prove the remote-access bundle
 *       works on the latest dsh: the boot line names the resolved LAN address
 *       and carries the harness `?token=` grant, every surface (/, /api,
 *       WebSocket upgrade) answers 401 without the session cookie, the launch
 *       token exchange grants it via a 303, the SPA index is served behind the
 *       cookie with the randomUUID polyfill injected, `/manifest.webmanifest`
 *       stays public, and an authenticated `/api` call reaches the bridge;
 *   5.  Playwright boots the WebUI through the LAN address (not loopback) and
 *       asserts the SPA renders into `#root` with zero page errors — over plain
 *       HTTP on a non-loopback origin `crypto.randomUUID` is undefined, so the
 *       injected polyfill is what keeps the client bundles from throwing
 *       (loopback is a secure context where this LAN-only bug could never
 *       surface).
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
  expectRemoteAccess, launchTokenFromLine, printedUrlFromLine, probeFreePort, rawRequest, resolvePnpmBinDir,
  saveFailureShot, runDSH, waitForReadyLine,
} from './helpers.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

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

    // Boot the real web server with the bundle mounted: --host 0.0.0.0, which
    // the stock startup rejects and this bundle resolves to a LAN address.
    const port = await probeFreePort()
    child = spawn('dsh', [
      'web',
      '--no-open', '--host', '0.0.0.0', '--port', String(port),
    ], {
      cwd: home,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', chunk => webLog.push(chunk.toString()))
    child.stderr?.on('data', chunk => webLog.push(chunk.toString()))
    readyLine = await waitForReadyLine(child)
    baseUrl = printedUrlFromLine(readyLine)
    // The browser goes through the LAN address the wildcard bind resolved to.
    // Over plain HTTP on a non-loopback address the origin is insecure —
    // crypto.randomUUID is undefined — so the injected polyfill actually runs;
    // loopback is a secure context where LAN-only bugs would never surface.
    browserUrl = baseUrl

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

  it('prints a boot line naming the resolved LAN address with the launch token', () => {
    // The bundle advertises the address the wildcard bind resolved to and the
    // harness launch token whose exchange mints the session cookie — one grant,
    // not two.
    expect(readyLine).toMatch(/^dsh web: http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\?token=/)
    expect(readyLine).not.toContain('127.0.0.1')
    expect(readyLine).not.toContain('web_token')
  })

  it('denies every surface without the session cookie, then grants it', async () => {
    const launchToken = launchTokenFromLine(readyLine)
    expect(launchToken).toBeDefined()
    await expectRemoteAccess(baseUrl, String(launchToken))
  })

  it('admits an authenticated /api request over the bound LAN authority', async () => {
    const launchToken = String(launchTokenFromLine(readyLine))
    const granted = await rawRequest(baseUrl, `/?token=${launchToken}`)
    const cookie = granted.headers['set-cookie']
      .split(',')
      .map(part => part.split(';')[0].trim())
      .filter(part => part.startsWith('dsh-auth-'))
      .join('; ')
    const api = await rawRequest(baseUrl, '/api/settings.describe', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
    })
    // 401 = the session cookie did not survive; 403 = the Host fence rejected
    // the authority the browser sent.
    expect(api.status).not.toBe(401)
    expect(api.status).not.toBe(403)
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

    // Navigate exactly like a real remote user opening the printed URL: it
    // carries the harness `?token=` grant, the server 303s to the clean
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
