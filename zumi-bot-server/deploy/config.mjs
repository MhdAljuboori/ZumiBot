import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

// Strict allow-lists: rsync forwards the remote path to a shell too, so refuse anything fancy.
// No leading dash, so a value can never be read as an ssh option.
export const SAFE_HOST = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/
export const SAFE_DIR = /^\/[A-Za-z0-9._\/-]+$/

/** VPS_VAULT_KEY_FILE: a file under ~/ or an absolute path, plain characters only and no `..`, so it is safe to quote into a remote shell. */
export const safeKeyFile = (v) =>
  typeof v === 'string' &&
  /^(?:~\/|\/)[A-Za-z0-9._\/-]*[A-Za-z0-9._-]$/.test(v) &&
  !v.includes('//') &&
  !/(?:^|\/)\.\.?(?:\/|$)/.test(v.replace(/^~\//, ''))

/**
 * The vault key file the local server uses: the rule of the server's resolveVaultKeyFile (backend/src/config.ts),
 * which sync.test.ts checks against it. Errors name the variable, never its value.
 */
export function vaultKeyFileOf(env, home, dataDir) {
  const val = (name) => (env[name] === '' ? undefined : env[name])
  const explicit = val('ZUMIBOT_VAULT_KEY_FILE')
  if (explicit !== undefined && !isAbsolute(explicit)) throw new Error('ZUMIBOT_VAULT_KEY_FILE must be an absolute path')
  const xdg = val('XDG_CONFIG_HOME')
  const full = resolve(explicit ?? join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'zumibot-vault', 'vault.key'))
  const data = resolve(dataDir)
  if (full === data || full.startsWith(data + sep)) throw new Error('ZUMIBOT_VAULT_KEY_FILE must be outside the data folder')
  // The server refuses a key folder agents could not be denied alone (dedicatedKeyDir in backend/src/config.ts).
  const dir = dirname(full),
    holds = (outer, inner) => inner === outer || inner.startsWith(outer === sep ? sep : outer + sep)
  const shared =
    ['/', '/etc', '/tmp', '/var/tmp', tmpdir()].some((d) => resolve(d) === dir) || holds(dir, resolve(home)) || holds(dir, data)
  if (shared || !/vault|zumibot/i.test(basename(dir))) {
    throw new Error(
      'ZUMIBOT_VAULT_KEY_FILE must be in a folder of its own, since agents are denied that whole folder: use a folder only for the vault key, with "vault" in its name, such as ~/.config/zumibot-vault'
    )
  }
  return full
}

// Dotenv-style parser by hand, to avoid a dependency.
export function parseEnvFile(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    // Strip a trailing comment first (outside quotes), then unquote.
    let v = m[2].trim()
    const q = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(v)
    if (q) v = q[2]
    else v = v.replace(/^#.*$|\s+#.*$/, '').trim()
    out[m[1]] = v
  }
  return out
}

// Never prompt, never hang: a password prompt or dead host would stall the health loop.
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
export const RSYNC_SSH = ['-e', `ssh ${SSH_OPTS.join(' ')}`]
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// opts.input goes to the child's stdin (a secret travels there, never in argv); without it stdin is closed.
export function realRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (opts.input !== undefined) {
      // A child that exits without reading would make the write fail; its exit code reports that instead.
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input)
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
      if (opts.stream) process.stdout.write(d)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      if (opts.stream) process.stderr.write(d)
    })
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}
