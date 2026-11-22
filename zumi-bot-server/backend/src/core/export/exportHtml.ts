import type { Nodes as MdNodes, Root as MdRoot } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { toHast } from 'mdast-util-to-hast'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { guardInlineMath, type MathGuardNode } from '@zumibot/shared/mathGuard'
import { closeFences, formatTime, type ExportBlock, type ExportDoc } from './chatExport'
import { escapeHtml, hastToHtml } from './hastHtml'

/** Raw HTML in a message reads as text, as it does in the chat. */
function htmlAsText(node: MdNodes): void {
  if (!('children' in node)) return
  node.children.forEach((child, i) => {
    if (child.type === 'html') (node.children as MdNodes[])[i] = { type: 'text', value: child.value }
    else htmlAsText(child)
  })
}

/**
 * One message's Markdown as HTML: GFM and math parsed as the chat parses them, math kept as TeX source. `prefix` keeps
 * footnote ids apart between messages on one page.
 */
export function markdownToHtml(text: string, prefix: string): string {
  const source = closeFences(text)
  const tree: MdRoot = fromMarkdown(source, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] })
  guardInlineMath(tree as unknown as MathGuardNode, source)
  htmlAsText(tree)
  return hastToHtml(toHast(tree, { clobberPrefix: prefix }))
}

const STYLE = `
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--soft:#f6f8fa;--user:#eef4ff;--accent:#0969da;--error:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--soft:#161b22;--user:#132036;--accent:#4493f8;--error:#f85149}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans","Noto Sans Arabic",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px}
h1.title{font-size:26px;line-height:1.3;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 24px}
.msg{border-top:1px solid var(--line);padding:16px 0}
.msg.more{border-top:0;padding-top:0}
.msg.user .body{background:var(--user);border-radius:10px;padding:2px 14px}
.who{font-size:13px;color:var(--muted);margin-bottom:6px}
.who strong{color:var(--fg);font-size:14px}
.tag{border:1px solid var(--line);border-radius:999px;padding:0 8px;margin-left:6px;font-size:12px}
.files{color:var(--muted);font-size:13px;font-style:italic}
.body p,.body li,.body h1,.body h2,.body h3,.body h4,.body h5,.body h6,.body blockquote,.body td,.body th,.qa dt,.qa dd{unicode-bidi:plaintext}
.body img{max-width:100%}
.body a[href]{color:var(--accent)}
.body blockquote{margin:0;padding:0 12px;border-left:3px solid var(--line);color:var(--muted)}
.body table{border-collapse:collapse;display:block;overflow-x:auto}
.body th,.body td{border:1px solid var(--line);padding:4px 10px}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);border-radius:4px;padding:1px 4px}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
pre code{background:none;padding:0}
.steps{margin:4px 0 12px;font-size:13px;color:var(--muted)}
.steps summary{cursor:pointer}
.steps ul{margin:6px 0 0;padding-left:20px}
.steps li.error{color:var(--error)}
.qa dt{font-weight:600}
.qa dd{margin:0 0 8px}
footer{margin-top:32px;color:var(--muted);font-size:12px}
`

function header(who: string, ts: number, zone: string, tag?: string): string {
  return `<div class="who"><strong>${escapeHtml(who)}</strong> · <time datetime="${new Date(ts).toISOString()}">${escapeHtml(formatTime(ts, zone))}</time>${tag ? `<span class="tag">${escapeHtml(tag)}</span>` : ''}</div>`
}

function blockHtml(b: ExportBlock, i: number, zone: string): string {
  const prefix = `m${i}-`
  switch (b.kind) {
    case 'message': {
      const files = b.files.length > 0 ? `<p class="files">Attached: ${b.files.map(escapeHtml).join(', ')}</p>` : ''
      return `<section class="msg ${b.role}${b.more ? ' more' : ''}">${b.more ? '' : header(b.who, b.ts, zone)}<div class="body">${markdownToHtml(b.text, prefix)}</div>${files}</section>`
    }
    case 'steps': {
      const n = b.lines.length
      const items = b.lines.map((l) => `<li${l.error ? ' class="error"' : ''}><code>${escapeHtml(l.text)}</code></li>`).join('')
      return `<details class="steps"><summary>${n} ${n === 1 ? 'step' : 'steps'}</summary><ul>${items}</ul></details>`
    }
    case 'questions':
      return `<section class="msg agent">${header(b.who, b.ts, zone, 'asked')}<dl class="qa">${b.pairs.map((p) => `<dt>${escapeHtml(p.question)}</dt><dd>${escapeHtml(p.answer)}</dd>`).join('')}</dl></section>`
    case 'plan':
      return `<section class="msg agent">${header(b.who, b.ts, zone, `plan, ${b.status}`)}<div class="body">${markdownToHtml(b.text, prefix)}</div></section>`
  }
}

/**
 * The export as one self-contained page: inline style, no script, and a CSP that lets it load nothing but https
 * images, so the file is safe to open and to pass on.
 */
export function toHtml(doc: ExportDoc): string {
  const sub = `${doc.subtitle}${doc.reply ? ' · one reply' : ''} · exported ${doc.exported} (${doc.zone})`
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1 class="title">${escapeHtml(doc.title)}</h1>`,
    `<p class="sub">${escapeHtml(sub)}</p>`,
    ...doc.blocks.map((b, i) => blockHtml(b, i, doc.zone)),
    '<footer>Exported from ZumiBot</footer>',
    '</main>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
