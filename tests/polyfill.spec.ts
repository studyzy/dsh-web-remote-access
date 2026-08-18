/**
 * web-token-polyfill index tap: the served index gets a `crypto.randomUUID`
 * polyfill backed by `crypto.getRandomValues` (available on insecure origins),
 * injected before `</head>` so it runs ahead of every client bundle. Inert
 * without a configured web token.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/polyfill.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fake webServer capturing the registered index taps. */
function fakeWebServer(): { taps: ((html: string) => string)[]; server: unknown } {
  const taps: ((html: string) => string)[] = []
  return {
    taps,
    server: { tapIndex: (tap: (html: string) => string) => { taps.push(tap); return () => {} } },
  }
}

describe('web-token-polyfill', () => {
  it('injects a getRandomValues-backed randomUUID polyfill before </head>', async () => {
    const ctx = new Context()
    const { taps, server } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({ webToken: 'tok-abc' }))
    await ctx.fiber.dispose()
    expect(taps.length).toBe(1)
    const out = taps[0]!('<html><head><title>t</title></head><body></body></html>')
    expect(out.indexOf('crypto.randomUUID')).toBeGreaterThan(-1)
    expect(out.indexOf('crypto.getRandomValues')).toBeGreaterThan(-1)
    // The polyfill runs before the rest of the head (and thus any module script).
    expect(out.indexOf('crypto.randomUUID') < out.indexOf('</head>')).toBe(true)
  })

  it('is inert without a configured web token', async () => {
    const ctx = new Context()
    const { taps, server } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({ webToken: '' }))
    await ctx.fiber.dispose()
    expect(taps).toEqual([])
  })
})
