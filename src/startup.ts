/**
 * @studyzy/dsh-web-remote-access/startup — a fork of `@deepseek-ai/dsh-web-app/startup` that
 * parses the `dsh --profile web` flag family (`--host`, `--port`,
 * `--trusted-host`) and its `--help` text, then provides the immutable values
 * as {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that service before
 * reading it from lazy config.
 *
 * The one divergence from upstream: upstream rejects a wildcard bind
 * (`--host 0.0.0.0`) outright, because binding every interface would expose
 * remote code execution to the network, and tells the user to name a concrete
 * interface address instead. This fork keeps the convenient `--host 0.0.0.0`
 * spelling and resolves it to this machine's first non-internal IPv4 address,
 * so the stock webserver row binds a concrete address while remote clients are
 * still gated by the harness's own launch-token session cookie.
 *
 * The flag parse and bounded-exit wiring is a vendored port of
 * `@deepseek-ai/dsh-cmdline`'s `parseCmdline` (MIT). This bundle forks the
 * official startup, and depending on that rc package pulled an unsatisfied
 * `dsh-invariants` peer into every profile install (the harness resolves
 * out-of-tree peers at runtime, but pnpm still warns). Inlining the ~40 lines
 * keeps consumers install-clean and independent of rc churn.
 */

import { networkInterfaces } from 'node:os'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** Whether this invocation opens the default browser after startup. */
  openBrowser: boolean
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** `--cookie-max-age-days`, absent when the invocation did not name one (harness default: 30). */
  cookieMaxAgeDays?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** Whether the resolved bind address serves beyond this machine (a non-loopback literal). */
  remote: boolean
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
  cookieMaxAgeDays?: string
}

/** Test hooks: the interface probe and the output streams. */
export const internals: {
  /** Non-internal IPv4 addresses of this machine; tests replace this to fix the set. */
  lanAddresses: () => string[]
  /** Process stream commander output is written to; tests replace these to capture text. */
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
} = {
  lanAddresses: () => Object.values(networkInterfaces()).flat()
    .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address),
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Bind literals that request every interface at once. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::ffff:0.0.0.0'])

/** Whether a bind literal names the local loopback authority. */
function isLoopbackLiteral(host: string): boolean {
  return host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
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
    .option('--host <host>', 'bind address: a concrete IPv4/IPv6 literal of a local interface; 0.0.0.0 resolves to this machine\'s LAN address')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--cookie-max-age-days <days>', 'lifetime of the harness session cookie in days (harness default: 30; browsers cap it at 400)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the loopback bind
  dsh --profile web --port 8080              serve on another loopback port
  dsh --profile web --host 0.0.0.0           serve on this machine\'s LAN address (remote browsers need the printed URL)
  dsh --profile web --host 10.0.0.7          serve on one named interface address
  dsh --profile web --cookie-max-age-days 400   keep remote browsers authorized for 400 days
`)
}

/**
 * Whether any command in the tree declares an action handler.
 *
 * The `Command` type cannot express the action precondition, so the handler is
 * read structurally (as {@link isCommanderError} reads commander's control-flow
 * errors): without this guard, a program that forgot its action would parse
 * successfully, publish nothing, and surface only as dependent rows pending on
 * the absent service.
 * @param command - the command whose tree is inspected.
 * @returns true when the command or any registered subcommand has an action.
 */
function hasAction(command: Command): boolean {
  if (typeof (command as unknown as { _actionHandler?: unknown })._actionHandler === 'function') return true
  return command.commands.some(hasAction)
}

/**
 * Route every command's exit and output through the launcher adapter.
 *
 * Commander copies `exitOverride` and output configuration into a subcommand
 * only at registration, so a root-only override would let an
 * already-registered subcommand's rejection write to the process streams and
 * call `process.exit` directly, bypassing the launcher's bounded exit.
 * @param command - the root of the command tree to configure.
 */
function configureExitAndOutput(command: Command): void {
  command
    .exitOverride()
    .configureOutput({
      writeOut: text => void internals.stdout.write(text),
      writeErr: text => void internals.stderr.write(text),
    })
  for (const child of command.commands) configureExitAndOutput(child)
}

/**
 * Whether a thrown value is commander's own control-flow error (help, version,
 * a parse error, or `program.error`).
 *
 * Detected structurally, not with `instanceof`: an out-of-tree plugin brings
 * its own commander copy, whose `CommanderError` class is a different identity
 * from any commander the harness imported, and an identity check there would
 * rethrow a printed help as a fatal load failure.
 * @param error - the thrown value.
 * @returns true when the value carries commander's error code and exit code.
 */
function isCommanderError(error: unknown): error is { code: string; exitCode: number } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('commander.')
    && typeof candidate.exitCode === 'number'
}

/**
 * Parse the launcher's immutable argument snapshot with this app's commander
 * program. Commander runs the program's own synchronous action handler on a
 * successful parse; app code there publishes its service and rejects an
 * invalid invocation with `program.error(...)`.
 *
 * Help, version, and rejected arguments — from the grammar or from an action
 * — are terminal for the process: commander writes the text and the helper
 * requests `ctx.appExit`. The action never runs on help, version, or a
 * grammar rejection; an action must reject before it publishes, because
 * statements before its `program.error(...)` have already run.
 * @param ctx - plugin context carrying `cmdlineArgs` and `appExit`.
 * @param program - the app's commander program, with its flags, description,
 * actions, and any subcommands already declared.
 * @throws when the launcher did not provide the command line and exit request,
 * or when no command in the program declares an action.
 */
function parseCmdline(ctx: Context, program: Command): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value and the plugin only needs to inject cmdlineArgs.
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) {
    throw new Error(`${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`)
  }
  if (!hasAction(program)) {
    throw new Error(`${program.name()}: no command in the program declares an action; parseCmdline runs the invoked command's action on a successful parse, and app code there publishes its service`)
  }
  configureExitAndOutput(program)
  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    // exitOverride turns help, version, a parse error, and the action's own
    // program.error() into a CommanderError; commander has already written the
    // text through the output configured above.
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
  }
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
    if (options.cookieMaxAgeDays !== undefined && !/^\d+$/.test(options.cookieMaxAgeDays)) {
      program.error(`error: --cookie-max-age-days must be a number, got ${JSON.stringify(options.cookieMaxAgeDays)}`)
    }
    // Upstream refuses a wildcard bind; resolve it to a concrete interface
    // address instead of failing the invocation, so the stock webserver row
    // binds one address and the harness trust fence accepts it as the bind
    // authority (no --trusted-host entry needed).
    let host = options.host
    if (host !== undefined && WILDCARD_HOSTS.has(host)) {
      const lan = internals.lanAddresses()[0]
      if (lan === undefined) {
        program.error(`error: --host ${host} needs a non-internal IPv4 address on this machine; none found`)
      }
      host = lan
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...host !== undefined && { host },
      ...options.port !== undefined && { port: Number(options.port) },
      ...options.cookieMaxAgeDays !== undefined && { cookieMaxAgeDays: Number(options.cookieMaxAgeDays) },
      trustedHosts: options.trustedHost ?? [],
      remote: host !== undefined && !isLoopbackLiteral(host),
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
