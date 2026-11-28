import { contextBridge, ipcRenderer } from 'electron'
import { safeOpenPath, type DesktopBridge, type DesktopNotificationTarget } from '@zumibot/shared/desktop'
import {
  cleanAgentList,
  ISLAND_PATH,
  parseIslandOpenTarget,
  type IslandBridge,
  type IslandLayout,
  type IslandOpenTarget,
  type IslandSettings
} from '@zumibot/shared/island'
import type { ServerMode, ThemePref } from '@zumibot/shared/types'

// Passed by the main process (webPreferences.additionalArguments). Empty for the picker and error pages.
const arg = (name: string): string => {
  const p = `--zumibot-${name}=`
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length) ?? ''
}
const origin = arg('origin')

if (location.protocol === 'file:' && arg('sync-page') === '1') {
  contextBridge.exposeInMainWorld('zumibotSync', {
    status: () => ipcRenderer.invoke('sync:status'),
    start: (o?: { chats?: boolean }) => ipcRenderer.invoke('sync:start', { chats: o?.chats === true }),
    configure: () => ipcRenderer.invoke('sync:configure')
  })
} else if (location.protocol === 'file:') {
  // The shell's own pages: a minimal bridge, never zumibotDesktop.
  contextBridge.exposeInMainWorld('zumibotPages', {
    pickServer: (choice: unknown): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('pages:pick', choice),
    currentChoice: (): Promise<unknown> => ipcRenderer.invoke('pages:currentChoice'),
    localKind: (): Promise<'native' | 'wsl' | null> => ipcRenderer.invoke('pages:localKind'),
    getError: (): Promise<string> => ipcRenderer.invoke('pages:getError'),
    retry: (): void => ipcRenderer.send('pages:retry'),
    switchServer: (): void => ipcRenderer.send('pages:switch')
  })
} else if (arg('island') === '1') {
  // The island window gets its own bridge on its own page only, never zumibotDesktop (a login redirect gets nothing).
  if (origin !== '' && location.origin === origin && location.pathname === ISLAND_PATH) {
    const subscribe = <T>(channel: string, pick: (raw: unknown) => T | null, cb: (v: T) => void): (() => void) => {
      const on = (_e: unknown, raw: unknown): void => {
        const v = pick(raw)
        if (v !== null) cb(v)
      }
      ipcRenderer.on(channel, on)
      return () => void ipcRenderer.removeListener(channel, on)
    }
    const rect = (v: unknown): boolean => {
      const r = v as Record<string, unknown> | null
      return !!r && ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))
    }
    const island: IslandBridge = {
      ready: () => ipcRenderer.send('island:ready'),
      agents: () => ipcRenderer.invoke('island:agents') as Promise<string[]>,
      onAgents: (cb) => subscribe('island:agents', cleanAgentList, cb),
      setShape: (icons, open) => ipcRenderer.send('island:shape', icons, open === true),
      onLayout: (cb) =>
        subscribe<IslandLayout>(
          'island:layout',
          (raw) => {
            const l = raw as { strip?: unknown; popup?: unknown; track?: unknown } | null
            return l && rect(l.strip) && (l.popup === null || rect(l.popup)) && (l.track === undefined || rect(l.track))
              ? (raw as IslandLayout)
              : null
          },
          cb
        ),
      drag: (phase, screenY, top) => ipcRenderer.send('island:drag', phase, screenY, typeof top === 'number' ? top : undefined),
      openMain: (t) => ipcRenderer.send('island:openMain', t),
      openAttachment: (url, name) => ipcRenderer.invoke('island:openAttachment', String(url), String(name)) as Promise<boolean>,
      onVoice: (cb) => subscribe<boolean>('island:voice', (raw) => (typeof raw === 'boolean' ? raw : null), cb),
      voiceEnded: () => ipcRenderer.send('island:voiceEnded')
    }
    contextBridge.exposeInMainWorld('zumibotIsland', island)
  }
} else if (origin !== '' && location.origin === origin) {
  // A remote page runs here: only the connected server's own origin gets the desktop bridge.
  const saveCallbacks = new Set<() => Promise<boolean>>()
  ipcRenderer.on('desktop:saveBeforeClose', () => {
    void (async () => {
      let ok = saveCallbacks.size > 0
      for (const cb of [...saveCallbacks]) ok = (await cb().catch(() => false)) && ok
      ipcRenderer.send('desktop:saveBeforeCloseResult', ok)
    })()
  })
  const clickCallbacks = new Set<(chatId: string | null) => void>()
  const openCallbacks = new Set<(t: DesktopNotificationTarget) => void>()
  ipcRenderer.on('desktop:notificationClick', (_e, raw: unknown) => {
    // The main process sends {chatId, open}; the path is checked again here, so the page only ever gets a safe one.
    const t = typeof raw === 'object' && raw !== null ? (raw as { chatId?: unknown; open?: unknown }) : {}
    const target: DesktopNotificationTarget = { chatId: typeof t.chatId === 'string' ? t.chatId : null, open: safeOpenPath(t.open) }
    for (const cb of [...clickCallbacks]) cb(target.chatId)
    for (const cb of [...openCallbacks]) cb({ ...target })
  })
  const islandOpenCallbacks = new Set<(t: IslandOpenTarget) => void>()
  ipcRenderer.on('desktop:islandOpen', (_e, raw: unknown) => {
    const t = parseIslandOpenTarget(raw) // checked again here, so the page only ever gets a well-formed target
    if (t) for (const cb of [...islandOpenCallbacks]) cb(structuredClone(t))
  })
  const bridge: DesktopBridge = {
    mode: (arg('mode') === 'local' ? 'local' : 'vps') as ServerMode,
    switchServer: () => ipcRenderer.send('desktop:switchServer'),
    sync: () => ipcRenderer.send('desktop:sync'),
    setEditorDirty: (dirty: boolean) => ipcRenderer.send('desktop:setEditorDirty', dirty === true),
    onSaveBeforeClose(cb) {
      saveCallbacks.add(cb)
      return () => void saveCallbacks.delete(cb)
    },
    setTheme: (t: ThemePref) => ipcRenderer.send('desktop:setTheme', t),
    openAttachment: (url: string, name: string) => ipcRenderer.invoke('desktop:openAttachment', String(url), String(name)),
    notify: (n) => ipcRenderer.send('desktop:notify', n),
    closeNotifications: (chatId, waitingOnly) => ipcRenderer.send('desktop:closeNotifications', String(chatId), waitingOnly === true),
    closeNotificationTag: (tag) => ipcRenderer.send('desktop:closeNotificationTag', String(tag)),
    onNotificationClick(cb) {
      clickCallbacks.add(cb)
      ipcRenderer.send('desktop:notificationClickReady') // the main process holds a click until someone listens
      return () => void clickCallbacks.delete(cb)
    },
    onNotificationOpen(cb) {
      openCallbacks.add(cb)
      ipcRenderer.send('desktop:notificationClickReady')
      return () => void openCallbacks.delete(cb)
    },
    island: {
      get: () => ipcRenderer.invoke('desktop:islandGet') as Promise<IslandSettings>,
      set: (patch) => {
        const send: Partial<IslandSettings> = {}
        if (patch?.agents !== undefined) send.agents = patch.agents
        if (patch?.startAtLogin !== undefined) send.startAtLogin = patch.startAtLogin
        if (patch?.voiceHotkey !== undefined) send.voiceHotkey = patch.voiceHotkey
        return ipcRenderer.invoke('desktop:islandSet', send) as Promise<IslandSettings>
      },
      renameAgent: (from, to) => ipcRenderer.send('desktop:islandRename', String(from), String(to))
    },
    onIslandOpen(cb) {
      islandOpenCallbacks.add(cb)
      return () => void islandOpenCallbacks.delete(cb)
    }
  }
  contextBridge.exposeInMainWorld('zumibotDesktop', bridge)
}
