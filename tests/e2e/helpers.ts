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

/** Ready line printed by the bundle's URL plugin: `dsh web: <local> (LAN: <lan>)`. */
const DSH_READY_LINE = /^dsh web: (http:\/\/[^\s]+)/
/** Optional LAN URL fragment appended when bound to 0.0.0.0 and a LAN IPv4 exists. */
const DSH_LAN_URL = /\(LAN: (http:\/\/[^\s]+)\)/

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
 * The line is the bundle's own URL print (`dsh web: http://127.0.0.1:PORT/?web_token=... (LAN: ...)`)
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
      const match = /dsh web: http:\/\/[^\s]+/.exec(out)
      if (match !== null) {
        clearTimeout(timer)
        resolve(out.split('\n').find(line => line.startsWith('dsh web:')) ?? match[0])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
  })
}

/** Extract the local loopback URL from a ready line (always present). */
export function localUrlFromLine(line: string): string {
  const match = DSH_READY_LINE.exec(line)
  if (match === null) throw new Error(`ready line has no local URL: ${line}`)
  return match[1] ?? ''
}

/** Extract the advertised LAN URL from a ready line, if one was printed. */
export function lanUrlFromLine(line: string): string | undefined {
  return DSH_LAN_URL.exec(line)?.[1]
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

/** Send one HTTP Upgrade request and return the first response bytes read. */
export function upgradeOnce(baseUrl: string, path: string): Promise<string> {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.once('data', (data: Buffer) => {
        socket.destroy()
        resolve(String(data))
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
 * Assert the full token-gate contract against a live server. Shared by the CI
 * and local e2e lanes so a change to the gate's behavior is verified in both
 * environments, not just one.
 */
export async function expectTokenGate(baseUrl: string, token: string): Promise<void> {
  // No cookie → 401 on the SPA fallback, the /api RPC bridge, and a WebSocket
  // upgrade (the upgrade answers 401, never a bare socket close).
  expect((await rawRequest(baseUrl, '/')).status).toBe(401)
  expect((await rawRequest(baseUrl, '/')).body).toContain('unauthorized')
  expect((await rawRequest(baseUrl, '/api/settings.describe')).status).toBe(401)
  expect(await upgradeOnce(baseUrl, '/api/events.mux')).toContain('401 Unauthorized')

  // A wrong query token stays denied; the grant flow is navigation (GET) only.
  expect((await rawRequest(baseUrl, '/?web_token=wrong')).status).toBe(401)
  expect((await rawRequest(baseUrl, '/?web_token=wrong')).body).toContain('unauthorized')
  expect((await rawRequest(baseUrl, `/?web_token=${token}`, { method: 'POST' })).status).toBe(401)

  // Correct query token on GET → 302 to the clean pathname + session cookie.
  const granted = await rawRequest(baseUrl, `/?web_token=${token}`)
  expect(granted.status).toBe(302)
  expect(granted.headers.location).toBe('/')
  expect(granted.headers['set-cookie']).toContain(`dsh_web_token=${token}`)
  expect(granted.headers['set-cookie']).toContain('HttpOnly')
  expect(granted.headers['set-cookie']).toContain('SameSite=Lax')

  // The cookie passes the gate: the SPA index is served with the randomUUID
  // polyfill injected (the insecure-origin guard this bundle ships).
  const cookie = granted.headers['set-cookie'].split(';')[0] as string
  const index = await rawRequest(baseUrl, '/', { headers: { Cookie: cookie } })
  expect(index.status).toBe(200)
  expect(index.headers['content-type']).toContain('text/html')
  expect(index.body).toContain('<div id="root">')
  expect(index.body).toContain('crypto.randomUUID')

  // The PWA manifest stays public (GET without cookie → 200) so the
  // installability probe is not gated while everything else is protected.
  expect((await rawRequest(baseUrl, '/manifest.webmanifest')).status).toBe(200)
}
