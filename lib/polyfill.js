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
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export const name = 'web-token-polyfill';
/** Services required before the tap can register. */
export const inject = ['webServer'];
export const Config = z.object({
    webToken: z.string().default(''),
});
/** RFC 4122 v4 UUID from `crypto.getRandomValues`, exposed on insecure origins. */
const POLYFILL_SCRIPT = `<script>
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function () {
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = '';
    for (var i = 0; i < 16; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  };
}
</script>`;
/**
 * Register the index tap that injects the polyfill before `</head>`, so it
 * runs before any client bundle executes.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
    if (config.webToken === '')
        return;
    ctx.webServer.tapIndex(html => html.replace('</head>', `${POLYFILL_SCRIPT}</head>`));
}
