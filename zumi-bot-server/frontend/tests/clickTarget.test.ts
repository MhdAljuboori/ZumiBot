import { describe, expect, it } from 'vitest'
import { clickUrl } from '../src/sw/clickTarget'

const run = { workflowId: 'w 1', runId: 'r1' }

describe('clickUrl', () => {
  it('message wins over run', () => {
    expect(clickUrl({ message: 'v1', run })).toBe('/inbox/v1')
  })

  it('run only gives the run URL', () => {
    expect(clickUrl({ run })).toBe('/workflows/w%201/runs/r1')
  })

  it('non-string message is ignored', () => {
    expect(clickUrl({ message: 5, run })).toBe('/workflows/w%201/runs/r1')
    expect(clickUrl({ message: 5 })).toBeNull()
  })

  it('nothing gives null', () => {
    expect(clickUrl(null)).toBeNull()
    expect(clickUrl(undefined)).toBeNull()
    expect(clickUrl({ chatId: 'c1' })).toBeNull()
    expect(clickUrl({ run: { workflowId: 'w1' } })).toBeNull()
  })
})

describe('clickUrl for a to-do card question', () => {
  it('opens the Inbox, where the card is answered', () => {
    expect(clickUrl({ chatId: 'c1', inbox: true })).toBe('/inbox')
    expect(clickUrl({ chatId: 'c1', inbox: false })).toBeNull()
  })
})
