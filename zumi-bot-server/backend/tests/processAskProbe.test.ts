// The real-CLI process ask probe (e2e/processAskProbe.mjs): its settings are the app's byte for byte, and only a start that ran
// without a can_use_tool fails it. The real runs cost quota and live in `npm run e2e`.
import { expect, it } from 'vitest'
import { PROCESS_ASK_SETTINGS } from '../src/core/processes/processTools'
// @ts-expect-error a plain .mjs script, no types
import { classify, PROCESS_ASK_SETTINGS as PROBE_SETTINGS } from '../../e2e/processAskProbe.mjs'

const START = 'mcp__zumibot_processes__start'
const run = (o: Record<string, unknown>) => ({
  mode: 'auto',
  version: '2.1.326',
  server: 'connected',
  asked: [],
  attempted: [],
  refused: [],
  ran: [],
  result: { is_error: false },
  stderr: '',
  error: null,
  ...o
})

it("passes the app's own ask rule", () => {
  expect(PROBE_SETTINGS).toBe(PROCESS_ASK_SETTINGS)
})

it('fails only a start that ran unasked, and calls anything that proves nothing inconclusive', () => {
  expect(classify(run({ asked: [START], ran: ['start', 'list'], attempted: [{ id: 'a', name: START }] })).outcome).toBe('pass')
  expect(classify(run({ asked: [], ran: ['start'], attempted: [{ id: 'a', name: START }] })).outcome).toBe('fail')
  expect(classify(run({ asked: [START], ran: ['start', 'start'] })).outcome).toBe('fail')
  expect(classify(run({ attempted: [] })).reason).toMatch(/never called/)
  expect(classify(run({ attempted: [{ id: 'a', name: START }], refused: ['a'] })).reason).toMatch(/refused by the CLI itself/)
  expect(classify(run({ server: 'failed' })).reason).toMatch(/did not connect/)
})
