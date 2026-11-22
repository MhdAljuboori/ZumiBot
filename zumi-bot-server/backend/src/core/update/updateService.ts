import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import {
  ALREADY_UPDATING,
  LOCAL_CURRENT_FILE,
  LOCAL_UPDATES_ENV,
  RELEASE_PUBLIC_KEY,
  UPDATE_CHECK_MS,
  UPDATE_LOG_FILE,
  UPDATE_STALE_MS,
  isNewer,
  parseVersion,
  type UpdateAvailability,
  type UpdateRelease,
  type UpdateResult,
  type UpdateStatus
} from '@zumibot/shared/update'
import { writeFileAtomic } from '../fsutil'
import { SiteError, downloadFile, fetchManifest } from './releaseSite'
import { sha256File } from './sha256sums'
import { verifyReleaseSignature } from './signature'

const run = promisify(execFile)

const TARBALL = 'zumibot-server.tar.gz'
// Soon after boot, so a desktop app opened after a release shows the toast within seconds.
const FIRST_CHECK_MS = 10_000
// How often the updater's unit is asked whether it still runs, and how long one question may take.
const POLL_MS = 5_000
const PROBE_TIMEOUT_MS = 5_000
// Probes in a row that got no answer (no systemctl, no user bus): past this the wait ends without calling the update failed.
const MAX_UNANSWERED = 24
const LOG_LINES = 20
const RESTART_DELAY_MS = 300
const CANNOT = 'This install cannot update itself'
// What releaseSite.ts says for a disk that would not take the download.
const DISK = 'Could not save the update download'
// One message for unsigned and badly signed: either way the release did not come from the publisher's key.
export const UNSIGNED = 'The release is not signed by the ZumiBot publisher'

/** A message made here, fixed text: safe to show. Anything else that fails shows a generic line, never its own text. */
class UpdateError extends Error {}

export interface UpdateDeps {
  dataDir: string
  /** The showcase site that re-publishes the latest release. */
  site: string
  installDir: string | null
  /** Local mode: the shell's folder of downloaded server builds (LOCAL_UPDATES_ENV); null everywhere else. */
  localDir?: string | null
  /** Local mode: this server runs inside the desktop shell. */
  local?: boolean
  /** Local mode: stop this server so the shell starts it again (it exits with LOCAL_RESTART_EXIT). */
  restart?: () => void
  availability: UpdateAvailability
  current: string
  busy: () => number
  broadcast: (s: UpdateStatus) => void
  fetchImpl?: typeof fetch
  /** The key releases must be signed with; RELEASE_PUBLIC_KEY unless a test brings its own. */
  publicKey?: string
  now?: () => number
  /** Starts argv as the transient user unit `unit`, and returns once it is started (not when it ends). */
  runDetached?: (argv: string[], logFile: string, unit: string) => Promise<void>
  /** Whether the transient unit still runs (`systemctl --user is-active` by default): false only when it is known to have ended, null when nobody could tell. */
  isActive?: (unit: string) => Promise<boolean | null>
}

interface State {
  pending?: { from: string; to: string; at: number }
  lastResult?: UpdateResult
}

/**
 * The systemd-run command line: its own transient unit, so the restart of this service cannot take the updater with it.
 * Stderr inherits stdout's file: a second `append:` descriptor would have its own offset and overwrite the output.
 * The unit does not get this process's env, so the data dir (a path, not a secret) is passed for the installer and rollback.
 */
export function systemdRunArgs(argv: string[], logFile: string, unit: string, dataDir: string): string[] {
  return [
    '--user',
    '--collect',
    `--unit=${unit}`,
    `--setenv=ZUMIBOT_DATA_DIR=${dataDir}`,
    '-p',
    `StandardOutput=truncate:${logFile}`,
    '-p',
    'StandardError=inherit',
    ...argv
  ]
}

/**
 * false only when systemd itself says the unit is over; true while it runs. Anything else (no systemctl, no user bus, a
 * timeout: promisify(execFile) gives stdout '' for those) is null, never "dead", so a broken probe cannot fail a good update.
 */
export async function systemctlActive(unit: string): Promise<boolean | null> {
  let out: string
  try {
    out = (await run('systemctl', ['--user', 'is-active', unit], { timeout: PROBE_TIMEOUT_MS })).stdout
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout
    out = typeof stdout === 'string' ? stdout : ''
  }
  const word = out.trim()
  if (/^(active|activating|reloading)$/.test(word)) return true
  if (/^(inactive|failed|dead)$/.test(word)) return false
  return null
}

export function detectAvailability(
  mode: 'vps' | 'local',
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean
): { availability: UpdateAvailability; installDir: string | null; localDir: string | null; local: boolean } {
  if (mode === 'local') {
    // A shell that keeps downloaded builds says where; an older shell, or a dev run, does not, and cannot run one.
    const dir = env[LOCAL_UPDATES_ENV]
    const ok = typeof dir === 'string' && isAbsolute(dir)
    return { availability: ok ? 'ok' : 'local', installDir: null, localDir: ok ? dir : null, local: true }
  }
  if (exists('/.dockerenv') || env.ZUMIBOT_CONTAINER) return { availability: 'container', installDir: null, localDir: null, local: false }
  const dir = env.ZUMIBOT_INSTALL_DIR
  if (!dir || !exists(join(dir, 'bin', 'zumibot-update')))
    return { availability: 'notInstaller', installDir: null, localDir: null, local: false }
  return { availability: 'ok', installDir: dir, localDir: null, local: false }
}

export class UpdateService {
  private release: { info: UpdateRelease; sha256: string; signature: string | undefined; url: string } | null = null
  private checkedAt: number | null = null
  private checking = false
  private error: string | null = null
  private installing = false
  private state: State = {}
  private timer: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private inflight: Promise<UpdateStatus> | null = null

  constructor(private readonly d: UpdateDeps) {}

  private now = (): number => (this.d.now ?? Date.now)()
  private stateFile = (): string => join(this.d.dataDir, 'update.json')
  private logFile = (): string => join(this.d.dataDir, UPDATE_LOG_FILE)
  private signed = (version: string, sha256: string, signature: string | undefined): boolean =>
    verifyReleaseSignature(version, sha256, signature, this.d.publicKey ?? RELEASE_PUBLIC_KEY)

  /** Settles what the last run left, drops killed downloads and an old token file, and starts the timer. */
  async start(): Promise<void> {
    await this.loadState()
    await this.settle()
    if (this.d.installDir) await fs.rm(join(this.d.installDir, 'updates'), { recursive: true, force: true }).catch(() => undefined)
    if (this.d.localDir) await this.dropLocalLeftovers(this.d.localDir)
    // Earlier versions kept a sealed GitHub token here; nothing reads it now, so it does not sit on disk.
    await fs.rm(join(this.d.dataDir, 'update-token.json'), { force: true }).catch(() => undefined)
    const tick = (): void => {
      void this.check().catch(() => undefined)
      this.timer = setTimeout(tick, UPDATE_CHECK_MS)
      this.timer.unref()
    }
    this.timer = setTimeout(tick, FIRST_CHECK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.poll) clearInterval(this.poll)
    this.timer = this.poll = null
  }

  status(): UpdateStatus {
    const latest = this.release?.info ?? null
    return {
      current: this.d.current,
      availability: this.d.availability,
      local: this.d.local ?? false,
      latest,
      newer: latest !== null && isNewer(latest.version, this.d.current),
      checkedAt: this.checkedAt,
      checking: this.checking,
      error: this.error,
      installing: this.installing,
      lastResult: this.state.lastResult ?? null,
      canRollBack: this.canRollBack()
    }
  }

  /**
   * The status a tab asks for when it connects or comes back into view. An answer older than UPDATE_STALE_MS starts a
   * check in the background, whose result reaches every tab, so a release out since the last timer tick shows its toast
   * without anyone pressing Check. Before the first check has run, the boot timer is already on its way.
   */
  seen(): UpdateStatus {
    const stale = this.checkedAt !== null && this.now() - this.checkedAt >= UPDATE_STALE_MS
    if (stale && !this.inflight && !this.installing) void this.check().catch(() => undefined)
    return this.status()
  }

  check(): Promise<UpdateStatus> {
    if (this.inflight) return this.inflight
    // Only an install that can update itself talks to the site.
    if (this.d.availability !== 'ok') return Promise.resolve(this.status())
    const p = this.doCheck().finally(() => {
      this.inflight = null
    })
    this.inflight = p
    return p
  }

  async install(o: { force: boolean }): Promise<{ started: true } | { busy: number }> {
    if (this.d.availability === 'ok' && this.d.localDir) return this.installLocal(this.d.localDir, o)
    const installDir = this.d.installDir
    if (this.d.availability !== 'ok' || !installDir) throw new Error(CANNOT)
    if (this.installing) throw new Error(ALREADY_UPDATING)
    const rel = this.release
    if (!rel || !isNewer(rel.info.version, this.d.current)) throw new Error('There is no newer release to install')
    const busy = this.d.busy()
    if (busy > 0 && !o.force) return { busy }
    // No await since the ALREADY_UPDATING check above, so two calls cannot both get here.
    this.begin()
    const dir = join(installDir, 'updates', `v${rel.info.version}`)
    const tarball = join(dir, TARBALL)
    let pending = false
    try {
      // Checked when the release was found too; again here, the last step before any byte is fetched or run.
      if (!this.signed(rel.info.version, rel.sha256, rel.signature)) throw new UpdateError(UNSIGNED)
      await fs.mkdir(dir, { recursive: true })
      await downloadFile(rel.url, tarball, this.d.fetchImpl)
      // The hash is the signed one, so a truncated or swapped file stops here, before anything is unpacked.
      if (rel.sha256 !== (await sha256File(tarball))) throw new UpdateError('The download did not match its checksum')
      // Only the installer comes out: it is the new release's own, and it unpacks the rest from the tarball itself.
      await run('tar', ['-xzf', tarball, '-C', dir, 'zumibot-server/install.sh']).catch(() => {
        throw new UpdateError('Could not unpack the update')
      })
      // The download took a while: replies may have started since the first look.
      const now = this.d.busy()
      if (now > 0 && !o.force) {
        await this.abandon(dir)
        return { busy: now }
      }
      this.state.pending = { from: this.d.current, to: rel.info.version, at: this.now() }
      await this.saveState()
      pending = true
      await this.launch(
        [
          'sh',
          join(dir, 'zumibot-server', 'install.sh'),
          '--dir',
          installDir,
          '--tarball',
          tarball,
          '--snapshot-data',
          ...(o.force ? ['--force'] : [])
        ],
        rel.info.version,
        dir
      )
      return { started: true }
    } catch (err) {
      this.fail(err)
      await this.abandon(dir, pending)
      throw new Error(this.error ?? 'The update failed')
    }
  }

  /**
   * Local mode: the same signed tarball a VPS gets, unpacked whole into the shell's folder as `v<version>/`, named in
   * `current.json`, then this server exits so the shell starts the new build. There is no installer script, systemd or
   * data snapshot here; the shell falls back to the build it bundles when the new one does not start, and the next boot's
   * settle reads that as a failed update.
   */
  private async installLocal(localDir: string, o: { force: boolean }): Promise<{ started: true } | { busy: number }> {
    if (this.installing) throw new Error(ALREADY_UPDATING)
    const rel = this.release
    if (!rel || !isNewer(rel.info.version, this.d.current)) throw new Error('There is no newer release to install')
    const busy = this.d.busy()
    if (busy > 0 && !o.force) return { busy }
    this.begin()
    // The shell appends here when the new build does not start; an older run's lines must not read as this one's.
    await fs.writeFile(this.logFile(), '').catch(() => undefined)
    const version = rel.info.version
    // One install runs at a time, so the whole downloads folder is this one's to remove.
    const downloads = join(localDir, 'downloads')
    const download = join(downloads, `v${version}`)
    const tarball = join(download, TARBALL)
    const staging = join(localDir, `v${version}.staging`)
    const target = join(localDir, `v${version}`)
    let pending = false
    try {
      if (!this.signed(version, rel.sha256, rel.signature)) throw new UpdateError(UNSIGNED)
      await fs.mkdir(download, { recursive: true })
      await downloadFile(rel.url, tarball, this.d.fetchImpl)
      if (rel.sha256 !== (await sha256File(tarball))) throw new UpdateError('The download did not match its checksum')
      await fs.rm(staging, { recursive: true, force: true })
      await fs.mkdir(staging, { recursive: true })
      // Relative to the builds folder: a GNU tar first on PATH (Git for Windows') cannot take a `C:\...` path.
      await run('tar', ['-xzf', `downloads/v${version}/${TARBALL}`, '-C', `v${version}.staging`], { cwd: localDir }).catch(() => {
        throw new UpdateError('Could not unpack the update')
      })
      // The package names its own version; a build that says another one, or lacks its server, is never run.
      const root = join(staging, 'zumibot-server')
      const named = await fs.readFile(join(root, 'VERSION'), 'utf8').then(
        (t) => t.trim(),
        () => ''
      )
      if (named !== version || !existsSync(join(root, 'app', 'server.mjs'))) throw new UpdateError('The update package is incomplete')
      const now = this.d.busy()
      if (now > 0 && !o.force) {
        await this.abandonLocal(downloads, staging)
        return { busy: now }
      }
      await fs.rm(target, { recursive: true, force: true })
      await fs.rename(staging, target)
      await fs.rm(downloads, { recursive: true, force: true }).catch(() => undefined)
      this.state.pending = { from: this.d.current, to: version, at: this.now() }
      await this.saveState()
      pending = true
      // Last: until this file names it, the shell keeps starting the build it has.
      await writeFileAtomic(join(localDir, LOCAL_CURRENT_FILE), JSON.stringify({ version }))
    } catch (err) {
      this.fail(err)
      await this.abandonLocal(downloads, staging, pending)
      throw new Error(this.error ?? 'The update failed')
    }
    // `installing` stays set: this process is about to end, and every tab waits for the new build. The restart waits a
    // moment, so this call's own answer reaches the tab before the sockets close.
    const restart = this.d.restart
    if (restart) setTimeout(restart, RESTART_DELAY_MS).unref()
    else {
      // A server with no way to ask for a restart (a test, or a caller that wired none): the next start runs the update.
      this.end()
      this.emit()
    }
    return { started: true }
  }

  private async abandonLocal(downloads: string, staging: string, pending = false): Promise<void> {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await this.abandon(downloads, pending)
  }

  /** Downloads and half-unpacked builds a killed install left behind; the shell itself prunes builds it no longer runs. */
  private async dropLocalLeftovers(localDir: string): Promise<void> {
    await fs.rm(join(localDir, 'downloads'), { recursive: true, force: true }).catch(() => undefined)
    const names = await fs.readdir(localDir).catch(() => [] as string[])
    for (const n of names) {
      if (n.endsWith('.staging')) await fs.rm(join(localDir, n), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async rollBack(o: { force: boolean }): Promise<{ started: true } | { busy: number }> {
    const installDir = this.d.installDir
    if (this.d.availability !== 'ok' || !installDir) throw new Error(CANNOT)
    if (this.installing) throw new Error(ALREADY_UPDATING)
    if (!this.canRollBack()) throw new Error('There is nothing to roll back to')
    const busy = this.d.busy()
    if (busy > 0 && !o.force) return { busy }
    this.begin()
    try {
      await this.launch([join(installDir, 'bin', 'zumibot-rollback')], await this.previousVersion(installDir), null)
      return { started: true }
    } catch (err) {
      this.fail(err)
      this.end()
      this.emit()
      throw new Error(this.error ?? 'The rollback failed')
    }
  }

  // Internals ----------------------------------------------------------------

  // Only right after an update that swapped: after a failed one the old pair belongs to an earlier update.
  private canRollBack(): boolean {
    const dir = this.d.installDir
    return (
      this.d.availability === 'ok' &&
      this.state.lastResult?.kind === 'updated' &&
      dir !== null &&
      existsSync(join(dir, 'app.prev')) &&
      existsSync(join(dir, 'data.prev'))
    )
  }

  private emit(): void {
    try {
      this.d.broadcast(this.status())
    } catch {
      console.error('telling the tabs about the update status failed')
    }
  }

  private begin(): void {
    this.installing = true
    this.error = null
    this.emit()
  }

  private end(): void {
    this.installing = false
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  /** An install that stops before the updater started: its download, and its pending note when it was written, go. */
  private async abandon(dir: string, pending = false): Promise<void> {
    this.end()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    if (pending) {
      delete this.state.pending
      await this.saveState()
    }
    this.emit()
  }

  // What data.prev was taken from (the installer notes it), as the rollback script reads it; shown if the rollback fails.
  private async previousVersion(installDir: string): Promise<string> {
    try {
      const v = (await fs.readFile(join(installDir, 'data.prev', '.zumibot-from'), 'utf8')).trim()
      if (/^[A-Za-z0-9._+-]+$/.test(v)) return v
    } catch {
      /* not noted */
    }
    return 'the previous version'
  }

  private async doCheck(): Promise<UpdateStatus> {
    this.checking = true
    this.emit()
    try {
      // 404 is no release published yet: not an error.
      const found = await fetchManifest(this.d.site, this.d.fetchImpl)
      this.error = null
      this.release = null
      if (found) {
        const version = found.manifest.version.replace(/^v/, '')
        const { sha256, signature } = found.manifest
        if (!parseVersion(version)) this.error = 'The latest release has no usable version'
        // Never offered unless signed: the bare version is what the release job signs.
        else if (!this.signed(version, sha256, signature)) this.error = UNSIGNED
        else
          this.release = {
            info: { version, publishedAt: found.manifest.publishedAt, notes: found.manifest.notes },
            sha256,
            signature,
            url: found.url
          }
      }
      this.checkedAt = this.now()
    } catch (err) {
      this.fail(err)
      this.checkedAt = this.now()
    } finally {
      this.checking = false
      this.emit()
    }
    return this.status()
  }

  /** Sets `error` to a message that is safe to show. */
  private fail(err: unknown): void {
    if (err instanceof UpdateError || err instanceof SiteError || (err instanceof Error && err.message === DISK)) {
      this.error = err.message
    } else {
      this.error = 'The update failed'
    }
  }

  private async launch(argv: string[], to: string, dir: string | null): Promise<void> {
    const unit = `zumibot-updater-${this.now()}`
    try {
      await (this.d.runDetached ?? ((a, l, u) => run('systemd-run', systemdRunArgs(a, l, u, this.d.dataDir)).then(() => undefined)))(
        argv,
        this.logFile(),
        unit
      )
    } catch {
      throw new UpdateError('Could not start the updater')
    }
    // The restart ends this process, so an updater that dies before it would leave `installing` set for good: ask its unit.
    // A unit that still runs is only slow (a big data copy); it is never given up on.
    let asking = false
    let unanswered = 0
    this.poll = setInterval(() => {
      if (asking) return
      asking = true
      void (async () => {
        try {
          const alive = await (this.d.isActive ?? systemctlActive)(unit).catch(() => null)
          unanswered = alive === null ? unanswered + 1 : 0
          if (alive === false) await this.unitEnded(to, dir)
          else if (unanswered >= MAX_UNANSWERED) this.stopAsking()
        } finally {
          asking = false
        }
      })()
    }, POLL_MS)
    this.poll.unref()
  }

  /**
   * Nobody can say whether the updater runs. It is not called failed: `pending` and the download stay, so the next boot
   * settles it as updated or failed, and the user can try again meanwhile.
   */
  private stopAsking(): void {
    this.end()
    this.error = 'Could not tell whether the updater is running'
    this.emit()
  }

  /** The updater's unit is gone and this process is still here: it failed before the restart. */
  private async unitEnded(to: string, dir: string | null): Promise<void> {
    // For a roll back `to` is the older version it was going to; the UI reads from > to as "roll back failed".
    this.state.lastResult = { kind: 'failed', from: this.d.current, to, at: this.now(), logTail: await this.logTail() }
    delete this.state.pending
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    await this.saveState()
    // After the awaits: `installing` stays set until the result is stored, so no new install starts in between.
    this.end()
    this.emit()
  }

  private async logTail(): Promise<string | undefined> {
    try {
      const lines = (await fs.readFile(this.logFile(), 'utf8')).split('\n')
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      return lines.length ? lines.slice(-LOG_LINES).join('\n') : undefined
    } catch {
      return undefined
    }
  }

  private async loadState(): Promise<void> {
    this.state = {}
    let raw: { pending?: unknown; lastResult?: unknown }
    try {
      raw = JSON.parse(await fs.readFile(this.stateFile(), 'utf8')) as typeof raw
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    // The file is ours, but it is read back as untyped JSON: a part of the wrong shape is dropped, not trusted.
    const str = (v: unknown): v is string => typeof v === 'string'
    const p = raw.pending as { from?: unknown; to?: unknown; at?: unknown } | null
    if (p && str(p.from) && str(p.to) && typeof p.at === 'number') this.state.pending = { from: p.from, to: p.to, at: p.at }
    const r = raw.lastResult as { kind?: unknown; from?: unknown; to?: unknown; at?: unknown; logTail?: unknown } | null
    if (
      r &&
      (r.kind === 'updated' || r.kind === 'failed' || r.kind === 'rolledBack') &&
      str(r.from) &&
      str(r.to) &&
      typeof r.at === 'number'
    ) {
      this.state.lastResult = { kind: r.kind, from: r.from, to: r.to, at: r.at, ...(str(r.logTail) ? { logTail: r.logTail } : {}) }
    }
  }

  private async saveState(): Promise<void> {
    try {
      await writeFileAtomic(this.stateFile(), JSON.stringify(this.state))
    } catch {
      console.error('saving the update state failed')
    }
  }

  /** What the previous run left: an update that is now running, one that never arrived, or a rollback. */
  private async settle(): Promise<void> {
    const p = this.state.pending
    let changed = false
    if (p) {
      delete this.state.pending
      this.state.lastResult =
        p.to === this.d.current
          ? { kind: 'updated', from: p.from, to: p.to, at: this.now() }
          : { kind: 'failed', from: p.from, to: p.to, at: this.now(), logTail: await this.logTail() }
      changed = true
    }
    // The rollback script wrote this; its mtime is when it happened.
    const note = join(this.d.dataDir, 'update-rolled-back')
    try {
      const at = (await fs.stat(note)).mtimeMs
      let v: { from?: unknown; to?: unknown } = {}
      try {
        v = JSON.parse(await fs.readFile(note, 'utf8')) as typeof v
      } catch {
        /* unreadable: the versions are unknown */
      }
      const name = (x: unknown): string => (typeof x === 'string' && x ? x : 'unknown')
      this.state.lastResult = { kind: 'rolledBack', from: name(v.from), to: name(v.to), at }
      await fs.rm(note, { force: true })
      changed = true
    } catch {
      /* no rollback happened */
    }
    if (changed) await this.saveState()
  }
}
