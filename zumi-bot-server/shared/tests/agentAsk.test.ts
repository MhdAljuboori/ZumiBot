import { describe, expect, it } from 'vitest'
import {
  ASK_MAX_HOPS,
  ASK_SIDE_NAME,
  ASK_SIDE_QUESTION_MAX,
  ASK_SIDE_TOOL,
  ASK_TOOL,
  askHandle,
  isAskTool,
  withAskTool,
  askedTitle,
  findAskTarget,
  isAsked
} from '@zumibot/shared/agentAsk'

describe('askHandle', () => {
  it('trims, drops one leading @ and lower-cases', () => {
    expect(askHandle('  @Workiom-Master ')).toBe('workiom-master')
  })
})

describe('findAskTarget', () => {
  it('finds an agent by name, case-insensitively', () => {
    expect(findAskTarget([{ name: 'workiom-master' }], '@WORKIOM-master')?.name).toBe('workiom-master')
  })
  it('returns null for an unknown name', () => {
    expect(findAskTarget([{ name: 'a' }], 'b')).toBeNull()
  })
})

describe('askedTitle', () => {
  it('joins the asking agent and the chat title', () => {
    expect(askedTitle('checker', 'Login bug')).toBe('@checker · Login bug')
  })
  it('says New chat when the title is empty', () => {
    expect(askedTitle('checker', '')).toBe('@checker · New chat')
  })
})

describe('isAsked', () => {
  it('is true when the chat carries an ask', () => {
    expect(isAsked({ asked: { by: 'a', from: 'c1', fromTitle: 't', chain: [] } })).toBe(true)
  })
  it('is false for a chat with no ask', () => {
    expect(isAsked({})).toBe(false)
  })
})

describe('constants', () => {
  it('exposes the tool name and hop cap', () => {
    expect(ASK_TOOL).toBe('mcp__zumibot_agents__ask')
    expect(ASK_MAX_HOPS).toBe(3)
  })
})

describe('withAskTool', () => {
  it('keeps null and adds the ask tool once', () => {
    expect(withAskTool(null)).toBeNull()
    expect(withAskTool(['Read'])).toEqual(['Read', ASK_TOOL, ASK_SIDE_TOOL])
    expect(withAskTool([ASK_TOOL, 'Read'])).toEqual(['Read', ASK_TOOL, ASK_SIDE_TOOL])
    expect(withAskTool(withAskTool(['Read']))).toEqual(['Read', ASK_TOOL, ASK_SIDE_TOOL])
  })
})

describe('side ask tool', () => {
  it('has the fixed names and cap', () => {
    expect(ASK_SIDE_NAME).toBe('side_question')
    expect(ASK_SIDE_TOOL).toBe('mcp__zumibot_agents__side_question')
    expect(ASK_SIDE_QUESTION_MAX).toBe(4000)
  })
  it('isAskTool is true for both ask tools and nothing else', () => {
    expect(isAskTool(ASK_TOOL)).toBe(true)
    expect(isAskTool(ASK_SIDE_TOOL)).toBe(true)
    expect(isAskTool('mcp__other__ask')).toBe(false)
    expect(isAskTool('mcp__other__side_question')).toBe(false)
  })
})
