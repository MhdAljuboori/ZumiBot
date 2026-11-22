import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { legacyFolders, migrateLegacyName } from '../src/legacyName'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'legacy-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const oldData = () => join(home, '.local/share/claudebot')
const newData = () => join(home, '.local/share/zumibot')

describe('migrateLegacyName', () => {
  it('moves the old data and vault key folders to their new names', () => {
    mkdirSync(oldData(), { recursive: true })
    writeFileSync(join(oldData(), 'chats.json'), '{"chats":[]}')
    mkdirSync(join(home, '.config/claudebot-vault'), { recursive: true })
    writeFileSync(join(home, '.config/claudebot-vault/vault.key'), 'k')
    const logs: string[] = []
    migrateLegacyName({ HOME: home }, (l) => logs.push(l))
    expect(readFileSync(join(newData(), 'chats.json'), 'utf8')).toBe('{"chats":[]}')
    expect(readFileSync(join(home, '.config/zumibot-vault/vault.key'), 'utf8')).toBe('k')
    expect(existsSync(oldData())).toBe(false)
    expect(logs).toHaveLength(2)
  })

  it('leaves both alone when the new folder exists', () => {
    mkdirSync(oldData(), { recursive: true })
    mkdirSync(newData(), { recursive: true })
    migrateLegacyName({ HOME: home }, () => undefined)
    expect(existsSync(oldData())).toBe(true)
  })

  it('moves a data folder set to the default, never one chosen by hand', () => {
    expect(legacyFolders({ HOME: home, ZUMIBOT_DATA_DIR: newData() }).map(([, to]) => to)).toContain(newData())
    expect(legacyFolders({ HOME: home, ZUMIBOT_DATA_DIR: '/srv/data' }).map(([, to]) => to)).not.toContain(newData())
  })

  it('names old settings without their values', () => {
    const logs: string[] = []
    migrateLegacyName({ HOME: home, CLAUDEBOT_LOCAL_SECRET: 'hunter2hunter2' }, (l) => logs.push(l))
    expect(logs.join('\n')).toContain('CLAUDEBOT_LOCAL_SECRET')
    expect(logs.join('\n')).not.toContain('hunter2')
  })
})
