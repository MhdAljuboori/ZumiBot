import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSyncConfig, readSyncConfig, saveSyncConfig, validateSyncDataDir } from '../src/main/syncConfig'
import { wantsSync } from '../src/main/syncTrigger'

describe('sync configuration', () => {
  it('uses the CLI dotenv syntax but imports only VPS settings', () => {
    expect(parseSyncConfig('export VPS_HOST="my-vps" # host\nVPS_USER=bot\nHOME=/evil\nPATH=/evil\nVPS_DIR=/srv/bot')).toEqual({
      VPS_HOST: 'my-vps',
      VPS_USER: 'bot',
      VPS_DIR: '/srv/bot'
    })
  })
  it.each([
    'VPS_HOST=-option\nVPS_USER=bot',
    'VPS_HOST=host;evil\nVPS_USER=bot',
    'VPS_HOST=host\nVPS_USER=bot\nVPS_DIR=relative',
    'VPS_HOST=host'
  ])('rejects invalid config: %s', (text) => {
    expect(() => parseSyncConfig(text)).toThrow()
  })
  it('saves private configuration and round-trips it', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-config-'))
    try {
      const file = join(root, 'sync.env')
      const config = parseSyncConfig('VPS_HOST=host\nVPS_USER=bot')
      saveSyncConfig(file, config)
      expect(readSyncConfig(file)).toEqual(config)
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readFileSync(file, 'utf8')).not.toContain('HOME=')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('imports VPS_VAULT_KEY_FILE, round-trips it, and refuses one unsafe to quote', () => {
    const text = 'VPS_HOST=host\nVPS_USER=bot\nVPS_VAULT_KEY_FILE=~/.config/zumibot-vault/vault.key\nZUMIBOT_VAULT_KEY_FILE=/evil'
    const config = parseSyncConfig(text)
    expect(config).toEqual({
      VPS_HOST: 'host',
      VPS_USER: 'bot',
      VPS_DIR: '/home/bot/zumibot',
      VPS_VAULT_KEY_FILE: '~/.config/zumibot-vault/vault.key'
    })
    expect(parseSyncConfig('VPS_HOST=host\nVPS_USER=bot\nVPS_VAULT_KEY_FILE=/srv/keys/vault.key').VPS_VAULT_KEY_FILE).toBe(
      '/srv/keys/vault.key'
    )
    for (const bad of ['relative/vault.key', '~/a;b', '~/$(id)', '/x/../y', '~/', '-oProxyCommand=x', '~/a b']) {
      expect(() => parseSyncConfig(`VPS_HOST=host\nVPS_USER=bot\nVPS_VAULT_KEY_FILE=${bad}`)).toThrow()
    }
    const root = mkdtempSync(join(tmpdir(), 'sync-config-'))
    try {
      const file = join(root, 'sync.env')
      saveSyncConfig(file, config)
      expect(readSyncConfig(file)).toEqual(config)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('refuses to sync a different data directory from the local server', () => {
    expect(() => validateSyncDataDir({ HOME: '/home/test', ZUMIBOT_DATA_DIR: '/tmp/other' })).toThrow(/data folder/)
    expect(() => validateSyncDataDir({ HOME: '/home/test', XDG_DATA_HOME: '/tmp/other' })).toThrow(/data folder/)
    expect(() => validateSyncDataDir({ HOME: '/home/test', XDG_DATA_HOME: 'relative' })).not.toThrow()
    expect(() => validateSyncDataDir({ HOME: '/home/test', ZUMIBOT_DATA_DIR: '/home/test/.local/share/zumibot' })).not.toThrow()
  })
})

it('accepts only the fixed sync protocol action', () => {
  expect(wantsSync(['zumibot', 'zumibot://sync'])).toBe(true)
  expect(wantsSync(['zumibot', 'zumibot://sync/'])).toBe(true)
  for (const url of [
    'zumibot://sync?cmd=evil',
    'zumibot://sync/other',
    'zumibot://sync#x',
    'zumibot://user@sync',
    'https://sync',
    '--sync',
    'zumibot://sync\n'
  ]) {
    expect(wantsSync(['zumibot', url])).toBe(false)
  }
})
