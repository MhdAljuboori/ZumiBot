import { dirname, relative, resolve, isAbsolute, sep } from 'node:path'

// No relative imports on purpose: e2e/vaultGuardProbe.mjs loads this file with Node's type stripping, which needs explicit extensions.

export const VAULT_GUARD_TEXT =
  'ZumiBot keeps the vault private: agents may not read its files. Use vault_items and browser_fill_from_vault instead.'
export const AUDIT_GUARD_TEXT = 'ZumiBot keeps the audit log private: agents may not read or change its files.'

/** The private paths: the vault's (key folder, vault.json) and, when given, the audit log's folder. */
export interface GuardPaths {
  keyFile: string
  vaultFile: string
  home: string
  auditDir?: string
}

// Same quoting as pauseSettings.ts (single quotes, every inner one closed and reopened).
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob'] as const

const windows = (): boolean => process.platform === 'win32'

/** `C:\Users\x` as Git Bash and Claude Code's permission rules spell it: `/c/Users/x`. */
export const gitBashPath = (abs: string): string =>
  abs.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/')

/**
 * The path as the shell may spell it: absolute, and ~/, $HOME/ and ${HOME}/ when it sits under the home folder. On Windows
 * also as the call's JSON carries it (every backslash doubled), with forward slashes, and in Git Bash's /c/ form.
 */
function spellings(path: string, home: string): string[] {
  const abs = resolve(path)
  const out = [abs]
  if (windows()) out.push(abs.replace(/\\/g, '\\\\'), abs.replace(/\\/g, '/'), gitBashPath(abs))
  const rel = relative(resolve(home), abs)
  if (home !== '' && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    const posix = rel.split(sep).join('/')
    out.push(`~/${posix}`, `$HOME/${posix}`, `\${HOME}/${posix}`)
  }
  return out
}

/**
 * The shell test both engines run over a call's JSON on stdin: it blocks any command naming the key folder or vault.json by
 * its resolved path, and never matches the bare word "vault.json", so work on ZumiBot's own source is not blocked.
 * `failClosed` (Codex hooks only) also blocks when grep itself fails: Codex lets a call run on any exit but 2, and the
 * Claude form's `&&` would turn a grep error into exit 0. The Claude form stays as it was, byte for byte.
 */
export function vaultGuardCommand(o: GuardPaths, failClosed = false): string {
  const keyDir = dirname(resolve(o.keyFile))
  const vaultFile = resolve(o.vaultFile)
  const patterns = [...spellings(keyDir, o.home), ...spellings(vaultFile, o.home)]
  // Windows (Claude Code runs this hook in Git Bash): paths ignore letter case, and Git for Windows' grep 3.0 both aborts
  // on -i with -F and mismatches -F patterns holding a backslash, either of which would let the call through. So tr
  // lowercases the call and turns every \ into /, and the patterns get the same, leaving grep no backslash to read. The
  // pipeline's status is still grep's. The backslash is octal \134: a doubled one reaches Git Bash halved through a
  // Windows command line, and tr then warns on stderr, which a block shows the agent.
  const grepOf = (ps: string[]) =>
    windows()
      ? `tr 'A-Z\\134' 'a-z/' | grep -qF ${[...new Set(ps.map((p) => p.toLowerCase().replace(/\\/g, '/')))].map((p) => `-e ${quote(p)}`).join(' ')}`
      : // A Mac's disk ignores letter case too, so ~/.config/Zumibot-vault is the same folder there: BSD grep takes -i with -F.
        `grep -q${process.platform === 'darwin' ? 'i' : ''}F ${ps.map((p) => `-e ${quote(p)}`).join(' ')}`
  const blockOf = (text: string) => `printf '%s\\n' ${quote(text)} >&2; exit 2`
  const grep = grepOf(patterns)
  const block = blockOf(VAULT_GUARD_TEXT)
  // Without an audit folder both forms stay exactly as they were (the probes and Codex's hook trust pin them).
  if (o.auditDir === undefined) {
    // grep: 0 a match, 1 none, 2 its own error.
    return failClosed ? `${grep}; [ $? -eq 1 ] && exit 0; ${block}` : `${grep} && { ${block}; }; exit 0`
  }
  // A second test with its own text, so a record and the agent can tell which private folder was refused. The call's JSON
  // is read once: two greps cannot both read stdin.
  const each = (g: string) => `printf '%s' "$i" | ${g}`
  const grepAudit = grepOf(spellings(resolve(o.auditDir), o.home))
  const blockAudit = blockOf(AUDIT_GUARD_TEXT)
  return failClosed
    ? `i=$(cat); ${each(grep)}; [ $? -eq 1 ] || { ${block}; }; ${each(grepAudit)}; [ $? -eq 1 ] && exit 0; ${blockAudit}`
    : `i=$(cat); ${each(grep)} && { ${block}; }; ${each(grepAudit)} && { ${blockAudit}; }; exit 0`
}

/**
 * The --settings JSON that keeps agents off the vault's files (a speed bump, not a wall: the agent is the same OS user, see
 * the spec). Deny rules cover the built-in file tools, in the CLI's //absolute form; the Bash hook is `vaultGuardCommand`,
 * a plain `sh` test on the call's JSON (no node start).
 */
export function vaultGuardSettings(o: GuardPaths): string {
  // Claude Code matches Windows paths in their POSIX form (`C:\x` is `/c/x`), so the rule is `//c/x/**` there.
  const rulePath = (p: string): string => (windows() ? gitBashPath(p) : p)
  const keyDir = rulePath(dirname(resolve(o.keyFile)))
  const vaultFile = rulePath(resolve(o.vaultFile))
  const auditDir = o.auditDir === undefined ? null : rulePath(resolve(o.auditDir))
  const deny = TOOLS.flatMap((tool) => [
    `${tool}(/${keyDir}/**)`,
    `${tool}(/${vaultFile})`,
    ...(auditDir === null ? [] : [`${tool}(/${auditDir}/**)`])
  ])
  const command = vaultGuardCommand(o)
  return JSON.stringify({ permissions: { deny }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } })
}
