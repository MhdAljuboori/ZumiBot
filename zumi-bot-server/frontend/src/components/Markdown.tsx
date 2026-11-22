import { createContext, memo, useContext, useMemo, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import type { AgentSummary } from '@zumibot/shared/types'
import { remarkMathGuard } from '../remarkMathGuard'
import { remarkCommands, remarkMentions } from '../remarkMentions'
import { appPath, plainClick } from '../state/appLink'
import { findAgent } from '../state/groupChat'
import { imageItem, viewer } from '../state/viewer'
import { inlineMarkdownProps } from '../state/inlineMarkdown'
import { CodeBlock } from './CodeBlock'
import { MermaidBlock, mermaidSource } from './Diagram'
import { CommandMark, Mention } from './Mention'

/** The chat's mentionable handles (`mentionHandles`) and the agents behind them, for mention chips in agent text; null for none. */
export const MentionScope = createContext<{ members: string[]; agents: AgentSummary[] } | null>(null)

/**
 * Set by the island page, whose window must never change address: an in-app link calls this with its path (any click,
 * modified or not, since the browser's own would navigate that window too) instead of pushing history.
 */
export const AppLinkContext = createContext<((path: string) => void) | null>(null)

/** The element remarkMentions makes for a member's @handle. */
function MentionElement({ name }: { name?: string }) {
  const scope = useContext(MentionScope)
  if (!name) return null
  return <Mention agent={scope ? findAgent(scope.agents, name) : undefined} name={name} />
}

/** The element remarkCommands makes for a comment's `/name`. */
function CommandElement({ name, agent }: { name?: string; agent?: string }) {
  const scope = useContext(MentionScope)
  if (!name) return null
  return <CommandMark name={name} agent={agent && scope ? findAgent(scope.agents, agent) : undefined} />
}

/** A ```mermaid block becomes a diagram; any other block stays code. */
function PreBlock(props: ComponentProps<'pre'> & ExtraProps) {
  const diagram = mermaidSource(props.node)
  return diagram === null ? <CodeBlock {...props} /> : <MermaidBlock code={diagram} />
}

/**
 * A link to one of the app's own pages moves the app there: the address changes and a popstate makes App.tsx's handler
 * open the view through its unsaved-changes guard, as Back does. A modified click keeps the browser's (a new tab).
 */
function AppAnchor({ node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  // No window when rendered on the server side (tests): every link is then an outside one.
  const path = typeof window === 'undefined' ? null : appPath(props.href, window.location.origin)
  const openApp = useContext(AppLinkContext)
  if (path === null) {
    // A new tab: the app must stay open; the desktop shell sends these to the system browser.
    return <a {...props} target="_blank" rel="noopener noreferrer" />
  }
  return (
    <a
      {...props}
      rel="noopener"
      onClick={(e) => {
        props.onClick?.(e)
        if (e.defaultPrevented) return
        if (openApp) {
          e.preventDefault()
          openApp(path)
          return
        }
        if (!plainClick(e)) return
        e.preventDefault()
        // The same address is the same view (the address follows it), so there is nothing to push or open.
        if (path === window.location.pathname + window.location.search + window.location.hash) return
        history.pushState(null, '', path)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }}
    />
  )
}

/**
 * An image in a message opens in the in-app viewer once it has loaded (the CSP blocks other hosts, which never load), with
 * the message's other loaded images a step away.
 */
function MessageImage({ node: _node, ...props }: ComponentProps<'img'> & ExtraProps) {
  const [ready, setReady] = useState(false)
  const open = (img: HTMLImageElement): void => {
    const root = img.closest('.markdown') ?? img.parentElement
    const all = Array.from(root?.querySelectorAll<HTMLImageElement>('img.markdown-img[data-ready]') ?? [img])
    viewer.open(
      all.map((i) => imageItem(i.currentSrc || i.src, i.alt, window.location.origin)),
      all.indexOf(img)
    )
  }
  // Until it loads it is a plain image: one the CSP blocks never becomes a button or a tab stop.
  if (!ready) return <img {...props} className="markdown-img" onLoad={() => setReady(true)} />
  return (
    <img
      {...props}
      className="markdown-img"
      data-ready=""
      onClick={(e) => open(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open(e.currentTarget)
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open ${props.alt || 'image'}`}
    />
  )
}

const markdownComponents = {
  a: AppAnchor,
  img: MessageImage,
  pre: PreBlock,
  // Not HTML elements, so outside what the Components type lists.
  mention: MentionElement,
  command: CommandElement
} as Components

// A reply still being written leaves diagrams as code: a half-sent one would fail to parse on every delta.
const liveComponents = { ...markdownComponents, pre: CodeBlock } as Components

// No <img> at all (a workflow note): the alt text stands in, so a note's Markdown never makes a request. The CSP would
// block another host anyway, but `data:` and same-origin URLs are allowed, and a note is no place for either.
function AltText({ alt }: ComponentProps<'img'> & ExtraProps) {
  return <span className="markdown-img-alt">{alt}</span>
}
const noImageComponents = { ...markdownComponents, img: AltText } as Components
const liveNoImageComponents = { ...liveComponents, img: AltText } as Components

// Inline mode (to-do text): the allow-list and element map are in inlineMarkdown.ts; links are the same safe ones.
const inlineComponents = { ...inlineMarkdownProps.components, a: markdownComponents.a } as Components
const inlinePlugins = [remarkGfm]

// errorColor lands in a style attribute, so the theme token works there.
const rehypePlugins: Options['rehypePlugins'] = [[rehypeKatex, { errorColor: 'var(--error)' }]]

// Memoized: parsing is the costly part of a render, and a long chat would re-parse every message on each keystroke or delta.
// `commands` (a comment's): each `/name` it runs, to the agent whose color it takes ('' for none); keep it memoized.
export const Markdown = memo(function Markdown({
  text,
  live = false,
  inline = false,
  images = true,
  commands
}: {
  text: string
  live?: boolean
  inline?: boolean
  images?: boolean
  commands?: ReadonlyMap<string, string>
}) {
  const scope = useContext(MentionScope)
  const plugins = useMemo(
    () => [
      remarkGfm,
      remarkMath,
      remarkMathGuard,
      ...(scope ? [remarkMentions(scope.members, scope.agents)] : []),
      ...(commands ? [remarkCommands(commands)] : [])
    ],
    [scope, commands]
  )
  if (inline) {
    return (
      <span className="markdown markdown-inline">
        <ReactMarkdown
          remarkPlugins={inlinePlugins}
          allowedElements={inlineMarkdownProps.allowedElements}
          unwrapDisallowed
          components={inlineComponents}
        >
          {text}
        </ReactMarkdown>
      </span>
    )
  }
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={rehypePlugins}
        components={images ? (live ? liveComponents : markdownComponents) : live ? liveNoImageComponents : noImageComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
