// The real-CLI mid-turn probe (e2e/steerProbe.mjs): its verdicts over the CLI's stream lines and its exit codes, checked
// without the real CLI or any quota (docs/architecture/mid-turn-messages.md).
import { expect, it, vi } from 'vitest'

// @ts-expect-error plain .mjs without types
const probe = (await import('../../e2e/steerProbe.mjs')) as {
  STEER_UUID: string
  classify(lines: string[]): { outcome: 'PASS' | 'FAILED' | 'INCONCLUSIVE'; reason: string | null }
  main(args?: string[], run?: () => Promise<{ outcome: string; version: string; reason: string | null }>): Promise<number>
}

// Lines shaped like claude 2.1.329's (stream-json in and out, --verbose, --replay-user-messages).
const j = (o: unknown) => JSON.stringify(o)
const init = j({ type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '9.9.9-fake' })
const prompt = j({ type: 'user', isReplay: true, uuid: '11111111-1111-4111-8111-111111111111', message: { role: 'user', content: 'go' } })
const toolUse = j({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 5' } }] }
})
const toolResult = j({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] }
})
const steer = () => j({ type: 'user', isReplay: true, uuid: probe.STEER_UUID, message: { role: 'user', content: 'also' } })
const text = j({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'BANANA' }] } })
const result = j({ type: 'result', subtype: 'success', is_error: false, result: 'BANANA', session_id: 's1' })

it('passes when the steer is echoed back inside the turn, before its one result', () => {
  expect(probe.classify([init, prompt, toolUse, toolResult, steer(), text, result])).toEqual({ outcome: 'PASS', reason: null })
})

it('fails when the CLI only takes the steer as a turn of its own, or never echoes it', () => {
  expect(probe.classify([init, prompt, toolUse, toolResult, text, result, init, steer(), text, result]).outcome).toBe('FAILED')
  expect(probe.classify([init, prompt, toolUse, toolResult, text, result]).outcome).toBe('FAILED')
})

it('is inconclusive without an init, or when the model ran no tool to steer during', () => {
  expect(probe.classify([prompt]).outcome).toBe('INCONCLUSIVE')
  expect(probe.classify([init, prompt, text, result]).outcome).toBe('INCONCLUSIVE')
})

it('exit codes: pass 0, failed 1, inconclusive 2 (0 with --soft), and the skip env', async () => {
  const as = (outcome: string) => async () => ({ outcome, version: '9.9.9', reason: outcome === 'PASS' ? null : 'why' })
  const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})]
  try {
    expect(await probe.main([], as('PASS'))).toBe(0)
    expect(await probe.main([], as('FAILED'))).toBe(1)
    expect(await probe.main(['--soft'], as('FAILED'))).toBe(1)
    expect(await probe.main([], as('INCONCLUSIVE'))).toBe(2)
    expect(await probe.main(['--soft'], as('INCONCLUSIVE'))).toBe(0)
    vi.stubEnv('ZUMIBOT_SKIP_STEER_PROBE', '1')
    expect(await probe.main([], as('FAILED'))).toBe(0)
  } finally {
    vi.unstubAllEnvs()
    quiet.forEach((q) => q.mockRestore())
  }
})
