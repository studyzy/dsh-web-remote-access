/**
 * LOCAL browser e2e for dsh-web-remote-access, running against the developer's
 * REAL ~/.dsh (no isolated home, no dsh install — the globally installed dsh
 * and the existing web profile are assumed):
 *
 *   1.  `dsh plugin --profile web add <this repo>` links the current source
 *       into the local web profile (an older `github:`-sourced install is
 *       removed first so the local path wins);
 *   2.  `dsh web --host 0.0.0.0 --web_token <token> --no-open --port <free>`
 *       is spawned against the real home;
 *   3.  the token gate is asserted over the live server (401 without a cookie
 *       or matching token, `?web_token=` 302 + session cookie, SPA + polyfill
 *       behind the cookie, public manifest), and Playwright boots the WebUI
 *       through the LAN interface with the granted cookie asserting zero page
 *       errors.
 *
 * Unlike the CI lane (`remote-access.e2e.ts`, isolated $DSH_HOME), this one
 * reuses the local profile and intentionally does NOT clean up: the source
 * link persists for the developer's daily use.
 *
 * The browser visits the LAN IP, not loopback: over plain HTTP on a
 * non-loopback address the origin is an insecure context (`crypto.randomUUID`
 * is undefined), which is exactly the remote-access scenario this bundle
 * exists for and the path that actually exercises the injected polyfill —
 * loopback is a secure context where LAN-only bugs would never surface.
 *
 * Not part of CI; run with `pnpm test:e2e:local`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  expectTokenGate, lanUrlFromLine, localUrlFromLine, probeFreePort, resolvePnpmBinDir, runDSH,
  saveFailureShot, waitForReadyLine,
} from './helpers.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
/** Deterministic token so the grant flow can be asserted byte-for-byte. */
const TOKEN = 'local-e2e-token-0123456789abcdef'

/** The local lane needs the real dsh CLI; skip gracefully when absent. */
function dshAvailable(): boolean {
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}

describe.skipIf(!dshAvailable())('dsh-web-remote-access browser e2e (local ~/.dsh)', () => {
  let child: ChildProcess
  let baseUrl: string
  let browserUrl: string
  let readyLine: string
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const webLog: string[] = []

  beforeAll(async () => {
    const home = homedir()
    // Install the CURRENT source into the local web profile as a `link:`
    // dependency. If an older `github:`-sourced version is already present,
    // pnpm keeps resolving that remote spec, so remove it first — then re-add
    // the local path as a link.
    const spawnEnv = { ...process.env }
    const pnpmBin = resolvePnpmBinDir()
    if (pnpmBin !== '') spawnEnv.PATH = `${pnpmBin}:${spawnEnv.PATH ?? ''}`
    await runDSH(['plugin', '--profile', 'web', 'remove', '@studyzy/dsh-web-remote-access'], home, spawnEnv)
      .catch(() => {
        // Not installed via dsh before (or already absent) is fine.
      })
    await runDSH(['plugin', '--profile', 'web', 'add', REPO_ROOT], home, spawnEnv)

    // Spawn `dsh web` against the REAL home (no DSH_HOME override). Bind
    // 0.0.0.0 so the server is reachable through the machine's LAN interface —
    // the browser must hit the LAN IP, not loopback.
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
    // The browser goes through the LAN interface (falling back to loopback only
    // when the machine has no non-internal IPv4 to advertise). Over plain HTTP
    // on a non-loopback address the origin is insecure — crypto.randomUUID is
    // undefined — so the injected polyfill actually runs; loopback is a secure
    // context where LAN-only bugs would never surface.
    browserUrl = lanUrlFromLine(readyLine) ?? baseUrl

    browser = await chromium.launch({ headless: process.platform !== 'darwin' })
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
    // Intentionally do NOT clean up the real profile: the source link persists
    // for the developer's daily use.
  })

  it('prints a boot line that embeds the grant URL', () => {
    expect(readyLine).toMatch(/^dsh web: http:\/\/127\.0\.0\.1:\d+\/\?web_token=/)
    expect(readyLine).toContain(`?web_token=${TOKEN}`)
    const lan = lanUrlFromLine(readyLine)
    if (lan !== undefined) expect(lan).toContain(`?web_token=${TOKEN}`)
  })

  it('enforces the token gate on every surface', async () => {
    await expectTokenGate(baseUrl, TOKEN)
  })

  it('boots the WebUI with the granted cookie without page errors', async () => {
    onTestFailed(async () => {
      // Failure evidence: a screenshot + page-state JSON, plus the frontend's
      // own errors and the host's stdout/stderr.
      saveFailureShot(page, 'remote-access-local').catch((error: unknown) => {
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
    // over the insecure LAN origin (the path that exercises the polyfill).
    await page.goto(browserUrl, { waitUntil: 'load', timeout: 90_000 })
    await page.waitForFunction(
      () => (document.querySelector('#root')?.children.length ?? 0) > 0,
      undefined,
      { timeout: 90_000 },
    )
    expect(pageErrors).toEqual([])
  }, 180_000)
})
