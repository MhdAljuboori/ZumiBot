import { randomUUID } from 'node:crypto'
import { CLAUDE_CODE_SETTINGS, routinesPath, workflowsPath } from '@zumibot/shared/appPaths'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import { NAME_PATTERN } from '@zumibot/shared/frontmatter'
import { STALE_REFUSED, WRITE_REFUSED } from '@zumibot/shared/automations'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { leadingCommand } from '@zumibot/shared/commands'
import type { Engine, EngineCaps } from '@zumibot/shared/engine'
import type { Routine, RoutineTarget } from '@zumibot/shared/routines'
import { describeSchedule } from '@zumibot/shared/schedule'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import type { Problem } from '@zumibot/shared/workflowGraph'
import { eventLabel } from '@zumibot/shared/workflowEvents'
import type { Workflow } from '@zumibot/shared/workflows'
import type { RoutineEditing } from '../routines/routineEditing'
import type { RoutineStore } from '../routines/routineStore'
import type { ChatStore } from '../store/chatStore'
import type { WorkflowEditing } from '../workflows/workflowEditing'
import type { WorkflowStore } from '../workflows/workflowStore'
import { agentResolver, routineAgents, withRoutineAgents, withWorkflowAgents, workflowAgents } from './agentNames'
import { routineFromAuthoring, routineToAuthoring, said, workflowFromAuthoring, workflowToAuthoring, type AuthoringCtx } from './authoring'
import { chatStepProblem } from '../workflows/workflowAgentSteps'
import { ROOM_NOT_FOUND } from '../workflows/workflowRooms'
import { chatIdFrom, chatTranscript } from './chatTranscript'
import { OBJECT_MAX } from './automationTools'

// One call of Zumi Bot's routine and workflow tools. Saves and deletes go through the same routineEditing and
// workflowEditing the editor's RPCs use, so the two can't drift. Every refusal is a plain sentence the agent can act
// on, and no result ever carries a webhook URL or secret.

/** writable: the turn was sent by the user; a routine run, a limit wait's continue and the like only read. */
export interface AutomationOwner {
  chatId: string
  writable: boolean
}

export type AutomationCall =
  | { op: 'routines_list' }
  | { op: 'routine_get'; id: string }
  | { op: 'routine_save'; routine: unknown }
  | { op: 'routine_delete'; id: string; name: string }
  | { op: 'workflows_list' }
  | { op: 'workflow_get'; id: string }
  | { op: 'workflow_save'; workflow: unknown }
  | { op: 'workflow_delete'; id: string; name: string }
  | { op: 'chat_read'; chat: string }
  | { op: 'skills_list' }
  | { op: 'skill_get'; name: string }
  | { op: 'skill_save'; skill: unknown }

/** The user's Claude Code skills (ExtensionsService, user scope). Errors are EXT_TEXT sentences; no result carries a path. */
export interface AutomationSkills {
  list(): Promise<{ name: string; description: string }[]>
  get(name: string): Promise<{ name: string; description: string; body: string; stamp: string }>
  save(input: { name: string; description: string; body: string; stamp?: string }): Promise<void>
}

export interface AutomationDeps {
  routines: Pick<RoutineStore, 'get' | 'list'>
  workflows: Pick<WorkflowStore, 'get' | 'list'>
  routineEditing: RoutineEditing
  workflowEditing: WorkflowEditing
  /** What keeps a workflow from running or being turned on (WorkflowRunner.problems), for get and list. */
  workflowProblems(w: Pick<Workflow, 'trigger' | 'steps' | 'edges'>): Promise<Problem[]>
  chats: Pick<ChatStore, 'get' | 'loadItems'>
  agents(): Promise<AgentSummary[]>
  /** What each engine can do; the shipped caps when absent. */
  caps?(engine: Engine): EngineCaps
  ctx(): Promise<Omit<AuthoringCtx, 'newId'>>
  /** Absent: the skill tools refuse (a server built without the extensions service). */
  skills?: AutomationSkills
}

const NO_ROUTINE = 'No routine with that id'
const NO_WORKFLOW = 'No workflow with that id'
const NO_CHAT = 'No chat with that id'
const NOT_READ = 'To edit it, read it first and send back the updatedAt it returned.'
const NOT_A_NUMBER = 'updatedAt must be the number the get returned'
// An A→B ask chat takes no message but the asker's (rpc/handlers.ts writable()).
const READ_ONLY_CHAT = 'That chat is read-only: routines cannot post into it'
const SKILLS_OFF = 'Skills are not available here.'
const BAD_SKILL_NAME = 'A skill name may hold only lower-case letters, digits and single hyphens, and be at most 100 characters.'
const NO_SKILL = 'No skill with that name'
const SKILL_SHAPE = 'skill must be {name, description, body, stamp?} with text values'
const SKILL_TOO_LONG = 'The description may be at most 5000 characters.'
const SKILL_TOO_BIG = 'That skill is too long to edit with these tools; the user can change it in Settings.'
const SKILL_NAME_MAX = 100
const SKILL_DESCRIPTION_MAX = 5_000
// Names a plain object would read through its prototype: never a folder.
const PROTO_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const renamed = (stored: string): string => `That id is now named “${said(stored, 100)}”: check with the user.`

const WRITES: ReadonlySet<AutomationCall['op']> = new Set(['routine_save', 'routine_delete', 'workflow_save', 'workflow_delete', 'skill_save'])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const json = (v: unknown): string => JSON.stringify(v)
// ISO: the model reads a date, not a count of milliseconds.
const when = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString())

/**
 * The stored item an edit names, checked against the updatedAt its get returned, so a save never overwrites what the
 * user saved in the editor meanwhile. Null for a create (no id).
 */
async function edited<T extends { updatedAt: number }>(
  raw: unknown,
  get: (id: string) => Promise<T | null>,
  missing: string
): Promise<T | null> {
  if (!isObj(raw) || raw.id === undefined || raw.id === null) return null
  const found = typeof raw.id === 'string' ? await get(raw.id) : null
  if (!found) throw new Error(missing)
  if (raw.updatedAt === undefined || raw.updatedAt === null) throw new Error(NOT_READ)
  // Not "changed meanwhile": a string or the like would read stale forever, and the agent would read it again in vain.
  if (typeof raw.updatedAt !== 'number') throw new Error(NOT_A_NUMBER)
  if (raw.updatedAt !== found.updatedAt) throw new Error(STALE_REFUSED)
  return found
}

/** The store's sentences in the tools' own words: a stale stamp reads as any other stale edit, a missing skill by name. */
async function skillStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const m = err instanceof Error ? err.message : ''
    if (m === EXT_TEXT.stale) throw new Error(STALE_REFUSED)
    if (m === EXT_TEXT.notFound) throw new Error(NO_SKILL)
    throw err
  }
}

const given = (v: unknown): boolean => v !== undefined && v !== null
const blankText = (v: unknown): boolean => !given(v) || (typeof v === 'string' && !v.trim())
/** The stored values under what the agent sent: a key it left out (or sent as null, as a create reads it) keeps its value. */
const under = (stored: Obj, raw: Obj): Obj => ({ ...stored, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => given(v))) })

/**
 * A routine edit with what the agent left out kept from the stored routine; `target` and `trigger` are taken whole.
 * After agent names resolve: a blank folder stays the stored one while the target's kind (and a new chat's agent) is
 * unchanged, as a room's folder never depended on its members; another agent gets its own default. A target sent
 * without `title` or `section` keeps the stored ones; null clears them.
 */
function routineKept(raw: unknown, before: Routine, resolve: (raw: unknown) => unknown): unknown {
  if (!isObj(raw)) return raw
  const merged = resolve(under({ ...routineToAuthoring(before) }, raw))
  // Left out keeps the stored cap; null clears it.
  if (isObj(merged) && raw.spendCap === null) delete merged.spendCap
  if (!isObj(merged) || !isObj(merged.target)) return merged
  const t = merged.target,
    stored = before.target
  if (stored.kind === 'chat' || t.kind !== stored.kind) return merged
  let target = t
  // Left out (not null): the chat title and the room's section stay, since a section is picked in the editor by an id.
  if (stored.title !== undefined && !Object.hasOwn(t, 'title')) target = { ...target, title: stored.title }
  if (stored.kind === 'new-group' && stored.section !== undefined && !Object.hasOwn(t, 'section'))
    target = { ...target, section: stored.section }
  if (blankText(t.cwd) && !(stored.kind === 'new-chat' && t.agent !== stored.agent)) target = { ...target, cwd: stored.cwd }
  return target === t ? merged : { ...merged, target }
}

/**
 * A workflow edit keeps its stored name, switch, time zone, spend cap and run settings when left out (null clears the
 * cap; 'wait' and 'run-once' clear a setting), and an existing step its blank folder.
 */
function workflowKept(raw: unknown, before: Workflow): unknown {
  if (!isObj(raw)) return raw
  const merged = under(
    {
      name: before.name,
      enabled: before.enabled,
      timeZone: before.timeZone,
      ...(before.spendCap !== undefined ? { spendCap: before.spendCap } : {}),
      ...(before.limitPolicy ? { limitPolicy: before.limitPolicy } : {}),
      ...(before.missedPolicy ? { missedPolicy: before.missedPolicy } : {})
    },
    raw
  )
  if (raw.spendCap === null) delete merged.spendCap
  if (!Array.isArray(merged.steps)) return merged
  // An agent or For each step's folder, and a room built from agents' (a template room has none).
  const folderKind = (k: unknown): 'agent' | 'room' | null => (k === 'agent' || k === 'foreach' ? 'agent' : k === 'room' ? 'room' : null)
  const folders = new Map(
    before.steps.flatMap((s) => {
      const kind = folderKind(s.kind)
      return kind && 'cwd' in s && typeof s.cwd === 'string' ? [[`${kind}:${s.handle}`, s.cwd] as const] : []
    })
  )
  // Only onto a step that still takes a folder: any other kind refuses a cwd field, and a template room one too.
  const steps = merged.steps.map((s) => {
    if (!isObj(s) || typeof s.handle !== 'string' || !blankText(s.cwd) || (s.kind === 'room' && !given(s.members))) return s
    const kind = folderKind(s.kind)
    const cwd = kind ? folders.get(`${kind}:${s.handle}`) : undefined
    return cwd === undefined ? s : { ...s, cwd }
  })
  return { ...merged, steps }
}

function scheduleText(trigger: Routine['trigger'] | Workflow['trigger'], timeZone: string): string {
  if (trigger.kind === 'manual') return 'Manual'
  if (trigger.kind === 'webhook') return 'condition' in trigger && trigger.condition ? 'Webhook, with a condition' : 'Webhook'
  if (trigger.kind !== 'schedule') return eventLabel(trigger.kind)
  return `${describeSchedule(trigger.schedule)} (${timeZone})`
}

// Handles, not ids: they are what the authoring format names steps by.
function problemTexts(w: Pick<Workflow, 'steps'>, problems: Problem[]): string[] {
  const handles = new Map(w.steps.map((s) => [s.id, s.kind === 'trigger' ? 'trigger' : s.handle]))
  return problems.map((p) => {
    const handle = p.stepId === null ? undefined : handles.get(p.stepId)
    return handle === undefined ? p.text : `Step "${handle}": ${p.text}`
  })
}

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name)

export class AutomationService {
  constructor(private readonly d: AutomationDeps) {}

  async run(owner: AutomationOwner, call: AutomationCall): Promise<string> {
    // First, before any lookup: a turn the user did not send learns nothing from a write either.
    if (WRITES.has(call.op) && !owner.writable) throw new Error(WRITE_REFUSED)
    switch (call.op) {
      case 'routines_list':
        return json(await this.routinesList())
      case 'routine_get': {
        const r = await this.routine(call.id)
        return json({ ...routineToAuthoring(r), path: routinesPath({ id: r.id }) })
      }
      case 'routine_save':
        return json(await this.routineSave(call.routine))
      case 'routine_delete':
        return json(await this.routineDelete(call.id, call.name))
      case 'workflows_list':
        return json(await this.workflowsList())
      case 'workflow_get':
        return json(await this.workflowGet(call.id))
      case 'workflow_save':
        return json(await this.workflowSave(call.workflow))
      case 'workflow_delete':
        return json(await this.workflowDelete(call.id, call.name))
      case 'chat_read': {
        const meta = await this.chat(call.chat)
        return chatTranscript(meta, await this.d.chats.loadItems(meta.id))
      }
      case 'skills_list':
        return json(await this.skills().list())
      case 'skill_get': {
        const text = json(await skillStep(() => this.skills().get(call.name)))
        // What skill_save could never take back is not handed out, and a huge answer would close the bridge's socket.
        if (Buffer.byteLength(text) > OBJECT_MAX) throw new Error(SKILL_TOO_BIG)
        return text
      }
      case 'skill_save':
        return json(await this.skillSave(call.skill))
    }
  }

  private skills(): AutomationSkills {
    if (!this.d.skills) throw new Error(SKILLS_OFF)
    return this.d.skills
  }

  /** A create (no stamp) never overwrites; an edit needs the stamp skill_get returned, so the user's own edits are never lost. */
  private async skillSave(raw: unknown) {
    const skills = this.skills()
    if (!isObj(raw) || !Object.keys(raw).every((k) => ['name', 'description', 'body', 'stamp'].includes(k))) throw new Error(SKILL_SHAPE)
    const { name, description, body, stamp } = raw
    if (typeof name !== 'string' || typeof description !== 'string' || typeof body !== 'string') throw new Error(SKILL_SHAPE)
    if (stamp !== undefined && typeof stamp !== 'string') throw new Error(SKILL_SHAPE)
    if (!NAME_PATTERN.test(name) || name.length > SKILL_NAME_MAX || PROTO_NAMES.has(name)) throw new Error(BAD_SKILL_NAME)
    if (description.length > SKILL_DESCRIPTION_MAX) throw new Error(SKILL_TOO_LONG)
    await skillStep(() => skills.save({ name, description, body, ...(stamp === undefined ? {} : { stamp }) }))
    return { name, created: stamp === undefined, path: CLAUDE_CODE_SETTINGS }
  }

  private async routine(id: string): Promise<Routine> {
    const r = await this.d.routines.get(id)
    if (!r) throw new Error(NO_ROUTINE)
    return r
  }

  private async workflow(id: string): Promise<Workflow> {
    const w = await this.d.workflows.get(id)
    if (!w) throw new Error(NO_WORKFLOW)
    return w
  }

  /** A chat named by its id or an app address holding one. */
  private async chat(text: string): Promise<ChatMeta> {
    const id = chatIdFrom(text)
    const meta = id === null ? null : await this.d.chats.get(id)
    if (!meta) throw new Error(NO_CHAT)
    return meta
  }

  private async authoringCtx(): Promise<AuthoringCtx> {
    return { ...(await this.d.ctx()), newId: () => randomUUID() }
  }

  private async targetText(t: RoutineTarget): Promise<string> {
    if (t.kind === 'new-chat') return `New chat with @${t.agent}`
    if (t.kind === 'new-group') return `New room with ${t.members.map((m) => `@${m}`).join(', ')}`
    const meta = await this.d.chats.get(t.chatId)
    if (!meta) return `Chat ${t.chatId} (deleted)`
    return `${isGroup(meta) ? 'Room' : 'Chat'} "${meta.title}" (${t.chatId})`
  }

  private async routinesList() {
    const rows = (await this.d.routines.list()).sort(byName)
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        timeZone: r.timeZone,
        trigger: scheduleText(r.trigger, r.timeZone),
        target: await this.targetText(r.target),
        nextRunAt: when(r.nextRunAt),
        path: routinesPath({ id: r.id })
      }))
    )
  }

  private async routineSave(raw: unknown) {
    const before = await edited(raw, (id) => this.d.routines.get(id), NO_ROUTINE)
    // Names resolve before the conversion: it fills a missing folder from the agent's name. On an edit, what the agent
    // left out keeps the stored value; the create-time defaults are for a create only.
    const resolver = agentResolver(await this.d.agents(), before ? routineAgents(before) : undefined, this.d.caps)
    const resolve = (r: unknown) => withRoutineAgents(r, resolver)
    const authored = before ? routineKept(raw, before, resolve) : resolve(raw)
    let input = routineFromAuthoring(authored, await this.authoringCtx())
    if (input.target.kind === 'chat') {
      const meta = await this.chat(input.target.chatId)
      if (meta.asked) throw new Error(READ_ONLY_CHAT)
      input = { ...input, target: { kind: 'chat', chatId: meta.id } }
    }
    // The authoring format has no command pick: the editor's one stays while the prompt still starts with its name,
    // or a room would no longer know whose command it is.
    const pick = before?.command
    if (pick && leadingCommand(input.prompt)?.name === pick.name) input = { ...input, command: pick }
    // Again, just before writing: the user may have saved in the editor while this was converted.
    if (before) await edited(raw, (id) => this.d.routines.get(id), NO_ROUTINE)
    const saved = await this.d.routineEditing.save(input, { webhookWithoutSample: true, source: 'zumi-bot' })
    return {
      id: saved.id,
      name: saved.name,
      enabled: saved.enabled,
      timeZone: saved.timeZone,
      nextRunAt: when(saved.nextRunAt),
      path: routinesPath({ id: saved.id })
    }
  }

  private async routineDelete(id: string, name: string) {
    const r = await this.routine(id)
    // The card showed `name`: a rename since means the user approved deleting something else.
    if (r.name !== name) throw new Error(renamed(r.name))
    await this.d.routineEditing.remove(id)
    return { deleted: r.name }
  }

  private async workflowsList() {
    const rows = (await this.d.workflows.list()).sort(byName)
    return Promise.all(
      rows.map(async (w) => ({
        id: w.id,
        name: w.name,
        enabled: w.enabled,
        timeZone: w.timeZone,
        trigger: scheduleText(w.trigger, w.timeZone),
        steps: w.steps.filter((s) => s.kind !== 'trigger').length,
        problems: problemTexts(w, await this.d.workflowProblems(w)),
        nextRunAt: when(w.nextRunAt),
        path: workflowsPath(w.id)
      }))
    )
  }

  private async workflowGet(id: string) {
    const w = await this.workflow(id)
    const authored = workflowToAuthoring(w)
    // A Room step's title, so Zumi Bot can name the room; null once the room is gone.
    const steps = await Promise.all(
      authored.steps.map(async (s) => {
        if (s.kind !== 'room') return s
        if (s.members) return s // built from agents: there is no template room to name
        const meta = s.room ? await this.d.chats.get(s.room) : null
        return { ...s, roomTitle: meta && isGroup(meta) ? meta.title : null }
      })
    )
    return { ...authored, steps, problems: problemTexts(w, await this.d.workflowProblems(w)), path: workflowsPath(w.id) }
  }

  private async workflowSave(raw: unknown) {
    const before = await edited(raw, (id) => this.d.workflows.get(id), NO_WORKFLOW)
    const resolved = withWorkflowAgents(
      before ? workflowKept(raw, before) : raw,
      agentResolver(await this.d.agents(), before ? workflowAgents(before) : undefined, this.d.caps)
    )
    // Canvas notes and groups are drawn by hand and not part of the authoring format: an edit keeps the user's own.
    const authored = workflowFromAuthoring(resolved, before, await this.authoringCtx())
    await this.checkTargets(authored, before)
    const input = before ? { ...authored, notes: before.notes ?? [], groups: before.groups ?? [] } : authored
    if (before) await edited(raw, (id) => this.d.workflows.get(id), NO_WORKFLOW)
    const { workflow: w, problems } = await this.d.workflowEditing.save(input, { ensureHook: true, source: 'zumi-bot' })
    return {
      id: w.id,
      name: w.name,
      enabled: w.enabled,
      timeZone: w.timeZone,
      nextRunAt: when(w.nextRunAt),
      problems: problemTexts(w, problems),
      path: workflowsPath(w.id)
    }
  }

  /**
   * A Room step must name a room that exists, and a Chat step a chat the editor would accept (its own refusal texts). One
   * the workflow already held is left alone: the user may have deleted or changed it since.
   */
  private async checkTargets(input: { steps: Workflow['steps'] }, before: Workflow | null): Promise<void> {
    for (const s of input.steps) {
      if (s.kind === 'room' && !s.members) {
        if (before?.steps.some((o) => o.kind === 'room' && o.id === s.id && o.room === s.room)) continue
        const meta = s.room ? await this.d.chats.get(s.room) : null
        if (!meta || !isGroup(meta)) throw new Error(ROOM_NOT_FOUND)
      } else if (s.kind === 'chat' && s.chat) {
        if (before?.steps.some((o) => o.kind === 'chat' && o.id === s.id && o.chat === s.chat)) continue
        const problem = chatStepProblem(await this.d.chats.get(s.chat), await this.d.agents(), ZUMI_BOT_NAME)
        if (problem) throw new Error(problem)
      }
    }
  }

  private async workflowDelete(id: string, name: string) {
    const w = await this.workflow(id)
    if (w.name !== name) throw new Error(renamed(w.name))
    await this.d.workflowEditing.remove(id)
    return { deleted: w.name }
  }
}
