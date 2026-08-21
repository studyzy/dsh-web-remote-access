/**
 * @studyzy/dsh-web-remote-access/webserver — a fork of `@deepseek-ai/dsh-host-webserver` that
 * adds an optional `webToken` access gate. Everything else (HTTP and upgrade
 * route registries, structured index injections plus raw transform taps, the
 * single fallback seat) keeps the upstream contract so the composition
 * resolves `ctx.webServer` unchanged.
 * The gate is transport-level only: when `webToken` is set, every request must
 * present it as the `dsh_web_token` cookie; the `?web_token=` query parameter
 * grants a session cookie once (302 to the clean pathname). Upgrades (the
 * WebSocket downlink) require the cookie directly, since the browser WS
 * handshake cannot carry the query flow.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { renderIndexInjections, type IndexInjection } from './injections.js'

export { renderIndexInjections } from './injections.js'
export type { IndexInjection, IndexInjectionPlacement } from './injections.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  interface Events {
    /**
     * Collect the structured index injection table. Emitted on every index
     * render; listeners push their current rows, so a row's data is read fresh
     * at emit time. Upstream 0.1.1 contract: the client-modules boot table and
     * the theme preference reach the served page through this event.
     * @param table - Mutable row table; listeners append in activation order.
     * @mode emit
     */
    'webserver/index-inject'(table: IndexInjection[]): void
  }
}

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** Gateway config: the listen address and the optional access token. */
export interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Access token. When non-empty, every request must present it as the
   * `dsh_web_token` cookie, granted once by opening any URL with the
   * `?web_token=` query parameter. Empty disables the gate.
   */
  webToken: string
}

/** Cookie name carrying the granted web token; a session cookie, cleared when the browser closes. */
const WEB_TOKEN_COOKIE = 'dsh_web_token'
/** Query parameter that grants the first access and sets the session cookie. */
const WEB_TOKEN_QUERY = 'web_token'
/** Cookie attributes: HttpOnly (never readable by page scripts) and Lax (keeps the API same-origin). */
const WEB_TOKEN_COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Lax'

/**
 * Constant-time token comparison. Both sides are hashed first so a length
 * mismatch never short-circuits and never leaks the expected token length.
 */
function tokenEquals(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false
  const a = createHash('sha256').update(candidate).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** The `dsh_web_token` cookie value, or undefined when absent. */
function cookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === WEB_TOKEN_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** The `web_token` query value, or undefined when absent. */
function queryToken(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? '/', 'http://x').searchParams.get(WEB_TOKEN_QUERY) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Public static paths served without the token. Browsers fetch the PWA
 * manifest (`<link rel="manifest">`) without the session cookie — unlike every
 * other same-origin subresource — so gating it would 401 the installability
 * check while protecting nothing: the manifest is public metadata shipped with
 * the dist. GET/HEAD only; the path never reaches the /api bridge.
 */
const PUBLIC_STATIC_PATHS = new Set(['/manifest.webmanifest'])

/**
 * Enforce the token gate on one HTTP request.
 * @param req - the incoming request.
 * @param res - the outgoing response.
 * @param expected - the configured web token.
 * @returns `'authorized'` when the request may continue to route matching,
 * or `'handled'` when the gate already answered (302 grant or 401 denial).
 */
function webTokenGate(req: IncomingMessage, res: ServerResponse, expected: string): 'authorized' | 'handled' {
  if (tokenEquals(cookieToken(req), expected)) return 'authorized'
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_STATIC_PATHS.has(pathname)) return 'authorized'
  // The query flow only makes sense for navigation (GET/HEAD): it grants a
  // session cookie and redirects to the clean pathname so the token leaves the
  // address bar and the browser history follows the cookie from then on.
  if ((req.method === 'GET' || req.method === 'HEAD') && tokenEquals(queryToken(req), expected)) {
    res.writeHead(302, {
      location: pathname,
      'set-cookie': `${WEB_TOKEN_COOKIE}=${expected}; ${WEB_TOKEN_COOKIE_ATTRIBUTES}`,
    })
    res.end()
    return 'handled'
  }
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('unauthorized: open the URL printed by dsh web, which carries the ?web_token= grant')
  return 'handled'
}

/**
 * The browser HTTP carrier service. Activation listens immediately. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers. A listen failure rejects
 * initialization, and the boot process reports the failed fiber.
 */
export class WebServer extends Service {
  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(),
    webToken: z.string().default(''),
  })

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private readonly upgradedSockets = new Set<Duplex>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRoute['handler'] | undefined
  private server!: Server
  private listenedPort!: number

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'webServer')
  }

  /** The listening port (the OS-assigned value when config.port is 0). */
  get port(): number {
    return this.listenedPort
  }

  /** The configured bind host (the loopback or all-interfaces literal). */
  get host(): Config['host'] {
    return this.config.host
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns are
   * a composition-level contract, so a collision is a misconfiguration.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Register an exact-path HTTP upgrade route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   * @param route - pathname and handler owning negotiation plus socket use.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * Claim the fallback seat: the handler answering every request no named
   * route matches (the SPA dist server in the shipped Web composition). One
   * owner only — a second registration throws, because two fallbacks cannot
   * compose.
   * @param handler - owns the full response lifecycle of unmatched requests.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /**
   * Register an index.html transform, applied by the fallback owner to every
   * index response ({@link applyIndexTaps}) in registration order.
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
  async [Service.init](): Promise<void> {
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      // The token gate runs before route matching so it covers every surface:
      // the SPA fallback, the /api RPC bridge, and every other registered route.
      if (this.config.webToken && webTokenGate(req, res, this.config.webToken) !== 'authorized') return
      /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
      requests; the field is only optional on the client-side IncomingMessage type */
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      this.authorizeApiAsLoopback(req, rawPath)
      const route = this.match(rawPath)
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      const fallback = this.fallback
      if (fallback === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      await fallback(req, res)
    }
    // Last-resort guard: handle() rejecting would otherwise be an unhandled
    // rejection killing the process on one malformed request (bad %-escape,
    // client dropping mid-body). Per-request failures log and answer 400 —
    // never a process exit.
    this.server = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(400)
        res.end()
      })
    })
    this.server.on('upgrade', (req, socket, head) => {
      const onError = (error: Error): void => {
        this.ctx.logger.warn(error)
        socket.destroy()
      }
      socket.on('error', onError)
      socket.once('close', () => {
        socket.off('error', onError)
        this.upgradedSockets.delete(socket)
      })
      // The upgrade path requires the cookie directly: the browser WebSocket
      // handshake cannot carry the ?web_token= query flow, but it does send
      // the cookie granted by the initial page open. A denied handshake
      // answers 401 — never a bare socket close — so the browser reports a
      // clear code and the client's reconnect loop succeeds once a session
      // cookie exists.
      if (this.config.webToken && !tokenEquals(cookieToken(req), this.config.webToken)) {
        socket.end([
          'HTTP/1.1 401 Unauthorized',
          'Connection: close',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Length: 11',
          '',
          'unauthorized',
        ].join('\r\n'))
        return
      }
      let route: WebUpgradeRoute | undefined
      try {
        /* v8 ignore next -- node:http always sets url on server requests. */
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        this.authorizeApiAsLoopback(req, pathname)
        route = this.upgrades.get(pathname)
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
        return
      }
      if (route === undefined) {
        socket.destroy()
        return
      }
      this.upgradedSockets.add(socket)
      try {
        Promise.resolve(route.handler(req, socket, head)).catch((error: unknown) => {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
        })
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      }
    })

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject)
        this.server.on('error', (err) => { this.ctx.logger.error(err) })
        this.listenedPort = (this.server.address() as AddressInfo).port
        resolve()
      })
    })

    // Node does not include upgraded sockets in closeAllConnections(). The service
    // owns them with the other connections, so it tracks and destroys them explicitly.
    this.ctx.effect(() => async () => {
      const serverClosed = new Promise<void>((resolve) => {
        this.server.close(() => { resolve() })
      })
      this.server.closeAllConnections()
      const upgradedClosed = [...this.upgradedSockets].map(socket => new Promise<void>((resolve) => {
        socket.once('close', () => { resolve() })
        socket.destroy()
      }))
      await Promise.all([serverClosed, ...upgradedClosed])
    }, 'webServer.listen')
  }

  /**
   * Present a token-authenticated `/api` request to the downstream trust fence
   * as a loopback authority instead of the LAN address it arrived on. The
   * harness pins the configuration plane (settings/credentials/agentPreset,
   * host.* , llm.discoverModels) to loopback "until a real authentication layer
   * exists" (client-connection PRIVILEGED_METHODS). The token gate IS that
   * layer: every `/api` request here passed cookie authentication, so the
   * fence may see a loopback authority. The cross-site defenses
   * (Origin/Sec-Fetch-Site) still run — the gate has already admitted only
   * cookie-bearing same-site clients. Both the HTTP and the upgrade path
   * apply it: the browser WebSocket handshake sends the same cookie and names
   * the same LAN authority in its Host header.
   * @param req - the authenticated request.
   * @param pathname - the request pathname, already parsed.
   */
  private authorizeApiAsLoopback(req: IncomingMessage, pathname: string): void {
    if (!this.config.webToken || !pathname.startsWith('/api/')) return
    const authority = `127.0.0.1:${String(this.listenedPort)}`
    req.headers.host = authority
    if (req.headers.origin !== undefined) req.headers.origin = `http://${authority}`
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * Run an index.html body through the registered taps in registration order
   * — called by the fallback owner on every index response it renders.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * Gather the structured injection table: one `webserver/index-inject` emit,
   * every subscriber pushes its current rows. Fresh per call, so subscribers
   * read live state (module graph, theme preference) at emit time.
   * @returns rows in subscriber activation order.
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * Render one index.html body: the structured injection table first, then
   * the raw `tapIndex` transforms over the result. This is the upstream 0.1.1
   * contract the `frontend-static` fallback owner calls on every index
   * response — without it the served page would reject with a 400.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  renderIndex(html: string): string {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }
}

export default WebServer
