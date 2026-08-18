/**
 * web-token-url URL line printing: the printed line embeds the configured
 * token as `?web_token=` so it opens directly, and the LAN variant mirrors
 * the /api trust snapshot for an all-interfaces bind.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/url.ts'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fake webServer carrying just the bind facts the URL line reads. */
function fakeServer(host: '127.0.0.1' | '0.0.0.0'): unknown {
  return { host, port: 4567 }
}

/** A fake Loader whose settlement the test controls. */
function provideLoader(ctx: Context, settle: () => Promise<void> = async () => {}): void {
  ctx.provide('loader', { await: settle } as never)
}

describe('web-token-url', () => {
  it('prints the token URL (local + LAN) for an all-interfaces bind', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('0.0.0.0'))
    provideLoader(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: true, webToken: 'tok-abc' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith(
      'dsh web: http://127.0.0.1:4567/?web_token=tok-abc (LAN: http://192.168.1.5:4567/?web_token=tok-abc)',
    )
    await ctx.fiber.dispose()
  })

  it('prints a plain URL when no token is configured', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('127.0.0.1'))
    provideLoader(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: true, webToken: '' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567')
    await ctx.fiber.dispose()
  })

  it('stays quiet with printUrl off', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('127.0.0.1'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, webToken: 'tok-abc' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('defers the URL line until Loader settlement and drops it on failure', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('127.0.0.1'))
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    provideLoader(ctx, () => settlement)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: true, webToken: '' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    release!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567')
    await ctx.fiber.dispose()
  })
})
