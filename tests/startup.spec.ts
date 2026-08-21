/**
 * The Web command-line provider over a real Loader tree: its ordinary service
 * releases a consumer whose config reads `ctx.webStartup` directly.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, internals as startupInternals, WEB_STARTUP_SERVICE, type WebStartupValues } from '../src/startup.ts'

/** What one fixture boot observed. */
interface Observed {
  exits: number[]
  out: string
  readerConfig?: unknown
}

/**
 * Provide the launcher services the startup plugin reads (`cmdlineArgs` and
 * `appExit`), mirroring the harness's own provideCmdline contract.
 * @param ctx - the booted context.
 * @param host - the invocation's arguments and its exit request.
 */
function provideCmdline(ctx: Context, host: { args: readonly string[]; exit: (code: number) => void }): void {
  ctx.provide('cmdlineArgs', { get: () => Object.freeze([...host.args]) })
  ctx.provide('appExit', host.exit)
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  startupInternals.stdout = process.stdout
  startupInternals.stderr = process.stderr
  startupInternals.mintRandomToken = () => randomBytes(32).toString('base64url')
  startupInternals.envWebToken = () => process.env.DSH_WEB_TOKEN
})

/**
 * Mount the real provider and a consumer using injection-ordered config.
 * @param args - the invocation's inner arguments.
 * @returns the service value and observed consumer/process effects.
 */
async function bootProvider(args: string[]): Promise<{
  values: WebStartupValues | undefined
  observed: Observed
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'reader.mjs'), `
export function apply(_ctx, config) { globalThis.__webStartupObserved.readerConfig = config }
`)
  // Node imports the fixture row outside Vite's source resolver, so delegate
  // to the source-plane plugin already imported by this test.
  writeFileSync(join(dir, 'provider.mjs'), `
export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__webStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: reader',
    `  name: ${pathToFileURL(join(dir, 'reader.mjs')).href}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  config:',
    "    openBrowser: !!js ctx.webStartup.openBrowser",
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    '    port: !!js ctx.webStartup.port ?? 3080',
    '    trustedHosts: !!js ctx.webStartup.trustedHosts',
    '    webToken: !!js ctx.webStartup.webToken',
    '- id: provider',
    `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  startupInternals.stdout = observing
  startupInternals.stderr = observing
  const globals = globalThis as unknown as {
    __webStartupApply: typeof apply
    __webStartupObserved: Observed
  }
  globals.__webStartupApply = apply
  globals.__webStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined,
    observed,
  }
}

describe('web command-line provider', () => {
  it('publishes each flag and releases direct service expressions', async () => {
    const { values, observed } = await bootProvider([
      '--host', '127.0.0.1',
      '--port', '8080',
      '--trusted-host', 'lab.internal', 'lab-2.internal',
      '--trusted-host', '10.0.0.9',
      '--web_token', '9mYik22Ajc1mvZZ3vNCU1o8njwn4jbeRLYNJH_0YW-o',
    ])
    expect(values).toEqual({
      openBrowser: true,
      host: '127.0.0.1',
      port: 8080,
      trustedHosts: ['lab.internal', 'lab-2.internal', '10.0.0.9'],
      webToken: '9mYik22Ajc1mvZZ3vNCU1o8njwn4jbeRLYNJH_0YW-o',
    })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.exits).toEqual([])
  })

  it('publishes openBrowser: false for --no-open', async () => {
    const { values, observed } = await bootProvider(['--no-open', '--web_token', 'tok-123'])
    expect(values).toEqual({ openBrowser: false, trustedHosts: [], webToken: 'tok-123' })
    expect(observed.exits).toEqual([])
  })

  it('mints a fresh random token when no flag or environment token exists', async () => {
    startupInternals.mintRandomToken = () => 'random-tok-123'
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ openBrowser: true, trustedHosts: [], webToken: 'random-tok-123' })
    expect(observed.readerConfig).toEqual({
      openBrowser: true,
      host: '127.0.0.1',
      port: 3080,
      trustedHosts: [],
      webToken: 'random-tok-123',
    })
    expect(observed.exits).toEqual([])
  })

  it('reads the DSH_WEB_TOKEN environment variable when no flag is given', async () => {
    startupInternals.envWebToken = () => 'env-tok-456'
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ openBrowser: true, trustedHosts: [], webToken: 'env-tok-456' })
    expect(observed.readerConfig).toEqual({
      openBrowser: true,
      host: '127.0.0.1',
      port: 3080,
      trustedHosts: [],
      webToken: 'env-tok-456',
    })
    expect(observed.exits).toEqual([])
  })

  it('prefers --web_token over the environment variable', async () => {
    startupInternals.envWebToken = () => 'env-tok-456'
    const { values, observed } = await bootProvider(['--web_token', 'flag-tok-789'])
    expect(values).toEqual({ openBrowser: true, trustedHosts: [], webToken: 'flag-tok-789' })
    expect(observed.readerConfig).toEqual({
      openBrowser: true,
      host: '127.0.0.1',
      port: 3080,
      trustedHosts: [],
      webToken: 'flag-tok-789',
    })
    expect(observed.exits).toEqual([])
  })

  it('treats an empty flag or empty environment value as unset', async () => {
    startupInternals.mintRandomToken = () => 'random-tok-123'
    startupInternals.envWebToken = () => ''
    const withEmptyFlag = await bootProvider(['--web_token', ''])
    expect(withEmptyFlag.values).toEqual({ openBrowser: true, trustedHosts: [], webToken: 'random-tok-123' })
    const withEmptyEnv = await bootProvider([])
    expect(withEmptyEnv.values).toEqual({ openBrowser: true, trustedHosts: [], webToken: 'random-tok-123' })
  })

  it('prints its own help and leaves the consumer pending', async () => {
    const { values, observed } = await bootProvider(['--help'])
    expect(observed.out).toContain('dsh --profile web')
    expect(observed.out).toContain('--trusted-host')
    expect(observed.out).toContain('--web_token')
    expect(observed.out).toContain('DSH_WEB_TOKEN')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects a non-numeric port before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('allows an all-interfaces bind without --web_token (a token always exists)', async () => {
    startupInternals.mintRandomToken = () => 'random-tok-123'
    const { values, observed } = await bootProvider(['--host', '0.0.0.0'])
    expect(values).toEqual({ openBrowser: true, host: '0.0.0.0', trustedHosts: [], webToken: 'random-tok-123' })
    expect(observed.readerConfig).toEqual({
      openBrowser: true,
      host: '0.0.0.0',
      port: 3080,
      trustedHosts: [],
      webToken: 'random-tok-123',
    })
    expect(observed.exits).toEqual([])
  })

  it('accepts an all-interfaces bind that carries --web_token', async () => {
    const { values, observed } = await bootProvider(['--host', '0.0.0.0', '--web_token', 'tok-123'])
    expect(values).toEqual({ openBrowser: true, host: '0.0.0.0', trustedHosts: [], webToken: 'tok-123' })
    expect(observed.readerConfig).toEqual({
      openBrowser: true,
      host: '0.0.0.0',
      port: 3080,
      trustedHosts: [],
      webToken: 'tok-123',
    })
    expect(observed.exits).toEqual([])
  })
})
