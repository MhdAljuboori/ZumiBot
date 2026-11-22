import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { EditorContent, useEditor, type Editor, type UseEditorOptions } from '@tiptap/react'
import { Node } from '@tiptap/core'
import { Document } from '@tiptap/extension-document'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Text } from '@tiptap/extension-text'
import { Placeholder, UndoRedo } from '@tiptap/extensions'
import { Slice } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import type { CommandPick } from '@zumibot/shared/commands'
import type { AgentSummary } from '@zumibot/shared/types'
import { CommandHighlight } from '../composerExtensions'
import { filterCommands, slashQuery, type AgentCommandOption, type CommandOption } from '../state/commandInput'
import { caretMenuPlace, docToPrompt, promptToDoc, type DocNode, type MenuPlace } from '../state/promptFields'
import { CommandMenu } from './CommandMenu'

/** A webhook field inside the prompt; it reads as the path and is saved as {{path}}. */
const FieldChip = Node.create({
  name: 'fieldChip',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { path: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'span[data-path]', getAttrs: (el) => ({ path: (el as HTMLElement).dataset.path ?? '' }) }]
  },
  renderHTML({ node }) {
    return ['span', { class: 'field-chip', 'data-testid': 'field-chip', 'data-path': node.attrs.path }, node.attrs.path]
  },
  renderText: ({ node }) => `{{${node.attrs.path}}}`
})

interface Props {
  value: string
  onChange: (text: string) => void
  /** The test call's field paths for a webhook routine, which turns on chips and the `{{` menu; null = plain text. */
  fields: string[] | null
  /** Filled with a function that puts a chip at the cursor. */
  insertRef: RefObject<((path: string) => void) | null>
  placeholder?: string
  /** Whose commands a leading `/` lists (the target agent, or a room's members); none = no `/` menu. */
  commandAgents?: AgentSummary[]
  /** A room: the `/` menu lists the commands under each agent. */
  grouped?: boolean
  /** The `/` menu's pick for the leading `/name`, which colors it like the composer does. */
  pick?: CommandPick | null
  onPick?: (pick: CommandPick) => void
  /** Several fields on one page (a workflow step's prompt and system prompt) tell themselves apart by these. */
  ariaLabel?: string
  testId?: string
  /** A tall field (the expand dialog): the `{{` menu opens at the caret, since under the field is off screen. */
  menuAtCaret?: boolean
  /** Focus the start of the text once the editor is made. */
  autoFocus?: boolean
}

interface Query {
  from: number
  to: number
  query: string
}

// A leading `/name` being typed: only in the prompt's first line, as in the composer.
function slashAt(state: EditorState): Query | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  const q = slashQuery($from.parent.textBetween(0, $from.parentOffset, undefined, '￼'), $from.index(0) === 0)
  // A routine prompt never resolves /todo (it is plain text there), so a `/todo /x` line offers no menu.
  return q === null || q.afterTodo ? null : { from: $from.start(), to: $from.pos, query: q.query }
}

// The `{{word` right before the caret, as a document range.
function braceQuery(state: EditorState): Query | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const m = /\{\{([A-Za-z0-9_.-]*)$/.exec(before)
  return m ? { from: $from.pos - m[0].length, to: $from.pos, query: m[1] } : null
}
const sameQuery = (a: Query | null, b: Query | null): boolean =>
  a === b || (a !== null && b !== null && a.from === b.from && a.to === b.to && a.query === b.query)

export function PromptField({
  value,
  onChange,
  fields,
  insertRef,
  placeholder = 'What should the agent do?',
  commandAgents,
  grouped = false,
  pick: picked = null,
  onPick,
  ariaLabel = 'Prompt',
  testId = 'routine-prompt-input',
  menuAtCaret = false,
  autoFocus = false
}: Props) {
  const chips = fields !== null
  const [query, setQuery] = useState<Query | null>(null)
  const [slash, setSlash] = useState<Query | null>(null)
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  // The `{{` and the `/` whose menu Esc closed.
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const [slashClosedAt, setSlashClosedAt] = useState<number | null>(null)

  const options = chips && query ? fields.filter((f) => f.toLowerCase().includes(query.query.toLowerCase())) : []
  // No `/btw` or `/todo` here: a side question needs a chat to ask in, and a routine prompt is sent as a message (a command
  // that makes to-dos asks for the list by itself).
  const commands: AgentCommandOption[] =
    commandAgents && slash ? filterCommands(slash.query, commandAgents).filter((o): o is AgentCommandOption => !('builtin' in o)) : []
  // Never both: a `/` query needs the line to start with `/name`, a `{{` one the braces right before the caret.
  const commandOpen = slash !== null && focused && slashClosedAt !== slash.from && commands.length > 0
  const menuOpen = !commandOpen && query !== null && focused && closedAt !== query.from && options.length > 0
  const count = commandOpen ? commands.length : options.length
  const activeIndex = Math.min(active, count - 1)

  const pick = (path: string): void => {
    if (!editor || !query) return
    const { from, to } = query
    editor.chain().focus().insertContentAt({ from, to }, { type: 'fieldChip', attrs: { path } }).run()
  }

  const pickCommand = (o: CommandOption): void => {
    if (!editor || !slash || 'builtin' in o) return
    const { from, to } = slash
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(`/${o.command.name} `, from, to)
        return true
      })
      .run()
    // After the insert's own update, which dropped the old pick.
    onPick?.({ agent: o.agent.name, name: o.command.name })
  }

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!(menuOpen || commandOpen) || e.isComposing) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (commandOpen) pickCommand(commands[activeIndex])
      else pick(options[activeIndex])
      return true
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (commandOpen) setSlashClosedAt(slash.from)
      else if (query) setClosedAt(query.from)
      return true
    }
    return false
  }

  // The editor is made once; its handlers reach the latest render through this.
  const latest = useRef({ onChange, onKeyDown, placeholder, commandAgents, picked })
  latest.current = { onChange, onKeyDown, placeholder, commandAgents, picked }

  const [editorOptions] = useState<UseEditorOptions>(() => ({
    extensions: [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      ...(chips ? [FieldChip] : []),
      CommandHighlight.configure({ agents: () => latest.current.commandAgents, pick: () => latest.current.picked }),
      Placeholder.configure({ placeholder: () => latest.current.placeholder, showOnlyWhenEditable: false })
    ],
    content: promptToDoc(value, chips),
    autofocus: autoFocus ? 'start' : false,
    editorProps: {
      attributes: { class: 'composer-input rt-prompt-input', 'data-testid': testId, 'aria-label': ariaLabel, 'aria-multiline': 'true' },
      handleKeyDown: (_v, e) => latest.current.onKeyDown(e),
      // Pasted text becomes lines (and chips for pasted {{fields}}), never rich HTML.
      clipboardTextParser: (text, _ctx, _plain, view) =>
        Slice.maxOpen(view.state.schema.nodeFromJSON(promptToDoc(text.replace(/\r\n?/g, '\n'), chips)).content),
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, '\n', (n) => (n.type.name === 'fieldChip' ? `{{${n.attrs.path}}}` : ''))
    },
    onUpdate: ({ editor: ed }) => {
      latest.current.onChange(docToPrompt(ed.getJSON() as DocNode))
      setActive(0)
      if (braceQuery(ed.state) === null) setClosedAt(null)
      if (slashAt(ed.state) === null) setSlashClosedAt(null)
    },
    onTransaction: ({ editor: ed }) => {
      const next = chips ? braceQuery(ed.state) : null
      setQuery((q) => (sameQuery(q, next) ? q : next))
      const lead = slashAt(ed.state)
      setSlash((q) => (sameQuery(q, lead) ? q : lead))
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false)
  }))
  const editor: Editor | null = useEditor(editorOptions)

  // Cancel and Save replace the prompt from outside; typing echoes the same string back and changes nothing.
  useEffect(() => {
    if (editor && docToPrompt(editor.getJSON() as DocNode) !== value)
      editor.commands.setContent(promptToDoc(value, chips), { emitUpdate: false })
  }, [editor, value, chips])

  // The command's color lives outside the document: a no-op transaction repaints it.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('promptProps', true))
  }, [editor, commandAgents, picked])

  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<MenuPlace | null>(null)
  // Measured before paint, and again as the field scrolls under an open menu.
  useLayoutEffect(() => {
    if (!menuAtCaret || !menuOpen || !editor || !query) {
      setPlace(null)
      return
    }
    const measure = (): void => {
      if (!box.current || editor.isDestroyed) return
      setPlace(caretMenuPlace(editor.view.coordsAtPos(query.to), box.current.getBoundingClientRect(), window.innerHeight))
    }
    measure()
    const dom = editor.view.dom
    dom.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      dom.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [menuAtCaret, menuOpen, editor, query])
  const menuStyle: CSSProperties | undefined =
    place === null
      ? undefined
      : place.top !== undefined
        ? { left: place.left, top: place.top }
        : { left: place.left, top: 'auto', bottom: place.bottom }

  useEffect(() => {
    insertRef.current = (path) => {
      editor?.chain().focus().insertContent({ type: 'fieldChip', attrs: { path } }).run()
    }
    return () => {
      insertRef.current = null
    }
  }, [editor, insertRef])

  return (
    <div ref={box} className="rt-prompt" data-testid="routine-prompt">
      <EditorContent editor={editor} />
      {commandOpen && <CommandMenu options={commands} grouped={grouped} active={activeIndex} onActive={setActive} onPick={pickCommand} />}
      {menuOpen && (
        <div
          className="menu rt-prompt-menu"
          role="listbox"
          aria-label="Insert a field"
          data-testid="field-menu"
          style={menuStyle}
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((path, i) => (
            <button
              key={path}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'on' : undefined}
              data-testid="field-option"
              data-path={path}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(path)}
            >
              <span className="mono">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
