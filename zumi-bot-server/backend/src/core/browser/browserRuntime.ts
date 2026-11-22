import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataDir } from '../../config'
import { ensureDataDir } from '../../dataDir'
import { loadBrowserConfig } from './config'
import { BrowserLaunchCleanupError } from './types'

export interface BrowserRuntime {
  node: string
  workerEntry: string
  bridgeEntry: string
  todoBridgeEntry: string
  vaultBridgeEntry: string
  askBridgeEntry: string
  automationBridgeEntry: string
  // Not in checkAssets: the pause hook is not part of the browser, and a missing one must not break browser-check.
  pauseHookEntry: string
  // The sandboxed run's file-tool guard (core/isolation/fileGuard.ts); also not in checkAssets.
  sandboxFileHookEntry: string
  // PID 1 of a contained run (core/isolation/containerEntry.ts); also not in checkAssets.
  containerEntry: string
  // Not in checkAssets either: processes are not part of the browser.
  processBridgeEntry: string
  playwrightDir: string
  executablePath: string | null
  electronNode: boolean
}
type RuntimeOptions = { moduleUrl?: string; versions?: { electron?: string }; execPath?: string; env?: NodeJS.ProcessEnv }

/** Pure preflight: text-only startup neither loads Playwright nor starts a process. */
export function resolveBrowserRuntime(options: RuntimeOptions = {}): BrowserRuntime {
  const url = options.moduleUrl ?? import.meta.url
  const dir = dirname(fileURLToPath(url))
  const env = options.env ?? process.env
  const packaged = existsSync(join(dir, 'browserWorker.mjs')) || url.endsWith('.mjs')
  // Source servers use the worker emitted by the normal backend build.
  const entryDir = packaged ? dir : join(dir, '../../../dist')
  const entry = (name: string) => join(entryDir, `${name}.mjs`)
  let playwrightDir = join(dir, 'node_modules', 'playwright-core')
  if (!packaged) {
    try {
      playwrightDir = dirname(createRequire(url).resolve('playwright-core/package.json'))
    } catch {
      /* browser remains optional */
    }
  }
  const managed = managedExecutable(playwrightDir, env)
  const candidates = env.ZUMIBOT_BROWSER_EXECUTABLE_PATH
    ? [env.ZUMIBOT_BROWSER_EXECUTABLE_PATH]
    : [
        ...(managed ? [managed] : []),
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ...(env.PROGRAMFILES ? [join(env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')] : [])
      ]
  const executablePath =
    candidates.find((path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    }) ?? null
  return {
    node: options.execPath ?? process.execPath,
    workerEntry: entry('browserWorker'),
    bridgeEntry: entry('browserBridge'),
    todoBridgeEntry: entry('todoBridge'),
    vaultBridgeEntry: entry('vaultBridge'),
    askBridgeEntry: entry('askBridge'),
    automationBridgeEntry: entry('automationBridge'),
    pauseHookEntry: entry('pauseHook'),
    sandboxFileHookEntry: entry('sandboxFileHook'),
    containerEntry: entry('containerEntry'),
    processBridgeEntry: entry('processBridge'),
    playwrightDir,
    executablePath,
    electronNode: Boolean((options.versions ?? (process.versions as { electron?: string })).electron)
  }
}

const PLAYWRIGHT_VERSION = '1.64.1'

function browserInstallDir(env: NodeJS.ProcessEnv): string {
  return resolve(resolveDataDir(env), 'browser-runtime')
}

/** Read only pinned metadata; importing Playwright here would load it in the parent. */
function managedExecutable(playwrightDir: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) return null
  try {
    const manifest = JSON.parse(readFileSync(join(playwrightDir, 'browsers.json'), 'utf8')) as {
      browsers: { name: string; revision: string }[]
    }
    const chromium = manifest.browsers.find((browser) => browser.name === 'chromium')
    if (!chromium || !/^\d+$/.test(chromium.revision)) return null
    return join(
      browserInstallDir(env),
      `chromium-${chromium.revision}`,
      process.arch === 'arm64' ? 'chrome-linux-arm64' : 'chrome-linux64',
      'chrome'
    )
  } catch {
    return null
  }
}

function checkAssets(runtime: BrowserRuntime): void {
  try {
    for (const path of [
      runtime.workerEntry,
      runtime.bridgeEntry,
      runtime.todoBridgeEntry,
      runtime.vaultBridgeEntry,
      runtime.askBridgeEntry,
      runtime.automationBridgeEntry,
      join(runtime.playwrightDir, 'cli.js'),
      join(runtime.playwrightDir, 'browsers.json')
    ])
      accessSync(path, constants.R_OK)
    if (JSON.parse(readFileSync(join(runtime.playwrightDir, 'package.json'), 'utf8')).version !== PLAYWRIGHT_VERSION) throw Error()
  } catch {
    throw new Error(
      'Browser runtime assets missing or incompatible. Rebuild/reinstall the complete ZumiBot artifact (Playwright Core 1.64.1).'
    )
  }
}

/** Explicit setup only. Never install OS packages or use the user's Playwright cache. */
export async function installBrowserRuntime(env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<void> {
  const runtime = resolveBrowserRuntime({ env })
  checkAssets(runtime)
  await ensureDataDir(resolveDataDir(env))
  const cache = browserInstallDir(env)
  await ensureDataDir(cache)
  const childEnv: NodeJS.ProcessEnv = { ...env, PLAYWRIGHT_BROWSERS_PATH: cache }
  delete childEnv.ZUMIBOT_LOCAL_SECRET
  delete childEnv.ELECTRON_RUN_AS_NODE
  if (runtime.electronNode) childEnv.ELECTRON_RUN_AS_NODE = '1'
  out('Installing pinned Chromium into ZUMIBOT_DATA_DIR/browser-runtime (network and disk space required).')
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(runtime.node, [join(runtime.playwrightDir, 'cli.js'), 'install', '--no-shell', 'chromium'], {
      env: childEnv,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0)
    throw new Error(
      'Browser installation failed. Check network/disk space and required OS libraries; no OS packages were installed. Run browser-check after setup.'
    )
  out('Chromium installed. Run browser-check to verify OS libraries and sandbox support.')
}

/** Own a synthetic profile only: app configuration, auth, locks and agent profiles are never opened. */
export async function checkBrowserRuntime(env: NodeJS.ProcessEnv): Promise<void> {
  const config = loadBrowserConfig(env)
  const runtime = resolveBrowserRuntime({ env })
  checkAssets(runtime)
  if (!runtime.executablePath)
    throw new Error(
      'Browser unavailable. Run browser-install or set ZUMIBOT_BROWSER_EXECUTABLE_PATH to a supported Chromium executable, then run browser-check.'
    )
  const temporary = await mkdtemp(join(tmpdir(), 'zumibot-browser-check-'))
  let instance: import('./types').BrowserInstance | undefined
  let safeToRemove = true
  try {
    const { createWorkerAdapter } = await import('./workerAdapter')
    instance = await createWorkerAdapter(runtime).launch(join(temporary, 'profile'), { ...config, executablePath: runtime.executablePath })
    const result = await instance.execute({ op: 'observe' }, new AbortController().signal)
    if (!result.ok) throw Error()
  } catch (error) {
    if (error instanceof BrowserLaunchCleanupError) instance = error.instance
    throw new Error(
      'Browser check failed. Verify required OS libraries and Chromium sandbox support as the non-root service user; no automatic installation was attempted. Do not disable the sandbox.'
    )
  } finally {
    try {
      await instance?.close()
    } catch {
      safeToRemove = false
      throw new Error('Browser check cleanup could not be confirmed. Restart before retrying; synthetic profile retained for recovery.')
    } finally {
      if (safeToRemove) await rm(temporary, { recursive: true, force: true })
    }
  }
}
