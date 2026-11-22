import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSyncFlow } from './syncFlow'
import { readSyncConfig, saveSyncConfig, validateSyncDataDir, type SyncConfig } from './syncConfig'
import { runSyncProcess } from './syncProcess'
import { APP_ICON } from './window'

interface Options {
  parent(): BrowserWindow | null
  available(): boolean
  settingsFile: string
  developmentConfig?: string
  isDirty(): boolean
  askUnsaved(window: BrowserWindow): Promise<'save' | 'discard' | 'cancel'>
  save(): Promise<boolean>
  busy(): Promise<number>
  pause(): Promise<void>
  restore(): Promise<void>
}

/** Local-only progress survives both servers restarting. No remote renderer can read configuration or start a worker. */
export function createDesktopSync(o: Options) {
  let window: BrowserWindow | null = null
  let config: SyncConfig | null = null
  let external = false
  let configuring = false
  const lines: string[] = []
  const page = join(__dirname, 'pages/sync.html')
  const log = (line: string): void => {
    lines.push(line)
    if (lines.length > 500) lines.splice(0, lines.length - 500)
  }
  const error = (err: unknown): void => log(err instanceof Error ? err.message : String(err))
  const trusted = (e: Electron.IpcMainInvokeEvent): boolean =>
    !!window &&
    e.sender === window.webContents &&
    e.senderFrame === window.webContents.mainFrame &&
    e.senderFrame.url === pathToFileURL(page).href

  /** False when the user cancels the picker; throws when the chosen file can't be used. */
  async function configure(): Promise<boolean> {
    if (!window || configuring) return false
    configuring = true
    try {
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose your VPS deploy.env',
        properties: ['openFile'],
        filters: [
          { name: 'Deployment settings', extensions: ['env'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePaths[0]) return false
      const next = readSyncConfig(result.filePaths[0])
      saveSyncConfig(o.settingsFile, next)
      config = next
      log('VPS settings imported. SSH keys stay on this PC.')
      return true
    } finally {
      configuring = false
    }
  }

  const flow = createSyncFlow({
    async prepare() {
      validateSyncDataDir(process.env)
      const hadConfig = config !== null
      if (!config && !(await configure())) return false
      if (!window || !config) return false
      if (external || !hadConfig) {
        const { response } = await dialog.showMessageBox(window, {
          type: 'question',
          title: 'Sync ZumiBot',
          message: `Sync this PC with ${config.VPS_USER}@${config.VPS_HOST}?`,
          detail:
            'Chats and Claude data will be merged in both directions, with backups. The VPS will restart. Wait for active replies to finish first.',
          buttons: ['Cancel', 'Sync'],
          defaultId: 0,
          cancelId: 0
        })
        if (response !== 1) return false
      }
      log(`Syncing with ${config.VPS_USER}@${config.VPS_HOST} (${config.VPS_DIR})...`)
      return true
    },
    isDirty: o.isDirty,
    askUnsaved: () => o.askUnsaved(window!),
    save: o.save,
    busy: o.busy,
    pause: o.pause,
    restore: o.restore,
    log,
    execute: () =>
      runSyncProcess({
        node: process.execPath,
        entry: app.isPackaged ? join(process.resourcesPath, 'sync/runner.mjs') : join(__dirname, 'sync/runner.mjs'),
        config: config!,
        home: process.env.HOME || homedir(),
        log
      })
  })
  const active = (): boolean => flow.active() || configuring
  const focus = (): void => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  ipcMain.handle('sync:status', (e) =>
    trusted(e)
      ? {
          active: active(),
          configured: config !== null,
          target: config ? `${config.VPS_USER}@${config.VPS_HOST} · ${config.VPS_DIR}` : 'Choose deploy.env to set up your VPS connection.',
          lines: [...lines]
        }
      : null
  )
  ipcMain.handle('sync:configure', async (e) => {
    if (trusted(e) && !active()) await configure().catch(error)
  })
  ipcMain.handle('sync:start', async (e) => {
    if (trusted(e) && !active() && o.available()) await flow.run()
  })

  return {
    active,
    focus,
    isOpen: () => window !== null,
    open(fromBrowser = false): void {
      if (window) {
        external ||= fromBrowser
        focus()
        return
      }
      if (!o.available()) return
      external = fromBrowser
      config = null
      lines.length = 0
      try {
        const file = existsSync(o.settingsFile) ? o.settingsFile : o.developmentConfig
        if (file && existsSync(file)) config = readSyncConfig(file)
      } catch (err) {
        error(err)
      }
      const parent = o.parent()
      window = new BrowserWindow({
        width: 680,
        height: 560,
        minWidth: 520,
        minHeight: 420,
        title: 'Sync ZumiBot',
        icon: APP_ICON,
        parent: parent ?? undefined,
        modal: !!parent,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          preload: join(__dirname, '../preload/index.js'),
          additionalArguments: ['--zumibot-sync-page=1']
        }
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (e) => e.preventDefault())
      window.webContents.on('will-redirect', (e) => e.preventDefault())
      window.webContents.on('will-attach-webview', (e) => e.preventDefault())
      window.on('close', (e) => {
        if (active()) e.preventDefault()
      })
      window.on('closed', () => {
        window = null
      })
      void window.loadFile(page).catch(error)
    }
  }
}
