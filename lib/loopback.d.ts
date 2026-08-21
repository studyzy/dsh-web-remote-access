/**
 * @studyzy/dsh-web-remote-access/loopback — index-tap injection that makes an
 * authenticated remote browser present the loopback view to the client runtime.
 *
 * The harness derives `ctx.connection.isLoopback` purely from the page's
 * `location.hostname` (`dsh-client-connection` client bundle). A browser on a
 * LAN address is therefore non-loopback, and the settings surface degrades to a
 * process-local "memory" scope whose mirror never reads from the host: the
 * Models page reports "settings are unavailable in this browser" and the
 * Plugins page renders empty — even though the token gate already authenticated
 * the client, and this bundle's webserver rewrites `/api` authority to loopback
 * so the privileged RPCs (`settings.describe`, `llm.providers`,
 * `credentials.describe`, …) would all succeed.
 *
 * The tap injects a script before `</head>` that intercepts the client module
 * loader and wraps the `@deepseek-ai/dsh-client-connection` plugin factory. When
 * the plugin provides its `connection` handle, the script flips `isLoopback` to
 * true, so the settings mirror runs in "host" persistence like a loopback
 * client. Inert where the client is genuinely on loopback (localhost / 127/8 —
 * the value is already true) and a no-op when the loader facade is absent.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "web-token-loopback";
/** Services required before the tap can register. */
export declare const inject: string[];
/** Plugin config: the web token; empty disables the tap. */
export interface Config {
    /** The web token; when set, the served index gets the isLoopback override. */
    webToken: string;
}
export declare const Config: z<Config>;
/**
 * Register the index tap that injects the loopback script before `</head>`, so
 * it runs ahead of the client module system boot.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
