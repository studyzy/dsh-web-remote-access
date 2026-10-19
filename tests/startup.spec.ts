/**
 * The Web command-line provider over a real Loader tree: its ordinary service
 * releases a consumer whose config reads `ctx.webStartup` directly.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

/** The real LAN probe, restored after tests that pin it. */
const realLanAddresses = startupInternals.lanAddresses

beforeEach(() => {
  // A runner's own NICs must not decide the assertions.
  startupInternals.lanAddresses = () => []
})

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  startupInternals.stdout = process.stdout
  startupInternals.stderr = process.stderr
  startupInternals.lanAddresses = realLanAddresses
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
    '    remote: !!js ctx.webStartup.remote',
    '    cookieMaxAgeDays: !!js ctx.webStartup.cookieMaxAgeDays',
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
      '--cookie-max-age-days', '400',
    ])
    expect(values).toEqual({
      openBrowser: true,
      host: '127.0.0.1',
      port: 8080,
      trustedHosts: ['lab.internal', 'lab-2.internal', '10.0.0.9'],
      remote: false,
      cookieMaxAgeDays: 400,
    })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.exits).toEqual([])
  })

  it('publishes openBrowser: false for --no-open', async () => {
    const { values, observed } = await bootProvider(['--no-open'])
    expect(values).toEqual({ openBrowser: false, trustedHosts: [], remote: false })
    expect(observed.exits).toEqual([])
  })

  it('serves a loopback bind when nothing is provided', async () => {
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ openBrowser: true, trustedHosts: [], remote: false })
    expect(observed.readerConfig).toEqual({
      openBrowser: true,
      host: '127.0.0.1',
      port: 3080,
      trustedHosts: [],
      remote: false,
    })
    expect(observed.exits).toEqual([])
  })

  it('resolves a wildcard --host to the first LAN address', async () => {
    startupInternals.lanAddresses = () => ['10.0.0.5', '10.0.0.6']
    const { values, observed } = await bootProvider(['--host', '0.0.0.0', '--trusted-host', 'lab.internal'])
    // Upstream rejects a wildcard bind outright; this fork binds one concrete
    // address instead, which the /api trust fence accepts as the bind authority.
    expect(values).toEqual({
      openBrowser: true,
      host: '10.0.0.5',
      trustedHosts: ['lab.internal'],
      remote: true,
    })
    expect(observed.readerConfig).toEqual({
      openBrowser: true,
      host: '10.0.0.5',
      port: 3080,
      trustedHosts: ['lab.internal'],
      remote: true,
    })
    expect(observed.exits).toEqual([])
  })

  it('rejects a wildcard --host when this machine has no LAN address', async () => {
    const { values, observed } = await bootProvider(['--host', '0.0.0.0'])
    expect(observed.out).toContain('needs a non-internal IPv4 address')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('passes a concrete --host through and marks it remote', async () => {
    const { values } = await bootProvider(['--host', '10.0.0.7'])
    expect(values).toEqual({ openBrowser: true, host: '10.0.0.7', trustedHosts: [], remote: true })
  })

  it('prints its own help and leaves the consumer pending', async () => {
    const { values, observed } = await bootProvider(['--help'])
    expect(observed.out).toContain('dsh --profile web')
    expect(observed.out).toContain('--trusted-host')
    expect(observed.out).toContain('--host')
    expect(observed.out).not.toContain('--web_token')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects a non-numeric --cookie-max-age-days before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--cookie-max-age-days', '30d'])
    expect(observed.out).toContain('--cookie-max-age-days must be a number')
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects a non-numeric port before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
