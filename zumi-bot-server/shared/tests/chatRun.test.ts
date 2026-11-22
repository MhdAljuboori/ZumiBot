import { describe, expect, it } from 'vitest'
import { effortFits, engineChatEffort, engineChatMode, isChatMode, isEffort, modeFits, runMode } from '../src/chatRun'

describe('chat permission modes and effort', () => {
  it('knows the modes a chat may keep: never auto (absent says that) and never one that skips approvals', () => {
    expect(['manual', 'acceptEdits', 'plan'].every(isChatMode)).toBe(true)
    expect(['auto', 'bypassPermissions', 'dontAsk', 'default', '', null, 3].some(isChatMode)).toBe(false)
  })

  it("knows the CLI's effort levels", () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].every(isEffort)).toBe(true)
    expect(['minimal', 'none', 'High', '', undefined].some(isEffort)).toBe(false)
  })

  it('Claude runs every mode; Codex only Ask, the stricter of its two policies', () => {
    expect(['manual', 'acceptEdits', 'plan'].every((m) => modeFits('claude', m as never))).toBe(true)
    expect(modeFits('codex', 'manual')).toBe(true)
    expect(modeFits('codex', 'acceptEdits')).toBe(false)
    expect(modeFits('codex', 'plan')).toBe(false)
  })

  it('effort is only for Claude chats', () => {
    expect(effortFits('claude', 'max')).toBe(true)
    expect(effortFits('codex', 'high')).toBe(false)
  })

  it("a setting the agent's engine cannot run is ignored, never handed to the wrong CLI", () => {
    expect(engineChatMode('claude', { permissionMode: 'plan' })).toBe('plan')
    expect(engineChatMode('codex', { permissionMode: 'plan' })).toBeUndefined()
    expect(engineChatMode('codex', { permissionMode: 'manual' })).toBe('manual')
    expect(engineChatMode('claude', {})).toBeUndefined()
    expect(engineChatEffort('claude', { effort: 'xhigh' })).toBe('xhigh')
    expect(engineChatEffort('codex', { effort: 'xhigh' })).toBeUndefined()
    expect(engineChatEffort('claude', {})).toBe('medium')
    expect(engineChatEffort('codex', {})).toBeUndefined()
  })

  it("a turn runs in the chat's mode, else the server's", () => {
    expect(runMode('auto', 'plan')).toBe('plan')
    expect(runMode('auto', undefined)).toBe('auto')
    expect(runMode('manual', undefined)).toBe('manual')
  })
})
