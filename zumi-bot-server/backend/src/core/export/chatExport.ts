import { displayName } from '@zumibot/shared/frontmatter'
import { parsePlan, PLAN_TOOL } from '@zumibot/shared/plans'
import { parseQuestions, QUESTION_TOOL } from '@zumibot/shared/questions'
import { toolSummary } from '@zumibot/shared/toolSummary'
import { isGroup, type ApprovalStatus, type ChatItem, type ChatMeta } from '@zumibot/shared/types'

/** One step line under a reply: a tool call or an error. */
export interface StepLine {
  text: string
  error: boolean
}

export type ExportBlock =
  // more: the same agent's reply goes on after steps, so no new header.
  | { kind: 'message'; role: 'user' | 'agent'; who: string; ts: number; text: string; files: string[]; more: boolean }
  | { kind: 'steps'; lines: StepLine[] }
  | { kind: 'questions'; who: string; ts: number; pairs: { question: string; answer: string }[] }
  | { kind: 'plan'; who: string; ts: number; status: string; text: string }

export interface ExportDoc {
  title: string
  subtitle: string // who the chat is with
  exported: string // when, as read in `zone`
  zone: string
  reply: boolean // one reply, not the whole chat
  blocks: ExportBlock[]
}

export interface BuildOptions {
  steps: boolean
  item: string | null
  now: number
  zone: string
}

const ERROR_MAX = 500

const PLAN_STATUS: Partial<Record<ApprovalStatus, string>> = {
  approved: 'approved',
  'sent-back': 'sent back',
  pending: 'waiting',
  unanswered: 'not answered',
  denied: 'not answered'
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** A zone Intl knows, else null. */
export function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** `2026-11-12 14:03` in the zone; the same shape whatever the server's locale. */
export function formatTime(ts: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(ts)
  const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

const agentOf = (item: ChatItem): string | undefined =>
  'agent' in item && typeof item.agent === 'string' && item.agent !== '' ? item.agent : undefined

/** The items of the reply that holds agent message `id`: that agent's run of items between other speakers. */
export function replyRange(items: readonly ChatItem[], id: string, fallbackAgent: string): [number, number] | null {
  const at = items.findIndex((x) => x.id === id)
  if (at < 0 || items[at]!.type !== 'assistant') return null
  const who = agentOf(items[at]!) ?? fallbackAgent
  const same = (x: ChatItem): boolean => x.type !== 'user' && (agentOf(x) ?? who) === who
  let a = at
  while (a > 0 && same(items[a - 1]!)) a--
  let b = at
  while (b < items.length - 1 && same(items[b + 1]!)) b++
  return [a, b]
}

function subtitleOf(meta: ChatMeta): string {
  if (isGroup(meta)) {
    const names = meta.group.members.map(displayName)
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? 'nobody')
    return `Room with ${list}`
  }
  if (meta.asked) return `${displayName(meta.asked.by)} asking ${displayName(meta.agentName)}`
  return `Chat with ${displayName(meta.agentName)}`
}

function answerText(v: string | string[] | undefined): string {
  if (v === undefined) return '(skipped)'
  const s = Array.isArray(v) ? v.join(', ') : v
  return s.trim() === '' ? '(empty)' : s
}

/**
 * What a chat export shows, from its stored (visible) items: messages, answered questions and plans always; tool steps
 * and errors only with `steps`. Notices, approval cards, handoffs and vault cards never. Null when `item` names no agent
 * message of the chat.
 */
export function buildExport(meta: ChatMeta, items: readonly ChatItem[], o: BuildOptions): ExportDoc | null {
  let list = items
  if (o.item !== null) {
    const range = replyRange(items, o.item, meta.agentName)
    if (range === null) return null
    list = items.slice(range[0], range[1] + 1)
  }
  const fallback = meta.agentName || 'agent'
  const blocks: ExportBlock[] = []
  // Who spoke last with a header; a reply that goes on after its steps needs none.
  let speaker: string | null = null
  const last = (): ExportBlock | undefined => blocks[blocks.length - 1]
  const step = (line: StepLine): void => {
    const prev = last()
    if (prev?.kind === 'steps') prev.lines.push(line)
    else blocks.push({ kind: 'steps', lines: [line] })
  }

  for (const item of list) {
    switch (item.type) {
      case 'user': {
        const who = item.from ? displayName(item.from) : 'You'
        blocks.push({
          kind: 'message',
          role: 'user',
          who,
          ts: item.ts,
          text: item.text,
          files: (item.attachments ?? []).map((a) => a.name),
          more: false
        })
        speaker = `user:${who}`
        break
      }
      case 'assistant': {
        if (item.text.trim() === '') break
        const who = displayName(agentOf(item) ?? fallback)
        const prev = last()
        if (prev?.kind === 'message' && prev.role === 'agent' && prev.who === who) {
          prev.text = `${prev.text}\n\n${item.text}`
          break
        }
        blocks.push({
          kind: 'message',
          role: 'agent',
          who,
          ts: item.ts,
          text: item.text,
          files: [],
          more: speaker === `agent:${who}` && prev?.kind === 'steps'
        })
        speaker = `agent:${who}`
        break
      }
      case 'tool':
        if (o.steps)
          step({
            text: toolSummary(item.name, item.input) + (item.isError ? ' (failed)' : item.blocked ? ' (blocked)' : ''),
            error: item.isError
          })
        break
      case 'error':
        if (o.steps) step({ text: clip(oneLine(item.text), ERROR_MAX), error: true })
        break
      case 'approval': {
        const who = displayName(agentOf(item) ?? fallback)
        if (item.toolName === QUESTION_TOOL) {
          const parsed = parseQuestions(item.input)
          if (item.status === 'answered' && item.answers && parsed && parsed.questions.length > 0) {
            blocks.push({
              kind: 'questions',
              who,
              ts: item.ts,
              pairs: parsed.questions.map((q) => ({ question: q.text, answer: answerText(item.answers![q.text]) }))
            })
            speaker = `agent:${who}`
          } else if (o.steps) {
            step({ text: `Question ${item.status === 'skipped' ? 'skipped' : 'not answered'}`, error: false })
          }
        } else if (item.toolName === PLAN_TOOL) {
          const plan = parsePlan(item.input).plan
          if (plan !== null) {
            blocks.push({ kind: 'plan', who, ts: item.ts, status: PLAN_STATUS[item.status] ?? item.status, text: plan })
            speaker = `agent:${who}`
          }
        }
        // Other approval cards duplicate their tool's own row.
        break
      }
      default:
        break
    }
  }
  return {
    title: meta.title.trim() || 'Chat',
    subtitle: subtitleOf(meta),
    exported: formatTime(o.now, o.zone),
    zone: o.zone,
    reply: o.item !== null,
    blocks
  }
}

/** Ends a code fence the text left open, so it can't swallow what follows it in the export. */
export function closeFences(text: string): string {
  let open: { ch: string; len: number } | null = null
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    const fence = m[1]!
    if (open === null) {
      // A backtick fence's info string can't hold a backtick.
      if (fence[0] === '`' && m[2]!.includes('`')) continue
      open = { ch: fence[0]!, len: fence.length }
    } else if (fence[0] === open.ch && fence.length >= open.len && m[2]!.trim() === '') {
      open = null
    }
  }
  return open === null ? text : `${text.replace(/\n*$/, '')}\n${open.ch.repeat(open.len)}`
}

/** Plain text that stays plain in Markdown: no emphasis, link, heading or HTML from a title or a name. */
export function mdText(s: string): string {
  return oneLine(s).replace(/[\\`*_[\]<>#|~]/g, '\\$&')
}

/** Inline code holding `s` whatever backticks it has. */
export function mdCode(s: string): string {
  const t = oneLine(s)
  const runs = t.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1)
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${t}${pad}${fence}`
}

const head = (who: string, ts: number, zone: string, tag?: string): string =>
  `**${mdText(who)}** · ${formatTime(ts, zone)}${tag ? ` · ${mdText(tag)}` : ''}`

/** The export as one Markdown file. */
export function toMarkdown(doc: ExportDoc): string {
  const out: string[] = [
    `# ${mdText(doc.title)}`,
    '',
    `${mdText(doc.subtitle)}${doc.reply ? ' · one reply' : ''} · exported ${doc.exported} (${mdText(doc.zone)})`
  ]
  for (const b of doc.blocks) {
    if (b.kind === 'steps') {
      out.push('', ...b.lines.map((l) => `> - ${l.error ? '**Error:** ' : ''}${mdCode(l.text)}`))
      continue
    }
    if (!(b.kind === 'message' && b.more)) out.push('', '---', '')
    else out.push('')
    switch (b.kind) {
      case 'message':
        if (!b.more) out.push(head(b.who, b.ts, doc.zone), '')
        out.push(closeFences(b.text).replace(/\s+$/, ''))
        if (b.files.length > 0) out.push('', `*Attached: ${b.files.map(mdText).join(', ')}*`)
        break
      case 'questions':
        out.push(head(b.who, b.ts, doc.zone, 'asked'), '', ...b.pairs.map((p) => `- **${mdText(p.question)}** ${mdText(p.answer)}`))
        break
      case 'plan':
        out.push(head(b.who, b.ts, doc.zone, `plan, ${b.status}`), '', closeFences(b.text).replace(/\s+$/, ''))
        break
    }
  }
  return out.join('\n') + '\n'
}
