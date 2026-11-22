import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Server } from 'node:http'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { containerNetBlocked, type AgentIsolation } from '@zumibot/shared/isolation'
import { createAuthProxy, type CredentialSource } from './authProxy'
import { createNetProxy } from './netProxy'
import { BASH_TIMEOUTS } from '../chat/runEnv'
import type { Exec } from './podmanCalls'

// Level 3 (governance.md 2.4): each Claude turn of a contained agent runs as its own `podman run --rm`, rootless, non-root inside,
// no network of its own, read-only root. Stdio is the CLI's as before, so the parser, approvals and bridges are unchanged; Stop's
// SIGINT reaches the CLI through podman's signal proxy and the entry. The container ends with its turn; whatever a crash or a
// SIGKILL leaves is removed by its owner label at start and at shutdown.

export const IN_NODE = '/usr/local/bin/node'
export const IN_CLAUDE = '/usr/local/bin/claude'
export const IN_ENTRY = '/cb/entry.mjs'
export const IN_RUN = '/cb/run'
export const LABEL_OWNER = 'io.zumibot.owner'
const API_URL = 'http://127.0.0.1:8787'
const PROXY_URL = 'http://127.0.0.1:3128'

export interface Mount {
  src: string
  dst: string
  ro: boolean
}

/** The CLI's folder name for a project's session logs (~/.claude/projects/<this>). */
export const projectDirName = (cwd: string): string => resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')

const under = (path: string, root: string): boolean => {
  const r = relative(root, path)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

// Env the run sets itself or that must never cross: the model's address and key, the proxies, the CLI's config place.
const OWN_ENV =
  /^(HOME|PATH|USER|LOGNAME|SHELL|CB_.*|ANTHROPIC_.*|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|https?_proxy|HTTPS?_PROXY|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|ELECTRON_RUN_AS_NODE)$/

export interface PodmanRun {
  name: string
  labels: Record<string, string>
  image: string
  /** The host user's home path: the container's HOME, backed by `homeDir`, never the real home. */
  home: string
  homeDir: string
  cwd: string
  mounts: Mount[]
  /** Names whose values podman takes from its own env (never written into argv). */
  envNames: string[]
  fixedEnv: Record<string, string>
  claudeBin: string
  entry: string
  runDir: string
}

/** The podman argv of one contained turn. */
export function podmanRunArgs(r: PodmanRun, inner: readonly string[]): string[] {
  const bind = (src: string, dst: string, ro: boolean) => ['--mount', `type=bind,source=${src},destination=${dst}${ro ? ',ro=true' : ''}`]
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    r.name,
    ...Object.entries(r.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    // Rootless, the host user's uid inside (so mounted folders and bridge sockets are its own), no root, no new privileges.
    '--userns=keep-id',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--pids-limit',
    '4096',
    ...bind(r.homeDir, r.home, false),
    ...r.mounts.flatMap((m) => bind(m.src, m.dst, m.ro)),
    ...bind(r.claudeBin, IN_CLAUDE, true),
    ...bind(r.entry, IN_ENTRY, true),
    ...bind(r.runDir, IN_RUN, false),
    '--workdir',
    r.cwd,
    ...Object.entries(r.fixedEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...r.envNames.flatMap((n) => ['--env', n]),
    r.image,
    IN_NODE,
    IN_ENTRY,
    IN_CLAUDE,
    ...inner
  ]
}

/** The CLI's args as the container runs them: the server's node (bridges, hooks) is the image's node there. */
export const innerArgs = (args: readonly string[], hostNode: string): string[] =>
  args.map((a) => (hostNode && a.includes(hostNode) ? a.split(hostNode).join(IN_NODE) : a))

export interface Private {
  home: string
  dataDir: string
  keyDir: string
  claudeHome: string
}

/**
 * Why a folder may not be mounted, or null. Never home itself or a folder holding it, never the data dir, the vault key or
 * ~/.claude (the run's own pieces of the data dir are passed with `inData`).
 */
export function mountRefusal(src: string, p: Private, inData = false): string | null {
  if (/[,\n\r]/.test(src)) return `${src}: a folder with a comma or line break in its path cannot be mounted`
  const s = resolve(src)
  if (under(p.home, s)) return `${s} is your home folder or holds it; a container never mounts it. Use a project folder.`
  if (under(s, p.keyDir) || under(p.keyDir, s)) return `${s} holds the vault key, which a container never mounts.`
  if (under(s, p.claudeHome)) return `${s} is inside ~/.claude, which a container never mounts.`
  if (!inData && (under(s, p.dataDir) || under(p.dataDir, s))) return `${s} is ZumiBot's data folder, which a container never mounts.`
  return null
}

export interface ContainerPlace {
  chatId: string
  agent: string
  cwd: string
  tmpDir: string | null
  addDirs: string[]
  gitDirs: string[]
  /** The turn's own env names (bridges, keys, temp folder, pause flag); their values stay in podman's env. */
  env: Record<string, string>
  iso: AgentIsolation
}

export interface ContainerRunnerDeps {
  podman: string
  image: string
  owner: string
  /** Per-chat fake homes live here (~/.local/state/zumibot-containers). */
  stateRoot: string
  /** Where agent files live (ZUMIBOT_AGENTS_DIR, else ~/.claude/agents): the agent's own file is mounted from here. */
  agentsDir: string
  priv: Private
  node: string
  entry: string
  distDir: string
  claudeBin: string
  credential: CredentialSource
  /** Runs podman for housekeeping (sweep, remove), through the server's PodmanCalls so its close() ends them. */
  exec: Exec
}

export interface ContainerRun {
  name: string
  /** The spawn as podman runs it. */
  wrap(s: { bin: string; args: string[]; env: NodeJS.ProcessEnv }): { bin: string; args: string[]; env: NodeJS.ProcessEnv }
  /** Hosts the network proxy refused since the last call. */
  drainDenied(): string[]
  dispose(): Promise<void>
}

const listen = (server: Server, path: string) =>
  new Promise<void>((ok, bad) => {
    server.once('error', bad)
    server.listen(path, () => ok())
  })
const close = (server: Server) =>
  new Promise<void>((ok) => {
    server.close(() => ok())
    server.closeAllConnections?.()
  })

/** Removes every container this server started (by its owner label): at start, after a crash, and at shutdown. */
export async function sweepOwned(owner: string, exec: Exec): Promise<number> {
  const ps = await exec(['ps', '-a', '-q', '--filter', `label=${LABEL_OWNER}=${owner}`])
  const ids = ps.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length > 0) await exec(['rm', '-f', '-t', '2', ...ids])
  return ids.length
}

const safeChat = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * Removes the fake homes of chats that are gone. `stateRoot` is this server's own (it holds the owner id), so another server's
 * chats are never touched. A folder podman left owned by a sub-uid is removed inside the user namespace.
 */
export async function pruneHomes(stateRoot: string, keep: readonly string[], exec: Exec | null): Promise<number> {
  const kept = new Set(keep.map(safeChat))
  const names = await fs.readdir(stateRoot).catch(() => [] as string[])
  let n = 0
  for (const name of names) {
    if (kept.has(name)) continue
    const at = join(stateRoot, name)
    const ok = await fs.rm(at, { recursive: true, force: true }).then(
      () => true,
      () => false
    )
    if (!ok && exec) await exec(['unshare', 'rm', '-rf', at])
    n++
  }
  return n
}

export class ContainerRunner {
  constructor(private d: ContainerRunnerDeps) {}

  private exec(args: string[]): Promise<{ code: number | null; stdout: string }> {
    return this.d.exec(args)
  }

  sweep(): Promise<number> {
    return sweepOwned(this.d.owner, (a) => this.exec(a))
  }

  /** The mounts of one turn, or the reason it cannot run. */
  async mountsOf(p: ContainerPlace, fakeClaude: string): Promise<{ mounts: Mount[] } | { refused: string }> {
    const mounts: Mount[] = []
    const add = (src: string, ro: boolean, inData = false, dst = src): string | null => {
      const why = mountRefusal(src, this.d.priv, inData)
      if (why) return why
      if (!mounts.some((m) => m.dst === dst)) mounts.push({ src: resolve(src), dst: resolve(dst), ro })
      return null
    }
    const cwd = resolve(p.cwd)
    const first = add(cwd, false)
    if (first) return { refused: first }
    for (const g of p.gitDirs) {
      const why = add(g, false)
      if (why) return { refused: why }
    }
    // Code the host runs later stays read-only, as in level 2: git hooks and config, the folder's own Claude settings.
    for (const f of [
      ...p.gitDirs.flatMap((g) => [join(g, 'hooks'), join(g, 'config')]),
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json'),
      join(cwd, '.mcp.json')
    ]) {
      if (
        await fs.lstat(f).then(
          () => true,
          () => false
        )
      )
        add(f, true, false)
    }
    for (const link of await linkTargets(cwd)) {
      const why = add(link, true)
      if (why) return { refused: why }
    }
    if (p.tmpDir) {
      const why = add(p.tmpDir, false, true)
      if (why) return { refused: why }
    }
    // The pause hook reads its flag inside the container; read-only, so the agent can neither redirect nor delete it.
    const pauseFile = p.env.ZUMIBOT_PAUSE_FILE
    if (pauseFile) {
      const why = add(dirname(pauseFile), true, true)
      if (why) return { refused: why }
    }
    for (const a of p.addDirs) {
      const why = add(a, true, true)
      if (why) return { refused: why }
    }
    for (const w of p.iso.write) {
      const why = add(w, false)
      if (why) return { refused: why }
    }
    for (const r of p.iso.read) {
      const why = add(r, true)
      if (why) return { refused: why }
    }
    // The bridges' socket folders (to-dos, vault, asks, browser, automations): private 0700 folders of their own under /tmp.
    for (const v of Object.values(p.env)) {
      if (/^\/tmp\/cb-[a-z]-[A-Za-z0-9]+\//.test(v)) add(dirname(v), false)
    }
    add(this.d.distDir, true)
    // Inside the fake home: this project's session logs (so edit, resend, Files restore and costs read them where they always
    // are), the agent's file and its user-scope memory.
    const claude = this.d.priv.claudeHome
    const projects = join(claude, 'projects', projectDirName(cwd))
    await fs.mkdir(projects, { recursive: true, mode: 0o700 })
    mounts.push({ src: projects, dst: join(fakeClaude, 'projects', projectDirName(cwd)), ro: false })
    const agentFile = join(this.d.agentsDir, `${p.agent}.md`)
    if (
      await fs.stat(agentFile).then(
        (s) => s.isFile(),
        () => false
      )
    )
      mounts.push({ src: agentFile, dst: join(fakeClaude, 'agents', `${p.agent}.md`), ro: true })
    const memory = join(claude, 'agent-memory', p.agent)
    await fs.mkdir(memory, { recursive: true, mode: 0o700 })
    mounts.push({ src: memory, dst: join(fakeClaude, 'agent-memory', p.agent), ro: false })
    return { mounts }
  }

  async open(p: ContainerPlace): Promise<ContainerRun | { refused: string }> {
    const home = this.d.priv.home
    const fakeClaude = join(home, '.claude')
    const planned = await this.mountsOf(p, fakeClaude)
    if ('refused' in planned) return planned
    const homeDir = join(this.d.stateRoot, safeChat(p.chatId), 'home')
    await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
    // Mount points under HOME land in the fake home. Made here, as the user: ones podman makes belong to the container's root
    // (a sub-uid), which the user cannot remove later.
    for (const m of planned.mounts) {
      if (!under(m.dst, home) || m.dst === resolve(home)) continue
      const at = join(homeDir, relative(home, m.dst))
      if ((await fs.stat(m.src)).isDirectory()) await fs.mkdir(at, { recursive: true, mode: 0o700 })
      else {
        await fs.mkdir(dirname(at), { recursive: true, mode: 0o700 })
        await fs.writeFile(at, '', { flag: 'a', mode: 0o600 })
      }
    }
    const runDir = await fs.mkdtemp('/tmp/cb-c-')
    await fs.chmod(runDir, 0o700)
    const runKey = `cb-run-${randomBytes(24).toString('hex')}`
    const denied: string[] = []
    const auth = createAuthProxy({ runKey, credential: this.d.credential })
    const netp = createNetProxy({
      network: p.iso.network,
      denied: (t) => {
        if (!denied.includes(t)) denied.push(t)
      }
    })
    try {
      await listen(auth, join(runDir, 'api.sock'))
      await listen(netp, join(runDir, 'net.sock'))
    } catch (err) {
      await Promise.all([close(auth), close(netp)])
      await fs.rm(runDir, { recursive: true, force: true })
      throw err
    }
    const name = `zumibot-${this.d.owner}-${randomBytes(6).toString('hex')}`
    const envNames = [
      ...Object.keys(p.env).filter((n) => !OWN_ENV.test(n)),
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
      ...Object.keys(BASH_TIMEOUTS)
    ]
    const run: PodmanRun = {
      name,
      image: this.d.image,
      home,
      homeDir,
      cwd: resolve(p.cwd),
      mounts: planned.mounts,
      envNames,
      claudeBin: this.d.claudeBin,
      entry: this.d.entry,
      runDir,
      labels: { [LABEL_OWNER]: this.d.owner, 'io.zumibot.chat': p.chatId, 'io.zumibot.agent': p.agent },
      fixedEnv: {
        HOME: home,
        CB_API_SOCK: `${IN_RUN}/api.sock`,
        CB_NET_SOCK: `${IN_RUN}/net.sock`,
        ANTHROPIC_BASE_URL: API_URL,
        HTTPS_PROXY: PROXY_URL,
        HTTP_PROXY: PROXY_URL,
        https_proxy: PROXY_URL,
        http_proxy: PROXY_URL,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        // The CLI's own traffic beyond the model (feature flags, error reports) has nowhere to go.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
      }
    }
    let disposed = false
    return {
      name,
      wrap: (s) => ({
        bin: this.d.podman,
        args: podmanRunArgs(run, innerArgs(s.args, this.d.node)),
        // podman needs the server's own env (XDG_RUNTIME_DIR, PATH); only the names in envNames cross into the container.
        env: { ...s.env, ANTHROPIC_API_KEY: runKey, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
      }),
      drainDenied: () => denied.splice(0),
      dispose: async () => {
        if (disposed) return
        disposed = true
        // --rm removes it when the turn ends; this catches a run whose podman client was killed.
        await this.exec(['rm', '-f', '--ignore', '-t', '2', name]).catch(() => null)
        await Promise.all([close(auth), close(netp)])
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

/** Absolute symlink targets outside `cwd` (a worktree's node_modules links), so they resolve inside; read-only. Depth 3, at most 50. */
export async function linkTargets(cwd: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= 50) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= 50) return
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) {
        const t = await fs.readlink(p).catch(() => null)
        if (
          t &&
          isAbsolute(t) &&
          !under(t, cwd) &&
          !out.includes(t) &&
          (await fs.stat(t).then(
            () => true,
            () => false
          ))
        )
          out.push(t)
      } else if (e.isDirectory() && depth < 3 && e.name !== '.git' && e.name !== 'node_modules') await walk(p, depth + 1)
    }
  }
  await walk(cwd, 1)
  return out
}

/** Appends what the network proxy refused during a tool to its result, in the sandbox's form (chat line and audit read it). */
export const withNetBlocks = (content: string, hosts: readonly string[]): string =>
  hosts.length === 0 ? content : `${content}${content ? '\n' : ''}${containerNetBlocked(hosts)}`
