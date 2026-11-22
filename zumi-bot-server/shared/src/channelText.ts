// Agent replies (Markdown) as a platform's own text, cut to its limit without breaking a code block. Pure.
// Telegram gets HTML parse mode, not MarkdownV2: HTML needs only < > & escaped, while MarkdownV2 fails a whole message on
// one missed escape. Slack gets mrkdwn, where the same three are escaped, so `<!here>` or `<@U…>` in an agent's text never
// pings anyone.

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;')

/** How one platform marks text up. Every input is already escaped by `escape` except where noted. */
export interface Dialect {
  escape(s: string): string
  bold(s: string): string
  italic(s: string): string
  strike(s: string): string
  /** Raw text in, escaped inside. */
  code(raw: string): string
  /** Raw text in, escaped inside. */
  pre(raw: string, lang: string): string
  /** A safe http(s) URL and a raw label. */
  link(url: string, label: string): string
  quote(lines: string[]): string
}

export const TELEGRAM: Dialect = {
  escape: escapeHtml,
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
  strike: (s) => `<s>${s}</s>`,
  code: (raw) => `<code>${escapeHtml(raw)}</code>`,
  pre: (raw, lang) =>
    lang ? `<pre><code class="language-${escapeAttr(lang)}">${escapeHtml(raw)}</code></pre>` : `<pre>${escapeHtml(raw)}</pre>`,
  link: (url, label) => `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`,
  quote: (lines) => `<blockquote>${lines.join('\n')}</blockquote>`
}

// Slack mrkdwn: a backtick inside code can't be escaped, so it becomes a look-alike; a link label loses `|` and `>`.
export const SLACK: Dialect = {
  escape: escapeHtml,
  bold: (s) => `*${s}*`,
  italic: (s) => `_${s}_`,
  strike: (s) => `~${s}~`,
  code: (raw) => `\`${escapeHtml(raw.replace(/`/g, 'ˋ'))}\``,
  pre: (raw) => `\`\`\`\n${escapeHtml(raw.replace(/```/g, 'ˋˋˋ'))}\n\`\`\``,
  link: (url, label) => `<${escapeHtml(url).replace(/\|/g, '%7C')}|${escapeHtml(label).replace(/[|>]/g, ' ')}>`,
  quote: (lines) => lines.map((l) => `&gt; ${l}`).join('\n')
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/

/** A Markdown source cut into blocks: a fenced code block is one block; other text is split at blank lines. */
interface Block {
  kind: 'code'
  fence: string
  lang: string
  lines: string[]
  closed: boolean
}
interface TextBlock {
  kind: 'text'
  lines: string[]
}
type AnyBlock = Block | TextBlock

function blocksOf(md: string): AnyBlock[] {
  const out: AnyBlock[] = []
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  let text: string[] = []
  const flush = () => {
    if (text.some((l) => l.trim() !== '')) out.push({ kind: 'text', lines: text })
    text = []
  }
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i])
    if (m) {
      flush()
      const fence = m[1]
      const body: string[] = []
      let closed = false
      for (i++; i < lines.length; i++) {
        const t = lines[i].trim()
        if (t.startsWith(fence[0].repeat(fence.length)) && t.replace(new RegExp(`^\\${fence[0]}+`), '').trim() === '') {
          closed = true
          break
        }
        body.push(lines[i])
      }
      out.push({ kind: 'code', fence, lang: m[2] ?? '', lines: body, closed })
      continue
    }
    if (lines[i].trim() === '') flush()
    else text.push(lines[i])
  }
  flush()
  return out
}

// --- Inline -------------------------------------------------------------------------------------------------------

const safeUrl = (u: string): string | null => (/^https?:\/\/[^\s"<>]+$/i.test(u) ? u : null)

function inlineText(s: string, d: Dialect): string {
  // Code spans first, so nothing inside them is read as Markdown.
  const parts = s.split(/(`+[^`]*?`+)/g)
  return parts
    .map((p) => {
      const code = /^(`+)([^`]*?)\1$/.exec(p)
      if (code && p.length >= 2) return d.code(code[2])
      return inlinePlain(p, d)
    })
    .join('')
}

function inlinePlain(raw: string, d: Dialect): string {
  const held: string[] = []
  const hold = (out: string) => `\u0000${held.push(out) - 1}\u0000`
  // NUL marks a placeholder, so one in the text itself would be read as one (and swap in another fragment).
  // Links and images become placeholders before escaping, so their URLs are never read for emphasis.
  let s = raw.replace(/\u0000/g, '').replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) => {
    const u = safeUrl(url)
    const label = text.trim() === '' ? url : text
    return hold(u ? d.link(u, label) : d.escape(label))
  })
  s = d.escape(s)
  // Each mark is held as it is made, so a later pattern never reads another's output (Slack's `*` is bold, Markdown's italic).
  s = s.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, (_m, x: string) => hold(d.bold(x)))
  s = s.replace(/(^|[^\w])__(?=\S)([^_]*?\S)__(?=[^\w]|$)/g, (_m, a: string, x: string) => a + hold(d.bold(x)))
  s = s.replace(/~~(?=\S)([^~]*?\S)~~/g, (_m, x: string) => hold(d.strike(x)))
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?=[^*\w]|$)/g, (_m, a: string, x: string) => a + hold(d.italic(x)))
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?=[^\w]|$)/g, (_m, a: string, x: string) => a + hold(d.italic(x)))
  // Held marks may hold others (a link inside bold): unfold until none is left. Each pass opens one level and there are
  // at most as many levels as held marks, so the bound only guards against a bug, never cuts real nesting short.
  for (let i = 0; i <= held.length && s.includes('\u0000'); i++)
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => held[Number(n)] ?? '')
  return s
}

// --- Blocks -------------------------------------------------------------------------------------------------------

function codeHtml(b: Block, d: Dialect): string {
  const body = b.lines.join('\n')
  if (b.lang.toLowerCase() === 'mermaid') return `${d.italic('Diagram (open in ZumiBot to see it drawn)')}\n${d.pre(body, '')}`
  return d.pre(body, b.lang)
}

const isTableLine = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)
const isRuleRow = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

function tableHtml(rows: string[], d: Dialect): string {
  const cells = rows
    .filter((r) => !isRuleRow(r))
    .map((r) =>
      r
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
    )
  const widths: number[] = []
  for (const r of cells) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
  return d.pre(
    cells
      .map((r) =>
        r
          .map((c, i) => c.padEnd(widths[i] ?? 0))
          .join('  ')
          .trimEnd()
      )
      .join('\n'),
    ''
  )
}

function textHtml(lines: string[], d: Dialect): string {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (isTableLine(l)) {
      const rows: string[] = []
      while (i < lines.length && isTableLine(lines[i])) rows.push(lines[i++])
      i--
      out.push(tableHtml(rows, d))
      continue
    }
    if (/^\s*>/.test(l)) {
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      i--
      out.push(d.quote(q.map((x) => inlineText(x, d))))
      continue
    }
    if (/^\s*\$\$/.test(l)) {
      // Display math: the TeX as written, kept apart so its symbols are not read as Markdown.
      const m: string[] = [l]
      if (!(l.trim().length > 2 && l.trim().endsWith('$$')))
        while (++i < lines.length) {
          m.push(lines[i])
          if (lines[i].trim().endsWith('$$')) break
        }
      out.push(d.pre(m.join('\n'), ''))
      continue
    }
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l)
    if (h) {
      out.push(d.bold(inlineText(h[1], d)))
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) {
      out.push('———')
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(l)
    if (bullet) {
      const indent = '  '.repeat(Math.min(3, Math.floor(bullet[1].length / 2)))
      const box = bullet[2] === undefined ? '•' : bullet[2] === ' ' ? '☐' : '☑'
      out.push(`${indent}${box} ${inlineText(bullet[3], d)}`)
      continue
    }
    const num = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(l)
    if (num) {
      out.push(`${'  '.repeat(Math.min(3, Math.floor(num[1].length / 2)))}${num[2]}. ${inlineText(num[3], d)}`)
      continue
    }
    out.push(inlineText(l.trim(), d))
  }
  return out.join('\n')
}

const blockHtml = (b: AnyBlock, d: Dialect): string => (b.kind === 'code' ? codeHtml(b, d) : textHtml(b.lines, d))

export function render(md: string, d: Dialect): string {
  return blocksOf(md)
    .map((b) => blockHtml(b, d))
    .join('\n\n')
}

export const renderTelegram = (md: string): string => render(md, TELEGRAM)
export const renderSlack = (md: string): string => render(md, SLACK)

// --- Splitting ----------------------------------------------------------------------------------------------------

/** One message: its HTML, and the Markdown source it came from (the plain-text fallback when the platform refuses the HTML). */
export interface ChannelPart {
  html: string
  plain: string
}

const blockSource = (b: AnyBlock): string => (b.kind === 'code' ? [b.fence + b.lang, ...b.lines, b.fence].join('\n') : b.lines.join('\n'))

/**
 * Cuts a reply into messages whose rendered HTML fits `limit`. Whole blocks are packed together first; a block too long
 * alone is cut at a line break, then a space, then anywhere. A cut code block is closed and reopened with its language,
 * so every part is a valid block and the code's own text is never changed.
 */
export function splitMessage(md: string, limit: number, d: Dialect = TELEGRAM): ChannelPart[] {
  const blocks = blocksOf(md).flatMap((b) => fitBlock(b, limit, d))
  const parts: ChannelPart[] = []
  let cur: AnyBlock[] = []
  const html = (bs: AnyBlock[]) => bs.map((b) => blockHtml(b, d)).join('\n\n')
  for (const b of blocks) {
    if (cur.length > 0 && html([...cur, b]).length > limit) {
      parts.push({ html: html(cur), plain: cur.map(blockSource).join('\n\n') })
      cur = []
    }
    cur.push(b)
  }
  if (cur.length > 0) parts.push({ html: html(cur), plain: cur.map(blockSource).join('\n\n') })
  return parts
}

/** A block cut into pieces that each render within `limit`. */
function fitBlock(b: AnyBlock, limit: number, d: Dialect): AnyBlock[] {
  if (blockHtml(b, d).length <= limit) return [b]
  const make = (lines: string[]): AnyBlock => (b.kind === 'code' ? { ...b, lines } : { kind: 'text', lines })
  const fits = (lines: string[]) => blockHtml(make(lines), d).length <= limit
  const out: AnyBlock[] = []
  let cur: string[] = []
  for (const line of b.lines) {
    if (fits([...cur, line])) {
      cur.push(line)
      continue
    }
    if (cur.length > 0) {
      out.push(make(cur))
      cur = []
    }
    if (fits([line])) {
      cur.push(line)
      continue
    }
    // One line too long alone: cut at spaces where text allows, else hard (code keeps every character).
    for (const piece of cutLine(line, (s) => fits([s]), b.kind === 'text')) out.push(make([piece]))
  }
  if (cur.length > 0) out.push(make(cur))
  return out
}

function cutLine(line: string, fits: (s: string) => boolean, atSpaces: boolean): string[] {
  const out: string[] = []
  let rest = line
  while (rest.length > 0) {
    if (fits(rest)) {
      out.push(rest)
      break
    }
    // The longest prefix that fits, found by halving (rendering is not linear in length: escapes grow it).
    let lo = 1,
      hi = rest.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(rest.slice(0, mid))) lo = mid
      else hi = mid - 1
    }
    let cut = lo
    // Never between the halves of a surrogate pair: each part would carry a lone half (an emoji shown as �, or a
    // message the platform refuses as bad UTF-8).
    if (cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut--
    if (atSpaces) {
      const sp = rest.lastIndexOf(' ', cut)
      if (sp > cut / 2) cut = sp
    }
    out.push(rest.slice(0, cut))
    rest = atSpaces ? rest.slice(cut).replace(/^ +/, '') : rest.slice(cut)
  }
  return out
}

/** The last `max` characters of a live reply, for a draft preview (the start drops away as it grows). */
export function tailOf(text: string, max: number): string {
  if (text.length <= max) return text
  let start = text.length - max + 1
  if (isLowSurrogate(text.charCodeAt(start))) start++ // not half an emoji at the start
  return '…' + text.slice(start)
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff
