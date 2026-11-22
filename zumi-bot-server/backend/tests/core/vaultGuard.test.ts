import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { AUDIT_GUARD_TEXT, VAULT_GUARD_TEXT, vaultGuardCommand, vaultGuardSettings } from '../../src/core/vault/vaultGuard'

// These pin the POSIX form (/home/... paths, a plain grep). On Windows the guard spells drive paths as //c/... and lowercases
// through tr; windowsPort.test.ts covers that form and runs it in Git Bash.
const posixOnly = process.platform === 'win32'
// A Mac's guard matches without letter case (its disk ignores case): grep -qiF where Linux has grep -qF.
const GREP = process.platform === 'darwin' ? 'grep -qiF' : 'grep -qF'
const pinned = (s: string): string => s.replace('grep -qF', GREP)

const home = '/home/ann'
const keyFile = '/home/ann/.config/zumibot-vault/vault.key'
const vaultFile = '/home/ann/.local/share/zumibot/vault.json'
const settings = JSON.parse(vaultGuardSettings({ keyFile, vaultFile, home })) as {
  permissions: { deny: string[] }
  hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] }
}
const hook = (command: string): { code: number | null; stderr: string } => {
  const r = spawnSync('sh', ['-c', settings.hooks.PreToolUse[0].hooks[0].command], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8'
  })
  return { code: r.status, stderr: r.stderr }
}

describe.skipIf(posixOnly)('vaultGuardSettings', () => {
  it('denies file tools on the key folder and vault.json', () => {
    const tools = ['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob']
    expect(settings.permissions.deny).toEqual(
      tools.flatMap((t) => [`${t}(//home/ann/.config/zumibot-vault/**)`, `${t}(//home/ann/.local/share/zumibot/vault.json)`])
    )
  })

  it('has one Bash hook, a plain sh test with no node start', () => {
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash')
    const command = settings.hooks.PreToolUse[0].hooks[0].command
    expect(command.startsWith(`${GREP} `)).toBe(true)
    expect(command).not.toMatch(/node|exec /)
  })

  it('the Bash hook blocks every spelling of both paths and allows others', () => {
    for (const cmd of [
      `cat ${keyFile}`,
      'cat ~/.config/zumibot-vault/vault.key',
      'cat $HOME/.config/zumibot-vault/vault.key',
      'cat "${HOME}/.config/zumibot-vault/vault.key"',
      'ls /home/ann/.config/zumibot-vault',
      `cat ${vaultFile}`,
      'cat ~/.local/share/zumibot/vault.json',
      'cat $HOME/.local/share/zumibot/vault.json'
    ]) {
      const r = hook(cmd)
      expect(r, cmd).toMatchObject({ code: 2 })
      expect(r.stderr.trim()).toBe(VAULT_GUARD_TEXT)
    }
    for (const cmd of ['grep vault.json src/', 'cat ~/.config/other/file', 'ls /home/ann', 'echo vault.key']) {
      expect(hook(cmd), cmd).toEqual({ code: 0, stderr: '' })
    }
  })

  it('quotes a path with a single quote and one outside the home folder gets only its absolute form', () => {
    const odd = JSON.parse(
      vaultGuardSettings({ keyFile: "/srv/it's/vault.key", vaultFile: '/srv/data/vault.json', home })
    ) as typeof settings
    const command = odd.hooks.PreToolUse[0].hooks[0].command
    expect(command).not.toContain('~/')
    const run = (text: string) =>
      spawnSync('sh', ['-c', command], { input: JSON.stringify({ tool_input: { command: text } }), encoding: 'utf8' }).status
    expect(run("cat /srv/it's/vault.key")).toBe(2)
    expect(run('cat /srv/data/vault.json')).toBe(2)
    expect(run('cat /srv/other')).toBe(0)
  })
})

// Taken before vaultGuardCommand was factored out: every Claude run's --settings must stay byte for byte.
describe.skipIf(posixOnly)('vaultGuardSettings output is pinned', () => {
  it('the home-folder paths', () => {
    expect(vaultGuardSettings({ keyFile, vaultFile, home })).toBe(
      pinned('{"permissions":{"deny":["Read(//home/ann/.config/zumibot-vault/**)","Read(//home/ann/.local/share/zumibot/vault.json)","Edit(//home/ann/.config/zumibot-vault/**)","Edit(//home/ann/.local/share/zumibot/vault.json)","MultiEdit(//home/ann/.config/zumibot-vault/**)","MultiEdit(//home/ann/.local/share/zumibot/vault.json)","Write(//home/ann/.config/zumibot-vault/**)","Write(//home/ann/.local/share/zumibot/vault.json)","Grep(//home/ann/.config/zumibot-vault/**)","Grep(//home/ann/.local/share/zumibot/vault.json)","Glob(//home/ann/.config/zumibot-vault/**)","Glob(//home/ann/.local/share/zumibot/vault.json)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"grep -qF -e \'/home/ann/.config/zumibot-vault\' -e \'~/.config/zumibot-vault\' -e \'$HOME/.config/zumibot-vault\' -e \'${HOME}/.config/zumibot-vault\' -e \'/home/ann/.local/share/zumibot/vault.json\' -e \'~/.local/share/zumibot/vault.json\' -e \'$HOME/.local/share/zumibot/vault.json\' -e \'${HOME}/.local/share/zumibot/vault.json\' && { printf \'%s\\\\n\' \'ZumiBot keeps the vault private: agents may not read its files. Use vault_items and browser_fill_from_vault instead.\' >&2; exit 2; }; exit 0"}]}]}}')
    )
  })
  it('a key folder with a quote in it', () => {
    expect(vaultGuardSettings({ keyFile: "/srv/it's here/vault/vault.key", vaultFile: '/srv/data/vault.json', home })).toBe(
      pinned('{"permissions":{"deny":["Read(//srv/it\'s here/vault/**)","Read(//srv/data/vault.json)","Edit(//srv/it\'s here/vault/**)","Edit(//srv/data/vault.json)","MultiEdit(//srv/it\'s here/vault/**)","MultiEdit(//srv/data/vault.json)","Write(//srv/it\'s here/vault/**)","Write(//srv/data/vault.json)","Grep(//srv/it\'s here/vault/**)","Grep(//srv/data/vault.json)","Glob(//srv/it\'s here/vault/**)","Glob(//srv/data/vault.json)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"grep -qF -e \'/srv/it\'\\\\\'\'s here/vault\' -e \'/srv/data/vault.json\' && { printf \'%s\\\\n\' \'ZumiBot keeps the vault private: agents may not read its files. Use vault_items and browser_fill_from_vault instead.\' >&2; exit 2; }; exit 0"}]}]}}')
    )
  })
})

describe.skipIf(process.platform !== 'darwin')('vaultGuardSettings on a Mac', () => {
  it('blocks a path spelled with other letter case, which names the same folder there', () => {
    expect(hook('cat /home/ann/.config/Zumibot-Vault/vault.key').code).toBe(2)
  })
})

describe('vaultGuardSettings with the audit folder', () => {
  const auditDir = '/home/ann/.local/share/zumibot/audit'
  const withAudit = JSON.parse(vaultGuardSettings({ keyFile, vaultFile, home, auditDir })) as typeof settings
  const run = (command: string, failClosed: boolean): { code: number | null; stderr: string } => {
    const cmd = failClosed
      ? vaultGuardCommand({ keyFile, vaultFile, home, auditDir }, true)
      : withAudit.hooks.PreToolUse[0].hooks[0].command
    const r = spawnSync('sh', ['-c', cmd], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' })
    return { code: r.status, stderr: r.stderr }
  }

  it.skipIf(posixOnly)('denies the file tools on the audit folder too', () => {
    for (const t of ['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob'])
      expect(withAudit.permissions.deny).toContain(`${t}(//home/ann/.local/share/zumibot/audit/**)`)
  })

  it.skipIf(posixOnly)('both hook forms block every spelling of the audit folder with its own text, and the vault with its own', () => {
    for (const failClosed of [false, true]) {
      for (const cmd of [`cat ${auditDir}/audit-1.jsonl`, 'rm -rf ~/.local/share/zumibot/audit', 'ls $HOME/.local/share/zumibot/audit']) {
        expect(run(cmd, failClosed)).toEqual({ code: 2, stderr: `${AUDIT_GUARD_TEXT}\n` })
      }
      expect(run(`cat ${keyFile}`, failClosed)).toEqual({ code: 2, stderr: `${VAULT_GUARD_TEXT}\n` })
      expect(run('ls /tmp', failClosed).code).toBe(0)
    }
  })

  it.skipIf(posixOnly)('keeps agents off the isolation settings, which live in the audit folder (only the UI may change them)', () => {
    for (const failClosed of [false, true]) {
      for (const cmd of [`cat ${auditDir}/isolation.json`, "sed -i 's/sandbox/off/' ~/.local/share/zumibot/audit/isolation.json"]) {
        expect(run(cmd, failClosed)).toEqual({ code: 2, stderr: `${AUDIT_GUARD_TEXT}\n` })
      }
    }
    expect(withAudit.permissions.deny).toContain('Edit(//home/ann/.local/share/zumibot/audit/**)')
  })

  it('without an audit folder the guard is byte for byte as before', () => {
    expect(vaultGuardSettings({ keyFile, vaultFile, home, auditDir: undefined })).toBe(vaultGuardSettings({ keyFile, vaultFile, home }))
  })
})

describe.skipIf(!posixOnly)('vaultGuardSettings on Windows', () => {
  it('denies the file tools on the key folder, vault.json and the audit folder in the //c/... form', () => {
    const deny = (
      JSON.parse(
        vaultGuardSettings({
          keyFile: 'C:\\Users\\ann\\.config\\zumibot-vault\\vault.key',
          vaultFile: 'C:\\Users\\ann\\.local\\share\\zumibot\\vault.json',
          home: 'C:\\Users\\ann',
          auditDir: 'C:\\Users\\ann\\.local\\share\\zumibot\\audit'
        })
      ) as typeof settings
    ).permissions.deny
    expect(deny).toContain('Read(//c/Users/ann/.config/zumibot-vault/**)')
    expect(deny).toContain('Read(//c/Users/ann/.local/share/zumibot/vault.json)')
    expect(deny).toContain('Edit(//c/Users/ann/.local/share/zumibot/audit/**)')
  })
})
