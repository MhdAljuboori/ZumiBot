import { describe, expect, it } from 'vitest'
import { CleanPoint } from '../../src/core/btw/cleanPoint'

describe('CleanPoint', () => {
  it('text-only entries are each clean', () => {
    const p = new CleanPoint()
    p.entry('a')
    p.entry('b')
    expect(p.get()).toBe('b')
  })

  it('an entry with an open tool call is not clean', () => {
    const p = new CleanPoint()
    p.entry('a')
    p.entry('b')
    p.toolUse('t1')
    expect(p.get()).toBe('a')
    p.entry('c')
    p.toolResult('t1')
    expect(p.get()).toBe('c')
  })

  it('parallel calls stay open until all results', () => {
    const p = new CleanPoint()
    p.entry('a')
    p.toolUse('t1')
    p.entry('b')
    p.toolUse('t2')
    p.entry('c')
    p.toolResult('t1')
    expect(p.get()).toBeNull()
    p.entry('d')
    p.toolResult('t2')
    expect(p.get()).toBe('d')
  })

  it('nothing yet', () => {
    expect(new CleanPoint().get()).toBeNull()
  })
})
