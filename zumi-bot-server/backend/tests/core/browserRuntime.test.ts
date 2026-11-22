import { expect, it } from 'vitest'
import { dirname } from 'node:path'
import { resolveBrowserRuntime } from '../../src/core/browser/browserRuntime'

it('resolves source worker paths without importing Playwright or requiring a browser binary', () => {
  const r = resolveBrowserRuntime()
  expect(r.workerEntry).toMatch(/browserWorker\.(ts|mjs)$/)
  expect(r.bridgeEntry).toMatch(/browserBridge\.(ts|mjs)$/)
  expect(r.todoBridgeEntry).toMatch(/todoBridge\.(ts|mjs)$/)
  expect(dirname(r.todoBridgeEntry)).toBe(dirname(r.bridgeEntry))
  expect(r.vaultBridgeEntry).toMatch(/vaultBridge\.(ts|mjs)$/)
  expect(dirname(r.vaultBridgeEntry)).toBe(dirname(r.bridgeEntry))
  expect(r.automationBridgeEntry).toMatch(/automationBridge\.(ts|mjs)$/)
  expect(dirname(r.automationBridgeEntry)).toBe(dirname(r.bridgeEntry))
  expect(r.playwrightDir).toMatch(/node_modules[\\/]playwright-core$/)
})

it('detects Electron after inherited ELECTRON_RUN_AS_NODE has been scrubbed', () => {
  const r = resolveBrowserRuntime({ versions: { electron: '45.0.0' }, execPath: '/opt/Electron', env: {} })
  expect(r.electronNode).toBe(true)
  expect(r.node).toBe('/opt/Electron')
})

it('keeps missing binary detection nonfatal for text-only startup', () => {
  const r = resolveBrowserRuntime({ env: { ZUMIBOT_BROWSER_EXECUTABLE_PATH: '/missing/private-browser' } })
  expect(r.executablePath).toBe(null)
})
