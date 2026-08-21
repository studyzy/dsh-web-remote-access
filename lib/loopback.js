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
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export const name = 'web-token-loopback';
/** Services required before the tap can register. */
export const inject = ['webServer'];
export const Config = z.object({
    webToken: z.string().default(''),
});
/**
 * Injected script. Runs after the boot manifest created `window.__ModuleLoader__`
 * (placed at the top of `<head>`) and before the deferred entry module boot.
 * It wraps the loader's `create` so the module system's `register` intercepts
 * the `@deepseek-ai/dsh-client-connection` bundle and wraps its factory. The
 * wrapped factory then wraps the plugin's `apply`, shadowing `ctx.provide` so
 * the provided `connection` handle is flipped to `isLoopback: true` at the
 * moment of provision — before any consumer (the settings UI) reads it.
 */
const LOOPBACK_SCRIPT = `<script>
(function () {
  var CONNECTION_ID = '@deepseek-ai/dsh-client-connection'
  function wrapFactory(factory) {
    return function (require) {
      var module = factory(require)
      var apply = module && module.apply
      if (typeof apply !== 'function') return module
      module.apply = function (ctx) {
        var provide = ctx && ctx.provide
        if (typeof provide === 'function') {
          ctx.provide = function (name, value) {
            if (name === 'connection' && value && typeof value === 'object') {
              value.isLoopback = true
            }
            return provide(name, value)
          }
        }
        return apply.call(this, ctx)
      }
      return module
    }
  }
  var loader = window.__ModuleLoader__
  if (!loader || typeof loader.create !== 'function') return
  var create = loader.create
  loader.create = function (options) {
    var system = create.call(this, options)
    if (system && typeof system.register === 'function') {
      var register = system.register
      system.register = function (registration) {
        if (registration && registration.id === CONNECTION_ID && typeof registration.factory === 'function') {
          registration.factory = wrapFactory(registration.factory)
        }
        return register.call(this, registration)
      }
    }
    return system
  }
})()
</script>`;
/**
 * Register the index tap that injects the loopback script before `</head>`, so
 * it runs ahead of the client module system boot.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
    if (config.webToken === '')
        return;
    ctx.webServer.tapIndex(html => html.replace('</head>', `${LOOPBACK_SCRIPT}</head>`));
}
