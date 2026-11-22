import YAML from 'yaml'
import { split } from './frontmatter'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export const MEMORY_LIMITS = [25, 50, 100, 150] as const
export const MEMORY_LIMIT_DEFAULT = 100
export const MEMORY_INDEX = 'MEMORY.md'
/** The CLI shows the agent only this many lines of MEMORY.md. */
export const INDEX_VISIBLE_LINES = 200
export const TITLE_MAX = 100
export const DESCRIPTION_MAX = 150
export const BODY_MAX = 8000
export const FILE_NAME_MAX = 200
const SLUG_MAX = 48
const TYPE_MAX = 40

export const MEMORY_CHANGED = 'This memory changed since you opened it.'
export const memoryFull = (limit: number): string =>
  `This agent has reached its limit of ${limit} memories. Edit, merge or delete one before adding another.`

export interface MemoryEntry {
  file: string
  name: string
  title: string
  description: string
  type: string | null
  body: string
  /** mtimeMs, sent back on save and remove to catch a rewrite in between. */
  modified: number
  /** 1-based line in MEMORY.md, or null when the index has none. */
  indexLine: number | null
}

export interface MemoryList {
  scope: string | null
  limit: number
  autoMemoryOff: boolean
  indexLines: number
  entries: MemoryEntry[]
}

export interface MemoryInput {
  title: string
  description: string
  type: string | null
  body: string
}

export interface MemoryTouch {
  saved: number
  updated: number
}

interface Parsed {
  name: string
  description: string
  type: string | null
  body: string
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function typeOf(data: Record<string, unknown>): string | null {
  const meta = data.metadata
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const t = str((meta as Record<string, unknown>).type)
    if (t !== null) return t
  }
  return str(data.type)
}

function trimBody(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

/** Never throws: a file the CLI or the user wrote badly is still a memory. */
export function parseMemoryFile(file: string, raw: string): Parsed {
  const fallback: Parsed = { name: file.replace(/\.md$/i, ''), description: '', type: null, body: raw }
  const s = split(raw)
  if (!s) return fallback
  const doc = YAML.parseDocument(s.yaml)
  if (doc.errors.length > 0) return fallback
  const data = doc.toJS()
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return fallback
  const d = data as Record<string, unknown>
  const name = d.name === undefined || d.name === null ? '' : String(d.name)
  const description = d.description === undefined || d.description === null ? '' : String(d.description)
  return { name: name || fallback.name, description, type: typeOf(d), body: trimBody(s.body) }
}

// The destination is `(file)`, or `(<file>)` for a name with whitespace or parens (CommonMark form).
const INDEX_LINE = /^- \[((?:\\.|[^\]\\])*)\]\((?:<([^<>\r\n]+)>|([^)\s]+))\)(?:[ \t]+[—-].*|[ \t]*)$/

export function parseIndex(raw: string): Map<string, { title: string; line: number }> {
  const out = new Map<string, { title: string; line: number }>()
  raw.split(/\r?\n/).forEach((text, i) => {
    const m = INDEX_LINE.exec(text)
    const file = m ? (m[2] ?? m[3]) : ''
    if (!m || out.has(file)) return
    out.set(file, { title: m[1].replace(/\\([\\[\]()])/g, '$1'), line: i + 1 })
  })
  return out
}

const NEEDS_ANGLE = /[\s()]/

/** False for a name no index line can link: `<` or `>` cannot sit inside `<…>`. */
export function indexLinkable(file: string): boolean {
  return !(NEEDS_ANGLE.test(file) && /[<>]/.test(file))
}

export function indexLine(title: string, file: string, description: string): string {
  const t = title.replace(/[\\[\]()]/g, '\\$&')
  const dest = NEEDS_ANGLE.test(file) ? `<${file}>` : file
  return description === '' ? `- [${t}](${dest})` : `- [${t}](${dest}) — ${description}`
}

const typeWord = (type: string | null): string => (type !== null && (MEMORY_TYPES as readonly string[]).includes(type) ? type : 'other')

export function newMemoryFile(type: string | null, title: string, taken: ReadonlySet<string>): { file: string; name: string } {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  slug = slug.slice(0, SLUG_MAX).replace(/^_+|_+$/g, '')
  if (slug === '') slug = 'memory'
  const base = `${typeWord(type)}_${slug}`
  let file = `${base}.md`
  for (let n = 2; taken.has(file); n++) file = `${base}_${n}.md`
  return { file, name: slug.replace(/_/g, '-') }
}

function yamlText(doc: YAML.Document): string {
  const y = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  return y.endsWith('\n') ? y : `${y}\n`
}

const bodyText = (body: string): string => `${body.replace(/\s+$/, '')}\n`

export function serializeNewMemory(name: string, input: MemoryInput): string {
  const doc = new YAML.Document({ name, description: input.description })
  if (input.type !== null) doc.setIn(['metadata', 'type'], input.type)
  return `---\n${yamlText(doc)}---\n\n${bodyText(input.body)}`
}

export function updateMemoryFile(raw: string, input: MemoryInput, fallbackName: string): string {
  const s = split(raw)
  const doc = s ? YAML.parseDocument(s.yaml) : null
  const data = doc && doc.errors.length === 0 ? doc.toJS() : null
  if (!s || !doc || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return serializeNewMemory(fallbackName, input)
  }
  const d = data as Record<string, unknown>
  if (d.name === undefined || d.name === null || String(d.name) === '') doc.set('name', fallbackName)
  doc.set('description', input.description)
  if (input.type !== typeOf(d)) {
    // Write the type where it already was, so a plain `type:` stays plain.
    const nested = str((d.metadata as Record<string, unknown> | null | undefined)?.type) !== null
    const path = nested ? ['metadata', 'type'] : d.type !== undefined && !doc.hasIn(['metadata']) ? ['type'] : ['metadata', 'type']
    if (input.type === null) doc.deleteIn(path)
    else doc.setIn(path, input.type)
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const conv = (t: string): string => (eol === '\n' ? t : t.replace(/\r?\n/g, eol))
  return `---${eol}${conv(yamlText(doc))}---${eol}${eol}${conv(bodyText(input.body))}`
}

export function isMemoryFileName(file: string): boolean {
  return file.length <= FILE_NAME_MAX && file.endsWith('.md') && !file.startsWith('.') && file !== MEMORY_INDEX && !/[/\\\0\r\n]/.test(file)
}

function line(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string' || /[\r\n]/.test(v)) throw new TypeError(field)
  const t = v.trim()
  if (t.length < min || t.length > max) throw new TypeError(field)
  return t
}

/** Errors name the field only, never the text. */
export function checkMemoryInput(v: unknown): MemoryInput {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('memory')
  const o = v as Record<string, unknown>
  const title = line(o.title, 'title', 1, TITLE_MAX)
  const description = line(o.description, 'description', 0, DESCRIPTION_MAX)
  // Any short type is allowed: an existing memory may carry one outside the four, and keeps it.
  const type = o.type === null ? null : line(o.type, 'type', 1, TYPE_MAX)
  if (typeof o.body !== 'string' || o.body.trim() === '' || o.body.length > BODY_MAX) throw new TypeError('body')
  return { title, description, type, body: o.body }
}

export function effectiveLimit(v: number | null | undefined): number {
  return (MEMORY_LIMITS as readonly number[]).includes(v as number) ? (v as number) : MEMORY_LIMIT_DEFAULT
}

export function capNote(count: number, limit: number): string {
  if (count < limit) return `Agent memory: you have ${count} of at most ${limit} memories.`
  return `Agent memory is full (${count} of ${limit}). Do not add a new memory file. To save something new, update a related memory with the combined text, or merge two related memories into one and delete the other. Never delete a memory that is still true only to make room. If nothing can be merged, tell the user that memory is full.`
}

export function memoryLineText(t: MemoryTouch, roomAgent: string | null): string {
  const parts = [t.saved > 0 ? `${t.saved} saved` : '', t.updated > 0 ? `${t.updated} updated` : ''].filter(Boolean)
  return `${roomAgent === null ? 'Memory' : `${roomAgent}'s memory`}: ${parts.join(', ')}`
}
