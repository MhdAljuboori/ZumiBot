import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Element } from 'hast'
import { isDark } from '../theme'
import { CopyCodeButton } from './CodeBlock'

type Mermaid = typeof import('mermaid').default

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The source of a ```mermaid block, or null for any other `<pre>`. */
export function mermaidSource(pre: Element | undefined): string | null {
  const code = pre?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code') return null
  const classes = code.properties.className
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return null
  return code.children.map((c) => (c.type === 'text' ? c.value : '')).join('')
}

function subscribeTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY)
  const attr = new MutationObserver(onChange)
  attr.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] })
  media.addEventListener('change', onChange)
  return () => {
    attr.disconnect()
    media.removeEventListener('change', onChange)
  }
}

const darkNow = (): boolean => isDark(document.documentElement, window.matchMedia(DARK_QUERY).matches)
// The look a diagram is drawn for: the theme and the color theme, so changing either redraws it.
const lookNow = (): string => `${darkNow() ? 'dark' : 'light'}:${document.documentElement.dataset.accent ?? 'blue'}`

/** A token as the hex Mermaid's color math reads: a probe resolves light-dark() for the theme showing now. */
function tokenHex(probe: HTMLElement, token: string): string {
  probe.style.color = `var(${token})`
  const [r = 0, g = 0, b = 0] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number)
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

// Mermaid's own themes are lavender: the diagram takes the app's color theme instead (its 'base' theme, fed the tokens).
function themeVariables(dark: boolean): Record<string, string | boolean> {
  const probe = document.createElement('span')
  probe.hidden = true
  document.body.append(probe)
  const t = (token: string) => tokenHex(probe, token)
  const vars = {
    darkMode: dark,
    background: t('--bg'),
    primaryColor: t('--tile-bg'),
    primaryTextColor: t('--fg'),
    primaryBorderColor: t('--ring'),
    secondaryColor: t('--bg-raised'),
    tertiaryColor: t('--bg-hover'),
    lineColor: t('--fg-muted'),
    textColor: t('--fg'),
    edgeLabelBackground: t('--bg'),
    clusterBkg: t('--bg-raised'),
    clusterBorder: t('--border')
  }
  probe.remove()
  return vars
}

// Mermaid is about 2 MB, so it loads only when a reply first holds a diagram.
let mermaid: Promise<Mermaid> | null = null
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

/** Diagram source to SVG. Mermaid's config and render scratch space are global, so renders run one at a time. */
function renderDiagram(code: string, dark: boolean): Promise<string> {
  mermaid ??= import('mermaid').then(
    (m) => m.default,
    (err: unknown) => {
      mermaid = null // a failed chunk load is retried by the next diagram
      throw err
    }
  )
  const loading = mermaid
  const run = queue.then(async () => {
    const api = await loading
    // strict: the SVG is sanitized and click handlers are off, since agent text can carry anything a page fed it.
    // A %%{init}%% line in the diagram cannot lift it: securityLevel is one of Mermaid's secure keys.
    api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: themeVariables(dark),
      fontFamily: getComputedStyle(document.body).fontFamily
    })
    return (await api.render(`mermaid-${++seq}`, code)).svg
  })
  queue = run.catch(() => undefined)
  return run
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DiagramIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.5" y="9.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 6.5v3a2 2 0 0 0 2 2h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** A ```mermaid block drawn as a diagram, with its source a click away. Shows the source while loading or when it fails. */
export function MermaidBlock({ code }: { code: string }) {
  const look = useSyncExternalStore(subscribeTheme, lookNow)
  const dark = look.startsWith('dark')
  // The last finished render: a theme switch keeps the old picture until the new one is ready.
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [showCode, setShowCode] = useState(false)

  useEffect(() => {
    let current = true
    renderDiagram(code, dark).then(
      (out) => {
        if (!current) return
        setSvg(out)
        setFailed(false)
      },
      () => {
        if (!current) return
        setSvg(null)
        setFailed(true)
      }
    )
    return () => {
      current = false
    }
  }, [code, dark, look])

  const source = code.replace(/\n$/, '')
  const drawn = svg !== null && !showCode
  return (
    <div className="code-block diagram-block" data-testid="mermaid-block">
      {drawn ? (
        <div className="mermaid-diagram" data-testid="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
      )}
      {failed && <div className="diagram-error">Diagram failed to render</div>}
      <div className="code-tools">
        {svg !== null && (
          <button
            type="button"
            className="code-copy"
            data-testid="diagram-toggle"
            aria-label={drawn ? 'Show code' : 'Show diagram'}
            data-tip={drawn ? 'Show code' : 'Show diagram'}
            onClick={() => setShowCode(drawn)}
          >
            {drawn ? <CodeIcon /> : <DiagramIcon />}
          </button>
        )}
        <CopyCodeButton text={() => source} />
      </div>
    </div>
  )
}
