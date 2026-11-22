import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ApprovalStore } from '../../src/core/store/approvalStore'
import { agentAllowKey, ruleOf } from '../../src/core/chat/controlProtocol'
import type { AgentRule } from '@zumibot/shared/types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-approvals-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const rule = ruleOf('Bash', { command: 'date' })
const fresh = async () => {
  const s = new ApprovalStore(dir)
  await s.load()
  return s
}

describe('ApprovalStore', () => {
  it('add persists across reload and keeps one rule per key', async () => {
    const s = await fresh()
    await s.add('a', rule)
    await s.add('a', rule)
    const r = await fresh()
    expect(r.has('a', rule.key)).toBe(true)
    expect(r.list('a')).toEqual([rule])
  })
  it('does not leak across agents', async () => {
    const s = await fresh()
    await s.add('a', rule)
    expect(s.has('b', rule.key)).toBe(false)
  })
  it('remove drops the rule', async () => {
    const s = await fresh()
    await s.add('a', rule)
    await s.remove('a', rule.key)
    expect(s.has('a', rule.key)).toBe(false)
    expect((await fresh()).list('a')).toEqual([])
  })
  it('renameAgent updates memory synchronously and persists', async () => {
    const s = await fresh()
    await s.add('a', rule)
    const p = s.renameAgent('a', 'b')
    expect(s.has('b', rule.key)).toBe(true)
    expect(s.has('a', rule.key)).toBe(false)
    await p
    expect((await fresh()).has('b', rule.key)).toBe(true)
  })
  it('forgetAgents empties the agent', async () => {
    const s = await fresh()
    await s.add('a', rule)
    await s.forgetAgents(['a'])
    expect(s.list('a')).toEqual([])
    expect((await fresh()).list('a')).toEqual([])
  })
  it('agents lists the names that hold rules', async () => {
    const s = await fresh()
    await s.add('a', rule)
    await s.add('b', rule)
    await s.remove('b', rule.key)
    expect(s.agents()).toEqual(['a'])
  })
  it('corrupt file loads as no rules', async () => {
    await fs.writeFile(join(dir, 'approvals.json'), '{oops')
    expect((await fresh()).list('a')).toEqual([])
  })
})

describe('ApprovalStore CLI rules', () => {
  const RULE = 'Bash(git branch -D:*)'
  const cli: AgentRule = { key: JSON.stringify(['cli', RULE]), toolName: 'Bash', command: null, cli: RULE }

  it('round-trips through a reload and cliRules lists it in stored order', async () => {
    const s = await fresh()
    await s.add('a', rule)
    await s.add('a', cli)
    await s.add('a', { ...cli, key: JSON.stringify(['cli', 'Bash(rm x:*)']), cli: 'Bash(rm x:*)' })
    const r = await fresh()
    expect(r.cliRules('a')).toEqual([RULE, 'Bash(rm x:*)'])
    expect(r.cliRules('b')).toEqual([])
    expect(r.list('a')[1]).toEqual(cli)
  })
  it('never matches a real can_use_tool key', async () => {
    const s = await fresh()
    await s.add('a', cli)
    for (const input of [{ command: RULE }, { command: 'git branch -D x' }, { command: 'cli' }, {}]) {
      expect(s.has('a', agentAllowKey('Bash', input))).toBe(false)
    }
    expect(s.has('a', agentAllowKey('cli', { command: RULE }))).toBe(false)
  })
  it('renameAgent moves it and forgetAgents drops it', async () => {
    const s = await fresh()
    await s.add('a', cli)
    await s.renameAgent('a', 'b')
    expect(s.cliRules('a')).toEqual([])
    expect((await fresh()).cliRules('b')).toEqual([RULE])
    await s.forgetAgents(['b'])
    expect((await fresh()).cliRules('b')).toEqual([])
  })
  it('a file written before `cli` existed still loads', async () => {
    await fs.writeFile(join(dir, 'approvals.json'), JSON.stringify({ a: [rule] }))
    const s = await fresh()
    expect(s.list('a')).toEqual([rule])
    expect(s.cliRules('a')).toEqual([])
  })
  it('a rule whose cli is not a string is dropped', async () => {
    await fs.writeFile(join(dir, 'approvals.json'), JSON.stringify({ a: [{ ...rule, cli: 5 }, rule] }))
    expect((await fresh()).list('a')).toEqual([rule])
  })
})

describe('ApprovalStore read failures', () => {
  const file = () => join(dir, 'approvals.json')
  const eio = () => Object.assign(new Error('io'), { code: 'EIO' })
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  afterEach(() => vi.restoreAllMocks())

  it('moves a corrupt file aside and starts empty', async () => {
    await fs.writeFile(file(), '{oops')
    quiet()
    const s = await fresh()
    expect(s.list('a')).toEqual([])
    const kept = (await fs.readdir(dir)).filter((f) => f.startsWith('approvals.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(join(dir, kept[0]!), 'utf8')).toBe('{oops')
  })

  it('never replaces a file it could not read', async () => {
    await (await fresh()).add('a', rule)
    const before = await fs.readFile(file(), 'utf8')
    quiet()
    const read = vi.spyOn(fs, 'readFile').mockRejectedValue(eio())
    const s = await fresh()
    await expect(s.add('b', rule)).rejects.toThrow()
    read.mockRestore()
    expect(await fs.readFile(file(), 'utf8')).toBe(before)
  })

  it('reads again before the first write, keeping the stored rules and the new one', async () => {
    await (await fresh()).add('a', rule)
    quiet()
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(eio())
    const s = await fresh()
    expect(s.has('a', rule.key)).toBe(false)
    await s.add('b', rule)
    expect(s.has('a', rule.key)).toBe(true)
    const r = await fresh()
    expect(r.list('a')).toEqual([rule])
    expect(r.list('b')).toEqual([rule])
  })
})
