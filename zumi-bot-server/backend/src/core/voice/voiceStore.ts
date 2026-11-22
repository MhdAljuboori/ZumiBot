import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CLEAN,
  DEFAULT_TALK,
  TALK_AGENT_MAX,
  TALK_AGENTS_MAX,
  TALK_PHRASES_MAX,
  TALK_PHRASE_MAX,
  voiceOn,
  type VoiceClean,
  type VoiceStatus,
  type VoiceTalk
} from '@zumibot/shared/voice'
import { writeFileAtomic } from '../fsutil'

interface VoiceFile {
  enabled: boolean
  key: string | null
  talk: VoiceTalk
  clean: VoiceClean
}

const defaults = (): VoiceFile => ({ enabled: true, key: null, talk: { ...DEFAULT_TALK, aliases: {} }, clean: { ...DEFAULT_CLEAN } })

/** Field by field, so one bad value costs only itself (a hand-edited or older file never loses the rest). */
function readTalk(raw: unknown): VoiceTalk {
  const out: VoiceTalk = { ...DEFAULT_TALK, aliases: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const t = raw as Record<string, unknown>
  if (typeof t.enabled === 'boolean') out.enabled = t.enabled
  if (t.defaultAgent === null) out.defaultAgent = null
  else if (typeof t.defaultAgent === 'string' && t.defaultAgent !== '' && t.defaultAgent.length <= TALK_AGENT_MAX)
    out.defaultAgent = t.defaultAgent
  if (typeof t.aliases === 'object' && t.aliases !== null && !Array.isArray(t.aliases)) {
    for (const [name, list] of Object.entries(t.aliases).slice(0, TALK_AGENTS_MAX)) {
      if (name === '__proto__' || name === '' || name.length > TALK_AGENT_MAX || !Array.isArray(list)) continue
      const phrases = list
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter((p) => p !== '' && p.length <= TALK_PHRASE_MAX)
        .slice(0, TALK_PHRASES_MAX)
      if (phrases.length > 0) out.aliases[name] = phrases
    }
  }
  return out
}

/** Field by field, like talk: a file from before the switches reads as both off. */
function readClean(raw: unknown): VoiceClean {
  const t = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    fillers: typeof t.fillers === 'boolean' ? t.fillers : DEFAULT_CLEAN.fillers,
    rewrite: typeof t.rewrite === 'boolean' ? t.rewrite : DEFAULT_CLEAN.rewrite
  }
}

/** voice.json: the OpenRouter key for dictation and its switch. It holds a secret, so it is written 0600. */
export class VoiceStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'voice.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  // Read on every use: tiny, and a switch flipped in one tab applies to the very next clip.
  private async read(): Promise<VoiceFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<VoiceFile>
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults().enabled,
        key: typeof raw.key === 'string' && raw.key !== '' ? raw.key : null,
        talk: readTalk(raw.talk),
        clean: readClean(raw.clean)
      }
    } catch {
      return defaults()
    }
  }

  private async write(f: VoiceFile): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.file, JSON.stringify(f, null, 2), 0o600)
  }

  private static status({ enabled, key, talk, clean }: VoiceFile): VoiceStatus {
    const keySaved = key !== null
    const on = voiceOn({ enabled, keySaved })
    return { on, enabled, keySaved, talk, talkOn: on && talk.enabled, clean }
  }

  status(): Promise<VoiceStatus> {
    return this.run(async () => VoiceStore.status(await this.read()))
  }

  key(): Promise<string | null> {
    return this.run(async () => (await this.read()).key)
  }

  /** Read per clip, so a switch flipped in one tab applies to the very next one. */
  clean(): Promise<VoiceClean> {
    return this.run(async () => (await this.read()).clean)
  }

  /**
   * An agent rename follows into the talk settings: the default agent and the alias key (aliases of a name that already
   * has some are merged, no duplicates, the key keeping its place). Answers the new status, or null when nothing named it.
   */
  renameAgent(from: string, to: string): Promise<VoiceStatus | null> {
    return this.run(async () => {
      const cur = await this.read()
      const hasAlias = Object.hasOwn(cur.talk.aliases, from)
      if (cur.talk.defaultAgent !== from && !hasAlias) return null
      const aliases: Record<string, string[]> = {}
      for (const [name, list] of Object.entries(cur.talk.aliases)) {
        const key = name === from ? to : name
        aliases[key] = [...new Set([...(aliases[key] ?? []), ...list])].slice(0, TALK_PHRASES_MAX)
      }
      const next: VoiceFile = {
        ...cur,
        talk: { ...cur.talk, defaultAgent: cur.talk.defaultAgent === from ? to : cur.talk.defaultAgent, aliases }
      }
      await this.write(next)
      return VoiceStore.status(next)
    })
  }

  /** A talk patch changes only the fields it names (the patch was checked by parseTalkPatch). */
  set(patch: { enabled?: boolean; key?: string | null; talk?: Partial<VoiceTalk>; clean?: Partial<VoiceClean> }): Promise<VoiceStatus> {
    return this.run(async () => {
      const cur = await this.read()
      const next: VoiceFile = {
        enabled: patch.enabled ?? cur.enabled,
        key: patch.key === undefined ? cur.key : patch.key,
        talk: { ...cur.talk, ...patch.talk },
        clean: { ...cur.clean, ...patch.clean }
      }
      await this.write(next)
      return VoiceStore.status(next)
    })
  }
}
