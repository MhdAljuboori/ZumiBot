import { expect, it } from 'vitest'
import { loadDesktopConfig } from '../../../src/core/desktop/config'

it('loads the spec defaults without starting anything', () => {
  expect(loadDesktopConfig({})).toEqual({
    max: 2,
    idleMs: 900000,
    leaseIdleMs: 120000,
    handoffIdleMs: 600000,
    commandMs: 30000,
    queueMs: 120000,
    width: 1280,
    height: 800
  })
})

it('reads every prefixed override', () => {
  expect(
    loadDesktopConfig({
      ZUMIBOT_DESKTOP_MAX: '8',
      ZUMIBOT_DESKTOP_IDLE_MS: '1000',
      ZUMIBOT_DESKTOP_LEASE_IDLE_MS: '2000',
      ZUMIBOT_DESKTOP_HANDOFF_IDLE_MS: '3000',
      ZUMIBOT_DESKTOP_COMMAND_MS: '4000',
      ZUMIBOT_DESKTOP_QUEUE_MS: '86400000',
      ZUMIBOT_DESKTOP_WIDTH: '1920',
      ZUMIBOT_DESKTOP_HEIGHT: '1080'
    })
  ).toEqual({ max: 8, idleMs: 1000, leaseIdleMs: 2000, handoffIdleMs: 3000, commandMs: 4000, queueMs: 86400000, width: 1920, height: 1080 })
  expect(loadDesktopConfig({ ZUMIBOT_DESKTOP_WIDTH: '640', ZUMIBOT_DESKTOP_HEIGHT: '480', ZUMIBOT_DESKTOP_MAX: '' })).toMatchObject({
    max: 2,
    width: 640,
    height: 480
  })
})

it.each(['MAX', 'IDLE_MS', 'LEASE_IDLE_MS', 'HANDOFF_IDLE_MS', 'COMMAND_MS', 'QUEUE_MS', 'WIDTH', 'HEIGHT'])(
  'rejects a malformed %s naming the variable, never the value',
  (name) => {
    const variable = `ZUMIBOT_DESKTOP_${name}`
    for (const value of ['0', '-1', '1.5', '1e3', 'Infinity', 'secret-token', ' 5', '999999999999999999999999']) {
      let error: unknown
      try {
        loadDesktopConfig({ [variable]: value })
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(variable)
      // The message names the bounds, so a lone digit can appear in it; anything longer must not.
      if (value.length > 1) expect((error as Error).message).not.toContain(value)
    }
  }
)

it.each([
  ['MAX', '9'],
  ['IDLE_MS', '86400001'],
  ['QUEUE_MS', '86400001'],
  ['COMMAND_MS', '86400001'],
  ['WIDTH', '4000'],
  ['WIDTH', '639'],
  ['HEIGHT', '1081'],
  ['HEIGHT', '479']
])('bounds %s (%s throws)', (name, value) => {
  expect(() => loadDesktopConfig({ [`ZUMIBOT_DESKTOP_${name}`]: value })).toThrow(`ZUMIBOT_DESKTOP_${name}`)
})
