import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { EditorContent, useEditor, type Editor, type UseEditorOptions } from '@tiptap/react'
import { Blockquote } from '@tiptap/extension-blockquote'
import { Code } from '@tiptap/extension-code'
import { CodeBlock } from '@tiptap/extension-code-block'
import { Document } from '@tiptap/extension-document'
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Text } from '@tiptap/extension-text'
import { UndoRedo } from '@tiptap/extensions'
import { Slice } from '@tiptap/pm/model'
import { Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { CommandPick } from '@zumibot/shared/commands'
import type { AgentSummary } from '@zumibot/shared/types'
import {
  CommandHighlight,
  ComposerKeys,
  editorQuery,
  editorSlash,
  MentionHighlight,
  sameQuery,
  sameSlash,
  type EditorQuery,
  type SlashQuery
} from '../composerExtensions'
import { coarsePointer } from '../media'
import { offersTodo } from '../state/agentEngine'
import { filterCommands, keepPick, type CommandOption } from '../state/commandInput'
import { fromMarkdown, toMarkdown } from '../state/composerMarkdown'
import { holdsSend, micDisabled, micVisible } from '../state/dictation'
import { editMenuPlace, type EditMenuPlace } from '../state/editMenu'
import { mentionOptionName, mentionOptions, type MentionOption } from '../state/mentionInput'
import { spaceDictation } from '../state/voice'
import { useDictation, useVoiceOn } from '../useDictation'
import { CommandMenu } from './CommandMenu'
import { DictationButton, DictationStrip } from './Dictation'
import { MentionMenu } from './MentionMenu'

interface Props {
  /** The message as markdown, as the composer sent it. */
  initial: string
  /** The message keeps its files, so it can be sent with no text. */
  hasAttachments: boolean
  /** The request is on its way: Send waits. */
  busy: boolean
  /** Whose commands a leading `/` lists, as in the composer; none: no menu. */
  commandAgents?: AgentSummary[]
  /** A room: the menu groups the commands under a header per member. */
  grouped?: boolean
  /** Whom typing `@` lists, as in the composer: a room's members, or the agents a single chat can ask; none: no list. */
  mentionMembers?: AgentSummary[]
  /** The list offers `@everyone` (a room). */
  everyone?: boolean
  onCancel: () => void
  /** `pick` is the `/` menu's command when the text still starts with it, so the server knows whose command it is. */
  onSend: (text: string, pick?: CommandPick) => void
}

/**
 * The user's bubble turned into the composer's editor: the same formatting, and mentions drawn by display name. Keys
 * match the composer: Enter sends and Shift+Enter makes a line; on a touch keyboard Enter makes a line and Ctrl or
 * Cmd+Enter sends. Esc cancels. A leading `/` opens the composer's command menu and an `@` the composer's mention list
 * (arrows, Enter or Tab pick; Esc closes it first, and only then cancels); both float over the chat.
 */
export function MessageEditor({
  initial,
  hasAttachments,
  busy,
  commandAgents,
  grouped = false,
  mentionMembers,
  everyone = false,
  onCancel,
  onSend
}: Props) {
  const [text, setText] = useState(initial)
  // The text and the pick as of now: a dictation's insert and its held send run before the next render.
  const textNow = useRef(initial)
  const pickNow = useRef<CommandPick | null>(null)
  const voiceOn = useVoiceOn()
  const dictation = useDictation({ insert: (t) => insertDictation(t), send: () => sendNow(textNow.current) })
  // A dictation is content: Send waits for its text, so the button stays on.
  const dictating = holdsSend(dictation.state)
  const canSend = !busy && (text.trim() !== '' || hasAttachments || dictating)

  // Both lists stay closed until the first change, so a message ending in `/name` or `@name` opens without one; Esc
  // closes a list for that `/` or `@` until it is finished or removed, as in the composer. The `/` menu wins.
  const [typed, setTyped] = useState(false)
  const [focused, setFocused] = useState(true)
  const [query, setQuery] = useState<EditorQuery | null>(null)
  const [slash, setSlash] = useState<SlashQuery | null>(null)
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const [slashClosedAt, setSlashClosedAt] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const commands: CommandOption[] =
    commandAgents && slash
      ? filterCommands(slash.query, commandAgents, { afterTodo: slash.afterTodo, todo: offersTodo(commandAgents), runWorkflow: false })
      : []
  const mentions: MentionOption[] = mentionMembers && query ? mentionOptions(query.query, mentionMembers, everyone) : []
  const commandOpen = typed && focused && slash !== null && slashClosedAt !== slash.from && commands.length > 0
  const mentionOpen = !commandOpen && typed && focused && query !== null && closedAt !== query.from && mentions.length > 0
  const count = commandOpen ? commands.length : mentions.length
  const activeIndex = Math.min(active, count - 1)

  // Takes the text, since the state can be a render behind a dictation's insert; the rules are the typed message's.
  const sendNow = (value: string): void => {
    if (busy || (value.trim() === '' && !hasAttachments)) return
    // Checked against the agents as they are now, as the composer does.
    onSend(value, keepPick(value, pickNow.current, commandAgents ?? []) ?? undefined)
  }

  /** The user's Send (button, Enter): while dictating, it waits for the text instead. */
  const submit = (): void => {
    if (dictation.requestSend()) return
    sendNow(textNow.current)
  }

  /** At the selection (kept while blurred), as plain text; no focus, so a phone keyboard stays as it was. */
  const insertDictation = (t: string): void => {
    if (!editor || editor.isDestroyed) return
    const { from, to, $from } = editor.state.selection
    const before = $from.parentOffset > 0 ? editor.state.doc.textBetween(from - 1, from, undefined, '￼') : null
    editor
      .chain()
      .command(({ tr }) => {
        tr.insertText(spaceDictation(t, before, null), from, to)
        return true
      })
      .run()
  }

  /** Replaces the query's range with `inserted`, then puts the caret after it. */
  const replace = (range: EditorQuery, inserted: string): void => {
    editor
      ?.chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(inserted, range.from, range.to)
        return true
      })
      .run()
  }

  const pickMention = (name: string): void => {
    if (query) replace(query, `@${name} `)
  }

  const pickCommand = (o: CommandOption): void => {
    if (!slash) return
    replace(slash, `/${'builtin' in o ? o.builtin : o.command.name} `)
    // After the insert's own update, which dropped the old pick; a no-op transaction recolors the `/name`.
    pickNow.current = 'builtin' in o ? null : { agent: o.agent.name, name: o.command.name }
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('composerProps', true))
  }

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if ((commandOpen || mentionOpen) && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
        return true
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (commandOpen) pickCommand(commands[activeIndex])
        else pickMention(mentionOptionName(mentions[activeIndex]))
        return true
      }
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (commandOpen && slash) setSlashClosedAt(slash.from)
        else if (query) setClosedAt(query.from)
        return true
      }
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey || !coarsePointer())) {
      submit()
      return true
    }
    return false
  }

  // Rich text from a page or another editor comes in as its plain text, so pasted code keeps its indentation.
  const onPaste = (view: EditorView, e: ClipboardEvent): boolean => {
    const pasted = e.clipboardData?.getData('text/plain')
    if (!pasted) return false
    view.pasteText(pasted)
    return true
  }

  const onUpdate = (ed: Editor): void => {
    const value = toMarkdown(ed.getJSON())
    textNow.current = value
    setText(value)
    setTyped(true)
    setActive(0)
    pickNow.current = keepPick(value, pickNow.current)
    if (editorQuery(ed.state) === null) setClosedAt(null)
    if (editorSlash(ed.state) === null) setSlashClosedAt(null)
  }

  // The editor is made once; its handlers and props reach the latest render through this.
  const latest = useRef({ mentionMembers, everyone, commandAgents, onKeyDown, onPaste, onUpdate })
  latest.current = { mentionMembers, everyone, commandAgents, onKeyDown, onPaste, onUpdate }

  const [editorOptions] = useState<UseEditorOptions>(() => ({
    extensions: [
      Document,
      Paragraph,
      Text,
      Blockquote,
      Code,
      CodeBlock.configure({ enableTabIndentation: true, tabSize: 2 }),
      BulletList,
      OrderedList,
      ListItem,
      ListKeymap,
      UndoRedo,
      ComposerKeys,
      MentionHighlight.configure({ members: () => latest.current.mentionMembers, everyone: () => latest.current.everyone }),
      CommandHighlight.configure({ agents: () => latest.current.commandAgents, pick: () => pickNow.current })
    ],
    content: fromMarkdown(initial),
    editorProps: {
      attributes: {
        class: 'composer-input msg-edit-text',
        'data-testid': 'message-editor-input',
        'aria-label': 'Edit message',
        'aria-multiline': 'true',
        role: 'textbox'
      },
      handleKeyDown: (_view, e) => latest.current.onKeyDown(e),
      handlePaste: (view, e) => latest.current.onPaste(view, e),
      clipboardTextParser: (t, _context, _plain, view) =>
        Slice.maxOpen(view.state.schema.nodeFromJSON(fromMarkdown(t.replace(/\r\n?/g, '\n'))).content),
      clipboardTextSerializer: (slice) => toMarkdown({ type: 'doc', content: slice.content.toJSON() })
    },
    onUpdate: ({ editor }) => latest.current.onUpdate(editor),
    onTransaction: ({ editor }) => {
      const next = editorQuery(editor.state)
      setQuery((q) => (sameQuery(q, next) ? q : next))
      const nextSlash = editorSlash(editor.state)
      setSlash((q) => (sameSlash(q, nextSlash) ? q : nextSlash))
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false)
  }))
  const editor = useEditor(editorOptions)

  // Opens with the caret at the end, as the composer does; at once (Tiptap's focus waits a frame), so a key pressed
  // right after the box shows (Esc) reaches it.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.commands.setTextSelection(Selection.atEnd(editor.state.doc).from)
    editor.view.dom.focus({ preventScroll: true })
  }, [editor])

  // The mention and command colors live outside the document: a no-op transaction repaints them.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('composerProps', true))
  }, [editor, mentionMembers, everyone, commandAgents])

  const box = useRef<HTMLDivElement>(null)
  const menuOpen = commandOpen || mentionOpen
  const place = useMenuPlace(box, menuOpen, commandOpen ? 420 : 240, text)

  let menu: ReactNode = null
  if (commandOpen)
    menu = <CommandMenu options={commands} grouped={grouped} active={activeIndex} onActive={setActive} onPick={pickCommand} />
  else if (mentionOpen && mentionMembers)
    menu = <MentionMenu options={mentions} members={mentionMembers} active={activeIndex} onActive={setActive} onPick={pickMention} />

  return (
    <div className="msg-edit" data-testid="message-editor" ref={box}>
      <EditorContent editor={editor} className="msg-edit-input" />
      {menu && place && (
        <div className="msg-edit-menu" style={{ left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}>
          {menu}
        </div>
      )}
      {/* Stays for an error or a recording after voice is turned off. */}
      {(voiceOn || dictation.state.phase !== 'idle') && <DictationStrip d={dictation} />}
      <div className="msg-edit-btns">
        {micVisible(voiceOn, dictation.state) && <DictationButton d={dictation} disabled={micDisabled(busy, dictation.state)} />}
        <button type="button" className="btn small" data-testid="message-editor-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn small primary"
          data-testid="message-editor-send"
          disabled={!canSend || dictation.state.sendAfter}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </div>
  )
}

/**
 * The open list's spot over the chat, next to the edit box: fixed, so the chat's scroll box never clips it. Follows the
 * box as the chat scrolls, the window resizes or the text grows.
 */
function useMenuPlace(box: RefObject<HTMLDivElement | null>, open: boolean, width: number, text: string): EditMenuPlace | null {
  const [place, setPlace] = useState<EditMenuPlace | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    const measure = (): void => {
      const r = box.current?.getBoundingClientRect()
      if (r) setPlace(editMenuPlace(r, { width: window.innerWidth, height: window.innerHeight }, { width, height: 260 }))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [box, open, width, text])
  return place
}
