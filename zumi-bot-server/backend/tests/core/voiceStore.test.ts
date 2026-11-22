import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CLEAN, DEFAULT_TALK } from '@zumibot/shared/voice'
import { VoiceStore } from '../../src/core/voice/voiceStore'

let dir: string
let store: VoiceStore
const file = () => join(dir, 'voice.json')

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-voice-store-'))
  store = new VoiceStore(dir)
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

describe('VoiceStore', () => {
  it('defaults to enabled with no key', async () => {
    expect(await store.status()).toEqual({
      on: false,
      enabled: true,
      keySaved: false,
      talk: DEFAULT_TALK,
      talkOn: false,
      clean: DEFAULT_CLEAN
    })
    expect(await store.key()).toBeNull()
  })

  it('saves the key 0600 and never returns it in status', async () => {
    const status = await store.set({ key: 'sk-or-abc' })
    expect(status).toEqual({ on: true, enabled: true, keySaved: true, talk: DEFAULT_TALK, talkOn: true, clean: DEFAULT_CLEAN })
    expect(JSON.stringify(status)).not.toContain('sk-or-abc')
    expect(JSON.stringify(await store.status())).not.toContain('sk-or-abc')
    if (process.platform !== 'win32') expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
    expect(await store.key()).toBe('sk-or-abc')
  })

  it('removes the key', async () => {
    await store.set({ key: 'sk-or-abc' })
    const status = await store.set({ key: null })
    expect(status.keySaved).toBe(false)
    expect(status.on).toBe(false)
    expect(await store.key()).toBeNull()
  })

  it('the switch turns it off without dropping the key', async () => {
    await store.set({ key: 'sk-or-abc' })
    const status = await store.set({ enabled: false })
    expect(status).toEqual({ on: false, enabled: false, keySaved: true, talk: DEFAULT_TALK, talkOn: false, clean: DEFAULT_CLEAN })
    expect(await store.key()).toBe('sk-or-abc')
  })

  it('a corrupt or odd file reads as defaults', async () => {
    await fs.writeFile(file(), '{nope')
    expect(await store.status()).toEqual({
      on: false,
      enabled: true,
      keySaved: false,
      talk: DEFAULT_TALK,
      talkOn: false,
      clean: DEFAULT_CLEAN
    })
    await fs.writeFile(file(), JSON.stringify({ enabled: 'yes', key: 5 }))
    expect(await store.status()).toEqual({
      on: false,
      enabled: true,
      keySaved: false,
      talk: DEFAULT_TALK,
      talkOn: false,
      clean: DEFAULT_CLEAN
    })
    expect(await store.key()).toBeNull()
  })

  it('reads an old file without talk as the default talk settings', async () => {
    await fs.writeFile(file(), JSON.stringify({ enabled: true, key: 'sk-or-abc' }))
    const status = await store.status()
    expect(status.talk).toEqual(DEFAULT_TALK)
    expect(status.talkOn).toBe(true)
  })

  it('reads a partly wrong talk field by field', async () => {
    await fs.writeFile(
      file(),
      JSON.stringify({
        enabled: true,
        key: 'k',
        talk: { enabled: 'no', defaultAgent: 'bob', aliases: { a: ['x'], b: 'bad', c: [5, 'ok', ''] } }
      })
    )
    expect((await store.status()).talk).toEqual({ enabled: true, defaultAgent: 'bob', aliases: { a: ['x'], c: ['ok'] } })
    await fs.writeFile(file(), JSON.stringify({ enabled: true, key: 'k', talk: 7 }))
    expect((await store.status()).talk).toEqual(DEFAULT_TALK)
    await fs.writeFile(file(), JSON.stringify({ enabled: true, key: 'k', talk: { defaultAgent: null, aliases: [] } }))
    expect((await store.status()).talk).toEqual({ enabled: true, defaultAgent: null, aliases: {} })
  })

  it('talk is on only when voice is on and talk is enabled', async () => {
    await store.set({ key: 'k', talk: { enabled: false } })
    expect((await store.status()).talkOn).toBe(false)
    expect((await store.set({ talk: { enabled: true } })).talkOn).toBe(true)
    expect((await store.set({ enabled: false })).talkOn).toBe(false)
  })

  it('reads an old file without clean as both switches off', async () => {
    await fs.writeFile(file(), JSON.stringify({ enabled: true, key: 'k' }))
    expect((await store.status()).clean).toEqual({ fillers: false, rewrite: false })
    expect(await store.clean()).toEqual({ fillers: false, rewrite: false })
  })

  it('reads a partly wrong clean field by field', async () => {
    await fs.writeFile(file(), JSON.stringify({ enabled: true, key: 'k', clean: { fillers: 'x', rewrite: true } }))
    expect(await store.clean()).toEqual({ fillers: false, rewrite: true })
  })

  it('a clean patch keeps the switch it does not name, and the key and talk', async () => {
    await store.set({ key: 'k', talk: { defaultAgent: 'x' } })
    await store.set({ clean: { rewrite: true } })
    const status = await store.set({ clean: { fillers: true } })
    expect(status.clean).toEqual({ fillers: true, rewrite: true })
    expect(status.talk.defaultAgent).toBe('x')
    expect(await store.key()).toBe('k')
    expect(await store.clean()).toEqual({ fillers: true, rewrite: true })
  })

  it('an old file with a spoken voice still loads, and the key is dropped on the next write', async () => {
    await fs.writeFile(
      join(dir, 'voice.json'),
      JSON.stringify({ enabled: true, key: null, talk: { ttsVoice: 'elevenlabs', defaultAgent: 'x' } })
    )
    expect((await store.status()).talk).toEqual({ enabled: true, defaultAgent: 'x', aliases: {} })
    await store.set({ enabled: true })
    expect(JSON.parse(await fs.readFile(join(dir, 'voice.json'), 'utf8')).talk).toEqual({ enabled: true, defaultAgent: 'x', aliases: {} })
  })

  it('a talk patch keeps the fields it does not name', async () => {
    await store.set({ talk: { aliases: { 'work-assistant': ['مساعد العمل'] } } })
    const status = await store.set({ talk: { defaultAgent: 'x' } })
    expect(status.talk).toEqual({ enabled: true, defaultAgent: 'x', aliases: { 'work-assistant': ['مساعد العمل'] } })
    expect((await store.set({ key: 'k2' })).talk).toEqual(status.talk)
  })

  it('renameAgent moves the default agent and the alias key, keeping order', async () => {
    await store.set({ key: 'k', talk: { defaultAgent: 'old', aliases: { a: ['1'], old: ['x', 'y'], z: ['2'] } } })
    const status = await store.renameAgent('old', 'new')
    expect(status?.talk.defaultAgent).toBe('new')
    expect(Object.entries(status!.talk.aliases)).toEqual([
      ['a', ['1']],
      ['new', ['x', 'y']],
      ['z', ['2']]
    ])
    expect((await store.status()).talk).toEqual(status!.talk)
    expect(await store.key()).toBe('k')
  })

  it('renameAgent merges into aliases the new name already has, without duplicates', async () => {
    await store.set({ talk: { aliases: { old: ['x', 'shared'], new: ['shared', 'n'] } } })
    const status = await store.renameAgent('old', 'new')
    expect(status?.talk.aliases).toEqual({ new: ['x', 'shared', 'n'] })
  })

  it('renameAgent changes nothing and answers null when the agent is not mentioned', async () => {
    await store.set({ talk: { defaultAgent: 'other', aliases: { a: ['1'] } } })
    expect(await store.renameAgent('old', 'new')).toBeNull()
    expect((await store.status()).talk).toEqual({ enabled: true, defaultAgent: 'other', aliases: { a: ['1'] } })
  })

  it('the key never appears in status, and the file stays 0600 with talk saved', async () => {
    await store.set({ key: 'sk-or-secret', talk: { defaultAgent: 'x' } })
    expect(JSON.stringify(await store.status())).not.toContain('sk-or-secret')
    if (process.platform !== 'win32') expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
  })
})
