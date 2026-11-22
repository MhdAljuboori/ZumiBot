import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { SentCommand } from '@zumibot/shared/commands'
import { capRefusal, engineCaps, ENGINES, roomRefusal, todoRefusal, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { displayName } from '@zumibot/shared/frontmatter'
import { findMentions, mentionsEveryone, stripMentions } from '@zumibot/shared/mentions'
import { RESUME_TEXT } from '@zumibot/shared/pause'
import {
  GROUP_HOP_CAP,
  GROUP_MIN_MEMBERS,
  NOTICE_TEXT,
  isGroup,
  type AgentRename,
  type AgentSummary,
  type ChatItem,
  type ChatMeta,
  type ChatPush,
  type ContextUse,
  type GroupInfo,
  type NoticeKind,
  type Attachment,
  type PausedRoom,
  type QueueEntry,
  type WorkflowSent
} from '@zumibot/shared/types'
import { groupRole } from '../groupMembers'
import type { PickInput } from '../btw/sidePicker'
import { unseenEntries } from '../btw/sidePrompt'
import type { ChatFiles } from '../attachments/attachmentStore'
import { addDirArgs, imageBlocks, refsOf, withImages, withNotes } from '../attachments/content'
import type { ChatStore } from '../store/chatStore'
import {
  compactPrompt,
  NOTHING_TO_COMPACT,
  pausedText,
  type ChatService,
  type ItemsRef,
  type Running,
  type TurnResult,
  type TurnSpec
} from './chatService'
import { buildBriefing, buildTurnMessage, isPass, threadEntries, type MemberInfo, type ThreadEntry, type TurnReason } from './groupPrompts'
import { planQueue, readyEntries, renamePaused, renameReason, type ModeratorAnswer } from './groupQueue'
import type { ModeratorInput } from './moderator'
import { repliedItem, withReplies } from './reply'
import { asksTodos, withCommands } from './commandText'
import { buildSeedPrompt, makeTitle } from './seedPrompt'
import { droppedMembers, engineField, enginesAfter, memberStartsBefore, withSessionEngines } from './sessionPoints'
import type { RoomTurnEnd } from './readMarks'
import { branch, type UserItem } from './versions'
import { workflowSystem } from '../workflows/workflowPrompt'
import { maskInputBlocks } from '@zumibot/shared/workflowTemplate'

export interface GroupServiceDeps {
  store: ChatStore
  chats: ChatService
  files: ChatFiles
  agents(): Promise<AgentSummary[]>
  moderate(input: ModeratorInput, cwd: string, signal: AbortSignal, chatId: string): Promise<ModeratorAnswer | null>
  push(p: ChatPush): void
  now(): number
  newId(): string
  disallowedToolsFor(agentName: string): string[]
  // ChatService's engine lookup: each member's turn, Compact and side answer runs on its own agent's engine. Absent: every
  // member is Claude's.
  engineOf?(agent: string): Promise<Engine>
  // What each engine can do (default engineCaps). While Codex rooms are off, a member on Codex is refused (refuseCodex).
  caps?(engine: Engine): EngineCaps
  /**
   * Once per member turn, after its items are in the thread and saved; never for Compact. A throw never reaches the
   * room. ChatService's own hook fires before `endTurn` decides what the turn leaves, so a room needs this one.
   */
  onTurnEnd?(e: RoomTurnEnd): void
}

type GroupMeta = ChatMeta & { group: GroupInfo }

/**
 * A posted message the moderator has not routed yet. lastId is its last item: the moderator's view of the thread ends there.
 * replyTo: the id of the member message the user's message replies to.
 * commandAgent: the agent of the user's command, routed as if the user had mentioned it.
 * restore: Resume's message: what the room saved when it paused; its waiting turns are queued again once it is routed.
 */
// material: a workflow Chat step's message, whose <input> blocks hold untrusted text that never addresses a member.
interface InboxEntry {
  text: string
  speaker: string | null
  lastId: string
  replyTo?: string
  commandAgent?: string
  restore?: PausedRoom
  material?: true
}

/** A member's turn in progress. */
interface Work {
  turn: string // stamped on its live items
  startId: string | null // side answers must not repeat what this turn already read
  since: number
  muted: boolean // it was working when another turn failed: its turn is posted, its reply not routed
  compacting: boolean // the CLI is compacting its context
}

/** What a turn needs, taken in the tick it starts. */
interface TurnStart {
  member: string
  work: Work
  reason: TurnReason
  items: ChatItem[] // the item list when it started
  agents: readonly AgentSummary[]
}

interface Room {
  r: Running
  ref: ItemsRef
  inbox: InboxEntry[]
  routing: InboxEntry | null // the message the moderator is routing now
  cancel: (() => void) | null // aborts the moderator call in progress
  // The queue and the working members live here while the room runs; the store gets a copy for the app.
  queue: QueueEntry[]
  working: Map<string, Work> // by member name
  reasons: Map<string, TurnReason> // why each queued member gets its turn
  hops: number // agent turns started since the user's last message
  lastAgent: string | null
  // The message that opened the room was no one's typing (a routine's or workflow's), and nobody has typed into it since:
  // member turns run auto, so a connector write is refused. A user's message into the open room ends it.
  unattended: boolean
  halted: boolean // a turn failed: nothing starts, and no member's reply is routed, until a user message is
  // Pause: nothing starts and no member's reply is routed while the members at work wrap up; the room then ends paused.
  // A message being routed still gets its plan, and the queue is kept for Resume.
  pausing: boolean
  pausedMembers: string[] // working when Pause was pressed: Resume addresses them
  settled: boolean // the end has read whether a pause lands: a Pause from here on is too late for this room
  // Resume's messages not routed yet (a Stop may take them out of the inbox): the room's end must not leave their saved
  // state behind.
  unrestored: Set<InboxEntry>
  noticed: boolean // a turn recorded the stop
  // Set in the same tick the loop decides to end, so a later send waits for this room and starts a new one.
  closing: boolean
  wake: (() => void) | null // the loop waiting for a turn to end or a message to be posted
  woken: boolean // a wake that came while the loop was busy: its next wait returns at once
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
// A chat deleted mid-run is not an error.
const chatGone = (e: unknown) => e instanceof Error && (e.message.startsWith('Chat not found') || e.message.startsWith('Not a group chat'))

async function finishStep(errors: unknown[], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (!chatGone(e)) errors.push(e)
  }
}

// A member can take turns while its agent file exists and loads; a broken duplicate of the name does not count.
const loadable = (agents: readonly AgentSummary[], name: string) => agents.find((a) => a.name === name && a.error === null)

const availableOf = (members: readonly string[], agents: readonly AgentSummary[]) =>
  members.filter((n) => loadable(agents, n) !== undefined)

const memberInfo = (names: readonly string[], agents: readonly AgentSummary[]): MemberInfo[] =>
  names.map((name) => ({ name, description: loadable(agents, name)?.description ?? '' }))

// Live items belong to a turn still running, not to the thread.
const isLive = (i: ChatItem) => 'turn' in i && i.turn !== undefined

function unstamp(i: ChatItem): ChatItem {
  if (!('turn' in i)) return i
  const { turn: _turn, ...plain } = i
  return plain as ChatItem
}

/** Items up to and including the one with this id; all of them when it is gone. */
function upTo(items: readonly ChatItem[], id: string): ChatItem[] {
  const at = items.findIndex((i) => i.id === id)
  return at < 0 ? [...items] : items.slice(0, at + 1)
}

/**
 * The history restored for a member whose session expired: everything except the messages its
 * turn message already carries (those after its seen item, from the user or another member).
 * Other members' tool rows are left out too: seed entries for tools carry no author, so they would read as its own.
 * So are other turns still running: they are not in the thread yet.
 */
function seedHistory(history: readonly ChatItem[], seenId: string | null, me: string): ChatItem[] {
  const seenAt = seenId === null ? -1 : history.findIndex((i) => i.id === seenId)
  const inPrompt = (i: ChatItem) => i.type === 'user' || (i.type === 'assistant' && !!i.agent && i.agent !== me)
  return history.filter((i, at) => !isLive(i) && (at <= seenAt || !inPrompt(i)) && !(i.type === 'tool' && i.agent !== me))
}

/** The items with each rename applied in order to their authors; untouched items keep their identity. */
function renameAuthors(items: ChatItem[], renames: readonly AgentRename[]): ChatItem[] {
  let out = items
  for (const { from, to } of renames) {
    out = out.map((i) =>
      'agent' in i && i.agent === from
        ? i.type === 'browser-action'
          ? { ...i, agent: to, handoff: { ...i.handoff, agent: to } }
          : { ...i, agent: to }
        : i
    )
    // `end.agent` stamps the turn's author on any item type, so a rename follows it too.
    out = out.map((i) => (i.end?.agent === from ? { ...i, end: { ...i.end, agent: to } } : i))
    // A user item's command names its agent too.
    out = out.map((i) => (i.type === 'user' && i.command?.agent === from ? { ...i, command: { ...i.command, agent: to } } : i))
  }
  return out
}

/** The group's `next` after a member's session was saved: a real session ends its start point, a null one asks to seed. */
function nextAfterSession(next: GroupInfo['next'], member: string, id: string | null): GroupInfo['next'] {
  const { [member]: _gone, ...rest } = next ?? {}
  if (id === null) return { ...rest, [member]: { seed: true } }
  return Object.keys(rest).length > 0 ? rest : undefined
}

// A member's saved session carries the engine that made it, so the other engine's CLI is never handed it; a Claude session
// (or none) has no mark.
function savedSession(g: GroupInfo, member: string, id: string | null, engine: Engine): GroupInfo {
  const point = { sessionId: id, next: null, ...engineField(engine) }
  return withSessionEngines(
    { ...g, sessions: { ...g.sessions, [member]: id }, next: nextAfterSession(g.next, member, id) },
    enginesAfter(g.sessionEngines, { [member]: point })
  )
}

// Resume ran, or the user took over: the turns a pause saved are no longer wanted.
const unpaused = ({ paused: _gone, ...g }: GroupInfo): GroupInfo => g

const lastAgentIn = (items: readonly ChatItem[]): string | null => {
  for (let k = items.length - 1; k >= 0; k--) {
    const i = items[k]
    if (i.type === 'assistant' && i.agent) return i.agent
  }
  return null
}

/** Runs group chats: one room loop per running group, sharing ChatService's running map and turns. */
export class GroupService {
  private rooms = new Map<string, Room>()
  private locks = new Map<string, Promise<unknown>>()
  // Every agent rename so far, oldest first: work that read a name before one follows it to the new name.
  private renames: AgentRename[] = []

  constructor(private d: GroupServiceDeps) {}

  private caps(engine: Engine): EngineCaps {
    return (this.d.caps ?? engineCaps)(engine)
  }

  /** A to-do request goes to every member that answers, so one member without ZumiBot's to-do tools refuses it (before the room is claimed or anything is stored). */
  private async refuseTodo(members: readonly string[]): Promise<void> {
    for (const m of members) {
      const engine = await this.engineOf(m)
      if (!this.caps(engine).bridges) throw new Error(todoRefusal(engine, m))
    }
  }

  private engineOf(member: string): Promise<Engine> {
    return this.d.engineOf ? this.d.engineOf(member) : Promise.resolve('claude')
  }

  /**
   * While Codex rooms are off (a later probe failed), a member whose agent is on Codex takes no turn, Compact or side answer
   * here, rather than run on Claude with a Codex model and body. Throws the fixed sentence, before anything starts.
   */
  async refuseCodex(member: string): Promise<void> {
    if (ENGINES.every((e) => this.caps(e).rooms) || !this.d.engineOf) return
    this.refuseOn(member, await this.d.engineOf(member))
  }

  /** refuseCodex for an engine already looked up, so a turn reads it once. */
  private refuseOn(member: string, engine: Engine): void {
    if (!this.caps(engine).rooms) throw new Error(roomRefusal(engine, member))
  }

  /** A side answer needs only the room entries its member has not read. */
  async sideThread(chatId: string, member: string): Promise<ThreadEntry[]> {
    const { group } = await this.groupMeta(chatId)
    const room = this.rooms.get(chatId)
    const items = room ? room.ref.get() : await this.d.store.loadItems(chatId)
    const work = room?.working.get(member)
    return unseenEntries(items, work ? work.startId : (group.seen[member] ?? null), member)
  }

  /** Include live room text so the picker can choose who knows the answer. */
  async pickInput(chatId: string, question: string): Promise<PickInput> {
    const { group } = await this.groupMeta(chatId)
    const agents = await this.d.agents()
    const available = availableOf(group.members, agents)
    const room = this.rooms.get(chatId)
    const items = room ? room.ref.get() : await this.d.store.loadItems(chatId)
    return {
      members: memberInfo(available, agents),
      messages: unseenEntries(items, null, ''),
      working: room ? [...room.working.keys()] : [],
      question
    }
  }

  /** Posts the message, starting the room when it is idle. Resolves once the message is posted, not when the room idles. */
  /** replyTo: the id of the member message this one replies to; an id that is not one is ignored. */
  /** messageId: the id the client shows the message under; a new one when an item already has it. */
  /** command: the resolved command the text starts with; its agent reads the prompt and counts as mentioned. */
  /** todo: the text began with /todo or used a command that makes to-dos; every member that answers it is asked for a list. */
  /** auto: no one typed the message (a routine's or workflow's); the room's member turns are unattended until the user types into it. */
  send(
    chatId: string,
    text: string,
    attachments: Attachment[] = [],
    replyTo?: string,
    messageId?: string,
    command?: SentCommand,
    todo?: true,
    workflowSent?: WorkflowSent,
    auto?: true
  ): Promise<void> {
    return this.serial(chatId, () => this.post(chatId, text, attachments, replyTo, messageId, command, todo, workflowSent, auto))
  }

  /**
   * Runs a message again as a new version (text = the edit, null = Resend) and rewinds every member to where it stood
   * just before the message. The moderator then routes the new version like a new message. Resolves once it is posted,
   * like send. Rejects, leaving the chat as it was, when the room is busy, the id is unknown or the edit is empty.
   */
  rerun(chatId: string, userId: string, text: string | null, command?: SentCommand, todo?: true): Promise<void> {
    return this.serial(chatId, () => this.rerunPost(chatId, userId, text, command, todo))
  }

  /**
   * Pause, once TaskQueue has stored the pausing state, written the flag and held the tray: nothing new starts and no
   * member's reply is routed while the members at work wrap up, then the room ends paused, saving who worked and what
   * waited. False when no room runs: one still opening reads the stored state as it starts. False too once a room has
   * settled its end: its release wakes TaskQueue's pump, which lands the stored pause under the chat's lock, so no Edit
   * can save between its read and its write of the items.
   */
  requestPause(chatId: string): boolean {
    const room = this.rooms.get(chatId)
    if (!room || room.settled) return false
    this.markPausing(room)
    return true
  }

  /**
   * Resume of a paused room (TaskQueue has cleared the paused state): posts `@m1 @m2 … Continue` to the members that were
   * working, as the user, and once it is routed queues the turns that waited again. Resolves once it is posted, like send.
   * messageId: the id the post gets (a new one when an item already has it), so a routine run can follow it.
   */
  resume(chatId: string, messageId?: string): Promise<void> {
    return this.serial(chatId, async () => {
      const since = this.renames.length
      const { group } = await this.groupMeta(chatId)
      const saved = group.paused ?? { members: [], queue: [] }
      // A member that left the room meanwhile is not addressed; its queued turn is left out when it is routed.
      const members = saved.members.filter((m) => group.members.includes(m))
      const text = [...members.map((m) => `@${m}`), RESUME_TEXT].join(' ')
      await this.post(chatId, text, [], undefined, messageId, undefined, undefined, undefined, undefined, { saved, since })
    })
  }

  setMembers(chatId: string, members: string[]): Promise<ChatMeta> {
    return this.serial(chatId, async () => {
      const meta = await this.groupMeta(chatId)
      const next = [...new Set(members)]
      if (next.length < GROUP_MIN_MEMBERS) throw new Error(`A group chat needs at least ${GROUP_MIN_MEMBERS} members`)
      if (next.includes(ZUMI_BOT_NAME)) throw new Error("Zumi Bot can't join a group chat")
      const agents = await this.d.agents()
      // A member whose agent file is gone may stay until it is removed; a new one must be an agent.
      const unknown = next.filter((n) => !meta.group.members.includes(n) && !agents.some((a) => a.name === n))
      if (unknown.length > 0) throw new Error(`Not an agent: ${unknown.join(', ')}`)
      if (this.d.chats.isRunning(chatId)) throw new Error("Members can't change while the group is working")
      const keep = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => next.includes(k)))
      return this.updateGroup(chatId, (g) => ({
        ...g,
        members: next,
        sessions: keep(g.sessions),
        seen: keep(g.seen),
        ...(g.context ? { context: keep(g.context) } : {}),
        ...(g.sessionEngines ? { sessionEngines: keep(g.sessionEngines) } : {}),
        queue: g.queue.filter((e) => next.includes(e.agent)).map((e) => ({ ...e, after: e.after.filter((n) => next.includes(n)) }))
      }))
    })
  }

  /**
   * Compacts one member's Claude session (/compact, the note says what to keep) while the room is idle, showing the
   * member as working meanwhile. Adds no items unless it fails.
   */
  compact(chatId: string, member: string, note: string): Promise<void> {
    return this.serial(chatId, () => this.compactMember(chatId, member, note))
  }

  /** Saves the group's role. Allowed while members work: only turns and moderator calls that start later read it. */
  setRole(chatId: string, role: string): Promise<ChatMeta> {
    return this.serial(chatId, async () => {
      groupRole(role)
      await this.groupMeta(chatId)
      return this.updateGroup(chatId, (g) => ({ ...g, role }))
    })
  }

  /**
   * Moves the running rooms to an agent's new name: item authors, the queue, working members, queued reasons, the last
   * speaker, posted messages not routed yet and the members a pause stopped. Call it before ChatStore.renameAgent
   * rewrites the stored chats, so no room saves the old names back.
   */
  renameAgent(from: string, to: string): void {
    if (from === to) return
    this.renames.push({ from, to })
    const rn = (n: string) => (n === from ? to : n)
    for (const room of this.rooms.values()) {
      room.ref.set(renameAuthors(room.ref.get(), [{ from, to }]))
      room.queue = room.queue.map((e) => ({ agent: rn(e.agent), after: e.after.map(rn) }))
      room.working = new Map([...room.working].map(([n, w]) => [rn(n), w]))
      room.reasons = new Map([...room.reasons].map(([n, why]): [string, TurnReason] => [rn(n), renameReason(why, rn)]))
      room.lastAgent = room.lastAgent === null ? null : rn(room.lastAgent)
      room.pausedMembers = room.pausedMembers.map(rn)
      // A set: an entry can be both in the inbox and waiting to restore, and must be renamed once.
      for (const e of new Set([...room.inbox, ...(room.routing ? [room.routing] : []), ...room.unrestored])) {
        e.speaker = e.speaker === null ? null : rn(e.speaker)
        if (e.commandAgent !== undefined) e.commandAgent = rn(e.commandAgent)
        if (e.restore) e.restore = renamePaused(e.restore, rn)
      }
    }
  }

  /** A name as it is now, following the renames made after the rename log had `since` entries. */
  private follow(since: number, name: string): string {
    return this.renames.slice(since).reduce((n, r) => (n === r.from ? r.to : n), name)
  }

  // Sends, member changes and role changes of one chat run one at a time.
  private serial<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(chatId) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => {})
    this.locks.set(chatId, tail)
    void tail.then(() => {
      if (this.locks.get(chatId) === tail) this.locks.delete(chatId)
    })
    return run
  }

  /** resume: Resume's message, with what its pause saved, by the names agents had when the rename log was `since` long. */
  private async post(
    chatId: string,
    text: string,
    attachments: Attachment[],
    replyTo: string | undefined,
    messageId: string | undefined,
    command: SentCommand | undefined,
    todo: true | undefined,
    workflowSent: WorkflowSent | undefined,
    auto: true | undefined,
    resume?: { saved: PausedRoom; since: number }
  ): Promise<void> {
    const { store, push, now, newId } = this.d
    if (text.trim() === '' && attachments.length === 0) throw new Error('Message is empty')
    const meta = await this.groupMeta(chatId)
    if (asksTodos({ todo, command })) await this.refuseTodo(meta.group.members)
    // The user wrote instead of pressing Resume: they took over, so the turns the pause saved are dropped.
    if (!resume && meta.group.paused) await this.updateGroup(chatId, unpaused)
    const agents = await this.d.agents()
    // Join the running room, unless it is winding down (ending or stopped): then wait for it and start a new one.
    let room: Room | undefined
    for (;;) {
      const cur = this.rooms.get(chatId)
      if (!cur) break
      if (!cur.closing && !cur.r.reason) {
        room = cur
        break
      }
      await cur.r.done
    }
    const fresh = room === undefined
    if (!room) room = await this.open(chatId)
    // The message that opens the room decides; a later one keeps it unattended only when it is no one's typing too.
    room.unattended = (fresh || room.unattended) && auto === true

    // From here to the inbox push nothing awaits, so the loop sees the item and the entry together.
    const { members } = meta.group
    const quoted = repliedItem(room.ref.get(), replyTo)?.id
    const taken = messageId === undefined || room.ref.get().some((i) => i.id === messageId)
    const user: ChatItem = {
      type: 'user',
      id: taken ? newId() : messageId,
      text,
      ts: now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(quoted ? { replyTo: quoted } : {}),
      ...(command ? { command } : {}),
      ...(todo ? { todo } : {}),
      ...(workflowSent ? { workflowSent } : {})
    }
    // A workflow room's (or a workflow-sent message's) <input> blocks are material, so an @mention inside one neither routes nor gets a notice.
    const missing = findMentions(meta.workflow || workflowSent ? maskInputBlocks(text) : text, members).filter(
      (n) => loadable(agents, n) === undefined
    )
    room.ref.set([...room.ref.get(), user, ...missing.map((n) => this.unavailable(n))])
    const restore = resume && renamePaused(resume.saved, (n) => this.follow(resume.since, n))
    const entry: InboxEntry = {
      text,
      speaker: null,
      lastId: user.id,
      ...(quoted ? { replyTo: quoted } : {}),
      ...(command ? { commandAgent: command.agent } : {}),
      ...(restore ? { restore } : {}),
      ...(workflowSent ? { material: true as const } : {})
    }
    if (restore) room.unrestored.add(entry)
    const saved = this.enter(chatId, room, fresh, entry)
    await saved
    if (meta.title === '') {
      const title = makeTitle(stripMentions(text, members) || attachments[0]?.name || '')
      if (title !== '') push({ chatId, kind: 'meta', meta: await store.update(chatId, { title }) })
    }
  }

  /**
   * Enters a user item already added to the room's items: restarts a room a failure halted, resets the turn count, puts
   * the message in the inbox and starts the room or wakes it. Saves and pushes the items; the caller awaits the save.
   * Nothing awaits before the inbox push, so the loop sees the item and the entry together.
   */
  private enter(chatId: string, room: Room, fresh: boolean, entry: InboxEntry): Promise<void> {
    room.hops = 0
    room.halted = false
    room.inbox.push(entry)
    const saved = this.d.store.saveItems(chatId, [...room.ref.get()])
    this.d.push({ chatId, kind: 'items', items: [...room.ref.get()], clearStreaming: false })
    if (fresh) this.start(chatId, room)
    else this.wake(room)
    return saved
  }

  private async rerunPost(
    chatId: string,
    userId: string,
    text: string | null,
    command: SentCommand | undefined,
    todo: true | undefined
  ): Promise<void> {
    const { store, now, newId } = this.d
    // A fast failure only: everything that matters is read again once the chat is claimed.
    if (this.d.chats.isRunning(chatId)) throw new Error('Chat is busy')
    const agents = await this.d.agents()
    const since = this.renames.length
    const room = await this.open(chatId) // claims the chat, so it fails when something else holds it
    // Renames since the claim reached no room (this one is not registered yet): follow them by hand, as `open` does.
    const rn = (n: string) => this.follow(since, n)
    // Set once the branched items are stored; cleared when updateGroup has moved the sessions to match.
    let restore: ChatItem[] | null = null
    try {
      // Read after the claim: a switch or rename that ran before it is already in the store.
      const meta = await this.groupMeta(chatId)
      const stored = renameAuthors(room.ref.get(), this.renames.slice(since))
      const members = meta.group.members.map(rn)
      const old = stored.find((i): i is UserItem => i.type === 'user' && i.id === userId)
      if (!old) throw new Error('Message not found')
      const body = text ?? old.text
      if (body.trim() === '' && !old.attachments?.length) throw new Error('Message is empty')
      const user: UserItem = {
        type: 'user',
        id: newId(),
        text: body,
        ts: now(),
        ...(old.attachments?.length ? { attachments: old.attachments } : {}),
        ...(old.replyTo ? { replyTo: old.replyTo } : {}),
        // Only the command resolved for this version: the old one stays with the old version.
        ...(command ? { command } : {}),
        // Resend keeps the flag the message had; an edit has its own, or none.
        ...((text === null ? old.todo : todo) ? { todo: true as const } : {}),
        // Resend keeps the workflow that sent it; an edit is the user's own text.
        ...(text === null && old.workflowSent ? { workflowSent: old.workflowSent } : {})
      }
      if (asksTodos(user)) await this.refuseTodo(members)
      const b = branch(stored, await store.loadVersions(chatId), userId, user)
      const at = b.items.length - 1
      const quoted = repliedItem(b.items.slice(0, at), old.replyTo)?.id
      const missing = findMentions(meta.workflow || user.workflowSent ? maskInputBlocks(body) : body, members).filter(
        (n) => loadable(agents, n) === undefined
      )
      // The point comes from the branched list; what each member's session still holds after it is only visible in `stored`,
      // so the turns this rewind discards are read there (droppedMembers).
      const points = memberStartsBefore(
        b.items,
        at,
        members,
        droppedMembers(
          stored,
          stored.findIndex((i) => i.id === userId),
          members
        )
      )
      const next = Object.fromEntries(Object.entries(points).flatMap(([m, p]) => (p.next ? [[rn(m), p.next]] : [])))
      const keyed = <T>(pick: (p: (typeof points)[string]) => T) =>
        Object.fromEntries(Object.entries(points).map(([m, p]) => [rn(m), pick(p)]))
      // Same order as a single chat: versions, then items, then the sessions, so a crash never loses a version.
      await store.saveVersions(chatId, b.versions)
      const shown = [...b.items, ...missing.map((n) => this.unavailable(n))]
      room.ref.set(shown)
      restore = stored
      await store.saveItems(chatId, [...shown])
      // An edit instead of Resume is the user taking over, as a new message is: the turns a pause saved are dropped.
      // Each member's mark follows the stamp it rewinds to, so a Codex member forks its thread and a Claude one cuts its session.
      await this.updateGroup(chatId, (g) =>
        withSessionEngines(
          {
            ...unpaused(g),
            sessions: { ...g.sessions, ...keyed((p) => p.sessionId) },
            seen: { ...g.seen, ...keyed((p) => p.seen) },
            next,
            queue: [],
            active: [],
            context: undefined // it described the version the members leave
          },
          enginesAfter(g.sessionEngines, points, rn)
        )
      )
      restore = null
      // In the same tick as `enter`, so the loop sees the final items. The hidden tail's last speaker must not steer routing.
      room.ref.set(renameAuthors(room.ref.get(), this.renames.slice(since)))
      room.lastAgent = lastAgentIn(room.ref.get())
      await this.enter(chatId, room, true, {
        text: body,
        speaker: null,
        lastId: user.id,
        ...(quoted ? { replyTo: quoted } : {}),
        ...(command ? { commandAgent: command.agent } : {}),
        ...(user.workflowSent ? { material: true as const } : {})
      })
    } catch (e) {
      // Not started: the chat goes idle again. Once the room runs, its loop does this itself.
      if (this.rooms.get(chatId) !== room) {
        // Branched items are stored but the members' sessions and `seen` still point into the hidden tail: put the
        // old version back, so they agree again. A failed save here leaves the branched items; nothing more to do.
        if (restore) {
          room.ref.set(restore)
          await this.d.store.saveItems(chatId, [...restore]).catch(() => {})
          this.d.push({ chatId, kind: 'items', items: [...restore], clearStreaming: true })
        }
        try {
          this.d.push({ chatId, kind: 'meta', meta: await this.d.store.update(chatId, { inFlight: false }) })
        } catch {
          /* chat gone */
        }
        this.d.chats.release(chatId, room.r)
      }
      throw e
    }
  }

  private async compactMember(chatId: string, member: string, note: string): Promise<void> {
    const { store, push } = this.d
    const g = (await this.groupMeta(chatId)).group
    if (!g.members.includes(member)) throw new Error(`Not a member: ${member}`)
    const engine = await this.engineOf(member)
    this.refuseOn(member, engine)
    const caps = this.caps(engine)
    if (!caps.compact) throw new Error(capRefusal(engine, 'compact'))
    const session = g.sessions[member] ?? null
    const start = g.next?.[member]
    // A session the other engine made is nothing this CLI can compact, as in a single chat.
    const stale = (g.sessionEngines?.[member] ?? 'claude') !== engine
    // Without rewinds a cut point is never forked: the next turn reseeds, so nothing of this session is left to compact.
    const cutGone = !caps.rewind && start !== undefined && 'at' in start
    if (session === null || stale || cutGone || (start !== undefined && 'seed' in start)) throw new Error(NOTHING_TO_COMPACT)
    const r = this.d.chats.claim(chatId) // fails while the room, or anything else, holds the chat
    const since = this.renames.length
    const me = () => this.follow(since, member)
    const errors: unknown[] = []
    try {
      let items = [...(await store.loadItems(chatId))]
      await this.updateGroup(chatId, (x) => ({
        ...x,
        active: [{ agent: me(), turn: this.d.newId(), since: this.d.now(), compacting: true }]
      }))
      push({ chatId, kind: 'meta', meta: await store.update(chatId, { inFlight: true }) })
      const prompt = compactPrompt(note)
      await this.d.chats.agentTurn(
        chatId,
        r,
        {
          agentName: member,
          sessionId: session,
          prompt,
          seedPrompt: () => prompt,
          extraArgs: [],
          disallowedTools: [...this.d.disallowedToolsFor(member), ...g.members.filter((n) => n !== member).map((n) => `Agent(${n})`)],
          get author() {
            return me()
          },
          allowScope: `${chatId}:${member}`,
          saveSession: async (id) => {
            await this.updateGroup(chatId, (x) => savedSession(x, me(), id, engine))
          },
          resumeAt: start && 'at' in start ? start.at : undefined,
          ...(start && 'at' in start && start.drops !== undefined ? { resumeDrops: start.drops } : {}),
          ...(engine === 'claude' ? {} : { engine }),
          compact: true,
          window: g.context?.[member]?.window ?? null,
          saveContext: (c) => this.saveContext(chatId, me(), c),
          // Only for a cut compact to clear: a compact is never told.
          ...(g.lost?.[member]?.length ? { lost: g.lost[member] } : {}),
          saveLost: (lost) => this.saveLost(chatId, me(), lost)
        },
        {
          get: () => items,
          set: (next) => {
            items = next
          }
        }
      )
    } catch (e) {
      if (!chatGone(e)) errors.push(e)
    } finally {
      await finishStep(errors, async () => {
        await this.updateGroup(chatId, (x) => ({ ...x, active: [] }))
      })
      await finishStep(errors, async () => {
        push({ chatId, kind: 'meta', meta: await store.update(chatId, { inFlight: false }) })
      })
      this.d.chats.release(chatId, r)
    }
    if (errors.length > 0) throw errors[0]
  }

  private saveContext(chatId: string, member: string, c: ContextUse): Promise<ChatMeta> {
    return this.updateGroup(chatId, (x) => ({ ...x, context: { ...x.context, [member]: c } }))
  }

  // In place, as a single chat's: bookkeeping must not move the room in the list. The key goes once no member has any.
  private saveLost(chatId: string, member: string, lost: string[] | null): Promise<unknown> {
    return this.d.store.patchInPlace(chatId, (cur) => {
      if (!cur.group) return null
      const { lost: all, ...g } = cur.group
      const { [member]: had, ...rest } = all ?? {}
      if (lost === null && had === undefined) return null
      const next = lost === null ? rest : { ...rest, [member]: lost }
      return { group: Object.keys(next).length > 0 ? { ...g, lost: next } : g }
    })
  }

  /** Claims the chat and loads its items; the caller starts the loop. */
  private async open(chatId: string): Promise<Room> {
    const { store, push } = this.d
    const r = this.d.chats.claim(chatId)
    try {
      const since = this.renames.length
      let items = [...(await store.loadItems(chatId))]
      push({ chatId, kind: 'meta', meta: await store.update(chatId, { inFlight: true }) })
      // An agent renamed meanwhile reached no room (this one is not running yet), so its new name is applied here.
      items = renameAuthors(items, this.renames.slice(since))
      return {
        r,
        ref: {
          get: () => items,
          set: (next) => {
            items = next
          }
        },
        inbox: [],
        routing: null,
        cancel: null,
        queue: [],
        working: new Map(),
        reasons: new Map(),
        hops: 0,
        lastAgent: lastAgentIn(items),
        unattended: false,
        halted: false,
        pausing: false,
        pausedMembers: [],
        settled: false,
        unrestored: new Set(),
        noticed: false,
        closing: false,
        wake: null,
        woken: false
      }
    } catch (e) {
      this.d.chats.release(chatId, r)
      throw e
    }
  }

  private start(chatId: string, room: Room): void {
    this.rooms.set(chatId, room)
    // Stop clears the queue (a pausing room keeps it for Resume) and inbox at once, so nothing waits while the working
    // members wind down.
    room.r.onStop = () => {
      this.clearPlans(room)
      room.cancel?.()
      this.wake(room)
    }
    room.r.done = this.loop(chatId, room)
  }

  /** Runs the room to the end, then always leaves the chat idle, saved and released. Never rejects. */
  private async loop(chatId: string, room: Room): Promise<void> {
    const { store, push } = this.d
    try {
      // A Pause pressed while the room was being opened found no room to tell; it is stored before it asks for one.
      if ((await store.get(chatId))?.pause === 'pausing') this.markPausing(room)
      await this.schedule(chatId, room)
    } catch (e) {
      // Nothing new starts; the room ends once the members still working finish.
      room.closing = true
      if (!chatGone(e)) this.add(room, { type: 'error', id: this.d.newId(), text: errorText(e), ts: this.d.now() })
      this.halt(room)
      await this.drain(room)
    }
    const errors: unknown[] = []
    try {
      room.closing = true
      room.settled = true
      room.inbox.length = 0
      if (room.r.reason && !room.noticed) this.add(room, this.notice(room.r.reason))
      // However the room ended (wrapped up, Stop, a failure), a Pause lands here, before release, whose idle would start
      // a held task. The stored state decides: a Pause is stored before the room hears of it.
      let landed = null as ChatMeta | null
      await finishStep(errors, async () => {
        landed = await this.d.chats.landPause(chatId)
      })
      // Read after the await, so a rename meanwhile is in. A Resume's message never routed (a Stop, a failure) left its
      // saved turns unqueued: paused again, they are saved again; otherwise they go, as the rest of the plans do.
      const unrestored = [...room.unrestored]
      const paused = landed ? this.pausedState(room, unrestored, landed.group?.members ?? []) : null
      room.reasons.clear()
      // After whatever ended the turns (their stopped notices, an error), in the list the room saves, so no save drops it.
      if (landed) this.add(room, this.notice('userPaused', pausedText(landed)))
      let meta = landed
      await finishStep(errors, async () => {
        meta = await store.updateGroup(chatId, (g) => ({
          ...(paused ? { ...g, paused } : unrestored.length > 0 ? unpaused(g) : g),
          active: [],
          queue: []
        }))
      })
      await finishStep(errors, async () => {
        meta = await store.update(chatId, { inFlight: false })
      })
      await finishStep(errors, () => store.saveItems(chatId, [...room.ref.get()]))
      push({ chatId, kind: 'items', items: [...room.ref.get()], clearStreaming: true })
      if (meta) push({ chatId, kind: 'meta', meta })
      if (landed) await finishStep(errors, () => this.d.chats.setPauseFlag(chatId, false))
    } catch (e) {
      errors.push(e)
    } finally {
      this.d.chats.release(chatId, room.r)
      if (this.rooms.get(chatId) === room) this.rooms.delete(chatId)
    }
    for (const e of errors) console.error('finishing a group chat run failed:', e)
  }

  /**
   * Starts every ready member and routes posted messages one at a time while turns run, until nothing is working and
   * nothing is left to start or route. Turns wake it when they end, and so do posted messages.
   */
  private async schedule(chatId: string, room: Room): Promise<void> {
    for (;;) {
      if (room.r.reason) {
        room.closing = true
        await this.sync(chatId, room) // the queue Stop cleared, or kept for a pausing room's Resume
        await this.drain(room)
        return
      }
      await this.startReady(chatId, room) // starts nothing while halted or pausing
      if (room.r.reason) continue
      // After a failure only the user's messages are left; routing one restarts the room.
      const entry = room.inbox.shift()
      if (entry) {
        await this.route(chatId, room, entry)
        continue
      }
      if (room.working.size === 0) {
        // A pausing room ends with its queue still in it: the end saves the queue for Resume.
        if (room.halted || room.queue.length === 0 || room.pausing) {
          room.closing = true
          return
        }
        // Loops back: the room ends unless the user posted meanwhile, which resets the count.
        if (room.hops >= GROUP_HOP_CAP) await this.hopPause(chatId, room)
        // A turn that ended while the room was busy made an entry ready: start it the normal way.
        else if (readyEntries(room.queue, new Set(), new Set()).length > 0) continue
        // Nothing runs, yet every entry waits: a wait the queue planner should have broken. Better to run than to stall.
        else await this.startReady(chatId, room, true)
        continue
      }
      await this.nextWake(room)
    }
  }

  /**
   * Starts every entry that is ready, while the cap allows; with `first`, only the first entry, whatever it waits for.
   * An entry whose agent was deleted, or stopped loading, after it was queued leaves with a notice instead.
   */
  private async startReady(chatId: string, room: Room, first = false): Promise<void> {
    const ready = (): QueueEntry[] => {
      if (room.r.reason || room.halted || room.pausing || room.hops >= GROUP_HOP_CAP) return []
      if (first) return room.queue.slice(0, 1)
      const unrouted = [...room.inbox, ...(room.routing ? [room.routing] : [])].flatMap((e) => (e.speaker === null ? [] : [e.speaker]))
      return readyEntries(room.queue, new Set(room.working.keys()), new Set(unrouted))
    }
    if (ready().length === 0) return
    const agents = await this.d.agents()
    let started = false
    let gone = false
    // From the readiness check to marking a member working nothing awaits.
    for (let next = ready(); next.length > 0; next = first ? [] : ready()) {
      for (const e of next) {
        if (room.hops >= GROUP_HOP_CAP) break
        room.queue = room.queue.filter((q) => q !== e)
        if (loadable(agents, e.agent) === undefined) {
          room.reasons.delete(e.agent)
          this.add(room, this.unavailable(e.agent))
          gone = true
        } else {
          this.startTurn(chatId, room, e.agent, agents)
          started = true
        }
      }
    }
    if (started || gone) await this.sync(chatId, room)
    if (gone) await this.saveAndPush(chatId, room, false)
  }

  /** Marks the member working and runs its turn alongside the others; the turn wakes the loop when it ends. */
  private startTurn(chatId: string, room: Room, member: string, agents: readonly AgentSummary[]): void {
    const work: Work = { turn: this.d.newId(), startId: null, since: this.d.now(), muted: false, compacting: false }
    room.working.set(member, work)
    room.hops++
    const reason = room.reasons.get(member) ?? { kind: 'moderator' }
    room.reasons.delete(member)
    void this.runTurn(chatId, room, { member, work, reason, items: room.ref.get(), agents })
  }

  private async runTurn(chatId: string, room: Room, t: TurnStart): Promise<void> {
    const { member: m, work, reason, items, agents } = t
    // The member's name now: its agent may be renamed while the turn runs.
    const since = this.renames.length
    const me = () => this.follow(since, m)
    // The member sees the thread as it was when its turn started; turns that finish meanwhile reach it next turn.
    const thread = items.filter((i) => !isLive(i))
    const startId = thread.length > 0 ? thread[thread.length - 1].id : null
    work.startId = startId
    let res: TurnResult = { text: '', ok: false, stopped: true, end: null }
    let ran = false
    let prevSeen: string | null = null // what the member had seen before this turn: kept when the turn does not move it
    try {
      // The stored names are the ones `m` had when the turn started: this read joins the store's FIFO in the tick the
      // turn starts, so it runs before any later rename's store.renameAgent (index.ts and ipc.ts call
      // groupService.renameAgent and store.renameAgent in one tick).
      const meta = await this.groupMeta(chatId)
      // Per turn, as a single chat reads it: a member whose agent changed engine runs on the new one from its next turn.
      const engine = await this.engineOf(m)
      // Thrown here, the refusal is this turn's error item, as a missing CLI's is.
      if (!room.r.reason) this.refuseOn(m, engine)
      if (!room.r.reason) {
        const g = meta.group
        const seenId = g.seen[m] ?? null
        prevSeen = seenId
        const start = g.next?.[m]
        // A session the other engine made means nothing to this engine's CLI: this member alone starts fresh from the room's
        // history (expired notice), so a thread id never reaches claude --resume, nor a Claude session id codex.
        const session = g.sessions[m] ?? null
        const stale = session !== null && (g.sessionEngines?.[m] ?? 'claude') !== engine
        const pathOf = (a: Attachment) => this.d.files.pathOf(chatId, a)
        // Only the command's owner reads its prompt; the moderator and other members read what the user typed.
        const turn = buildTurnMessage(
          threadEntries(withNotes(withReplies(withCommands(items, m, this.caps(engine).bridges)), pathOf), seenId, m),
          reason
        )
        const blocks = await imageBlocks(refsOf(turn.attachments, pathOf))
        const available = availableOf(g.members, agents)
        // Asked for a list when any message it has not seen yet began with /todo (or used a command that makes to-dos).
        const unseen = items.slice(seenId === null ? 0 : items.findIndex((i) => i.id === seenId) + 1)
        const todoAsked = unseen.some((i) => i.type === 'user' && i.todo === true)
        const spec: TurnSpec = {
          agentName: m,
          sessionId: stale ? null : session,
          prompt: withImages(turn.text, blocks),
          seedPrompt: (history) =>
            withImages(
              buildSeedPrompt(
                withNotes(seedHistory(withReplies(withCommands(history, m, this.caps(engine).bridges)), seenId, m), pathOf),
                turn.text
              ),
              blocks
            ),
          // A workflow room's paragraph leads the briefing, joined as app.ts's side base joins them (same cache prefix).
          systemPrompt: [
            meta.workflow ? workflowSystem(meta.workflow.name) : '',
            buildBriefing(m, memberInfo(available, agents), meta.cwd, g.role, g.handoff)
          ]
            .filter(Boolean)
            .join('\n\n'),
          extraArgs: addDirArgs(items, this.d.files.dirOf(chatId)),
          disallowedTools: [...this.d.disallowedToolsFor(m), ...g.members.filter((n) => n !== m).map((n) => `Agent(${n})`)],
          get author() {
            return me()
          },
          turnId: work.turn,
          allowScope: `${chatId}:${m}`,
          // A saved session ends the member's start point; null (a reseed) leaves the next turn seeding again if this one fails early.
          saveSession: async (id) => {
            await this.updateGroup(chatId, (x) => savedSession(x, me(), id, engine))
          },
          resumeAt: !stale && start && 'at' in start ? start.at : undefined,
          ...(!stale && start && 'at' in start && start.drops !== undefined ? { resumeDrops: start.drops } : {}),
          reseed: stale || (start !== undefined && 'seed' in start),
          // A Codex member's room briefing (systemPrompt) leads its baseInstructions after the agent's body, as Claude's appends it.
          ...(engine === 'claude' ? {} : { engine }),
          ...(start !== undefined && 'fresh' in start ? { freshStart: true } : {}),
          // Answering (not Skipping) a question, or deciding a plan, counts as the user taking part, like posting a message.
          onAnswered: () => {
            room.hops = 0
          },
          window: g.context?.[m]?.window ?? null,
          saveContext: (c) => this.saveContext(chatId, me(), c),
          // Per member: what a stop killed in one member's turn is told to that member only.
          ...(g.lost?.[m]?.length ? { lost: g.lost[m] } : {}),
          saveLost: (lost) => this.saveLost(chatId, me(), lost),
          setCompacting: (on) => {
            work.compacting = on
            return this.sync(chatId, room)
          },
          ...(todoAsked ? { todoAsked } : {}),
          ...(room.unattended ? { auto: true as const } : {}),
          // The turn end says it is a workflow's, so it notifies nobody (a Room step's run reports for itself); a kept room notifies.
          ...(meta.workflow && !meta.workflow.keep ? { workflow: true as const } : {})
        }
        // Before any request of the turn: the room's Room-step rules decide its permission requests without a card.
        if (meta.workflow) this.d.chats.noteWorkflowRules(chatId, meta.workflowRules ?? [])
        ran = true
        res = await this.d.chats.agentTurn(chatId, room.r, spec, room.ref)
        if (res.stopped) room.noticed = true
      }
    } catch (e) {
      res = { text: '', ok: false, stopped: false, end: null }
      if (!chatGone(e)) this.add(room, { type: 'error', id: this.d.newId(), text: errorText(e), ts: this.d.now(), turn: work.turn })
    }
    await this.endTurn(chatId, room, t, res, ran ? startId : null, me(), prevSeen)
  }

  /**
   * Appends the ended turn to the thread in one piece and puts its reply in the inbox, unless it passed, failed or was
   * stopped; a failure halts the room. Then saves, pushes and wakes the loop. `seenId` is null when it saw nothing new.
   */
  private async endTurn(
    chatId: string,
    room: Room,
    t: TurnStart,
    res: TurnResult,
    seenId: string | null,
    me: string,
    prevSeen: string | null
  ): Promise<void> {
    const { work, reason } = t
    // Decided in the tick the turn ends, before anything else can post.
    const ofTurn = (i: ChatItem) => 'turn' in i && i.turn === work.turn
    const all = room.ref.get()
    let own = all.filter(ofTurn).map(unstamp)
    // After an error the member may not have done what it was asked, so a later "@m try again" still carries the
    // request; a turn the user stopped has seen it.
    const errored = !res.ok && !res.stopped
    const replied = res.ok && !res.stopped && !room.r.reason
    // Only a turn the user asked for must reply; a step-in or another member's mention may pass.
    const passed = replied && (reason.kind === 'moderator' || reason.kind === 'agent' || reason.kind === 'everyone') && isPass(res.text)
    if (passed) {
      // A pass leaves nothing behind, not even its tool rows, unless the turn asked for an approval: then its tool rows
      // and approval cards stay on record, and only the pass reply goes.
      const asked = own.some((i) => i.type === 'approval' || (i.type === 'tool' && i.blocked))
      own = own.filter((i) => i.type !== 'assistant' && (asked || (i.type !== 'tool' && i.type !== 'thinking')))
    }
    // The turn's last item records where its session ended and what the member has seen then, so a rewind to just
    // after it can restore both. A pass that left no items stamps nothing: the next start point is an earlier pair.
    if (res.end && own.length > 0) {
      const seen = errored || seenId === null ? prevSeen : seenId
      // `sent` rides beside it, as in a single chat: the id this member's own prompt went out under, which a later rewind of
      // this member declares as the turn it discards (see docs/architecture/edit-resend-fork.md).
      own = [...own.slice(0, -1), { ...own[own.length - 1], end: { ...res.end, agent: me, seen }, ...(res.sent ? { sent: res.sent } : {}) }]
    }
    room.ref.set([...all.filter((i) => !ofTurn(i)), ...own])
    if (errored) {
      this.halt(room) // the moderator does not run on partial text
    } else if (replied && !passed) {
      room.lastAgent = me
      const reply = own.filter((i) => i.type === 'assistant').pop()
      // A pausing room routes no reply: routing one would only plan more work. A cap stop ends as a reply too.
      if (reply && !work.muted && !room.pausing && res.text.trim() !== '')
        room.inbox.push({ text: res.text, speaker: me, lastId: reply.id })
    }
    for (const [name, w] of room.working) if (w === work) room.working.delete(name)
    try {
      const seen = errored || seenId === null ? null : seenId
      await Promise.all([
        this.sync(chatId, room, (g) => (seen === null ? g : { ...g, seen: { ...g.seen, [me]: seen } })),
        this.saveAndPush(chatId, room, true, me)
      ])
    } catch (e) {
      if (!chatGone(e)) {
        this.add(room, { type: 'error', id: this.d.newId(), text: errorText(e), ts: this.d.now() })
        this.halt(room)
      }
    } finally {
      try {
        this.d.onTurnEnd?.({ chatId, agent: me, outcome: errored ? 'error' : replied ? 'ok' : 'stopped', passed, reply: res.text })
      } catch {
        /* a mark must never reach the room */
      }
      this.wake(room)
    }
  }

  /**
   * After a failed turn: the queue clears, and members still working finish without their replies routed. Members'
   * replies waiting to be routed are dropped, and so is one being routed; the user's messages still get their answer.
   * A pausing room keeps its queue and the reasons: once Pause is pressed the room ends paused however it ends, and Resume
   * restores them.
   */
  private halt(room: Room): void {
    room.halted = true
    if (!room.pausing) {
      room.queue = []
      room.reasons.clear()
    }
    room.inbox = room.inbox.filter((e) => e.speaker === null)
    if (room.routing && room.routing.speaker !== null) {
      room.routing = null
      room.cancel?.()
    }
    for (const w of room.working.values()) w.muted = true
  }

  /** Stop: nothing is left to start or route. A pausing room keeps its queue and reasons for Resume: Stop only hurries the pause. */
  private clearPlans(room: Room): void {
    if (!room.pausing) {
      room.queue = []
      room.reasons.clear()
    }
    room.inbox = []
  }

  private async route(chatId: string, room: Room, entry: InboxEntry): Promise<void> {
    // Until it is routed, members waiting for its speaker stay queued. A failure meanwhile drops a member's reply.
    room.routing = entry
    const dropped = () => room.routing !== entry || room.r.reason !== null
    try {
      const since = this.renames.length
      const { speaker } = entry
      const meta = await this.groupMeta(chatId)
      const { members } = meta.group
      const agents = await this.d.agents()
      const available = availableOf(members, agents)
      // A command picks its agent as an @mention would, so only the user's entries carry one.
      const owner = speaker === null && entry.commandAgent !== undefined && members.includes(entry.commandAgent) ? [entry.commandAgent] : []
      // In a workflow room the message holds webhook text in <input> blocks: material, never an address.
      const text = meta.workflow || entry.material ? maskInputBlocks(entry.text) : entry.text
      const all = [...new Set([...owner, ...findMentions(text, members)])]
      // Only the user can address everyone; an agent's @everyone is plain text.
      const everyone = speaker === null && mentionsEveryone(text)
      // A reply that mentions nobody is for the member it replies to, read now so a rename since it was posted follows.
      const replied = all.length === 0 && !everyone ? repliedItem(room.ref.get(), entry.replyTo)?.agent : undefined
      const mentioned = (replied ? [replied] : all).filter((n) => available.includes(n))
      let changed = false
      // The user's mentions of missing members got their notice when the message was posted.
      if (speaker !== null) {
        for (const n of all) {
          if (!available.includes(n)) {
            this.add(room, this.unavailable(n))
            changed = true
          }
        }
      }
      const answer = dropped()
        ? null
        : await this.moderate(
            room,
            {
              members: memberInfo(available, agents),
              messages: threadEntries(withReplies(upTo(room.ref.get(), entry.lastId)), null, ''),
              speaker,
              role: meta.group.role,
              working: [...room.working.keys()],
              queue: room.queue,
              mentioned,
              everyone,
              ...(meta.workflow || entry.material ? { material: true as const } : {})
            },
            meta.cwd,
            chatId
          )
      if (!dropped()) {
        // The user's message restarts a room a failure halted, as posting it would.
        if (speaker === null && room.halted) {
          room.halted = false
          room.hops = 0
        }
        const planned = this.plan(room, answer, since, speaker, mentioned, available, everyone)
        // Resume's message: the turns that waited when the room paused go after what was planned for it, and are forgotten.
        if (entry.restore)
          this.restore(
            room,
            entry.restore,
            members.map((n) => this.follow(since, n))
          )
        if (planned.queue || entry.restore) await this.sync(chatId, room, entry.restore ? unpaused : undefined)
        // Only once that is saved: until then the room's end must not leave the saved state behind.
        room.unrestored.delete(entry)
        if (planned.notice) changed = true
      }
      if (changed) await this.saveAndPush(chatId, room, false)
    } finally {
      if (room.routing === entry) room.routing = null
    }
  }

  /**
   * Queues the saved turns again after the planned ones, each with the reason it had, so a request the user made is
   * still one. A member already queued (with the reason the new plan gave it) or working, or gone from the room, is left out.
   */
  private restore(room: Room, saved: PausedRoom, members: readonly string[]): void {
    const taken = new Set([...room.queue.map((e) => e.agent), ...room.working.keys()])
    for (const e of saved.queue) {
      if (!members.includes(e.agent) || taken.has(e.agent)) continue
      taken.add(e.agent)
      room.queue = [...room.queue, { agent: e.agent, after: e.after.filter((n) => members.includes(n)) }]
      const why = saved.reasons?.[e.agent]
      if (why && !room.reasons.has(e.agent)) room.reasons.set(e.agent, { ...why })
    }
  }

  /**
   * What a room that ends paused saves for Resume: who was working, the queue and each queued member's reason, plus the
   * saved state of any Resume message the room never routed, so pausing again loses none of it.
   */
  private pausedState(room: Room, unrestored: readonly InboxEntry[], members: readonly string[]): PausedRoom {
    let working = [...room.pausedMembers]
    for (const e of unrestored) {
      if (!e.restore) continue
      this.restore(room, e.restore, members)
      working = [...new Set([...working, ...e.restore.members])]
    }
    const reasons = Object.fromEntries(
      [...room.reasons].filter(([n]) => room.queue.some((e) => e.agent === n)).map(([n, why]) => [n, { ...why }])
    )
    return {
      members: working,
      queue: room.queue.map((e) => ({ agent: e.agent, after: [...e.after] })),
      ...(Object.keys(reasons).length > 0 ? { reasons } : {})
    }
  }

  /**
   * Merges the moderator's answer into the queue and gives each queued member its reason, by the names agents have now.
   * Says whether the queue changed and whether a notice was added.
   */
  private plan(
    room: Room,
    answer: ModeratorAnswer | null,
    since: number,
    speaker: string | null,
    mentioned: string[],
    available: string[],
    everyone: boolean
  ): { queue: boolean; notice: boolean } {
    // One may have been renamed while the moderator ran; the moderator answers with the handles it was given.
    const rn = (n: string) => this.follow(since, n)
    const speakerNow = speaker === null ? null : rn(speaker)
    const mentionedNow = mentioned.map(rn)
    // What the user asked for stands until it has run: only members queued by agents or the moderator can be dropped.
    const askedByUser = (n: string) => ['user', 'answer', 'everyone'].includes(room.reasons.get(n)?.kind ?? '')
    // Only when the moderator says the message asks the user to decide may a drop hold back what the user asked for.
    const drop = answer ? answer.drop.map(rn).filter((n) => answer.askUser || !askedByUser(n)) : []
    const plan = planQueue({
      answer: answer && {
        next: answer.next.map((p) => ({ ...p, agent: rn(p.agent), after: p.after.map(rn) })),
        drop,
        skip: answer.skip.map(rn),
        askUser: answer.askUser
      },
      mentioned: mentionedNow,
      speaker: speakerNow,
      queue: room.queue,
      working: [...room.working.keys()],
      // Replies that finished while the moderator ran: whoever waits for their speakers waits for them to be routed.
      unrouted: room.inbox.flatMap((e) => (e.speaker === null ? [] : [e.speaker])),
      available: available.map(rn),
      lastAgent: room.lastAgent,
      everyone
    })
    const queueChanged = JSON.stringify(plan.queue) !== JSON.stringify(room.queue)
    // Members the drop took off the queue while the user is asked: say who waits.
    const held = answer?.askUser
      ? drop.filter((n, k) => drop.indexOf(n) === k && room.queue.some((e) => e.agent === n) && !plan.queue.some((e) => e.agent === n))
      : []
    room.queue = plan.queue
    const asked: TurnReason = speakerNow === null ? { kind: 'user' } : { kind: 'agent', by: speakerNow }
    // A mention the moderator skipped asked for nothing, unless it also picked the member.
    const skippedNow = new Set(speakerNow === null || !answer ? [] : answer.skip.map(rn))
    const mentions = mentionedNow.filter((n) => n !== speakerNow && (!skippedNow.has(n) || answer?.next.some((p) => rn(p.agent) === n)))
    // A user message that mentions nobody is for the group: the first member added must answer it; the rest may pass.
    const forGroup = speakerNow === null && mentionedNow.length === 0
    // @everyone is for the group too, but its members other than the first may pass.
    const ofGroup = forGroup || everyone
    plan.added.forEach((n, at) => {
      const why: TurnReason = mentions.includes(n)
        ? asked
        : ofGroup && at === 0
          ? { kind: 'answer' }
          : everyone
            ? { kind: 'everyone' }
            : { kind: 'moderator' }
      room.reasons.set(n, why)
    })
    // A member already queued keeps its reason, except that the user's mention makes any turn the user's request, and an
    // agent's mention makes one the moderator queued answer. A moderator note stays.
    for (const n of mentions) {
      const why = room.reasons.get(n)
      if (why && (speakerNow === null || why.kind === 'moderator')) room.reasons.set(n, why.note ? { ...asked, note: why.note } : asked)
    }
    for (const [n, note] of Object.entries(plan.notes)) room.reasons.set(n, { ...(room.reasons.get(n) ?? { kind: 'moderator' }), note })
    for (const n of [...room.reasons.keys()]) if (!room.queue.some((e) => e.agent === n)) room.reasons.delete(n)
    if (plan.notice !== null) this.add(room, this.notice('moderator', plan.notice))
    for (const n of held) this.add(room, this.notice('held', `${displayName(n)} waits for your answer.`))
    return { queue: queueChanged, notice: plan.notice !== null || held.length > 0 }
  }

  /**
   * The moderator's answer, or null when it failed, or Stop or a failed turn cancelled it (the cancel wins even if the
   * call ignores its signal).
   */
  private async moderate(room: Room, input: ModeratorInput, cwd: string, chatId: string): Promise<ModeratorAnswer | null> {
    if (room.r.reason) return null
    const ctrl = new AbortController()
    const cancelled = new Promise<null>((resolve) => ctrl.signal.addEventListener('abort', () => resolve(null), { once: true }))
    room.cancel = () => ctrl.abort()
    try {
      const answer = (async () => this.d.moderate(input, cwd, ctrl.signal, chatId))().catch(() => null)
      return await Promise.race([answer, cancelled])
    } finally {
      room.cancel = null
    }
  }

  // The hop cap's pause, not the user's (requestPause): it drops the queue and waits for a message.
  private async hopPause(chatId: string, room: Room): Promise<void> {
    this.add(room, this.notice('paused'))
    room.reasons.clear()
    room.queue = []
    await this.sync(chatId, room)
    await this.saveAndPush(chatId, room, false)
  }

  private markPausing(room: Room): void {
    if (room.pausing) return
    room.pausing = true
    room.pausedMembers = [...room.working.keys()]
    // Members' replies not routed yet would only plan more work. The user's message keeps its answer: it is routed, and
    // what the moderator plans for it waits in the saved queue.
    room.inbox = room.inbox.filter((e) => e.speaker === null)
    this.wake(room)
  }

  private async drain(room: Room): Promise<void> {
    while (room.working.size > 0) await this.nextWake(room)
  }

  private nextWake(room: Room): Promise<void> {
    if (room.woken) {
      room.woken = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      room.wake = resolve
    })
  }

  // Never lost: the loop may be busy saving or routing when a turn ends, and must look again before it waits.
  private wake(room: Room): void {
    const wake = room.wake
    room.wake = null
    if (wake) wake()
    else room.woken = true
  }

  private async groupMeta(chatId: string): Promise<GroupMeta> {
    const meta = await this.d.store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    if (!isGroup(meta)) throw new Error(`Not a group chat: ${chatId}`)
    return meta
  }

  private async updateGroup(chatId: string, fn: (g: GroupInfo) => GroupInfo): Promise<ChatMeta> {
    const meta = await this.d.store.updateGroup(chatId, fn)
    this.d.push({ chatId, kind: 'meta', meta })
    return meta
  }

  /** Saves the room's queue and working members as they are when the store gets to it, so writes never go back in time. */
  private sync(chatId: string, room: Room, fn: (g: GroupInfo) => GroupInfo = (g) => g): Promise<ChatMeta> {
    return this.updateGroup(chatId, (g) => ({
      ...fn(g),
      queue: room.queue.map((e) => ({ agent: e.agent, after: [...e.after] })),
      active: [...room.working].map(([agent, w]) => ({
        agent,
        turn: w.turn,
        since: w.since,
        ...(w.compacting ? { compacting: true as const } : {})
      }))
    }))
  }

  // Reads the items and queues the save in one tick, so the store never writes an older list after a newer one.
  // With an agent, clearStreaming clears only that agent's live text.
  private async saveAndPush(chatId: string, room: Room, clearStreaming: boolean, agent?: string): Promise<void> {
    const saved = this.d.store.saveItems(chatId, [...room.ref.get()])
    this.d.push({ chatId, kind: 'items', items: [...room.ref.get()], clearStreaming, ...(agent === undefined ? {} : { agent }) })
    await saved
  }

  private add(room: Room, item: ChatItem): void {
    room.ref.set([...room.ref.get(), item])
  }

  private notice(kind: NoticeKind, text: string = NOTICE_TEXT[kind]): ChatItem {
    return { type: 'notice', id: this.d.newId(), kind, text, ts: this.d.now() }
  }

  private unavailable(name: string): ChatItem {
    return this.notice('unavailable', `${displayName(name)} is no longer available.`)
  }
}
