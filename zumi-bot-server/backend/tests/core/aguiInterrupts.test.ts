import { describe, expect, it } from 'vitest'
import { parseQuestions } from '@zumibot/shared/questions'
import { allowResponse, denyResponse, errorResponse } from '../../src/core/chat/controlProtocol'
import { expiryOf, interruptQuestions, isExpired, resumeEntry, type AguiInterrupt } from '../../src/core/agui/aguiInterrupts'
import { elicitationAnswer, elicitationQuestions } from '../../src/core/acp/acpElicitation'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const approval: AguiInterrupt = {
  id: 'int-1',
  reason: 'tool_approval',
  message: 'Run the deploy?',
  responseSchema: { type: 'object', properties: { approved: { type: 'boolean', title: 'Approve' } }, required: ['approved'] }
}
// The card's answer, keyed by question text, on the input the server built.
const answered = (i: AguiInterrupt, answers: Record<string, unknown>) =>
  allowResponse('r', { ...(interruptQuestions(i) as object), answers })

describe('interruptQuestions', () => {
  it('maps a schema the ACP form mapping reads to the question card, its message as the title', () => {
    const p = parseQuestions(interruptQuestions(approval))!
    expect(p.title).toBe('Run the deploy?')
    expect(p.questions).toHaveLength(1)
    expect(p.questions[0]).toMatchObject({ text: 'Approve', kind: 'choice' })
    expect(p.questions[0].options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })

  it('gives null with no schema, or one the card cannot show', () => {
    expect(interruptQuestions({ id: 'i', reason: 'r' })).toBeNull()
    expect(
      interruptQuestions({ id: 'i', reason: 'r', responseSchema: { type: 'object', properties: { nested: { type: 'object' } } } })
    ).toBeNull()
    expect(interruptQuestions({ id: 'i', reason: 'r', responseSchema: { type: 'object' } })).toBeNull()
  })
})

describe('resumeEntry', () => {
  it('resolves an allowed card with the answers as the payload', () => {
    expect(resumeEntry(approval, answered(approval, { Approve: 'Yes' }), NOW)).toEqual({
      interruptId: 'int-1',
      status: 'resolved',
      payload: { approved: true }
    })
    expect(resumeEntry(approval, answered(approval, { Approve: 'No' }), NOW)).toEqual({
      interruptId: 'int-1',
      status: 'resolved',
      payload: { approved: false }
    })
  })

  it('cancels a skipped card, an error, no answer, or an allow missing a required answer', () => {
    for (const answer of [denyResponse('r', 'skip'), errorResponse('r', 'stopped'), null, answered(approval, {})]) {
      expect(resumeEntry(approval, answer, NOW)).toEqual({ interruptId: 'int-1', status: 'cancelled' })
    }
  })

  it('cancels an interrupt with no schema even when allowed', () => {
    expect(resumeEntry({ id: 'i', reason: 'r' }, allowResponse('r', {}), NOW)).toEqual({ interruptId: 'i', status: 'cancelled' })
  })

  it('cancels an interrupt that expired at or before now', () => {
    for (const expiresAt of ['2026-11-18T12:00:00Z', '2026-11-18T11:59:59Z']) {
      const i = { ...approval, expiresAt }
      expect(resumeEntry(i, answered(i, { Approve: 'Yes' }), NOW)).toEqual({ interruptId: 'int-1', status: 'cancelled' })
    }
    const later = { ...approval, expiresAt: '2026-11-18T12:00:01Z' }
    expect(resumeEntry(later, answered(later, { Approve: 'Yes' }), NOW)).toEqual({
      interruptId: 'int-1',
      status: 'resolved',
      payload: { approved: true }
    })
  })
})

// Pydantic AI 2.65's tool-approval interrupt, as a real server sends it.
const PYDANTIC_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, editedArgs: { type: 'object' }, reason: { type: 'string' } },
  required: ['approved']
}
const pydantic: AguiInterrupt = { id: 'int-p', reason: 'tool_call', toolCallId: 'call_1', responseSchema: PYDANTIC_SCHEMA }

describe('interrupts: the card asks only what the server requires', () => {
  it('asks the Pydantic approval as one Yes/No question, approved, with neither reason nor editedArgs', () => {
    const p = parseQuestions(interruptQuestions(pydantic))!
    expect(p.questions.map((q) => [q.text, q.kind])).toEqual([['approved', 'choice']])
    expect(p.questions[0].options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })

  it('resolves Yes to exactly {approved: true}, whatever else the answer carries', () => {
    for (const answers of [{ approved: 'Yes' }, { approved: 'Yes', reason: 'because' }, { approved: 'Yes', editedArgs: '{"x":1}' }]) {
      const entry = resumeEntry(pydantic, answered(pydantic, answers), NOW)
      expect(entry).toEqual({ interruptId: 'int-p', status: 'resolved', payload: { approved: true } })
      expect(Object.keys((entry as { payload: object }).payload)).toEqual(['approved'])
    }
  })

  it('resolves No to {approved: false}', () => {
    expect(resumeEntry(pydantic, answered(pydantic, { approved: 'No' }), NOW)).toEqual({
      interruptId: 'int-p',
      status: 'resolved',
      payload: { approved: false }
    })
  })

  it('keeps the optional properties a card can show when nothing is required', () => {
    const i: AguiInterrupt = {
      id: 'int-o',
      reason: 'r',
      responseSchema: { type: 'object', properties: { note: { type: 'string', title: 'Note' }, extra: { type: 'object' } } }
    }
    const p = parseQuestions(interruptQuestions(i))!
    expect(p.questions.map((q) => [q.text, q.kind])).toEqual([['Note', 'text']])
    expect(resumeEntry(i, answered(i, { Note: 'hi' }), NOW)).toEqual({ interruptId: 'int-o', status: 'resolved', payload: { note: 'hi' } })
  })

  it('still cancels a schema whose required property is one a card cannot show', () => {
    const i: AguiInterrupt = {
      id: 'int-r',
      reason: 'r',
      responseSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' }, editedArgs: { type: 'object' } },
        required: ['approved', 'editedArgs']
      }
    }
    expect(interruptQuestions(i)).toBeNull()
    expect(resumeEntry(i, allowResponse('r', { questions: [], answers: { approved: 'Yes' } }), NOW)).toEqual({
      interruptId: 'int-r',
      status: 'cancelled'
    })
  })

  it('reads a required name with no property (not an own key of properties) as nothing required', () => {
    const i: AguiInterrupt = {
      id: 'int-g',
      reason: 'r',
      responseSchema: {
        type: 'object',
        properties: { note: { type: 'string', title: 'Note' }, extra: { type: 'object' } },
        required: ['ghost', 'toString']
      }
    }
    // As with nothing required: the optional fields a card can show stay, the rest go.
    expect(parseQuestions(interruptQuestions(i))!.questions.map((q) => [q.text, q.kind])).toEqual([['Note', 'text']])
    expect(resumeEntry(i, answered(i, { Note: 'hi' }), NOW)).toEqual({ interruptId: 'int-g', status: 'resolved', payload: { note: 'hi' } })
  })

  it('cancels an all-optional schema with nothing a card can show', () => {
    const i: AguiInterrupt = {
      id: 'int-n',
      reason: 'r',
      responseSchema: { type: 'object', properties: { editedArgs: { type: 'object' } } }
    }
    expect(interruptQuestions(i)).toBeNull()
    expect(resumeEntry(i, allowResponse('r', { questions: [], answers: {} }), NOW)).toEqual({ interruptId: 'int-n', status: 'cancelled' })
  })

  it('treats a property named __proto__ as a key while it prunes', () => {
    const optional = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"x":{"type":"object"}}}')
    expect(parseQuestions(interruptQuestions({ id: 'i', reason: 'r', responseSchema: optional }))!.questions.map((q) => q.text)).toEqual([
      '__proto__'
    ])
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object"},"ok":{"type":"boolean"}},"required":["ok"]}')
    const i: AguiInterrupt = { id: 'int-x', reason: 'r', responseSchema: schema }
    expect(parseQuestions(interruptQuestions(i))!.questions.map((q) => q.text)).toEqual(['ok'])
    expect(resumeEntry(i, answered(i, { ok: 'Yes' }), NOW)).toEqual({ interruptId: 'int-x', status: 'resolved', payload: { ok: true } })
    expect(({} as Record<string, unknown>).type).toBeUndefined()
  })

  it("leaves ACP's own mapping as it was: an optional object property still declines the form", () => {
    const params = { mode: 'form', message: 'Approve?', requestedSchema: PYDANTIC_SCHEMA }
    expect(elicitationQuestions(params)).toBeNull()
    expect(elicitationAnswer(allowResponse('r', { questions: [], answers: { approved: 'Yes' } }), params)).toEqual({ action: 'decline' })
  })
})

describe('isExpired and expiryOf', () => {
  it('reads expiresAt with Date.parse', () => {
    expect(expiryOf('2026-11-18T12:00:00Z')).toBe(NOW)
    expect(isExpired({ expiresAt: '2026-11-18T12:00:00Z' }, NOW)).toBe(true)
    expect(isExpired({ expiresAt: '2026-11-18T12:00:00.001Z' }, NOW)).toBe(false)
  })

  it('never expires a value that is not a date, or none', () => {
    for (const expiresAt of ['soon', '', null, undefined]) {
      expect(expiryOf(expiresAt)).toBeNull()
      expect(isExpired({ expiresAt }, NOW)).toBe(false)
    }
  })
})
