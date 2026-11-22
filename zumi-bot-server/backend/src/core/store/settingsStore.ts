import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isAccent, isThemePref, type AppSettings } from '@zumibot/shared/types'
import { KEEP_WARM_DEFAULT, keepWarmOf } from '@zumibot/shared/keepWarm'
import { writeFileAtomic } from '../fsutil'

const defaults = (): AppSettings => ({
  claudePath: null,
  lastFolderByAgent: {},
  theme: 'system',
  accent: 'blue',
  lastGroupFolder: null,
  houseStyle: true,
  keepWarm: { ...KEEP_WARM_DEFAULT },
  worktreeFolders: []
})

// The server's own zone is not the user's: schedules and times shown follow the page's.
function validZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export class SettingsStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'settings.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<AppSettings> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      // Only a missing file means defaults. A passing EMFILE or EACCES must not read as empty, or the next write would
      // replace the user's real settings with them.
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') return defaults()
      throw err
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults()
      const raw = parsed as Partial<AppSettings>
      return {
        claudePath: typeof raw.claudePath === 'string' ? raw.claudePath : null,
        lastFolderByAgent: raw.lastFolderByAgent && typeof raw.lastFolderByAgent === 'object' ? { ...raw.lastFolderByAgent } : {},
        theme: isThemePref(raw.theme) ? raw.theme : 'system',
        accent: isAccent(raw.accent) ? raw.accent : 'blue',
        lastGroupFolder: typeof raw.lastGroupFolder === 'string' ? raw.lastGroupFolder : null,
        // On unless turned off: a file from before the setting, or a bad value, reads as on.
        houseStyle: raw.houseStyle !== false,
        keepWarm: keepWarmOf(raw.keepWarm),
        worktreeFolders: Array.isArray(raw.worktreeFolders) ? raw.worktreeFolders.filter((f): f is string => typeof f === 'string') : [],
        // Absent until the page reports one; a stored value that is not a usable zone reads as absent.
        ...(typeof raw.timeZone === 'string' && validZone(raw.timeZone) ? { timeZone: raw.timeZone } : {})
      }
    } catch {
      return defaults() // a corrupt file holds nothing worth keeping
    }
  }

  private async write(s: AppSettings): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.file, JSON.stringify(s, null, 2))
  }

  get(): Promise<AppSettings> {
    return this.run(() => this.read())
  }

  set(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.run(async () => {
      const next = { ...(await this.read()), ...patch }
      await this.write(next)
      return next
    })
  }

  async setLastFolder(agent: string, folder: string): Promise<void> {
    await this.run(async () => {
      const cur = await this.read()
      await this.write({ ...cur, lastFolderByAgent: { ...cur.lastFolderByAgent, [agent]: folder } })
    })
  }

  async setLastGroupFolder(cwd: string): Promise<void> {
    await this.run(async () => {
      await this.write({ ...(await this.read()), lastGroupFolder: cwd })
    })
  }

  async worktreeOn(top: string): Promise<boolean> {
    return (await this.get()).worktreeFolders.includes(top)
  }

  async setWorktreeFolder(top: string, on: boolean): Promise<void> {
    await this.run(async () => {
      const cur = await this.read()
      if (cur.worktreeFolders.includes(top) === on) return
      await this.write({ ...cur, worktreeFolders: on ? [...cur.worktreeFolders, top] : cur.worktreeFolders.filter((f) => f !== top) })
    })
  }

  async timeZone(): Promise<string | null> {
    return (await this.get()).timeZone ?? null
  }

  async setTimeZone(tz: string): Promise<void> {
    if (!validZone(tz)) return
    await this.run(async () => {
      const cur = await this.read()
      if (cur.timeZone === tz) return
      await this.write({ ...cur, timeZone: tz })
    })
  }

  async renameAgent(oldName: string, newName: string): Promise<void> {
    await this.run(async () => {
      const cur = await this.read()
      if (!(oldName in cur.lastFolderByAgent) || oldName === newName) return
      const map = { ...cur.lastFolderByAgent }
      map[newName] = map[oldName]
      delete map[oldName]
      await this.write({ ...cur, lastFolderByAgent: map })
    })
  }
}
