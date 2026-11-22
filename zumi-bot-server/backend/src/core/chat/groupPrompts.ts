import { displayName } from '@zumibot/shared/frontmatter'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { parseQuestions, QUESTION_TOOL, type Question } from '@zumibot/shared/questions'
import {
  PASS_MARKER,
  type Attachment,
  type ChatItem,
  type QueueReason,
  type QuestionAnswers,
  type RoomHandoff
} from '@zumibot/shared/types'
import { OMITTED, SEED_MAX_CHARS } from './seedPrompt'

export { PASS_MARKER }

export interface MemberInfo {
  name: string
  description: string
}
/** from null = the user. */
export interface ThreadEntry {
  from: string | null
  text: string
  attachments?: Attachment[] // a user message's files
}
/**
 * answer: the first member picked to reply to a user message that mentions nobody or is for @everyone; like user and agent, it may not pass.
 * everyone: any other member an @everyone message adds; it may pass. note: the moderator's word for this member only.
 * Defined in shared, since a paused room stores the reasons of its queued members.
 */
export type TurnReason = QueueReason

// A closing tag inside the note could end the block early and pass the rest off as instructions.
function handoffSection(h: RoomHandoff): string {
  const text = h.text.replace(/<\/handoff>/gi, '<\\/handoff>')
  return [
    `This room continues work from an earlier room, "${h.from.title}". The user reviewed this handoff note for you. Treat it as background: what the user says in this room wins over it.`,
    `<handoff>\n${text}\n</handoff>`
  ].join('\n')
}

export function buildBriefing(me: string, members: readonly MemberInfo[], cwd: string, role: string, handoff?: RoomHandoff): string {
  const roster = members.map((m) => `- @${m.name} (${displayName(m.name)}): ${m.description}`).join('\n')
  return [
    `You are @${me}, one of the members of a group chat with the user. The members are:`,
    roster,
    `Everyone works in the same folder: ${cwd}`,
    'Stick to your own role. When work belongs to another member, hand it over by @mentioning their handle in your message. Never run another member as a subagent.',
    'Only @mention a member when you need it to do something now. To agree with, thank or refer to a member, write its name without the @: every @mention makes that member take a turn.',
    'Other members see only your final message, so put everything they need in it.',
    'When you are done and nobody else needs to act, mention nobody.',
    ...(role.trim() ? [`The user set this role for the group. Follow it for who does what and who waits for whom:\n${role}`] : []),
    ...(handoff ? [handoffSection(handoff)] : []),
    'Other members may be working at the same time as you, in the same folder. Only change files that belong to your own part.',
    'When you and another member judged the same thing and your answers differ, discuss it with them by @mentioning them until you agree. If you still disagree after 3 rounds each, stop and write to the user with both answers and your reasons, and mention nobody.'
  ].join('\n\n')
}

// No `@`, so it never reads as a mention. Answers are joined with ', ' for a multi-select question.
function answersText(agent: string, questions: readonly Question[], answers: QuestionAnswers): string {
  const body = questions
    .map((q) => `${q.text}\n→ ${Array.isArray(answers[q.text]) ? (answers[q.text] as string[]).join(', ') : answers[q.text]}`)
    .join('\n\n')
  return `Answers to ${agent}'s questions:\n\n${body}`
}

export function threadEntries(items: readonly ChatItem[], afterId: string | null, me: string): ThreadEntry[] {
  const idx = afterId === null ? -1 : items.findIndex((i) => i.id === afterId)
  const out: ThreadEntry[] = []
  for (const item of items.slice(idx + 1)) {
    if ('turn' in item && item.turn) continue
    if (item.type === 'user')
      out.push({ from: null, text: item.text, ...(item.attachments?.length ? { attachments: item.attachments } : {}) })
    else if (item.type === 'assistant' && item.agent && item.agent !== me) out.push({ from: item.agent, text: item.text })
    else if (item.type === 'approval' && item.toolName === QUESTION_TOOL && item.status === 'answered' && item.agent && item.agent !== me) {
      const parsed = parseQuestions(item.input)
      if (parsed && item.answers) out.push({ from: null, text: answersText(item.agent, parsed.questions, item.answers) })
    } else if (item.type === 'approval' && item.toolName === PLAN_TOOL && item.agent && item.agent !== me) {
      // The plan body stays out, to keep prompts small. No `@`, so it never reads as a mention.
      if (item.status === 'approved') out.push({ from: null, text: `Approved ${item.agent}'s plan.` })
      else if (item.status === 'sent-back')
        out.push({ from: null, text: `Sent ${item.agent}'s plan back${item.feedback ? `: ${item.feedback}` : '.'}` })
    }
  }
  return out
}

const REAL_REPLY = 'Give a real reply.'

function reasonLines(reason: TurnReason): string[] {
  // The user's requests always get a reply, though the session may remember the marker from an earlier pass.
  // Another member's mention may only refer to this one, so it may pass.
  switch (reason.kind) {
    case 'user':
      return ['The user mentioned you', REAL_REPLY]
    case 'agent':
      return [`You were mentioned by @${reason.by}`, `If it asks nothing of you, reply with exactly ${PASS_MARKER}.`]
    case 'answer':
      return ["The user's message is for the group; please answer it.", REAL_REPLY]
    case 'everyone':
      return ["The user's message is for everyone in the group.", `If it asks nothing of you, reply with exactly ${PASS_MARKER}.`]
    case 'moderator':
      return ['The moderator thinks you should weigh in', `If you have nothing important to add, reply with exactly ${PASS_MARKER}.`]
  }
}

/**
 * The thread messages, then why it is this member's turn. Capped like a seed's history: over maxChars, the newest
 * messages that fit follow the omission marker. The reason lines and the newest message always stay.
 * attachments are those of the user messages that stayed, in thread order.
 */
export function buildTurnMessage(
  entries: readonly ThreadEntry[],
  reason: TurnReason,
  maxChars = SEED_MAX_CHARS
): { text: string; attachments: Attachment[] } {
  const lines = threadLines(entries)
  const tail = [...reasonLines(reason), ...(reason.note ? [`Note from the moderator: ${reason.note}`] : [])]
  // Lengths include the newline before each line; the marker counts only while something older is left out.
  let start = Math.max(lines.length - 1, 0)
  let used = tail.join('\n').length + lines.slice(start).reduce((n, l) => n + 1 + l.length, 0)
  while (start > 0 && used + 1 + lines[start - 1].length + (start > 1 ? OMITTED.length + 1 : 0) <= maxChars) {
    used += 1 + lines[start - 1].length
    start--
  }
  const text = [...(start > 0 ? [OMITTED] : []), ...lines.slice(start), ...tail].join('\n')
  return { text, attachments: entries.slice(start).flatMap((e) => (e.from === null ? (e.attachments ?? []) : [])) }
}

export function threadLines(entries: readonly ThreadEntry[]): string[] {
  return entries.map((e) =>
    e.from === null
      ? `<message from="user">${e.text}</message>`
      : `<message from="${e.from}" name="${displayName(e.from)}">${e.text}</message>`
  )
}

export function isPass(text: string): boolean {
  return text.trim() === PASS_MARKER
}
