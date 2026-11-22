import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { CONNECTOR_TEXT } from '@zumibot/shared/connectors'
import {
  EXT_TEXT,
  type HookFile,
  type HookPosition,
  type LoadoutHook,
  type LoadoutSection,
  type LoadoutServer,
  type LoadoutSkill,
  type McpScope,
  type McpServerView,
  type SkillView
} from '@zumibot/shared/extensions'
import { api } from '../api'
import { errorMessage } from '../errors'
import { homeFolder, useLoadout } from '../net/useLoadout'
import { useConnected } from '../useConnected'
import {
  TAB_LABEL,
  TAB_ORDER,
  findHookRow,
  hookKey,
  hookRow,
  removeText,
  serverRow,
  skillRow,
  tabKeyTarget,
  type PendingSwitch
} from '../state/extensionsPage'
import type { EditorHandle } from './AgentEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { useReturnFocus } from './ExtFormParts'
import { HooksList, PluginsList, ServersList, SkillsList } from './ExtensionLists'
import { HookForm } from './HookForm'
import { LoadoutFolderBar } from './LoadoutFolderBar'
import { McpServerForm } from './McpServerForm'
import { SkillEditor } from './SkillEditor'

const SERVER_SCOPES: McpScope[] = ['user', 'local', 'project']
const HOOK_FILES: HookFile[] = ['user', 'project', 'local']

// One form at a time, in place of the tab's list. `n` makes each open a new form, so no draft carries over from another.
type Form =
  | { kind: 'server'; n: number; view: McpServerView | null }
  | { kind: 'skill'; n: number; view: SkillView | null }
  | { kind: 'hook'; n: number; hook: LoadoutHook | null; file?: HookFile }

type Dialog =
  | { kind: 'discard'; then: () => void }
  | { kind: 'remove-server'; server: LoadoutServer; scope: McpScope }
  | { kind: 'remove-hook'; hook: LoadoutHook; file: HookFile; at: HookPosition; stamp: string }

const tabId = (t: LoadoutSection): string => `ext-tab-${t}`

/**
 * Settings › Claude Code: what Claude Code loads from a folder (MCP servers, plugins, skills, hooks), with the edits the page
 * can make. The lists come from the server's own probe of the CLI; a form is a draft that the Settings guard can ask about.
 */
export function ExtensionsSettings({ handle, onOpenConnectors }: { handle: RefObject<EditorHandle | null>; onOpenConnectors: () => void }) {
  const [folder, setFolder] = useState('')
  const [homeFailed, setHomeFailed] = useState(false)
  const [tab, setTab] = useState<LoadoutSection>('servers')
  const [form, setForm] = useState<Form | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlyMap<string, PendingSwitch>>(new Map())
  const [switching, setSwitching] = useState<ReadonlySet<string>>(new Set())
  const formHandle = useRef<EditorHandle | null>(null)
  const formCount = useRef(0)
  const panel = useRef<HTMLDivElement | null>(null)
  // A form takes the list's place, so the button that opened it is gone while it shows: focus goes back to it once it closes.
  const focus = useReturnFocus(panel)
  // A hook form reloaded after a stale save: reopened from the fresh loadout once it lands (a hook has no view of its own).
  const [reopenHook, setReopenHook] = useState<{ hook: LoadoutHook; after: number | null } | null>(null)
  const { loadout, loading, error, refresh } = useLoadout(folder, null)

  useEffect(() => {
    if (reopenHook === null || loadout === null || loadout.at === reopenHook.after) return
    const fresh = findHookRow(loadout.hooks, reopenHook.hook)
    setReopenHook(null)
    if (fresh) setForm({ kind: 'hook', n: ++formCount.current, hook: fresh, file: hookRow(fresh).file ?? undefined })
  }, [loadout, reopenHook])

  // Asked once the socket is up, and again after a reconnect while it has no answer (homeFolder keeps a found one).
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    let live = true
    homeFolder().then(
      (home) => {
        if (!live) return
        setHomeFailed(false)
        setFolder((f) => (f === '' ? home : f))
      },
      () => live && setHomeFailed(true)
    )
    return () => {
      live = false
    }
  }, [connected])

  // The Settings unsaved-changes guard asks whichever form is open.
  useEffect(() => {
    handle.current = {
      isDirty: () => formHandle.current?.isDirty() ?? false,
      save: async () => (formHandle.current ? formHandle.current.save() : true)
    }
    return () => {
      handle.current = null
    }
  }, [handle])

  const open = (make: (n: number) => Form): void => {
    setNote(null)
    setForm(make(++formCount.current))
  }
  const closeForm = (): void => {
    setForm(null)
    focus.restore()
  }
  // Anything that would drop the open form asks first when it has edits.
  const leave = (then: () => void): void => {
    if (formHandle.current?.isDirty()) setDialog({ kind: 'discard', then })
    else then()
  }

  const pickTab = (t: LoadoutSection): void => {
    if (t === tab) return
    leave(() => {
      setForm(null)
      setNote(null)
      setTab(t)
    })
  }
  const tabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const to = tabKeyTarget(e.key, tab)
    if (to === null) return
    e.preventDefault()
    pickTab(to)
    document.getElementById(tabId(to))?.focus()
  }
  const changeFolder = (path: string): void => {
    if (path === folder) return
    leave(() => {
      setForm(null)
      setNote(null)
      setFolder(path)
    })
  }

  // A button's action: the row shows busy, and a failure is the page's note (a fixed sentence from the server).
  const act = async (key: string, run: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setNote(null)
    try {
      await run()
    } catch (e) {
      setNote(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const editServer = (s: LoadoutServer): void => {
    const scope = serverRow(s).scope
    if (scope === null) return
    focus.remember()
    void act(`server:${s.name}`, async () => {
      const view = await api.extensions.server(folder, scope, s.name)
      open((n) => ({ kind: 'server', n, view }))
    })
  }
  const editSkill = (s: LoadoutSkill): void => {
    const scope = skillRow(s).scope
    if (scope === null) return
    focus.remember()
    void act(`skill:${s.name}`, async () => {
      const view = await api.extensions.skill(scope, folder, s.name)
      open((n) => ({ kind: 'skill', n, view }))
    })
  }

  // Reload after a stale or lost save: the form opens again from what is on disk now. A server that is gone opens as a new one.
  const reloadServer = (view: McpServerView): void => {
    void act(`server:${view.name}`, async () => {
      const fresh = await api.extensions.server(folder, view.scope, view.name).catch(() => null)
      open((n) => ({ kind: 'server', n, view: fresh }))
    })
  }
  const reloadSkill = (view: SkillView): void => {
    void act(`skill:${view.name}`, async () => {
      let fresh: SkillView
      try {
        fresh = await api.extensions.skill(view.scope, folder, view.name)
      } catch (e) {
        // A skill that is gone has nothing to reopen: back to the list, which says why.
        setForm(null)
        throw e
      }
      open((n) => ({ kind: 'skill', n, view: fresh }))
    })
  }
  const reloadHook = (hook: LoadoutHook): void => {
    setForm(null)
    setReopenHook({ hook, after: loadout?.at ?? null })
    refresh()
  }

  // A write answers before the probe that reflects it; the switch shows what was asked until that probe lands (shownOn).
  const flip = async (kind: 'plugin' | 'skill', name: string, on: boolean): Promise<void> => {
    if (!loadout) return
    const key = `${kind}:${name}`
    setNote(null)
    setPending((m) => new Map(m).set(key, { on, at: loadout.at }))
    setSwitching((s) => new Set(s).add(key))
    try {
      await (kind === 'plugin' ? api.extensions.setPlugin(name, on) : api.extensions.setSkill(name, on))
    } catch (e) {
      setPending((m) => {
        const next = new Map(m)
        next.delete(key)
        return next
      })
      setNote(errorMessage(e))
    } finally {
      setSwitching((s) => {
        const next = new Set(s)
        next.delete(key)
        return next
      })
    }
  }

  const dialogView = (): ReactNode => {
    if (dialog === null) return null
    const done = (): void => setDialog(null)
    if (dialog.kind === 'discard') {
      const { then } = dialog
      return (
        <ConfirmDialog
          title="Unsaved changes"
          message="You have unsaved changes. Discard them?"
          buttons={[
            { label: 'Discard', value: 'discard', danger: true },
            { label: 'Keep editing', value: 'keep' }
          ]}
          initialFocus="keep"
          onResolve={(v) => {
            done()
            if (v === 'discard') then()
          }}
        />
      )
    }
    if (dialog.kind === 'remove-server') {
      const { server, scope } = dialog
      return (
        <ConfirmDialog
          title="Remove server"
          message={removeText.server(server.name, scope)}
          buttons={[
            { label: 'Remove', value: 'remove', danger: true },
            { label: 'Cancel', value: 'cancel' }
          ]}
          initialFocus="cancel"
          onResolve={(v) => {
            done()
            if (v === 'remove') void act(`server:${server.name}`, () => api.extensions.removeServer(folder, scope, server.name))
          }}
        />
      )
    }
    const { hook, file, at, stamp } = dialog
    return (
      <ConfirmDialog
        title="Remove hook"
        message={removeText.hook(hook.event, file)}
        buttons={[
          { label: 'Remove', value: 'remove', danger: true },
          { label: 'Cancel', value: 'cancel' }
        ]}
        initialFocus="cancel"
        onResolve={(v) => {
          done()
          if (v === 'remove') void act(hookKey(hook), () => api.extensions.removeHook(file, folder, hook.event, at, stamp))
        }}
      />
    )
  }

  const body = (): ReactNode => {
    if (form?.kind === 'server') {
      const view = form.view
      return (
        <McpServerForm
          key={form.n}
          view={view}
          scopes={view ? [view.scope] : SERVER_SCOPES}
          folder={folder}
          handle={formHandle}
          onCancel={closeForm}
          onReload={view ? () => reloadServer(view) : undefined}
          onSave={async (name, scope, input) => {
            if (scope === null) return
            await api.extensions.saveServer(folder, scope, name, input, view && view.name !== name ? view.name : undefined, view?.stamp)
            closeForm()
          }}
        />
      )
    }
    if (form?.kind === 'skill') {
      const view = form.view
      return (
        <SkillEditor
          key={form.n}
          view={view}
          folder={folder}
          handle={formHandle}
          onCancel={closeForm}
          onReload={view ? () => reloadSkill(view) : undefined}
          onSave={async (scope, input) => {
            await api.extensions.saveSkill(scope, folder, input)
            closeForm()
          }}
          onDelete={async (scope, name) => {
            await api.extensions.removeSkill(scope, folder, name)
            closeForm()
          }}
        />
      )
    }
    if (form?.kind === 'hook') {
      const { hook, file } = form
      return (
        <HookForm
          key={form.n}
          value={hook}
          file={file}
          files={hook ? null : HOOK_FILES}
          folder={folder}
          handle={formHandle}
          onCancel={closeForm}
          onReload={hook ? () => reloadHook(hook) : undefined}
          onSave={async (target, input, stamp) => {
            if (target === null) return
            await api.extensions.saveHook(target, folder, input, stamp)
            closeForm()
          }}
        />
      )
    }
    if (loadout === null) {
      if (error !== null) {
        return (
          <p className="set-note bad" role="alert" data-testid="ext-error">
            {error}{' '}
            <button type="button" className="btn small" data-testid="ext-retry" onClick={refresh}>
              Retry
            </button>
          </p>
        )
      }
      return folder === '' && homeFailed ? (
        <p className="set-hint">Pick a folder to see what Claude Code loads there.</p>
      ) : (
        <p className="set-hint" data-testid="ext-loading-text">
          Asking Claude Code…
        </p>
      )
    }
    const sectionError = loadout.errors[tab]
    return (
      <>
        {error !== null && (
          <p className="set-note bad" role="alert" data-testid="ext-error">
            {error}{' '}
            <button type="button" className="btn small" data-testid="ext-retry" onClick={refresh}>
              Retry
            </button>
          </p>
        )}
        {sectionError && (
          <p className="set-note bad" role="alert" data-testid="ext-section-error">
            {sectionError}
          </p>
        )}
        {note && (
          <p className="set-note bad" role="alert" data-testid="ext-note-error">
            {note}
          </p>
        )}
        {tab === 'servers' && (
          <ServersList
            loadout={loadout}
            busy={busy}
            onAdd={() => {
              focus.remember()
              open((n) => ({ kind: 'server', n, view: null }))
            }}
            onEdit={editServer}
            onRemove={(s) => {
              const scope = serverRow(s).scope
              if (scope !== null) setDialog({ kind: 'remove-server', server: s, scope })
            }}
          />
        )}
        {tab === 'plugins' && (
          <PluginsList loadout={loadout} pending={pending} switching={switching} onSwitch={(id, on) => void flip('plugin', id, on)} />
        )}
        {tab === 'skills' && (
          <SkillsList
            loadout={loadout}
            pending={pending}
            switching={switching}
            busy={busy}
            onAdd={() => {
              focus.remember()
              open((n) => ({ kind: 'skill', n, view: null }))
            }}
            onEdit={editSkill}
            onSwitch={(name, on) => void flip('skill', name, on)}
          />
        )}
        {tab === 'hooks' && (
          <HooksList
            loadout={loadout}
            busy={busy}
            onAdd={() => {
              focus.remember()
              open((n) => ({ kind: 'hook', n, hook: null }))
            }}
            onEdit={(h) => {
              focus.remember()
              open((n) => ({ kind: 'hook', n, hook: h, file: hookRow(h).file ?? undefined }))
            }}
            onRemove={(h) => {
              const file = hookRow(h).file
              if (file !== null && h.at && h.stamp !== null) setDialog({ kind: 'remove-hook', hook: h, file, at: h.at, stamp: h.stamp })
            }}
          />
        )}
      </>
    )
  }

  return (
    <div data-testid="settings-claude-code">
      <p className="set-intro">
        What Claude Code loads when it runs in a folder: MCP servers, plugins, skills and hooks. {EXT_TEXT.machineOnly}
      </p>
      <LoadoutFolderBar folder={folder} agentName={null} loading={loading} onFolder={changeFolder} onRefresh={refresh} />
      <div className="seg ext-tabs" role="tablist" aria-label="Claude Code" data-testid="ext-tabs" onKeyDown={tabKey}>
        {TAB_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={tabId(t)}
            aria-selected={tab === t}
            aria-controls="ext-panel"
            tabIndex={tab === t ? 0 : -1}
            data-testid={tabId(t)}
            onClick={() => pickTab(t)}
          >
            {TAB_LABEL[t]}
            {loadout?.errors[t] && (
              <>
                <span className="ext-tab-flag" aria-hidden="true" data-tip="Could not be read">
                  !
                </span>
                <span className="sr-only"> (could not be read)</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div
        id="ext-panel"
        ref={panel}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
        className="ext-panel"
        data-testid="ext-panel"
        data-tab={tab}
      >
        {tab === 'servers' && form === null && (
          <p className="ext-note" data-testid="ext-connectors-hint">
            {CONNECTOR_TEXT.toConnectors}{' '}
            <button type="button" className="ext-link" data-testid="ext-connectors-link" onClick={onOpenConnectors}>
              Open Connectors
            </button>
          </p>
        )}
        {body()}
      </div>
      {dialogView()}
    </div>
  )
}
