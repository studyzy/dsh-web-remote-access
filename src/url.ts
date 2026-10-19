/**
 * @studyzy/dsh-web-remote-access/url — the web URL line printer. Replaces the
 * stock web-app URL print (which the bundle patch disables) so the line names
 * the address the server actually bound, including the harness launch token
 * (`?token=`) whose first-open exchange mints the session cookie the Web UI
 * and the `/api` bridge require.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'web-token-url'

/** Services required before the URL can be read. */
export const inject = ['webStartup', 'webServer']

/**
 * The stock 0.2.x browser-auth seam, read structurally: `authenticatedUrl`
 * appends the process launch token (`?token=`) whose first-open exchange mints
 * the harness session cookie that the frontend-static index and the `/api`
 * bridge require. Read with `ctx.get` rather than `inject` so the row still
 * loads on a 0.1.x host without the connection service.
 */
interface ConnectionFacts {
  authenticatedUrl(baseUrl: string): string
}

/** Plugin config: print the URL line. */
export interface Config {
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
}

export const Config: z<Config> = z.object({
  printUrl: z.boolean().default(true),
})

/** The host a loopback bind defaults to, matching the webserver row's own default. */
const DEFAULT_HOST = '127.0.0.1'

/** Bind-dependent values the URL line reads; kept to what this row needs. */
interface WebServerFacts {
  host: string
  port: number
}

/**
 * Print the web URL line, waiting for Loader settlement when one exists so a
 * supervisor (or a keyless smoke) can RPC as soon as the line appears. A
 * failed or torn-down boot prints nothing.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.printUrl) return
  const printUrl = (): void => {
    const server = ctx.get('webServer') as WebServerFacts | undefined
    if (server === undefined) return
    const connection = ctx.get('connection') as ConnectionFacts | undefined
    // The launch token is the one grant in the line: its exchange mints the
    // harness session cookie, so the printed URL opens straight into the UI.
    const printable = `http://${server.host}:${String(server.port)}`
    const url = connection === undefined ? printable : connection.authenticatedUrl(printable)
    console.log(`dsh web: ${url}`)
  }
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) printUrl()
  else {
    void settled.then(() => {
      if (ctx.get('webServer') !== undefined) printUrl()
    }, () => {})
  }
}
