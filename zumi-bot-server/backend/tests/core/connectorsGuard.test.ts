import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectorsGuardSettings } from '../../src/core/connectors/connectorsGuard'
import { gitBashPath } from '../../src/core/vault/vaultGuard'

describe('connectorsGuardSettings', () => {
  it('denies every file tool on connectors.json in the CLI //absolute form', () => {
    const f = '/d/connectors.json'
    // On Windows the path resolves onto the current drive, and Claude Code matches it as /c/... there.
    const abs = process.platform === 'win32' ? gitBashPath(resolve(f)) : '/d/connectors.json'
    expect(JSON.parse(connectorsGuardSettings(f))).toEqual({
      permissions: { deny: ['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob'].map((t) => `${t}(/${abs})`) }
    })
  })

  it.skipIf(process.platform !== 'win32')('spells a drive path as //c/... on Windows', () => {
    expect(JSON.parse(connectorsGuardSettings('C:\\Users\\U\\data\\connectors.json')).permissions.deny[0]).toBe(
      'Read(//c/Users/U/data/connectors.json)'
    )
  })
})
