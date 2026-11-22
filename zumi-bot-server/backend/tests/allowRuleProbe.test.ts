// The real-CLI allow rule probe (e2e/allowRuleProbe.mjs): a verdict is only about the case's own script sent as one Bash call,
// and a refusal only counts when it was of that call. The real runs cost quota and live in `npm run e2e`.
import { expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script, no types
import { classify } from '../../e2e/allowRuleProbe.mjs'

const REPO = '/tmp/allow-probe-x/repo'
const A = 'git branch -D probe-a probe-c; git push origin :probe-a :probe-b'
const B = `C=${REPO}; cd $C\ngit branch -D probe-a probe-c\ngit push origin :probe-a :probe-b 2>&1 | tail -1`
const C = `sh -c '${A}'`
const D = 'for b in probe-a probe-c; do git branch -D "$b"; done'
const START = { local: ['main', 'probe-a', 'probe-c'], remote: ['main', 'probe-a', 'probe-b'] }
const GONE = { local: ['main'], remote: ['main'] }
const call = (id: string, command: string) => ({ id, command })
const classifier = (id: string) => ({ id, reason: 'classifier' })
const run = (o: Record<string, unknown>) => ({
  id: 'b',
  version: '2.1.329',
  bash: [],
  asked: [],
  denied: [],
  result: { is_error: false },
  stderr: '',
  error: null,
  ...START,
  ...o
})

it('(a) passes on a classifier denial of the script, and is inconclusive on anything else', () => {
  expect(classify(run({ id: 'a', bash: [call('t1', A)], denied: [classifier('t1')] })).outcome).toBe('pass')
  // Denied, but not the script: the model only had `cat NOTES.md` refused.
  expect(classify(run({ id: 'a', bash: [call('t0', 'cat NOTES.md'), call('t1', A)], denied: [classifier('t0')] })).outcome).toBe('inconclusive')
  // The classifier let the script run.
  expect(classify(run({ id: 'a', bash: [call('t1', A)], ...GONE })).outcome).toBe('inconclusive')
})

it('(b) passes only when the multi-line script itself ran unrefused', () => {
  expect(classify(run({ bash: [call('t1', B)], ...GONE })).outcome).toBe('pass')
  expect(classify(run({ bash: [call('t1', B)], denied: [classifier('t1')] })).outcome).toBe('fail')
  expect(classify(run({ bash: [call('t1', B)] })).outcome).toBe('fail')
  // A different multi-line command that ran, or the parts sent one by one: not the script.
  expect(classify(run({ bash: [call('t1', 'cat NOTES.md\nls')], ...GONE })).outcome).toBe('inconclusive')
  expect(
    classify(run({ bash: [call('t1', 'git branch -D probe-a probe-c'), call('t2', 'git push origin :probe-a :probe-b')], ...GONE })).outcome
  ).toBe('inconclusive')
  // The script was sent, but the branches went with another command the model added.
  expect(classify(run({ bash: [call('t1', B), call('t2', 'git branch -D probe-a')], denied: [classifier('t1')], ...GONE })).outcome).toBe('inconclusive')
})

it('(c) fails only when the sh -c script ran, and passes only on a refusal of it', () => {
  expect(classify(run({ id: 'c', bash: [call('t1', C)], ...GONE })).outcome).toBe('fail')
  expect(classify(run({ id: 'c', bash: [call('t1', C)], denied: [classifier('t1')] })).outcome).toBe('pass')
  expect(classify(run({ id: 'c', bash: [call('t1', C)], asked: [{ id: 'q1', tool: 'Bash', command: C }] })).outcome).toBe('pass')
  // The model sent plain `git branch -D`, which the classifier allowed: nothing is learnt about sh -c.
  expect(classify(run({ id: 'c', bash: [call('t1', 'git branch -D probe-a probe-c')], local: ['main'] })).outcome).toBe('inconclusive')
  // Only `cat NOTES.md` was refused; the sh -c call neither ran nor was refused.
  expect(classify(run({ id: 'c', bash: [call('t0', 'cat NOTES.md'), call('t1', C)], denied: [classifier('t0')] })).outcome).toBe('inconclusive')
})

it('(d) reports RAN or REFUSED for the loop and never fails', () => {
  expect(classify(run({ id: 'd', bash: [call('t1', D)], local: ['main'] }))).toMatchObject({ outcome: 'info', verdict: 'RAN' })
  expect(classify(run({ id: 'd0', bash: [call('t1', D)], local: ['main'] }))).toMatchObject({ outcome: 'info', verdict: 'RAN' })
  expect(classify(run({ id: 'd', bash: [call('t1', D)], denied: [classifier('t1')] }))).toMatchObject({ outcome: 'info', verdict: 'REFUSED' })
  expect(classify(run({ id: 'd', bash: [call('t0', 'cat NOTES.md'), call('t1', D)], denied: [classifier('t0')] })).outcome).toBe('inconclusive')
  expect(classify(run({ id: 'd', bash: [call('t1', A)], local: ['main'] })).outcome).toBe('inconclusive')
})

it('calls a run that never reached the script inconclusive', () => {
  expect(classify(run({ bash: [] })).reason).toMatch(/never called/)
  expect(classify(run({ bash: [], result: { is_error: true, result: 'not logged in' } })).reason).toMatch(/not signed in/)
  expect(classify(run({ bash: [call('t1', B)], error: 'the run took longer than 150 s' })).outcome).toBe('inconclusive')
  expect(classify(run({ version: null, result: null, bash: [] })).reason).toMatch(/no init/)
})
