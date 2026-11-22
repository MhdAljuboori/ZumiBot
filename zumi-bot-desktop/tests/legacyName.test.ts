import { describe, expect, it } from 'vitest'
import { migrateLegacyShell, type LegacyFs } from '../src/main/legacyName'

// The fake tree is kept in / form: on Windows node:path joins with backslashes.
const slash = (p: string) => p.replaceAll('\\', '/')

function fakeFs(present: string[]): LegacyFs & { files: Set<string>; removed: string[] } {
  const files = new Set(present)
  const removed: string[] = []
  return {
    files,
    removed,
    existsSync: (p) => files.has(slash(p)) || [...files].some((f) => f.startsWith(slash(p) + '/')),
    mkdirSync: () => undefined,
    copyFileSync: (from, to) => {
      if (!files.has(slash(from))) throw new Error('missing')
      files.add(slash(to))
    },
    rmSync: (p) => {
      removed.push(slash(p))
      files.delete(slash(p))
    }
  }
}

const o = { appData: '/c', userData: '/c/ZumiBot', autostartDir: '/c/autostart' }

describe('migrateLegacyShell', () => {
  it('copies the shell files it finds and drops the old login entry', () => {
    const fs = fakeFs(['/c/ClaudeBot/server.json', '/c/ClaudeBot/sync.env', '/c/ClaudeBot/Cookies'])
    expect(migrateLegacyShell(o, fs)).toEqual(['server.json', 'sync.env'])
    expect(fs.files.has('/c/ZumiBot/server.json')).toBe(true)
    expect(fs.files.has('/c/ZumiBot/Cookies')).toBe(false)
    expect(fs.files.has('/c/ClaudeBot/server.json')).toBe(true)
    expect(fs.removed).toEqual(['/c/autostart/claudebot.desktop'])
  })

  it('never overwrites a file the new folder already has', () => {
    const fs = fakeFs(['/c/ClaudeBot/server.json', '/c/ZumiBot/server.json'])
    expect(migrateLegacyShell(o, fs)).toEqual([])
    expect(fs.removed).toEqual([])
  })

  it('does nothing without the old folder', () => {
    expect(migrateLegacyShell(o, fakeFs([]))).toEqual([])
  })
})
