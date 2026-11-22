import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scriptBin } from '../support/chatFakeBin'
import { MATERIAL_RULE } from '@zumibot/shared/workflowTemplate'
import { removeDir } from '../support/platform'
import {
  BareCalls,
  CALL_FAILED,
  CALL_STOPPED,
  CALL_TIMED_OUT,
  CONDITION_SYSTEM,
  LLM_SYSTEM,
  NO_ANSWER,
  limitOf,
  llmArgs,
  conditionArgs
} from '../../src/core/workflows/bareCalls'

const FAKE = scriptBin(join(__dirname, '..', 'fixtures', 'fake-workflow-claude.mjs'))
let dir: string
let argsOut: string
let extraEnv: NodeJS.ProcessEnv

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bare-'))
  argsOut = join(dir, 'args.jsonl')
  extraEnv = {}
})
// A killed fake may still hold the folder as its cwd for a moment on Windows.
afterEach(() => removeDir(dir))

const make = (o: { max?: number; llmTimeoutMs?: number; conditionTimeoutMs?: number } = {}): BareCalls =>
  new BareCalls({
    bin: async () => FAKE,
    env: async () => ({ ...process.env, FAKE_WORKFLOW_ARGS_OUT: argsOut, ...extraEnv }),
    cwd: dir,
    ...o
  })
const started = (): number => (existsSync(argsOut) ? readFileSync(argsOut, 'utf8').trim().split('\n').filter(Boolean).length : 0)
const until = async (f: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25))
  expect(f()).toBe(true)
}
const sig = (): AbortSignal => new AbortController().signal

describe('BareCalls', () => {
  it('llm returns result text and cost', async () => {
    const r = await make().llm({ model: 'haiku', prompt: 'hello' }, sig())
    expect(r).toMatchObject({ ok: true, text: 'LLM:hello', id: 'fake-uuid' })
    if (r.ok) expect(r.cost?.totalUsd).toBe(0.01)
  })

  it('llmArgs adds --effort and keeps material rule after user system prompt', () => {
    const a = llmArgs('opus', 'high', 'Be terse.')
    expect(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
    const system = a[a.indexOf('--system-prompt') + 1]
    expect(system).toContain('Be terse.')
    expect(system.endsWith(MATERIAL_RULE)).toBe(true)
    expect(llmArgs('opus', undefined, undefined)).not.toContain('--effort')
    expect(llmArgs('opus', undefined, undefined).at(-1)).toBe(LLM_SYSTEM)
    expect(LLM_SYSTEM.endsWith(MATERIAL_RULE)).toBe(true)
    expect(conditionArgs('haiku').at(-1)).toBe(CONDITION_SYSTEM)
    expect(CONDITION_SYSTEM.endsWith(MATERIAL_RULE)).toBe(true)
  })

  it('condition yes and no', async () => {
    const c = make()
    expect(await c.condition({ model: 'haiku', prompt: 'is it? YES' }, sig())).toMatchObject({ ok: true, answer: 'yes', reason: 'fake' })
    expect(await c.condition({ model: 'haiku', prompt: 'is it? NO' }, sig())).toMatchObject({ ok: true, answer: 'no', reason: 'fake' })
  })

  it('condition without structured answer fails with fixed text', async () => {
    extraEnv = { FAKE_CONDITION_ANSWER: 'maybe' }
    expect(await make().condition({ model: 'haiku', prompt: 'x' }, sig())).toEqual({ ok: false, limit: null, error: NO_ANSWER })
  })

  it('limit result returns limit with resetsAt', async () => {
    const before = Date.now()
    const r = await make().llm({ model: 'haiku', prompt: '#LIMIT' }, sig())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.limit?.resetsAt).toBeGreaterThan(before)
      expect(r.limit?.resetsAt).toBeLessThan(before + 10_000)
      expect(r.error).not.toContain('limit')
    }
  })

  it('a context limit error is a plain failure, not a usage limit to wait out', async () => {
    expect(await make().llm({ model: 'haiku', prompt: '#CONTEXT' }, sig())).toEqual({ ok: false, limit: null, error: CALL_FAILED })
  })

  it('limitOf takes status 429 or the usage-limit wording only', () => {
    const reset = { rate_limit_info: { resetsAt: 1_800_000_000 } }
    expect(limitOf({ is_error: true, api_error_status: 429, result: 'Overloaded', ...reset })).toEqual({ resetsAt: 1_800_000_000_000 })
    expect(limitOf({ is_error: true, result: "You've hit your limit · resets 5pm" })).toEqual({ resetsAt: null })
    expect(limitOf({ is_error: true, result: 'Claude AI usage limit reached|1800000000' })).toEqual({ resetsAt: null })
    expect(limitOf({ is_error: true, result: 'Context limit reached' })).toBeNull()
    expect(limitOf({ is_error: true, result: 'API Error: 429 is not a status here', api_error_status: 500 })).toBeNull()
    expect(limitOf({ is_error: true, result: 'Rate limited by the proxy' })).toBeNull()
    expect(limitOf({ is_error: false, api_error_status: 429, result: 'fine' })).toBeNull()
  })

  it('timeout kills and returns fixed text', async () => {
    const r = await make({ llmTimeoutMs: 300 }).llm({ model: 'haiku', prompt: '#HANG' }, sig())
    expect(r).toEqual({ ok: false, limit: null, error: CALL_TIMED_OUT })
  })

  it('fifth call waits for a slot', async () => {
    const c = make({ max: 1 })
    const first = new AbortController()
    const p1 = c.llm({ model: 'haiku', prompt: '#HANG' }, first.signal)
    await until(() => started() === 1)
    const p2 = c.llm({ model: 'haiku', prompt: 'second' }, sig())
    await new Promise((r) => setTimeout(r, 300))
    expect(started()).toBe(1)
    first.abort()
    expect(await p1).toMatchObject({ ok: false, error: CALL_STOPPED })
    expect(await p2).toMatchObject({ ok: true, text: 'LLM:second' })
    expect(started()).toBe(2)
  })

  it('stopAll aborts running and queued', async () => {
    const c = make({ max: 1 })
    const p1 = c.llm({ model: 'haiku', prompt: '#HANG' }, sig())
    await until(() => started() === 1)
    const p2 = c.llm({ model: 'haiku', prompt: 'queued' }, sig())
    c.stopAll()
    expect(await p1).toEqual({ ok: false, limit: null, error: CALL_STOPPED })
    expect(await p2).toEqual({ ok: false, limit: null, error: CALL_STOPPED })
    expect(started()).toBe(1)
  })

  it('bare args never allow tools or settings', async () => {
    const c = make()
    await c.llm({ model: 'sonnet', prompt: 'a' }, sig())
    await c.condition({ model: 'haiku', prompt: 'b YES' }, sig())
    const runs = readFileSync(argsOut, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[])
    expect(runs).toHaveLength(2)
    for (const a of runs) {
      expect(a[a.indexOf('--tools') + 1]).toBe('')
      expect(a[a.indexOf('--setting-sources') + 1]).toBe('')
      expect(a).toContain('--strict-mcp-config')
      expect(a).toContain('--no-session-persistence')
      expect(a).not.toContain('--agent')
    }
    expect(runs[1]).toContain('--json-schema')
  })
})
