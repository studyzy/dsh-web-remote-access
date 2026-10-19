/**
 * web-remote-url URL line printing: the printed line names the address the
 * server bound and carries the harness launch token (`?token=`) whose exchange
 * mints the session cookie the Web UI and the /api bridge require.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/url.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fake webServer carrying just the bind facts the URL line reads. */
function fakeServer(host: string): unknown {
  return { host, port: 4567 }
}

/** A fake connection service: the stock launch-token seam. */
function provideConnection(ctx: Context): void {
  ctx.provide('connection', { authenticatedUrl: (base: string) => `${base}/?token=launch-1` })
}

/** A fake Loader whose settlement the test controls. */
function provideLoader(ctx: Context, settle: () => Promise<void> = async () => {}): void {
  ctx.provide('loader', { await: settle } as never)
}

describe('web-remote-url', () => {
  it('prints the bound address with the harness launch token', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('192.168.1.5'))
    provideConnection(ctx)
    provideLoader(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://192.168.1.5:4567/?token=launch-1')
    await ctx.fiber.dispose()
  })

  it('prints the loopback bind when no address was resolved', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('127.0.0.1'))
    provideConnection(ctx)
    provideLoader(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=launch-1')
    await ctx.fiber.dispose()
  })

  it('prints the bare URL when the host has no launch-token seam', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('10.0.0.7'))
    provideLoader(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://10.0.0.7:4567')
    await ctx.fiber.dispose()
  })

  it('stays quiet with printUrl off', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeServer('127.0.0.1'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false }))
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
    apply(ctx, new Config({ printUrl: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    release!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567')
    await ctx.fiber.dispose()
  })
})
