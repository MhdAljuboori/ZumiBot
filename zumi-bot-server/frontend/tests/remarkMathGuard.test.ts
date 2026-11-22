import { describe, expect, it } from 'vitest'
import type { Nodes, Paragraph, Root } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import { remarkMathGuard } from '../src/remarkMathGuard'

const parse = (md: string): Root => {
  const proc = unified().use(remarkParse).use(remarkMath).use(remarkMathGuard)
  return proc.runSync(proc.parse(md), md)
}

/** The first paragraph's children, with text values joined the way they read. */
const line = (md: string) => {
  const p = parse(md).children[0] as Paragraph
  const kinds = (p.children as Nodes[]).map((n) => n.type)
  const text = (p.children as Nodes[]).map((n) => ('value' in n ? n.value : '')).join('')
  return { kinds, text, math: (p.children as Nodes[]).filter((n) => n.type === 'inlineMath').map((n) => ('value' in n ? n.value : '')) }
}

describe('remarkMathGuard', () => {
  it('keeps plain inline math', () => {
    expect(line('the area is $\\pi r^2$ here').math).toEqual(['\\pi r^2'])
  })

  it('leaves two prices on a line as text', () => {
    const r = line('costs $5 and $10 today')
    expect(r.math).toEqual([])
    expect(r.text).toBe('costs $5 and $10 today')
  })

  it('leaves a pair as text when the opening $ is followed by a space', () => {
    expect(line('a $ x$ b').math).toEqual([])
    expect(line('a $ x$ b').text).toBe('a $ x$ b')
  })

  it('leaves a pair as text when the closing $ follows a space', () => {
    expect(line('a $x $ b').math).toEqual([])
  })

  it('leaves a pair as text when a digit follows the closing $', () => {
    const r = line('from $x$5 up')
    expect(r.math).toEqual([])
    expect(r.text).toBe('from $x$5 up')
  })

  it('keeps math that starts with a digit', () => {
    expect(line('grows like $2^n$, fast').math).toEqual(['2^n'])
  })

  it('keeps inline $$ math as written', () => {
    expect(line('so $$a + b$$ holds').math).toEqual(['a + b'])
  })

  it('keeps display math', () => {
    expect(parse('$$\nE = mc^2\n$$').children[0]).toMatchObject({ type: 'math', value: 'E = mc^2' })
  })

  it('never touches code', () => {
    const r = line('run `echo $5 and $10` now')
    expect(r.kinds).toEqual(['text', 'inlineCode', 'text'])
    expect(r.text).toBe('run echo $5 and $10 now')
  })

  it('reaches math nested in lists and emphasis', () => {
    const tree = parse('- *total $5 and $6*\n- area $x^2$')
    const items = JSON.stringify(tree)
    expect(items).not.toContain('"value":"5 and "')
    expect(items).toContain('"type":"inlineMath","value":"x^2"')
  })
})
