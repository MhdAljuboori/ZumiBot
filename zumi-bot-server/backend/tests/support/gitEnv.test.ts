import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedGitEnv } from './gitEnv'

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
})

// The Claude desktop terminal sets this in every shell it opens, so a test run from there carried it into every repo.
test('config the shell passes through the environment never reaches a test repo', () => {
  process.env.GIT_CONFIG_PARAMETERS = "'safe.bareRepository=explicit' 'core.fsmonitor='"
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'safe.bareRepository'
  process.env.GIT_CONFIG_VALUE_0 = 'explicit'
  const env = isolatedGitEnv()
  expect(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_') && k !== 'GIT_CONFIG_GLOBAL' && k !== 'GIT_CONFIG_NOSYSTEM')).toEqual([])
  expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })

  const dir = mkdtempSync(join(tmpdir(), 'zb-git-env-'))
  try {
    const bare = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { env })
    expect(execFileSync('git', ['rev-parse', '--is-bare-repository'], { cwd: bare, env, encoding: 'utf8' }).trim()).toBe('true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
