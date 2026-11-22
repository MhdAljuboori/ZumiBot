import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autostartEntry, autostartFile, syncAutostart, wantsHidden } from '../src/main/autostart'

function fakeFs(initial?: string) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set('/c/autostart/zumibot.desktop', initial)
  const writes: string[] = []
  return {
    files,
    writes,
    fs: {
      readFileSync: (f: string) => {
        if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return files.get(f)!
      },
      writeFileSync: (f: string, d: string) => void (writes.push(f), files.set(f, d)),
      mkdirSync: () => undefined,
      rmSync: (f: string) => void files.delete(f)
    }
  }
}

describe('autostart', () => {
  it('writes the exact entry', () => {
    expect(autostartEntry('/opt/ZumiBot/zumibot')).toBe(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=ZumiBot',
        'Comment=Start ZumiBot in the tray',
        'Exec=/opt/ZumiBot/zumibot --hidden',
        'Icon=zumibot',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        ''
      ].join('\n')
    )
  })

  it('quotes an exec holding a space or a special character', () => {
    expect(autostartEntry('/opt/Zumi Bot/zumibot')).toContain('Exec="/opt/Zumi Bot/zumibot" --hidden')
    expect(autostartEntry('/opt/a$b/zumibot')).toContain('Exec="/opt/a\\$b/zumibot" --hidden')
    expect(autostartEntry('/opt/a"b`c\\d/x')).toContain('Exec="/opt/a\\"b\\`c\\\\d/x" --hidden')
  })

  it('finds the autostart folder from XDG_CONFIG_HOME or the home', () => {
    expect(autostartFile({ XDG_CONFIG_HOME: '/x' }, '/h')).toBe(join('/x', 'autostart', 'zumibot.desktop'))
    expect(autostartFile({}, '/h')).toBe(join('/h', '.config', 'autostart', 'zumibot.desktop'))
  })

  it('wantsHidden reads --hidden', () => {
    expect(wantsHidden(['zumibot', '--hidden'])).toBe(true)
    expect(wantsHidden(['zumibot'])).toBe(false)
  })

  it('an unpackaged run touches nothing', () => {
    const t = fakeFs()
    expect(syncAutostart({ on: true, packaged: false, file: '/c/autostart/zumibot.desktop', exec: '/x' }, t.fs)).toBe('skipped')
    expect(syncAutostart({ on: false, packaged: false, file: '/c/autostart/zumibot.desktop', exec: '/x' }, t.fs)).toBe('skipped')
    expect(t.writes).toEqual([])
  })

  it('on writes once, then leaves an identical file alone', () => {
    const t = fakeFs()
    const o = { on: true, packaged: true, file: '/c/autostart/zumibot.desktop', exec: '/opt/zumibot' }
    expect(syncAutostart(o, t.fs)).toBe('written')
    expect(t.files.get(o.file)).toBe(autostartEntry('/opt/zumibot'))
    expect(syncAutostart(o, t.fs)).toBe('skipped')
    expect(t.writes).toHaveLength(1)
  })

  it('on rewrites a file whose content differs', () => {
    const t = fakeFs('stale')
    const o = { on: true, packaged: true, file: '/c/autostart/zumibot.desktop', exec: '/opt/zumibot' }
    expect(syncAutostart(o, t.fs)).toBe('written')
    expect(t.files.get(o.file)).toBe(autostartEntry('/opt/zumibot'))
  })

  it('off removes the file, and a missing one quietly', () => {
    const t = fakeFs('x')
    const o = { on: false, packaged: true, file: '/c/autostart/zumibot.desktop', exec: '/opt/zumibot' }
    expect(syncAutostart(o, t.fs)).toBe('removed')
    expect(t.files.has(o.file)).toBe(false)
    // a real rmSync with force: true says nothing for a missing file
    const calls: unknown[] = []
    expect(syncAutostart(o, { ...t.fs, rmSync: (f, opts) => void calls.push([f, opts]) })).toBe('removed')
    expect(calls).toEqual([[o.file, { force: true }]])
  })
})
