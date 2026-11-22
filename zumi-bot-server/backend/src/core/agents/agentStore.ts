import { isCommandModel } from '@zumibot/shared/chatModel'
import { promises as fs, mkdirSync, watch as fsWatch } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { extensionsOf, NO_FRONTMATTER, parseAgent, serializeAgent, validateFields } from '@zumibot/shared/frontmatter'
import type { AgentExtensions } from '@zumibot/shared/extensions'
import type { AcpLaunch } from '@zumibot/shared/acp'
import { aguiHost, type AguiLaunch } from '@zumibot/shared/agui'
import type { Provider } from '@zumibot/shared/engine'
import { withTodoTools } from '@zumibot/shared/todos'
import { withProcessTools } from '@zumibot/shared/processes'
import { withVaultTools } from '@zumibot/shared/vault'
import { withAskTool } from '@zumibot/shared/agentAsk'
import { builtInError } from '@zumibot/shared/zumiBot'
import { validCommands, type AgentCommand } from '@zumibot/shared/commands'
import type { AgentSummary, SaveAgentResult } from '@zumibot/shared/types'
import { assertInside, writeFileAtomic } from '../fsutil'

const DEBOUNCE_MS = 150

export class AgentStore {
  constructor(
    private readonly dir: string,
    private readonly trashFn: (path: string) => Promise<void>,
    private readonly writer: (path: string, data: string) => Promise<void> = writeFileAtomic,
    private readonly builtInName: string | null = null
  ) {}

  async list(): Promise<AgentSummary[]> {
    const all = await this.scan()
    const dups = findDuplicates(all)
    return all.map((a) => {
      const keep = dups.get(resolve(a.filePath))
      return keep ? { ...a, error: `Duplicate name "${a.name}" \u2014 also declared in ${keep}` } : a
    })
  }

  /** Valid commands of the loadable agent with this name, read fresh so a send never uses a stale prompt. */
  async commandsOf(name: string): Promise<AgentCommand[]> {
    const agent = (await this.list()).find((a) => a.name === name && a.error === null)
    if (!agent) return []
    try {
      const parsed = parseAgent(await fs.readFile(agent.filePath, 'utf8'))
      return parsed.ok ? validCommands(parsed.fields.commands ?? []) : []
    } catch {
      return []
    }
  }

  /** Body and `model:` of the loadable agent with this name, read fresh; Codex has no `--agent`, so ZumiBot sends both. */
  async definitionOf(name: string): Promise<{ body: string; model: string | null } | null> {
    const agent = (await this.list()).find((a) => a.name === name && a.error === null)
    if (!agent) return null
    try {
      const parsed = parseAgent(await fs.readFile(agent.filePath, 'utf8'))
      return parsed.ok ? { body: parsed.body, model: parsed.fields.model } : null
    } catch {
      return null
    }
  }

  /**
   * An ACP agent's body and launch (`acp:`), read fresh like `definitionOf`, so each attempt runs (and checks against launch
   * trust) the file as it is now. `launch` is null when the key is absent or does not parse; null when no loadable agent has the name.
   * `provider` lets a run and Agent Studio's Test refuse a file that is no longer an ACP agent.
   */
  async acpOf(name: string): Promise<{ provider: Provider | null; body: string; launch: AcpLaunch | null } | null> {
    const agent = (await this.list()).find((a) => a.name === name && a.error === null)
    if (!agent) return null
    try {
      const parsed = parseAgent(await fs.readFile(agent.filePath, 'utf8'))
      return parsed.ok ? { provider: parsed.fields.provider, body: parsed.body, launch: parsed.fields.acp } : null
    } catch {
      return null
    }
  }

  /**
   * A remote (AG-UI) agent's launch (`agui:`), read fresh like `acpOf`, so each attempt checks the file as it is now against launch
   * trust. `launch` is null when the key is absent or does not parse; null when no loadable agent has the name. `provider` lets a
   * run refuse a file that is no longer a remote agent. The body is not read: a remote agent's instructions are its server's,
   * and nothing of the file but the launch is sent.
   */
  async aguiOf(name: string): Promise<{ provider: Provider | null; launch: AguiLaunch | null } | null> {
    const agent = (await this.list()).find((a) => a.name === name && a.error === null)
    if (!agent) return null
    try {
      const parsed = parseAgent(await fs.readFile(agent.filePath, 'utf8'))
      return parsed.ok ? { provider: parsed.fields.provider, launch: parsed.fields.agui } : null
    } catch {
      return null
    }
  }

  /** Servers, plugins, skills and hooks this agent's file sets, read fresh like `definitionOf`; null when no loadable agent has the name. */
  async extensionsOf(name: string): Promise<AgentExtensions | null> {
    const agent = (await this.list()).find((a) => a.name === name && a.error === null)
    if (!agent) return null
    try {
      const parsed = parseAgent(await fs.readFile(agent.filePath, 'utf8'))
      return parsed.ok ? extensionsOf(parsed.fields) : null
    } catch {
      return null
    }
  }

  read(filePath: string): Promise<string> {
    return fs.readFile(assertInside(this.dir, filePath), 'utf8')
  }

  async save(originalFilePath: string | null, rawIn: string): Promise<SaveAgentResult> {
    const parsed = parseAgent(rawIn)
    const builtInPath = this.builtInPath()
    if (builtInPath !== null && this.builtInName !== null) {
      const isOriginal = originalFilePath !== null && resolve(originalFilePath) === builtInPath
      if (isOriginal || (parsed.ok && parsed.fields.name === this.builtInName)) {
        return { ok: false, error: builtInError(this.builtInName) }
      }
    }
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const errors = validateFields(parsed.fields, parsed.acpEditable, parsed.aguiEditable)
    if (errors.length > 0) return { ok: false, error: errors.join('; ') }

    // With --agent the CLI gives an agent only the tools it lists, so a non-empty list needs the to-do, ask and process tools or they never reach it.
    // No list (all tools) stays absent. serializeAgent edits only the tools line.
    const tools = parsed.fields.tools
    const full = tools !== null && tools.length > 0 ? withProcessTools(withAskTool(withTodoTools(withVaultTools(tools)))) : null
    const raw =
      full !== null && full.join() !== tools?.join() ? serializeAgent(rawIn, { ...parsed.fields, tools: full }, parsed.body) : rawIn

    const name = parsed.fields.name
    const original = originalFilePath === null ? null : assertInside(this.dir, originalFilePath)

    // An edit that keeps the name never moves the file, even if its basename differs from the name.
    const inPlace = original !== null && (await this.oldName(original)) === name
    // A folder agent lives at <dir>/<n>/<n>.md; renaming it moves the whole folder.
    const oldFolder = original !== null && !inPlace ? await this.folderOf(original) : null
    const newFolder = oldFolder === null ? null : assertInside(this.dir, join(this.dir, name))
    let target: string
    if (inPlace) target = original
    else if (newFolder !== null) target = assertInside(this.dir, join(newFolder, `${name}.md`))
    else if (original !== null && dirname(original) !== resolve(this.dir)) {
      target = assertInside(this.dir, join(dirname(original), `${name}.md`))
    } else target = assertInside(this.dir, join(this.dir, `${name}.md`))
    if (newFolder !== null) {
      if (await exists(newFolder)) return { ok: false, error: `An agent folder named ${name} already exists` }
    } else if (target !== original && (await exists(target))) {
      return { ok: false, error: `An agent file named ${name}.md already exists` }
    }
    // Chats and the CLI's --agent lookup are keyed by name, so one name must map to one file.
    const all = await this.scan()
    const dups = findDuplicates(all)
    // Flagged duplicates do not count as owners: the real agent must stay savable while a stray copy exists.
    const clash = all.find((a) => !a.error && a.name === name && resolve(a.filePath) !== original && !dups.has(resolve(a.filePath)))
    if (clash) {
      return { ok: false, error: `Another agent already uses the name "${name}" (${basename(clash.filePath)})` }
    }

    if (inPlace) {
      try {
        await this.writer(target, raw)
        return { ok: true, filePath: target, name, renamedFrom: null }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    }

    let renamedFrom: string | null = null
    let renamed = false
    try {
      await fs.mkdir(this.dir, { recursive: true })
      if (original !== null) {
        const oldName = await this.oldName(original)
        // A flagged duplicate never owned its chats; they stay with the real agent that still has the name.
        renamedFrom = dups.has(original) ? null : oldName
        if (oldFolder !== null && newFolder !== null) {
          await fs.rename(oldFolder, newFolder)
          renamed = true
          await fs.rename(join(newFolder, basename(original)), target)
        } else if (target !== original) {
          await fs.rename(original, target)
          renamed = true
        }
      }
      await this.writer(target, raw)
      return { ok: true, filePath: target, name, renamedFrom }
    } catch (err) {
      const message = errorMessage(err)
      if (renamed && original !== null) {
        try {
          if (oldFolder !== null && newFolder !== null) {
            if (await exists(target)) await fs.rename(target, join(newFolder, basename(original)))
            await fs.rename(newFolder, oldFolder)
          } else await fs.rename(target, original)
        } catch {
          return {
            ok: false,
            error: `${message}. The file is now at ${name}.md with its old content`
          }
        }
      }
      return { ok: false, error: message }
    }
  }

  async trash(filePath: string): Promise<void> {
    const builtInPath = this.builtInPath()
    if (builtInPath !== null && this.builtInName !== null && resolve(filePath) === builtInPath) {
      throw new Error(builtInError(this.builtInName))
    }
    const safe = assertInside(this.dir, filePath)
    const folder = await this.folderOf(safe)
    if (folder !== null && (await this.soleAgent(folder, safe))) {
      await this.trashFn(assertInside(this.dir, folder))
      return
    }
    await this.trashFn(safe)
  }

  watch(onChange: () => void): () => void {
    // Sync mkdir keeps the unsubscribe function synchronous for the caller.
    mkdirSync(this.dir, { recursive: true })
    let timer: NodeJS.Timeout | null = null
    const watcher = fsWatch(this.dir, { recursive: true }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onChange()
      }, DEBOUNCE_MS)
    })
    // A removed/renamed dir or EPERM emits 'error'; unhandled, it would crash the main process.
    watcher.on('error', () => {
      if (timer) clearTimeout(timer)
      timer = null
      watcher.close()
    })
    return () => {
      if (timer) clearTimeout(timer)
      timer = null
      watcher.close()
    }
  }

  private builtInPath(): string | null {
    return this.builtInName === null ? null : resolve(join(this.dir, `${this.builtInName}.md`))
  }

  private async scan(): Promise<AgentSummary[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const builtInPath = this.builtInPath()
    const out: AgentSummary[] = []
    const readDir = async (folder: string, names: string[], nested: boolean): Promise<void> => {
      for (const file of names) {
        if (file.startsWith('.') || !file.endsWith('.md')) continue
        const filePath = join(folder, file)
        let raw: string
        try {
          const stat = await fs.stat(filePath)
          if (!stat.isFile()) continue
          raw = await fs.readFile(filePath, 'utf8')
        } catch {
          continue
        }
        const builtIn = builtInPath !== null && resolve(filePath) === builtInPath
        const parsed = parseAgent(raw)
        if (parsed.ok) {
          const {
            name,
            description,
            color,
            icon,
            memory,
            memoryLimit,
            computerUse,
            autoCompactWindow,
            model,
            provider,
            dailySpendCap,
            agui
          } = parsed.fields
          // The host only, for the remote chip: never the path or the query, which may carry a team or a token.
          const remoteHost = provider === 'ag-ui' && agui !== null ? aguiHost(agui.endpoint) : null
          const commands = validCommands(parsed.fields.commands ?? []).map((c) => ({
            name: c.name,
            description: c.description,
            ...(c.todos ? { todos: true as const } : {}),
            ...(isCommandModel(c.model) ? { model: c.model } : {})
          }))
          out.push({
            filePath,
            name,
            description,
            color,
            icon,
            error: null,
            builtIn,
            ...(commands.length > 0 ? { commands } : {}),
            ...(memory !== null ? { memory } : {}),
            ...(memoryLimit !== null ? { memoryLimit } : {}),
            ...(computerUse === true ? { computerUse } : {}),
            ...(autoCompactWindow !== null ? { autoCompactWindow } : {}),
            ...(model !== null ? { model } : {}),
            ...(provider !== null ? { provider } : {}),
            ...(dailySpendCap !== null ? { dailySpendCap } : {}),
            ...(remoteHost !== null ? { remoteHost } : {})
          })
        } else {
          if (nested && parsed.error === NO_FRONTMATTER) continue
          out.push({ filePath, name: basename(file, '.md'), description: '', color: null, icon: null, error: parsed.error, builtIn })
        }
      }
    }
    await readDir(this.dir, entries, false)
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const sub = join(this.dir, entry)
      try {
        if (!(await fs.stat(sub)).isDirectory()) continue
        await readDir(sub, await fs.readdir(sub), true)
      } catch {
        continue
      }
    }
    return out.sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath))
  }

  /** The agent's folder when it is a folder agent (<dir>/<n>/<n>.md with n the agent name), else null. */
  private async folderOf(file: string): Promise<string | null> {
    const folder = dirname(file)
    if (folder === resolve(this.dir)) return null
    const base = basename(file, '.md')
    if (basename(folder) !== base || (await this.oldName(file)) !== base) return null
    return folder
  }

  /** True when no other *.md in the folder parses as an agent. */
  private async soleAgent(folder: string, file: string): Promise<boolean> {
    let names: string[]
    try {
      names = await fs.readdir(folder)
    } catch {
      return false
    }
    for (const n of names) {
      const p = join(folder, n)
      if (!n.endsWith('.md') || resolve(p) === resolve(file)) continue
      try {
        if (parseAgent(await fs.readFile(p, 'utf8')).ok) return false
      } catch {
        /* unreadable: not an agent */
      }
    }
    return true
  }

  private async oldName(path: string): Promise<string> {
    try {
      const parsed = parseAgent(await fs.readFile(path, 'utf8'))
      if (parsed.ok) return parsed.fields.name
    } catch {
      /* fall through to basename */
    }
    return basename(path, '.md')
  }
}

/** Maps each non-canonical duplicate's resolved path to the file that keeps the name: <name>.md, else the first by path. */
function findDuplicates(list: AgentSummary[]): Map<string, string> {
  const byName = new Map<string, AgentSummary[]>()
  for (const a of list) if (!a.error) byName.set(a.name, [...(byName.get(a.name) ?? []), a])
  const dups = new Map<string, string>()
  for (const [name, group] of byName) {
    if (group.length < 2) continue
    const keep = group.find((a) => basename(a.filePath) === `${name}.md`) ?? group[0]
    for (const a of group) if (a !== keep) dups.set(resolve(a.filePath), basename(keep.filePath))
  }
  return dups
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
