import { expect, test, vi } from 'vitest'
import { createRunEnv, loginShell, resolveRunPath, spawnCapture } from '../../src/core/chat/shellEnv'

const fallback = '/usr/bin:/bin'
// Linux behaviour: Windows never asks a shell (windowsPort.test.ts).
const platform = 'linux' as const
const deps = (capture: (file: string, args: string[]) => Promise<string>) => ({ capture: vi.fn(capture), fallback, platform })

test('takes the text after the last marker and ignores banner noise', async () => {
  const d = deps(async () => 'Welcome to bash\n__CB__ not the real one\nmotd\n\n__CB__/home/u/.nvm/bin:/usr/bin:/bin')
  expect(await resolveRunPath(d)).toBe('/home/u/.nvm/bin:/usr/bin:/bin')
})

test('runs an interactive login bash that prints the marker', async () => {
  const d = deps(async () => '\n__CB__/a:/b')
  await resolveRunPath(d)
  const [file, args] = d.capture.mock.calls[0]
  expect(file).toBe('bash')
  expect(args.slice(0, 1)).toEqual(['-ilc'])
  expect(args[1]).toContain('__CB__')
  expect(args[1]).toContain('$PATH')
})

test('asks zsh on a Mac, where Homebrew and nvm write their PATH, unless the user picked bash', async () => {
  expect(loginShell('darwin', '/bin/zsh')).toBe('zsh')
  expect(loginShell('darwin', '')).toBe('zsh')
  expect(loginShell('darwin', '/usr/local/bin/fish')).toBe('zsh')
  expect(loginShell('darwin', '/bin/bash')).toBe('bash')
  expect(loginShell('linux', '/usr/bin/zsh')).toBe('bash')
  const d = { ...deps(async () => '\n__CB__/opt/homebrew/bin:/usr/bin'), platform: 'darwin' as const, userShell: '/bin/zsh' }
  expect(await resolveRunPath(d)).toBe('/opt/homebrew/bin:/usr/bin')
  expect(d.capture.mock.calls[0]![0]).toBe('zsh')
  expect(d.capture.mock.calls[0]![1][0]).toBe('-ilc')
})

test('falls back when the shell fails or times out', async () => {
  expect(
    await resolveRunPath(
      deps(async () => {
        throw new Error('timed out')
      })
    )
  ).toBe(fallback)
})

test.each([
  ['no marker', 'just a banner'],
  ['empty value', '\n__CB__'],
  ['relative entry', '\n__CB__/a/bin:relative/bin'],
  ['empty entry', '\n__CB__/a/bin::/b/bin'],
  ['junk', '\n__CB__command not found']
])('rejects %s', async (_name, out) => {
  expect(await resolveRunPath(deps(async () => out))).toBe(fallback)
})

test('createRunEnv resolves once and merges PATH over the process env', async () => {
  const d = deps(async () => '\n__CB__/nvm/bin:/usr/bin')
  const run = createRunEnv({ ...d, base: { HOME: '/home/u', PATH: fallback } })
  expect(run.env()).toEqual({ HOME: '/home/u', PATH: fallback })
  await run.ready()
  await run.ready()
  expect(d.capture).toHaveBeenCalledTimes(1)
  expect(run.env()).toEqual({ HOME: '/home/u', PATH: '/nvm/bin:/usr/bin' })
})

test('createRunEnv does not resolve until asked', () => {
  const d = deps(async () => '\n__CB__/a')
  createRunEnv({ ...d, base: {} })
  expect(d.capture).not.toHaveBeenCalled()
})

test('createRunEnv keeps the process PATH when resolution fails', async () => {
  const run = createRunEnv({
    platform,
    capture: async () => {
      throw new Error('x')
    },
    base: { PATH: fallback }
  })
  await run.ready()
  expect(run.env().PATH).toBe(fallback)
})

test('spawnCapture returns stdout, rejects on timeout and on oversize output', async () => {
  const node = process.execPath
  expect(await spawnCapture(node, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 5000, maxBytes: 1024 })).toBe('hi')
  const t = Date.now()
  await expect(spawnCapture(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150, maxBytes: 1024 })).rejects.toThrow()
  expect(Date.now() - t).toBeLessThan(3000)
  await expect(spawnCapture(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { timeoutMs: 5000, maxBytes: 100 })).rejects.toThrow()
})

test('spawnCapture does not wait for stdin', async () => {
  const out = await spawnCapture(process.execPath, ['-e', 'process.stdin.on("end",()=>process.stdout.write("eof")).resume()'], {
    timeoutMs: 5000,
    maxBytes: 100
  })
  expect(out).toBe('eof')
})

test('the run env never carries the local secret or ELECTRON_RUN_AS_NODE', async () => {
  const base = { HOME: '/h', PATH: fallback, ZUMIBOT_LOCAL_SECRET: 'x'.repeat(64), ELECTRON_RUN_AS_NODE: '1' }
  const run = createRunEnv({ capture: async () => '\n__CB__/a:/b', base, platform })
  expect(run.env()).toEqual({ HOME: '/h', PATH: fallback })
  await run.ready()
  expect(run.env()).toEqual({ HOME: '/h', PATH: '/a:/b' })
  expect(base.ZUMIBOT_LOCAL_SECRET).toBeDefined() // the caller's object is not mutated
})

test('the run env drops the NODE_ENV the server inherited (agent npm install must keep devDependencies)', async () => {
  const base = { HOME: '/h', PATH: fallback, NODE_ENV: 'production' }
  const run = createRunEnv({ capture: async () => '\n__CB__/a:/b', base, platform })
  expect(run.env()).toEqual({ HOME: '/h', PATH: fallback })
  await run.ready()
  expect(run.env()).toEqual({ HOME: '/h', PATH: '/a:/b' })
  expect(base.NODE_ENV).toBe('production')
})
