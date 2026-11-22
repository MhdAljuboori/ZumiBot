import { basename } from 'node:path'
import { matchAgent } from '@zumibot/shared/agentMatch'
import { displayName } from '@zumibot/shared/agentName'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import {
  CHANNEL_COMMANDS,
  CHANNEL_FILE_MAX,
  CHANNEL_LABELS,
  CHANNEL_TEXT_MAX,
  COMMAND_PREFIX,
  TOKEN_NAMES,
  channelMessageId,
  parseChannelCommand,
  type ChannelCommand,
  type ChannelPlatform,
  type ChannelState,
  type ChannelStatus
} from '@zumibot/shared/channels'
import { SLACK, TELEGRAM, render, splitMessage, tailOf, type Dialect } from '@zumibot/shared/channelText'
import type { FileChange } from '@zumibot/shared/files'
import { channelNotifyText, type ChannelNotifyToggles, type NotifyPayload } from '@zumibot/shared/notify'
import type { NotifyTarget } from '../notify/notifyService'
import {
  NOTICE_TEXT,
  isGroup,
  type AgentSummary,
  type ApprovalDecision,
  type QuestionAnswers,
  type ChatItem,
  type ChatMeta,
  type ChatPush,
  type SendResult,
  type StageResult
} from '@zumibot/shared/types'
import type { ButtonPress, ChannelAdapter, ChannelSink, InboundMessage, OutText } from './adapter'
import { ButtonTokens, type ButtonAction } from './buttons'
import type { OpenStream, PlatformStateView } from './channelState'
import type { ChannelSettings, ChannelStore } from './channelStore'
import type { ChannelToken, ChannelTokens } from './channelTokens'
import { ChannelCards } from './cards'
import { Pairing } from './pairing'

// The platform-free core: pairing, which conversation is which chat, commands, a message from the channel becoming a turn
// through the same queue as `chats:send`, and the reply streaming back. See docs/architecture/channels.md.

export interface ChannelServiceDeps {
  /** One service per platform; every other dep is shared or that platform's own view. */
  platform: ChannelPlatform
  store: ChannelStore
  tokens: ChannelTokens
  state: PlatformStateView
  adapterFor(token: ChannelToken): ChannelAdapter
  /** Asks the platform whether the tokens work, before they are saved. */
  checkToken(token: ChannelToken): Promise<'ok' | 'refused' | 'unreachable'>
  agents(): Promise<AgentSummary[]>
  chats: {
    list(): Promise<ChatMeta[]>
    get(id: string): Promise<ChatMeta | null>
    loadItems(id: string): Promise<ChatItem[]>
    patchInPlace(id: string, fn: (cur: ChatMeta) => Partial<Omit<ChatMeta, 'id' | 'updatedAt'>> | null): Promise<ChatMeta | null>
  }
  /** A new single chat in the folder the new-chat screen would pick (never one named from the channel). */
  createChat(agent: string): Promise<ChatMeta>
  /** TaskQueue.submit as a once-only user message; `committed` fires once it is stored, queued or found a duplicate. */
  submit(
    chatId: string,
    text: string,
    staged: string[],
    messageId: string,
    committed: (r: SendResult | 'duplicate') => void
  ): Promise<unknown>
  stop(chatId: string): Promise<unknown>
  // Cards: the same handlers as the web's buttons (chats:answer, chats:answerQuestions, chats:answerPlan).
  answer(chatId: string, requestId: string, decision: ApprovalDecision, agent?: string): Promise<unknown>
  answerQuestions(chatId: string, requestId: string, answers: QuestionAnswers, agent?: string): Promise<unknown>
  answerPlan(chatId: string, requestId: string, approve: boolean, feedback: string | null, agent?: string): Promise<unknown>
  /** The request still waits in a running turn (ChatService.isPending). */
  pending(chatId: string, requestId: string, agent?: string): boolean
  pause(chatId: string): Promise<unknown>
  resume(chatId: string): Promise<unknown>
  stage(name: string, bytes: Uint8Array): Promise<StageResult>
  discard(id: string): Promise<void>
  /** A voice note's transcript (voice input's own path and cleaning), 'off' when voice input is off, null when it failed. */
  transcribe(audio: Uint8Array, mime: string): Promise<string | 'off' | null>
  /** A whole-file snapshot the Files panel keeps, by its id. */
  snapshot(chatId: string, id: string): Promise<string | null>
  /** Paths whose content must never be sent (the data folder, the vault key's folder). */
  forbidden(path: string): boolean
  /** Every vault secret out of outbound text. */
  scrub(text: string): string
  pushMeta(meta: ChatMeta): void
  /** Settings › Channels refetches. */
  changed(): void
  /** The VPS address for links back to a chat; null in Local mode, where nothing public reaches the server. */
  chatUrl(chatId: string): string | null
  random(n: number): Uint8Array
  now(): number
  log(line: string): void
}

/** A chat replying to the channel: the turns started by channel messages (`anchors`) stream back, nothing else. */
interface Drive {
  conv: string
  anchors: Set<string>
  sent: Set<string>
  steps: Set<string>
  changes: Map<string, FileChange> // by path, the newest
  live: string
  items: ChatItem[] | null // the newest pushed list (the store's copy trails the pushes)
  draftId: number
  lastPreview: number
  previewTimer: ReturnType<typeof setTimeout> | null
  headed: boolean
}

const PREVIEW_GAP_MS = 1000
const DRIVEN_GRACE_MS = 60_000
const PREVIEW_MAX = 3500
const ERROR_MAX = 500
const LIST_MAX = 10
const FILES_OFFERED = 5

type Settings = ChannelSettings

export class ChannelService {
  private adapter: ChannelAdapter | null = null
  private status: ChannelState = 'off'
  private bot: string | null = null
  private readonly pairing: Pairing
  private readonly buttons: ButtonTokens
  private readonly cards: ChannelCards
  private drives = new Map<string, Drive>()
  // Chats whose drive closed a moment ago: a turn's end can reach the notifications just after its drive closed.
  private driven = new Map<string, number>()
  private reconciling: Promise<void> = Promise.resolve()
  private closed = false
  private readonly p: ChannelPlatform
  private readonly dl: Dialect
  private readonly label: string
  private readonly cmd: string

  constructor(private readonly d: ChannelServiceDeps) {
    this.p = d.platform
    this.dl = d.platform === 'slack' ? SLACK : TELEGRAM
    this.label = CHANNEL_LABELS[d.platform]
    this.cmd = COMMAND_PREFIX[d.platform]
    this.pairing = new Pairing({ random: d.random, now: d.now })
    this.buttons = new ButtonTokens({ random: () => Buffer.from(d.random(16)).toString('base64url'), now: d.now })
    this.cards = new ChannelCards({
      adapter: () => (this.closed ? null : this.adapter),
      dialect: this.dl,
      buttons: this.buttons,
      answer: d.answer,
      answerQuestions: d.answerQuestions,
      answerPlan: d.answerPlan,
      pending: d.pending,
      scrub: d.scrub,
      remember: (conv, msg, chatId) => this.remember(conv, msg, chatId),
      // Written even while stopping: stop() waits for the outbound queue and these writes, and a card sent just before must be
      // remembered, or its buttons would stay after the restart.
      saveRecords: async (records) => {
        await this.d.state.update((x) => {
          x.cards = records
        })
      },
      log: d.log
    })
  }

  /** Plain text in the platform's markup: escaped, nothing else. */
  private plain(text: string): OutText {
    return { html: this.dl.escape(text), plain: text }
  }

  // --- Lifecycle --------------------------------------------------------------------------------------------------

  /** Starts or stops the poller to match the settings and the token; serialized, so two quick changes never race. */
  reconcile(): Promise<void> {
    if (this.closed) return this.reconciling
    this.reconciling = this.reconciling
      .then(() => this.doReconcile())
      .catch((err) => this.d.log(`channels: ${err instanceof Error ? err.message : 'error'}`))
    return this.reconciling
  }

  private async doReconcile(): Promise<void> {
    const s = await this.d.store.platform(this.p)
    const token = this.d.tokens.get(this.p)
    const want = s.run && token !== null
    if (!want) {
      await this.stopAdapter()
      this.setState(this.d.tokens.isLocked(this.p) && s.run ? 'vault' : 'off', null)
      return
    }
    if (this.adapter) return
    const adapter = this.d.adapterFor(token)
    this.adapter = adapter
    const st = await this.d.state.get()
    adapter.start(this.sink(adapter), st.offset, (next) =>
      this.d.state
        .update((x) => {
          x.offset = next
        })
        .then(() => undefined)
    )
  }

  private async stopAdapter(): Promise<void> {
    const a = this.adapter
    this.adapter = null
    if (a) await a.stop()
  }

  async start(): Promise<void> {
    await this.reconcile()
    await this.recover()
  }

  /** Before the server's lock goes: nothing more is read, sent or written once this resolves. */
  async stop(): Promise<void> {
    this.closed = true
    for (const drv of this.drives.values()) if (drv.previewTimer) clearTimeout(drv.previewTimer)
    await this.reconciling
    await this.stopAdapter()
    await this.queue.catch(() => undefined)
    // Queued after every write already started.
    await this.d.state.get().catch(() => undefined)
  }

  private setState(s: ChannelState, bot: string | null): void {
    if (s === this.status && bot === this.bot) return
    this.status = s
    if (bot !== null) this.bot = bot
    this.d.changed()
  }

  async statusOf(): Promise<ChannelStatus> {
    const s = await this.d.store.platform(this.p)
    return {
      platform: this.p,
      configured: this.d.tokens.configured(this.p),
      run: s.run,
      state: this.status,
      bot: this.bot,
      paired: s.paired ? { name: s.paired.name } : null,
      pairing: this.pairing.open(),
      agents: s.agents,
      sharedCards: s.sharedCards,
      notify: s.notify
    }
  }

  // --- Settings (RPC) ---------------------------------------------------------------------------------------------

  async setToken(token: ChannelToken): Promise<void> {
    const check = await this.d.checkToken(token)
    if (check === 'refused') throw new Error(`${this.label} refused this ${TOKEN_NAMES[this.p]}.`)
    if (check === 'unreachable') throw new Error(`${this.label} could not be reached to check the ${TOKEN_NAMES[this.p]}. Try again.`)
    await this.stopAdapter()
    await this.d.tokens.set(this.p, token)
    // A new bot: its updates start from its own beginning, and the old bot's messages and chats no longer route.
    await this.d.state.update((x) => {
      x.offset = 0
      x.current = {}
      x.msgs = []
    })
    this.bot = null
    await this.reconcile()
    this.d.changed()
  }

  async removeToken(): Promise<void> {
    await this.stopAdapter()
    await this.d.tokens.remove(this.p)
    this.bot = null
    await this.reconcile()
    this.d.changed()
  }

  async setRun(on: boolean): Promise<void> {
    await this.d.store.update(this.p, (t) => ({ ...t, run: on }))
    await this.reconcile()
    this.d.changed()
  }

  pairStart(): { code: string; expiresAt: number } {
    const p = this.pairing.start()
    this.d.changed()
    return p
  }

  pairCancel(): void {
    this.pairing.cancel()
    this.d.changed()
  }

  async unpair(): Promise<void> {
    await this.d.store.update(this.p, (t) => ({ ...t, paired: null }))
    await this.d.state.update((x) => {
      x.current = {}
      x.msgs = []
    })
    this.drives.clear()
    this.d.changed()
  }

  /** Slack: whether cards show in channels others can read (off: a link to the chat goes there instead). */
  async setSharedCards(on: boolean): Promise<void> {
    await this.d.store.update(this.p, (t) => ({ ...t, sharedCards: on }))
    this.d.changed()
  }

  /** Which notifications also go to the paired chat (Settings › Channels). */
  async setNotify(toggles: ChannelNotifyToggles): Promise<void> {
    await this.d.store.update(this.p, (t) => ({ ...t, notify: { ...toggles } }))
    this.d.changed()
  }

  /**
   * This channel as a notification target: the paired direct chat gets the same title-only text a push carries, with a
   * link to the chat on a VPS. A reply to it continues that chat, as a reply to any bot message does.
   */
  notifyTarget(): NotifyTarget {
    return {
      id: `channel:${this.p}`,
      label: this.label,
      toggles: async () => {
        const s = await this.d.store.platform(this.p)
        return s.paired && this.adapter && !this.closed ? s.notify : null
      },
      drives: (chatId) => this.drives.has(chatId) || this.d.now() - (this.driven.get(chatId) ?? -Infinity) < DRIVEN_GRACE_MS,
      send: (payload) => this.sendNotice(payload)
    }
  }

  private async sendNotice(payload: NotifyPayload): Promise<boolean> {
    const s = await this.d.store.platform(this.p)
    const a = this.adapter
    if (!s.paired || !a || this.closed) return false
    const { title, line } = channelNotifyText(payload)
    const url = payload.chatId ? this.d.chatUrl(payload.chatId) : null
    const safeTitle = this.d.scrub(title)
    const html = [this.dl.bold(this.dl.escape(safeTitle)), this.dl.escape(line), ...(url ? [this.dl.escape(url)] : [])].join('\n')
    const plain = [safeTitle, line, ...(url ? [url] : [])].join('\n')
    const id = await a.send(s.paired.chatId, { html, plain })
    if (payload.chatId) await this.remember(s.paired.chatId, id, payload.chatId)
    if (payload.kind === 'waiting' && payload.chatId && !payload.inbox) await this.noticeCards(s, payload.chatId)
    return id !== ''
  }

  /**
   * A waiting notice of a web turn brings the chat's pending approval, question and plan cards, so they can be answered from
   * the phone. Only for a chat whose agents are on for this channel; browser and vault handoffs stay title-only.
   */
  private async noticeCards(s: Settings, chatId: string): Promise<void> {
    const chat = await this.d.chats.get(chatId)
    if (!chat || (await this.refusal(chat, s)) !== null || !s.paired) return
    const conv = s.paired.chatId
    const run = async () => {
      for (const it of await this.d.chats.loadItems(chatId)) {
        if (it.type !== 'approval' || it.status !== 'pending') continue
        if (!this.d.pending(chatId, it.id, it.agent)) continue
        await this.cards.show(conv, chatId, it)
      }
    }
    this.queue = this.queue.then(run, run)
    await this.queue
  }

  async setAgents(names: string[]): Promise<void> {
    const known = new Set((await this.d.agents()).map((a) => a.name))
    const list = [...new Set(names)].filter((n) => n !== ZUMI_BOT_NAME && known.has(n))
    await this.d.store.update(this.p, (t) => ({ ...t, agents: list }))
    this.d.changed()
  }

  /** Continue in Telegram (or Slack): the chat becomes the paired direct conversation's current chat. */
  async link(chatId: string): Promise<void> {
    const s = await this.d.store.platform(this.p)
    if (!s.paired) throw new Error(`Pair a ${this.label} account in Settings › Channels first`)
    const chat = await this.d.chats.get(chatId)
    if (!chat) throw new Error(`Chat not found: ${chatId}`)
    const why = await this.refusal(chat, s)
    if (why) throw new Error(why)
    await this.makeCurrent(s.paired.chatId, chat)
    if (this.adapter)
      await this.say(
        s.paired.chatId,
        { html: `Continuing here: ${this.headerHtml(chat)}`, plain: `Continuing here: ${chat.title}` },
        chat.id
      )
  }

  async unlink(chatId: string): Promise<void> {
    await this.d.state.update((x) => {
      for (const [k, v] of Object.entries(x.current)) if (v === chatId) delete x.current[k]
    })
    await this.mark(chatId, false)
    this.drives.delete(chatId)
  }

  // --- Eligibility ------------------------------------------------------------------------------------------------

  private async enabledAgents(s: Settings): Promise<AgentSummary[]> {
    return (await this.d.agents()).filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME && s.agents.includes(a.name))
  }

  /** Why a chat can't be used from the channel now (checked at every send and press, since switches change), or null. */
  private async refusal(chat: ChatMeta, s: Settings): Promise<string | null> {
    if (chat.asked) return 'That chat is read-only.'
    const enabled = new Set((await this.enabledAgents(s)).map((a) => a.name))
    const members = isGroup(chat) ? chat.group!.members : [chat.agentName]
    if (members.length === 0 || !members.every((m) => enabled.has(m)))
      return `This chat's agent is not available from ${this.label}. Turn it on in Settings › Channels.`
    return null
  }

  private async eligibleChats(s: Settings): Promise<ChatMeta[]> {
    const out: ChatMeta[] = []
    for (const c of (await this.d.chats.list()).sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (out.length >= LIST_MAX) break
      if ((c.archivedAt ?? 0) > (c.unarchivedAt ?? 0)) continue
      if ((await this.refusal(c, s)) === null) out.push(c)
    }
    return out
  }

  private titleOf(chat: ChatMeta): string {
    return isGroup(chat) ? `Room: ${chat.title}` : `${displayName(chat.agentName)} · ${chat.title}`
  }

  private headerHtml(chat: ChatMeta): string {
    return this.dl.bold(this.dl.escape(this.d.scrub(this.titleOf(chat))))
  }

  // --- Inbound ----------------------------------------------------------------------------------------------------

  private sink(adapter: ChannelAdapter): ChannelSink {
    return {
      message: (m) => this.onMessage(adapter, m),
      press: (p) => this.onPress(adapter, p),
      state: (s, bot) => {
        if (this.adapter === adapter) this.setState(s, bot)
      }
    }
  }

  private async onMessage(adapter: ChannelAdapter, m: InboundMessage): Promise<void> {
    if (this.closed) throw new Error('channel stopped') // not confirmed: the next start reads it again
    const s = await this.d.store.platform(this.p)
    if (!s.paired) {
      // Before pairing only a code-shaped message from a one-to-one chat is read, and nothing is ever answered but success.
      if (!m.direct) return
      if (this.pairing.attempt(m.from.id, m.text) !== 'paired') return
      const name = (await adapter.userName?.(m.from).catch(() => null)) ?? m.from.name
      await this.d.store.update(this.p, (t) => ({ ...t, paired: { userId: m.from.id, chatId: m.conv, name } }))
      this.d.changed()
      await adapter.send(m.conv, this.plain(`Paired with ZumiBot. ${this.cmd}help lists the commands.`))
      return
    }
    // Anyone but the paired account is ignored, never answered and never read further. The paired account counts in its own
    // direct chat with the bot, and (Slack) in a shared channel only when it mentions the bot or writes in a thread that
    // already is a chat: nothing else said in a channel is read.
    if (m.from.id !== s.paired.userId) return
    if (
      m.direct
        ? m.conv !== s.paired.chatId
        : !adapter.sharedConvs || (!m.mentioned && (await this.d.state.get()).current[m.conv] === undefined)
    )
      return

    // A reply to a card (its prompt, a question, a plan) answers the card and never becomes a turn. In a shared thread a
    // message has no reply target of its own, so an open prompt there takes the next one.
    if (m.text.trim() !== '' && (await this.cards.reply(m.conv, m.replyTo, m.text, adapter.isShared(m.conv)))) return

    const cmd = parseChannelCommand(m.text, this.p)
    if (cmd) {
      // At most once: recorded before it runs, so a redelivered /new never makes a second chat (a crash loses the command instead).
      if ((await this.d.state.get()).cmds.includes(m.updateId)) return
      await this.d.state.update((x) => {
        x.cmds.push(m.updateId)
      })
      return this.onCommand(adapter, m, cmd, s)
    }

    let chat: ChatMeta | null = null
    if (m.replyTo) {
      const id = await this.d.state.chatOfMessage(m.conv, m.replyTo)
      chat = id ? await this.d.chats.get(id) : null
    }
    if (!chat) {
      const id = (await this.d.state.get()).current[m.conv]
      chat = id ? await this.d.chats.get(id) : null
    }
    if (!chat)
      return void (await adapter.send(
        m.conv,
        this.plain(
          `No chat ${adapter.isShared(m.conv) ? 'in this thread ' : ''}yet. ${this.cmd}new <agent> starts one, ${this.cmd}agents lists them, ${this.cmd}chats lists recent chats.`
        )
      ))
    const why = await this.refusal(chat, s)
    if (why) return void (await adapter.send(m.conv, this.plain(why)))

    let text = m.text
    if (m.voice) {
      const heard = await this.d.transcribe(await adapter.fetchFile(m.voice).catch(() => new Uint8Array()), m.voice.mime)
      if (heard === 'off') return void (await adapter.send(m.conv, this.plain('Voice input is off in ZumiBot (Settings › Voice input).')))
      if (heard === null || heard.trim() === '')
        return void (await adapter.send(m.conv, this.plain("Couldn't transcribe that voice note.")))
      text = text === '' ? heard : `${text}\n\n${heard}`
      await adapter.send(m.conv, this.plain(`🎙 ${heard}`))
    }
    if (text.length > CHANNEL_TEXT_MAX)
      return void (await adapter.send(m.conv, this.plain(`That message is too long (more than ${CHANNEL_TEXT_MAX} characters).`)))

    const staged: string[] = []
    for (const f of m.files) {
      let bytes: Uint8Array
      try {
        bytes = await adapter.fetchFile(f)
      } catch {
        await adapter.send(
          m.conv,
          this.plain(`Couldn't fetch ${f.name} (files up to ${Math.round(adapter.limits.downloadBytes / 1048576)} MB).`)
        )
        continue
      }
      const r = await this.d.stage(f.name, bytes)
      if (r.ok) staged.push(r.attachment.id)
      else await adapter.send(m.conv, this.plain(r.error))
    }
    if (text.trim() === '' && staged.length === 0) return

    const botId = adapter.botId() ?? '0'
    const mid = channelMessageId(this.p, botId, m.updateId)
    const drv = this.driveFor(chat.id, m.conv)
    // A redelivery of a message still being answered finds its id already here: it must not take it away below.
    const had = drv.anchors.has(mid)
    drv.anchors.add(mid)
    await this.saveOpen()
    let committed: (r: SendResult | 'duplicate') => void = () => undefined
    const settled = new Promise<SendResult | 'duplicate'>((r) => (committed = r))
    const sent = this.d.submit(chat.id, text, staged, mid, committed)
    const outcome = await Promise.race([
      settled,
      sent.then(
        () => null,
        (err: unknown) => err as Error
      )
    ])
    if (outcome instanceof Error || outcome === null) {
      if (outcome instanceof Error) {
        if (!had) drv.anchors.delete(mid)
        for (const id of staged) await this.d.discard(id).catch(() => undefined)
        await adapter.send(m.conv, this.plain(this.d.scrub(outcome.message).slice(0, ERROR_MAX)))
        await this.endIfIdle(chat.id)
      }
      return
    }
    // A turn's own failures reach the chat as its error item; a rejection after this point is not the channel's to answer.
    sent.catch(() => undefined)
    if (outcome === 'duplicate') {
      if (!had) drv.anchors.delete(mid)
      await this.endIfIdle(chat.id)
      return
    }
    await this.makeCurrent(m.conv, chat)
    if (outcome === 'queued') await adapter.send(m.conv, this.plain('Queued: the reply comes after the running one.'))
  }

  private async onCommand(adapter: ChannelAdapter, m: InboundMessage, cmd: ChannelCommand, s: Settings): Promise<void> {
    const conv = m.conv
    const currentChat = async (): Promise<ChatMeta | null> => {
      const id = (await this.d.state.get()).current[conv]
      return id ? this.d.chats.get(id) : null
    }
    const withCurrent = async (fn: (c: ChatMeta) => Promise<unknown>, done: string): Promise<void> => {
      const c = await currentChat()
      if (!c) return void (await adapter.send(conv, this.plain('No current chat.')))
      try {
        await fn(c)
        await adapter.send(conv, this.plain(done))
      } catch (err) {
        await adapter.send(conv, this.plain(this.d.scrub(err instanceof Error ? err.message : 'That did not work.').slice(0, ERROR_MAX)))
      }
    }
    switch (cmd.kind) {
      case 'help':
        return void (await adapter.send(
          conv,
          this.plain(
            [
              adapter.isShared(conv)
                ? 'In this thread, write to its chat. Mention me to start one.'
                : `Send a message to talk to the current chat. ${this.p === 'slack' ? 'Reply in a thread of a bot message' : 'Reply to a bot message'} to continue that chat.`,
              '',
              ...CHANNEL_COMMANDS.map((c) => `${this.cmd}${c.name} — ${c.about.replace(/\//g, this.cmd)}`)
            ].join('\n')
          )
        ))
      case 'agents': {
        const list = await this.enabledAgents(s)
        if (list.length === 0)
          return void (await adapter.send(
            conv,
            this.plain(`No agents are turned on for ${this.label}. Choose them in Settings › Channels.`)
          ))
        const group = `agents:${this.d.now()}`
        const rows = chunk(
          list.map((a) => ({
            label: displayName(a.name),
            token: this.buttons.issue(conv, group, { kind: 'newChat', agent: a.name }, true)
          })),
          2
        )
        return void (await adapter.send(conv, this.plain('Start a new chat with:'), { buttons: rows }))
      }
      case 'new': {
        let agent: string | null = null
        if (cmd.agent === null) {
          const c = await currentChat()
          if (!c || isGroup(c))
            return void (await adapter.send(conv, this.plain(`Name the agent: ${this.cmd}new <agent>. ${this.cmd}agents lists them.`)))
          agent = c.agentName
        } else {
          const hit = matchAgent(cmd.agent, await this.enabledAgents(s))
          if (!hit.ok)
            return void (await adapter.send(
              conv,
              this.plain(`No agent named ${cmd.agent.slice(0, 60)} is available here. ${this.cmd}agents lists them.`)
            ))
          agent = hit.name
        }
        return this.newChat(adapter, conv, agent, s)
      }
      case 'chats': {
        const list = await this.eligibleChats(s)
        if (list.length === 0) return void (await adapter.send(conv, this.plain(`No chats with agents turned on for ${this.label} yet.`)))
        const group = `chats:${this.d.now()}`
        const rows = list.map((c) => [
          {
            label: this.d.scrub(this.titleOf(c)).slice(0, 60),
            token: this.buttons.issue(conv, group, { kind: 'openChat', chatId: c.id }, true)
          }
        ])
        return void (await adapter.send(conv, this.plain('Continue a chat:'), { buttons: rows }))
      }
      case 'where': {
        const c = await currentChat()
        if (!c) return void (await adapter.send(conv, this.plain(`No current chat. ${this.cmd}new <agent> starts one.`)))
        const state = c.pause ? 'paused' : c.inFlight ? 'replying' : 'idle'
        const queued = c.tasks?.length ? `, ${c.tasks.length} queued` : ''
        return void (await this.say(
          conv,
          { html: `${this.headerHtml(c)}\n${state}${queued}`, plain: `${this.titleOf(c)}\n${state}${queued}` },
          c.id
        ))
      }
      case 'stop':
        return withCurrent((c) => this.d.stop(c.id), 'Stopped.')
      case 'pause':
        return withCurrent((c) => this.d.pause(c.id), 'Pausing: running subagents finish first.')
      case 'resume':
        return withCurrent((c) => this.d.resume(c.id), 'Resumed.')
      case 'unknown':
        return void (await adapter.send(conv, this.plain(`Unknown command. ${this.cmd}help lists them.`)))
    }
  }

  private async newChat(adapter: ChannelAdapter, conv: string, agent: string, s: Settings): Promise<void> {
    if (!(await this.enabledAgents(s)).some((a) => a.name === agent))
      return void (await adapter.send(conv, this.plain('That agent is not available here.')))
    const chat = await this.d.createChat(agent)
    this.d.pushMeta(chat)
    await this.makeCurrent(conv, chat)
    await this.say(conv, { html: `New chat: ${this.headerHtml(chat)}`, plain: `New chat: ${this.titleOf(chat)}` }, chat.id)
  }

  private async onPress(adapter: ChannelAdapter, p: ButtonPress): Promise<void> {
    const s = await this.d.store.platform(this.p)
    const ours = s.paired !== null && p.from.id === s.paired.userId && (p.direct ? p.conv === s.paired.chatId : adapter.sharedConvs)
    // Someone else pressed a button they can see (a shared channel): told, privately, and nothing else happens.
    if (!ours) return adapter.ackPress(p, !p.direct && s.paired ? `Only ${s.paired.name} can answer this.` : undefined)
    const action: ButtonAction | null = this.buttons.take(p.conv, p.token)
    if (!action) return adapter.ackPress(p, 'That button is no longer active.')
    // A card answers its own press (checked against the live request) and keeps its keyboard until it is answered.
    if (action.kind === 'card') return this.cards.press(p, action)
    await adapter.ackPress(p)
    if (p.msg && action.kind !== 'sendFile') await adapter.clearButtons(p.conv, p.msg).catch(() => undefined)
    switch (action.kind) {
      case 'newChat':
        return this.newChat(adapter, p.conv, action.agent, s)
      case 'openChat': {
        const chat = await this.d.chats.get(action.chatId)
        if (!chat) return void (await adapter.send(p.conv, this.plain('That chat is gone.')))
        const why = await this.refusal(chat, s)
        if (why) return void (await adapter.send(p.conv, this.plain(why)))
        await this.makeCurrent(p.conv, chat)
        return void (await this.say(p.conv, { html: `Now in ${this.headerHtml(chat)}`, plain: `Now in ${this.titleOf(chat)}` }, chat.id))
      }
      case 'sendFile': {
        const chat = await this.d.chats.get(action.chatId)
        if (!chat || (await this.refusal(chat, s)) !== null || this.d.forbidden(action.path))
          return void (await adapter.send(p.conv, this.plain("That file can't be sent.")))
        const body = await this.d.snapshot(action.chatId, action.snapshot)
        const bytes = body === null ? null : Buffer.from(body, 'utf8')
        if (!bytes || bytes.length > Math.min(CHANNEL_FILE_MAX, adapter.limits.uploadBytes))
          return void (await adapter.send(p.conv, this.plain("That file can't be sent (missing or larger than 10 MB).")))
        const id = await adapter.sendFile(p.conv, action.name, bytes)
        await this.remember(p.conv, id, action.chatId)
        return
      }
    }
  }

  private async makeCurrent(conv: string, chat: ChatMeta): Promise<void> {
    await this.d.state.update((x) => {
      x.current[conv] = chat.id
    })
    await this.mark(chat.id, true)
  }

  /** The chat's small channel mark in the sidebar. */
  private async mark(chatId: string, on: boolean): Promise<void> {
    const meta = await this.d.chats.patchInPlace(chatId, (cur) =>
      on
        ? cur.channel?.platform === this.p
          ? null
          : { channel: { platform: this.p } }
        : cur.channel?.platform === this.p
          ? { channel: undefined }
          : null
    )
    if (meta) this.d.pushMeta(meta)
  }

  private async remember(conv: string, msgId: string, chatId: string): Promise<void> {
    if (msgId === '') return
    await this.d.state.update((x) => {
      x.msgs.push([conv, msgId, chatId])
    })
  }

  /** A message that belongs to a chat: a reply to it continues that chat. */
  private async say(conv: string, text: OutText, chatId: string, buttons?: Parameters<ChannelAdapter['send']>[2]): Promise<void> {
    const a = this.adapter
    if (!a) return
    const id = await a.send(conv, text, buttons)
    await this.remember(conv, id, chatId)
  }

  // --- Outbound ---------------------------------------------------------------------------------------------------

  private driveFor(chatId: string, conv: string): Drive {
    let drv = this.drives.get(chatId)
    if (!drv || drv.conv !== conv) {
      drv = {
        conv,
        anchors: new Set(),
        sent: new Set(),
        steps: new Set(),
        changes: new Map(),
        live: '',
        items: null,
        draftId: 1 + (Buffer.from(this.d.random(4)).readUInt32BE() % 2_000_000_000),
        lastPreview: 0,
        previewTimer: null,
        headed: false
      }
      this.drives.set(chatId, drv)
    }
    return drv
  }

  private async saveOpen(): Promise<void> {
    if (this.closed) return
    const open: OpenStream[] = [...this.drives]
      .filter(([, v]) => v.anchors.size > 0)
      .map(([chatId, v]) => ({ chatId, conv: v.conv, anchors: [...v.anchors] }))
    await this.d.state.update((x) => {
      x.open = open
    })
  }

  /** Every pushed chat change; only chats with a channel-driven turn are read. Never throws into the push path. */
  chatPush(p: ChatPush): void {
    if (!this.adapter || this.closed) return
    const drv = this.drives.get(p.chatId)
    if (drv) {
      void this.onPush(drv, p).catch((err) =>
        this.d.log(`channels: reply not sent (${err instanceof Error ? err.message.slice(0, 80) : 'error'})`)
      )
      return
    }
    // A question card sent with a notice (a web turn's): kept in step with the chat like a driven turn's card.
    if (this.cards.hasChat(p.chatId)) void this.onCardPush(p).catch(() => undefined)
  }

  private onCardPush(p: ChatPush): Promise<void> {
    const run = async () => {
      if (p.kind === 'items') await this.cards.sync(p.chatId, p.items)
      else if (p.kind === 'meta' && !p.meta.inFlight && !this.drives.has(p.chatId)) await this.cards.closeChat(p.chatId)
    }
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  private queue: Promise<void> = Promise.resolve()

  private onPush(drv: Drive, p: ChatPush): Promise<void> {
    // In order, one at a time: the items of a push are sent before the next push's.
    const run = async () => {
      switch (p.kind) {
        case 'delta':
          if (p.thought) return
          drv.live += p.text
          this.preview(p.chatId, drv)
          return
        case 'items':
          drv.items = p.items
          await this.sendItems(p.chatId, drv, p.items)
          await this.cards.sync(p.chatId, p.items)
          if (p.clearStreaming) drv.live = ''
          return
        case 'meta':
          if (!p.meta.inFlight) await this.endIfIdle(p.chatId, drv)
          return
        default:
          return
      }
    }
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  private preview(chatId: string, drv: Drive): void {
    if (drv.previewTimer) return
    const wait = Math.max(0, drv.lastPreview + PREVIEW_GAP_MS - this.d.now())
    drv.previewTimer = setTimeout(() => {
      drv.previewTimer = null
      if (this.drives.get(chatId) !== drv || !this.adapter) return
      drv.lastPreview = this.d.now()
      const a = this.adapter
      const text =
        drv.live.trim() !== ''
          ? this.d.scrub(tailOf(drv.live, PREVIEW_MAX))
          : `Working… (${drv.steps.size} ${drv.steps.size === 1 ? 'step' : 'steps'})`
      const html = drv.live.trim() !== '' ? render(text, this.dl) : this.dl.escape(text)
      void a
        .draft(drv.conv, drv.draftId, { html, plain: text })
        .then((ok) => (ok ? undefined : a.typing(drv.conv)))
        .catch(() => undefined)
    }, wait)
    drv.previewTimer.unref?.()
  }

  private async sendItems(chatId: string, drv: Drive, items: ChatItem[]): Promise<void> {
    const chat = await this.d.chats.get(chatId)
    if (!chat) return
    const s = await this.d.store.platform(this.p)
    // Checked per push: an agent switched off mid-turn sends nothing more.
    if ((await this.refusal(chat, s)) !== null) return
    let on = false
    for (const it of items) {
      if (it.type === 'user') {
        on = drv.anchors.has(it.id)
        continue
      }
      if (!on || drv.sent.has(it.id)) continue
      switch (it.type) {
        case 'assistant': {
          drv.sent.add(it.id)
          if (it.text.trim() === '') break
          await this.sendReply(chat, drv, it.text, isGroup(chat) ? it.agent : undefined)
          break
        }
        case 'tool':
          drv.steps.add(it.id)
          for (const c of it.changes ?? []) drv.changes.set(c.path, c)
          if (drv.live.trim() === '') this.preview(chatId, drv)
          break
        case 'error':
          drv.sent.add(it.id)
          await this.say(drv.conv, this.plain(`Error: ${this.d.scrub(it.text).slice(0, ERROR_MAX)}`), chatId)
          break
        case 'notice':
          drv.sent.add(it.id)
          await this.say(
            drv.conv,
            this.plain(
              it.kind in NOTICE_TEXT && it.kind !== 'worktree' && it.kind !== 'remote'
                ? NOTICE_TEXT[it.kind]
                : this.d.scrub(it.text).slice(0, ERROR_MAX)
            ),
            chatId
          )
          break
        case 'approval':
        case 'browser-action':
        case 'vault-approval': {
          if (it.type === 'approval' && it.status !== 'pending') break
          // In a channel others can read, a card goes there only when Settings allows it; else the link below.
          const cardsHere = !this.adapter?.isShared(drv.conv) || s.sharedCards
          if (it.type === 'approval' && cardsHere && (await this.cards.show(drv.conv, chatId, it))) {
            drv.sent.add(it.id)
            break
          }
          if (it.type === 'browser-action' && it.handoff.status !== 'pending') break
          if (it.type === 'vault-approval' && it.request.status !== 'pending') break
          drv.sent.add(it.id)
          const who = it.agent ? displayName(it.agent) : 'The agent'
          const url = this.d.chatUrl(chatId)
          const where = url ? `Open it in ZumiBot: ${url}` : 'Open ZumiBot on your computer to answer.'
          await this.say(drv.conv, this.plain(`${who} is waiting for you in ZumiBot. ${where}`), chatId)
          break
        }
        default:
          break
      }
    }
  }

  private async sendReply(chat: ChatMeta, drv: Drive, text: string, member?: string): Promise<void> {
    const a = this.adapter
    if (!a) return
    const head = member ? this.dl.bold(this.dl.escape(displayName(member))) : !drv.headed ? this.headerHtml(chat) : ''
    const headPlain = member ? displayName(member) : !drv.headed ? this.titleOf(chat) : ''
    drv.headed = true
    const room = head === '' ? a.limits.text : a.limits.text - head.length - 1
    const parts = splitMessage(this.d.scrub(text), room, this.dl)
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const out = i === 0 && head !== '' ? { html: `${head}\n${p.html}`, plain: `${headPlain}\n${p.plain}` } : p
      await this.say(drv.conv, out, chat.id)
    }
  }

  /** A drive whose turns are all answered: the files it changed are offered, and it is closed. */
  /**
   * `only`: the drive a push was routed to. The queue can run that push late, after its drive ended and a new channel
   * message opened another; that new turn is between storing its message and marking the chat in flight, so it reads as
   * idle, and ending its drive here would leave its reply and cards unsent.
   */
  private async endIfIdle(chatId: string, only?: Drive): Promise<void> {
    const drv = this.drives.get(chatId)
    if (!drv || (only !== undefined && drv !== only)) return
    // Read now, never the push's copy: this queue can lag behind, and a channel message sent meanwhile may have joined the
    // drive after that push was made.
    const m = await this.d.chats.get(chatId)
    if (!m) {
      this.drives.delete(chatId)
      await this.saveOpen()
      return
    }
    if (m.inFlight) return
    // A channel message still waiting in the queue keeps the drive: its turn comes next.
    if ([...drv.anchors].some((a) => m.tasks?.some((t) => t.id === a))) return
    // So does one being launched now, whose user item is not in the list yet.
    const items = drv.items ?? (await this.d.chats.loadItems(chatId))
    const users = new Set(items.filter((i) => i.type === 'user').map((i) => i.id))
    if ([...drv.anchors].some((a) => !users.has(a))) return
    // The newest list is read once more, so nothing it holds is left unsent.
    const before = new Set(drv.anchors)
    await this.sendItems(chatId, drv, items)
    // Sending takes a while, and a channel message arriving meanwhile joins this drive: it stays for that message's turn.
    // Nothing is awaited between this check and the delete, so no message can join in between.
    if ([...drv.anchors].some((a) => !before.has(a)) || this.drives.get(chatId) !== drv) return
    if (drv.previewTimer) clearTimeout(drv.previewTimer)
    this.drives.delete(chatId)
    this.driven.set(chatId, this.d.now())
    if (this.driven.size > 500) this.driven.delete(this.driven.keys().next().value as string)
    await this.saveOpen()
    await this.cards.closeChat(chatId)
    await this.offerFiles(chatId, drv)
  }

  private async offerFiles(chatId: string, drv: Drive): Promise<void> {
    const a = this.adapter
    const files = [...drv.changes.values()].filter((c) => !this.d.forbidden(c.path))
    if (!a || files.length === 0) return
    const names = files.map((c) => basename(c.path))
    const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ` (+${names.length - 8})` : '')
    const group = `files:${chatId}:${this.d.now()}`
    const rows = files
      .filter((c) => c.after !== null)
      .slice(0, FILES_OFFERED)
      .map((c) => [
        {
          label: `Send ${basename(c.path)}`.slice(0, 60),
          token: this.buttons.issue(
            drv.conv,
            group,
            { kind: 'sendFile', chatId, path: c.path, snapshot: c.after as string, name: basename(c.path) },
            false
          )
        }
      ])
    await this.say(drv.conv, this.plain(this.d.scrub(`Files changed: ${shown}`)), chatId, rows.length > 0 ? { buttons: rows } : undefined)
  }

  /** After a restart: a reply cut by it is said to be cut; a channel message still queued streams back when it runs. */
  private async recover(): Promise<void> {
    const st = await this.d.state.get()
    await this.cards.recover(st.cards)
    const open = st.open
    if (open.length === 0) return
    const s = await this.d.store.platform(this.p)
    for (const o of open) {
      const meta = await this.d.chats.get(o.chatId)
      if (!meta || !s.paired || (o.conv !== s.paired.chatId && !this.adapter?.isShared(o.conv))) continue
      const anchors = o.anchors
      const queued = anchors.filter((a) => meta.tasks?.some((t) => t.id === a))
      if (queued.length < anchors.length && this.adapter)
        await this.say(o.conv, this.plain('(Interrupted: ZumiBot restarted before this reply finished.)'), o.chatId).catch(() => undefined)
      if (queued.length > 0) {
        const drv = this.driveFor(o.chatId, o.conv)
        for (const a of queued) drv.anchors.add(a)
      }
    }
    await this.saveOpen()
  }
}

function chunk<T>(list: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}
