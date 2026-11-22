import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { engineCaps, engineOfAgent, roomRefusal, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { GROUP_MIN_MEMBERS, ROLE_MAX_CHARS, type AgentSummary } from '@zumibot/shared/types'

/** The handles as a de-duplicated string list; throws when the input is not an array of strings. */
export function memberList(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((m) => typeof m === 'string')) throw new TypeError('members must be an array of strings')
  return [...new Set(v as string[])]
}

/** A group role: a string of at most ROLE_MAX_CHARS characters. */
export function groupRole(v: unknown): string {
  if (typeof v !== 'string') throw new TypeError('role must be a string')
  if (v.length > ROLE_MAX_CHARS) throw new Error(`A group role can be at most ${ROLE_MAX_CHARS} characters`)
  return v
}

/** Throws when Zumi Bot is among a new group's members: it only works in its own chat. */
export function refuseZumiBot(members: readonly string[]): void {
  if (members.includes(ZUMI_BOT_NAME)) throw new Error("Zumi Bot can't join a group chat")
}

/** Throws for the first member whose agent runs on Codex, but only while Codex rooms are off (a later probe failed). */
export function refuseCodexMembers(
  members: readonly string[],
  agents: readonly AgentSummary[],
  caps: (e: Engine) => EngineCaps = engineCaps
): void {
  for (const m of members) {
    const engine = engineOfAgent(agents.find((x) => x.name === m))
    if (!caps(engine).rooms) throw new Error(roomRefusal(engine, m))
  }
}

/** A new group's members: enough of them, none Zumi Bot, each an existing agent that loads without error. */
export function validateNewGroupMembers(
  v: unknown,
  agents: readonly AgentSummary[],
  caps: (e: Engine) => EngineCaps = engineCaps
): string[] {
  const members = memberList(v)
  if (members.length < GROUP_MIN_MEMBERS) throw new Error(`A group chat needs at least ${GROUP_MIN_MEMBERS} members`)
  refuseZumiBot(members)
  for (const m of members) {
    const a = agents.find((x) => x.name === m)
    if (!a || a.error) throw new Error(`${m} is not an available agent`)
  }
  refuseCodexMembers(members, agents, caps)
  return members
}
