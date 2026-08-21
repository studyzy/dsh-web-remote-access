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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type IndexInjection } from './injections.js';
export { renderIndexInjections } from './injections.js';
export type { IndexInjection, IndexInjectionPlacement } from './injections.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: WebServer;
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
        'webserver/index-inject'(table: IndexInjection[]): void;
    }
}
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';
/** One named route registration. */
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns protocol negotiation and the upgraded socket after dispatch. */
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
/** Gateway config: the listen address and the optional access token. */
export interface Config {
    /** Listen host; the two supported values are loopback and all-interfaces. */
    host: '127.0.0.1' | '0.0.0.0';
    /** Listen port; zero requests an OS-assigned port. */
    port: number;
    /**
     * Access token. When non-empty, every request must present it as the
     * `dsh_web_token` cookie, granted once by opening any URL with the
     * `?web_token=` query parameter. Empty disables the gate.
     */
    webToken: string;
}
/**
 * The browser HTTP carrier service. Activation listens immediately. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers. A listen failure rejects
 * initialization, and the boot process reports the failed fiber.
 */
export declare class WebServer extends Service {
    private config;
    static Config: z<Config>;
    private readonly exact;
    private readonly prefixes;
    private readonly upgrades;
    private readonly upgradedSockets;
    private readonly indexTaps;
    private fallback;
    private server;
    private listenedPort;
    constructor(ctx: Context, config: Config);
    /** The listening port (the OS-assigned value when config.port is 0). */
    get port(): number;
    /** The configured bind host (the loopback or all-interfaces literal). */
    get host(): Config['host'];
    /**
     * Register a named route. Duplicate (kind, path) throws — route patterns are
     * a composition-level contract, so a collision is a misconfiguration.
     * @param route - kind, path, and the owning handler.
     * @returns the disposer removing the route.
     */
    register(route: WebRoute): () => void;
    /**
     * Register an exact-path HTTP upgrade route. Duplicate paths throw because
     * one socket can have only one protocol owner.
     * @param route - pathname and handler owning negotiation plus socket use.
     * @returns the disposer removing the route.
     */
    registerUpgrade(route: WebUpgradeRoute): () => void;
    /**
     * Claim the fallback seat: the handler answering every request no named
     * route matches (the SPA dist server in the shipped Web composition). One
     * owner only — a second registration throws, because two fallbacks cannot
     * compose.
     * @param handler - owns the full response lifecycle of unmatched requests.
     * @returns the disposer releasing the seat.
     */
    registerFallback(handler: WebRoute['handler']): () => void;
    /**
     * Register an index.html transform, applied by the fallback owner to every
     * index response ({@link applyIndexTaps}) in registration order.
     * @param transform - pure html-to-html function.
     * @returns the disposer removing the transform.
     */
    tapIndex(transform: (html: string) => string): () => void;
    /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
    [Service.init](): Promise<void>;
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
    private authorizeApiAsLoopback;
    /** Longest-prefix-wins over the prefix table after an exact-table miss. */
    private match;
    /**
     * Run an index.html body through the registered taps in registration order
     * — called by the fallback owner on every index response it renders.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    applyIndexTaps(html: string): string;
    /**
     * Gather the structured injection table: one `webserver/index-inject` emit,
     * every subscriber pushes its current rows. Fresh per call, so subscribers
     * read live state (module graph, theme preference) at emit time.
     * @returns rows in subscriber activation order.
     */
    collectIndexInjections(): IndexInjection[];
    /**
     * Render one index.html body: the structured injection table first, then
     * the raw `tapIndex` transforms over the result. This is the upstream 0.1.1
     * contract the `frontend-static` fallback owner calls on every index
     * response — without it the served page would reject with a 400.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    renderIndex(html: string): string;
}
export default WebServer;
