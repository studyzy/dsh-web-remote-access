/**
 * @studyzy/dsh-web-remote-access/url — the web URL line printer. Replaces the
 * stock web-app URL print (which the bundle patch disables) so the line names
 * the address the server actually bound, including the harness launch token
 * (`?token=`) whose first-open exchange mints the session cookie the Web UI
 * and the `/api` bridge require.
 */
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export const name = 'web-token-url';
/** Services required before the URL can be read. */
export const inject = ['webStartup', 'webServer'];
export const Config = z.object({
    printUrl: z.boolean().default(true),
});
/** The host a loopback bind defaults to, matching the webserver row's own default. */
const DEFAULT_HOST = '127.0.0.1';
/**
 * Print the web URL line, waiting for Loader settlement when one exists so a
 * supervisor (or a keyless smoke) can RPC as soon as the line appears. A
 * failed or torn-down boot prints nothing.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
    if (!config.printUrl)
        return;
    const printUrl = () => {
        const server = ctx.get('webServer');
        if (server === undefined)
            return;
        const connection = ctx.get('connection');
        // The launch token is the one grant in the line: its exchange mints the
        // harness session cookie, so the printed URL opens straight into the UI.
        const printable = `http://${server.host}:${String(server.port)}`;
        const url = connection === undefined ? printable : connection.authenticatedUrl(printable);
        console.log(`dsh web: ${url}`);
    };
    const settled = ctx.get('loader')?.await();
    if (settled === undefined)
        printUrl();
    else {
        void settled.then(() => {
            if (ctx.get('webServer') !== undefined)
                printUrl();
        }, () => { });
    }
}
