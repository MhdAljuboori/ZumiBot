import type { Element, Nodes, Properties } from 'hast'

// An allowlist, not a sanitizer pass over a full serializer: anything not named here never reaches the page.
const ELEMENTS = new Set([
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'input',
  'section',
  'sup'
])
const VOID = new Set(['br', 'hr', 'img', 'input'])
const TOKEN_RE = /^[A-Za-z0-9_-]{1,100}$/
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/
const ALIGN = new Set(['left', 'right', 'center'])

export function escapeHtml(s: string): string {
  return s
    .replace(/\u0000/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A link or image address the page may keep: relative, or a scheme on the list. Browsers drop tabs and newlines inside a scheme, so any character outside a scheme's own fails it. */
export function safeUrl(url: string, image: boolean): string | null {
  const u = url.trim()
  if (u === '') return null
  const colon = u.indexOf(':')
  const sep = u.search(/[/?#]/)
  if (colon < 0 || (sep >= 0 && sep < colon)) return image ? null : u // an image must not load from the file's own folder
  const scheme = u.slice(0, colon).toLowerCase()
  return (image ? /^https$/ : /^(https?|mailto)$/).test(scheme) ? u : null
}

const str = (v: Properties[string]): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null)

function attrsOf(el: Element): string {
  const p = el.properties ?? {}
  const out: string[] = []
  const add = (name: string, value: string | true): void => {
    out.push(value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`)
  }
  if (Array.isArray(p.className)) {
    const cls = p.className.filter((c): c is string => typeof c === 'string' && TOKEN_RE.test(c))
    if (cls.length > 0) add('class', cls.join(' '))
  }
  const id = str(p.id)
  if (id !== null && ID_RE.test(id)) add('id', id)
  if (el.tagName === 'a') {
    const href = str(p.href)
    const safe = href === null ? null : safeUrl(href, false)
    if (safe !== null) add('href', safe)
  }
  if (el.tagName === 'img') {
    const src = str(p.src)
    const safe = src === null ? null : safeUrl(src, true)
    if (safe !== null) add('src', safe)
    add('alt', str(p.alt) ?? '')
    add('loading', 'lazy')
    add('referrerpolicy', 'no-referrer')
  }
  if (el.tagName === 'a' || el.tagName === 'img') {
    const title = str(p.title)
    if (title !== null) add('title', title)
  }
  if (el.tagName === 'ol' && typeof p.start === 'number' && Number.isInteger(p.start)) add('start', String(p.start))
  if ((el.tagName === 'th' || el.tagName === 'td') && typeof p.align === 'string' && ALIGN.has(p.align))
    add('style', `text-align:${p.align}`)
  if (el.tagName === 'input') {
    add('type', 'checkbox')
    if (p.checked === true) add('checked', true)
    add('disabled', true)
  }
  for (const [prop, name] of [
    ['dataFootnoteRef', 'data-footnote-ref'],
    ['dataFootnoteBackref', 'data-footnote-backref'],
    ['dataFootnotes', 'data-footnotes']
  ] as const) {
    if (p[prop] === true || p[prop] === '') add(name, true)
  }
  const describedBy = p.ariaDescribedBy
  const ids = (Array.isArray(describedBy) ? describedBy : [describedBy]).filter((v): v is string => typeof v === 'string' && ID_RE.test(v))
  if (ids.length > 0) add('aria-describedby', ids.join(' '))
  const label = str(p.ariaLabel)
  if (label !== null) add('aria-label', label)
  return out.join('')
}

/** HTML text of a hast tree, keeping only the allowlisted elements and attributes; other elements give their children. */
export function hastToHtml(node: Nodes): string {
  switch (node.type) {
    case 'root':
      return node.children.map(hastToHtml).join('')
    case 'text':
      return escapeHtml(node.value)
    case 'element': {
      const inner = node.children.map(hastToHtml).join('')
      if (!ELEMENTS.has(node.tagName)) return inner
      const open = `<${node.tagName}${attrsOf(node)}>`
      return VOID.has(node.tagName) ? open : `${open}${inner}</${node.tagName}>`
    }
    default:
      // raw, comment and doctype nodes: the export never passes HTML through.
      return ''
  }
}
