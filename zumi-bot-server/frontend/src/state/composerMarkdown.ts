// The composer's rich text and the markdown draft it stands for, both ways. Only what the composer can make is known:
// paragraphs (one per line), `-` and `1.` lists (nested by indenting to the marker's width), `>` quotes, ``` code blocks and `code`.
// Anything else stays text as typed, unescaped, so a plain message reaches the agent exactly as it was written.
import type { JSONContent } from '@tiptap/core'

const LIST_ITEM = /^(-|\d+\.)(?: (.*))?$/
const FENCE = /^(`{3,})([\w+-]*)\s*$/

const longestRun = (text: string, ch: string): number => Math.max(0, ...(text.match(new RegExp(`${ch}+`, 'g')) ?? []).map((r) => r.length))

function inlineToMarkdown(nodes: JSONContent[] = []): string {
  return nodes
    .map((n) => {
      const text = n.text ?? ''
      if (!n.marks?.some((m) => m.type === 'code')) return text
      const fence = '`'.repeat(longestRun(text, '`') + 1)
      const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
      return fence + pad + text + pad + fence
    })
    .join('')
}

function blocksToLines(nodes: JSONContent[] = []): string[] {
  return nodes.flatMap((n): string[] => {
    if (n.type === 'paragraph') return [inlineToMarkdown(n.content)]
    if (n.type === 'codeBlock') {
      const text = (n.content ?? []).map((t) => t.text ?? '').join('')
      const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1))
      return [fence + (n.attrs?.language ?? ''), ...text.split('\n'), fence]
    }
    if (n.type === 'blockquote') return blocksToLines(n.content).map((line) => (line === '' ? '>' : `> ${line}`))
    if (n.type === 'bulletList' || n.type === 'orderedList') {
      const start = Number(n.attrs?.start ?? 1)
      return (n.content ?? []).flatMap((item, i) => {
        const marker = n.type === 'bulletList' ? '- ' : `${start + i}. `
        const pad = ' '.repeat(marker.length)
        return blocksToLines(item.content).map((line, j) =>
          line === '' ? (j === 0 ? marker.trimEnd() : '') : (j === 0 ? marker : pad) + line
        )
      })
    }
    return n.content ? blocksToLines(n.content) : []
  })
}

const hasText = (n: JSONContent): boolean => (n.text ?? '').trim() !== '' || (n.content ?? []).some(hasText)

/** The draft a composer document stands for; '' while it holds no text (an empty bullet is nothing to send). */
export function toMarkdown(doc: JSONContent): string {
  return hasText(doc) ? blocksToLines(doc.content).join('\n') : ''
}

/** Text with its `code` spans as code-marked text nodes. */
function inlineFromMarkdown(line: string): JSONContent[] {
  const out: JSONContent[] = []
  const push = (text: string, code: boolean): void => {
    if (text) out.push(code ? { type: 'text', text, marks: [{ type: 'code' }] } : { type: 'text', text })
  }
  let plain = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      plain += line[i++]
      continue
    }
    const open = /^`+/.exec(line.slice(i))![0]
    const close = new RegExp(`(?<!\`)${open}(?!\`)`, 'g')
    close.lastIndex = i + open.length
    const end = close.exec(line)
    if (!end) {
      plain += open
      i += open.length
      continue
    }
    let code = line.slice(i + open.length, end.index)
    if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
    push(plain, false)
    plain = ''
    push(code, true)
    i = end.index + open.length
  }
  push(plain, false)
  return out
}

const paragraph = (line: string): JSONContent => {
  const content = inlineFromMarkdown(line)
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function blocksFromLines(lines: string[]): JSONContent[] {
  const out: JSONContent[] = []
  let i = 0
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i])
    if (fence) {
      const closing = new RegExp(`^\`{${fence[1].length},}\\s*$`)
      const body: string[] = []
      for (i++; i < lines.length && !closing.test(lines[i]); i++) body.push(lines[i])
      i++ // past the closing fence (or the end, for one never closed)
      const text = body.join('\n')
      out.push({ type: 'codeBlock', attrs: { language: fence[2] || null }, ...(text ? { content: [{ type: 'text', text }] } : {}) })
      continue
    }
    if (lines[i].startsWith('>')) {
      // The quote runs over each following line that starts with `>`; its text is read as blocks of its own.
      const body: string[] = []
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^> ?/, ''))
      out.push({ type: 'blockquote', content: blocksFromLines(body) })
      continue
    }
    const first = LIST_ITEM.exec(lines[i])
    if (!first) {
      out.push(paragraph(lines[i++]))
      continue
    }
    const ordered = first[1] !== '-'
    const items: JSONContent[] = []
    for (let m: RegExpExecArray | null = first; m && (m[1] !== '-') === ordered; m = i < lines.length ? LIST_ITEM.exec(lines[i]) : null) {
      const pad = ' '.repeat(m[1].length + 1)
      const body = [m[2] ?? '']
      // An item runs on over lines indented to its text; a blank line belongs to it only when more of it follows.
      for (i++; i < lines.length; i++) {
        if (lines[i].startsWith(pad)) body.push(lines[i].slice(pad.length))
        else if (
          lines[i] === '' &&
          lines
            .slice(i)
            .find((l) => l !== '')
            ?.startsWith(pad)
        )
          body.push('')
        else break
      }
      const content = blocksFromLines(body)
      // A list item opens with a paragraph.
      items.push({ type: 'listItem', content: content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content] })
    }
    out.push(
      ordered ? { type: 'orderedList', attrs: { start: parseInt(first[1], 10) }, content: items } : { type: 'bulletList', content: items }
    )
  }
  return out
}

/** The composer document for a draft. */
export function fromMarkdown(text: string): JSONContent {
  return { type: 'doc', content: text === '' ? [{ type: 'paragraph' }] : blocksFromLines(text.split('\n')) }
}
