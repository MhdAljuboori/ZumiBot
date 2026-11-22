import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { attemptTitle, picksError, startBlocked } from '@zumibot/shared/attempts'
import { TODO_FILES, type TodoAttempt, type TodoAttempts, type TodoItem } from '@zumibot/shared/todos'
import { bridgeRefusal, engineCaps, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { AgentSummary, AttemptsResult, ChatMeta, ChatPush, ChatWorktree } from '@zumibot/shared/types'
import type { AttachmentStore } from '../attachments/attachmentStore'
import type { ChatStore } from '../store/chatStore'
import type { TodoService } from '../todos/todoService'
import { attemptMessage } from './attemptPrompt'

export interface AttemptSetsDeps {
  store: Pick<ChatStore, 'get' | 'list' | 'create' | 'patchInPlace'>
  todos: Pick<TodoService, 'card' | 'userStartAttempts' | 'userKeepAttempt' | 'userDropAttempts'>
  files: Pick<AttachmentStore, 'pathOf' | 'stagePath'>
  /** The user's message into a chat, through the queue. Resolves when its turn ends, so it is never awaited here. */
  submit(chatId: string, text: string, stagedIds: string[]): Promise<unknown>
  running(chatId: string): boolean
  stop(chatId: string): void
  agents(): Promise<AgentSummary[]>
  /** The engine an agent runs on, so a row can show it without reading the agent file again. */
  engineOf(agent: string, agents: readonly AgentSummary[]): Engine
  /** What each engine can do (default engineCaps): an attempt is a task chat, so it needs an engine with `bridges`. */
  caps?(engine: Engine): EngineCaps
  /** The repo top of a folder whose "Isolate in worktree" toggle is on, else null: attempts need a worktree each. */
  isolatedTop(dir: string): Promise<string | null>
  /** The commit a folder is on now; every attempt's worktree starts there, so the diffs compare. */
  headOf(dir: string): Promise<string | null>
  /** One worktree for one attempt, made from `at`. */
  worktree(dir: string, slugBase: string, at: string | null): Promise<{ cwd: string; worktree: ChatWorktree }>
  /** Archives a chat as the sidebar's Archive does, release included; the reason it refuses is the caller's to report. */
  archive(chatId: string): Promise<void>
  isFolder(path: string): Promise<boolean>
  push(p: ChatPush): void
  now(): number
  newId(): string
}

const TITLE_MAX = 80
const titleOf = (text: string): string => [...text].slice(0, TITLE_MAX).join('').trim()

/** The card as every attempt was given it, kept on the set so the rows can show what was asked. */
const cardText = (item: TodoItem): string => (item.description ? `${item.text}\n\n${item.description}` : item.text)

const why = (e: unknown): string => (e instanceof Error ? e.message : 'failed')

// Only the code: a submit error can carry a path, and the message the user typed never goes to a log.
const logged =
  (what: string) =>
  (e: unknown): void => {
    const code = (e as { code?: unknown } | null)?.code
    if (e instanceof Error && e.message.startsWith('Chat not found')) return // deleted meanwhile: nothing to send to
    console.error(what, typeof code === 'string' ? code : e instanceof Error ? e.message.slice(0, 120) : 'error')
  }

/**
 * Parallel attempts: 2 to 5 agents given one card at once, each in its own chat and its own worktree from one base
 * commit, so their diffs compare. The card keeps no single task chat until the user keeps one; until then nothing but
 * the user moves it. See docs/architecture/review-loop.md.
 */
export class AttemptSets {
  constructor(private readonly d: AttemptSetsDeps) {}

  /**
   * Starts a set. Every attempt is placed in order; one that cannot be placed is reported and the rest still run, since
   * a worktree already made is work the user may want. Nothing is rolled back.
   */
  async start(todoId: string, picks: { agent: string }[], folderArg: string | null = null): Promise<AttemptsResult> {
    const { d } = this
    const item = await d.todos.card(todoId)
    const blocked = startBlocked(item)
    if (blocked) throw new Error(blocked)
    const agents = await d.agents()
    const bad = picksError(picks, agents)
    if (bad) throw new Error(bad)
    if (picks.some((p) => p.agent === ZUMI_BOT_NAME)) throw new Error('Zumi Bot cannot take a task card')
    for (const p of picks) {
      const engine = d.engineOf(p.agent, agents)
      if (!(d.caps ?? engineCaps)(engine).bridges) throw new Error(bridgeRefusal(engine, p.agent))
    }
    // The card's own folder when it has one (it was assigned once), else the one the dialog offered.
    const folder = item.folder ?? folderArg
    if (!folder) throw new Error('Pick the folder its chats run in first.')
    if (!(await d.isFolder(folder))) throw new Error('Folder not found')
    // Attempts must not edit each other's files, so the folder's worktree toggle has to be on.
    if (!(await d.isolatedTop(folder))) {
      throw new Error('Attempts need a worktree each. Turn "Isolate in worktree" on for this folder, then run them again.')
    }
    // One base for the whole set, read once: every worktree starts there, so the diffs compare.
    const base = await d.headOf(folder)
    const made: { attempt: TodoAttempt; staged: string[] }[] = []
    const problems: { agent: string; why: string }[] = []
    for (const [i, pick] of picks.entries()) {
      try {
        made.push(await this.one(item, pick.agent, i + 1, folder, base, agents))
      } catch (e) {
        problems.push({ agent: pick.agent, why: why(e) })
      }
    }
    if (made.length === 0) throw new Error(problems[0]?.why ?? 'No attempt could be started.')
    const attempts = made.map((m) => m.attempt)
    const set: TodoAttempts = {
      id: d.newId(),
      at: d.now(),
      base,
      folder,
      prompt: cardText(item),
      attempts,
      ...(problems.length > 0 ? { failed: problems } : {})
    }
    await d.todos.userStartAttempts(todoId, set)
    // After the card holds the set: each chat's meta names it, so a row knows which set it belongs to from either side.
    for (const a of attempts) {
      const meta = await d.store.patchInPlace(a.chatId, () => ({ attempt: { todoId, setId: set.id, n: a.n } }))
      if (meta) d.push({ chatId: a.chatId, kind: 'meta', meta })
    }
    // Not awaited: a submit resolves when its turn ends. The rows follow the chats from here. The count each attempt is
    // told is how many really started, not how many were picked.
    for (const m of made) {
      void d
        .submit(m.attempt.chatId, attemptMessage(item, { n: m.attempt.n, total: attempts.length }), m.staged)
        .catch(logged('starting an attempt failed:'))
    }
    return { started: attempts.length, problems }
  }

  /** One attempt: its own worktree from the set's base, its own chat, and copies of the card's files staged for it. */
  private async one(
    item: TodoItem,
    agent: string,
    n: number,
    folder: string,
    base: string | null,
    agents: readonly AgentSummary[]
  ): Promise<{ attempt: TodoAttempt; staged: string[] }> {
    const { d } = this
    const place = await d.worktree(folder, agent, base)
    const meta = await d.store.create(agent, place.cwd, { title: attemptTitle(titleOf(item.text), { agent, n }), worktree: place.worktree })
    d.push({ chatId: meta.id, kind: 'meta', meta })
    // Copies, so the card and each chat keep their own; a file gone from the card is skipped.
    const staged: string[] = []
    for (const f of item.files ?? []) {
      const r = await d.files.stagePath(d.files.pathOf(TODO_FILES, f))
      if (r.ok) staged.push(r.attachment.id)
    }
    return { attempt: { n, agent, engine: d.engineOf(agent, agents), chatId: meta.id }, staged }
  }

  /**
   * The user keeps one: the card goes to that agent with its chat, moves to In review, and every other attempt's chat
   * is archived through the ordinary path — so a worktree release that refuses a dirty folder says so and nothing is
   * forced.
   */
  async keep(todoId: string, chatId: string): Promise<AttemptsResult> {
    const { d } = this
    const r = await d.todos.userKeepAttempt(todoId, chatId)
    const problems: { agent: string; why: string }[] = []
    for (const other of r.others) {
      if (d.running(other.chatId)) d.stop(other.chatId)
      try {
        await d.archive(other.chatId)
      } catch (e) {
        problems.push({ agent: other.agent, why: why(e) })
      }
    }
    // Release runs in the background, so a kept folder shows on the chat itself (its archived note), not here.
    return { kept: chatId, problems }
  }

  /** The set is dropped without a winner: what runs is stopped, the chats and their worktrees stay. */
  async cancel(todoId: string): Promise<void> {
    const r = await this.d.todos.userDropAttempts(todoId)
    for (const a of r.dropped) if (this.d.running(a.chatId)) this.d.stop(a.chatId)
  }
}

/**
 * A turn ended: in an attempt's chat its outcome goes on that chat's own meta, so a row can tell a finished attempt
 * from a failed one. Wired beside the other turn-end hooks in `app.ts`, since it needs no set. In place, so the
 * sidebar order does not move. Never throws; a failed write only logs its code, never the chat's text.
 */
export function attemptTurnEnded(
  d: { store: Pick<ChatStore, 'get' | 'patchInPlace'>; push(p: ChatPush): void },
  e: { chatId: string; outcome: 'ok' | 'error' | 'stopped' }
): void {
  void (async () => {
    if (!(await d.store.get(e.chatId))?.attempt) return
    const next = await d.store.patchInPlace(e.chatId, (cur) => (cur.attempt ? { attempt: { ...cur.attempt, outcome: e.outcome } } : null))
    if (next) d.push({ chatId: e.chatId, kind: 'meta', meta: next })
  })().catch((err) => {
    const code = (err as { code?: unknown } | null)?.code
    console.error('attempt outcome not stored:', typeof code === 'string' ? code : 'error')
  })
}
