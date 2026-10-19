/**
 * @studyzy/dsh-web-remote-access/url — the web URL line printer. Replaces the
 * stock web-app URL print (which the bundle patch disables) so the line names
 * the address the server actually bound, including the harness launch token
 * (`?token=`) whose first-open exchange mints the session cookie the Web UI
 * and the `/api` bridge require.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "web-token-url";
/** Services required before the URL can be read. */
export declare const inject: string[];
/** Plugin config: print the URL line. */
export interface Config {
    /** Print the URL line on activation; a non-interactive layer can turn it off. */
    printUrl: boolean;
}
export declare const Config: z<Config>;
/**
 * Print the web URL line, waiting for Loader settlement when one exists so a
 * supervisor (or a keyless smoke) can RPC as soon as the line appears. A
 * failed or torn-down boot prints nothing.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
