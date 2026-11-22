import { describe, expect, test } from 'vitest'
import { ACP_ASK_MODE } from '@zumibot/shared/acp'
import { askHeld, askSwitch } from '../../src/core/acp/acpModes'

const modes = (current: string, ids: string[]) => ({
  modes: { currentModeId: current, availableModes: ids.map((id) => ({ id, name: id })) }
})
const option = (current: string, options: unknown[], extra: object = {}) => ({
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: current,
  options,
  ...extra
})
const flat = (values: string[]) => values.map((value) => ({ value, name: value }))

describe('askSwitch', () => {
  test('the asking mode is the id `default`', () => {
    expect(ACP_ASK_MODE).toBe('default')
  })

  test('a session in another mode, with `default` among its modes, is switched with session/set_mode', () => {
    for (const current of ['auto', 'acceptEdits', 'plan']) {
      expect(askSwitch(modes(current, ['default', 'acceptEdits', 'plan', 'auto']), [current])).toEqual({
        method: 'session/set_mode',
        params: { modeId: 'default' }
      })
    }
  })

  test("the Claude adapter's start (modes and the same mode as a config option) takes one set_config_option, on that option", () => {
    const res = { ...modes('auto', ['default', 'auto']), configOptions: [option('auto', flat(['default', 'auto']))] }
    expect(askSwitch(res, ['auto', 'auto'])).toEqual({
      method: 'session/set_config_option',
      params: { configId: 'mode', value: 'default' }
    })
  })

  test('a session already in `default` everywhere it reports a mode is left alone', () => {
    expect(askSwitch(modes('default', ['default', 'auto']), ['default'])).toBeNull()
    const res = { ...modes('default', ['default', 'auto']), configOptions: [option('default', flat(['default', 'auto']))] }
    expect(askSwitch(res, ['default', 'default'])).toBeNull()
  })

  test('only the control still off `default` is switched', () => {
    const optionOff = { ...modes('default', ['default', 'auto']), configOptions: [option('auto', flat(['default', 'auto']))] }
    expect(askSwitch(optionOff, ['default', 'auto'])).toEqual({
      method: 'session/set_config_option',
      params: { configId: 'mode', value: 'default' }
    })
    const modesOff = { ...modes('auto', ['default', 'auto']), configOptions: [option('default', flat(['default', 'auto']))] }
    expect(askSwitch(modesOff, ['auto', 'default'])).toEqual({ method: 'session/set_mode', params: { modeId: 'default' } })
    // A mode option that cannot take `default` leaves `modes` to do it.
    const optionWithout = { ...modes('auto', ['default', 'auto']), configOptions: [option('auto', flat(['auto', 'plan']))] }
    expect(askSwitch(optionWithout, ['auto', 'auto'])).toEqual({ method: 'session/set_mode', params: { modeId: 'default' } })
  })

  test('an agent that does not offer `default` keeps its own mode', () => {
    expect(askSwitch(modes('build', ['build', 'plan']), ['build'])).toBeNull()
    expect(askSwitch({ configOptions: [option('build', flat(['build', 'plan']))] }, ['build'])).toBeNull()
    expect(askSwitch({}, [])).toBeNull()
    expect(askSwitch(null, [])).toBeNull()
  })

  test('an agent with modes only as a config option is switched with session/set_config_option, on that option', () => {
    const res = {
      configOptions: [
        { id: 'model', category: 'model', currentValue: 'x', options: flat(['default', 'x']) },
        option('auto', flat(['default', 'auto']), { id: 'approval' })
      ]
    }
    expect(askSwitch(res, ['auto'])).toEqual({ method: 'session/set_config_option', params: { configId: 'approval', value: 'default' } })
  })

  test('grouped config option values are searched too', () => {
    const grouped = [
      { group: 'safe', name: 'Safe', options: flat(['default', 'plan']) },
      { group: 'fast', name: 'Fast', options: flat(['auto']) }
    ]
    expect(askSwitch({ configOptions: [option('auto', grouped)] }, ['auto'])).toEqual({
      method: 'session/set_config_option',
      params: { configId: 'mode', value: 'default' }
    })
  })

  test('a model option offering a `default` value is never taken for a mode', () => {
    const res = { configOptions: [{ id: 'model', category: 'model', currentValue: 'opus', options: flat(['default', 'opus']) }] }
    expect(askSwitch(res, [])).toBeNull()
  })

  test('a config option wins over `modes` when both offer `default`: the spec prefers config options', () => {
    const res = { ...modes('auto', ['default', 'auto']), configOptions: [option('auto', flat(['default', 'auto']), { id: 'other' })] }
    expect(askSwitch(res, ['auto', 'auto'])).toEqual({
      method: 'session/set_config_option',
      params: { configId: 'other', value: 'default' }
    })
  })

  test('malformed answers switch nothing and never throw', () => {
    for (const res of [
      { modes: 'auto' },
      { modes: { currentModeId: 'auto', availableModes: 'default' } },
      { modes: { currentModeId: 'auto', availableModes: [null, 7, { id: 7 }, { name: 'default' }] } },
      { configOptions: 'mode' },
      { configOptions: [null, { category: 'mode', currentValue: 'auto', options: [null, { value: 7 }, { group: 'g', options: 'x' }] }] },
      { configOptions: [{ category: 'mode', currentValue: 'auto', options: flat(['default']) }] } // no id to address it by
    ])
      expect(askSwitch(res, ['auto'])).toBeNull()
  })
})

describe('askHeld', () => {
  const setOption = { method: 'session/set_config_option', params: { configId: 'mode', value: 'default' } } as const
  const setMode = { method: 'session/set_mode', params: { modeId: 'default' } } as const

  test('set_config_option holds when its answer has the option at `default`, or says nothing of it', () => {
    expect(askHeld(setOption, { configOptions: [option('default', [])] })).toBe(true)
    for (const answer of [
      {},
      null,
      { configOptions: 'x' },
      { configOptions: [option('auto', [], { id: 'other' })] },
      { configOptions: [{ id: 'mode' }] }
    ]) {
      expect(askHeld(setOption, answer)).toBe(true)
    }
  })

  test('set_config_option does not hold when its answer has the option at another mode', () => {
    expect(askHeld(setOption, { configOptions: [option('auto', [])] })).toBe(false)
  })

  test('set_mode answers nothing to check', () => {
    expect(askHeld(setMode, {})).toBe(true)
    expect(askHeld(setMode, { configOptions: [option('auto', [])] })).toBe(true)
  })
})
