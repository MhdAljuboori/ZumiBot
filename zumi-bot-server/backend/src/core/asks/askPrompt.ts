import { ASK_REPLY_MAX, ASK_SIDE_NAME, ASK_TOOL } from '@zumibot/shared/agentAsk'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { engineCaps, isRemoteAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { AgentSummary } from '@zumibot/shared/types'

// Same text on every turn, so the prompt cache holds; only the roster below it changes, and only when the agents do.
const ASK_PARAGRAPH = [
  `You can ask the user's other agents for help with the ${ASK_TOOL} tool (agent: their handle, message: what they should do). It waits for the other agent to finish and gives you its last reply.`,
  "- Use it when the user's message @mentions another agent and asks for its help, or when the work clearly belongs to another agent.",
  '- The other agent sees only your message, not this chat: include what it needs (links, ids, file paths, the issue itself).',
  '- Its reply may end with questions. If you know the answers, ask the same agent again. Otherwise ask the user (with AskUserQuestion if you have it), then pass the answer on.',
  "- Tell the user briefly what the other agent did. Don't paste its whole reply unless it is short.",
  "- Don't ask an agent to do what you can do yourself.",
  `- To check something with an agent you already asked from this chat, while it works or after, use ${ASK_SIDE_NAME}: it answers from what it already knows there, without tools, and its work keeps going.`
].join('\n')

const DESCRIPTION_MAX = 200

/** The agents `agent` may ask, sorted so the roster in the system prompt (and its cache) does not move with directory order. A remote agent is never one: it would be sent the other agent's message and chat. */
export function askRoster(
  agents: readonly AgentSummary[],
  agent: string,
  caps: (e: Engine) => EngineCaps = engineCaps
): { name: string; description: string }[] {
  return agents
    .filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME && a.name !== agent && !isRemoteAgent(a, caps))
    .map((a) => ({ name: a.name, description: a.description }))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
}

/** The fixed ask paragraph and the roster of agents A may ask; '' when there is nobody to ask. */
export function askSystem(roster: readonly { name: string; description: string }[]): string {
  if (roster.length === 0) return ''
  const lines = roster.map((a) => {
    const first =
      a.description
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim()
        .slice(0, DESCRIPTION_MAX) ?? ''
    return first ? `- @${a.name}: ${first}` : `- @${a.name}`
  })
  return [ASK_PARAGRAPH, 'Agents you can ask:', ...lines].join('\n')
}

/** B's paragraph in a chat made by an ask; the title is user text, so it stays one line and cannot close its quotes. */
export function askedSystem(by: string, fromTitle: string): string {
  const title = fromTitle.replace(/\s+/g, ' ').replace(/"/g, "'").trim() || 'New chat'
  return [
    `You are being asked by the agent @${by}, who is working for the user in their chat "${title}".`,
    'The user does not read this chat live and cannot answer you here. If you need anything, end your reply with your questions: @' +
      by +
      ' will answer them or ask the user.',
    `Your last message is all @${by} gets back, so make it complete.`
  ].join('\n')
}

export const QUESTIONS_DENIED = (by: string): string => `Ask your question at the end of your reply; @${by} will answer or ask the user.`

// Each sentence is shown to the asking agent through the IPC's filter (SAFE_ASK_MESSAGE): letters, digits, space and . , : ; ' ( ) { } ? @ _ - only, under 400.
const SENTENCE_MAX = 350
const word = (name: string): string => name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60)
const hh = (n: number): string => String(n).padStart(2, '0')
function untilTime(resetsAt: number | null): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return ' for now'
  const d = new Date(resetsAt)
  return Number.isNaN(d.getTime()) ? ' for now' : ` until ${hh(d.getUTCHours())}:${hh(d.getUTCMinutes())} UTC`
}

function unknown(handles: readonly string[]): string {
  const head = 'No agent has that name.'
  const usable = handles.filter((h) => /^[A-Za-z0-9_.-]{1,60}$/.test(h))
  if (usable.length === 0) return `${head} There is no other agent you can ask.`
  let out = `${head} Agents you can ask: `
  let cut = false
  for (let i = 0; i < usable.length; i++) {
    const piece = `${i > 0 ? ', ' : ''}@${usable[i]}`
    // Room for the closing note too, so a cut list still fits the filter's limit.
    if (out.length + piece.length + ', and more.'.length > SENTENCE_MAX) {
      cut = true
      break
    }
    out += piece
  }
  return cut ? `${out}, and more.` : `${out}.`
}

export const REFUSAL = Object.freeze({
  unknown,
  zumiBot: 'That agent cannot be asked.',
  self: 'You cannot ask yourself. Do the work yourself.',
  remote: (name: string) => `@${word(name)} runs on a remote server, so it cannot be asked.`,
  inChain: (name: string) => `@${word(name)} is already waiting for your answer in this chain, so it cannot be asked.`,
  tooDeep: 'This chain of asks is too long. Do the work yourself or tell the user.',
  perTurn: 'You have used all the asks you can make in one turn. Tell the user what is left.',
  parallel: 'Too many asks are running at once. Wait for one to finish, then ask again.',
  busy: (name: string) => `@${word(name)} is still answering an earlier message from this chat. Try again when it is done.`,
  broken: (name: string) => `@${word(name)} cannot run because its agent file does not load.`,
  limited: (name: string, resetsAt: number | null) => `@${word(name)} hit its usage limit and cannot answer${untilTime(resetsAt)}.`,
  failed: (name: string) => `@${word(name)} could not finish. The user can open the conversation to see why.`,
  stopped: (name: string) => `The ask to @${word(name)} was stopped.`,
  stopping: 'ZumiBot is stopping, so no agent can be asked now.',
  noText: (name: string) => `@${name} finished without writing a reply.`,
  noConversation: (name: string) => `You have not asked @${word(name)} from this chat yet, so there is no conversation to ask about.`,
  sideLimit: (name: string) => `@${word(name)} already has 3 side questions running. Wait for one to finish.`,
  sideTimeout: (name: string) => `The side question to @${word(name)} took too long.`,
  sideFailed: (name: string) => `@${word(name)} could not answer the side question.`,
  sideStopped: (name: string) => `The side question to @${word(name)} was stopped.`,
  sideNoText: (name: string) => `@${word(name)} finished without writing an answer.`,
  sideRunAsk: `Side answers cannot ask an agent to do work. Use ${ASK_SIDE_NAME}.`,
  // Appended to a successful reply, so it is not subject to the filter.
  cut: `\n\n[Reply cut at ${ASK_REPLY_MAX} characters.]`
})
