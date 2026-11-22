import { describe, expect, it } from 'vitest'
import { joinGuards, type FormGuard } from '../src/state/formGuards'

const guard = (dirty: boolean, saves: boolean, log: string[], name: string): FormGuard => ({
  isDirty: () => dirty,
  save: async () => {
    log.push(name)
    return saves
  }
})

describe('joinGuards', () => {
  it('is dirty when any open form is, and clean with none open', () => {
    const log: string[] = []
    expect(joinGuards(() => [guard(false, true, log, 'a'), null, guard(true, true, log, 'b')]).isDirty()).toBe(true)
    expect(joinGuards(() => [guard(false, true, log, 'a'), undefined]).isDirty()).toBe(false)
    expect(joinGuards(() => []).isDirty()).toBe(false)
  })

  it('saves only the dirty forms, in order, and stops at the first that could not save', async () => {
    const log: string[] = []
    expect(await joinGuards(() => [guard(true, true, log, 'a'), guard(false, true, log, 'b'), guard(true, true, log, 'c')]).save()).toBe(
      true
    )
    expect(log).toEqual(['a', 'c'])
    log.length = 0
    expect(await joinGuards(() => [guard(true, false, log, 'a'), guard(true, true, log, 'b')]).save()).toBe(false)
    expect(log).toEqual(['a'])
  })

  it('reads the forms at call time, so one opened later counts', () => {
    const log: string[] = []
    let open: FormGuard | null = null
    const joined = joinGuards(() => [open])
    expect(joined.isDirty()).toBe(false)
    open = guard(true, true, log, 'late')
    expect(joined.isDirty()).toBe(true)
  })
})
