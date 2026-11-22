import { describe, expect, it } from 'vitest'
import { AUDIT_INPUT_MAX } from '@zumibot/shared/audit'
import { FILL_TOOL } from '@zumibot/shared/vault'
import { cutJson, maskSecretShapes, redactAnswer, redactError, redactInput } from '../../../src/core/audit/auditRedact'

const none = new Map<string, string>()
const vault = new Map([['hunter2-very-secret', '[vault: Bank]']])

describe('audit redaction', () => {
  it('tags vault values in inputs, errors and answers', () => {
    expect(redactInput('Bash', { command: 'curl -u me:hunter2-very-secret x' }, vault).input).toEqual({
      command: 'curl -u me:[vault: Bank] x'
    })
    expect(redactError('Bash', 'bad hunter2-very-secret', vault)).toBe('bad [vault: Bank]')
    expect(redactAnswer({ answers: { q: 'hunter2-very-secret' } }, vault)).toEqual({ answers: { q: '[vault: Bank]' } })
  })

  it('stores browser input as {} and browser and desktop errors as fixed lines', () => {
    expect(redactInput('mcp__zumibot_browser__browser_type', { text: 'my password' }, none).input).toEqual({})
    expect(redactError('mcp__zumibot_browser__browser_click', 'page text here', none)).toBe('Browser command failed.')
    expect(redactError('mcp__zumibot_desktop__desktop_click', 'screen text', none)).toBe('Desktop command failed.')
  })

  it('keeps desktop input but typed text only as its length', () => {
    expect(redactInput('mcp__zumibot_desktop__desktop_type', { text: 'pässword', window: 3 }, none).input).toEqual({
      text: '<8 chars>',
      window: 3
    })
    expect(redactInput('mcp__zumibot_desktop__desktop_click', { x: 1, y: 2 }, none).input).toEqual({ x: 1, y: 2 })
  })

  it('a vault fill is stored as its row shows it, or {} without the row helper', () => {
    expect(
      redactInput(FILL_TOOL, { item: 'id1', field: 'password', stamp: 's' }, none, () => ({ item: 'Bank', field: 'password' })).input
    ).toEqual({ item: 'Bank', field: 'password' })
    expect(redactInput(FILL_TOOL, { item: 'id1' }, none).input).toEqual({})
  })

  it('masks known secret shapes that never came from the vault', () => {
    for (const s of [
      'sk-ant-api03-abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'github_pat_11ABCDEFG0123456789abcdef',
      'xoxb-1234567890-abcdef',
      'AKIAABCDEFGHIJKLMNOP',
      'sk-proj-abcdefghijklmnopqrstuv'
    ]) {
      expect(maskSecretShapes(`x ${s} y`)).toBe('x [secret] y')
    }
    expect(maskSecretShapes('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer [secret]')
    expect(maskSecretShapes('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('[secret]')
    expect(maskSecretShapes('sk-short and normal text')).toBe('sk-short and normal text')
  })

  it('cuts long input to valid JSON under the cap and notes the original length', () => {
    const big = { command: 'x'.repeat(AUDIT_INPUT_MAX * 2), note: 'keep' }
    const r = redactInput('Bash', big, none)
    expect(r.inputCut).toBe(JSON.stringify(big).length)
    const json = JSON.stringify(r.input)
    expect(json.length).toBeLessThanOrEqual(AUDIT_INPUT_MAX)
    expect((r.input as { note: string }).note).toBe('keep')
    expect((r.input as { command: string }).command).toMatch(/…\[cut \d+ chars\]$/)
    expect(redactInput('Bash', { command: 'ls' }, none).inputCut).toBeNull()
    expect(cutJson({ a: 'b' }, 100)).toBeNull()
    // Many short strings: the head of the JSON as one string, still under the cap.
    const many = Array.from({ length: 5000 }, (_, i) => `v${i}`)
    const cut = cutJson(many, 1000)!
    expect(JSON.stringify(cut.value).length).toBeLessThanOrEqual(1000)
  })
})
