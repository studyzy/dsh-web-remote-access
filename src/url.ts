/**
 * @studyzy/dsh-web-remote-access/url — the web URL line printer. Replaces the stock web-app
 * URL print (which the bundle patch disables) so a configured `--web_token`
 * shows up in the printed URL: opening the printed line is exactly the
 * `?web_token=` grant flow, and the LAN variant mirrors the /api trust
 * snapshot (non-internal IPv4 literals for an all-interfaces bind).
 */

import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'web-token-url'

/** Services required before the URL can be read. */
export const inject = ['webStartup', 'webServer']

/** Plugin config: print the URL line, and the access token to embed. */
export interface Config {
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /** The web token; when set, the printed URLs carry `?web_token=` so they open directly. */
  webToken: string
}

export const Config: z<Config> = z.object({
  printUrl: z.boolean().default(true),
  webToken: z.string().default(''),
})

/** The loopback host the local URL always prints. */
const LOOPBACK_HOST = '127.0.0.1'
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/** LAN IPv4 literals for an all-interfaces bind; empty for a loopback bind. */
function lanAddresses(bindHost: string): string[] {
  if (bindHost !== ALL_INTERFACES_HOST) return []
  return Object.values(networkInterfaces()).flat()
    .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}

/** One URL with the optional `?web_token=` grant appended. */
function urlWithToken(base: string, webToken: string): string {
  return webToken === '' ? base : `${base}/?web_token=${encodeURIComponent(webToken)}`
}

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
    const local = urlWithToken(`http://${LOOPBACK_HOST}:${String(server.port)}`, config.webToken)
    const lan = lanAddresses(server.host)[0]
    const lanLine = lan === undefined
      ? ''
      : ` (LAN: ${urlWithToken(`http://${lan}:${String(server.port)}`, config.webToken)})`
    console.log(`dsh web: ${local}${lanLine}`)
  }
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) printUrl()
  else {
    void settled.then(() => {
      if (ctx.get('webServer') !== undefined) printUrl()
    }, () => {})
  }
}
