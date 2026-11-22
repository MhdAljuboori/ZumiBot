import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultBash } from '../../zumi-bot-server/backend/src/core/procKill'
import { writeFakeBin } from '../../zumi-bot-server/backend/tests/support/fakeBin'
import { startLocalServer } from '../src/main/localServer'
import {
  createStdioControl,
  NO_ENTRY_EXIT,
  NO_NODE_EXIT,
  OLD_NODE_EXIT,
  WSL_ENTRY_ENV,
  WSL_SCRIPT,
  WSL_SCRIPT_ENV,
  wslLaunch,
  wslStartError
} from '../src/main/wslLaunch'

describe('wslLaunch', () => {
  it('runs bash in WSL with the script in env and forwards only the server variables', () => {
    const l = wslLaunch('C:\\ZumiBot\\resources\\server\\server.mjs', {
      PATH: 'x',
      WSLENV: 'FOO/u',
      ZUMIBOT_MODE: 'local',
      ZUMIBOT_LOCAL_SECRET: 's',
      ZUMIBOT_PORT: '4318',
      HOME: 'h'
    })
    expect(l.command).toBe('wsl.exe')
    expect(l.args).toEqual(['--exec', 'bash', '-lic', `source <(printenv ${WSL_SCRIPT_ENV})`])
    expect(l.args.join(' ')).not.toContain('"') // nothing for Windows' argv quoting to get wrong
    expect(l.env[WSL_SCRIPT_ENV]).toBe(WSL_SCRIPT)
    expect(l.env[WSL_ENTRY_ENV]).toBe('C:\\ZumiBot\\resources\\server\\server.mjs')
    expect(l.env['WSLENV']).toBe(
      `FOO/u:ZUMIBOT_MODE/u:ZUMIBOT_LOCAL_SECRET/u:ZUMIBOT_PORT/u:ZUMIBOT_STDIN_CONTROL/u:${WSL_SCRIPT_ENV}/u:${WSL_ENTRY_ENV}/p`
    )
    expect(l.env['WSLENV']).not.toMatch(/PATH|HOME/)
  })

  it('translates the updates folder to a WSL path when the app keeps one', () => {
    const l = wslLaunch('C:\\s.mjs', { ZUMIBOT_LOCAL_UPDATES: 'C:\\Users\\me\\AppData\\Roaming\\ZumiBot\\server-updates' })
    expect(l.env['WSLENV']).toMatch(/:ZUMIBOT_LOCAL_UPDATES\/p$/)
  })

  it('names what is missing for each launch failure', () => {
    expect(wslStartError(null, Object.assign(new Error('x'), { code: 'ENOENT' }))).toMatch(/WSL is not installed.*wsl --install/)
    expect(wslStartError(NO_NODE_EXIT)).toMatch(/Node.js is not installed in WSL/)
    expect(wslStartError(OLD_NODE_EXIT)).toMatch(/too old.*22/)
    expect(wslStartError(NO_ENTRY_EXIT)).toMatch(/cannot read/)
    expect(wslStartError(1)).toMatch(/exited \(code 1\)/)
  })
})

describe('createStdioControl', () => {
  it('matches replies to questions per kind and times out', async () => {
    const sent: string[] = []
    const c = createStdioControl((l) => sent.push(l) > 0)
    const b = c.ask('busy')
    const p = c.ask('processes')
    expect(c.onLine('CONTROL processes 4')).toBe(true)
    expect(c.onLine('CONTROL busy 1')).toBe(true)
    expect(c.onLine('something else')).toBe(false)
    await expect(b).resolves.toBe(1)
    await expect(p).resolves.toBe(4)
    expect(sent).toEqual(['busy\n', 'processes\n'])
    const e = c.ask('busy')
    c.onLine('CONTROL busy error')
    await expect(e).rejects.toThrow()
    await expect(c.ask('busy', 10)).rejects.toThrow(/timed out/)
    const gone = c.ask('busy')
    c.close()
    await expect(gone).rejects.toThrow(/gone/)
    await expect(c.ask('busy')).rejects.toThrow(/gone/)
  })
})

// A stand-in wsl.exe that runs the real launch script with this machine's bash and node.
describe('startLocalServer in WSL mode', () => {
  let dir: string
  let path: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-wsl-'))
    if (process.platform === 'win32') {
      // Windows spawns only real exes: a launcher runs Git Bash with the script (wsl.exe's own args land in $0...).
      writeFakeBin(dir, 'wsl', null, { program: defaultBash(), args: ['-c', `eval "$(printenv ${WSL_SCRIPT_ENV})"`] })
    } else {
      const fake = join(dir, 'wsl.exe')
      writeFileSync(fake, `#!/bin/sh\nexec bash -c "$(printenv ${WSL_SCRIPT_ENV})"\n`)
      chmodSync(fake, 0o755)
    }
    path = process.env['PATH']
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${dir}${delimiter}${path}` })

  it('starts, answers busy over stdio and stops when stdin ends', async () => {
    const entry = join(dir, 'server.mjs')
    writeFileSync(
      entry,
      `import { createInterface } from 'node:readline'
       if (process.env.ZUMIBOT_STDIN_CONTROL !== '1') process.exit(9)
       console.log('LISTENING 4318')
       const rl = createInterface({ input: process.stdin })
       rl.on('line', (l) => console.log(l === 'busy' ? 'CONTROL busy 2' : 'CONTROL processes 5'))
       rl.on('close', () => process.exit(0))`
    )
    let exits = 0
    const s = await startLocalServer({ node: 'unused', entry, env: env(), wsl: true, onExit: () => exits++ })
    expect(s.origin).toBe('http://127.0.0.1:4318')
    expect(await s.busy()).toBe(2)
    expect(await s.processes()).toBe(5)
    await s.stop()
    expect(exits).toBe(0)
  })

  it('says the server files cannot be read when the entry is missing', async () => {
    await expect(startLocalServer({ node: 'unused', entry: join(dir, 'nope.mjs'), env: env(), wsl: true })).rejects.toThrow(
      /cannot read ZumiBot's server files/
    )
  })
})
