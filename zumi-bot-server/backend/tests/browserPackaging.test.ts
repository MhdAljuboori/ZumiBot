import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { BrowserCapabilities } from '../src/core/browser/browserCapabilities'
import { serveBrowserIpc } from '../src/core/browser/browserIpc'
import { serveDesktopIpc } from '../src/core/desktop/desktopIpc'
import { serveTodoIpc } from '../src/core/todos/todoIpc'
import { serveAutomationIpc } from '../src/core/automations/automationIpc'
import { serveVaultIpc } from '../src/core/vault/vaultIpc'
import { identity, isRunning, processInfo, readOwner, recoverProfile } from '../src/core/browser/browserProcess'
import { writeFakeBin } from './support/fakeBin'

let root: string, artifact: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb packaged browser '))
  const built = join(root, 'build')
  artifact = join(root, 'copy outside repo with spaces')
  await build({
    root: resolve('zumi-bot-server/backend'),
    configFile: resolve('zumi-bot-server/backend/vite.config.ts'),
    build: { outDir: built },
    logLevel: 'silent'
  })
  await cp(built, artifact, { recursive: true })
  await rm(built, { recursive: true })
}, 30000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
const env = (data: string, extra: NodeJS.ProcessEnv = {}) => ({ HOME: root, PATH: '/nonexistent', ZUMIBOT_DATA_DIR: data, ...extra })
async function run(args: string[], variables: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: artifact,
    env: env(join(root, 'unused data'), variables),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = '',
    err = ''
  child.stdout.on('data', (b) => {
    out += b
  })
  child.stderr.on('data', (b) => {
    err += b
  })
  const [code] = await once(child, 'exit')
  return { code, out, err }
}
const cli = (...args: string[]) => [join(artifact, 'server.mjs'), ...args]
async function gone(pid: number) {
  const p = await processInfo(pid)
  return !p || p.state === 'Z'
}

it('ships a runnable pinned CLI with no repository or PATH dependency', async () => {
  expect(await run([join(artifact, 'node_modules/playwright-core/cli.js'), '--version'])).toEqual({
    code: 0,
    out: 'Version 1.64.1\n',
    err: ''
  })
})

// The agent browser (a Linux Chromium owned through /proc) is Linux-only, so its checks run only there.
it.skipIf(process.platform !== 'linux')(
  'checks a copied artifact with a sandboxed ephemeral profile, leaving app data untouched',
  async () => {
    const data = join(root, 'check data'),
      scratch = join(root, 'check scratch')
    await mkdir(scratch)
    await writeFile(join(scratch, 'unrelated-temp-owner'), 'preserve')
    await mkdir(join(data, 'browsers'), { recursive: true })
    await writeFile(join(data, 'browsers/profiles.json'), 'deliberately unreadable profile metadata')
    const executable = join(root, 'check browser'),
      record = join(root, 'check launch'),
      proceed = join(root, 'check proceed')
    // Gate exec so worker/browser birth identities are captured without a polling race.
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$$" "$PPID" "$@" > '${record}'\nwhile [ ! -f '${proceed}' ]; do /bin/sleep 0.01; done\nexec /opt/google/chrome/chrome "$@"\n`
    )
    await chmod(executable, 0o755)
    const checking = run(cli('browser-check'), { ZUMIBOT_DATA_DIR: data, TMPDIR: scratch, ZUMIBOT_BROWSER_EXECUTABLE_PATH: executable })
    let profile = '',
      owned: Awaited<ReturnType<typeof identity>>[] = []
    try {
      await expect.poll(() => readFile(record, 'utf8').catch(() => ''), { timeout: 5000 }).toContain('--user-data-dir=')
      const lines = (await readFile(record, 'utf8')).trim().split('\n')
      profile = lines.find((line) => line.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)
      expect(dirname(dirname(profile))).toBe(scratch)
      owned = await Promise.all(lines.slice(0, 2).map((pid) => identity(Number(pid))))
      expect((await readOwner(profile))?.worker).toEqual(owned[1])
    } finally {
      await writeFile(proceed, '')
      await checking
    }
    const result = await checking
    expect(result).toMatchObject({ code: 0, err: '' })
    await expect(readdir(dirname(profile))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const process of owned) expect(await isRunning(process)).toBe(false)
    // TMPDIR is shared with Chrome internals; cleanup owns only the check subtree.
    expect((await readdir(scratch)).filter((name) => name.startsWith('zumibot-browser-check-'))).toEqual([])
    expect(await readFile(join(scratch, 'unrelated-temp-owner'), 'utf8')).toBe('preserve')
    expect(result.out).toContain('Browser check passed')
    expect(await readdir(data)).toEqual(['browsers'])
    expect(await readFile(join(data, 'browsers/profiles.json'), 'utf8')).toBe('deliberately unreadable profile metadata')
  },
  15000
)

it('reports a missing override without fallback, download, auth setup, or data creation', async () => {
  const data = join(root, 'missing data')
  const result = await run(cli('browser-check'), { ZUMIBOT_DATA_DIR: data, ZUMIBOT_BROWSER_EXECUTABLE_PATH: '/missing/browser' })
  expect(result.code).toBe(1)
  expect(result.err).toContain('browser-install')
  expect(result.err).toContain('ZUMIBOT_BROWSER_EXECUTABLE_PATH')
  await expect(readdir(data)).rejects.toThrow()
})

it('uses the shipped pinned CLI only on explicit install and confines its cache without sudo', async () => {
  const isolated = join(root, 'install artifact'),
    data = join(root, 'install data'),
    record = join(root, 'install record.json')
  await cp(artifact, isolated, { recursive: true })
  // Replace only the upstream download boundary; no network or browser installation in this test.
  await writeFile(
    join(isolated, 'node_modules/playwright-core/cli.js'),
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),cache:process.env.PLAYWRIGHT_BROWSERS_PATH,electron:process.env.ELECTRON_RUN_AS_NODE,secret:process.env.ZUMIBOT_LOCAL_SECRET}));process.exit(17);`
  )
  const result = await run([join(isolated, 'server.mjs'), 'browser-install'], {
    ZUMIBOT_DATA_DIR: data,
    PLAYWRIGHT_BROWSERS_PATH: '/wrong/cache',
    ZUMIBOT_LOCAL_SECRET: 'must-not-inherit'
  })
  expect(await readFile(record, 'utf8').then(JSON.parse)).toEqual({
    args: ['install', '--no-shell', 'chromium'],
    cache: join(data, 'browser-runtime')
  })
  expect(result.code).toBe(1)
  expect(result.err).toContain('Browser installation failed')
  expect(await readdir(data)).toEqual(['browser-runtime'])
})

it.skipIf(process.platform !== 'linux')(
  'checks missing OS dependencies without attempting installation or disabling the sandbox',
  async () => {
    const isolated = join(root, 'dependency artifact'),
      data = join(root, 'dependency data'),
      record = join(root, 'browser launch args')
    await cp(artifact, isolated, { recursive: true })
    await writeFile(join(isolated, 'node_modules/playwright-core/cli.js'), `throw Error('Unexpected auto install');`)
    const executable = join(root, 'missing libraries browser')
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\necho 'error while loading shared libraries: libSyntheticMissing.so' >&2\nexit 127\n`
    )
    await chmod(executable, 0o755)
    const result = await run([join(isolated, 'server.mjs'), 'browser-check'], {
      ZUMIBOT_DATA_DIR: data,
      ZUMIBOT_BROWSER_EXECUTABLE_PATH: executable
    })
    expect(result.code).toBe(1)
    expect(result.err).toContain('OS libraries')
    expect(result.err).toContain('sandbox')
    expect(await readFile(record, 'utf8')).not.toContain('--no-sandbox')
    await expect(readdir(data)).rejects.toThrow()
  },
  15000
)

it.skipIf(process.platform !== 'linux')(
  'resolves the pinned managed browser ahead of system Chrome, and an explicit override ahead of both',
  async () => {
    const data = join(root, 'managed data')
    const managed = join(
      data,
      'browser-runtime/chromium-1248',
      process.arch === 'arm64' ? 'chrome-linux-arm64/chrome' : 'chrome-linux64/chrome'
    )
    await mkdir(join(managed, '..'), { recursive: true })
    await writeFile(managed, '#!/bin/sh\nexit 0\n')
    await chmod(managed, 0o755)
    const module = pathToFileURL(join(artifact, 'browserRuntime.mjs')).href
    const result = await run(
      [
        '--input-type=module',
        '-e',
        `const {resolveBrowserRuntime}=await import(${JSON.stringify(module)}); console.log(resolveBrowserRuntime().executablePath)`
      ],
      { ZUMIBOT_DATA_DIR: data }
    )
    expect(result.out.trim()).toBe(managed)
    const overridden = await run(
      [
        '--input-type=module',
        '-e',
        `const {resolveBrowserRuntime}=await import(${JSON.stringify(module)}); console.log(resolveBrowserRuntime().executablePath)`
      ],
      { ZUMIBOT_DATA_DIR: data, ZUMIBOT_BROWSER_EXECUTABLE_PATH: '/opt/google/chrome/chrome' }
    )
    expect(overridden.out.trim()).toBe('/opt/google/chrome/chrome')
  }
)

it('discovers and routes the copied bridge from a directory with spaces and no PATH tools', async () => {
  const owner = { profileId: 'profile', chatId: 'chat', turnId: 'turn' }
  const service = await serveBrowserIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { node: process.execPath, bridgeEntry: join(artifact, 'browserBridge.mjs'), electronNode: false },
    manager: {
      registerTurn: () => () => {},
      endTurn: async () => {},
      run: async (actual, command) => {
        expect(actual).toEqual(owner)
        expect(command).toEqual({ op: 'tabs' })
        return { ok: true, data: { tabs: [] } }
      }
    }
  })
  const turn = await service.createBrowserTurn(owner, async () => {})
  const client = new Client({ name: 'packaging-test', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(artifact, 'browserBridge.mjs')],
        cwd: artifact,
        env: env(root, turn.env) as Record<string, string>
      })
    )
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('browser_tabs')
    expect(await client.callTool({ name: 'browser_tabs', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"tabs":[]') }]
    })
  } finally {
    await client.close()
    await turn.dispose()
    await service.close()
  }
})

it('discovers and routes the copied desktop bridge from a directory with spaces and no PATH tools', async () => {
  const owner = { profileId: 'profile', chatId: 'chat', turnId: 'turn' }
  const service = await serveDesktopIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { node: process.execPath, bridgeEntry: join(artifact, 'desktopBridge.mjs'), electronNode: false },
    manager: {
      registerTurn: () => () => {},
      endTurn: async () => {},
      run: async (actual, command) => {
        expect(actual).toEqual(owner)
        expect(command).toEqual({ op: 'windows' })
        return { ok: true, data: { windows: [] } }
      }
    }
  })
  const turn = await service.createDesktopTurn(owner, async () => {})
  const client = new Client({ name: 'packaging-test', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(artifact, 'desktopBridge.mjs')],
        cwd: artifact,
        env: env(root, turn.env) as Record<string, string>
      })
    )
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('desktop_windows')
    expect(await client.callTool({ name: 'desktop_windows', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"windows":[]') }]
    })
  } finally {
    await client.close()
    await turn.dispose()
    await service.close()
  }
})

it('ships the to-do bridge beside the others and routes it from a directory with spaces', async () => {
  expect((await readdir(artifact)).filter((name) => /Bridge\.mjs$/.test(name)).sort()).toEqual([
    'askBridge.mjs',
    'automationBridge.mjs',
    'browserBridge.mjs',
    'desktopBridge.mjs',
    'processBridge.mjs',
    'todoBridge.mjs',
    'vaultBridge.mjs'
  ])
  const calls: unknown[][] = []
  const service = await serveTodoIpc({
    runtime: { node: process.execPath, todoBridgeEntry: join(artifact, 'todoBridge.mjs'), electronNode: false },
    service: {
      agentList: async (...a: unknown[]) => {
        calls.push(a)
        return 'No open to-dos.'
      },
      agentAdd: async () => '',
      agentCheck: async () => '',
      agentRemove: async () => '',
      agentAskUser: async () => '',
      agentReview: async () => '',
      agentComment: async () => ''
    }
  })
  const turn = service.createTodoTurn({ chatId: 'chat', agent: () => 'ann', turn: 'turn', label: 'l' })
  const client = new Client({ name: 'packaging-test', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(artifact, 'todoBridge.mjs')],
        cwd: artifact,
        env: env(root, turn.env) as Record<string, string>
      })
    )
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'add',
      'ask_user',
      'check',
      'comment',
      'list',
      'ready_for_review',
      'remove'
    ])
    expect(await client.callTool({ name: 'list', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'No open to-dos.' }] })
    expect(calls).toEqual([['chat', 'ann']])
  } finally {
    await client.close()
    turn.dispose()
    await service.close()
  }
})

it('ships automationBridge.mjs and routes it from a directory with spaces', async () => {
  const seen: unknown[] = []
  const service = await serveAutomationIpc({
    runtime: { node: process.execPath, automationBridgeEntry: join(artifact, 'automationBridge.mjs'), electronNode: false },
    service: {
      run: async (owner: unknown, call: unknown) => {
        seen.push([owner, call])
        return '[]'
      }
    } as never
  })
  const turn = service.createAutomationTurn({ chatId: 'chat', writable: false })
  const client = new Client({ name: 'packaging-test', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(artifact, 'automationBridge.mjs')],
        cwd: artifact,
        env: env(root, turn.env) as Record<string, string>
      })
    )
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('workflow_save')
    expect(await client.callTool({ name: 'workflows_list', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: '[]' }] })
    expect(seen).toEqual([[{ chatId: 'chat', writable: false }, { op: 'workflows_list' }]])
  } finally {
    await client.close()
    turn.dispose()
    await service.close()
  }
})

it('ships vaultBridge.mjs and routes it from a directory with spaces', async () => {
  const seen: string[] = []
  const service = await serveVaultIpc({
    runtime: { node: process.execPath, vaultBridgeEntry: join(artifact, 'vaultBridge.mjs'), electronNode: false },
    items: (agent) => {
      seen.push(agent)
      return [{ id: 'k1', kind: 'apiKey', name: 'Azure PAT', env: 'AZURE_PAT', description: '' }]
    }
  })
  const turn = service.createVaultTurn({ chatId: 'chat', agent: () => 'ann', turn: 'turn' })
  const client = new Client({ name: 'packaging-test', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(artifact, 'vaultBridge.mjs')],
        cwd: artifact,
        env: env(root, turn.env) as Record<string, string>
      })
    )
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['vault_items'])
    expect(await client.callTool({ name: 'vault_items', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('AZURE_PAT') }]
    })
    expect(seen).toEqual(['ann'])
  } finally {
    await client.close()
    turn.dispose()
    await service.close()
  }
})

it('ships the pause hook entry, and it blocks main-thread calls and lets subagent calls through', async () => {
  const hook = join(artifact, 'pauseHook.mjs')
  const feed = (input: string) =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [hook], { cwd: artifact, env: env(root), stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (b) => {
        err += b
      })
      child.once('exit', (code) => resolve({ code, err }))
      child.stdin.end(input)
    })
  expect(await feed('{"tool_name":"Bash"}')).toEqual({ code: 2, err: expect.stringContaining('(zumibot-pause)') })
  expect(await feed('{"tool_name":"Bash","agent_id":"a1"}')).toEqual({ code: 0, err: '' })
  // Input cut short or missing is blocked, with the text, so the agent learns why.
  expect(await feed('{"tool_name":"Bash","agent_')).toEqual({ code: 2, err: expect.stringContaining('(zumibot-pause)') })
  expect(await feed('')).toEqual({ code: 2, err: expect.stringContaining('(zumibot-pause)') })
})

it.skipIf(process.platform !== 'linux')(
  'a copied worker closes its whole owned Chromium tree after forced parent death',
  async () => {
    const profile = join(root, 'synthetic profile with spaces'),
      script = join(artifact, 'parent with spaces.mjs')
    await writeFile(
      script,
      `import {createWorkerAdapter} from './workerAdapter.mjs'; import {resolveBrowserRuntime} from './browserRuntime.mjs';
    const config={maxBrowsers:2,maxTabs:4,idleMs:120000,leaseIdleMs:120000,handoffIdleMs:600000,commandMs:5000,queueMs:120000,fps:10,width:1280,height:800,scale:2,executablePath:null};
    const instance=await createWorkerAdapter(resolveBrowserRuntime()).launch(${JSON.stringify(profile)},config);
    const result=await instance.execute({op:'observe'},new AbortController().signal);if(!result.ok)process.exit(2);
    process.send({ready:true});setInterval(()=>{},1000);`
    )
    const parent = fork(script, [], {
      cwd: artifact,
      env: env(root, { ZUMIBOT_BROWSER_EXECUTABLE_PATH: '/opt/google/chrome/chrome' }),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let stderr = ''
    parent.stderr!.on('data', (b) => {
      stderr += b
    })
    try {
      await Promise.race([
        once(parent, 'message'),
        once(parent, 'exit').then(() => {
          throw Error('Synthetic parent exited before ready: ' + stderr)
        })
      ])
      const owner = (await readOwner(profile))!
      expect(owner.processes.length).toBeGreaterThan(0)
      process.kill(owner.processes[0].pid, 'SIGSTOP')
      parent.kill('SIGKILL')
      await expect.poll(() => gone(owner.worker.pid), { timeout: 7000 }).toBe(true)
      for (const p of owner.processes) expect(await gone(p.pid)).toBe(true)
    } finally {
      parent.kill('SIGKILL')
      await recoverProfile(profile)
    }
  },
  15000
)

it('keeps serve and a fake text turn usable without a browser or parent Playwright loading', async () => {
  const data = join(root, 'text data'),
    agents = join(root, 'text agents'),
    secret = 'packaging-test-secret'.padEnd(40, 'x')
  await mkdir(data)
  await mkdir(agents)
  await cp(resolve('zumi-bot-server/backend/tests/fixtures/fake-claude.mjs'), join(root, 'fake.mjs'))
  await cp(resolve('zumi-bot-server/backend/tests/fixtures/stream/basic.jsonl'), join(root, 'basic.jsonl'))
  const fake = writeFakeBin(root, 'fake claude', join(root, 'fake.mjs'))
  await writeFile(join(data, 'settings.json'), JSON.stringify({ claudePath: fake }))
  await writeFile(join(agents, 'tester.md'), '---\nname: tester\ndescription: Test\n---\nTest.')
  const script = join(artifact, 'serve without playwright.mjs')
  await writeFile(
    script,
    `import {registerHooks} from 'node:module'; registerHooks({resolve(s,c,next){if(s==='playwright-core')throw Error('Parent loaded Playwright');return next(s,c)}});process.argv=[process.argv[0],process.argv[1],'serve'];await import('./server.mjs');`
  )
  const child = spawn(process.execPath, [script], {
    cwd: artifact,
    env: env(data, {
      ZUMIBOT_MODE: 'local',
      ZUMIBOT_LOCAL_SECRET: secret,
      ZUMIBOT_AGENTS_DIR: agents,
      ZUMIBOT_PORT: '0',
      ZUMIBOT_BROWSER_EXECUTABLE_PATH: '/missing/browser',
      FAKE_STDOUT_FILE: join(root, 'basic.jsonl')
    })
  })
  let output = '',
    errors = ''
  child.stdout.on('data', (b) => {
    output += b
  })
  child.stderr.on('data', (b) => {
    errors += b
  })
  let ws: WebSocket | undefined
  try {
    await expect.poll(() => output, { timeout: 10000 }).toMatch(/LISTENING \d+/)
    const origin = `http://127.0.0.1:${/LISTENING (\d+)/.exec(output)![1]}`
    ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin, Cookie: `cb_local=${secret}` } })
    await once(ws, 'open')
    let id = 0
    const call = (method: string, ...args: unknown[]) =>
      new Promise<any>((resolve, reject) => {
        const n = ++id
        const onMessage = (b: Buffer) => {
          const r = JSON.parse(String(b))
          if (r.id !== n) return
          ws!.off('message', onMessage)
          r.ok ? resolve(r.value) : reject(Error(r.error))
        }
        ws!.on('message', onMessage)
        ws!.send(JSON.stringify({ id: n, method, args }))
      })
    const chat = await call('chats:create', 'tester', root)
    await call('chats:send', chat.id, 'hello', [])
    await expect.poll(async () => JSON.stringify(await call('chats:items', chat.id)), { timeout: 8000 }).toContain('pong')
    expect(await call('browsers:status', 'tester')).toMatchObject({ state: 'stopped', tabs: [] })
    expect(errors).not.toContain('Parent loaded Playwright')
  } finally {
    ws?.terminate()
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
}, 20000)
