import { promises as fs, lstatSync, mkdirSync, readdirSync, renameSync, watch as fsWatch, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NAME_PATTERN } from '@zumibot/shared/frontmatter'
import {
  MEMORY_CHANGED,
  MEMORY_INDEX,
  MEMORY_TYPES,
  indexLine,
  indexLinkable,
  isMemoryFileName,
  memoryFull,
  newMemoryFile,
  parseIndex,
  parseMemoryFile,
  serializeNewMemory,
  updateMemoryFile,
  type MemoryEntry,
  type MemoryInput,
  type MemoryList
} from '@zumibot/shared/memory'
import { assertInside, writeFileAtomic } from '../fsutil'

const DEBOUNCE_MS = 150
const TYPE_ERROR = 'type must be user, feedback, project or reference'
const TYPES: readonly (string | null)[] = [null, ...MEMORY_TYPES]

/** Same rule as the CLI: its config dir, else ~/.claude. */
export function memoryRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env['CLAUDE_CONFIG_DIR']
  return join(dir ? dir : join(home, '.claude'), 'agent-memory')
}

export async function isAutoMemoryOff(env: NodeJS.ProcessEnv, configDir: string): Promise<boolean> {
  if (/^(1|true|yes)$/i.test((env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] ?? '').trim())) return true
  try {
    const s = JSON.parse(await fs.readFile(join(configDir, 'settings.json'), 'utf8')) as unknown
    return s !== null && typeof s === 'object' && (s as Record<string, unknown>).autoMemoryEnabled === false
  } catch {
    return false
  }
}

interface Deps {
  root: string
  trash(p: string): Promise<void>
  log(line: string): void
}

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT'
const lineCount = (raw: string): number => (raw === '' ? 0 : raw.replace(/\n$/, '').split('\n').length)
// Newlines would split the index line, so a hook is one line.
const hook = (d: string): string => d.replace(/\s+/g, ' ').trim()
const isRegular = (st: Stats): boolean => st.isFile() && !st.isSymbolicLink()

/** Adds a newline first only when the last line lacks one, so existing bytes stay as they were. */
function appendLine(raw: string, line: string): string {
  return `${raw === '' || raw.endsWith('\n') ? raw : `${raw}\n`}${line}\n`
}

export class MemoryStore {
  // Per agent folder, so a list's repair and a save never interleave on MEMORY.md.
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly d: Deps) {}

  dirOf(agent: string): string {
    if (typeof agent !== 'string' || !NAME_PATTERN.test(agent)) throw new TypeError('agent')
    return assertInside(this.d.root, join(this.d.root, agent))
  }

  async list(agent: string, o: { scope: string | null; limit: number; autoMemoryOff: boolean }): Promise<MemoryList> {
    const dir = this.dirOf(agent)
    return this.queued(agent, async () => {
      await this.repair(agent, dir)
      const index = await this.readIndex(dir)
      const lines = parseIndex(index)
      const entries: MemoryEntry[] = []
      for (const file of await this.files(dir)) {
        const path = join(dir, file)
        let st: Stats
        let raw: string
        try {
          st = await fs.lstat(path)
          raw = await fs.readFile(path, 'utf8')
        } catch (err) {
          if (missing(err)) continue
          throw err
        }
        const p = parseMemoryFile(file, raw)
        const at = lines.get(file)
        entries.push({
          file,
          name: p.name,
          title: at ? at.title : p.name,
          description: p.description,
          type: p.type,
          body: p.body,
          modified: st.mtimeMs,
          indexLine: at ? at.line : null
        })
      }
      return { scope: o.scope, limit: o.limit, autoMemoryOff: o.autoMemoryOff, indexLines: lineCount(index), entries }
    })
  }

  async count(agent: string): Promise<number> {
    return (await this.files(this.dirOf(agent))).length
  }

  repairIndex(agent: string): Promise<void> {
    const dir = this.dirOf(agent)
    return this.queued(agent, () => this.repair(agent, dir))
  }

  async save(agent: string, file: string | null, input: MemoryInput, modified: number | null, limit: number): Promise<void> {
    const dir = this.dirOf(agent)
    const path = file === null ? null : this.fileOf(dir, file)
    if (file === null && !TYPES.includes(input.type)) throw new TypeError(TYPE_ERROR)
    await this.queued(agent, async () => {
      if (file === null || path === null) return this.create(agent, dir, input, limit)
      const st = await this.statRegular(path, file)
      if (modified === null || st.mtimeMs !== modified) throw new Error(MEMORY_CHANGED)
      const raw = await fs.readFile(path, 'utf8')
      const p = parseMemoryFile(file, raw)
      // A type the file already has (outside the four) stays allowed, so editing its text never forces a change.
      if (!TYPES.includes(input.type) && input.type !== p.type) throw new TypeError(TYPE_ERROR)
      await writeFileAtomic(path, updateMemoryFile(raw, input, p.name))
      const line = indexLine(input.title, file, hook(input.description))
      const index = await this.readIndex(dir)
      const at = parseIndex(index).get(file)
      if (!at) return this.writeIndex(dir, appendLine(index, line))
      const lines = index.split('\n')
      lines[at.line - 1] = line + (lines[at.line - 1].endsWith('\r') ? '\r' : '')
      await this.writeIndex(dir, lines.join('\n'))
    })
  }

  async remove(agent: string, file: string, modified: number): Promise<void> {
    const dir = this.dirOf(agent)
    const path = this.fileOf(dir, file)
    await this.queued(agent, async () => {
      const st = await this.statRegular(path, file)
      if (st.mtimeMs !== modified) throw new Error(MEMORY_CHANGED)
      await this.d.trash(path)
      const index = await this.readIndex(dir)
      const at = parseIndex(index).get(file)
      if (!at) return
      const lines = index.split('\n')
      lines.splice(at.line - 1, 1)
      await this.writeIndex(dir, lines.join('\n'))
    })
  }

  /** Synchronous: the rename handler runs it before any await. A merge, never an overwrite. */
  moveAgent(from: string, to: string): void {
    const a = this.dirOf(from)
    const b = this.dirOf(to)
    if (a === b) return
    try {
      lstatSync(a)
    } catch (err) {
      if (missing(err)) return
      throw err
    }
    let targetExists = true
    try {
      lstatSync(b)
    } catch (err) {
      if (!missing(err)) throw err
      targetExists = false
    }
    if (!targetExists) {
      renameSync(a, b)
      return
    }
    const taken = new Set(readdirSync(b))
    for (const file of readdirSync(a)) {
      if (!isMemoryFileName(file) || !isRegular(lstatSync(join(a, file)))) continue
      let target = file
      for (let n = 2; taken.has(target); n++) target = `${file.slice(0, -3)}_${n}.md`
      taken.add(target)
      renameSync(join(a, file), join(b, target))
    }
    // What is left is the old MEMORY.md and ignored files; the Trash keeps them.
    this.d.trash(a).catch(() => this.d.log(`memory: could not move the old folder of ${from} to the Trash`))
  }

  async trashAgent(name: string): Promise<void> {
    const dir = this.dirOf(name)
    try {
      await fs.lstat(dir)
    } catch (err) {
      if (missing(err)) return
      throw err
    }
    await this.d.trash(dir)
  }

  watch(onChange: (agent: string) => void): () => void {
    mkdirSync(this.d.root, { recursive: true })
    const timers = new Map<string, NodeJS.Timeout>()
    const watcher = fsWatch(this.d.root, { recursive: true }, (_ev, filename) => {
      if (!filename) return
      const agent = String(filename).split(/[\\/]/)[0]
      if (!NAME_PATTERN.test(agent)) return
      const t = timers.get(agent)
      if (t) clearTimeout(t)
      timers.set(
        agent,
        setTimeout(() => {
          timers.delete(agent)
          // A throwing listener must not become an uncaught exception.
          try {
            onChange(agent)
          } catch {
            this.d.log(`memory: change listener failed for ${agent}`)
          }
        }, DEBOUNCE_MS)
      )
    })
    const stop = (): void => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      watcher.close()
    }
    // A removed root or EPERM emits 'error'; unhandled, it would crash the main process.
    watcher.on('error', stop)
    return stop
  }

  private queued<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(agent) ?? Promise.resolve()
    const run = prev.then(fn)
    const tail = run.catch(() => undefined)
    this.chains.set(agent, tail)
    // Drop the entry once idle so the map does not grow with every agent ever seen.
    void tail.then(() => {
      if (this.chains.get(agent) === tail) this.chains.delete(agent)
    })
    return run
  }

  private fileOf(dir: string, file: string): string {
    if (typeof file !== 'string' || !isMemoryFileName(file)) throw new TypeError('file')
    return assertInside(dir, join(dir, file))
  }

  private async statRegular(path: string, file: string): Promise<Stats> {
    let st: Stats
    try {
      st = await fs.lstat(path)
    } catch (err) {
      if (missing(err)) throw new Error(MEMORY_CHANGED)
      throw err
    }
    if (!isRegular(st)) throw new TypeError(`Not a memory file: ${file}`)
    return st
  }

  /** Top-level regular .md files other than the index. */
  private async files(dir: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch (err) {
      if (missing(err)) return []
      throw err
    }
    const out: string[] = []
    for (const n of names) {
      if (!isMemoryFileName(n)) continue
      try {
        if (isRegular(await fs.lstat(join(dir, n)))) out.push(n)
      } catch (err) {
        if (!missing(err)) throw err
      }
    }
    return out
  }

  private async readIndex(dir: string): Promise<string> {
    try {
      return await fs.readFile(join(dir, MEMORY_INDEX), 'utf8')
    } catch (err) {
      if (missing(err)) return ''
      throw err
    }
  }

  private async writeIndex(dir: string, raw: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, MEMORY_INDEX), raw)
  }

  /** Adds a line for each file the index lacks; never removes or rewrites one. */
  private async repair(agent: string, dir: string): Promise<void> {
    const files = await this.files(dir)
    if (files.length === 0) return
    const index = await this.readIndex(dir)
    const have = parseIndex(index)
    const add: string[] = []
    for (const file of files.sort()) {
      if (have.has(file)) continue
      if (!indexLinkable(file)) {
        this.d.log(`memory: ${agent}/${file} cannot be linked in the index, skipped`)
        continue
      }
      let raw: string
      try {
        raw = await fs.readFile(join(dir, file), 'utf8')
      } catch (err) {
        if (missing(err)) continue
        throw err
      }
      const p = parseMemoryFile(file, raw)
      add.push(indexLine(hook(p.name) || file.slice(0, -3), file, hook(p.description)))
    }
    if (add.length === 0) return
    await this.writeIndex(dir, appendLine(index, add.join('\n')))
    this.d.log(`memory: added ${add.length} missing index line(s) for ${agent}`)
  }

  private async create(agent: string, dir: string, input: MemoryInput, limit: number): Promise<void> {
    const existing = await this.files(dir)
    if (existing.length >= limit) throw new Error(memoryFull(limit))
    await this.repair(agent, dir)
    await fs.mkdir(dir, { recursive: true })
    const { file, name } = newMemoryFile(input.type, input.title, new Set(await fs.readdir(dir)))
    await writeFileAtomic(assertInside(dir, join(dir, file)), serializeNewMemory(name, input))
    await this.writeIndex(dir, appendLine(await this.readIndex(dir), indexLine(input.title, file, hook(input.description))))
  }
}
