import { describe, expect, it } from 'vitest'
import { aguiHeaders, keyUnusable } from '../../src/core/agui/aguiTurn'

const KEY = 'sk-remote-1'
const launch = (authHeader: string | null, authKey: string | null = 'AGENT_KEY') => ({
  endpoint: 'https://a.example.com/run',
  authKey,
  authHeader
})

describe('aguiHeaders', () => {
  it('sends Authorization: Bearer <value> with no header named, or one named authorization in any case', () => {
    for (const name of [null, 'authorization', 'Authorization', 'AUTHORIZATION']) {
      expect(aguiHeaders(launch(name), KEY)).toEqual({ Authorization: `Bearer ${KEY}` })
    }
  })
  it('sends the bare value under any other header, as written', () => {
    expect(aguiHeaders(launch('X-Api-Key'), KEY)).toEqual({ 'X-Api-Key': KEY })
  })
  it('sends nothing without a key, or with no value for it', () => {
    expect(aguiHeaders(launch(null, null), KEY)).toEqual({})
    expect(aguiHeaders(launch('X-Api-Key'), undefined)).toEqual({})
  })
})

describe('keyUnusable', () => {
  it('refuses every C0 control but HTAB, DEL and anything past Latin-1', () => {
    for (const c of ['\x00', '\x01', '\x08', '\n', '\x0b', '\r', '\x1f', '\x7f', 'Ā', '€', '😀'])
      expect(keyUnusable(`ab${c}cd`), JSON.stringify(c)).toBe(true)
  })
  it('takes printable ASCII, HTAB and Latin-1', () => {
    for (const v of ['sk-live_7f3a9c', 'a\tb', 'clé-ÿ', ' ~!', '']) expect(keyUnusable(v), JSON.stringify(v)).toBe(false)
  })
})
