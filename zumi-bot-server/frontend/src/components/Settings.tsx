import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import type { Accent, AgentSummary, ThemePref } from '@zumibot/shared/types'
import { KEEP_WARM_CHAT_HOURS, KEEP_WARM_ROOM_HOURS, type KeepWarmSettings } from '@zumibot/shared/keepWarm'
import { api } from '../api'
import type { SettingsSection } from '../state/route'
import { keepWarmLabel, mobileDevice, settingsLabel } from '../state/settings'
import type { EditorHandle } from './AgentEditor'
import { ChannelsSettings } from './ChannelsSettings'
import { ConnectorsSettings } from './ConnectorsSettings'
import { ExtensionsSettings } from './ExtensionsSettings'
import { IslandSettings } from './IslandSettings'
import { JevSettings } from './JevSettings'
import { MenuIcon, type MenuIconName } from './MenuIcon'
import { NotificationsSettings } from './NotificationsSettings'
import { Glyph } from './Sidebar'
import { AccentControl } from './AccentControl'
import { ThemeControl } from './ThemeControl'
import { UsageView } from './UsageView'
import { VaultSettings } from './VaultSettings'
import { AuditLogSettings } from './AuditLogSettings'
import { VoiceSettings } from './VoiceSettings'
import { SearchSelect } from './SearchSelect'
import { Markdown } from './Markdown'
import { aboutLine, canCheck, canOfferRollBack, checkedLine, resultLine } from '../state/update'
import { dismissMessage, startUpdate, updateCall, useUpdate } from '../useUpdate'
import { useConnected } from '../useConnected'

const ICONS: Record<SettingsSection, MenuIconName> = {
  general: 'sliders',
  notifications: 'bell',
  vault: 'lock',
  audit: 'fileText',
  'claude-code': 'settings',
  connectors: 'plug',
  channels: 'messagePlus',
  voice: 'mic',
  jev: 'sparkles',
  usage: 'chart',
  sync: 'sync',
  island: 'bot',
  account: 'user',
  about: 'info'
}

const desktop = (): boolean => api.desktop !== null

interface NavProps {
  /** The small-screen drawer is out. */
  open: boolean
  onClose: () => void
  section: SettingsSection
  sections: SettingsSection[]
  backLabel: string
  /** Some chat waits on an approval, or holds an unseen reply: shown on Back, the way out to it. */
  pending: boolean
  unread: boolean
  onSection: (section: SettingsSection) => void
  onBack: () => void
}

/** Settings' sidebar: the way back and the list of sections. It is the drawer on a small screen, like the chats sidebar. */
export function SettingsNav(p: NavProps) {
  return (
    <aside className={p.open ? 'sidebar settings-nav open' : 'sidebar settings-nav'} id="sidebar" data-testid="settings-nav">
      <div className="sidebar-head">
        <button type="button" className="settings-back" data-testid="settings-back" onClick={p.onBack}>
          <MenuIcon name="arrowLeft" />
          {p.backLabel}
          {p.pending && <span className="approval-badge compact" role="status" aria-label="Approval needed" data-tip="Approval needed" />}
          {!p.pending && p.unread && <span className="unread-dot" role="status" aria-label="Unread messages" data-tip="Unread messages" />}
        </button>
        <span className="grow" />
        <button
          type="button"
          className="head-btn nav-close"
          data-testid="nav-close"
          aria-label="Close sidebar"
          data-tip="Close sidebar"
          onClick={p.onClose}
        >
          <Glyph name="close" />
        </button>
      </div>
      <h2 className="settings-title">Settings</h2>
      <nav className="settings-list" aria-label="Settings">
        {p.sections.map((s) => (
          <button
            key={s}
            type="button"
            className="settings-item"
            data-testid={`settings-nav-${s}`}
            aria-current={s === p.section ? 'page' : undefined}
            onClick={() => p.onSection(s)}
          >
            <MenuIcon name={ICONS[s]} />
            {settingsLabel(s, desktop())}
          </button>
        ))}
      </nav>
    </aside>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-text">
        <span className="set-label">{label}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </span>
      {children}
    </div>
  )
}

function GeneralSettings(p: {
  theme: ThemePref | null
  onThemeChange: (theme: ThemePref) => void
  accent: Accent | null
  onAccentChange: (accent: Accent) => void
}) {
  // null until read; read each time the section opens, so a change made in another tab shows, and again on each reconnect.
  const connected = useConnected()
  const [houseStyle, setHouseStyle] = useState<boolean | null>(null)
  useEffect(() => {
    if (connected) api.app.getHouseStyle().then(setHouseStyle, () => {})
  }, [connected])
  const toggleHouseStyle = (on: boolean) => {
    setHouseStyle(on)
    api.app.setHouseStyle(on).then(setHouseStyle, () => setHouseStyle(!on))
  }
  const [keepWarm, setKeepWarm] = useState<KeepWarmSettings | null>(null)
  useEffect(() => {
    if (connected) api.app.getKeepWarm().then(setKeepWarm, () => {})
  }, [connected])
  const changeKeepWarm = (next: KeepWarmSettings) => {
    const before = keepWarm
    setKeepWarm(next)
    api.app.setKeepWarm(next).then(setKeepWarm, () => setKeepWarm(before))
  }
  return (
    <div data-testid="settings-general">
      <h2 className="set-group">Appearance</h2>
      <div className="set-card">
        <Row label="Theme" hint="Light or dark colors. System follows the setting of your device.">
          <ThemeControl value={p.theme} onChange={p.onThemeChange} />
        </Row>
        <Row label="Color" hint="The app's main color, for buttons, highlights and picked rows. Blue unless you pick another.">
          <AccentControl value={p.accent} onChange={p.onAccentChange} />
        </Row>
      </div>
      <h2 className="set-group">Replies</h2>
      <div className="set-card">
        <label className="set-row">
          <span className="set-text">
            <span className="set-label">Easy-to-read replies</span>
            <span className="set-hint">
              Adds a shared reply style to every agent's system prompt. Applies from each chat's next message.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            data-testid="house-style"
            checked={houseStyle === true}
            disabled={houseStyle === null}
            onChange={(e) => toggleHouseStyle(e.target.checked)}
          />
        </label>
      </div>
      <h2 className="set-group">Tokens</h2>
      <div className="set-card">
        <Row
          label="Keep rooms warm"
          hint="After a big room goes quiet, a tiny check every 55 minutes keeps each member's prompt cache alive, so coming back does not reload its whole context at full price. Costs about a fortieth of a reload per hour."
        >
          <SearchSelect
            className="field"
            data-testid="keep-warm-rooms"
            disabled={keepWarm === null}
            value={keepWarm?.roomHours ?? ''}
            onChange={(v) => keepWarm && changeKeepWarm({ ...keepWarm, roomHours: Number(v) })}
          >
            {KEEP_WARM_ROOM_HOURS.map((h) => (
              <option key={h} value={h}>
                {keepWarmLabel(h)}
              </option>
            ))}
          </SearchSelect>
        </Row>
        <Row label="Keep chats warm" hint="The same for a big single chat. Chats are left alone sooner, so its window is shorter.">
          <SearchSelect
            className="field"
            data-testid="keep-warm-chats"
            disabled={keepWarm === null}
            value={keepWarm?.chatHours ?? ''}
            onChange={(v) => keepWarm && changeKeepWarm({ ...keepWarm, chatHours: Number(v) })}
          >
            {KEEP_WARM_CHAT_HOURS.map((h) => (
              <option key={h} value={h}>
                {keepWarmLabel(h)}
              </option>
            ))}
          </SearchSelect>
        </Row>
      </div>
    </div>
  )
}

function SyncSettings() {
  const shell = api.desktop
  const phone = !shell && mobileDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  return (
    <div data-testid="settings-sync">
      <div className="set-card">
        {shell?.sync ? (
          <Row label="Sync this PC and VPS" hint="Copies ZumiBot data and ~/.zumi both ways. The app reconnects when it finishes.">
            <button type="button" className="btn" data-testid="sync" onClick={() => shell.sync?.()}>
              Sync…
            </button>
          </Row>
        ) : shell ? (
          <Row
            label="Sync this PC and VPS"
            hint="Update the ZumiBot desktop app to use Sync. Until then, close the app and run npm run sync from your source checkout."
          />
        ) : phone ? (
          <Row
            label="Sync your PC and VPS"
            hint="Sync runs in the ZumiBot desktop app on your PC, so it can’t start from a phone or tablet. On the PC, choose Sync… in Settings › Sync & server."
          />
        ) : (
          <Row
            label="Sync this PC and VPS"
            hint="The ZumiBot desktop app on this PC handles sync: open it to choose your VPS connection, start sync and see progress. Your browser may ask permission to launch it. Keep the app open until sync finishes."
          >
            <a className="btn primary" href="zumibot://sync" data-testid="sync-open-desktop">
              Open ZumiBot
            </a>
          </Row>
        )}
      </div>
      {!shell && !phone && <p className="set-foot">Install the latest ZumiBot desktop app if it doesn’t open.</p>}
      {shell && (
        <>
          <h2 className="set-group">Server</h2>
          <div className="set-card">
            <Row label="Switch server" hint="Choose Local or a VPS for this app.">
              <button type="button" className="btn" data-testid="switch-server" onClick={() => shell.switchServer()}>
                Switch server…
              </button>
            </Row>
          </div>
        </>
      )}
    </div>
  )
}

function AccountSettings({ vps }: { vps: boolean }) {
  if (!vps)
    return (
      <p className="set-intro" data-testid="settings-account">
        This server has no sign-in, so there is nothing to sign out of.
      </p>
    )
  return (
    <div data-testid="settings-account">
      <div className="set-card">
        <Row label="Sign out" hint="Signs this browser out.">
          <button type="button" className="btn" data-testid="sign-out" onClick={() => void api.session.signOut()}>
            Sign out
          </button>
        </Row>
        <Row label="Sign out everywhere" hint="Signs out every browser and device, this one too.">
          <button
            type="button"
            className="btn danger-outline"
            data-testid="sign-out-everywhere"
            onClick={() => void api.session.signOutEverywhere()}
          >
            Sign out everywhere
          </button>
        </Row>
      </div>
    </div>
  )
}

function AboutSettings() {
  const u = useUpdate()
  const s = u.status
  const [busy, setBusy] = useState(false)
  // One call at a time, so a double click cannot send two.
  const run = (call: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    void call().finally(() => setBusy(false))
  }
  const can = s?.availability === 'ok'
  const rollable = s !== null && canOfferRollBack(s)
  return (
    <div data-testid="settings-about">
      <div className="set-card">
        <Row label="ZumiBot">
          <span className="set-value" data-testid="about-version">
            Version {s?.current ?? __APP_VERSION__}
          </span>
        </Row>
        {s && (
          <>
            <Row label="Updates" hint={aboutLine(s)}>
              {can && (
                <span className="set-actions">
                  <button
                    type="button"
                    className="btn"
                    data-testid="about-check"
                    disabled={busy || !canCheck(s)}
                    onClick={() => run(() => updateCall(() => api.update.check()))}
                  >
                    Check for updates
                  </button>
                  {s.newer && s.latest && (
                    <button
                      type="button"
                      className="btn primary"
                      data-testid="about-install"
                      disabled={busy || s.installing || u.pending}
                      onClick={() => run(() => startUpdate('install'))}
                    >
                      Install update
                    </button>
                  )}
                </span>
              )}
            </Row>
            {can && (
              <>
                <Row label="Latest">
                  <span className="set-value" data-testid="about-latest">
                    {s.latest ? s.latest.version : 'Unknown'}
                  </span>
                </Row>
                <Row label="Last checked">
                  <span className="set-value" data-testid="about-checked">
                    {checkedLine(s.checkedAt)}
                  </span>
                </Row>
              </>
            )}
            {can && s.error && (
              <div className="set-block">
                <p className="set-note bad" data-testid="about-error">
                  {s.error}
                </p>
              </div>
            )}
            {u.message && (
              <div className="set-block">
                <p className="set-note bad" role="alert" data-testid="about-message">
                  {u.message}{' '}
                  <button type="button" className="btn small" onClick={dismissMessage}>
                    OK
                  </button>
                </p>
              </div>
            )}
            {can && s.newer && s.latest && s.latest.notes.trim() !== '' && (
              <div className="set-block">
                <span className="set-label">What's new in {s.latest.version}</span>
                <div className="about-notes" data-testid="about-notes">
                  <Markdown text={s.latest.notes} />
                </div>
              </div>
            )}
            {s.lastResult && (
              <div className="set-block" data-testid="about-result">
                <p className={s.lastResult.kind === 'failed' ? 'set-note bad' : 'set-hint'}>{resultLine(s.lastResult)}</p>
                {s.lastResult.logTail && <pre className="about-log">{s.lastResult.logTail}</pre>}
                {can && rollable && (
                  <div className="set-actions">
                    <button
                      type="button"
                      className="btn danger-outline"
                      data-testid="about-rollback"
                      disabled={busy || s.installing || u.pending}
                      onClick={() => run(() => startUpdate('rollBack'))}
                    >
                      Roll back
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <div className="set-block about-body">
          <p>
            ZumiBot is where you chat with your Claude Code agents. Every reply runs the real Claude Code with that agent, on the machine
            this server runs on.
          </p>
          <ul>
            <li>Chat with one agent, or bring several into a group chat where a moderator picks who answers next.</li>
            <li>Approve or deny each tool an agent wants to use, right in the chat.</li>
            <li>Ask Zumi Bot to create, edit or delete agents for you.</li>
            <li>Use it from any browser through your server, or on your own PC with the desktop app.</li>
          </ul>
        </div>
      </div>
      <p className="set-foot about-credit" data-testid="about-credit">
        Built by Mohammed Al-Juboori
        <a href="https://mhdaljuboori.me/" target="_blank" rel="noreferrer">
          mhdaljuboori.me
        </a>
      </p>
    </div>
  )
}

interface PageProps {
  section: SettingsSection
  vps: boolean
  theme: ThemePref | null
  onThemeChange: (theme: ThemePref) => void
  accent: Accent | null
  onAccentChange: (accent: Accent) => void
  agents: AgentSummary[]
  /** The chat the Usage section is filtered to (opened from a chat's cost chip). */
  usageChat: string | null
  usageChatTitle: string | null
  onClearUsageChat: () => void
  onOpenChat: (chatId: string) => void
  /** Audit log's Show in chat: the chat, scrolled to the item. */
  onOpenItem: (chatId: string, itemId: string | null) => void
  chatTitle: (chatId: string) => string | null
  /** The open form's side of the unsaved-changes guard (the Vault and Claude Code sections'). */
  editorHandle: RefObject<EditorHandle | null>
  /** Opens another section through App's unsaved-changes guard (the links between Connectors and Claude Code). */
  onSection: (section: SettingsSection) => void
}

/** The open Settings section, in the main area. */
export function SettingsPage(p: PageProps) {
  // Usage has its own heading row, with its filters beside it.
  if (p.section === 'usage') {
    return (
      <UsageView
        chatId={p.usageChat}
        chatTitle={p.usageChatTitle}
        agents={p.agents}
        onClearChat={p.onClearUsageChat}
        onOpenChat={p.onOpenChat}
      />
    )
  }
  return (
    <div className="settings-page" data-testid="settings-page">
      <div className="settings-inner">
        <h1 className="settings-h1">{settingsLabel(p.section, desktop())}</h1>
        {p.section === 'general' && (
          <GeneralSettings theme={p.theme} onThemeChange={p.onThemeChange} accent={p.accent} onAccentChange={p.onAccentChange} />
        )}
        {p.section === 'notifications' && <NotificationsSettings />}
        {p.section === 'vault' && <VaultSettings agents={p.agents} handle={p.editorHandle} />}
        {p.section === 'claude-code' && <ExtensionsSettings handle={p.editorHandle} onOpenConnectors={() => p.onSection('connectors')} />}
        {p.section === 'connectors' && <ConnectorsSettings agents={p.agents} onSection={p.onSection} />}
        {p.section === 'channels' && <ChannelsSettings agents={p.agents} />}
        {p.section === 'audit' && <AuditLogSettings chatTitle={p.chatTitle} onOpenItem={p.onOpenItem} />}
        {p.section === 'voice' && <VoiceSettings agents={p.agents} />}
        {p.section === 'jev' && <JevSettings />}
        {p.section === 'sync' && <SyncSettings />}
        {p.section === 'island' && <IslandSettings agents={p.agents} />}
        {p.section === 'account' && <AccountSettings vps={p.vps} />}
        {p.section === 'about' && <AboutSettings />}
      </div>
    </div>
  )
}
