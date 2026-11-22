// The composer editor's own keys and its mention coloring, on top of TipTap's list, code and code block extensions.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { leadingCommand, type CommandPick } from '@zumibot/shared/commands'
import { EVERYONE } from '@zumibot/shared/mentions'
import type { AgentSummary } from '@zumibot/shared/types'
import { mentionLabel, revealsMention } from './state/agentNames'
import { agentInk } from './state/bot'
import { commentCommandMarks, slashQuery } from './state/commandInput'
import { mentionSegments } from './state/groupChat'
import { mentionQuery } from './state/mentionInput'

/**
 * Shift+Enter starts a new line in the composer's terms: the next list item (or, on an empty one, a step out of the
 * list), a line in a code block (two blank ones at its end leave it), a code block from a lone ``` line, a step out of
 * a quote from an empty line in it, else a new paragraph. Tab and Shift+Tab nest and un-nest list items; they never leave the box from inside a list. Enter is the
 * composer's (it sends).
 */
export const ComposerKeys = Extension.create({
  name: 'composerKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': ({ editor }) => {
        const { $from, empty } = editor.state.selection
        const atEnd = empty && $from.parentOffset === $from.parent.content.size
        if ($from.parent.type.name === 'codeBlock') {
          if (atEnd && $from.parent.textContent.endsWith('\n\n')) {
            return editor
              .chain()
              .command(({ tr }) => {
                tr.delete($from.pos - 2, $from.pos)
                return true
              })
              .exitCode()
              .run()
          }
          return editor.commands.newlineInCode()
        }
        const inQuote = $from.node(-1).type.name === 'blockquote'
        const fence = /^```([\w+-]*)$/.exec($from.parent.textContent)
        if (fence && atEnd && ($from.depth === 1 || inQuote)) {
          return editor
            .chain()
            .command(({ tr }) => {
              tr.delete($from.start(), $from.end())
              return true
            })
            .setCodeBlock(fence[1] ? { language: fence[1] } : undefined)
            .run()
        }
        if (inQuote && $from.parent.content.size === 0) return editor.commands.lift('blockquote')
        if (editor.isActive('listItem')) return editor.commands.splitListItem('listItem') || editor.commands.liftListItem('listItem')
        return editor.commands.splitBlock()
      },
      Tab: ({ editor }) => {
        if (!editor.isActive('listItem') || editor.isActive('codeBlock')) return false
        editor.commands.sinkListItem('listItem')
        return true
      },
      'Shift-Tab': ({ editor }) => {
        if (!editor.isActive('listItem') || editor.isActive('codeBlock')) return false
        editor.commands.liftListItem('listItem')
        return true
      }
    }
  }
})

const mentionStyle = (agent: AgentSummary | undefined): string | undefined => {
  const tint = agent && agent.error === null ? agentInk(agent.color) : null
  return tint ? `--mention: ${tint}` : undefined
}

/** A mention's display name, drawn in place of its handle. */
function mentionChip(view: EditorView, label: string, style: string | undefined): HTMLElement {
  const chip = view.dom.ownerDocument.createElement('span')
  chip.className = 'composer-mark composer-mention'
  if (style) chip.setAttribute('style', style)
  chip.textContent = label
  return chip
}

/**
 * Colors @mentions as they are typed, and shows each by its display name (`@Code Specialist`) while the caret is away
 * from it: the handle stays the text of the draft, hidden, and shows again as the caret or a selection reaches it, so it
 * is edited as typed and the caret never lands in hidden text. `members` and `everyone` are read on every update, so a
 * meta-only transaction repaints.
 */
export const MentionHighlight = Extension.create<{ members: () => readonly AgentSummary[] | undefined; everyone: () => boolean }>({
  name: 'mentionHighlight',
  addOptions() {
    return { members: () => undefined, everyone: () => true }
  },
  addProseMirrorPlugins() {
    const members = this.options.members
    const everyone = this.options.everyone
    return [
      new Plugin({
        key: new PluginKey('mentionHighlight'),
        props: {
          decorations: (state) => {
            const agents = members()
            if (!agents) return null
            const names = agents.map((a) => a.name)
            const { from: selFrom, to: selTo } = state.selection
            const marks: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return true
              if (node.type.spec.code) return false
              // Code-marked text is blanked out: a handle inside a code span names nobody.
              let text = ''
              node.forEach((child) => {
                text += child.isText && !child.marks.some((m) => m.type.spec.code) ? child.text : ' '.repeat(child.nodeSize)
              })
              let at = pos + 1
              for (const s of mentionSegments(text, names, everyone())) {
                const len = s.kind === 'text' ? s.text.length : s.raw.length
                if (s.kind === 'mention') {
                  const style = s.name === EVERYONE ? undefined : mentionStyle(agents.find((a) => a.name === s.name))
                  const label = mentionLabel(s.name)
                  if (label === s.raw || revealsMention(at, at + len, selFrom, selTo)) {
                    marks.push(Decoration.inline(at, at + len, style ? { class: 'composer-mark', style } : { class: 'composer-mark' }))
                  } else {
                    marks.push(
                      Decoration.widget(at, (view) => mentionChip(view, label, style), { side: -1, key: `mention:${label}:${style ?? ''}` })
                    )
                    marks.push(Decoration.inline(at, at + len, { class: 'composer-mention-raw' }))
                  }
                }
                at += len
              }
              return false
            })
            return DecorationSet.create(state.doc, marks)
          }
        }
      })
    ]
  }
})

/**
 * Tints a leading `/name` in the first block in its agent's color, the way `MentionHighlight` does: the picked agent's,
 * or the one agent that owns the name when nothing was picked. Several owners and no pick leave it untinted, since the server would refuse it.
 */
export const CommandHighlight = Extension.create<{
  agents: () => readonly AgentSummary[] | undefined
  pick: () => CommandPick | null
}>({
  name: 'commandHighlight',
  addOptions() {
    return { agents: () => undefined, pick: () => null }
  },
  addProseMirrorPlugins() {
    const { agents: agentsOf, pick: pickOf } = this.options
    return [
      new Plugin({
        key: new PluginKey('commandHighlight'),
        props: {
          decorations: (state) => {
            const agents = agentsOf()
            const first = state.doc.firstChild
            if (!agents || !first || first.type.name !== 'paragraph') return null
            // Code-marked text is blanked out, as for mentions: `/check` in a code span is not a command.
            let text = ''
            first.forEach((child) => {
              text += child.isText && !child.marks.some((m) => m.type.spec.code) ? child.text : ' '.repeat(child.nodeSize)
            })
            const lead = leadingCommand(text)
            if (!lead) return null
            const pick = pickOf()
            const owners = agents.filter((a) => a.error === null && (a.commands ?? []).some((c) => c.name === lead.name))
            const agent = pick?.name === lead.name ? agents.find((a) => a.name === pick.agent) : owners.length === 1 ? owners[0] : undefined
            if (!agent) return null
            const style = mentionStyle(agent)
            const attrs = style ? { class: 'composer-mark', style } : { class: 'composer-mark' }
            return DecorationSet.create(state.doc, [Decoration.inline(1, 2 + lead.name.length, attrs)])
          }
        }
      })
    ]
  }
})

/**
 * A comment box's `/name`s that run (`commentCommandMarks`: owned by an agent the comment mentions), tinted as
 * `CommandHighlight` tints the composer's. The comment is read whole, so a mention on another line still counts.
 */
export const CommentCommandHighlight = Extension.create<{ members: () => readonly AgentSummary[] | undefined }>({
  name: 'commentCommandHighlight',
  addOptions() {
    return { members: () => undefined }
  },
  addProseMirrorPlugins() {
    const members = this.options.members
    return [
      new Plugin({
        key: new PluginKey('commentCommandHighlight'),
        props: {
          decorations: (state) => {
            const agents = members()
            if (!agents) return null
            // The box holds plain paragraphs: one line each, joined as the posted text joins them.
            const lines: { at: number; pos: number }[] = []
            let text = ''
            state.doc.forEach((node, pos) => {
              if (lines.length > 0) text += '\n'
              lines.push({ at: text.length, pos: pos + 1 })
              text += node.textContent
            })
            const marks = commentCommandMarks(text, agents).map((m) => {
              const line = lines.filter((l) => l.at <= m.start).at(-1)!
              const from = line.pos + m.start - line.at
              const style = m.agent ? mentionStyle(m.agent) : undefined
              return Decoration.inline(from, from + m.end - m.start, style ? { class: 'composer-mark', style } : { class: 'composer-mark' })
            })
            return marks.length > 0 ? DecorationSet.create(state.doc, marks) : null
          }
        }
      })
    ]
  }
})

// The `@` and `/` queries the composer and the message editor open their lists on.

/** The `@word` being typed right before the caret, as a document range; never inside a code block. */
export interface EditorQuery {
  from: number // the '@'
  to: number // the caret
  query: string
}

export function editorQuery(state: EditorState): EditorQuery | null {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.spec.code) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const q = mentionQuery(before, before.length)
  return q ? { from: $from.start() + q.start, to: $from.pos, query: q.query } : null
}

/** The range is the `/name` being typed; after a leading `/todo ` it leaves that part alone. */
export interface SlashQuery extends EditorQuery {
  afterTodo: boolean
}

/** A leading `/name` being typed: only in the message's first block, and that block a plain paragraph (not a list, quote or code). */
export function editorSlash(state: EditorState): SlashQuery | null {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.spec.code || $from.parent.firstChild?.marks.some((m) => m.type.spec.code)) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const q = slashQuery(before, $from.depth === 1 && $from.index(0) === 0)
  // The query is `/` plus its letters, right before the caret; a leading `/todo ` stays outside the range.
  return q === null ? null : { from: $from.pos - 1 - q.query.length, to: $from.pos, query: q.query, afterTodo: q.afterTodo }
}

export const sameQuery = (a: EditorQuery | null, b: EditorQuery | null): boolean =>
  a === b || (a !== null && b !== null && a.from === b.from && a.to === b.to && a.query === b.query)

export const sameSlash = (a: SlashQuery | null, b: SlashQuery | null): boolean => sameQuery(a, b) && a?.afterTodo === b?.afterTodo
