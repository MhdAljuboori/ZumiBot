import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Engine } from '@zumibot/shared/engine'
import { CONNECTOR_TEXT } from '@zumibot/shared/connectors'
import type { Loadout, LoadoutHook, LoadoutSection } from '@zumibot/shared/extensions'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import { api } from '../api'
import { homeFolder, useLoadout } from '../net/useLoadout'
import { useConnected } from '../useConnected'
import {
  cacheNote,
  chooseFolder,
  hookTags,
  loadoutKey,
  readOnlyNote,
  serverTags,
  skillTags,
  totalsText,
  vaultKeysOf
} from '../state/agentLoadout'
import {
  SOURCE_LABEL,
  agentPluginRows,
  agentServerRows,
  agentSkillRows,
  groupBySource,
  pluginHint,
  toggleServer,
  toggleSkill,
  togglePlugin,
  totals,
  type PluginRow,
  type ServerRow,
  type SkillRow
} from '../state/extensions'
import { hookKey, hookRow, pluginLine, sortByName, statusInfo, tokensText, toolsText } from '../state/extensionsPage'
import { joinGuards } from '../state/formGuards'
import type { EditorHandle } from './AgentEditor'
import { OwnHooksCard, OwnServersCard } from './AgentOwnExtensions'
import { LoadoutFolderBar } from './LoadoutFolderBar'

interface Props {
  /** The saved name: the probe runs for the file on disk, not for an unsaved rename in the form. */
  agentName: string
  /** The form's draft: the switches read and write it. null while the raw text does not parse. */
  fields: AgentFields | null
  /** What is on disk: the list shows what this agent loads, and a plugin switched on in the draft says it needs a Save. */
  savedFields: AgentFields | null
  onFields: (patch: Partial<AgentFields>) => void
  /** Zumi Bot and Codex agents: the lists with no switches and no own-server or own-hook editing. */
  readOnly: boolean
  engine: Engine
  /** The open own-server or own-hook sub-form, for the editor's unsaved-changes guard. */
  formHandle?: RefObject<EditorHandle | null>
  /** Opens Settings › Connectors: a catalog connector is switched there, not by this card. */
  onOpenConnectors?: () => void
}

const TITLES: Record<LoadoutSection, string> = { servers: 'Servers', skills: 'Skills', plugins: 'Plugins', hooks: 'Hooks' }

/** One section of the card: a heading with its count, folded by the browser's own details control. */
function Section({
  id,
  count,
  error,
  open,
  children
}: {
  id: LoadoutSection
  count: number
  error?: string
  open?: boolean
  children: ReactNode
}) {
  return (
    <details className="al-section" open={open} data-testid={`agent-ext-${id}`}>
      <summary className="al-summary">
        <span className="al-section-title">{TITLES[id]}</span>
        <span className="al-count">{count}</span>
        {error && (
          <>
            <span className="ext-tab-flag" aria-hidden="true" data-tip="Could not be read">
              !
            </span>
            <span className="sr-only"> (could not be read)</span>
          </>
        )}
      </summary>
      {error && (
        <p className="set-note bad" role="alert" data-testid="agent-ext-section-error">
          {error}
        </p>
      )}
      {!error && count === 0 && <p className="ext-note al-empty">Nothing here.</p>}
      {children}
    </details>
  )
}

/** Rows grouped by where they come from, each group a card. */
function Groups<T extends { source: string }>({ rows, render }: { rows: T[]; render: (row: T, index: number) => ReactNode }) {
  return (
    <>
      {groupBySource(rows).map((g) => (
        <div key={g.source} className="al-group">
          <h5 className="al-group-title">{SOURCE_LABEL[g.source as keyof typeof SOURCE_LABEL] ?? g.source}</h5>
          <div className="set-card">{g.rows.map(render)}</div>
        </div>
      ))}
    </>
  )
}

function Tags({ tags }: { tags: string[] }) {
  return tags.length === 0 ? null : (
    <div className="ext-row-sub">
      {tags.map((t) => (
        <span key={t} className="ext-tag" data-testid="agent-ext-tag">
          {t}
        </span>
      ))}
    </div>
  )
}

export function Switch({
  on,
  label,
  disabled,
  onChange,
  testId = 'agent-ext-switch',
  attrs
}: {
  on: boolean
  label: string
  disabled: boolean
  onChange: (on: boolean) => void
  testId?: string
  attrs?: Record<`data-${string}`, string>
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      data-testid={testId}
      {...attrs}
      aria-label={label}
      aria-checked={on}
      checked={on}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

function ServerLine({
  r,
  readOnly,
  locked,
  onToggle,
  onOpenConnectors
}: {
  r: ServerRow
  readOnly: boolean
  locked: boolean
  onToggle: (on: boolean) => void
  onOpenConnectors?: () => void
}) {
  const st = statusInfo(r.status)
  return (
    <div className="ext-row" data-testid="agent-ext-server" data-name={r.name} data-source={r.source} data-on={r.onForAgent}>
      <div className="ext-row-main">
        <span className="ext-dot" data-tone={st.tone} aria-hidden="true" />
        <span className="set-label ext-name">{r.name}</span>
        <span className="ext-status" data-tone={st.tone}>
          {st.label}
        </span>
        {r.status !== 'disabled' && r.status !== 'unknown' && <span className="ext-status">{toolsText(r.tools.length)}</span>}
        <span className="grow" />
        {!readOnly && r.toggleable && (
          <Switch on={r.onForAgent} label={`${r.name} on for this agent`} disabled={locked} onChange={onToggle} />
        )}
        {r.connector !== null && onOpenConnectors && (
          <button type="button" className="ext-link" data-testid="agent-ext-connector-link" onClick={onOpenConnectors}>
            {CONNECTOR_TEXT.agentRow}
          </button>
        )}
      </div>
      <Tags tags={serverTags(r)} />
    </div>
  )
}

function SkillLine({
  r,
  readOnly,
  locked,
  onToggle
}: {
  r: SkillRow
  readOnly: boolean
  locked: boolean
  onToggle: (on: boolean) => void
}) {
  const tokens = tokensText(r.tokens)
  return (
    <div className="ext-row" data-testid="agent-ext-skill" data-name={r.name} data-source={r.source} data-on={r.onForAgent}>
      <div className="ext-row-main">
        <span className="set-label ext-name">{r.name}</span>
        {tokens && <span className="ext-tag">{tokens}</span>}
        <span className="grow" />
        {!readOnly && r.toggleable && (
          <Switch on={r.onForAgent} label={`${r.name} on for this agent`} disabled={locked} onChange={onToggle} />
        )}
      </div>
      {r.description && <p className="ext-desc">{r.description}</p>}
      <Tags tags={skillTags(r)} />
    </div>
  )
}

function PluginLine({
  r,
  hint,
  readOnly,
  locked,
  onToggle
}: {
  r: PluginRow
  hint: boolean
  readOnly: boolean
  locked: boolean
  onToggle: (on: boolean) => void
}) {
  return (
    <div className="ext-row" data-testid="agent-ext-plugin" data-name={r.id} data-on={r.onForAgent}>
      <div className="ext-row-main">
        <span className="set-label ext-name">{r.id}</span>
        <span className="grow" />
        {readOnly ? (
          <span className="ext-tag">{r.enabled ? 'On' : 'Off'}</span>
        ) : (
          <Switch on={r.onForAgent} label={`${r.id} on for this agent`} disabled={locked} onChange={onToggle} />
        )}
      </div>
      <p className="ext-note">{pluginLine(r, r.onForAgent)}</p>
      <Tags tags={hint ? ['Save to see what it adds'] : []} />
    </div>
  )
}

function HookLine({ h }: { h: LoadoutHook }) {
  const r = hookRow(h)
  return (
    <div className="ext-row" data-testid="agent-ext-hook" data-name={h.event} data-source={h.source}>
      <div className="ext-row-main">
        <span className="set-label ext-name">{h.event}</span>
        <span className="ext-tag">{r.matcher}</span>
        {r.timeout && <span className="ext-tag">{r.timeout}</span>}
        {h.plugin && <span className="ext-tag">{h.plugin}</span>}
      </div>
      <code className="ext-code">{r.line}</code>
      <Tags tags={hookTags(h)} />
    </div>
  )
}

/**
 * Agent Studio's "What this agent loads": the servers, skills, plugins and hooks of the saved agent in a folder, from the server's
 * own probe of the CLI. The switches write the form's draft (`serversOff`, `skillsOff`, `plugins`), so the editor's Save, Revert and
 * unsaved-changes guard cover them; the list stays the saved agent's until a Save, after which the card asks again.
 */
export function AgentLoadout({ agentName, fields, savedFields, onFields, readOnly, engine, formHandle, onOpenConnectors }: Props) {
  const [folder, setFolder] = useState('')
  const [vaultKeys, setVaultKeys] = useState<Array<{ env: string; name: string }>>([])
  const { loadout, loading, error, refresh } = useLoadout(folder, agentName)
  const serverForm = useRef<EditorHandle | null>(null)
  const hookForm = useRef<EditorHandle | null>(null)

  // Both sub-forms answer the editor's guard as one: dirty when either holds a draft, Save takes both into the agent's draft.
  useEffect(() => {
    if (!formHandle) return
    formHandle.current = joinGuards(() => [serverForm.current, hookForm.current])
    return () => {
      formHandle.current = null
    }
  }, [formHandle])

  // The agent's last folder, else home: asked once the socket is up, and after a reconnect while none was found (both
  // calls failed); never over a folder already set.
  const connected = useConnected()
  useEffect(() => setFolder(''), [agentName])
  useEffect(() => {
    if (!connected) return
    let live = true
    Promise.all([api.app.lastFolder(agentName).catch(() => null), homeFolder().catch(() => '')]).then(([last, home]) => {
      if (live) setFolder((f) => (f === '' ? chooseFolder(last, home) : f))
    })
    return () => {
      live = false
    }
  }, [agentName, connected])

  // A Save (or a change on disk) changes what the saved agent loads; the server keys its cache by the file, and this forces the ask.
  const key = loadoutKey(savedFields)
  const seen = useRef(key)
  useEffect(() => {
    if (seen.current === key) return
    seen.current = key
    refresh()
  }, [key, refresh])

  // The Vault keys this agent may use, for the own servers' From Vault picker. A locked or empty vault just offers none.
  useEffect(() => {
    if (readOnly || !connected) return
    let live = true
    const load = (): void => {
      api.vault.list().then(
        (items) => live && setVaultKeys(vaultKeysOf(items, agentName)),
        () => live && setVaultKeys([])
      )
    }
    load()
    const off = api.vault.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [agentName, readOnly, connected])

  const f = fields ?? savedFields
  const locked = fields === null
  const view = (l: Loadout, a: AgentFields) => {
    const servers = agentServerRows(l, a)
    const skills = agentSkillRows(l, a)
    return { servers, skills, plugins: agentPluginRows(l, a), totals: totals(servers, skills) }
  }
  const v = loadout && f ? view(loadout, f) : null
  const note = !readOnly && fields !== null && savedFields !== null ? cacheNote(fields, savedFields) : null

  const body = (): ReactNode => {
    if (loadout === null || f === null || v === null) {
      if (error !== null)
        return (
          <p className="set-note bad" role="alert" data-testid="agent-loadout-error">
            {error}{' '}
            <button type="button" className="btn small" data-testid="agent-loadout-retry" onClick={refresh}>
              Retry
            </button>
          </p>
        )
      return (
        <p className="set-hint" data-testid="agent-loadout-loading">
          {folder === '' ? 'Pick a folder to see what this agent loads there.' : 'Asking Claude Code…'}
        </p>
      )
    }
    return (
      <>
        {error !== null && (
          <p className="set-note bad" role="alert" data-testid="agent-loadout-error">
            {error}{' '}
            <button type="button" className="btn small" data-testid="agent-loadout-retry" onClick={refresh}>
              Retry
            </button>
          </p>
        )}
        <p className="al-totals" data-testid="agent-loadout-totals">
          {totalsText(v.totals)}
        </p>
        {readOnly && (
          <p className="ext-note" data-testid="agent-loadout-readonly">
            {readOnlyNote(engine)}
          </p>
        )}
        {locked && !readOnly && <p className="ext-note">Fix the file in the Raw view to change these.</p>}
        {note && (
          <p className="ext-note warn" data-testid="agent-cache-note">
            {note}
          </p>
        )}

        <Section id="servers" count={v.servers.length} error={loadout.errors.servers} open>
          <Groups
            rows={sortByName(v.servers)}
            render={(r) => (
              <ServerLine
                key={`${r.source}:${r.name}`}
                r={r}
                readOnly={readOnly}
                locked={locked}
                onToggle={(on) => f && onFields(toggleServer(f, r.name, on))}
                onOpenConnectors={onOpenConnectors}
              />
            )}
          />
        </Section>
        <Section id="skills" count={v.skills.length} error={loadout.errors.skills}>
          <Groups
            rows={sortByName(v.skills)}
            render={(r) => (
              <SkillLine
                key={`${r.source}:${r.name}`}
                r={r}
                readOnly={readOnly}
                locked={locked}
                onToggle={(on) => f && onFields(toggleSkill(f, r.name, on))}
              />
            )}
          />
        </Section>
        {engine === 'claude' && (
          <Section id="plugins" count={v.plugins.length} error={loadout.errors.plugins}>
            <div className="set-card">
              {sortByName(v.plugins.map((p) => ({ ...p, name: p.id }))).map((r) => (
                <PluginLine
                  key={r.id}
                  r={r}
                  hint={f !== null && pluginHint(f, savedFields, r.id, r.enabled) === 'save-to-see'}
                  readOnly={readOnly}
                  locked={locked}
                  onToggle={(on) => f && onFields(togglePlugin(f, r.id, on, r.enabled))}
                />
              ))}
            </div>
          </Section>
        )}
        <Section id="hooks" count={loadout.hooks.length} error={loadout.errors.hooks}>
          <Groups rows={loadout.hooks} render={(h, i) => <HookLine key={`${hookKey(h)}:${i}`} h={h} />} />
        </Section>
      </>
    )
  }

  return (
    <section className="card agent-loadout" aria-label="What this agent loads" data-testid="agent-loadout">
      <div className="memory-head">
        <h3 className="card-title">What this agent loads</h3>
      </div>
      <p className="ext-note">The servers, skills, plugins and hooks Claude Code gives this agent when it runs in a folder.</p>
      <LoadoutFolderBar folder={folder} agentName={agentName} loading={loading} onFolder={setFolder} onRefresh={refresh} />
      {body()}
      {!readOnly && fields !== null && (
        <>
          <OwnServersCard fields={fields} loadout={loadout} vaultKeys={vaultKeys} onFields={onFields} handle={serverForm} />
          <OwnHooksCard fields={fields} onFields={onFields} handle={hookForm} />
        </>
      )}
    </section>
  )
}
