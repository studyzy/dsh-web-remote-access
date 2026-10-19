/**
 * Shared plumbing for the browser e2e lane: pnpm≥10 resolution, free-port
 * probing, the `dsh web` ready-line wait, raw HTTP/upgrade probes against the
 * running server, and failure evidence.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer, connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { expect } from 'vitest'

/** Ready line printed by the bundle's URL plugin: `dsh web: <url>`. */
const DSH_READY_LINE = /^dsh web: (http:\/\/[^\s]+)/

/**
 * Directory on PATH whose `pnpm` dsh will resolve to. The vitest process is
 * itself launched by `pnpm run`, which pins PATH to this repo's package-manager
 * (pnpm@9 in CI) — and pnpm 9 rejects `pnpm add` to a workspace root, so dsh's
 * own `pnpm` would fail. Find a pnpm ≥10 (corepack cache on Linux and macOS)
 * and prepend its bin dir to the spawned env's PATH so dsh installs cleanly.
 * Returns '' to leave PATH alone when pnpm ≥10 is already first.
 */
export function resolvePnpmBinDir(): string {
  // If the current PATH's pnpm is already ≥10, nothing to do.
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
  const current = (probe.stdout ?? '').trim()
  if (probe.status === 0 && /^(10|[1-9]\d)\./.test(current)) return ''
  // Otherwise search the corepack cache for the newest 10.x and prepend it.
  const roots = [
    join(homedir(), '.local/share/pnpm/.tools/pnpm'), // Linux / GitHub Actions
    join(homedir(), 'Library/pnpm/.tools/pnpm'),      // macOS
  ]
  let best = ''
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const version of readdirSync(root)) {
      if (!/^10\./.test(version)) continue
      const bin = join(root, version, 'bin')
      if (existsSync(bin)) best = bin
    }
  }
  // Fall back to npm's global install (e.g. `npm install -g pnpm@10`).
  if (best === '') {
    const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
    const npmGlobalNodeModules = (npmRoot.stdout ?? '').trim()
    if (npmGlobalNodeModules !== '') {
      const npmGlobalPnpmBin = join(npmGlobalNodeModules, 'pnpm', 'bin')
      if (existsSync(npmGlobalPnpmBin)) best = npmGlobalPnpmBin
    }
  }
  return best
}

/** OS-assigned free port, released before use (the spawned `dsh web` needs a concrete --port). */
export function probeFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('port probe returned no address')) })
        return
      }
      probe.close(() => { resolvePort(address.port) })
    })
  })
}

/**
 * Resolve once `dsh web` prints its listening line and return the full line.
 * The line is the bundle's own URL print (`dsh web: http://<bound>:<port>/?token=...`)
 * and is asserted by the test — so the raw line, not a parsed URL, is returned.
 */
export function waitForReadyLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => {
      reject(new Error(`dsh web not ready in 90s; output:\n${out}`))
    }, 90_000)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      // The harness itself prints a `dsh web: listening on ...` notice; only
      // the bundle's URL line names an http:// URL, so match on that.
      const line = out.split('\n').find(candidate => /^dsh web: http:\/\/\S+/.test(candidate))
      if (line !== undefined) {
        clearTimeout(timer)
        resolve(line.trim())
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
  })
}

/** Extract the printed URL from a ready line (the address the server bound). */
export function printedUrlFromLine(line: string): string {
  const match = DSH_READY_LINE.exec(line)
  if (match === null) throw new Error(`ready line has no URL: ${line}`)
  return match[1] ?? ''
}

/**
 * Extract the harness launch token (`?token=`) from a ready line, if the host
 * printed one. Since dsh 0.2.x the harness mints its own session cookie from
 * that token and gates the index and the `/api` bridge with it.
 */
export function launchTokenFromLine(line: string): string | undefined {
  const url = DSH_READY_LINE.exec(line)?.[1]
  return url === undefined ? undefined : new URL(url).searchParams.get('token') ?? undefined
}

/** One raw HTTP request (no redirect following, no cookie jar) returning status, headers and body. */
export async function rawRequest(
  baseUrl: string,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const url = new URL(path, baseUrl)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: init.headers,
    }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += String(chunk) })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: Object.fromEntries(
          Object.entries(res.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : String(value),
          ]),
        ),
        body,
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Send one HTTP Upgrade request and return the first response bytes read.
 * Resolves with '' when the server closes without answering (an unknown
 * upgrade path is destroyed, never answered) so a probe can never hang.
 */
export function upgradeOnce(baseUrl: string, path: string): Promise<string> {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname)
    let received = ''
    const finish = (): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(received)
    }
    const timer = setTimeout(finish, 15_000)
    socket.once('error', reject)
    socket.once('close', finish)
    socket.once('connect', () => {
      socket.once('data', (data: Buffer) => {
        received += String(data)
        finish()
      })
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        'Connection: Upgrade',
        'Upgrade: dsh-test',
        '',
        '',
      ].join('\r\n'))
    })
  })
}

/** Failure evidence goes to the gitignored .artifacts/. */
export async function saveFailureShot(page: Page, name: string): Promise<void> {
  const dir = fileURLToPath(new URL('../../.artifacts', import.meta.url))
  mkdirSync(dir, { recursive: true })
  try {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
    const info = await page.evaluate(() => {
      const describe = (el: Element): string => {
        const role = el.getAttribute('role')
        const aria = el.getAttribute('aria-label')
        const text = (el.textContent ?? '').trim().slice(0, 80)
        return `[${role ?? el.tagName.toLowerCase()} aria-label=${aria ?? ''}] "${text}"`
      }
      const dialogs = [...document.querySelectorAll('[role="dialog"],[role="menu"]')].map(describe)
      const buttons = [...document.querySelectorAll('button[aria-haspopup]')].map(describe)
      const textareas = [...document.querySelectorAll('textarea')].map(describe)
      return { dialogs, buttons, textareas }
    })
    await import('node:fs/promises').then(fs =>
      fs.writeFile(`${dir}/${name}.json`, JSON.stringify(info, null, 2)))
  } catch {
    // Best-effort evidence: a dead page at failure time must not mask the real assertion error.
  }
}

/** Spawn `dsh <args...>` inheriting stdout/stderr and resolve on exit (non-zero rejects). */
export async function runDSH(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('dsh', args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`dsh ${args.join(' ')} failed (exit ${code})`))
    })
    child.once('error', reject)
  })
}

/**
 * Assert the remote-access contract against a live server: every surface
 * answers 401 without the harness session cookie, the launch-token exchange
 * grants it, and the SPA index is served with the randomUUID polyfill. Shared
 * by the CI and local e2e lanes so a change is verified in both environments.
 */
export async function expectRemoteAccess(baseUrl: string, launchToken: string): Promise<void> {
  // No cookie → 401 on the SPA fallback, the /api RPC bridge, and a WebSocket
  // upgrade (the upgrade answers 401, never a bare socket close).
  expect((await rawRequest(baseUrl, '/')).status).toBe(401)
  expect((await rawRequest(baseUrl, '/api/settings.describe')).status).toBe(401)
  expect(await upgradeOnce(baseUrl, '/api/remote.mux')).toContain('401 Unauthorized')

  // The launch-token exchange mints the authority-bound session cookie.
  const granted = await rawRequest(baseUrl, `/?token=${launchToken}`)
  expect(granted.status).toBe(303)
  expect(granted.headers['set-cookie']).toContain('dsh-auth-')
  const cookie = granted.headers['set-cookie']
    .split(',')
    .map(part => part.split(';')[0].trim())
    .filter(part => part.startsWith('dsh-auth-'))
    .join('; ')

  // The cookie passes the harness: the SPA index is served with the randomUUID
  // polyfill injected (the insecure-origin guard this bundle ships), and /api
  // reaches the bridge instead of the authentication fence.
  const index = await rawRequest(baseUrl, '/', { headers: { Cookie: cookie } })
  expect(index.status).toBe(200)
  expect(index.headers['content-type']).toContain('text/html')
  expect(index.body).toContain('<div id="root">')
  expect(index.body).toContain('crypto.randomUUID')

  // The PWA manifest stays public (GET without cookie → 200) so the
  // installability probe is not gated.
  expect((await rawRequest(baseUrl, '/manifest.webmanifest')).status).toBe(200)
}
