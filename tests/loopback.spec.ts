/**
 * web-token-loopback index tap: the served index gets a script (before
 * `</head>`) that forces `connection.isLoopback` to true for remote browsers,
 * so the settings surface runs in "host" persistence instead of the
 * process-local "memory" scope. Inert without a configured web token.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/loopback.ts'

afterEach(() => {
  // Remove the globals the injected script is eval'd against.
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).__ModuleLoader__
})

/** A fake webServer capturing the registered index taps. */
function fakeWebServer(): { taps: ((html: string) => string)[]; server: unknown } {
  const taps: ((html: string) => string)[] = []
  return {
    taps,
    server: { tapIndex: (tap: (html: string) => string) => { taps.push(tap); return () => {} } },
  }
}

/** Extract the first inline script body from rendered html. */
function scriptBody(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (match === null) throw new Error('no inline script found in rendered html')
  return match[1]!
}

describe('web-token-loopback', () => {
  it('injects the isLoopback override script before </head>', async () => {
    const ctx = new Context()
    const { taps, server } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({ webToken: 'tok-abc' }))
    await ctx.fiber.dispose()
    expect(taps.length).toBe(1)
    const out = taps[0]!('<html><head><title>t</title></head><body></body></html>')
    expect(out.indexOf('@deepseek-ai/dsh-client-connection')).toBeGreaterThan(-1)
    expect(out.indexOf('isLoopback = true')).toBeGreaterThan(-1)
    // The override runs before the rest of the head (and thus any module script).
    expect(out.indexOf('@deepseek-ai/dsh-client-connection') < out.indexOf('</head>')).toBe(true)
  })

  it('is inert without a configured web token', async () => {
    const ctx = new Context()
    const { taps, server } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({ webToken: '' }))
    await ctx.fiber.dispose()
    expect(taps).toEqual([])
  })

  it('flips connection.isLoopback when the connection plugin registers through the loader', async () => {
    const factories = new Map<string, (require: (spec: string) => unknown) => unknown>()
    const system = {
      register(registration: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void {
        factories.set(registration.id, registration.factory)
      },
    }
    const loader = {
      mode: 'queue' as string,
      pendingQueue: [] as Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }>,
      load(registration: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void {
        this.pendingQueue.push(registration)
      },
      create(): typeof system {
        this.mode = 'live'
        this.load = (registration: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void => {
          system.register(registration)
        }
        for (const registration of this.pendingQueue.splice(0)) this.load(registration)
        return system
      },
    }

    const ctx = new Context()
    const { taps, server } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({ webToken: 'tok-abc' }))
    const html = taps[0]!('<html><head></head><body></body></html>')
    await ctx.fiber.dispose()

    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as Record<string, unknown>).__ModuleLoader__ = loader
    new Function(scriptBody(html))()

    // Boot creates the module system; the connection bundle arrives afterwards.
    loader.create({})
    loader.load({
      id: '@deepseek-ai/dsh-client-connection',
      factory: () => ({
        apply(fake: { provide: (name: string, value: unknown) => void }): void {
          fake.provide('connection', { isLoopback: false })
        },
      }),
    })

    const provided: { connection: { isLoopback?: boolean } | undefined } = { connection: undefined }
    const exports = factories.get('@deepseek-ai/dsh-client-connection')
    expect(exports).toBeDefined()
    const module = exports!(() => { throw new Error('unexpected require') }) as {
      apply(fake: { provide: (name: string, value: unknown) => void }): void
    }
    module.apply({
      provide(name: string, value: unknown): void {
        if (name === 'connection') provided.connection = value as { isLoopback?: boolean }
      },
    })

    expect(provided.connection?.isLoopback).toBe(true)
  })

  it('leaves other plugin factories unwrapped', async () => {
    const factories = new Map<string, (require: (spec: string) => unknown) => unknown>()
    const system = {
      register(registration: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void {
        factories.set(registration.id, registration.factory)
      },
    }
    const loader = {
      mode: 'queue' as string,
      pendingQueue: [] as Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }>,
      load(registration: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void {
        this.pendingQueue.push(registration)
      },
      create(): typeof system {
        this.mode = 'live'
        this.load = (registration: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void => {
          system.register(registration)
        }
        for (const registration of this.pendingQueue.splice(0)) this.load(registration)
        return system
      },
    }

    const ctx = new Context()
    const { taps, server } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({ webToken: 'tok-abc' }))
    const html = taps[0]!('<html><head></head><body></body></html>')
    await ctx.fiber.dispose()

    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as Record<string, unknown>).__ModuleLoader__ = loader
    new Function(scriptBody(html))()

    loader.create({})
    const otherFactory = () => ({ apply: () => {} })
    loader.load({ id: '@deepseek-ai/dsh-client-other', factory: otherFactory })

    expect(factories.get('@deepseek-ai/dsh-client-other')).toBe(otherFactory)
  })

  it('is a no-op when the module loader facade is absent', async () => {
    const ctx = new Context()
    const { taps, server } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({ webToken: 'tok-abc' }))
    const html = taps[0]!('<html><head></head><body></body></html>')
    await ctx.fiber.dispose()

    ;(globalThis as Record<string, unknown>).window = globalThis
    delete (globalThis as Record<string, unknown>).__ModuleLoader__
    expect(() => new Function(scriptBody(html))()).not.toThrow()
  })
})
