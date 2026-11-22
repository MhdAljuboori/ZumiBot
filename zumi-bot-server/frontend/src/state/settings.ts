import { SETTINGS_SECTIONS, type SettingsSection } from './route'

const LABELS: Record<SettingsSection, string> = {
  general: 'General',
  notifications: 'Notifications',
  vault: 'Vault',
  audit: 'Audit log',
  'claude-code': 'Claude Code',
  connectors: 'Connectors',
  channels: 'Channels',
  voice: 'Voice input',
  jev: 'Jev decisions',
  usage: 'Usage',
  sync: 'Sync',
  island: 'Island & startup',
  account: 'Account',
  about: 'About'
}

/** A section's name in the Settings nav, its heading and the small-screen bar. */
export const settingsLabel = (section: SettingsSection, desktop: boolean): string =>
  section === 'sync' && desktop ? 'Sync & server' : LABELS[section]

/** The sections the nav lists: Account holds only sign-out, so only a server with a sign-in has it; Island only a shell that has one. */
export const visibleSections = (vps: boolean, island: boolean): SettingsSection[] =>
  SETTINGS_SECTIONS.filter((s) => (s !== 'account' || vps) && (s !== 'island' || island))

/** The section to draw: a link to Island in a browser or an older shell opens General, since there is nothing to show. */
export const shownSection = (section: SettingsSection, island: boolean): SettingsSection =>
  section === 'island' && !island ? 'general' : section

/**
 * A phone or tablet. The desktop app runs only on a PC, so Sync's `zumibot://sync` link has nothing to open there.
 * iPadOS says Macintosh, so a touch screen tells it from a Mac.
 */
export const mobileDevice = (ua: string, maxTouchPoints: number): boolean =>
  /Android|iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)

/** A keep-warm window in the General section's selects. */
export const keepWarmLabel = (hours: number): string => (hours === 0 ? 'Off' : `${hours} hours`)
