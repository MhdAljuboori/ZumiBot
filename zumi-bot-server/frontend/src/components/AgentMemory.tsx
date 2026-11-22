import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import {
  BODY_MAX,
  DESCRIPTION_MAX,
  INDEX_VISIBLE_LINES,
  MEMORY_CHANGED,
  MEMORY_LIMITS,
  MEMORY_LIMIT_DEFAULT,
  TITLE_MAX,
  memoryFull,
  type MemoryEntry,
  type MemoryInput,
  type MemoryList
} from '@zumibot/shared/memory'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useOnReconnect } from '../useConnected'
import { groupMemories, keepDraftOnConflict, limitState, typeChoices, visibleMemories } from '../state/memory'
import { ConfirmDialog } from './ConfirmDialog'
import { Glyph } from './Sidebar'
import { SearchSelect } from './SearchSelect'

interface Props {
  agentName: string
  /** null when the raw text does not parse: the switch and limit are disabled then. */
  fields: AgentFields | null
  onFields(patch: Partial<AgentFields>): void
  focus: boolean
}

/** The row being edited; file null = a new memory. */
interface Open {
  file: string | null
  modified: number | null
  base: MemoryInput
  draft: MemoryInput
  /** The file vanished while open; Save creates it again. */
  gone?: boolean
}

const EMPTY: MemoryInput = { title: '', description: '', type: 'user', body: '' }
const inputOf = (e: MemoryEntry): MemoryInput => ({ title: e.title, description: e.description, type: e.type, body: e.body })
const same = (a: MemoryInput, b: MemoryInput): boolean =>
  a.title === b.title && a.description === b.description && a.type === b.type && a.body === b.body
const typeLabel = (t: string | null): string => (t === null ? 'Other' : t.charAt(0).toUpperCase() + t.slice(1))

export function AgentMemory({ agentName, fields, onFields, focus }: Props) {
  const [list, setList] = useState<MemoryList | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Open | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const latest = useRef(0) // an older response must not overwrite a newer one
  const alive = useRef(true)
  const section = useRef<HTMLElement>(null)

  const load = (): void => {
    const n = ++latest.current
    api.memory.list(agentName).then(
      (l) => {
        if (!alive.current || n !== latest.current) return
        setList(l)
        setLoadFailed(false)
        setRefreshFailed(false)
      },
      () => {
        if (!alive.current || n !== latest.current) return
        setLoadFailed(true)
        setRefreshFailed(true)
      }
    )
  }

  useEffect(() => {
    alive.current = true
    setList(null)
    setLoadFailed(false)
    setRefreshFailed(false)
    setError(null)
    setOpen(null)
    setQuery('')
    load()
    const off = api.memory.onChanged((name) => {
      if (name === agentName) load()
    })
    // The limit lives in the agent file, not the memory folder: a saved Memory limit changes only the agents.
    const offAgents = api.agents.onChanged(() => load())
    return () => {
      alive.current = false
      off()
      offAgents()
    }
  }, [agentName])

  // A list the socket cut off, or a change pushed while it was down: read again once it is back.
  useOnReconnect(load)

  useEffect(() => {
    if (focus) section.current?.scrollIntoView?.({ block: 'start' })
  }, [])

  const dirty = open !== null && !same(open.base, open.draft)
  const groups = useMemo(() => groupMemories(visibleMemories(list?.entries ?? [], query, open?.file ?? null)), [list, query, open?.file])

  // The open file was deleted meanwhile: keep the draft as a new memory so it can still be saved or cancelled.
  useEffect(() => {
    if (list === null || open === null || open.file === null || list.entries.some((e) => e.file === open.file)) return
    setOpen({ file: null, modified: null, base: EMPTY, draft: open.draft, gone: true })
  }, [list])

  const apply = (l: MemoryList): void => {
    latest.current++
    setList(l)
    setLoadFailed(false)
    setRefreshFailed(false)
  }

  const save = (): void => {
    if (open === null || busy) return
    const { file, modified, draft } = open
    setBusy(true)
    setError(null)
    api.memory.save(agentName, file, draft, modified).then(
      (l) => {
        if (!alive.current) return
        setBusy(false)
        apply(l)
        setOpen(null)
      },
      (e) => {
        if (!alive.current) return
        setBusy(false)
        const msg = errorMessage(e)
        setError(msg)
        if (file === null || !msg.includes(MEMORY_CHANGED)) return
        // Show the fresh file under the user's text, so nothing typed is lost.
        const n = ++latest.current
        api.memory.list(agentName).then(
          (fresh) => {
            if (!alive.current || n !== latest.current) return
            setList(fresh)
            const kept = keepDraftOnConflict(draft, fresh, file)
            setOpen(
              kept.entry
                ? { file, modified: kept.entry.modified, base: inputOf(kept.entry), draft: kept.draft }
                : { file: null, modified: null, base: EMPTY, draft: kept.draft }
            ) // deleted meanwhile: save as new
          },
          () => {
            if (alive.current && n === latest.current) setRefreshFailed(true)
          }
        )
      }
    )
  }

  const remove = (): void => {
    if (open === null || open.file === null || open.modified === null || busy) return
    const { file, modified } = open
    setBusy(true)
    setError(null)
    api.memory.remove(agentName, file, modified).then(
      (l) => {
        if (!alive.current) return
        setBusy(false)
        apply(l)
        setOpen(null)
      },
      (e) => {
        if (!alive.current) return
        setBusy(false)
        setError(errorMessage(e))
        load()
      }
    )
  }

  const edit = (patch: Partial<MemoryInput>): void => setOpen((o) => (o === null ? o : { ...o, draft: { ...o.draft, ...patch } }))

  const openRow = (e: MemoryEntry): void => {
    if (dirty || busy) return
    setError(null)
    setOpen({ file: e.file, modified: e.modified, base: inputOf(e), draft: inputOf(e) })
  }

  const count = list?.entries.length ?? 0
  const limit = list?.limit ?? MEMORY_LIMIT_DEFAULT
  const state = list ? limitState(count, limit) : 'room'
  const otherScope = list !== null && (list.scope === 'project' || list.scope === 'local')
  const savedOff = list !== null && list.scope === null
  const shownLimit = fields?.memoryLimit ?? MEMORY_LIMIT_DEFAULT
  const isOn = fields?.memory != null

  const editor = (o: Open) => (
    <div className="memory-edit" data-testid="memory-editor">
      {o.gone && (
        <div className="field-error" role="status">
          This memory was deleted meanwhile; Save creates it again.
        </div>
      )}
      <label className="memory-label">
        Title
        <input className="field" maxLength={TITLE_MAX} value={o.draft.title} onChange={(e) => edit({ title: e.target.value })} />
      </label>
      <label className="memory-label">
        Description
        <input
          className="field"
          maxLength={DESCRIPTION_MAX}
          value={o.draft.description}
          onChange={(e) => edit({ description: e.target.value })}
        />
      </label>
      <label className="memory-label">
        Type
        <SearchSelect className="field" value={o.draft.type ?? ''} onChange={(v) => edit({ type: v === '' ? null : v })}>
          {typeChoices(o.base.type).map((t) => (
            <option key={t ?? 'none'} value={t ?? ''}>
              {typeLabel(t)}
            </option>
          ))}
        </SearchSelect>
      </label>
      <label className="memory-label">
        Text
        <textarea
          className="field memory-body"
          maxLength={BODY_MAX}
          rows={6}
          value={o.draft.body}
          onChange={(e) => edit({ body: e.target.value })}
        />
      </label>
      <div className="memory-edit-foot">
        {o.modified !== null && <span className="hint">Changed {new Date(o.modified).toLocaleString()}</span>}
        <span className="grow" />
        {o.file !== null && (
          <button
            type="button"
            className="btn small danger-outline"
            data-testid="memory-delete"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        )}
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => {
            setOpen(null)
            setError(null)
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn small primary"
          data-testid="memory-save"
          disabled={busy || !dirty || o.draft.title.trim() === '' || o.draft.body.trim() === ''}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  )

  return (
    <section className="card memory" ref={section} aria-label="Memory" data-testid="memory-section">
      <div className="memory-head">
        <h3 className="card-title">Memory</h3>
        {list && (
          <span className={state === 'over' ? 'memory-count over' : 'memory-count'} data-testid="memory-count">
            {count} of {limit}
          </span>
        )}
        <span className="grow" />
        {list && !otherScope && state === 'room' && (
          <button
            type="button"
            className="btn small"
            data-testid="memory-new"
            disabled={dirty || busy}
            onClick={() => {
              setError(null)
              setOpen({ file: null, modified: null, base: EMPTY, draft: EMPTY })
            }}
          >
            New memory
          </button>
        )}
        <SearchSelect
          className="field memory-limit"
          aria-label="Memory limit"
          data-testid="memory-limit"
          disabled={fields === null}
          value={(MEMORY_LIMITS as readonly number[]).includes(shownLimit) ? shownLimit : MEMORY_LIMIT_DEFAULT}
          onChange={(v) => {
            const n = Number(v)
            onFields({ memoryLimit: n === MEMORY_LIMIT_DEFAULT ? null : n })
          }}
        >
          {MEMORY_LIMITS.map((n) => (
            <option key={n} value={n}>
              Limit {n}
            </option>
          ))}
        </SearchSelect>
        <button
          type="button"
          role="switch"
          className="rt-switch"
          data-testid="memory-switch"
          aria-checked={isOn}
          aria-label="Memory"
          disabled={fields === null}
          onClick={() => onFields({ memory: isOn ? null : 'user' })}
        >
          <span className="rt-switch-dot" />
          <span className="rt-switch-text">{isOn ? 'On' : 'Off'}</span>
        </button>
      </div>

      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      {loadFailed && list === null && (
        <div className="field-error" role="alert">
          Could not load memory.
        </div>
      )}
      {refreshFailed && list !== null && (
        <div className="field-error" role="alert">
          Could not refresh memory; this list may be out of date.
        </div>
      )}
      {list?.autoMemoryOff && (
        <div className="memory-warn" role="status">
          Claude Code&apos;s auto memory is off, so this agent can&apos;t read or save memories. Turn it on with /memory in Claude Code.
        </div>
      )}

      {list !== null && otherScope && (
        <div className="hint">
          This agent keeps a separate memory in each project folder (<code>memory: {list.scope}</code>). ZumiBot shows only memory kept for
          all projects.
        </div>
      )}

      {list !== null && !otherScope && (
        <>
          {savedOff && <div className="hint">Off. Turn it on and save your changes to let this agent remember things between chats.</div>}
          {savedOff && count > 0 && <div className="hint">Memory is off: the agent neither reads nor saves these.</div>}
          {state !== 'room' && <div className="hint">{memoryFull(limit)}</div>}
          {list.indexLines > INDEX_VISIBLE_LINES && (
            <div className="hint">Only the first {INDEX_VISIBLE_LINES} lines of MEMORY.md reach the agent.</div>
          )}

          <div className="search memory-search">
            <Glyph name="search" />
            <input
              className="search-input"
              data-testid="memory-search"
              type="text"
              value={query}
              placeholder="Search memories"
              aria-label="Search memories"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query !== '' && (
              <button type="button" className="search-close" aria-label="Clear search" onClick={() => setQuery('')}>
                <Glyph name="close" />
              </button>
            )}
          </div>

          {open !== null && open.file === null && (
            <div className="memory-row open" data-testid="memory-row">
              {editor(open)}
            </div>
          )}
          {count === 0 && open === null && <div className="hint">No memories yet.</div>}
          {count > 0 && groups.length === 0 && <div className="hint">No memory matches.</div>}
          {groups.map((g) => (
            <div key={g.key} className="memory-group">
              <div className="memory-group-title">{g.label}</div>
              <ul className="memory-list">
                {g.entries.map((e) => (
                  <li key={e.file} className={open?.file === e.file ? 'memory-row open' : 'memory-row'} data-testid="memory-row">
                    {open?.file === e.file ? (
                      editor(open)
                    ) : (
                      <button type="button" className="memory-open" disabled={dirty || busy} onClick={() => openRow(e)}>
                        <span className="memory-title">{e.title}</span>
                        {e.description !== '' && <span className="memory-desc">{e.description}</span>}
                        {e.indexLine !== null && e.indexLine > INDEX_VISIBLE_LINES && (
                          <span className="memory-mark">not seen by the agent</span>
                        )}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Move this memory to Trash?"
          message="You can restore it from the Trash."
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Move to Trash', value: 'trash', danger: true }
          ]}
          onResolve={(v) => {
            setConfirmDelete(false)
            if (v === 'trash') remove()
          }}
        />
      )}
    </section>
  )
}
