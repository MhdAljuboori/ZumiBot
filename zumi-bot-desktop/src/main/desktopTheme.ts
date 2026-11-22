import { execFile } from 'node:child_process'

// Chromium on Linux learns the desktop's dark preference from the xdg-desktop-portal over D-Bus, and only
// well after the app is ready: until then nativeTheme reports light, so a dark desktop first paints light.

/** The portal's org.freedesktop.appearance color-scheme: 1 = prefer dark; 0 (no preference) and 2 are light, as in Chromium. */
export function parsePortalColorScheme(stdout: string): boolean | null {
  const m = /uint32 (\d+)/.exec(stdout)
  return m ? m[1] === '1' : null
}

/** Asks the portal directly (~50ms); null when there is no portal or gdbus to answer. */
export function readPortalPrefersDark(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.portal.Desktop',
        '--object-path',
        '/org/freedesktop/portal/desktop',
        '--method',
        'org.freedesktop.portal.Settings.Read',
        'org.freedesktop.appearance',
        'color-scheme'
      ],
      { timeout: 2000 },
      (err, stdout) => resolve(err ? null : parsePortalColorScheme(stdout))
    )
  })
}

export interface ShowGateDeps {
  themeSettled(): boolean // nativeTheme already reports the desktop's preference
  show(): void
}

/** Shows a window created hidden once it has painted and its theme is settled, or on giveUp() whatever the theme. */
export function createShowGate(d: ShowGateDeps): { painted(): void; themeUpdated(): void; giveUp(): void } {
  let painted = false
  let gaveUp = false
  let shown = false
  const tryShow = (): void => {
    if (shown || !painted || !(gaveUp || d.themeSettled())) return
    shown = true
    d.show()
  }
  return {
    painted() {
      painted = true
      tryShow()
    },
    themeUpdated: tryShow,
    giveUp() {
      gaveUp = true
      tryShow()
    }
  }
}
