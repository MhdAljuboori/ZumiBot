import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { build } from 'vite'
import { createWorkerAdapter, workerEnv } from '../../src/core/browser/workerAdapter'
import { resolveBrowserRuntime } from '../../src/core/browser/browserRuntime'
import { loadBrowserConfig } from '../../src/core/browser/config'
import { browserSite } from '../../../e2e/fixtures/browser-site.mjs'
import { BrowserLaunchCleanupError } from '../../src/core/browser/types'
import {
  canonicalProfile,
  cleanupOwned,
  identity,
  ownershipMarker,
  ownershipVariable,
  processInfo,
  readOwner,
  recoverProfile,
  writeOwner
} from '../../src/core/browser/browserProcess'

let artifact: string, profile: string
let site: Awaited<ReturnType<typeof browserSite>>
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-artifact-'))
  profile = await mkdtemp(join(tmpdir(), 'cb-worker-profile-'))
  await build({
    root: resolve('zumi-bot-server/backend'),
    configFile: resolve('zumi-bot-server/backend/vite.config.ts'),
    build: { outDir: artifact },
    logLevel: 'silent'
  })
  site = await browserSite()
}, 30000)
afterAll(async () => {
  await site?.close()
  await rm(artifact, { recursive: true, force: true })
  await rm(profile, { recursive: true, force: true })
})
function runtime() {
  return {
    ...resolveBrowserRuntime(),
    workerEntry: join(artifact, 'browserWorker.mjs'),
    playwrightDir: join(artifact, 'node_modules/playwright-core'),
    executablePath: '/usr/bin/google-chrome'
  }
}
const config = { ...loadBrowserConfig({}), commandMs: 1500 }
async function browserPids(path: string) {
  const owner = await readOwner(path)
  return (
    await Promise.all(
      (owner?.processes ?? []).map(async (p) => {
        const current = await processInfo(p.pid)
        return current?.start === p.start && current.state !== 'Z' ? p.pid : null
      })
    )
  ).filter((pid): pid is number => pid !== null)
}
async function gone(pid: number) {
  const p = await processInfo(pid)
  return !p || p.state === 'Z'
}
async function processSnapshot(path: string) {
  return browserPids(path)
}

it('runs a real worker from an artifact outside repository resolution and closes owned processes', async () => {
  const i = await createWorkerAdapter(runtime()).launch(profile, config)
  try {
    expect(await i.execute({ op: 'navigate', url: site.url }, new AbortController().signal)).toMatchObject({ ok: true })
    expect(await i.execute({ op: 'observe' }, new AbortController().signal)).toMatchObject({
      ok: true,
      data: { text: expect.stringContaining('Click me') }
    })
    const generation = i.generation
    await i.invalidateReferences()
    expect(i.generation).toBe(generation)
  } finally {
    await i.close()
  }
  expect(await readdir(profile)).not.toContain('.zumibot-browser-owner.json')
})

it('fills a vault value through its own worker op and answers with codes only', async () => {
  const i = await createWorkerAdapter(runtime()).launch(join(profile, 'fill'), config)
  try {
    expect(
      await i.execute({ op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` }, new AbortController().signal)
    ).toMatchObject({ ok: true })
    const observe = async () => {
      const r = await i.execute({ op: 'observe' }, new AbortController().signal)
      if (!r.ok) throw Error(r.message)
      return r.data as { stamp: any; elements: { ref: string; name: string; text: string }[] }
    }
    const o = await observe(),
      ref = o.elements.find((e) => e.name === 'Card number')!.ref
    const fill = { stamp: o.stamp, ref, value: '4242424242424242', secret: true, target: 'input' as const }
    expect(await i.fill({ ...fill, hosts: { kind: 'card', approved: [] } }, new AbortController().signal)).toEqual({
      ok: true,
      data: { approve: { site: '127.0.0.1', frameSite: 'localhost' } }
    })
    expect(await i.fill({ ...fill, hosts: { kind: 'login', sites: ['example.com'] } }, new AbortController().signal)).toEqual({
      ok: false,
      code: 'wrong_site',
      message: 'This login is saved for example.com'
    })
    expect(
      await i.fill(
        { ...fill, hosts: { kind: 'card', approved: [{ site: '127.0.0.1', frameSite: 'localhost' }] } },
        new AbortController().signal
      )
    ).toEqual({ ok: true, data: { filled: true } })
    // The page got the value (its own echo shows it); the worker's answers never held it.
    expect((await observe()).elements.find((e) => e.name === 'Echo')?.text).toBe('Typed 4242424242424242')
  } finally {
    await i.close()
  }
})

it('keeps a long tab title, URL and dialog at their final lengths in the state it sends, so the server never closes the worker for them', async () => {
  const i = await createWorkerAdapter(runtime()).launch(join(profile, 'long'), config)
  try {
    const run = (command: Parameters<typeof i.execute>[0]) => i.execute(command, new AbortController().signal)
    expect(await run({ op: 'navigate', url: `${site.url}/long-status?v=mark` })).toMatchObject({ ok: true })
    // The page's title runs past 9 000 characters and its URL past 16 000: the state the server parses holds 500 and 8 192.
    await expect.poll(() => [i.status().tabs[0]?.title.length, i.status().tabs[0]?.url.length]).toEqual([500, 8192])
    expect(i.isClosed()).toBe(false)
    // An agent's own result still gets the margin the scrub needs.
    const tabs = (await run({ op: 'tabs' })) as { ok: true; data: { tabs: { title: string; url: string }[] } }
    expect([tabs.data.tabs[0].title.length, tabs.data.tabs[0].url.length]).toEqual([500 + 8192, 8192 + 8192])
    const o = (await run({ op: 'observe' })) as { ok: true; data: { stamp: any; elements: { ref: string; name: string }[] } }
    expect(await run({ op: 'click', stamp: o.data.stamp, ref: o.data.elements.find((e) => e.name === 'Alert')!.ref })).toMatchObject({
      ok: true
    })
    await expect.poll(() => i.status().dialog?.message.length).toBe(2000)
    expect(i.isClosed()).toBe(false)
    expect(await run({ op: 'dialog', accept: true })).toMatchObject({ ok: true })
    expect(await run({ op: 'observe' })).toMatchObject({ ok: true })
  } finally {
    await i.close()
  }
})

it('builds the worker env without the debug switches that would log a vault value', () => {
  const env = workerEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/u',
      DEBUG: 'pw:protocol',
      DEBUG_FILE: '/tmp/log',
      DEBUG_COLORS: '1',
      PWDEBUG: '1',
      PWDEBUGIMPL: '1',
      NODE_DEBUG: 'child_process',
      ZUMIBOT_LOCAL_SECRET: 's',
      ELECTRON_RUN_AS_NODE: '1'
    },
    'marker',
    false
  )
  expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', [ownershipVariable]: 'marker' })
  expect(workerEnv({ PATH: '/usr/bin' }, 'marker', true)).toEqual({
    PATH: '/usr/bin',
    [ownershipVariable]: 'marker',
    ELECTRON_RUN_AS_NODE: '1'
  })
})

it('never writes a protocol log holding a filled value, whatever DEBUG the server has', async () => {
  const log = join(profile, 'protocol.log'),
    saved = { DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE, NODE_DEBUG: process.env.NODE_DEBUG }
  Object.assign(process.env, { DEBUG: 'pw:protocol,pw:api', DEBUG_FILE: log, NODE_DEBUG: 'child_process' })
  const path = await canonicalProfile(join(profile, 'debug'))
  let i: Awaited<ReturnType<ReturnType<typeof createWorkerAdapter>['launch']>> | undefined
  try {
    i = await createWorkerAdapter(runtime()).launch(path, config)
    const env = (await readFile(`/proc/${(await readOwner(path))!.worker.pid}/environ`, 'utf8')).split('\0')
    expect(env.filter((e) => /^(DEBUG|DEBUG_\w+|PWDEBUG\w*|NODE_DEBUG)=/.test(e))).toEqual([])
    expect(await i.execute({ op: 'navigate', url: `${site.url}/login` }, new AbortController().signal)).toMatchObject({ ok: true })
    const o = await i.execute({ op: 'observe' }, new AbortController().signal)
    if (!o.ok) throw Error(o.message)
    const seen = o.data as { stamp: any; elements: { ref: string; name: string }[] }
    expect(
      await i.fill(
        {
          stamp: seen.stamp,
          ref: seen.elements.find((e) => e.name === 'Password')!.ref,
          value: 'debug-secret-value',
          secret: true,
          target: 'password',
          hosts: { kind: 'login', sites: ['127.0.0.1'] }
        },
        new AbortController().signal
      )
    ).toEqual({ ok: true, data: { filled: true } })
  } finally {
    await i?.close()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  await expect(readFile(log, 'utf8')).rejects.toThrow()
})

it('returns a generic unavailable error without leaking executable paths', async () => {
  await expect(
    createWorkerAdapter({ ...runtime(), executablePath: '/missing/private-secret' }).launch(join(profile, 'missing'), config)
  ).rejects.toThrow('Browser unavailable')
})

it('ships a complete pinned Playwright package and resolves packaged entries in isolation', async () => {
  const { resolveBrowserRuntime: packaged } = await import(pathToFileURL(join(artifact, 'browserRuntime.mjs')).href)
  expect(packaged().workerEntry).toBe(join(artifact, 'browserWorker.mjs'))
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {createRequire} from 'node:module'; const r=createRequire(${JSON.stringify(pathToFileURL(join(artifact, 'server.mjs')).href)}); const p=r('playwright-core'); console.log(r('playwright-core/package.json').version, typeof p.chromium.launchPersistentContext)`
      ],
      { cwd: artifact }
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(output) : reject(Error('Package failed'))))
  })
  expect(result.trim()).toBe('1.64.1 function')
})

it('parent runtime imports remain usable when Playwright loading is forbidden', async () => {
  const script = join(artifact, 'text-only-parent.mjs')
  await writeFile(
    script,
    `import {registerHooks} from 'node:module';
    registerHooks({resolve(s,c,next){if(s==='playwright-core')throw Error('Parent loaded Playwright');return next(s,c)}});
    const {resolveBrowserRuntime}=await import('./browserRuntime.mjs');
    const {createWorkerAdapter}=await import('./workerAdapter.mjs');
    createWorkerAdapter(resolveBrowserRuntime());`
  )
  const result = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: artifact, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  expect(result).toBe(0)
})

it('IPC EOF closes Chromium while the parent remains alive', async () => {
  const path = await canonicalProfile(join(profile, 'eof'))
  const token = randomUUID()
  const child = fork(runtime().workerEntry, [], {
    env: { ...process.env, [ownershipVariable]: ownershipMarker({ profile: path, token }) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced'
  })
  const owner = {
    version: 2 as const,
    token,
    profile: path,
    state: 'launching' as const,
    worker: await identity(child.pid!),
    parent: await identity(process.pid),
    processes: []
  }
  await writeOwner(owner)
  const response = once(child, 'message')
  child.send({ id: 1, op: 'launch', profile: path, config: { ...config, executablePath: '/usr/bin/google-chrome' } })
  // Launch may emit tab-change events before its result.
  await response
  await expect.poll(async () => (await browserPids(path)).length).toBeGreaterThan(0)
  const tree = await processSnapshot(path)
  child.disconnect()
  await expect.poll(() => gone(child.pid!), { timeout: 6000 }).toBe(true)
  expect(await Promise.all(tree.map(gone))).not.toContain(false)
  expect(await browserPids(path)).toEqual([])
})

it('forced parent death cleans its orphaned worker and Chromium', async () => {
  const path = await canonicalProfile(join(profile, 'parent-death'))
  const script = join(artifact, 'synthetic-parent.mjs')
  await writeFile(
    script,
    `import {createWorkerAdapter} from './workerAdapter.mjs';
    const instance=await createWorkerAdapter(${JSON.stringify(runtime())}).launch(${JSON.stringify(path)},${JSON.stringify(config)});
    process.send({ready:true}); setInterval(()=>{},1000);`
  )
  const parent = fork(script, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  try {
    await once(parent, 'message')
    const owner = (await readOwner(path))!
    const chromium = await browserPids(path)
    const tree = await processSnapshot(path)
    expect(chromium.length).toBeGreaterThan(0)
    // Freeze the browser so closing its IPC pipe alone cannot satisfy cleanup.
    process.kill(chromium[0], 'SIGSTOP')
    expect((await browserPids(path)).length).toBeGreaterThan(0)
    parent.kill('SIGKILL')
    await expect.poll(() => gone(owner.worker.pid), { timeout: 6000 }).toBe(true)
    expect(await browserPids(path)).toEqual([])
    await expect.poll(async () => (await Promise.all(tree.map(gone))).every(Boolean)).toBe(true)
    expect(await readOwner(path)).toMatchObject({ state: 'stopped' })
  } finally {
    parent.kill('SIGKILL')
    await recoverProfile(path)
  }
}, 10000)

it.each(['-other', ' --unrelated'] as const)('forced worker death preserves an unrelated profile suffix %s', async (suffix) => {
  const path = await canonicalProfile(join(profile, 'worker profile [1]'))
  const unrelated = await createWorkerAdapter(runtime()).launch(path + suffix, config)
  const i = await createWorkerAdapter(runtime()).launch(path, config)
  try {
    const owner = (await readOwner(path))!
    const chromium = await browserPids(path)
    const tree = await processSnapshot(path)
    expect(chromium.length).toBeGreaterThan(0)
    process.kill(chromium[0], 'SIGSTOP')
    const pending = i.execute({ op: 'navigate', url: site.url + '/slow?secret' }, new AbortController().signal)
    const rejection = expect(pending).rejects.toThrow('Browser unavailable')
    process.kill(owner.worker.pid, 'SIGKILL')
    await rejection
    await i.close()
    expect(i.isClosed()).toBe(true)
    expect(await Promise.all(tree.map(gone))).not.toContain(false)
    expect(await unrelated.execute({ op: 'navigate', url: site.url }, new AbortController().signal)).toMatchObject({ ok: true })
  } finally {
    await i.close()
    await unrelated.close()
  }
})

it.each(['reused', 'missing-marker', 'malformed-marker', 'different-nonce'] as const)(
  'stale recovery will not signal a process with %s proof',
  async (kind) => {
    const path = await canonicalProfile(join(profile, 'reused-pid'))
    const token = randomUUID(),
      env = { ...process.env }
    delete env[ownershipVariable]
    if (kind === 'malformed-marker') env[ownershipVariable] = 'not-an-ownership-marker'
    if (kind === 'different-nonce') env[ownershipVariable] = ownershipMarker({ profile: path, token: randomUUID() })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env })
    try {
      await writeOwner({
        version: 2,
        token,
        profile: path,
        state: 'stopped',
        worker: kind === 'reused' ? { pid: unrelated.pid!, start: '0' } : await identity(unrelated.pid!),
        parent: { pid: 2147483647, start: '0' },
        processes: []
      })
      if (kind === 'reused') await recoverProfile(path)
      else await expect(recoverProfile(path)).rejects.toThrow('Browser ownership proof unavailable')
      expect(await gone(unrelated.pid!)).toBe(false)
    } finally {
      unrelated.kill('SIGKILL')
    }
  }
)

it('malformed persisted ownership blocks profile reuse without replacing its evidence', async () => {
  const path = await canonicalProfile(join(profile, 'malformed-owner'))
  const file = join(path, '.zumibot-browser-owner.json')
  await writeFile(file, '{invalid ownership')
  await expect(createWorkerAdapter(runtime()).launch(path, config)).rejects.toThrow('Browser cleanup could not be confirmed')
  expect(await readFile(file, 'utf8')).toBe('{invalid ownership')
})

it('changed ownership nonce cannot authorize cleanup of a live browser at the same profile', async () => {
  const path = await canonicalProfile(join(profile, 'nonce-proof'))
  const i = await createWorkerAdapter(runtime()).launch(path, config)
  try {
    const owner = (await readOwner(path))!
    await expect(cleanupOwned({ ...owner, token: randomUUID() }, true)).rejects.toThrow('Browser ownership proof changed')
    expect(await i.execute({ op: 'navigate', url: site.url }, new AbortController().signal)).toMatchObject({ ok: true })
  } finally {
    await i.close()
  }
})

it('persists unconfirmed startup cleanup and allows close retry only after stopped proof', async () => {
  const path = await canonicalProfile(join(profile, 'uncertain-startup'))
  const workerEntry = join(artifact, 'uncertain-startup.mjs')
  await writeFile(
    workerEntry,
    `process.on('message',r=>{if(r.op==='launch')process.send({type:'result',id:r.id,error:'launch failed'});if(r.op==='close')process.exit(0)});`
  )
  let failure: unknown
  try {
    await createWorkerAdapter({ ...runtime(), workerEntry }).launch(path, config)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(BrowserLaunchCleanupError)
  const reservation = (failure as BrowserLaunchCleanupError).instance
  const owner = (await readOwner(path))!
  expect(owner).toMatchObject({ state: 'unconfirmed' })
  await expect(reservation.close()).rejects.toThrow('Browser cleanup could not be confirmed')
  await expect(recoverProfile(path)).rejects.toThrow('Browser cleanup could not be confirmed')
  // This synthetic child never spawned Chromium; the test can establish stopped proof.
  await writeOwner({ ...owner, state: 'stopped' })
  await reservation.close()
  expect(reservation.isClosed()).toBe(true)
  expect(await readOwner(path)).toBe(null)
})

it('streams download chunks with acknowledgements through the built worker and leaves no scratch files', async () => {
  const received: Buffer[] = []
  const path = join(profile, 'files')
  const i = await createWorkerAdapter(runtime()).launch(path, config, {
    download: async (source, name, generation) => {
      expect(name).toBe('network.txt')
      expect(generation).toBe(i.generation)
      for await (const bytes of source) {
        expect(bytes.length).toBeLessThanOrEqual(65536)
        received.push(Buffer.from(bytes))
      }
      return { id: 'opaque-download', name, size: received.reduce((n, b) => n + b.length, 0) }
    }
  })
  try {
    await i.execute({ op: 'navigate', url: site.url + '/files' }, new AbortController().signal)
    const r = await i.execute({ op: 'observe' }, new AbortController().signal)
    if (!r.ok) throw Error('fixture unavailable')
    const o = r.data as { stamp: import('../../src/core/browser/types').BrowserStamp; elements: { name: string; ref: string }[] }
    await i.execute(
      { op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Network download')!.ref },
      new AbortController().signal
    )
    await expect.poll(() => Buffer.concat(received).toString(), { timeout: 5000 }).toBe('network bytes')
  } finally {
    await i.close()
  }
  expect((await readdir(path)).some((n) => n.startsWith('.downloads-'))).toBe(false)
})

it('cancels oversized download progress while the parent chunk ACK stalls and removes partial data', async () => {
  const { BrowserFiles } = await import('../../src/core/browser/browserFiles')
  const path = join(profile, 'ack-stall'),
    staging = join(profile, 'ack-stall-staged'),
    files = new BrowserFiles(staging)
  await files.clear()
  let release!: () => void,
    first = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const i = await createWorkerAdapter(runtime()).launch(path, config, {
    download: (source, name, generation, signal) => {
      async function* stalled() {
        for await (const chunk of source) {
          first = true
          yield chunk
          await gate
        }
      }
      return files.stageDownload({ profileId: 'p', generation, viewerId: 'v' }, stalled(), name, signal)
    }
  })
  try {
    await i.execute({ op: 'navigate', url: site.url + '/files' }, new AbortController().signal)
    const r = await i.execute({ op: 'observe' }, new AbortController().signal)
    if (!r.ok) throw Error('fixture unavailable')
    const o = r.data as { stamp: import('../../src/core/browser/types').BrowserStamp; elements: { name: string; ref: string }[] }
    await i.execute(
      { op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Oversized download')!.ref },
      new AbortController().signal
    )
    await expect.poll(() => site.oversized.closed, { timeout: 5000 }).toBe(true)
    expect(first).toBe(true)
    expect(site.oversized.finished).toBe(false)
    await expect.poll(() => readdir(staging)).toEqual([])
    const scratch = (await readdir(path)).find((n) => n.startsWith('.downloads-'))!
    await expect.poll(() => readdir(join(path, scratch))).toEqual([])
  } finally {
    release()
    await i.close()
    await files.close()
  }
}, 10000)
it('keeps an agent-triggered prompt resolvable after exclusive human takeover', async () => {
  const { BrowserManager } = await import('../../src/core/browser/browserManager')
  const { BrowserProfileStore } = await import('../../src/core/browser/profileStore')
  const profiles = new BrowserProfileStore(join(profile, 'takeover-store'))
  await profiles.load()
  const manager = new BrowserManager({
    profiles,
    adapter: createWorkerAdapter(runtime()),
    config,
    now: Date.now,
    newId: randomUUID,
    resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
    onHandoff: async () => {}
  })
  const owner = { profileId: (await profiles.ensure('a')).id, chatId: 'chat', turnId: 'turn' },
    signal = new AbortController().signal
  try {
    await manager.run(owner, { op: 'navigate', url: site.url + '/files' }, signal)
    const r = await manager.run(owner, { op: 'observe' }, signal)
    if (!r.ok) throw Error('fixture unavailable')
    const o = r.data as { stamp: import('../../src/core/browser/types').BrowserStamp; elements: { name: string; ref: string }[] }
    expect(
      await manager.run(owner, { op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Prompt')!.ref }, signal)
    ).toMatchObject({ ok: true, data: { dialogPending: true } })
    const sub = await manager.watch({ agent: 'a' }, { id: 'human', sessionKey: 'session', sendStatus() {}, sendFrame() {} })
    await manager.takeControl('human')
    const status = await manager.status('a')
    expect(
      await manager.navigate(
        'human',
        { op: 'dialog', accept: true, text: 'تأكيد' },
        { generation: status.generation, tabId: status.activeTabId! }
      )
    ).toMatchObject({ ok: true })
    await manager.releaseControl('human')
    expect(await manager.run(owner, { op: 'observe' }, signal)).toMatchObject({
      ok: true,
      data: { text: expect.stringContaining('تأكيد') }
    })
    await sub.close()
  } finally {
    await manager.close()
  }
}, 10000)
it('releases the doubled download reservation only after the worker confirms source deletion', async () => {
  const { BrowserFiles } = await import('../../src/core/browser/browserFiles')
  const path = join(profile, 'cleanup-ack'),
    files = new BrowserFiles(join(profile, 'cleanup-ack-staged'))
  await files.clear()
  const owner = { profileId: 'p', generation: 'g', viewerId: 'v' }
  for (let n = 0; n < 2; n++)
    await files.stageDownload(
      owner,
      (async function* () {
        yield Buffer.alloc(20 * 1024 * 1024)
      })(),
      'existing'
    )
  let cleanupRequested = false,
    acknowledged = false,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const i = await createWorkerAdapter(runtime()).launch(path, config, {
    download: (source, name, _generation, signal) => files.stageDownload(owner, source, name, signal),
    sourceClosed: async (id) => {
      const scratch = (await readdir(path)).find((n) => n.startsWith('.downloads-'))!
      expect(await readdir(join(path, scratch))).toEqual([])
      cleanupRequested = true
      await gate
      files.sourceClosed(id)
      acknowledged = true
    }
  })
  try {
    await i.execute({ op: 'navigate', url: site.url + '/files' }, new AbortController().signal)
    const r = await i.execute({ op: 'observe' }, new AbortController().signal)
    if (!r.ok) throw Error('fixture unavailable')
    const o = r.data as { stamp: import('../../src/core/browser/types').BrowserStamp; elements: { name: string; ref: string }[] }
    await i.execute(
      { op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Network download')!.ref },
      new AbortController().signal
    )
    await expect.poll(() => cleanupRequested).toBe(true)
    const retained = () =>
      Object.assign(
        (async function* () {
          yield Buffer.from('next')
        })(),
        { retainsSource: true as const }
      )
    await expect(files.stageDownload(owner, retained(), 'before-cleanup-ack')).rejects.toThrow('limit')
    release()
    await expect.poll(() => acknowledged).toBe(true)
    expect((await files.stageDownload(owner, retained(), 'after-cleanup-ack')).size).toBe(4)
  } finally {
    release()
    await i.close()
    await files.close()
  }
}, 10000)

it('keeps a failed worker download reserved until its source cleanup identity is confirmed', async () => {
  const { BrowserFiles } = await import('../../src/core/browser/browserFiles')
  const path = join(profile, 'failed-cleanup-ack'),
    staging = join(profile, 'failed-cleanup-staged'),
    files = new BrowserFiles(staging)
  await files.clear()
  const owner = { profileId: 'p', generation: 'g', viewerId: 'v' }
  for (let n = 0; n < 2; n++)
    await files.stageDownload(
      owner,
      (async function* () {
        yield Buffer.alloc(20 * 1024 * 1024)
      })(),
      'existing'
    )
  let cleanupRequested = false,
    confirmed = false,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const i = await createWorkerAdapter(runtime()).launch(path, config, {
    download: (source, name, _generation, signal) => {
      const failing = Object.assign(
        (async function* () {
          for await (const chunk of source) {
            yield chunk
            throw new Error('synthetic sink failure')
          }
        })(),
        { retainsSource: true as const, sourceId: source.sourceId }
      )
      return files.stageDownload(owner, failing, name, signal)
    },
    sourceClosed: async (id) => {
      const scratch = (await readdir(path)).find((n) => n.startsWith('.downloads-'))!
      expect(await readdir(join(path, scratch))).toEqual([])
      cleanupRequested = true
      await gate
      files.sourceClosed(id)
      confirmed = true
    }
  })
  try {
    await i.execute({ op: 'navigate', url: site.url + '/files' }, new AbortController().signal)
    const r = await i.execute({ op: 'observe' }, new AbortController().signal)
    if (!r.ok) throw Error('fixture unavailable')
    const o = r.data as { stamp: import('../../src/core/browser/types').BrowserStamp; elements: { name: string; ref: string }[] }
    await i.execute(
      { op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Network download')!.ref },
      new AbortController().signal
    )
    await expect.poll(() => cleanupRequested, { timeout: 2000 }).toBe(true)
    expect(files.list(owner.profileId)).toHaveLength(2)
    expect(await readdir(staging)).toHaveLength(2)
    const replacement = () =>
      Object.assign(
        (async function* () {
          yield Buffer.from('next')
        })(),
        { retainsSource: true as const, sourceId: 'replacement' }
      )
    await expect(files.stageDownload(owner, replacement(), 'before-failed-cleanup-ack')).rejects.toThrow('limit')
    release()
    await expect.poll(() => confirmed).toBe(true)
    expect((await files.stageDownload(owner, replacement(), 'after-failed-cleanup-ack')).size).toBe(4)
    files.sourceClosed('replacement')
  } finally {
    release()
    await i.close()
    await files.close()
  }
}, 10000)
