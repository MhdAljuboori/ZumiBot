import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { buildsToPrune, downloadedEntry, forgetBuild, pickServer, pruneBuilds } from '../src/main/serverPick'

const BUNDLED = '/opt/ZumiBot/resources/server/server.mjs'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), 'zumibot-builds-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A downloaded build as the server unpacks it, optionally named in current.json. */
const build = (v: string, current = true): void => {
  mkdirSync(join(dir, `v${v}`, 'zumibot-server', 'app'), { recursive: true })
  writeFileSync(downloadedEntry(dir, v), '')
  if (current) writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: v }))
}
const pick = (bundledVersion = '0.1.0') => pickServer({ bundledEntry: BUNDLED, bundledVersion, dir })

describe('pickServer', () => {
  it('runs the downloaded build current.json names when it is newer than the bundled one', () => {
    build('0.2.0')
    expect(pick()).toEqual({ entry: downloadedEntry(dir, '0.2.0'), version: '0.2.0', downloaded: true })
  })

  it('runs the bundled build when the download is not newer: a newer desktop install wins', () => {
    build('0.2.0')
    expect(pick('0.2.0')).toEqual({ entry: BUNDLED, version: '0.2.0', downloaded: false })
    expect(pick('0.3.0').downloaded).toBe(false)
  })

  it('runs the bundled build when current.json is missing, damaged, or names a build that is not there', () => {
    expect(pick().downloaded).toBe(false)
    writeFileSync(join(dir, 'current.json'), '{not json')
    expect(pick().downloaded).toBe(false)
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: '../../etc' }))
    expect(pick().downloaded).toBe(false)
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: '0.2.0' }))
    expect(pick().downloaded).toBe(false)
  })

  it('runs the bundled build with no builds folder (a development run)', () => {
    expect(pickServer({ bundledEntry: BUNDLED, bundledVersion: '0.1.0', dir: null })).toEqual({ entry: BUNDLED, version: '0.1.0', downloaded: false })
  })
})

describe('pruning', () => {
  it('keeps only the build that runs, and touches nothing that is not a build folder', () => {
    expect(buildsToPrune(['v0.1.5', 'v0.2.0', 'current.json', 'downloads', 'v0.2.0.staging', 'notes'], '0.2.0')).toEqual(['v0.1.5'])
    expect(buildsToPrune(['v0.1.5', 'v0.2.0'], null)).toEqual(['v0.1.5', 'v0.2.0'])
  })

  it('with the bundled build running, every download goes and so does current.json', () => {
    build('0.1.5', false)
    build('0.2.0')
    pruneBuilds(dir, null)
    expect(readdirSync(dir)).toEqual([])
  })

  it('with a download running, the others go and current.json stays', () => {
    build('0.1.5', false)
    build('0.2.0')
    pruneBuilds(dir, '0.2.0')
    expect(readdirSync(dir).sort()).toEqual(['current.json', 'v0.2.0'])
  })

  it('a missing folder is not an error', () => {
    expect(() => pruneBuilds(join(dir, 'nope'), null)).not.toThrow()
  })
})

describe('forgetBuild', () => {
  it('drops the build and current.json, so the next pick is the bundled one, and says why in the update log', () => {
    build('0.2.0')
    const log = join(dir, 'data', 'update-log.txt')
    forgetBuild(dir, '0.2.0', log, 'The local server exited (code 1) before it was ready\nSyntaxError: x')
    expect(existsSync(join(dir, 'v0.2.0'))).toBe(false)
    expect(pick().downloaded).toBe(false)
    const text = readFileSync(log, 'utf8')
    expect(text).toContain('ZumiBot v0.2.0 did not start')
    expect(text).toContain('SyntaxError: x')
  })
})
