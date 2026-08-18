/**
 * @studyzy/dsh-web-remote-access/startup — a fork of `@deepseek-ai/dsh-web-app/startup` that
 * parses the `dsh --profile web` flag family (`--host`, `--port`,
 * `--trusted-host`, `--web_token`) and its `--help` text, then provides the
 * immutable values as {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that
 * service before reading it from lazy config. The web token always exists:
 * the explicit `--web_token` wins, then `$DSH_WEB_TOKEN`, then a fresh random
 * token minted at startup — so an all-interfaces bind always runs behind the
 * gate and the printed URL always opens directly.
 */

import { randomBytes } from 'node:crypto'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** Environment variable that supplies the web token when no `--web_token` is given. */
export const WEB_TOKEN_ENV = 'DSH_WEB_TOKEN'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** The active web token: `--web_token`, else `$DSH_WEB_TOKEN`, else a fresh random one. */
  webToken: string
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  trustedHost?: string[]
  web_token?: string
}

/** Test hooks: randomness and the environment seam. */
export const internals: {
  /** Mint the random fallback token; randomBytes(32) → base64url by default. */
  mintRandomToken: () => string
  /** Read the `DSH_WEB_TOKEN` environment variable. */
  envWebToken: () => string | undefined
} = {
  mintRandomToken: () => randomBytes(32).toString('base64url'),
  envWebToken: () => process.env[WEB_TOKEN_ENV],
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--web_token <token>', 'require this token to open the Web UI (first visit via ?web_token= grants a session cookie); defaults to $DSH_WEB_TOKEN, or a fresh random token')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port; prints a random-token URL
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0           serve on all interfaces behind a random token (or $DSH_WEB_TOKEN)
  dsh --profile web --host 0.0.0.0 --web_token <token>   serve on all interfaces behind a fixed token
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named plus the resolved
 * web token; a non-numeric `--port` is a usage error, so on rejection (and on
 * `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    const explicit = options.web_token !== undefined && options.web_token !== ''
      ? options.web_token
      : undefined
    const env = internals.envWebToken()
    const webToken = explicit ?? (env !== undefined && env !== '' ? env : internals.mintRandomToken())
    ctx.provide(WEB_STARTUP_SERVICE, {
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
      webToken,
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
