import { describe, expect, it } from 'vitest'
import { engineChatModel, modelFits, turnModel } from '../src/chatModel'

describe('turnModel', () => {
  it('a plain message runs on the chat model, or the agent default when the chat has none', () => {
    expect(turnModel({ chatModel: 'sonnet', agentModel: 'opus', fresh: false })).toEqual({ run: 'sonnet' })
    expect(turnModel({ agentModel: 'opus', fresh: false })).toEqual({})
  })

  it("a command that starts the session sets the chat's model", () => {
    expect(turnModel({ agentModel: 'opus', picked: 'sonnet', fresh: true })).toEqual({ run: 'sonnet', save: 'sonnet' })
    // Its own default needs no override.
    expect(turnModel({ agentModel: 'opus', picked: 'opus', fresh: true })).toEqual({ save: null })
    expect(turnModel({ chatModel: 'sonnet', agentModel: 'opus', picked: 'haiku', fresh: true })).toEqual({ run: 'haiku', save: 'haiku' })
  })

  it('in a running session a stronger command switches up and a cheaper one never down', () => {
    expect(turnModel({ chatModel: 'sonnet', agentModel: 'opus', picked: 'opus', fresh: false })).toEqual({ save: null })
    expect(turnModel({ agentModel: 'sonnet', picked: 'opus', fresh: false })).toEqual({ run: 'opus', save: 'opus' })
    expect(turnModel({ agentModel: 'opus', picked: 'sonnet', fresh: false })).toEqual({})
    expect(turnModel({ chatModel: 'sonnet', agentModel: 'opus', picked: 'haiku', fresh: false })).toEqual({ run: 'sonnet' })
  })

  it('an agent default it cannot rank (inherit, a full model id) never switches a running session', () => {
    expect(turnModel({ agentModel: null, picked: 'opus', fresh: false })).toEqual({})
    expect(turnModel({ agentModel: 'claude-opus-5-5', picked: 'sonnet', fresh: false })).toEqual({})
    expect(turnModel({ agentModel: null, picked: 'sonnet', fresh: true })).toEqual({ run: 'sonnet', save: 'sonnet' })
  })

  it('a model picked by hand runs every turn, and no command moves it up or down', () => {
    expect(turnModel({ chatModel: 'haiku', byHand: true, agentModel: 'opus', picked: 'opus', fresh: false })).toEqual({ run: 'haiku' })
    expect(turnModel({ chatModel: 'sonnet', byHand: true, agentModel: 'opus', picked: 'haiku', fresh: true })).toEqual({ run: 'sonnet' })
    // Its own model too: picked by hand, it stays even when the agent's file changes.
    expect(turnModel({ chatModel: 'opus', byHand: true, agentModel: 'opus', fresh: false })).toEqual({ run: 'opus' })
  })
})

describe('modelFits', () => {
  it('a Claude chat takes the three command models, a Codex chat any plain Codex model name', () => {
    for (const m of ['opus', 'sonnet', 'haiku']) expect(modelFits('claude', m)).toBe(true)
    expect(modelFits('claude', 'gpt-6.1-sol')).toBe(false)
    expect(modelFits('codex', 'gpt-6.1-sol')).toBe(true)
    expect(modelFits('codex', 'o4-mini')).toBe(true)
    expect(modelFits('codex', 'sonnet')).toBe(false)
  })
  it('refuses what is no model name', () => {
    for (const m of ['', ' gpt', 'gpt 6', 'gpt"6', '-gpt', 'a'.repeat(101), 'gpt\n6']) expect(modelFits('codex', m)).toBe(false)
  })
})

describe('engineChatModel', () => {
  it("a Claude turn takes the chat's command model, picked or set by a command", () => {
    expect(engineChatModel('claude', { model: 'sonnet' })).toBe('sonnet')
    expect(engineChatModel('claude', { model: 'haiku', modelByHand: true })).toBe('haiku')
    expect(engineChatModel('claude', {})).toBeUndefined()
  })
  it('a Codex turn takes only a Codex model picked by hand', () => {
    expect(engineChatModel('codex', { model: 'gpt-6.1-sol', modelByHand: true })).toBe('gpt-6.1-sol')
    // A Claude command left it: Codex has no command models.
    expect(engineChatModel('codex', { model: 'sonnet' })).toBeUndefined()
    expect(engineChatModel('codex', { model: 'sonnet', modelByHand: true })).toBeUndefined()
  })
  it("a pick the agent's old engine made is ignored, never handed to the other CLI", () => {
    expect(engineChatModel('claude', { model: 'gpt-6.1-sol', modelByHand: true })).toBeUndefined()
  })
})
