import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, type Editor, type UseEditorOptions } from '@tiptap/react'
import { Document } from '@tiptap/extension-document'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Text } from '@tiptap/extension-text'
import { Placeholder, UndoRedo } from '@tiptap/extensions'
import { Slice } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { TODO_COMMENT_MAX } from '@zumibot/shared/todos'
import type { AgentSummary } from '@zumibot/shared/types'
import { CommentCommandHighlight, MentionHighlight } from '../composerExtensions'
import { commentCommandOptions, commentSlashQuery } from '../state/commandInput'
import { popPlace, type PopPlace } from '../state/commentBox'
import { mentionOptionName, mentionOptions, mentionQuery } from '../state/mentionInput'
import { docToPrompt, promptToDoc, type DocNode } from '../state/promptFields'
import { CommandMenu } from './CommandMenu'
import { MentionMenu } from './MentionMenu'
import { isMac } from './WorkflowMenu'

interface Props {
  /** The agents an `@` lists; each one mentioned answers under the comment, and `/` lists the mentioned ones' commands. */
  members: AgentSummary[]
  busy: boolean
  placeholder: string
  label: string
  submitLabel: string
  initial?: string
  autoFocus?: boolean
  testId?: string
  /** The post button's own test id, when it is not `<testId>-post`. */
  postTestId?: string
  /** Resolves true when it was posted, so the box empties. */
  onSubmit(text: string): Promise<boolean>
  onCancel?(): void
}

/** The `@word` or `/word` being typed right before the caret, as a document range. */
interface Typed {
  kind: 'mention' | 'command'
  from: number
  to: number
  query: string
}

function typedAt(state: EditorState): Typed | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const m = mentionQuery(before, before.length)
  if (m) return { kind: 'mention', from: $from.start() + m.start, to: $from.pos, query: m.query }
  const s = commentSlashQuery(before, before.length)
  return s ? { kind: 'command', from: $from.start() + s.start, to: $from.pos, query: s.query } : null
}
const sameTyped = (a: Typed | null, b: Typed | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.from === b.from && a.to === b.to && a.query === b.query)
const textOf = (editor: Editor): string => docToPrompt(editor.getJSON() as DocNode)

/**
 * A card's comment box: markdown source as plain lines, with the composer's `@` list and its mention chips (an agent's
 * display name in its color while the caret is away from the handle), and a `/` list of the commands of every agent the
 * comment mentions, grouped by agent when it mentions several. Both lists float over the drawer (a portal: the drawer
 * clips what overflows it). Arrows, Enter or Tab pick, Esc closes a list first. Ctrl or Cmd with Enter posts; Enter
 * alone is a new line, as comments run long.
 */
export function TodoCommentBox({
  members,
  busy,
  placeholder,
  label,
  submitLabel,
  initial = '',
  autoFocus = false,
  testId = 'todo-comment',
  postTestId,
  onSubmit,
  onCancel
}: Props) {
  const [text, setText] = useState(initial)
  const [typed, setTyped] = useState<Typed | null>(null)
  const [focused, setFocused] = useState(autoFocus)
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const field = useRef<HTMLDivElement>(null)

  const options = typed?.kind === 'mention' ? mentionOptions(typed.query, members, false) : []
  const commands = typed?.kind === 'command' ? commentCommandOptions(typed.query, text, members) : []
  const count = typed?.kind === 'mention' ? options.length : commands.length
  const open = focused && typed !== null && closedAt !== typed.from && count > 0
  const at = Math.min(active, count - 1)
  const grouped = new Set(commands.map((o) => o.agent.name)).size > 1

  const replaceTyped = (insert: string): void => {
    if (!editor || !typed) return
    const { from, to } = typed
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(insert, from, to)
        return true
      })
      .run()
  }
  const pick = (name: string): void => replaceTyped(`@${name} `)
  const pickCommand = (name: string): void => replaceTyped(`/${name} `)
  const pickAt = (i: number): void => {
    if (typed?.kind === 'mention') pick(mentionOptionName(options[i]!))
    else pickCommand(commands[i]!.command.name)
  }
  const post = async (): Promise<void> => {
    if (!editor || busy) return
    const value = textOf(editor)
    if (value.trim() === '') return
    if (await onSubmit(value)) editor.commands.setContent(promptToDoc('', false))
  }

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (e.isComposing) return false
    if (open && typed) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive((at + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
        return true
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        pickAt(at)
        return true
      }
      if (e.key === 'Escape') {
        e.stopPropagation() // the drawer closes on Esc: the list goes first
        setClosedAt(typed.from)
        return true
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void post()
      return true
    }
    if (e.key === 'Escape' && onCancel) {
      e.stopPropagation()
      onCancel()
      return true
    }
    return false
  }

  // The editor is made once; its handlers and props reach the latest render through this.
  const latest = useRef({ onKeyDown, placeholder, members })
  latest.current = { onKeyDown, placeholder, members }

  const [editorOptions] = useState<UseEditorOptions>(() => ({
    extensions: [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      Placeholder.configure({ placeholder: () => latest.current.placeholder, showOnlyWhenEditable: false }),
      MentionHighlight.configure({ members: () => latest.current.members, everyone: () => false }),
      CommentCommandHighlight.configure({ members: () => latest.current.members })
    ],
    content: promptToDoc(initial, false),
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        class: 'field composer-input todo-comment-input',
        'data-testid': `${testId}-input`,
        'aria-label': label,
        'aria-multiline': 'true',
        role: 'textbox'
      },
      handleKeyDown: (_v, e) => latest.current.onKeyDown(e),
      // A comment is markdown source: pasted text stays lines, never rich HTML.
      clipboardTextParser: (pasted, _ctx, _plain, view) =>
        Slice.maxOpen(view.state.schema.nodeFromJSON(promptToDoc(pasted.replace(/\r\n?/g, '\n'), false)).content),
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n'),
      // The stored comment has a cap; typing past it is refused, as the textarea's maxLength did.
      handleTextInput: (view, _from, _to, input) => docToPrompt(view.state.doc.toJSON() as DocNode).length + input.length > TODO_COMMENT_MAX
    },
    onUpdate: ({ editor: ed }) => {
      setText(textOf(ed))
      setActive(0)
      if (typedAt(ed.state) === null) setClosedAt(null)
    },
    onTransaction: ({ editor: ed }) => {
      const next = typedAt(ed.state)
      setTyped((q) => (sameTyped(q, next) ? q : next))
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false)
  }))
  const editor = useEditor(editorOptions)

  // Mention colors and names live outside the document: a no-op transaction repaints them when the agents change.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('commentMembers', true))
  }, [editor, members])

  // Measured before paint, and again as anything scrolls under an open list or the window resizes.
  const [place, setPlace] = useState<PopPlace | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    const measure = (): void => {
      const r = field.current?.getBoundingClientRect()
      if (r) setPlace(popPlace(r, window.innerHeight))
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, text])

  const menu =
    open &&
    place &&
    createPortal(
      <div
        className="todo-comment-pop"
        data-testid={`${testId}-pop`}
        style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
      >
        {typed?.kind === 'mention' ? (
          <MentionMenu options={options} members={members} active={at} onActive={setActive} onPick={pick} />
        ) : (
          <CommandMenu
            options={commands}
            grouped={grouped}
            active={at}
            onActive={setActive}
            onPick={(o) => {
              if (!('builtin' in o)) pickCommand(o.command.name)
            }}
          />
        )}
      </div>,
      document.body
    )

  return (
    <form
      className="todo-comment-form"
      data-testid={`${testId}-form`}
      onSubmit={(e) => {
        e.preventDefault()
        void post()
      }}
    >
      <div className="todo-comment-field" ref={field}>
        <EditorContent editor={editor} />
      </div>
      {menu}
      <div className="todo-card-buttons todo-comment-bar">
        <span className="todo-comment-tip">@ to ask an agent · Markdown · {isMac() ? '⌘↵' : 'Ctrl+↵'} to send</span>
        {onCancel && (
          <button type="button" className="btn small" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="btn small primary"
          data-testid={postTestId ?? `${testId}-post`}
          disabled={busy || text.trim() === ''}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
