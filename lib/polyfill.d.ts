/**
 * @studyzy/dsh-web-remote-access/polyfill — index-tap injection of a `crypto.randomUUID`
 * polyfill. `crypto.randomUUID` is a secure-context-only Web API: over plain
 * HTTP on a non-loopback address — exactly the remote access this bundle
 * enables — it is `undefined`, while `crypto.getRandomValues` (which insecure
 * origins do expose) works. Client bundles that call `crypto.randomUUID`
 * (RPC id minting, draft-attachment ids) would otherwise throw on every such
 * call, which also breaks the WebSocket readiness handshake. The injected
 * script is a no-op where the API already exists (loopback/HTTPS).
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "web-remote-polyfill";
/** Services required before the tap can register. */
export declare const inject: string[];
/** Plugin config: whether this bind serves beyond the local machine. */
export interface Config {
    /** True when the bound address is not loopback; a loopback bind needs no tap. */
    remote: boolean;
}
export declare const Config: z<Config>;
/**
 * Register the index tap that injects the polyfill before `</head>`, so it
 * runs before any client bundle executes.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
