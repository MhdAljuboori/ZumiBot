import { describe, expect, it, vi } from 'vitest'
import { createHandlers, type HandlerDeps } from '../../src/rpc/handlers'

function make() {
  const update = {
    seen: vi.fn(() => ({ current: '0.1.0' })),
    check: vi.fn(async () => ({ current: '0.1.0' })),
    install: vi.fn(async () => ({ started: true as const })),
    rollBack: vi.fn(async () => ({ started: true as const }))
  }
  const h = createHandlers({ update } as unknown as HandlerDeps)
  return { update, h }
}

describe('update handlers', () => {
  it('update:status asks seen() (a stale answer starts a check) and update:check passes through', async () => {
    const { update, h } = make()
    expect(await h['update:status']()).toEqual({ current: '0.1.0' })
    expect(update.seen).toHaveBeenCalledOnce()
    await h['update:check']()
    expect(update.check).toHaveBeenCalledOnce()
  })

  it('update:install needs a boolean force', async () => {
    const { update, h } = make()
    for (const bad of ['yes', 1, null, undefined])
      await expect(h['update:install']({ force: bad })).rejects.toThrow(/force must be a boolean/)
    await expect(h['update:install'](true)).rejects.toThrow()
    await expect(h['update:install']()).rejects.toThrow()
    expect(update.install).not.toHaveBeenCalled()
    await h['update:install']({ force: false })
    expect(update.install).toHaveBeenCalledWith({ force: false })
  })

  it('update:rollBack needs a boolean force too', async () => {
    const { update, h } = make()
    await expect(h['update:rollBack']({ force: 'x' })).rejects.toThrow(/force must be a boolean/)
    await h['update:rollBack']({ force: true })
    expect(update.rollBack).toHaveBeenCalledWith({ force: true })
  })

  it('has no token call any more', () => {
    const { h } = make()
    expect(h).not.toHaveProperty('update:setToken')
  })
})
