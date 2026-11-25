import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { statusOf } from '@zumibot/shared/todos'
import { bridgeRefusal } from '@zumibot/shared/engine'
import type { AgentSummary, ChatMeta, ChatPush } from '@zumibot/shared/types'
import { AttachmentStore } from '../../../src/core/attachments/attachmentStore'
import { ChatStore } from '../../../src/core/store/chatStore'
import { TodoService } from '../../../src/core/todos/todoService'
import { AttemptSets, attemptTurnEnded } from '../../../src/core/attempts/attemptSets'
import { attemptMessage } from '../../../src/core/attempts/attemptPrompt'
import { WorktreeService } from '../../../src/core/git/worktrees'
import { makeGit } from '../../../src/core/git/git'
import { isolatedGitEnv } from '../../support/gitEnv'

// The user's own git config must never leak into these repos.
const env = isolatedGitEnv
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' })
const exists = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false
  )

let dir: string
let repo: string
let store: ChatStore
let files: AttachmentStore
let todos: TodoService
let worktrees: WorktreeService
let sets: AttemptSets
let clock: number
let ids: number
let submitted: { chatId: string; text: string; staged: string[] }[]
let stopped: string[]
let archived: string[]
let archiveFails: Record<string, string>
let running: Set<string>
let pushes: ChatPush[]

const agent = (name: string, o: Partial<AgentSummary> = {}): AgentSummary => ({
  name,
  filePath: `/a/${name}.md`,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...o
})
let agents: AgentSummary[]

const card = async (text: string, folder: string | null): Promise<string> => {
  await todos.userAdd(text, null)
  const id = (await todos.board()).open.at(-1)!.id
  if (folder) await todos.userAssign(id, 'alpha', folder)
  return id
}
const itemOf = async (id: string) => (await todos.board()).open.find((i) => i.id === id)!

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-attempts-')))
  repo = join(dir, 'repo')
  await fs.mkdir(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@example.com')
  sh(repo, 'config', 'user.name', 'T')
  await fs.writeFile(join(repo, 'a.txt'), 'a\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'init')

  clock = 1000
  ids = 0
  submitted = []
  stopped = []
  archived = []
  archiveFails = {}
  running = new Set()
  pushes = []
  agents = [
    agent('alpha'),
    agent('beta', { provider: 'codex' }),
    agent('broken', { error: 'bad frontmatter' }),
    agent('gem', { provider: 'acp' })
  ]
  store = new ChatStore(join(dir, 'data'))
  files = new AttachmentStore(join(dir, 'attachments'), () => `f${++ids}`)
  todos = new TodoService({ store, files, now: () => ++clock, newId: () => `t${++ids}`, onChanged: () => {} })
  worktrees = new WorktreeService({
    git: makeGit(env),
    store: { list: () => store.list(), patchInPlace: (id, fn) => store.patchInPlace(id, fn) },
    push: () => {},
    hex: () => `${++ids}`.padStart(6, '0'),
    log: () => {}
  })
  sets = new AttemptSets({
    store,
    todos,
    files,
    submit: async (chatId, text, staged) => void submitted.push({ chatId, text, staged }),
    running: (id) => running.has(id),
    stop: (id) => stopped.push(id),
    agents: async () => agents,
    engineOf: (name, list) => list.find((a) => a.name === name)?.provider ?? 'claude',
    isolatedTop: async (d) => (d === repo ? repo : null),
    headOf: (d) => worktrees.headOf(d),
    worktree: (d, slug, at) => worktrees.create(d, slug, at === null ? {} : { at }),
    archive: async (id) => {
      const why = archiveFails[id]
      if (why) throw new Error(why)
      archived.push(id)
    },
    isFolder: (p) => exists(p),
    push: (p) => pushes.push(p),
    now: () => ++clock,
    newId: () => `s${++ids}`
  })
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('AttemptSets.start', () => {
  it('makes a chat and a worktree per attempt, all from one base commit, and sends each the card', async () => {
    const id = await card('Fix the sum', repo)
    const r = await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }, { agent: 'alpha' }])
    expect(r).toEqual({ started: 3, problems: [] })
    const item = await itemOf(id)
    const set = item.attempts!
    expect(statusOf(item)).toBe('progress')
    expect(set.base).toBe(sh(repo, 'rev-parse', 'HEAD').trim())
    expect(set.folder).toBe(repo)
    expect(set.attempts.map((a) => [a.n, a.agent, a.engine])).toEqual([
      [1, 'alpha', 'claude'],
      [2, 'beta', 'codex'],
      [3, 'alpha', 'claude']
    ])
    // Each attempt is its own worktree on its own branch, and every one starts at the set's base.
    const chats = await Promise.all(set.attempts.map((a) => store.get(a.chatId)))
    const roots = chats.map((c) => c!.worktree!.root)
    expect(new Set(roots).size).toBe(3)
    for (const c of chats) {
      expect(c!.worktree!.base).toBe(set.base)
      expect(await exists(c!.worktree!.root)).toBe(true)
      expect(sh(c!.worktree!.root, 'rev-parse', 'HEAD').trim()).toBe(set.base)
      expect(c!.attempt).toEqual({ todoId: id, setId: set.id, n: c!.attempt!.n })
    }
    // Every attempt is told which of how many it is, and never to use the card tools.
    expect(submitted.map((s) => s.chatId)).toEqual(set.attempts.map((a) => a.chatId))
    expect(submitted[1].text).toBe(attemptMessage({ text: 'Fix the sum' }, { n: 2, total: 3 }))
    expect(submitted[0].text).toContain('attempt 1 of 3')
    expect(submitted[0].text).toContain('Do not call the task-card tools')
  })

  it('keeps the set and the card together: the title names the agent and its place', async () => {
    const id = await card('Fix the sum', repo)
    await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }])
    const set = (await itemOf(id)).attempts!
    const titles = await Promise.all(set.attempts.map(async (a) => (await store.get(a.chatId))!.title))
    expect(titles).toEqual(['Fix the sum · alpha #1', 'Fix the sum · beta #2'])
  })

  it('starts every attempt it can and names the ones it could not, rather than rolling back', async () => {
    const id = await card('Fix the sum', repo)
    const fail = vi.spyOn(worktrees, 'create')
    let n = 0
    fail.mockImplementation(((d: string, slug: string, o: { at?: string }) => {
      n += 1
      return n === 2
        ? Promise.reject(new Error('fatal: could not create worktree'))
        : WorktreeService.prototype.create.call(worktrees, d, slug, o)
    }) as typeof worktrees.create)
    const r = await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }, { agent: 'alpha' }])
    expect(r.started).toBe(2)
    expect(r.problems).toEqual([{ agent: 'beta', why: 'fatal: could not create worktree' }])
    const set = (await itemOf(id)).attempts!
    expect(set.attempts.map((a) => a.n)).toEqual([1, 3]) // the place each was picked at, so the rows read as asked for
    expect(set.failed).toEqual([{ agent: 'beta', why: 'fatal: could not create worktree' }])
    // The count they are told is how many really started.
    expect(submitted[0].text).toContain('attempt 1 of 2')
  })

  it('refuses a folder that does not isolate, since attempts must not share files', async () => {
    const plain = join(dir, 'plain')
    await fs.mkdir(plain)
    const id = await card('Fix the sum', plain)
    await expect(sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }])).rejects.toThrow(/Isolate in worktree/)
    expect((await itemOf(id)).attempts).toBeUndefined()
  })

  it('takes the folder from the dialog when the card has none, and refuses one that is not there', async () => {
    const id = await card('Fix the sum', null)
    await expect(sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }])).rejects.toThrow(/Pick the folder/)
    await expect(sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }], join(dir, 'nope'))).rejects.toThrow('Folder not found')
    const r = await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }], repo)
    expect(r.started).toBe(2)
  })

  it('checks the picks before it makes anything', async () => {
    const id = await card('Fix the sum', repo)
    await expect(sets.start(id, [{ agent: 'alpha' }])).rejects.toThrow(/2 to 5/)
    await expect(sets.start(id, [{ agent: 'alpha' }, { agent: 'nope' }])).rejects.toThrow('No agent named nope')
    await expect(sets.start(id, [{ agent: 'alpha' }, { agent: 'broken' }])).rejects.toThrow(/cannot load/)
    expect(await store.list()).toHaveLength(0)
  })

  it('refuses a pick whose engine has no bridges (an attempt is a task chat), naming it, before it makes anything', async () => {
    const id = await card('Fix the sum', repo)
    await expect(sets.start(id, [{ agent: 'alpha' }, { agent: 'gem' }])).rejects.toThrow(bridgeRefusal('acp', 'gem'))
    expect(await store.list()).toHaveLength(0)
    expect((await itemOf(id)).attempts).toBeUndefined()
  })

  it('refuses a card an agent already works on, and a second set', async () => {
    const id = await card('Fix the sum', repo)
    await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }])
    await expect(sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }])).rejects.toThrow(/already has attempts/)
  })
})

describe('AttemptSets.keep', () => {
  const started = async (): Promise<{ id: string; chats: string[] }> => {
    const id = await card('Fix the sum', repo)
    await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }, { agent: 'alpha' }])
    return { id, chats: (await itemOf(id)).attempts!.attempts.map((a) => a.chatId) }
  }

  it('gives the card to the winner and archives the others through the ordinary path', async () => {
    const { id, chats } = await started()
    const r = await sets.keep(id, chats[1])
    expect(r).toEqual({ kept: chats[1], problems: [] })
    expect(archived).toEqual([chats[0], chats[2]])
    const item = await itemOf(id)
    expect(item.assignee).toBe('beta')
    expect(item.task?.chatId).toBe(chats[1])
    expect(statusOf(item)).toBe('review')
    expect(item.attempts?.winner).toBe(chats[1])
  })

  it('stops an attempt that still runs before archiving it, and never touches the winner', async () => {
    const { id, chats } = await started()
    running.add(chats[0])
    running.add(chats[1])
    await sets.keep(id, chats[1])
    expect(stopped).toEqual([chats[0]])
    expect(archived).not.toContain(chats[1])
  })

  it('names an attempt whose archive refused, and leaves it, rather than forcing anything', async () => {
    const { id, chats } = await started()
    archiveFails[chats[2]] = 'This chat is running. Stop it first.'
    const r = await sets.keep(id, chats[0])
    expect(r.problems).toEqual([{ agent: 'alpha', why: 'This chat is running. Stop it first.' }])
    expect(archived).toEqual([chats[1]])
    // The card still went to the winner: one folder that would not go is not a reason to undo the decision.
    expect((await itemOf(id)).task?.chatId).toBe(chats[0])
  })

  it('refuses a chat that is not one of the set', async () => {
    const { id } = await started()
    await expect(sets.keep(id, 'not-a-chat')).rejects.toThrow(/not one of/)
  })
})

describe('AttemptSets.cancel', () => {
  it('drops the set, stops what runs, and leaves the chats and their worktrees', async () => {
    const id = await card('Fix the sum', repo)
    await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }])
    const chats = (await itemOf(id)).attempts!.attempts.map((a) => a.chatId)
    running.add(chats[0])
    await sets.cancel(id)
    const item = await itemOf(id)
    expect(item.attempts).toBeUndefined()
    expect(statusOf(item)).toBe('new')
    expect(stopped).toEqual([chats[0]])
    expect(archived).toEqual([])
    for (const c of chats) {
      const meta = await store.get(c)
      expect(meta).not.toBeNull()
      expect(await exists(meta!.worktree!.root)).toBe(true)
    }
  })
})

describe('attemptTurnEnded', () => {
  it("stores the outcome on the attempt's own chat and leaves any other chat alone", async () => {
    const id = await card('Fix the sum', repo)
    await sets.start(id, [{ agent: 'alpha' }, { agent: 'beta' }])
    const [a] = (await itemOf(id)).attempts!.attempts
    const plain = await store.create('alpha', repo)
    pushes = []
    attemptTurnEnded({ store, push: (p) => pushes.push(p) }, { chatId: a.chatId, outcome: 'error' })
    attemptTurnEnded({ store, push: (p) => pushes.push(p) }, { chatId: plain.id, outcome: 'ok' })
    await vi.waitFor(async () => expect((await store.get(a.chatId))!.attempt?.outcome).toBe('error'))
    expect((await store.get(plain.id))!.attempt).toBeUndefined()
    expect(pushes.map((p) => p.chatId)).toEqual([a.chatId])
  })
})
