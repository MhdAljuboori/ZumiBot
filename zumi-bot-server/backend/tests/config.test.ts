import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const vps = { ZUMIBOT_ORIGIN: 'https://zumibot.example.com', HOME: '/home/u' }
const SECRET = 'S3cretValue-that-is-long-enough-0123456789'
const local = { ZUMIBOT_MODE: 'local', ZUMIBOT_LOCAL_SECRET: SECRET, HOME: '/home/u' }

describe('loadConfig', () => {
  it('vps without ZUMIBOT_ORIGIN throws naming ZUMIBOT_ORIGIN', () => {
    expect(() => loadConfig({ HOME: '/home/u' })).toThrow(/ZUMIBOT_ORIGIN/)
  })

  it('origin with a path throws', () => {
    expect(() => loadConfig({ ...vps, ZUMIBOT_ORIGIN: 'https://x.example.com/app' })).toThrow(/ZUMIBOT_ORIGIN/)
    expect(() => loadConfig({ ...vps, ZUMIBOT_ORIGIN: 'https://x.example.com/?a=1' })).toThrow(/ZUMIBOT_ORIGIN/)
  })

  it('origin must be https, except loopback http under NODE_ENV=test', () => {
    expect(() => loadConfig({ ...vps, ZUMIBOT_ORIGIN: 'http://x.example.com' })).toThrow(/ZUMIBOT_ORIGIN/)
    expect(() => loadConfig({ ...vps, ZUMIBOT_ORIGIN: 'http://127.0.0.1:4317' })).toThrow(/ZUMIBOT_ORIGIN/)
    expect(loadConfig({ ...vps, NODE_ENV: 'test', ZUMIBOT_ORIGIN: 'http://127.0.0.1:4317' }).origin).toBe('http://127.0.0.1:4317')
    expect(() => loadConfig({ ...vps, NODE_ENV: 'test', ZUMIBOT_ORIGIN: 'http://evil.example.com' })).toThrow(/ZUMIBOT_ORIGIN/)
  })

  it('a trailing slash is normalised away', () => {
    expect(loadConfig({ ...vps, ZUMIBOT_ORIGIN: 'https://zumibot.example.com/' }).origin).toBe('https://zumibot.example.com')
  })

  it('local without a secret throws', () => {
    expect(() => loadConfig({ ZUMIBOT_MODE: 'local' })).toThrow(/ZUMIBOT_LOCAL_SECRET/)
    expect(() => loadConfig({ ZUMIBOT_MODE: 'local', ZUMIBOT_LOCAL_SECRET: 'short' })).toThrow(/ZUMIBOT_LOCAL_SECRET/)
  })

  it('defaults resolve under XDG_DATA_HOME', () => {
    const c = loadConfig({ ...vps, XDG_DATA_HOME: '/xdg/data' })
    expect(c.dataDir).toBe(join('/xdg/data', 'zumibot'))
    expect(c.agentsDir).toBe(join('/home/u', '.claude', 'agents'))
    expect(c.port).toBe(4317)
    expect(c.mode).toBe('vps')
    expect(c.localSecret).toBeNull()
    expect(loadConfig(vps).dataDir).toBe(join('/home/u', '.local', 'share', 'zumibot'))
    expect(loadConfig({ ...vps, XDG_DATA_HOME: 'relative' }).dataDir).toBe(join('/home/u', '.local', 'share', 'zumibot'))
    expect(loadConfig({ ...vps, ZUMIBOT_DATA_DIR: '/d' }).dataDir).toBe('/d')
  })

  it('local mode defaults', () => {
    const c = loadConfig({ ...local, ZUMIBOT_MIGRATE_FROM: '/old' })
    expect(c).toMatchObject({ mode: 'local', port: 0, origin: '', localSecret: SECRET, migrateFrom: '/old' })
    expect(c.webDir.endsWith(sep + 'web')).toBe(true)
  })

  it('migrate-from is local only', () => {
    expect(() => loadConfig({ ...vps, ZUMIBOT_MIGRATE_FROM: '/old' })).toThrow(/ZUMIBOT_MIGRATE_FROM/)
  })

  it('unknown mode and bad port throw naming the variable', () => {
    expect(() => loadConfig({ ...vps, ZUMIBOT_MODE: 'cloud' })).toThrow(/ZUMIBOT_MODE/)
    expect(() => loadConfig({ ...vps, ZUMIBOT_PORT: 'abc' })).toThrow(/ZUMIBOT_PORT/)
    expect(() => loadConfig({ ...vps, ZUMIBOT_PORT: '70000' })).toThrow(/ZUMIBOT_PORT/)
    expect(loadConfig({ ...vps, ZUMIBOT_PORT: '8080' }).port).toBe(8080)
  })

  it('error text never includes the secret value', () => {
    const bad = 'tooshort-secret-value'
    let msg = ''
    try {
      loadConfig({ ZUMIBOT_MODE: 'local', ZUMIBOT_LOCAL_SECRET: bad })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('ZUMIBOT_LOCAL_SECRET')
    expect(msg).not.toContain(bad)
    expect(() => loadConfig({ ...vps, ZUMIBOT_MODE: 'topsecretmode' })).toThrow(/^(?!.*topsecretmode)/s)
    expect(() => loadConfig({ ...vps, ZUMIBOT_ORIGIN: 'http://hunter2.example.com/x' })).toThrow(/^(?!.*hunter2)/s)
  })

  it('vaultKeyFile defaults to XDG_CONFIG_HOME then ~/.config', () => {
    expect(loadConfig(vps).vaultKeyFile).toBe(resolve('/home/u/.config/zumibot-vault/vault.key'))
    expect(loadConfig({ ...vps, XDG_CONFIG_HOME: '/xdg/conf' }).vaultKeyFile).toBe(resolve('/xdg/conf/zumibot-vault/vault.key'))
    expect(loadConfig({ ...vps, XDG_CONFIG_HOME: 'relative' }).vaultKeyFile).toBe(resolve('/home/u/.config/zumibot-vault/vault.key'))
    expect(loadConfig({ ...vps, ZUMIBOT_VAULT_KEY_FILE: '/keys/vault/v.key' }).vaultKeyFile).toBe(resolve('/keys/vault/v.key'))
  })

  // The vault guard denies agents the key's whole folder, so a shared folder would lock them out of it.
  it('refuses a vault key whose folder is not one only for the key, naming only the variable', () => {
    const shared = [
      '/home/u/vault.key',
      '/home/u/.config/vault.key',
      '/vault.key',
      '/home/vault.key',
      '/etc/x.key',
      '/tmp/vault.key',
      '/var/tmp/vault.key',
      join(tmpdir(), 'vault.key'),
      '/srv/keys/vault.key',
      '/home/u/.config/zumibot-vault/../vault.key'
    ]
    for (const file of shared) {
      expect(() => loadConfig({ ...vps, ZUMIBOT_VAULT_KEY_FILE: file }), file).toThrow(
        /^ZUMIBOT_VAULT_KEY_FILE .*use a folder only for the vault key/
      )
    }
    // A home or a folder holding the data folder is shared whatever its name.
    expect(() => loadConfig({ ...vps, HOME: '/home/zumibot', ZUMIBOT_VAULT_KEY_FILE: '/home/zumibot/vault.key' })).toThrow(
      /use a folder only for the vault key/
    )
    expect(() => loadConfig({ ...vps, ZUMIBOT_DATA_DIR: '/srv/zumibot/data', ZUMIBOT_VAULT_KEY_FILE: '/srv/zumibot/vault.key' })).toThrow(
      /use a folder only for the vault key/
    )
    expect(() => loadConfig({ ...vps, ZUMIBOT_VAULT_KEY_FILE: '/srv/keys/hunter2/vault.key' })).toThrow(/^(?!.*hunter2)/s)
    // A folder named for the vault or the app, and the e2e harness's temp one, are fine.
    for (const file of [
      '/srv/zumibot-vault/vault.key',
      '/home/u/.config/MyVault/k.key',
      '/opt/ZumiBot-keys/vault.key',
      '/tmp/cb-e2e-x/vault-key/vault.key'
    ]) {
      expect(loadConfig({ ...vps, ZUMIBOT_VAULT_KEY_FILE: file }).vaultKeyFile).toBe(resolve(file))
    }
  })

  it('refuses a vault key inside the data dir, or a relative one, naming only the variable', () => {
    const inside = '/d/keys/secret-folder/vault.key'
    expect(() => loadConfig({ ...vps, ZUMIBOT_DATA_DIR: '/d', ZUMIBOT_VAULT_KEY_FILE: inside })).toThrow(/ZUMIBOT_VAULT_KEY_FILE/)
    expect(() => loadConfig({ ...vps, ZUMIBOT_DATA_DIR: '/d', ZUMIBOT_VAULT_KEY_FILE: '/d/../d/vault.key' })).toThrow(
      /ZUMIBOT_VAULT_KEY_FILE/
    )
    expect(() => loadConfig({ ...vps, ZUMIBOT_VAULT_KEY_FILE: 'vault.key' })).toThrow(/ZUMIBOT_VAULT_KEY_FILE/)
    expect(() => loadConfig({ ...vps, ZUMIBOT_DATA_DIR: '/d', ZUMIBOT_VAULT_KEY_FILE: inside })).toThrow(/^(?!.*secret-folder)/s)
    expect(loadConfig({ ...vps, ZUMIBOT_DATA_DIR: '/d', ZUMIBOT_VAULT_KEY_FILE: '/dd/vault/vault.key' }).vaultKeyFile).toBe(
      resolve('/dd/vault/vault.key')
    )
  })
})
