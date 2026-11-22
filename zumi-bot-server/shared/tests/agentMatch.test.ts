import { describe, expect, it } from 'vitest'
import { matchAgent } from '../src/agentMatch'

const agents = [
  { name: 'work-assistant', error: null },
  { name: 'zumi-bot', error: null },
  { name: 'broken-one', error: 'bad frontmatter' },
  { name: 'twin-a', error: null },
  { name: 'Twin A', error: null }
]

describe('matchAgent', () => {
  it('finds an agent by spoken display name, with a leading @', () => {
    expect(matchAgent('@Work Assistant', agents)).toEqual({ ok: true, name: 'work-assistant' })
  })

  it('takes the exact name first, and collapses whitespace', () => {
    expect(matchAgent('  work-assistant ', agents)).toEqual({ ok: true, name: 'work-assistant' })
    expect(matchAgent('work   assistant', agents)).toEqual({ ok: true, name: 'work-assistant' })
  })

  it('never returns Zumi Bot, by name or display name', () => {
    expect(matchAgent('zumi bot', agents)).toEqual({ ok: false, reason: 'zumi-bot' })
    expect(matchAgent('zumi-bot', agents)).toEqual({ ok: false, reason: 'zumi-bot' })
  })

  it('treats a broken agent as unknown', () => {
    expect(matchAgent('broken one', agents)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('treats a missing agent as unknown', () => {
    expect(matchAgent('nobody', agents)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('treats two agents with the same display name as unknown', () => {
    expect(matchAgent('twin a', agents)).toEqual({ ok: false, reason: 'unknown' })
  })
})
