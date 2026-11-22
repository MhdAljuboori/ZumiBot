import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentIsolation } from '@zumibot/shared/isolation'

// The per-run --settings of a sandboxed agent (governance.md 2.3). Built at spawn, merged into the run's one --settings by
// oneSettings; never written to the user's or a project's settings files.

export interface SandboxPlace {
  cwd: string
  /** The chat's CLAUDE_CODE_TMPDIR (under the data dir), or null when the CLI's own temp folder is used. */
  tmpDir: string | null
  /** Git folders Bash may write so `git commit` works (the repo's or the worktree's git dirs), hooks and config left out. */
  gitDirs: string[]
  /** Read-only: a worktree's node_modules link targets, `--add-dir` folders (attachments). */
  readDirs: string[]
  /** The agent's memory folder, written by the file tools only. */
  memoryDir: string | null
}

export interface SandboxPrivate {
  home: string
  dataDir: string
  keyDir: string
}

// The file guard hook's matcher and command (its run is fileGuard.ts). Here, not there: e2e/sandboxProbe.mjs loads this file
// with Node's type stripping, which needs it free of relative imports.
export const FILE_TOOLS_MATCHER = 'Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob'

export interface GuardRoots {
  read: string[] // the file tools may read under these (the write roots are readable too)
  write: string[] // and change under these
  deny: string[] // never changed by the file tools, even inside a write root (git dirs, the folder's Claude settings)
}

/** The roots as the hook's one argument (base64url JSON: no quoting trouble with any path). */
export const encodeRoots = (r: GuardRoots): string => Buffer.from(JSON.stringify(r)).toString('base64url')

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The hook command: any exit but 0 (a node crash) becomes 2, so the CLI blocks the call rather than running it. */
export function fileGuardCommand(o: { node: string; entry: string; electronNode: boolean }, roots: GuardRoots): string {
  return `${o.electronNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(o.node)} ${quote(o.entry)} ${encodeRoots(roots)}; [ $? -eq 0 ] && exit 0; exit 2`
}

/** How the file guard hook is started (the same node and build folder as the pause hook). */
export interface HookRuntime {
  node: string
  entry: string
  electronNode: boolean
}

const under = (path: string, root: string): boolean => {
  const r = relative(root, path)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Folders under home on PATH that a sandboxed Bash may read (node, npm globals, the claude CLI), plus git's own config. */
export function toolchainReads(pathEnv: string, home: string): string[] {
  const out: string[] = []
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p)
  }
  for (const raw of pathEnv.split(':')) {
    if (!raw || !isAbsolute(raw)) continue
    const dir = resolve(raw)
    if (!under(dir, home) || dir === resolve(home)) continue
    // `.../node/v22/bin` needs its `lib` too, so the version folder is granted; a bin right under home or ~/.local stays alone,
    // since its parent holds unrelated data (~/.local/share keeps keyrings and app data).
    const parent = dirname(dir)
    const depth = relative(home, parent).split(sep).filter(Boolean).length
    add(basename(dir) === 'bin' && depth >= 2 && basename(parent) !== '.local' ? parent : dir)
  }
  add(join(home, '.gitconfig'))
  add(join(home, '.config', 'git'))
  return out
}

/** The git dirs Bash needs to write for a commit in `cwd`: the nearest `.git`, and for a worktree its own and the common dir. */
export async function gitDirsOf(cwd: string): Promise<string[]> {
  let dir = resolve(cwd)
  for (;;) {
    const dotGit = join(dir, '.git')
    const st = await fs.stat(dotGit).catch(() => null)
    if (st?.isDirectory()) return [dotGit]
    if (st?.isFile()) {
      const text = await fs.readFile(dotGit, 'utf8').catch(() => '')
      const m = /^gitdir:\s*(.+)$/m.exec(text)
      if (!m) return []
      const own = resolve(dir, m[1].trim())
      const common = await fs.readFile(join(own, 'commondir'), 'utf8').then(
        (c) => resolve(own, c.trim()),
        () => null
      )
      return common === null || under(own, common) ? [common ?? own] : [own, common]
    }
    const up = dirname(dir)
    if (up === dir) return []
    dir = up
  }
}

/** The settings object for one sandboxed run. */
export function sandboxSettings(
  iso: AgentIsolation,
  place: SandboxPlace,
  priv: SandboxPrivate,
  toolchain: readonly string[],
  hook: HookRuntime
): Record<string, unknown> {
  const cwd = resolve(place.cwd)
  const tmp = place.tmpDir === null ? [] : [resolve(place.tmpDir)]
  const git = place.gitDirs.map((d) => resolve(d))
  const writable = [cwd, ...tmp, ...git, ...iso.write]
  const readable = [...writable, ...place.readDirs, ...toolchain, ...iso.read]
  // Code that runs later outside the sandbox, or that widens it: the folder's own Claude settings, git hooks and config.
  const protectedFiles = [
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.mcp.json'),
    ...git.flatMap((d) => [join(d, 'hooks'), join(d, 'config')])
  ]
  // The file tools: held by ZumiBot's own hook to the run's folders; extra read-only folders are reachable but not editable.
  const memory = place.memoryDir === null ? [] : [resolve(place.memoryDir)]
  const roots = {
    read: [cwd, ...tmp, ...memory, ...place.readDirs, ...iso.read],
    write: [cwd, ...tmp, ...memory, ...iso.write],
    deny: [...protectedFiles, ...git]
  }
  // Deny rules too, so the CLI refuses these before the hook even runs (and the audit says "a rule").
  const deny = [
    ...['Edit', 'Write', 'MultiEdit'].flatMap((t) => [...protectedFiles.map((f) => `${t}(/${f})`), ...git.map((d) => `${t}(/${d}/**)`)]),
    ...(iso.webSearch ? [] : ['WebSearch'])
  ]
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true, // never run unsandboxed silently
      allowUnsandboxedCommands: false, // dangerouslyDisableSandbox is ignored: nothing is retried outside
      autoAllowBashIfSandboxed: iso.autoBash, // false unless the user's own per-agent choice
      excludedCommands: [],
      filesystem: {
        allowWrite: dedupe(writable),
        denyWrite: dedupe(protectedFiles),
        denyRead: dedupe(['~/', resolve(priv.dataDir), resolve(priv.keyDir)]),
        allowRead: dedupe(readable)
      },
      network: {
        allowedDomains: [...iso.network],
        strictAllowlist: true, // off-list = denied, never sent to the auto mode classifier
        allowLocalBinding: false,
        allowAllUnixSockets: false
      }
    },
    permissions: {
      deny,
      // Every fetch reaches ZumiBot, which answers by the network list and never shows a card for an off-list host (chatService).
      ask: ['WebFetch']
    },
    hooks: { PreToolUse: [{ matcher: FILE_TOOLS_MATCHER, hooks: [{ type: 'command', command: fileGuardCommand(hook, roots) }] }] }
  }
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)]
}
