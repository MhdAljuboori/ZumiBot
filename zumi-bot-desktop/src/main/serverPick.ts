import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LOCAL_CURRENT_FILE, isNewer, localCurrentVersion } from '@zumibot/shared/update'

// Local mode's server updates (docs/architecture/updates.md, Local mode): the server unpacks a signed release into
// `<dir>/v<x.y.z>/zumibot-server/` and names it in `<dir>/current.json`; the shell decides here which build to start.

export interface ServerPick {
  entry: string
  version: string
  /** A build the server downloaded, not the one this app bundles. */
  downloaded: boolean
}

export interface PickFs {
  read(path: string): string | null
  exists(path: string): boolean
}

export const realFs: PickFs = {
  read: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  exists: existsSync
}

export const downloadedEntry = (dir: string, version: string): string => join(dir, `v${version}`, 'zumibot-server', 'app', 'server.mjs')

/**
 * The downloaded build `current.json` names, when it is complete and newer than the bundled one; else the bundled one.
 * A newer desktop install therefore wins over an older download, and an equal one runs what the app shipped with.
 */
export function pickServer(o: { bundledEntry: string; bundledVersion: string; dir: string | null; fs?: PickFs }): ServerPick {
  const fs = o.fs ?? realFs
  const bundled = { entry: o.bundledEntry, version: o.bundledVersion, downloaded: false }
  if (!o.dir) return bundled
  const v = localCurrentVersion(fs.read(join(o.dir, LOCAL_CURRENT_FILE)))
  if (!v || !isNewer(v, o.bundledVersion)) return bundled
  const entry = downloadedEntry(o.dir, v)
  return fs.exists(entry) ? { entry, version: v, downloaded: true } : bundled
}

/** The build folders to delete: every `v<x.y.z>` but the one kept (a running server's folder is never in the list). */
export function buildsToPrune(names: readonly string[], keep: string | null): string[] {
  return names.filter((n) => /^v\d+\.\d+\.\d+$/.test(n) && n !== (keep === null ? null : `v${keep}`))
}

/** Best effort: a folder that cannot be removed now is tried again at the next launch. */
export function pruneBuilds(dir: string, keep: string | null): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of buildsToPrune(names, keep)) {
    try {
      rmSync(join(dir, n), { recursive: true, force: true })
    } catch {
      /* next launch */
    }
  }
  // current.json naming a build that is not kept (older than the bundled one, or gone) is dropped with it.
  if (keep === null) {
    try {
      rmSync(join(dir, LOCAL_CURRENT_FILE), { force: true })
    } catch {
      /* next launch */
    }
  }
}

/**
 * A downloaded build that would not start: current.json goes, so this and every later launch runs the bundled build, and
 * why it failed goes to the data dir's update log, which the bundled server's boot settle shows as the failed update.
 */
export function forgetBuild(dir: string, version: string, logFile: string | null, why: string): void {
  try {
    rmSync(join(dir, LOCAL_CURRENT_FILE), { force: true })
    rmSync(join(dir, `v${version}`), { recursive: true, force: true })
  } catch {
    /* pruned at the next launch */
  }
  if (!logFile) return
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, `ZumiBot v${version} did not start; running the version this app came with.\n${why}\n`)
  } catch {
    console.error('could not write the update log')
  }
}
