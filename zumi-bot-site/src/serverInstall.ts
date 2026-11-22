// The server section's commands, built from the address the reader types. Pure, so tests/serverInstall.test.ts can
// check them. They follow docs/architecture/install.md (Phase 3): download, read, run, then the proxy and /setup.

// Where install.sh and the releases live. Fixed, not location.origin: a preview deploy must not hand out its own URL.
export const SITE = 'https://zumibot.run'
export const EXAMPLE_ORIGIN = 'https://zumibot.example.com'
// install.sh's default --dir and its systemd user unit.
const DIR = '~/zumibot'
const UNIT = 'zumibot'

/**
 * The https origin a reader typed ("zumibot.example.com", "https://zumibot.example.com/"), or null when install.sh
 * would refuse it: http, a path, a query, credentials, or a host with characters other than letters, digits, . and -
 * (it writes the host into its configs through sed).
 */
export function originFrom(input: string): string | null {
  const raw = input.trim().replace(/\/+$/, '')
  if (raw === '') return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  const m = /^https:\/\/([A-Za-z0-9.-]+)(:\d{1,5})?$/i.exec(withScheme)
  if (!m) return null
  const host = m[1].toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null
  const port = m[2] ?? ''
  if (port !== '' && (Number(port.slice(1)) < 1 || Number(port.slice(1)) > 65535)) return null
  return `https://${host}${port}`
}

export interface InstallStep {
  title: string
  detail?: string
  commands: string[]
}

/** The steps, in order, for a server that will answer at `origin`. */
export function installSteps(origin: string): InstallStep[] {
  return [
    {
      title: 'Download the installer and read it',
      commands: [`curl -fsSL ${SITE}/releases/latest/install.sh -o install.sh`, 'less install.sh']
    },
    {
      title: 'Install it for the address you will open',
      detail: 'Run it as your own user, not root. It checks the release against the publisher’s signature first.',
      commands: [`sh install.sh --origin ${origin}`]
    },
    {
      title: 'Point your HTTPS proxy at it',
      detail: `Ready-made Caddy and nginx configs are in ${DIR}/proxy/.`,
      commands: []
    },
    {
      title: `Open ${origin}/setup`,
      detail: 'Paste the one-time setup code from the server’s log:',
      commands: [`journalctl --user -u ${UNIT} -n 20 --no-pager`]
    },
    {
      title: 'Update it later',
      detail: 'It waits while a reply is still running.',
      commands: [`${DIR}/bin/zumibot-update`]
    }
  ]
}
