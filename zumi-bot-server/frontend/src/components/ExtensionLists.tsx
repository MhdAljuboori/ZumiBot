import { useState, type ReactNode } from 'react'
import type { Loadout, LoadoutHook, LoadoutPlugin, LoadoutServer, LoadoutSkill } from '@zumibot/shared/extensions'
import { SOURCE_LABEL, groupBySource } from '../state/extensions'
import {
  emptyText,
  hookKey,
  hookRow,
  listedHooks,
  listedServers,
  pluginLine,
  serverRow,
  shownOn,
  skillRow,
  sortByName,
  statusInfo,
  tokensText,
  toolsText,
  type PendingSwitch
} from '../state/extensionsPage'

/** Rows grouped by where they come from, each group a card. */
function Groups<T extends { source: string }>({
  rows,
  render,
  testId
}: {
  rows: T[]
  render: (row: T, index: number) => ReactNode
  testId: string
}) {
  return (
    <>
      {groupBySource(rows).map((g) => (
        <section key={g.source} data-testid={`${testId}-${g.source}`}>
          <h2 className="set-group">{SOURCE_LABEL[g.source as keyof typeof SOURCE_LABEL] ?? g.source}</h2>
          <div className="set-card">{g.rows.map(render)}</div>
        </section>
      ))}
    </>
  )
}

/** The head of a tab's list: its Add button, or a line saying where things are added. */
function Head({ children }: { children: ReactNode }) {
  return <div className="ext-head">{children}</div>
}

interface ServersProps {
  loadout: Loadout
  /** The row an action is working on. */
  busy: string | null
  onAdd: () => void
  onEdit: (s: LoadoutServer) => void
  onRemove: (s: LoadoutServer) => void
}

function ServerRow({ s, busy, onEdit, onRemove }: { s: LoadoutServer; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const info = serverRow(s)
  const st = statusInfo(s.status)
  return (
    <div className="ext-row" data-testid="ext-server" data-name={s.name} data-source={s.source} data-status={s.status}>
      <div className="ext-row-main">
        <span className="ext-dot" data-tone={st.tone} aria-hidden="true" />
        <span className="set-label ext-name">{s.name}</span>
        <span className="ext-status" data-tone={st.tone} data-testid="ext-status">
          {st.label}
        </span>
        <span className="grow" />
        {info.scope !== null && (
          <span className="set-actions">
            <button
              type="button"
              className="btn small"
              data-testid="ext-edit"
              aria-label={`Edit ${s.name}`}
              disabled={busy}
              onClick={onEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn small danger-outline"
              data-testid="ext-remove"
              aria-label={`Remove ${s.name}`}
              disabled={busy}
              onClick={onRemove}
            >
              Remove
            </button>
          </span>
        )}
      </div>
      <div className="ext-row-sub">
        {s.transport && <span>{s.transport}</span>}
        {s.tools.length > 0 ? (
          <button type="button" className="ext-link" data-testid="ext-tools-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {toolsText(s.tools.length)}
          </button>
        ) : (
          s.status === 'connected' && <span>{toolsText(0)}</span>
        )}
        {info.note && <span data-testid="ext-note">{info.note}</span>}
      </div>
      {/* serverRow already names a read-only row's own note in the line above. */}
      {s.note && s.note !== info.note && <p className="ext-note">{s.note}</p>}
      {info.signIn && (
        <p className="ext-note warn" data-testid="ext-signin">
          {info.signIn}
        </p>
      )}
      {open && (
        <ul className="ext-tools" data-testid="ext-tools">
          {s.tools.map((t) => (
            <li key={t} className="vault-mono">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ServersList({ loadout, busy, onAdd, onEdit, onRemove }: ServersProps) {
  const servers = listedServers(loadout)
  return (
    <>
      <Head>
        <span className="grow" />
        <button type="button" className="btn primary small" data-testid="ext-add-server" onClick={onAdd}>
          Add server
        </button>
      </Head>
      {servers.length === 0 ? (
        !loadout.errors.servers && (
          <p className="set-hint" data-testid="ext-empty">
            {emptyText('servers')}
          </p>
        )
      ) : (
        <Groups
          testId="ext-group"
          rows={sortByName(servers)}
          render={(s) => (
            <ServerRow
              key={`${s.source}:${s.name}`}
              s={s}
              busy={busy === `server:${s.name}`}
              onEdit={() => onEdit(s)}
              onRemove={() => onRemove(s)}
            />
          )}
        />
      )}
    </>
  )
}

interface PluginsProps {
  loadout: Loadout
  pending: ReadonlyMap<string, PendingSwitch>
  switching: ReadonlySet<string>
  onSwitch: (id: string, on: boolean) => void
}

export function PluginsList({ loadout, pending, switching, onSwitch }: PluginsProps) {
  const row = (p: LoadoutPlugin): ReactNode => {
    const key = `plugin:${p.id}`
    const on = shownOn(p.enabled, pending.get(key), loadout.at)
    return (
      <label key={p.id} className="set-row" data-testid="ext-plugin" data-name={p.id} data-source="plugin">
        <span className="set-text">
          <span className="set-label">{p.id}</span>
          <span className="set-hint">{pluginLine(p)}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          data-testid="ext-plugin-switch"
          aria-checked={on}
          checked={on}
          disabled={switching.has(key)}
          onChange={(e) => onSwitch(p.id, e.target.checked)}
        />
      </label>
    )
  }
  return (
    <>
      <Head>
        <span className="set-hint">Install plugins with the claude plugin command. Switch them on and off here.</span>
      </Head>
      {loadout.plugins.length === 0 ? (
        !loadout.errors.plugins && (
          <p className="set-hint" data-testid="ext-empty">
            {emptyText('plugins')}
          </p>
        )
      ) : (
        <div className="set-card">{sortByName(loadout.plugins.map((p) => ({ ...p, name: p.id }))).map(row)}</div>
      )}
    </>
  )
}

interface SkillsProps {
  loadout: Loadout
  pending: ReadonlyMap<string, PendingSwitch>
  switching: ReadonlySet<string>
  busy: string | null
  onAdd: () => void
  onEdit: (s: LoadoutSkill) => void
  onSwitch: (name: string, on: boolean) => void
}

function SkillRow({
  s,
  on,
  switching,
  busy,
  onEdit,
  onSwitch
}: {
  s: LoadoutSkill
  on: boolean
  switching: boolean
  busy: boolean
  onEdit: () => void
  onSwitch: (on: boolean) => void
}) {
  const info = skillRow(s)
  const tokens = tokensText(s.tokens)
  return (
    <div className="ext-row" data-testid="ext-skill" data-name={s.name} data-source={s.source} data-on={on}>
      <div className="ext-row-main">
        <span className="set-label ext-name">{s.name}</span>
        {tokens && (
          <span className="ext-tag" data-testid="ext-tokens">
            {tokens}
          </span>
        )}
        <span className="grow" />
        {info.scope !== null && (
          <button type="button" className="btn small" data-testid="ext-edit" aria-label={`Edit ${s.name}`} disabled={busy} onClick={onEdit}>
            Edit
          </button>
        )}
        <input
          type="checkbox"
          role="switch"
          className="switch"
          data-testid="ext-skill-switch"
          aria-label={`${s.name} for every agent`}
          aria-checked={on}
          checked={on}
          disabled={switching}
          onChange={(e) => onSwitch(e.target.checked)}
        />
      </div>
      {s.description && <p className="ext-desc">{s.description}</p>}
      {info.note && (
        <p className="ext-note" data-testid="ext-note">
          {info.note}
        </p>
      )}
    </div>
  )
}

export function SkillsList({ loadout, pending, switching, busy, onAdd, onEdit, onSwitch }: SkillsProps) {
  return (
    <>
      <Head>
        <span className="set-hint">The switch applies to every agent. An agent can turn a skill off for itself in Agent Studio.</span>
        <span className="grow" />
        <button type="button" className="btn primary small" data-testid="ext-add-skill" onClick={onAdd}>
          Add skill
        </button>
      </Head>
      {loadout.skills.length === 0 ? (
        !loadout.errors.skills && (
          <p className="set-hint" data-testid="ext-empty">
            {emptyText('skills')}
          </p>
        )
      ) : (
        <Groups
          testId="ext-group"
          rows={sortByName(loadout.skills)}
          render={(s) => {
            const key = `skill:${s.name}`
            return (
              <SkillRow
                key={`${s.source}:${s.name}`}
                s={s}
                on={shownOn(s.on, pending.get(key), loadout.at)}
                switching={switching.has(key)}
                busy={busy === key}
                onEdit={() => onEdit(s)}
                onSwitch={(on) => onSwitch(s.name, on)}
              />
            )
          }}
        />
      )}
    </>
  )
}

interface HooksProps {
  loadout: Loadout
  busy: string | null
  onAdd: () => void
  onEdit: (h: LoadoutHook) => void
  onRemove: (h: LoadoutHook) => void
}

function HookRow({ h, busy, onEdit, onRemove }: { h: LoadoutHook; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const r = hookRow(h)
  return (
    <div className="ext-row" data-testid="ext-hook" data-name={h.event} data-source={h.source}>
      <div className="ext-row-main">
        <span className="set-label ext-name">{h.event}</span>
        <span className="ext-tag" data-testid="ext-hook-matcher">
          {r.matcher}
        </span>
        {r.timeout && <span className="ext-tag">{r.timeout}</span>}
        {h.plugin && <span className="ext-tag">{h.plugin}</span>}
        <span className="grow" />
        {r.editable && (
          <span className="set-actions">
            <button
              type="button"
              className="btn small"
              data-testid="ext-edit"
              aria-label={`Edit the ${h.event} hook`}
              disabled={busy}
              onClick={onEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn small danger-outline"
              data-testid="ext-remove"
              aria-label={`Remove the ${h.event} hook`}
              disabled={busy}
              onClick={onRemove}
            >
              Remove
            </button>
          </span>
        )}
      </div>
      <code className="ext-code" data-testid="ext-hook-command">
        {r.line}
      </code>
      {r.note && (
        <p className="ext-note" data-testid="ext-note">
          {r.note}
        </p>
      )}
    </div>
  )
}

export function HooksList({ loadout, busy, onAdd, onEdit, onRemove }: HooksProps) {
  const hooks = listedHooks(loadout)
  return (
    <>
      <Head>
        <span className="grow" />
        <button type="button" className="btn primary small" data-testid="ext-add-hook" onClick={onAdd}>
          Add hook
        </button>
      </Head>
      {hooks.length === 0 ? (
        !loadout.errors.hooks && (
          <p className="set-hint" data-testid="ext-empty">
            {emptyText('hooks')}
          </p>
        )
      ) : (
        <Groups
          testId="ext-group"
          rows={hooks}
          render={(h, i) => (
            <HookRow key={`${hookKey(h)}:${i}`} h={h} busy={busy === hookKey(h)} onEdit={() => onEdit(h)} onRemove={() => onRemove(h)} />
          )}
        />
      )}
    </>
  )
}
