import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { ChatMeta } from '@zumibot/shared/types'
import type { Routine } from '@zumibot/shared/routines'
import { OLD_BUILT_IN_NAME, migrateOldBuiltIn, type OldBuiltInDeps } from '../../src/core/agents/oldBuiltIn'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-old-built-in-'))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const chat = (patch: Partial<ChatMeta>): ChatMeta => ({
  id: 'c1',
  agentName: 'writer',
  sessionId: null,
  cwd: '/w',
  title: 't',
  createdAt: 1,
  updatedAt: 1,
  inFlight: false,
  ...patch
})

const routine = (target: Routine['target']): Routine => ({ target }) as Routine

function setup(over: Partial<OldBuiltInDeps> = {}) {
  const calls: string[] = []
  const deps: OldBuiltInDeps = {
    agentsDir: tmp,
    chats: async () => [chat({})],
    approvals: () => ['writer'],
    routines: async () => [routine({ kind: 'new-chat', agent: 'writer', cwd: '/w' })],
    rename: async (from, to) => {
      calls.push(`rename ${from} ${to}`)
    },
    trash: async (p) => {
      calls.push(`trash ${p}`)
      await fs.rm(p)
    },
    ...over
  }
  return { deps, calls }
}

const oldFile = (): string => join(tmp, `${OLD_BUILT_IN_NAME}.md`)

describe('migrateOldBuiltIn', () => {
  it('does nothing when no file, chat, approval or routine names the old agent', async () => {
    const { deps, calls } = setup()
    expect(await migrateOldBuiltIn(deps)).toBe(false)
    expect(calls).toEqual([])
  })

  it('renames to Zumi Bot first, then trashes the old file', async () => {
    await fs.writeFile(oldFile(), 'x')
    const { deps, calls } = setup()
    expect(await migrateOldBuiltIn(deps)).toBe(true)
    expect(calls).toEqual([`rename ${OLD_BUILT_IN_NAME} ${ZUMI_BOT_NAME}`, `trash ${oldFile()}`])
  })

  it('keeps the old file when the rename fails, so the next start tries again', async () => {
    await fs.writeFile(oldFile(), 'x')
    const { deps, calls } = setup({
      rename: async () => {
        throw new Error('disk full')
      }
    })
    await expect(migrateOldBuiltIn(deps)).rejects.toThrow('disk full')
    expect(calls).toEqual([])
    await expect(fs.access(oldFile())).resolves.toBeUndefined()
  })

  it.each<[string, Partial<OldBuiltInDeps>]>([
    ['a chat of the old agent', { chats: async () => [chat({ agentName: OLD_BUILT_IN_NAME })] }],
    ['a chat it asked from', { chats: async () => [chat({ asked: { by: OLD_BUILT_IN_NAME, from: 'c0', fromTitle: 't', chain: [] } })] }],
    [
      'a queued command',
      {
        chats: async () => [
          chat({ tasks: [{ id: 'q', text: '/x', ts: 1, command: { agent: OLD_BUILT_IN_NAME, name: 'x', prompt: 'p' } }] })
        ]
      }
    ],
    ['a remembered approval', { approvals: () => ['writer', OLD_BUILT_IN_NAME] }],
    ['a routine', { routines: async () => [routine({ kind: 'new-chat', agent: OLD_BUILT_IN_NAME, cwd: '/w' })] }],
    [
      'a group routine',
      { routines: async () => [routine({ kind: 'new-group', members: ['writer', OLD_BUILT_IN_NAME], role: '', cwd: '/w' })] }
    ]
  ])('renames without a file when %s still names the old agent', async (_what, over) => {
    const { deps, calls } = setup(over)
    expect(await migrateOldBuiltIn(deps)).toBe(true)
    expect(calls).toEqual([`rename ${OLD_BUILT_IN_NAME} ${ZUMI_BOT_NAME}`])
  })
})
