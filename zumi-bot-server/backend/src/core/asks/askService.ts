import { ASK_MAX_HOPS, ASK_PARALLEL, ASK_PER_TURN, ASK_REPLY_MAX, askedTitle, findAskTarget } from '@zumibot/shared/agentAsk'
import { SIDE_LIMIT_TEXT, SIDE_TIMEOUT_TEXT, type SideQuestion } from '@zumibot/shared/btw'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { capRefusal, engineCaps, engineOfAgent, isRemoteAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { AgentSummary, ChatPush } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'
import type { AskCall, AskOwner, SideAskCall } from './askIpc'
import { REFUSAL } from './askPrompt'

/** A refusal's message is a fixed sentence the asking agent may read; nothing else ever goes in one. */
export class AskRefusal extends Error {}

export type AskedOutcome =
  | { kind: 'ok'; reply: string | null }
  | { kind: 'busy' }
  | { kind: 'stopped' }
  | { kind: 'limited'; resetsAt: number | null }
  | { kind: 'error' }

export interface AgentAsksDeps {
  agents(): Promise<AgentSummary[]>
  chats: Pick<ChatStore, 'list' | 'get' | 'create' | 'update'>
  run(
    chatId: string,
    o: { from: string; message: string; chain: string[]; parent: string; signal: AbortSignal; auto?: true }
  ): Promise<AskedOutcome>
  push(p: ChatPush): void
  side(
    chatId: string,
    o: { question: string; from: string; link: { chatId: string; entryId: string } | null; signal: AbortSignal }
  ): Promise<SideQuestion>
  /** What each engine can do (default engineCaps): a side question to an engine whose side questions are off is refused. */
  caps?(engine: Engine): EngineCaps
}

interface TurnCount {
  asks: number
  running: number
}

/** Runs B for an `ask` call of A: checks the limits, finds or makes the A to B chat, runs one turn in it and turns the outcome into the tool's answer. */
export class AgentAsks {
  private readonly turns = new Map<string, TurnCount>()
  // Two asks to the same agent that start together must find one chat, not make two.
  private readonly making = new Map<string, Promise<string>>()
  private closed = false

  constructor(private readonly d: AgentAsksDeps) {}

  async ask(owner: AskOwner, call: AskCall, signal: AbortSignal): Promise<string> {
    // A side run may only side-question: a full ask from it would start work from an answer that must not change anything.
    if (owner.side) throw new AskRefusal(REFUSAL.sideRunAsk)
    const all = await this.d.agents()
    const caller = owner.agent()
    const target = this.targetOf(all, caller, call.agent)
    if (owner.chain.includes(target.name)) throw new AskRefusal(REFUSAL.inChain(target.name))
    if (owner.chain.length >= ASK_MAX_HOPS) throw new AskRefusal(REFUSAL.tooDeep)
    this.mustLoad(target)
    const count = this.claim(owner)

    let outcome: AskedOutcome
    try {
      const chatId = await this.chatFor(owner, caller, target.name)
      outcome = await this.d.run(chatId, {
        from: caller,
        message: call.message,
        chain: [...owner.chain, caller],
        parent: owner.chatId,
        signal,
        ...(owner.auto ? { auto: true as const } : {})
      })
    } catch (error) {
      if (error instanceof AskRefusal) throw error
      // The thrown text never reaches the agent: it may name a path.
      if (signal.aborted) throw new AskRefusal(REFUSAL.stopped(target.name))
      const now = findAskTarget(await this.d.agents().catch(() => all), target.name)
      throw new AskRefusal(now === null || now.error !== null ? REFUSAL.broken(target.name) : REFUSAL.failed(target.name))
    } finally {
      count.running--
    }
    switch (outcome.kind) {
      case 'ok':
        if (outcome.reply === null || outcome.reply === '') return REFUSAL.noText(target.name)
        return outcome.reply.length > ASK_REPLY_MAX ? outcome.reply.slice(0, ASK_REPLY_MAX) + REFUSAL.cut : outcome.reply
      case 'busy':
        throw new AskRefusal(REFUSAL.busy(target.name))
      case 'stopped':
        throw new AskRefusal(REFUSAL.stopped(target.name))
      case 'limited':
        throw new AskRefusal(REFUSAL.limited(target.name, outcome.resetsAt))
      case 'error':
        throw new AskRefusal(REFUSAL.failed(target.name))
    }
  }

  /** Asks B a quick side question about the A to B chat this source chat already has, and returns the answer text. Never makes a chat, and hop rules do not apply: B only answers. */
  async sideAsk(owner: AskOwner, call: SideAskCall, signal: AbortSignal): Promise<string> {
    const all = await this.d.agents()
    const caller = owner.agent()
    const target = this.targetOf(all, caller, call.agent)
    this.mustLoad(target)
    // The fixed sentence, not a failed answer, while the target's engine has no side questions (a later probe kept them off).
    const engine = engineOfAgent(target)
    if (!(this.d.caps ?? engineCaps)(engine).btw) throw new AskRefusal(capRefusal(engine, 'btw'))
    const name = target.name
    const chat = (await this.d.chats.list()).find((c) => c.asked?.from === owner.chatId && c.agentName === name)
    if (!chat) throw new AskRefusal(REFUSAL.noConversation(name))
    // askFrom links B's entry before it looks at the signal, so a stale call must never reach it.
    if (signal.aborted) throw new AskRefusal(REFUSAL.sideStopped(name))
    const count = this.claim(owner)

    let entry: SideQuestion
    try {
      entry = await this.d.side(chat.id, { question: call.question, from: caller, link: owner.side ?? null, signal })
    } catch (error) {
      // The thrown text never reaches the agent: it may name a path.
      if (signal.aborted) throw new AskRefusal(REFUSAL.sideStopped(name))
      throw new AskRefusal(error instanceof Error && error.message === SIDE_LIMIT_TEXT ? REFUSAL.sideLimit(name) : REFUSAL.sideFailed(name))
    } finally {
      count.running--
    }
    switch (entry.state) {
      case 'done':
        // A normal result, like `ask`'s noText: the question was answered, with nothing.
        if (entry.answer.trim() === '') return REFUSAL.sideNoText(name)
        return entry.answer.length > ASK_REPLY_MAX ? entry.answer.slice(0, ASK_REPLY_MAX) + REFUSAL.cut : entry.answer
      case 'stopped':
        throw new AskRefusal(REFUSAL.sideStopped(name))
      case 'error':
        throw new AskRefusal(entry.error === SIDE_TIMEOUT_TEXT ? REFUSAL.sideTimeout(name) : REFUSAL.sideFailed(name))
      // askFrom resolves only once the entry has ended.
      default:
        throw new AskRefusal(REFUSAL.sideFailed(name))
    }
  }

  /** The target of a call, shared by ask and sideAsk: unknown, Zumi Bot, the caller itself and a remote agent are refused alike. */
  private targetOf(all: AgentSummary[], caller: string, handle: string): AgentSummary {
    const target = findAskTarget(all, handle)
    // Loadable agents only: a broken one is named as broken, and never offered.
    const handles = all
      .filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME && a.name !== caller && !isRemoteAgent(a, this.d.caps))
      .map((a) => a.name)
      .sort()
    if (!target) throw new AskRefusal(REFUSAL.unknown(handles))
    if (target.name === ZUMI_BOT_NAME) throw new AskRefusal(REFUSAL.zumiBot)
    if (target.name === caller) throw new AskRefusal(REFUSAL.self)
    // The message and the chat would leave this machine, and the user never chose that agent for it.
    if (isRemoteAgent(target, this.d.caps)) throw new AskRefusal(REFUSAL.remote(target.name))
    return target
  }

  private mustLoad(target: AgentSummary): void {
    if (target.error !== null) throw new AskRefusal(REFUSAL.broken(target.name))
  }

  /** Checks the turn's limits and counts one more running call; the caller releases `running`. */
  private claim(owner: AskOwner): TurnCount {
    const count = this.turns.get(owner.turn) ?? { asks: 0, running: 0 }
    if (count.asks >= ASK_PER_TURN) throw new AskRefusal(REFUSAL.perTurn)
    if (count.running >= ASK_PARALLEL) throw new AskRefusal(REFUSAL.parallel)
    if (this.closed) throw new AskRefusal(REFUSAL.stopping)
    // Counted before the first await: asks that start together must all see each other.
    count.asks++
    count.running++
    this.turns.set(owner.turn, count)
    return count
  }

  /** The turn is over: forget its counters. */
  endTurn(turn: string): void {
    this.turns.delete(turn)
  }

  close(): void {
    this.closed = true
  }

  /** The A to B chat for this source chat and agent, made on the first ask; refuses as stopped when the source chat is gone. */
  private chatFor(owner: AskOwner, by: string, name: string): Promise<string> {
    const key = `${owner.chatId}\n${name}`
    const pending = this.making.get(key)
    if (pending) return pending
    const job = (async (): Promise<string> => {
      try {
        return await this.findOrMake(owner, by, name)
      } catch (error) {
        // A store failure names a path; the agent only gets a fixed sentence.
        throw error instanceof AskRefusal ? error : new AskRefusal(REFUSAL.failed(name))
      }
    })()
    this.making.set(key, job)
    const clear = () => {
      if (this.making.get(key) === job) this.making.delete(key)
    }
    job.then(clear, clear)
    return job
  }

  private async findOrMake(owner: AskOwner, by: string, name: string): Promise<string> {
    const existing = (await this.d.chats.list()).find((c) => c.asked?.from === owner.chatId && c.agentName === name)
    if (existing) return existing.id
    const source = await this.d.chats.get(owner.chatId)
    if (!source) throw new AskRefusal(REFUSAL.stopped(name))
    const made = await this.d.chats.create(name, source.cwd)
    const meta = await this.d.chats.update(made.id, {
      asked: { by, from: owner.chatId, fromTitle: source.title, chain: [...owner.chain] },
      title: askedTitle(by, source.title),
      ...(source.worktree ? { worktree: source.worktree } : {})
    })
    this.d.push({ chatId: meta.id, kind: 'meta', meta })
    return meta.id
  }
}
