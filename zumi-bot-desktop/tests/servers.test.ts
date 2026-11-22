import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadLastTheme,
  loadServerChoice,
  localRunsInWsl,
  parseServerChoice,
  saveLastTheme,
  saveServerChoice
} from '../src/main/servers'

describe('parseServerChoice', () => {
  it("accepts {kind:'vps', url:'https://zumibot-server.mhdaljuboori.me'}", () => {
    expect(parseServerChoice({ kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me' })).toEqual({
      kind: 'vps',
      url: 'https://zumibot-server.mhdaljuboori.me'
    })
  })

  it('accepts local, and drops extra fields', () => {
    expect(parseServerChoice({ kind: 'local', url: 'https://x.test' })).toEqual({ kind: 'local', port: 4318 })
  })

  it('keeps a valid local port and rejects the rest', () => {
    expect(parseServerChoice({ kind: 'local', port: 5000 })).toEqual({ kind: 'local', port: 5000 })
    for (const port of [80, '5000', 70000, 1023, 5000.5, null]) expect(parseServerChoice({ kind: 'local', port })).toBeNull()
  })

  it('normalises a trailing slash to the bare origin', () => {
    expect(parseServerChoice({ kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me/' })).toEqual({
      kind: 'vps',
      url: 'https://zumibot-server.mhdaljuboori.me'
    })
  })

  it('rejects a url with a path', () => {
    expect(parseServerChoice({ kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me/app' })).toBeNull()
    expect(parseServerChoice({ kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me/?a=1' })).toBeNull()
    expect(parseServerChoice({ kind: 'vps', url: 'https://u:p@zumibot-server.mhdaljuboori.me' })).toBeNull()
  })

  it('rejects http://example.com', () => {
    expect(parseServerChoice({ kind: 'vps', url: 'http://example.com' })).toBeNull()
    expect(parseServerChoice({ kind: 'vps', url: 'http://127.0.0.1:8080' })).toBeNull() // packaged: no loopback http
  })

  it('allows loopback http only when asked (unpackaged dev)', () => {
    expect(parseServerChoice({ kind: 'vps', url: 'http://127.0.0.1:8080' }, { allowLoopbackHttp: true })).toEqual({
      kind: 'vps',
      url: 'http://127.0.0.1:8080'
    })
    expect(parseServerChoice({ kind: 'vps', url: 'http://localhost:8080' }, { allowLoopbackHttp: true })).not.toBeNull()
    expect(parseServerChoice({ kind: 'vps', url: 'http://example.com' }, { allowLoopbackHttp: true })).toBeNull()
  })

  it('runs local mode in WSL only on Windows, and only when asked', () => {
    expect(localRunsInWsl('linux')).toBe(false)
    expect(localRunsInWsl('darwin')).toBe(false)
    // Windows runs natively; WSL2 only when asked for.
    expect(localRunsInWsl('win32', {})).toBe(false)
    expect(localRunsInWsl('win32', { ZUMIBOT_LOCAL_WSL: '1' })).toBe(true)
    expect(localRunsInWsl('linux', { ZUMIBOT_LOCAL_WSL: '1' })).toBe(false)
  })

  it('rejects garbage → null', () => {
    for (const raw of [
      null,
      undefined,
      5,
      'x',
      [],
      {},
      { kind: 'vps' },
      { kind: 'vps', url: 3 },
      { kind: 'other' },
      { kind: 'vps', url: 'nope' }
    ]) {
      expect(parseServerChoice(raw)).toBeNull()
    }
  })
})

describe('server.json', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-servers-'))
    file = join(dir, 'server.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips through the file', () => {
    saveServerChoice(file, { kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me' })
    expect(loadServerChoice(file)).toEqual({ kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me' })
    saveServerChoice(file, { kind: 'local', port: 5123 })
    expect(loadServerChoice(file)).toEqual({ kind: 'local', port: 5123 })
  })

  it('is null when the file is missing or corrupt', () => {
    expect(loadServerChoice(file)).toBeNull()
    writeFileSync(file, '{nope')
    expect(loadServerChoice(file)).toBeNull()
  })

  it('keeps lastTheme across choice saves, and ignores a bad one', () => {
    saveServerChoice(file, { kind: 'local', port: 4318 })
    saveLastTheme(file, 'dark')
    expect(loadLastTheme(file)).toBe('dark')
    saveServerChoice(file, { kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me' })
    expect(loadLastTheme(file)).toBe('dark')
    expect(loadServerChoice(file)).toEqual({ kind: 'vps', url: 'https://zumibot-server.mhdaljuboori.me' })
    writeFileSync(file, JSON.stringify({ kind: 'local', lastTheme: 'neon' }))
    expect(loadLastTheme(file)).toBeNull()
  })

  it('saving a theme before any choice does not invent a choice', () => {
    saveLastTheme(file, 'light')
    expect(loadServerChoice(file)).toBeNull()
    expect(loadLastTheme(file)).toBe('light')
  })
})
