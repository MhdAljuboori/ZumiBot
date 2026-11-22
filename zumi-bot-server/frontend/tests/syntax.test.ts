import { describe, expect, it } from 'vitest'
import { rowsFromTexts, rowsOfText, type Row } from '../src/state/filesPanel'
import { HIGHLIGHT_MAX, hastLines, languageOf, rowTokens, toneOf, type HNode, type Highlight, type Tok } from '../src/state/syntax'
import { highlightLines } from '../src/syntaxEngine'

const el = (className: string[], ...children: HNode[]): HNode => ({ type: 'element', properties: { className }, children })
const tx = (value: string): HNode => ({ type: 'text', value })
const root = (...children: HNode[]): HNode => ({ type: 'root', children })
const spell = (toks: Tok[] | null): string | null => (toks ? toks.map((t) => t.text).join('') : null)
const tones = (toks: Tok[] | null): Array<[string, string | null]> => (toks ?? []).map((t) => [t.text, t.tone])

describe('toneOf', () => {
  it('maps a scope, a sub-scope and its parent', () => {
    expect(toneOf(['hljs-keyword'])).toBe('kw')
    expect(toneOf(['hljs-title', 'function_'])).toBe('fn')
    expect(toneOf(['hljs-title', 'class_'])).toBe('type')
    expect(toneOf(['hljs-title', 'class_', 'inherited__'])).toBe('type')
    expect(toneOf(['hljs-variable', 'language_'])).toBe('type')
  })
  it('keeps the parent tone for an unknown scope, and goes plain for a substitution', () => {
    expect(toneOf(['hljs-params'])).toBeUndefined()
    expect(toneOf(['language-ts'])).toBeUndefined()
    expect(toneOf(['hljs-subst'])).toBeNull()
  })
})

describe('hastLines', () => {
  it('splits text at newlines and keeps a tone across them', () => {
    const lines = hastLines(root(el(['hljs-comment'], tx('/* a\nb */')), tx('\nx = '), el(['hljs-number'], tx('1'))))
    expect(lines.map(tones)).toEqual([
      [['/* a', 'com']],
      [['b */', 'com']],
      [
        ['x = ', null],
        ['1', 'num']
      ]
    ])
  })
  it('lets an inner scope win, an unknown one inherit, and a substitution reset', () => {
    const lines = hastLines(
      root(el(['hljs-string'], tx('`a'), el(['hljs-subst'], tx('${'), el(['hljs-params'], tx('b')), tx('}')), tx('`')))
    )
    expect(lines.map(tones)).toEqual([
      [
        ['`a', 'str'],
        ['${b}', null],
        ['`', 'str']
      ]
    ])
  })
  it('gives an empty line no tokens, and a trailing newline an empty last line', () => {
    expect(hastLines(root(tx('a\n\nb\n')))).toEqual([[{ text: 'a', tone: null }], [], [{ text: 'b', tone: null }], []])
  })
})

// A stand-in highlighter: every word `if` is a keyword, and a line inside /* */ (tracked across lines) is a comment.
const fake: Highlight = (lang, text) => {
  if (lang !== 'fake') return null
  let open = false
  return text.split('\n').map((line): Tok[] => {
    if (line.startsWith('/*')) open = true
    const tone = open ? ('com' as const) : null
    if (line.endsWith('*/')) open = false
    if (tone) return line === '' ? [] : [{ text: line, tone }]
    return line
      .split(/(\bif\b)/)
      .filter(Boolean)
      .map((t) => ({ text: t, tone: t === 'if' ? ('kw' as const) : null }))
  })
}

describe('rowTokens', () => {
  it('colours each side of a diff as its own text, kept lines from the new side', () => {
    const rows = rowsFromTexts('a\nif x\nb\n', 'a\nif y\nb\n')
    const toks = rowTokens(rows, 'fake', fake)
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx'])
    expect(toks[0]).toBeNull()
    expect(rows.slice(1).map((r, i) => spell(toks[i + 1]) === r.text)).toEqual([true, true, true, true])
    expect(tones(toks[2])).toEqual([
      ['if', 'kw'],
      [' x', null]
    ])
    expect(tones(toks[3])).toEqual([
      ['if', 'kw'],
      [' y', null]
    ])
  })

  it('follows the whole file with `full`, so a hunk inside a block comment reads as one', () => {
    const before = '/*\n1\n2\n3\n4\n5\nif\n*/\n'
    const after = '/*\n1\n2\n3\n4\n5\nif!\n*/\n'
    const rows = rowsFromTexts(before, after)
    const added = rows.findIndex((r) => r.kind === 'add')
    expect(rows[1].text).not.toBe('/*') // the hunk starts inside the comment
    expect(tones(rowTokens(rows, 'fake', fake)[added])).toEqual([
      ['if', 'kw'],
      ['!', null]
    ])
    expect(tones(rowTokens(rows, 'fake', fake, { old: before, new: after })[added])).toEqual([['if!', 'com']])
  })

  it('maps a whole-file view by its line numbers, old and new alike', () => {
    const text = 'if a\nb\n'
    const old = rowsOfText(text, 'old')
    expect(rowTokens(old, 'fake', fake, { old: text, new: null }).map(spell)).toEqual(['if a', 'b'])
    const neu = rowsOfText(text, 'new')
    expect(rowTokens(neu, 'fake', fake, { old: null, new: text }).map(spell)).toEqual(['if a', 'b'])
  })

  it("draws a Windows line ending's row without the \\r, and drops tokens that do not spell the row", () => {
    const rows = rowsOfText('if a\r\nb\r\n', 'new')
    expect(rowTokens(rows, 'fake', fake).map(spell)).toEqual(['if a', 'b'])
    const liar: Highlight = () => [[{ text: 'nope', tone: 'kw' }]]
    expect(rowTokens(rowsOfText('if a\n', 'new'), 'x', liar)).toEqual([null])
  })

  it('leaves everything plain for an unknown language or past the size cap', () => {
    const rows = rowsOfText('if a\n', 'new')
    expect(rowTokens(rows, 'nope', fake)).toEqual([null])
    const big: Row[] = [{ kind: 'ctx', text: 'x'.repeat(HIGHLIGHT_MAX + 1), oldNo: null, newNo: 1 }]
    expect(rowTokens(big, 'fake', fake)).toEqual([null])
  })
})

describe('the real highlighter', () => {
  it('colours TypeScript and spells every line exactly', () => {
    const text = '/** doc\n * more */\nexport function add(a: number): string {\n  return `${a}` // done\n}\n'
    const lines = highlightLines('typescript', text)!
    expect(lines.map(spell)).toEqual(text.split('\n'))
    expect(lines[0].every((t) => t.tone === 'com')).toBe(true)
    expect(lines[1].every((t) => t.tone === 'com')).toBe(true)
    expect(tones(lines[2])).toContainEqual(['export', 'kw'])
    expect(tones(lines[2])).toContainEqual(['add', 'fn'])
    expect(lines[3].some((t) => t.tone === 'str')).toBe(true)
    expect(lines[3].some((t) => t.tone === 'com' && t.text === '// done')).toBe(true)
  })
  it('knows the extra Dockerfile grammar and refuses an unknown language', () => {
    expect(highlightLines('dockerfile', 'FROM node:22\n')![0][0]).toEqual({ text: 'FROM', tone: 'kw' })
    expect(highlightLines('no-such-language', 'x')).toBeNull()
  })
  it('keeps markup as text: an HTML file is tokens, never elements', () => {
    const lines = highlightLines('xml', '<img src=x onerror="alert(1)">')!
    expect(spell(lines[0])).toBe('<img src=x onerror="alert(1)">')
  })
})

describe('languageOf', () => {
  it('reads extensions and well-known names, case aside', () => {
    expect(languageOf('src/app/Chat.component.ts')).toBe('typescript')
    expect(languageOf('a/b.TSX')).toBe('typescript')
    expect(languageOf('index.html')).toBe('xml')
    expect(languageOf('styles.scss')).toBe('scss')
    expect(languageOf('Makefile')).toBe('makefile')
    expect(languageOf('docker/Dockerfile.dev')).toBe('dockerfile')
    expect(languageOf('pyproject.toml')).toBe('ini')
    expect(languageOf('.bashrc')).toBe('bash')
  })
  it('leaves unknown and extensionless files plain', () => {
    expect(languageOf('LICENSE')).toBeNull()
    expect(languageOf('data.bin')).toBeNull()
    expect(languageOf('.gitignore')).toBeNull()
  })
})
