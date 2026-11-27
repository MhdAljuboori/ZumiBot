import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

const DEBOUNCE_MS = 400
// Folders whose whole tree the CLI reads: a skill, a command (a nested one is `/folder:name`).
const TREES = new Set(['skills', 'commands'])
// The CLI rewrites these at every start (claude.ai's synced skills; `.trash` is where a deleted skill goes). A re-probe is
// a CLI start, so firing on them would loop.
const SKIP_IN_TREE = new Set(['synced', '.trash'])
// `plugins/` holds the CLI's caches and synced plugins, rewritten at every start too: only the install list counts.
const PLUGINS = 'plugins'
const PLUGINS_FILE = 'installed_plugins.json'
// Plugin switches and `skillOverrides`.
const SETTINGS = 'settings.json'

/**
 * Watches what the `/` menu and the Claude Code page read from the user's Claude config folder: `skills/` and `commands/`
 * (a skill or command added, edited or removed), `plugins/installed_plugins.json` (a plugin installed or updated) and
 * `settings.json` (a plugin or skill switched). Calls `onChange` once per burst. A folder made after the start is watched
 * from then on. A missing config folder gives a stop that does nothing. The returned function stops every watch.
 */
export function watchClaudeConfig(claudeDir: string, onChange: () => void, debounceMs = DEBOUNCE_MS): () => void {
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const subs = new Map<string, FSWatcher>()

  const fire = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      // A throwing listener must not become an uncaught exception.
      try {
        onChange()
      } catch {
        /* the next change tries again */
      }
    }, debounceMs)
  }

  const drop = (name: string): void => {
    subs.get(name)?.close()
    subs.delete(name)
  }

  // True when a watch was started; a missing folder is picked up by the top watch when it appears.
  const attach = (name: string): boolean => {
    if (stopped || subs.has(name)) return false
    const path = join(claudeDir, name)
    let w: FSWatcher
    try {
      w =
        name === PLUGINS
          ? fsWatch(path, (_ev, f) => {
              if (f !== null && String(f) === PLUGINS_FILE) fire()
            })
          : fsWatch(path, { recursive: true }, (_ev, f) => {
              // No name, no way to tell the CLI's own churn from a change: ignored rather than risk a loop.
              if (f === null) return
              if (!SKIP_IN_TREE.has(String(f).split(/[\\/]/)[0])) fire()
            })
    } catch {
      return false
    }
    // A removed folder or EPERM emits 'error'; unhandled, it would crash the main process.
    w.on('error', () => {
      if (subs.get(name) === w) drop(name)
    })
    subs.set(name, w)
    return true
  }

  let top: FSWatcher
  try {
    top = fsWatch(claudeDir, (_ev, f) => {
      const name = f === null ? '' : String(f)
      if (name === SETTINGS) return fire()
      if (!(TREES.has(name) || name === PLUGINS)) return
      // Only a folder made or removed counts here; what changes inside it is its own watch's to report.
      if (subs.has(name)) {
        if (!existsSync(join(claudeDir, name))) {
          drop(name)
          fire()
        }
      } else if (attach(name)) fire()
    })
  } catch {
    return () => {}
  }
  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    for (const name of [...subs.keys()]) drop(name)
    top.close()
  }
  top.on('error', stop)
  for (const name of [...TREES, PLUGINS]) attach(name)
  return stop
}
