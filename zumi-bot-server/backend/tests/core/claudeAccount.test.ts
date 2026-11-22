import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { AccountService, claudeConfigFile, parseCachedUsage, parseProfile, planLabel } from '../../src/core/claudeAccount'

const UUID = 'acc-1'
const oauthAccount = { accountUuid: UUID, emailAddress: 'me@x.io', displayName: 'Mo', fullName: 'Mo Al', organizationType: 'claude_pro' }
const cached = (fetchedAtMs: number, accountUuid = UUID) => ({
  fetchedAtMs,
  accountUuid,
  utilization: {
    five_hour: { utilization: 42, resets_at: '2026-10-23T19:00:00.338532+00:00' },
    seven_day: { utilization: 34, resets_at: '2026-10-30T03:00:00+00:00' },
    seven_day_opus: null
  }
})

let dir: string
let now: number
let configFile: string
let usageFile: string
const service = () => new AccountService({ configFile, usageFile, osUser: () => 'osuser', now: () => now })
const writeConfig = (c: unknown) => fs.writeFile(configFile, JSON.stringify(c))

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-account-'))
  configFile = join(dir, '.claude.json')
  usageFile = join(dir, 'userData', 'usage.json')
  now = 1_000
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('claudeConfigFile', () => {
  it('follows CLAUDE_CONFIG_DIR, else the home folder', () => {
    expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: '/c' })).toBe(join('/c', '.claude.json'))
    expect(claudeConfigFile({})).toBe(join(os.homedir(), '.claude.json'))
  })
})

describe('planLabel', () => {
  it('names claude_ organization types', () => {
    expect(planLabel('claude_pro')).toBe('Pro')
    expect(planLabel('claude_max')).toBe('Max')
    expect(planLabel('claude_team_plus')).toBe('Team Plus')
    for (const v of ['api', '', null, 3, 'claude_']) expect(planLabel(v)).toBeNull()
  })
})

describe('parseProfile', () => {
  it('prefers the display name, then the full name, then the email', () => {
    expect(parseProfile({ oauthAccount })).toEqual({ uuid: UUID, email: 'me@x.io', name: 'Mo', plan: 'Pro' })
    expect(parseProfile({ oauthAccount: { ...oauthAccount, displayName: ' ' } })?.name).toBe('Mo Al')
    expect(parseProfile({ oauthAccount: { ...oauthAccount, displayName: null, fullName: undefined } })?.name).toBe('me@x.io')
  })
  it('is null when not signed in to a Claude account', () => {
    for (const c of [
      null,
      {},
      { oauthAccount: null },
      { oauthAccount: { accountUuid: UUID } },
      { oauthAccount: { emailAddress: 'a@b' } }
    ]) {
      expect(parseProfile(c)).toBeNull()
    }
  })
})

describe('parseCachedUsage', () => {
  it('reads Claude Code’s cached usage as percent and epoch ms', () => {
    expect(parseCachedUsage({ cachedUsageUtilization: cached(500) })).toEqual({
      session: { percent: 42, resetsAt: Date.parse('2026-10-23T19:00:00.338Z') },
      weekly: { percent: 34, resetsAt: Date.parse('2026-10-30T03:00:00Z') },
      updatedAt: 500,
      accountUuid: UUID
    })
  })
  it('skips windows it cannot read, and is null with none', () => {
    const u = cached(500)
    expect(
      parseCachedUsage({ cachedUsageUtilization: { ...u, utilization: { ...u.utilization, five_hour: { utilization: 'x' } } } })?.session
    ).toBeNull()
    expect(
      parseCachedUsage({ cachedUsageUtilization: { ...u, utilization: { five_hour: { utilization: 7, resets_at: 'soon' } } } })
    ).toMatchObject({
      session: { percent: 7, resetsAt: null },
      weekly: null
    })
    for (const c of [{}, { cachedUsageUtilization: { ...u, fetchedAtMs: 'x' } }, { cachedUsageUtilization: { ...u, utilization: {} } }]) {
      expect(parseCachedUsage(c)).toBeNull()
    }
  })
})

describe('AccountService', () => {
  const reading = { session: { percent: 15, resetsAt: 9_000 }, weekly: { percent: 21, resetsAt: 99_000 } }

  it('falls back to the OS user when claude is not signed in', async () => {
    expect(await service().account()).toEqual({ name: 'osuser', email: null, plan: null, usage: null })
    await writeConfig({ oauthAccount: { accountUuid: UUID } })
    expect((await service().account()).name).toBe('osuser')
  })

  it('uses Claude Code’s cached usage when no chat turn has been seen', async () => {
    await writeConfig({ oauthAccount, cachedUsageUtilization: cached(500) })
    expect(await service().account()).toMatchObject({
      name: 'Mo',
      email: 'me@x.io',
      plan: 'Pro',
      usage: { updatedAt: 500, session: { percent: 42 } }
    })
  })

  it('a newer chat turn wins over the cache, is kept across restarts, and loses to a newer cache', async () => {
    await writeConfig({ oauthAccount, cachedUsageUtilization: cached(500) })
    await service().record(reading)
    expect((await service().account()).usage).toEqual({ ...reading, updatedAt: 1_000 })
    await writeConfig({ oauthAccount, cachedUsageUtilization: cached(2_000) })
    expect((await service().account()).usage).toMatchObject({ updatedAt: 2_000, session: { percent: 42 } })
  })

  it('drops usage seen for another account', async () => {
    await writeConfig({ oauthAccount: { ...oauthAccount, accountUuid: 'other' }, cachedUsageUtilization: cached(500) })
    const s = service()
    await s.record(reading)
    await writeConfig({ oauthAccount, cachedUsageUtilization: cached(500, 'other') })
    expect((await s.account()).usage).toBeNull()
  })

  it('keeps the latest of quick readings, in the order they came', async () => {
    await writeConfig({ oauthAccount })
    const s = service()
    void s.record({ session: { percent: 1, resetsAt: null }, weekly: null })
    now = 2_000
    await s.record({ session: { percent: 2, resetsAt: null }, weekly: null })
    expect((await s.account()).usage).toEqual({ session: { percent: 2, resetsAt: null }, weekly: null, updatedAt: 2_000 })
    expect((await service().account()).usage?.updatedAt).toBe(2_000)
  })

  it('ignores a broken usage file and a failed save', async () => {
    await writeConfig({ oauthAccount })
    await fs.mkdir(join(dir, 'userData'))
    await fs.writeFile(usageFile, '{not json')
    expect((await service().account()).usage).toBeNull()
    const blocked = new AccountService({ configFile, usageFile: join(configFile, 'usage.json'), osUser: () => 'u', now: () => now })
    await expect(blocked.record(reading)).resolves.toBeUndefined()
    expect((await blocked.account()).usage).toEqual({ ...reading, updatedAt: 1_000 })
  })
})

describe('Codex readings never reach the Claude account', () => {
  it('only an untagged event is recorded by the Claude hook', async () => {
    const { claudeUsageOf } = await import('../../src/core/claudeAccount')
    const w = { percent: 5, resetsAt: null }
    expect(claudeUsageOf({ kind: 'rateLimit', session: w, weekly: null })).toEqual({ session: w, weekly: null })
    expect(claudeUsageOf({ kind: 'rateLimit', provider: 'codex', session: w, weekly: null })).toBeNull()
  })
})
