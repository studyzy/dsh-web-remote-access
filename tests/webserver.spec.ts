/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row, and every assertion observes the
 * user-visible HTTP surface of the running server (routing precedence, index
 * taps, fallback-seat semantics, per-request error containment, teardown).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '../src/webserver.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml with one webserver row, then boot it through the real Loader. */
async function loadComposition(port = 0, webToken?: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-webserver-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    ...(webToken === undefined ? [] : [`    webToken: ${JSON.stringify(webToken)}`]),
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status plus a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, body: (await response.text()).slice(0, 80) }
}

/** One raw HTTP GET (no redirect following, no cookie jar) returning the full head. */
async function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
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

/** Open one raw upgrade request and return after the handler writes its response. */
async function upgrade(port: number, path: string): Promise<ReturnType<typeof connect>> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  const [data] = await response as [Buffer]
  expect(String(data)).toContain('101 Switching Protocols')
  return socket
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('serves registered routes, index taps, and the fallback-seat semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const server = loaded.webServer
    expect(server).toBeInstanceOf(HttpServer)
    const port = server.port
    expect(port).toBeGreaterThan(0)

    // Routing precedence: exact beats prefix, longest prefix wins, a prefix
    // route answers its own path, and routes own their method handling
    // (POST reaches a registered prefix; 405 is fallback-only semantics).
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('EXACT') } })
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.register({ kind: 'prefix', path: '/api/deep', handler: (_req, res) => { res.writeHead(200); res.end('DEEP') } })
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })
    expect(await request(port, '/api/anything')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/deep/leaf')).toMatchObject({ status: 200, body: 'DEEP' })
    expect(await request(port, '/api')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/anything', { method: 'POST' })).toMatchObject({ status: 200, body: 'API' })

    // Fallback seat: 404 while unclaimed; the owner answers everything no
    // named route matches; index taps are the owner's to apply; the seat
    // admits exactly one owner and the disposer releases it.
    expect((await request(port, '/no/such/route')).status).toBe(404)
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    expect(server.applyIndexTaps('<head></head>')).toContain('__T__')
    const releaseFallback = server.registerFallback((req, res) => {
      // Decode like a real static server would — a malformed %-escape throws
      // here, probing the webserver's per-request error containment.
      decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(server.applyIndexTaps('<head></head><body>shell</body>'))
    })
    expect(() => server.registerFallback(() => {})).toThrow(/fallback already registered/)
    expect((await request(port, '/no/such/route')).body).toContain('__T__')
    untap()
    expect((await request(port, '/no/such/route')).body).not.toContain('__T__')
    expect((await request(port, '/no/such/route')).body).toContain('shell')

    // Per-request error containment: a malformed %-escape answers 400 and the
    // server keeps serving afterwards (no process-level failure path).
    expect((await request(port, '/%zz')).status).toBe(400)
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Duplicate (kind, path) is a misconfiguration and throws; the disposer
    // restores registrability (register/disposer symmetry).
    expect(() => server.register({ kind: 'exact', path: '/probe', handler: () => {} }))
      .toThrow(/duplicate exact route/)
    const disposeOnce = server.register({ kind: 'exact', path: '/once', handler: (_req, res) => { res.writeHead(200); res.end('ONCE') } })
    expect(await request(port, '/once')).toMatchObject({ status: 200, body: 'ONCE' })
    disposeOnce()
    expect((await request(port, '/once')).body).toContain('shell') // back to the fallback owner
    expect(() => server.register({ kind: 'exact', path: '/once', handler: () => {} })).not.toThrow()

    // Releasing the seat restores the unclaimed 404 and registrability.
    releaseFallback()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()

    // Upgrade routes match exact pathnames, reject duplicate ownership, and
    // become registrable again after disposal. The accepted socket stays open
    // so the teardown assertion also covers upgraded-connection ownership.
    let upgradedServerClosed = false
    const disposeUpgrade = server.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.once('close', () => { upgradedServerClosed = true })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} }))
      .toThrow(/duplicate upgrade route/)
    const upgraded = await upgrade(port, '/events?stream=mux')
    disposeUpgrade()
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} })).not.toThrow()

    // The webserver contains raw-socket errors even before an upgrade handler
    // has installed its protocol implementation.
    server.registerUpgrade({
      path: '/upgrade-error',
      handler: async (_req, socket) => {
        await Promise.resolve()
        socket.destroy(new Error('test upgrade transport failure'))
      },
    })
    const failedUpgrade = connect(port, '127.0.0.1')
    failedUpgrade.on('error', () => { /* The server-side reset is the fixture outcome. */ })
    await once(failedUpgrade, 'connect')
    const failedUpgradeClosed = once(failedUpgrade, 'close')
    failedUpgrade.write([
      'GET /upgrade-error HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      '',
      '',
    ].join('\r\n'))
    await failedUpgradeClosed
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Teardown closes both ordinary and upgraded sockets before it resolves.
    await loaded.fiber.dispose()
    expect(upgradedServerClosed).toBe(true)
    upgraded.destroy()
    await expect(request(port, '/probe')).rejects.toThrow()
  })

  it('fails the fiber when the port is already taken (fail-loud at activation)', { timeout: 60_000 }, async () => {
    const first = await loadComposition()
    const takenPort = first.webServer.port
    const firstRoot = root
    root = undefined // keep the first composition's files until the end

    let second: Context | undefined
    try {
      let failure: unknown
      try {
        await loadComposition(takenPort)
      } catch (error) {
        failure = error
      }
      second = context
      expect(String(failure)).toMatch(/failed to apply loader entry.*EADDRINUSE/)
    } finally {
      await second?.fiber.dispose()
      context = first
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = firstRoot
    }
  })
})

describe('webToken gate', () => {
  const TOKEN = '9mYik22Ajc1mvZZ3vNCU1o8njwn4jbeRLYNJH_0YW-o'

  it('is inert without a configured webToken (stock behavior)', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    expect(await rawRequest(port, '/anything')).toMatchObject({ status: 404 })
    await loaded.fiber.dispose()
  })

  it('denies every request without the cookie or a matching query token', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, TOKEN)
    const port = loaded.webServer.port
    const denied = await rawRequest(port, '/')
    expect(denied.status).toBe(401)
    expect(denied.body).toContain('unauthorized')
    expect((await rawRequest(port, `/?web_token=wrong`)).status).toBe(401)
    // Non-GET requests are never granted through the query: the grant flow is navigation only.
    const postStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `/?web_token=${TOKEN}`, method: 'POST' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
    expect(postStatus).toBe(401)
    await loaded.fiber.dispose()
  })

  it('grants a session cookie via ?web_token= on GET and redirects to the clean pathname', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, TOKEN)
    const port = loaded.webServer.port
    const granted = await rawRequest(port, `/?web_token=${TOKEN}`)
    expect(granted.status).toBe(302)
    expect(granted.headers.location).toBe('/')
    expect(granted.headers['set-cookie']).toContain('dsh_web_token=')
    expect(granted.headers['set-cookie']).toContain('HttpOnly')
    expect(granted.headers['set-cookie']).toContain('SameSite=Lax')
    const deep = await rawRequest(port, `/some/route?web_token=${TOKEN}`)
    expect(deep.status).toBe(302)
    expect(deep.headers.location).toBe('/some/route')
    await loaded.fiber.dispose()
  })

  it('serves requests that present the cookie', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, TOKEN)
    const port = loaded.webServer.port
    const first = await rawRequest(port, `/?web_token=${TOKEN}`)
    const cookie = first.headers['set-cookie'].split(';')[0] as string
    // With no fallback registered, a routed miss answers 404 — the 401 would
    // only appear if the gate still held the cookie-less request back.
    expect((await rawRequest(port, '/page', { Cookie: cookie })).status).toBe(404)
    await loaded.fiber.dispose()
  })

  it('presents token-authenticated /api requests to downstream handlers as loopback', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, TOKEN)
    const port = loaded.webServer.port
    const seen: { host?: string; origin?: string } = {}
    loaded.webServer.register({
      kind: 'prefix',
      path: '/api',
      handler: (req, res) => {
        seen.host = req.headers.host
        seen.origin = req.headers.origin
        res.writeHead(200)
        res.end()
      },
    })
    loaded.webServer.register({
      kind: 'exact',
      path: '/page',
      handler: (req, res) => {
        seen.host = req.headers.host
        res.writeHead(200)
        res.end()
      },
    })
    const first = await rawRequest(port, `/?web_token=${TOKEN}`)
    const cookie = first.headers['set-cookie'].split(';')[0] as string
    // A LAN Host arriving with the cookie is shown to the route handler as
    // loopback, so the harness's loopback-only privileged-method fence admits it.
    await rawRequest(port, '/api/settings.describe', {
      Cookie: cookie,
      Host: `9.134.212.96:${String(port)}`,
      Origin: `http://9.134.212.96:${String(port)}`,
    })
    expect(seen.host).toBe(`127.0.0.1:${String(port)}`)
    expect(seen.origin).toBe(`http://127.0.0.1:${String(port)}`)
    // Non-/api paths are not rewritten.
    seen.host = undefined
    await rawRequest(port, '/page', { Cookie: cookie, Host: `9.134.212.96:${String(port)}` })
    expect(seen.host).toBe(`9.134.212.96:${String(port)}`)
    // A cookie-less /api request is denied by the gate before any rewrite.
    const denied = await rawRequest(port, '/api/settings.describe', { Host: `9.134.212.96:${String(port)}` })
    expect(denied.status).toBe(401)
    await loaded.fiber.dispose()
  })

  it('serves the PWA manifest without a cookie (public static metadata)', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, TOKEN)
    const port = loaded.webServer.port
    // No fallback registered: a gate-passed miss answers 404, never the gate's
    // 401 — that is what proves the manifest exemption let the request through.
    expect((await rawRequest(port, '/manifest.webmanifest')).status).toBe(404)
    // The exemption is GET/HEAD only; other methods stay gated.
    const postStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/manifest.webmanifest', method: 'POST' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
    expect(postStatus).toBe(401)
    await loaded.fiber.dispose()
  })

  it('answers 401 on upgrades without the cookie and admits them with it', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, TOKEN)
    const port = loaded.webServer.port
    loaded.webServer.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    // No cookie: the gate answers 401 — never a bare socket close — so the
    // browser reports a clear code instead of a mysterious handshake reset.
    const denied = connect(port, '127.0.0.1')
    denied.on('error', () => { /* server-side reset fixture outcome. */ })
    await once(denied, 'connect')
    const deniedResponse = once(denied, 'data')
    denied.write([
      'GET /events HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      '',
      '',
    ].join('\r\n'))
    const [deniedData] = await deniedResponse as [Buffer]
    expect(String(deniedData)).toContain('401 Unauthorized')
    // With the cookie: negotiation proceeds.
    const admitted = connect(port, '127.0.0.1')
    await once(admitted, 'connect')
    const response = once(admitted, 'data')
    admitted.write([
      'GET /events HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      `Cookie: dsh_web_token=${TOKEN}`,
      '',
      '',
    ].join('\r\n'))
    const [data] = await response as [Buffer]
    expect(String(data)).toContain('101 Switching Protocols')
    admitted.destroy()
    await loaded.fiber.dispose()
  })

  it('presents token-authenticated /api upgrades to downstream handlers as loopback', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, TOKEN)
    const port = loaded.webServer.port
    const seen: { host?: string; origin?: string } = {}
    loaded.webServer.registerUpgrade({
      path: '/api/events.mux',
      handler: (req, socket) => {
        seen.host = req.headers.host
        seen.origin = req.headers.origin
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    loaded.webServer.registerUpgrade({
      path: '/other',
      handler: (req, socket) => {
        seen.host = req.headers.host
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    const first = await rawRequest(port, `/?web_token=${TOKEN}`)
    const cookie = first.headers['set-cookie'].split(';')[0] as string
    // A LAN Host arriving with the cookie is shown to the upgrade handler as
    // loopback — the same rewrite the HTTP /api path applies — so the
    // harness's browser-trust fence admits the WebSocket downlink.
    const admitted = connect(port, '127.0.0.1')
    await once(admitted, 'connect')
    const response = once(admitted, 'data')
    admitted.write([
      'GET /api/events.mux HTTP/1.1',
      `Host: 9.134.212.96:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      `Origin: http://9.134.212.96:${String(port)}`,
      `Cookie: ${cookie}`,
      '',
      '',
    ].join('\r\n'))
    const [data] = await response as [Buffer]
    expect(String(data)).toContain('101 Switching Protocols')
    expect(seen.host).toBe(`127.0.0.1:${String(port)}`)
    expect(seen.origin).toBe(`http://127.0.0.1:${String(port)}`)
    // Non-/api upgrade paths are not rewritten.
    seen.host = undefined
    const plain = connect(port, '127.0.0.1')
    await once(plain, 'connect')
    const plainResponse = once(plain, 'data')
    plain.write([
      'GET /other HTTP/1.1',
      `Host: 9.134.212.96:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      `Cookie: ${cookie}`,
      '',
      '',
    ].join('\r\n'))
    const [plainData] = await plainResponse as [Buffer]
    expect(String(plainData)).toContain('101 Switching Protocols')
    expect(seen.host).toBe(`9.134.212.96:${String(port)}`)
    admitted.destroy()
    plain.destroy()
    await loaded.fiber.dispose()
  })
})
