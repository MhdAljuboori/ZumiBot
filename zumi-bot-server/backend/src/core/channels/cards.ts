import {
  answersOf,
  approvalCardHtml,
  optionLabel,
  outcomeLine,
  pickedLine,
  questionHtml,
  typedAnswerProblem
} from '@zumibot/shared/channelCards'
import { splitMessage, type Dialect } from '@zumibot/shared/channelText'
import { parsePlan, planHeading, PLAN_TOOL } from '@zumibot/shared/plans'
import { parseQuestions, questionHeading, QUESTION_TOOL, type Question } from '@zumibot/shared/questions'
import { toolSummary } from '@zumibot/shared/toolSummary'
import type { ApprovalDecision, ApprovalStatus, ChatItem, QuestionAnswers } from '@zumibot/shared/types'
import type { Button, ButtonPress, ChannelAdapter, OutText } from './adapter'
import type { ButtonAction, ButtonTokens, CardAct } from './buttons'
import type { CardRecord } from './channelState'

// Approval, question and plan cards in a channel. A card is another place to answer the same request: every answer goes
// through the same calls as the web's (chats:answer, chats:answerQuestions, chats:answerPlan), only Allow once and Deny
// are offered (nothing is remembered from a channel), a press is checked against the live request, not the message, and
// a card answered anywhere updates its message here. See docs/architecture/channels.md, Cards.

type Approval = Extract<ChatItem, { type: 'approval' }>
type CardKind = 'approval' | 'question' | 'plan'

export interface CardDeps {
  adapter(): ChannelAdapter | null
  dialect: Dialect
  buttons: ButtonTokens
  answer(chatId: string, requestId: string, decision: ApprovalDecision, agent?: string): Promise<unknown>
  answerQuestions(chatId: string, requestId: string, answers: QuestionAnswers, agent?: string): Promise<unknown>
  answerPlan(chatId: string, requestId: string, approve: boolean, feedback: string | null, agent?: string): Promise<unknown>
  /** The request still waits in a running turn. */
  pending(chatId: string, requestId: string, agent?: string): boolean
  scrub(text: string): string
  /** A bot message belongs to a chat: a reply to it routes there (when no card takes it first). */
  remember(conv: string, msg: string, chatId: string): Promise<void>
  /** The card messages with live buttons, for clearing after a restart. */
  saveRecords(records: CardRecord[]): Promise<void>
  log(line: string): void
}

interface QuestionUi {
  opts: string[]
  type: string
  done: string | null
}

interface Card {
  key: string
  group: string
  chatId: string
  requestId: string
  agent?: string
  kind: CardKind
  conv: string
  msgs: { id: string; text: OutText; live: boolean }[] // live: still carries buttons
  questions: Question[]
  heading: string | null
  picks: Map<number, string | string[]>
  toggles: Map<number, Set<number>>
  qMsg: Map<number, number> // question -> index in msgs
  ui: Map<number, QuestionUi>
  prompts: Map<string, number | 'feedback'> // a ForceReply message -> what its reply answers
  here: boolean // answered from this channel
  sending: boolean
}

const keyOf = (chatId: string, requestId: string, agent?: string) => `${chatId}:${agent ?? ''}:${requestId}`

export const STALE_NOTICE = 'Already answered.'

export class ChannelCards {
  private cards = new Map<string, Card>()

  constructor(private readonly d: CardDeps) {}

  private plain(text: string): OutText {
    return { html: this.d.dialect.escape(text), plain: text }
  }

  /** Any card of the chat still open here. */
  hasChat(chatId: string): boolean {
    for (const c of this.cards.values()) if (c.chatId === chatId) return true
    return false
  }

  has(chatId: string, requestId: string, agent?: string): boolean {
    return this.cards.has(keyOf(chatId, requestId, agent))
  }

  /** Shows a pending card of a channel-driven turn. False when it has no channel form (the caller sends the link instead). */
  async show(conv: string, chatId: string, item: Approval): Promise<boolean> {
    const a = this.d.adapter()
    if (!a) return false
    const key = keyOf(chatId, item.id, item.agent)
    if (this.cards.has(key)) return true
    const kind: CardKind = item.toolName === QUESTION_TOOL ? 'question' : item.toolName === PLAN_TOOL ? 'plan' : 'approval'
    const parsed = kind === 'question' ? parseQuestions(item.input) : null
    // A question card the web would show as a plain approval has no channel form.
    if (kind === 'question' && !parsed) return false
    const card: Card = {
      key,
      group: `card:${key}`,
      chatId,
      requestId: item.id,
      ...(item.agent ? { agent: item.agent } : {}),
      kind,
      conv,
      msgs: [],
      questions: parsed?.questions ?? [],
      heading: null,
      picks: new Map(),
      toggles: new Map(),
      qMsg: new Map(),
      ui: new Map(),
      prompts: new Map(),
      here: false,
      sending: false
    }
    this.cards.set(key, card)
    const issue = (act: CardAct, label: string, once: boolean, q?: number, o?: number): Button => ({
      label,
      token: this.d.buttons.issue(
        conv,
        card.group,
        { kind: 'card', key, act, ...(q !== undefined ? { q } : {}), ...(o !== undefined ? { o } : {}) },
        once
      )
    })
    const sendMsg = async (text: OutText, buttons?: Button[][]) => {
      const id = await a.send(conv, text, buttons ? { buttons } : undefined)
      card.msgs.push({ id, text, live: buttons !== undefined })
      await this.d.remember(conv, id, chatId)
    }
    try {
      if (kind === 'approval') {
        const html = approvalCardHtml(
          {
            agent: item.agent ?? null,
            toolName: item.toolName,
            input: scrubDeep(item.input, this.d.scrub),
            summary: this.d.scrub(toolSummary(item.toolName, item.input)),
            description: item.description ? this.d.scrub(item.description) : null,
            reason: item.reason ? this.d.scrub(item.reason) : null
          },
          this.d.dialect
        )
        await sendMsg({ html, plain: this.d.scrub(toolSummary(item.toolName, item.input)) }, [
          [issue('allow', 'Allow once', true), issue('deny', 'Deny', true)]
        ])
      } else if (kind === 'plan') {
        const dl = this.d.dialect
        const head = dl.bold(dl.escape(planHeading(item.agent ?? null)))
        const plan = parsePlan(item.input).plan ?? '(The plan is empty.)'
        const parts = splitMessage(this.d.scrub(plan), a.limits.text - head.length - 1, dl)
        for (let i = 0; i < parts.length; i++) {
          const last = i === parts.length - 1
          const text = i === 0 ? { html: `${head}\n${parts[i].html}`, plain: parts[i].plain } : parts[i]
          await sendMsg(text, last ? [[issue('approve', 'Approve', true), issue('keep', 'Keep planning', false)]] : undefined)
        }
      } else {
        card.heading = this.d.scrub(questionHeading(parsed!.title, card.questions.length, item.agent ?? null))
        for (let q = 0; q < card.questions.length; q++) {
          const qu = scrubQuestion(card.questions[q], this.d.scrub)
          const ui: QuestionUi = {
            opts: qu.options.map((opt, o) => issue(qu.multiSelect ? 'toggle' : 'pick', opt.label, false, q, o).token),
            type: issue('type', qu.options.length > 0 ? 'Other…' : 'Type an answer…', false, q).token,
            done: qu.multiSelect ? issue('done', 'Done', false, q).token : null
          }
          card.ui.set(q, ui)
          card.qMsg.set(q, card.msgs.length)
          await sendMsg(
            {
              html: questionHtml(qu, { heading: q === 0 ? card.heading : null, index: q, count: card.questions.length }, this.d.dialect),
              plain: qu.text
            },
            this.keyboard(card, q)
          )
        }
      }
    } catch (err) {
      this.d.log(`channels: card not sent (${err instanceof Error ? err.message.slice(0, 80) : 'error'})`)
    }
    await this.save()
    return true
  }

  /** The keyboard of a question: its options (ticked when picked, for a multi-select), Other…, and Done. */
  private keyboard(card: Card, q: number): Button[][] {
    const qu = card.questions[q]
    const ui = card.ui.get(q)!
    const picked = card.toggles.get(q) ?? new Set<number>()
    const opts = qu.options.map((o, i) => ({ label: optionLabel(this.d.scrub(o.label), picked.has(i)), token: ui.opts[i] }))
    const rows: Button[][] = []
    for (let i = 0; i < opts.length; i += 2) rows.push(opts.slice(i, i + 2))
    rows.push([
      { label: qu.options.length > 0 ? 'Other…' : 'Type an answer…', token: ui.type },
      ...(ui.done ? [{ label: 'Done', token: ui.done }] : [])
    ])
    return rows
  }

  /** A press on a card's button. The caller has checked the presser is the paired account and taken the token. */
  async press(p: ButtonPress, action: Extract<ButtonAction, { kind: 'card' }>): Promise<void> {
    const a = this.d.adapter()
    const card = this.cards.get(action.key)
    if (!a) return
    if (!card || !this.d.pending(card.chatId, card.requestId, card.agent)) {
      if (card) this.d.buttons.burn(card.group)
      return a.ackPress(p, STALE_NOTICE)
    }
    const q = action.q ?? -1
    switch (action.act) {
      case 'allow':
      case 'deny':
        await a.ackPress(p)
        return this.submit(card, () =>
          this.d.answer(card.chatId, card.requestId, action.act === 'allow' ? 'allow-once' : 'deny', card.agent)
        )
      case 'approve':
        await a.ackPress(p)
        return this.submit(card, () => this.d.answerPlan(card.chatId, card.requestId, true, null, card.agent))
      case 'keep': {
        await a.ackPress(p)
        const where = a.isShared(card.conv)
          ? 'Write it in this thread'
          : a.platform === 'slack'
            ? "Reply in this message's thread"
            : 'Reply to this message'
        const id = await a.ask(
          card.conv,
          this.plain(`What should change? ${where}, or answer /skip to send it back with no note.`),
          card.msgs.at(-1)?.id ?? null
        )
        card.prompts.set(id, 'feedback')
        return
      }
      case 'pick': {
        if (card.picks.has(q) || action.o === undefined) return a.ackPress(p, STALE_NOTICE)
        await a.ackPress(p)
        card.picks.set(q, card.questions[q].options[action.o].label)
        await this.markAnswered(card, q)
        return this.maybeSubmit(card)
      }
      case 'toggle': {
        if (card.picks.has(q) || action.o === undefined) return a.ackPress(p, STALE_NOTICE)
        await a.ackPress(p)
        const set = card.toggles.get(q) ?? new Set<number>()
        if (set.has(action.o)) set.delete(action.o)
        else set.add(action.o)
        card.toggles.set(q, set)
        const m = card.msgs[card.qMsg.get(q)!]
        return a.setButtons(card.conv, m.id, this.keyboard(card, q))
      }
      case 'done': {
        if (card.picks.has(q)) return a.ackPress(p, STALE_NOTICE)
        const set = card.toggles.get(q)
        if (!set || set.size === 0) return a.ackPress(p, 'Pick at least one, or type an answer with Other…')
        await a.ackPress(p)
        card.picks.set(
          q,
          [...set].sort((x, y) => x - y).map((i) => card.questions[q].options[i].label)
        )
        await this.markAnswered(card, q)
        return this.maybeSubmit(card)
      }
      case 'type': {
        if (card.picks.has(q)) return a.ackPress(p, STALE_NOTICE)
        await a.ackPress(p)
        const m = card.msgs[card.qMsg.get(q)!]
        const where = a.isShared(card.conv)
          ? ' (write it in this thread)'
          : a.platform === 'slack'
            ? " (reply in this message's thread)"
            : ''
        const id = await a.ask(card.conv, this.plain(`Your answer to: ${this.d.scrub(card.questions[q].text).slice(0, 200)}${where}`), m.id)
        card.prompts.set(id, q)
        return
      }
    }
  }

  /**
   * A typed message that answers a card: a reply to a card's prompt, to a question's message (its free text) or to a plan
   * (feedback with Keep planning). True when a card took it; the message never becomes a turn then.
   */
  async reply(conv: string, replyTo: string | null, text: string, implicit = false): Promise<boolean> {
    const a = this.d.adapter()
    if (!a || (replyTo === null && !implicit)) return false
    for (const card of this.cards.values()) {
      if (card.conv !== conv) continue
      // `implicit`: a thread has no reply target, so the newest open prompt there takes the message.
      const promptId = replyTo !== null ? (card.prompts.has(replyTo) ? replyTo : null) : ([...card.prompts.keys()].at(-1) ?? null)
      let target: number | 'feedback' | undefined = promptId !== null ? card.prompts.get(promptId) : undefined
      if (target === undefined && replyTo !== null) {
        const at = card.msgs.findIndex((m) => m.id === replyTo)
        if (at >= 0 && card.kind === 'plan') target = 'feedback'
        else if (at >= 0 && card.kind === 'question') target = [...card.qMsg].find(([, i]) => i === at)?.[0]
      }
      if (target === undefined) continue
      // A prompt is used once: in a thread, later messages go back to the chat.
      if (promptId !== null) card.prompts.delete(promptId)
      if (!this.d.pending(card.chatId, card.requestId, card.agent)) {
        await a.send(conv, this.plain(STALE_NOTICE))
        return true
      }
      if (target === 'feedback') {
        const note = /^[/!]skip$/.test(text.trim()) ? null : text
        await this.submit(card, () => this.d.answerPlan(card.chatId, card.requestId, false, note, card.agent))
        return true
      }
      const q = target
      if (card.picks.has(q)) {
        await a.send(conv, this.plain('That question already has an answer.'))
        return true
      }
      const problem = typedAnswerProblem(card.questions[q], text)
      if (problem) {
        await a.send(conv, this.plain(problem))
        return true
      }
      const set = card.toggles.get(q)
      const labels =
        card.questions[q].multiSelect && set ? [...set].sort((x, y) => x - y).map((i) => card.questions[q].options[i].label) : []
      card.picks.set(q, card.questions[q].multiSelect ? [...labels, text.trim()] : text.trim())
      await this.markAnswered(card, q)
      await this.maybeSubmit(card)
      return true
    }
    return false
  }

  private async markAnswered(card: Card, q: number): Promise<void> {
    const a = this.d.adapter()
    const at = card.qMsg.get(q)
    if (!a || at === undefined) return
    const m = card.msgs[at]
    const pick = card.picks.get(q)!
    // Shown scrubbed; the answer itself goes to the agent as the exact label it offered.
    const line = pickedLine(Array.isArray(pick) ? pick.map((x) => this.d.scrub(x)) : this.d.scrub(pick), this.d.dialect)
    m.live = false
    await a.edit(card.conv, m.id, { html: `${m.text.html}\n${line}`, plain: m.text.plain }, null)
    await this.save()
  }

  private async maybeSubmit(card: Card): Promise<void> {
    const answers = answersOf(card.questions, card.picks)
    if (answers) await this.submit(card, () => this.d.answerQuestions(card.chatId, card.requestId, answers, card.agent))
  }

  /** One answer at a time; its refusal (checkAnswers, checkFeedback) is told in the channel and the card stays open. */
  private async submit(card: Card, fn: () => Promise<unknown>): Promise<void> {
    if (card.sending) return
    card.sending = true
    card.here = true
    try {
      await fn()
      this.d.buttons.burn(card.group)
    } catch (err) {
      card.here = false
      const a = this.d.adapter()
      await a?.send(card.conv, this.plain(this.d.scrub(err instanceof Error ? err.message : 'That answer was refused.').slice(0, 500)))
    } finally {
      card.sending = false
    }
  }

  /** Every items push of a chat: a card no longer pending gets its outcome, wherever it was answered. */
  async sync(chatId: string, items: ChatItem[]): Promise<void> {
    for (const card of [...this.cards.values()]) {
      if (card.chatId !== chatId) continue
      const it = items.find(
        (i): i is Approval => i.type === 'approval' && i.id === card.requestId && (card.agent === undefined || i.agent === card.agent)
      )
      // Not in this list (an older page): left to the turn's end, which closes it.
      if (!it || it.status === 'pending') continue
      await this.close(card, it.status)
    }
  }

  /** The chat's turn ended: whatever is still open there is no longer pending. */
  async closeChat(chatId: string): Promise<void> {
    for (const card of [...this.cards.values()]) if (card.chatId === chatId) await this.close(card, 'unanswered')
  }

  private async close(card: Card, status: ApprovalStatus): Promise<void> {
    this.cards.delete(card.key)
    this.d.buttons.burn(card.group)
    const a = this.d.adapter()
    if (a) {
      const dl = this.d.dialect
      const line = dl.italic(dl.escape(outcomeLine(status, card.here)))
      // The outcome goes on the message that held the buttons (every question's, for a question card).
      const targets = card.kind === 'question' ? card.msgs : card.msgs.filter((m) => m.live)
      for (const m of targets) {
        await a
          .edit(card.conv, m.id, { html: `${m.text.html}\n\n${line}`, plain: `${m.text.plain}\n\n${outcomeLine(status, card.here)}` }, null)
          .catch(() => undefined)
      }
    }
    await this.save()
  }

  private save(): Promise<void> {
    const records: CardRecord[] = []
    for (const c of this.cards.values()) for (const m of c.msgs) if (m.live) records.push({ conv: c.conv, msg: m.id, chatId: c.chatId })
    return this.d.saveRecords(records).catch(() => undefined)
  }

  /** After a restart: the cards it cut lose their buttons (their turns ended with the restart). */
  async recover(records: CardRecord[]): Promise<void> {
    const a = this.d.adapter()
    if (!a || records.length === 0) return
    for (const r of records) await a.clearButtons(r.conv, r.msg).catch(() => undefined)
    const convs = new Set(records.map((r) => r.conv))
    for (const c of convs) await a.send(c, this.plain('Cards from before ZumiBot restarted are no longer pending.')).catch(() => undefined)
    await this.d.saveRecords([])
  }
}

/** A card's input with vault values out of every string (a Bash command may name a key). */
function scrubDeep(v: unknown, scrub: (s: string) => string): unknown {
  if (typeof v === 'string') return scrub(v)
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, scrub)]))
  return v
}

function scrubQuestion(q: Question, scrub: (s: string) => string): Question {
  return {
    ...q,
    text: scrub(q.text),
    header: scrub(q.header),
    description: q.description ? scrub(q.description) : null,
    options: q.options.map((o) => ({ ...o, label: scrub(o.label), description: o.description ? scrub(o.description) : null }))
  }
}
