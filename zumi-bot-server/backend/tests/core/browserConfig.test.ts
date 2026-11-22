import { expect, it } from 'vitest'
import { loadBrowserConfig } from '../../src/core/browser/config'

it('loads bounded defaults without starting a browser', () => {
  expect(loadBrowserConfig({})).toEqual({
    maxBrowsers: 2,
    maxTabs: 4,
    idleMs: 120000,
    leaseIdleMs: 120000,
    handoffIdleMs: 600000,
    commandMs: 30000,
    queueMs: 120000,
    fps: 10,
    width: 1280,
    height: 800,
    scale: 2,
    executablePath: null
  })
})
it('reads every prefixed override', () => {
  expect(
    loadBrowserConfig({
      ZUMIBOT_BROWSER_MAX_BROWSERS: '3',
      ZUMIBOT_BROWSER_MAX_TABS: '8',
      ZUMIBOT_BROWSER_IDLE_MS: '1000',
      ZUMIBOT_BROWSER_LEASE_IDLE_MS: '2000',
      ZUMIBOT_BROWSER_HANDOFF_IDLE_MS: '3000',
      ZUMIBOT_BROWSER_COMMAND_MS: '4000',
      ZUMIBOT_BROWSER_QUEUE_MS: '5000',
      ZUMIBOT_BROWSER_FPS: '5',
      ZUMIBOT_BROWSER_WIDTH: '1920',
      ZUMIBOT_BROWSER_HEIGHT: '1080',
      ZUMIBOT_BROWSER_SCALE: '1',
      ZUMIBOT_BROWSER_EXECUTABLE_PATH: '/opt/chrome'
    })
  ).toEqual({
    maxBrowsers: 3,
    maxTabs: 8,
    idleMs: 1000,
    leaseIdleMs: 2000,
    handoffIdleMs: 3000,
    commandMs: 4000,
    queueMs: 5000,
    fps: 5,
    width: 1920,
    height: 1080,
    scale: 1,
    executablePath: '/opt/chrome'
  })
})
it.each([
  'MAX_BROWSERS',
  'MAX_TABS',
  'IDLE_MS',
  'LEASE_IDLE_MS',
  'HANDOFF_IDLE_MS',
  'COMMAND_MS',
  'QUEUE_MS',
  'FPS',
  'WIDTH',
  'HEIGHT',
  'SCALE'
])('rejects malformed %s without exposing its value', (name) => {
  const variable = `ZUMIBOT_BROWSER_${name}`
  for (const value of ['0', '-1', '1.5', 'Infinity', 'secret-token', '999999999999999999999999']) {
    let error: unknown
    try {
      loadBrowserConfig({ [variable]: value })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(variable)
    expect((error as Error).message).not.toContain(value)
  }
})
it.each([
  ['FPS', '11'],
  ['WIDTH', '1921'],
  ['HEIGHT', '1081'],
  ['SCALE', '3']
])('caps %s', (name, value) => {
  expect(() => loadBrowserConfig({ [`ZUMIBOT_BROWSER_${name}`]: value })).toThrow(`ZUMIBOT_BROWSER_${name}`)
})
it('rejects invalid executable overrides without exposing their contents', () => {
  expect(() => loadBrowserConfig({ ZUMIBOT_BROWSER_EXECUTABLE_PATH: 'relative-secret' })).toThrow('ZUMIBOT_BROWSER_EXECUTABLE_PATH')
})
