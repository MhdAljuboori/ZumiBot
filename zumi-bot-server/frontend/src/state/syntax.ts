import type { Row } from './filesPanel'

// Syntax colours for the Files and Changes panels. Pure: the highlighter itself (lowlight, loaded lazily) is passed in,
// so this file stays testable and out of the main bundle.

/** A colour family; the stylesheet gives each a light and a dark value (`.tk-<tone>`). */
export type Tone =
  'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'attr' | 'tag' | 'meta' | 'var' | 'sec' | 'add' | 'del' | 'em' | 'strong' | 'link'

/** A run of one line's text in one tone; null = the plain text colour. */
export interface Tok {
  text: string
  tone: Tone | null
}

/** Highlights a whole text as one block, giving each line its tokens; null when the language isn't known. */
export type Highlight = (lang: string, text: string) => Tok[][] | null

/** The most text highlighted for one view: past it rows stay plain, so a huge file never stalls the panel. */
export const HIGHLIGHT_MAX = 300_000

// highlight.js scopes (`title.function` arrives as classes `hljs-title function_`) to tones. A scope missing here takes
// its parent's tone, as CSS would; `subst` (`${...}` in a template string) goes back to plain text on purpose.
const TONES: Record<string, Tone | null> = {
  keyword: 'kw',
  'selector-tag': 'kw',
  doctag: 'kw',
  'template-tag': 'kw',
  string: 'str',
  regexp: 'str',
  number: 'num',
  literal: 'num',
  symbol: 'num',
  bullet: 'num',
  'variable.constant': 'num',
  'char.escape': 'num',
  comment: 'com',
  quote: 'com',
  title: 'fn',
  'selector-id': 'fn',
  'title.class': 'type',
  'title.class.inherited': 'type',
  type: 'type',
  built_in: 'type',
  'variable.language': 'type',
  'selector-class': 'type',
  attr: 'attr',
  attribute: 'attr',
  property: 'attr',
  'selector-attr': 'attr',
  'selector-pseudo': 'attr',
  name: 'tag',
  meta: 'meta',
  variable: 'var',
  'template-variable': 'var',
  section: 'sec',
  addition: 'add',
  deletion: 'del',
  emphasis: 'em',
  strong: 'strong',
  link: 'link',
  subst: null
}

/** The tone of an element's classes: a tone, null for plain, undefined to keep the parent's. */
export function toneOf(classes: readonly string[]): Tone | null | undefined {
  const first = classes.find((c) => c.startsWith('hljs-'))
  if (!first) return undefined
  const base = first.slice('hljs-'.length)
  const scope = [base, ...classes.filter((c) => c !== first && c.endsWith('_')).map((c) => c.replace(/_+$/, ''))].join('.')
  if (scope in TONES) return TONES[scope]
  return base in TONES ? TONES[base] : undefined
}

/** The parts of a hast tree this reads; lowlight's Root fits it. */
export interface HNode {
  type: string
  value?: string
  children?: readonly HNode[]
  properties?: { className?: unknown }
}

const classesOf = (n: HNode): string[] => {
  const c = n.properties?.className
  return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? c.split(' ') : []
}

function push(line: Tok[], text: string, tone: Tone | null): void {
  const last = line[line.length - 1]
  if (last && last.tone === tone) last.text += text
  else line.push({ text, tone })
}

/** A highlighted tree cut into lines: a token that spans a newline (a block comment) is split, keeping its tone on both. */
export function hastLines(root: HNode): Tok[][] {
  const lines: Tok[][] = [[]]
  const walk = (node: HNode, tone: Tone | null): void => {
    if (node.type === 'text') {
      const parts = (node.value ?? '').split('\n')
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part !== '') push(lines[lines.length - 1], part, tone)
      })
      return
    }
    let t = tone
    if (node.type === 'element') {
      const own = toneOf(classesOf(node))
      if (own !== undefined) t = own
    }
    for (const c of node.children ?? []) walk(c, t)
  }
  walk(root, null)
  return lines
}

// What a row draws: a trailing \r (a Windows line ending) is not drawn, so it is not highlighted either.
const shown = (text: string): string => text.replace(/\r$/, '')
const isCode = (r: Row): r is Extract<Row, { oldNo: number | null }> => r.kind === 'ctx' || r.kind === 'add' || r.kind === 'del'
// Tokens that don't spell the row's text exactly are dropped: a wrong colour is fine, wrong text never is.
const fits = (toks: Tok[] | undefined, text: string): Tok[] | null =>
  toks && toks.map((t) => t.text).join('') === shown(text) ? toks : null

/**
 * Tokens for each row (null = draw it plain). With the whole old and new texts (`full`), each numbered row takes its
 * line from the highlighted file, so a hunk that starts inside a block comment is still right. Otherwise each run of
 * code rows between headers is highlighted as one block per side: removed lines and kept ones as the old text read,
 * added and kept ones as the new text read.
 */
export function rowTokens(
  rows: readonly Row[],
  lang: string,
  hl: Highlight,
  full?: { old: string | null; new: string | null }
): (Tok[] | null)[] {
  const out: (Tok[] | null)[] = rows.map(() => null)
  const whole = (t: string | null): string => (t ?? '').replace(/\r(?=\n|$)/g, '')
  if (full && whole(full.old).length + whole(full.new).length <= HIGHLIGHT_MAX) {
    const oldLines = full.old === null ? [] : hl(lang, whole(full.old))
    const newLines = full.new === null ? [] : hl(lang, whole(full.new))
    if (oldLines === null || newLines === null) return out
    rows.forEach((r, i) => {
      if (!isCode(r)) return
      const fromNew = r.kind !== 'del' && r.newNo !== null
      const no = fromNew ? r.newNo : r.oldNo
      if (no !== null) out[i] = fits((fromNew ? newLines : oldLines)[no - 1], r.text)
    })
    return out
  }
  let budget = HIGHLIGHT_MAX
  const block = (idx: number[]): Tok[][] | null => {
    const text = idx.map((i) => shown(rows[i].text)).join('\n')
    budget -= text.length
    return budget < 0 ? null : hl(lang, text)
  }
  const segment = (from: number, to: number): void => {
    const idx = Array.from({ length: to - from }, (_, k) => from + k)
    if (idx.length === 0) return
    const oldIdx = idx.filter((i) => rows[i].kind !== 'add')
    const newIdx = idx.filter((i) => rows[i].kind !== 'del')
    const newLines = block(newIdx)
    if (newLines === null) return
    newIdx.forEach((i, k) => {
      out[i] = fits(newLines[k], rows[i].text)
    })
    const delIdx = new Set(idx.filter((i) => rows[i].kind === 'del'))
    if (delIdx.size === 0) return // no removed lines: nothing reads only as the old text
    const oldLines = block(oldIdx)
    if (oldLines === null) return
    oldIdx.forEach((i, k) => {
      if (delIdx.has(i)) out[i] = fits(oldLines[k], rows[i].text)
    })
  }
  let start = 0
  for (let i = 0; i <= rows.length; i++) {
    if (i < rows.length && isCode(rows[i])) continue
    segment(start, i)
    start = i + 1
  }
  return out
}

// File names and extensions to highlight.js language names; only languages the panel's highlighter registers.
const BY_NAME: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.bash_profile': 'bash',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini'
}
const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  webmanifest: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  xml: 'xml',
  svg: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  plist: 'xml',
  vue: 'xml',
  svelte: 'xml',
  csproj: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rb: 'ruby',
  gemspec: 'ruby',
  rake: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  ino: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  m: 'objectivec',
  mm: 'objectivec',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  diff: 'diff',
  patch: 'diff',
  vb: 'vbnet',
  mk: 'makefile',
  mak: 'makefile',
  wat: 'wasm',
  dockerfile: 'dockerfile'
}

/** The highlight.js language for a file path, or null to show it plain. */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith('dockerfile.')) return 'dockerfile' // Dockerfile.dev
  const dot = name.lastIndexOf('.')
  return dot < 0 ? null : (BY_EXT[name.slice(dot + 1)] ?? null)
}
