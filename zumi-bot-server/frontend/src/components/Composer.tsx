import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { EditorContent, useEditor, type Editor, type UseEditorOptions } from '@tiptap/react'
import { Blockquote } from '@tiptap/extension-blockquote'
import { Code } from '@tiptap/extension-code'
import { CodeBlock } from '@tiptap/extension-code-block'
import { Document } from '@tiptap/extension-document'
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Text } from '@tiptap/extension-text'
import { Placeholder, UndoRedo } from '@tiptap/extensions'
import { Slice } from '@tiptap/pm/model'
import { Selection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { CommandPick } from '@zumibot/shared/commands'
import type { EngineCommands } from '@zumibot/shared/engineCommands'
import { displayName } from '@zumibot/shared/frontmatter'
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
import { coarsePointer, keepFocus } from '../media'
import { isBlankBox } from '../state/replyOptions'
import { offersTodo } from '../state/agentEngine'
import { agentInk } from '../state/bot'
import {
  filterCommands,
  filterWorkflowNames,
  keepPick,
  keepWorkflowPick,
  workflowMenuQuery,
  type CommandOption,
  type WorkflowPick
} from '../state/commandInput'
import { fromMarkdown, toMarkdown } from '../state/composerMarkdown'
import { holdsSend, micDisabled, micVisible } from '../state/dictation'
import { mentionOptionName, mentionOptions, type MentionOption } from '../state/mentionInput'
import { isStaging, readyIds, type DraftFiles } from '../state/draftFiles'
import { newer, older, type Browse } from '../state/promptHistory'
import { replySnippet } from '../state/reply'
import { sendKeyAction, type SendHow } from '../state/sendKeys'
import { btwRefusal, routeSend, workflowRefusal } from '../state/sideQuestions'
import { spaceDictation } from '../state/voice'
import { useDictation, useVoiceOn } from '../useDictation'
import { DraftAttachments } from './Attachments'
import { CommandMenu, WorkflowMenu } from './CommandMenu'
import { DictationButton, DictationStrip } from './Dictation'
import { MentionMenu } from './MentionMenu'
import { ReplyIcon } from './MessageActions'

interface Props {
  /** Accessible name of the input; also its placeholder (with an ellipsis) unless one is given. */
  label: string
  placeholder?: string
  /** A suggested reply: the placeholder while the box is empty, and Tab (or the hint button) writes it into the box. */
  suggestion?: string
  /** The message as markdown: what the box shows (lists, code, code blocks) and what Send sends. */
  draft: string
  inFlight: boolean
  /** False while the chat's own CLI is missing (codex for a Codex chat, else claude): the box is read-only. */
  cliFound: boolean
  /** Why Send is held back even with text typed (shown as the button's tooltip), or null. */
  blockedReason?: string | null
  onDraftChange: (text: string) => void
  /**
   * `pick` is the `/` menu's command when the text still starts with it, so the server knows whose command it is;
   * `workflowId` is the Workflows list's pick while the text still starts with `/run-workflow <its name>`.
   */
  // `how`: into the running reply (Enter, a click on Send) or queued for after it (Ctrl/Cmd+Enter, a long press on Send).
  onSend: (text: string, pick?: CommandPick, workflowId?: string, how?: SendHow) => void
  /** Enter can send into the running reply here (takesSteers): Send's tip says so, and a long press on it queues. */
  steers?: boolean
  onStop: () => void
  /** The Pause button beside Stop, shown only while Stop is: null or absent hides it; pausing shows it held. */
  pause?: 'pause' | 'pausing' | null
  onPause?: () => void
  /** Messages can be sent while the chat runs (they wait as tasks), so the button is Stop only while running with nothing typed. */
  allowSendWhileRunning?: boolean
  /** A group's members: typing @ opens a list of them, and their mentions are colored as you type. */
  mentionMembers?: AgentSummary[]
  /** Whether `@everyone` is offered and colored: a room's, but not a single chat's, where `@` asks another agent. Default true. */
  everyone?: boolean
  /** Whose commands a leading `/` lists: the chat's agent, or a room's loadable members (grouped under headers when `mentionMembers` is set). */
  commandAgents?: AgentSummary[]
  /** The chat agent's engine rows after the agent's own in the `/` menu (single chat and new-chat screen only; a room has none). */
  engineCommands?: EngineCommands | null
  /** Whether the `/` menu offers `/btw`: false for an engine without side questions (Codex). Default true. */
  btw?: boolean
  /** A typed leading `/btw` is not sent: this notice shows instead (the island, which has no side panel for the answer). */
  noBtw?: string
  /** Whether the `/` menu offers `/run-workflow` and its Workflows list. Default true; off in the island and on the new-chat screen. */
  runWorkflow?: boolean
  /** The workflows `/run-workflow ` lists (the app's snapshot). */
  workflows?: readonly { id: string; name: string }[]
  /** A typed leading `/run-workflow` is not sent: this notice shows instead (no chat to run it from, or no way to open its run). */
  noRunWorkflow?: string
  /** Files waiting to go with the next message. */
  files?: DraftFiles
  /** Files pasted from the clipboard (File objects). */
  onAddFiles?: (files: File[], origin: 'paste' | 'drop') => void
  /** Files pasted as file:// paths (a file manager's copy). */
  onPickFiles?: () => void
  onRemoveFile?: (key: string) => void
  /** The agent message the next message replies to, shown above the input box; Esc or its ✕ cancels it. */
  reply?: { id: string; agent: AgentSummary; text: string } | null
  onCancelReply?: () => void
  /** Each new value puts the caret at the end of the box (text was quoted into the draft). */
  focusRequest?: number
  /** Messages sent in this chat, oldest first: Up on the box's top line recalls them, Down walks back to the draft. */
  history?: readonly string[]
  /** Shown under the input box. */
  children?: ReactNode
}

/**
 * The range is the name being typed after a leading `/run-workflow `: only in the first block, a plain paragraph. None
 * while a pick holds (the first block still starts with `/run-workflow <its name>`), so the list stays closed after a pick.
 */
function editorWorkflow(state: EditorState, pick: WorkflowPick | null): EditorQuery | null {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.spec.code || $from.parent.firstChild?.marks.some((m) => m.type.spec.code)) return null
  if ($from.depth !== 1 || $from.index(0) !== 0) return null
  const q = workflowMenuQuery($from.parent.textBetween(0, $from.parentOffset, undefined, '￼'), $from.parent.textContent, pick)
  return q === null ? null : { from: $from.pos - q.length, to: $from.pos, query: q }
}

// While a reply runs, Send goes into it; holding Send (or Ctrl+Enter) queues for after it (docs/architecture/mid-turn-messages.md).
const LONG_PRESS_MS = 500
const STEER_TIP = 'Send into this reply (Enter) · Hold or Ctrl+Enter to queue'

const quoteTint = (agent: AgentSummary): CSSProperties | undefined => {
  const tint = agent.error === null ? agentInk(agent.color) : null
  return tint ? ({ '--quote': tint } as CSSProperties) : undefined
}

export function Composer({
  label,
  placeholder = `${label}…`,
  suggestion,
  draft,
  inFlight,
  cliFound,
  blockedReason = null,
  onDraftChange,
  onSend,
  steers = false,
  onStop,
  pause = null,
  onPause,
  allowSendWhileRunning = false,
  mentionMembers,
  everyone = true,
  commandAgents,
  engineCommands,
  btw = true,
  noBtw,
  runWorkflow = true,
  workflows,
  noRunWorkflow,
  files,
  onAddFiles,
  onPickFiles,
  onRemoveFile,
  reply = null,
  onCancelReply,
  focusRequest = 0,
  history = [],
  children
}: Props) {
  const [query, setQuery] = useState<EditorQuery | null>(null)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  // The `@` whose menu Esc closed: it stays closed until that mention is finished or removed.
  const [closedAt, setClosedAt] = useState<number | null>(null)
  // The same for the `/` menu, and the command picked from it (dropped once the leading `/name` is edited).
  const [slash, setSlash] = useState<SlashQuery | null>(null)
  const [slashClosedAt, setSlashClosedAt] = useState<number | null>(null)
  const [pick, setPick] = useState<CommandPick | null>(null)
  // The Workflows list after `/run-workflow `, closed by Esc the same way, and the workflow picked from it (its id goes
  // with Send; dropped once the name after the command is edited).
  const [wfQuery, setWfQuery] = useState<EditorQuery | null>(null)
  const [wfClosedAt, setWfClosedAt] = useState<number | null>(null)
  const [wfPick, setWfPick] = useState<WorkflowPick | null>(null)
  // Repaints Send after the draft effect drops editor texts the render read (a held send's text, then the cleared box).
  const [, repaint] = useState(0)
  // What the last Send took, so a draft restored after a failed send gets its pick back.
  const lastSent = useRef<{ text: string; pick: CommandPick | null; workflow: WorkflowPick | null } | null>(null)
  // Counts sends, so the draft effect checks the box after each one even when the prop didn't change: React batches a
  // dictation's insert (its draft sent up) with the held send's clear, so the prop can go from '' straight back to ''.
  const [sends, setSends] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  // Drafts the editor sent up that the draft prop has not come back with yet, oldest first. The prop can lag a few
  // keystrokes behind the editor; an older one coming back is its own echo, not a change to apply.
  const unseen = useRef<string[]>([])
  // The box's text: the prop lags the editor, most of all right after a dictation's insert, just before its held send.
  const latestText = (): string => unseen.current.at(-1) ?? draft

  const voiceOn = useVoiceOn()
  // Called whether or not the mic shows, so hook order never changes when voice is switched on or off.
  // How the pending send goes: a dictation holds the send for its text, which then goes the way the user sent it.
  const sendHow = useRef<SendHow>('steer')
  const dictation = useDictation({ insert: (text) => insertDictation(text), send: () => submitText(latestText()) })
  // A dictation is content: Send waits for its text, so the button must not turn into Stop.
  const dictating = holdsSend(dictation.state)

  const hasReady = files ? readyIds(files).length > 0 : false
  const staging = files ? isStaging(files) : false
  const ready =
    cliFound && (!inFlight || allowSendWhileRunning) && blockedReason === null && (!staging || routeSend(latestText()).kind === 'btw')
  // Nothing to send: no text, no ready file and no dictation.
  const empty = latestText().trim() === '' && !hasReady && !dictating
  const showStop = inFlight && (!allowSendWhileRunning || empty)
  // Only into an empty box: Tab in a message the user is writing keeps its usual meaning.
  const suggested = suggestion !== undefined && latestText().trim() === '' && !dictating ? suggestion : null
  const shownPlaceholder = suggested ?? placeholder
  const canSend = ready && !empty
  /** The send itself, with the box's latest text; a held send comes here directly, never through submit. */
  const submitText = (text: string): void => {
    if (!ready || (text.trim() === '' && !hasReady)) return
    const refused = btwRefusal(text, noBtw) ?? workflowRefusal(text, noRunWorkflow)
    if (refused !== null) {
      setNotice(refused)
      return
    }
    // Checked against the agents as they are now: the new-chat agent may have been switched since the pick.
    const sent = keepPick(text, pick, commandAgents ?? [], engineCommands)
    const workflow = keepWorkflowPick(text, wfPick)
    lastSent.current = { text, pick: sent, workflow }
    setPick(null)
    // The workflow pick stays: a started run clears the box (the draft effect drops it then), a failed one leaves the
    // text there, and a second Send must still name the picked workflow.
    onSend(text, sent ?? undefined, workflow?.id, sendHow.current)
    setSends((n) => n + 1)
  }
  /** The user's Send (button or a key): while dictating, it waits for the text instead. */
  const submit = (how: SendHow = 'steer'): void => {
    sendHow.current = how
    if (dictation.requestSend()) return
    submitText(latestText())
  }
  // A long press on Send queues instead: the click that ends the press must not send a second time.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressed = useRef(false)
  const endPress = (): void => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
  }
  const startPress = (): void => {
    endPress()
    pressed.current = false
    if (!steers || !inFlight || showStop) return
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      pressed.current = true
      submit('queue')
    }, LONG_PRESS_MS)
  }
  useEffect(() => endPress, [])

  /** The transcript at the caret (replacing a selection), as plain text. No focus: the phone keyboard stays as it was. */
  const insertDictation = (text: string): void => {
    if (!editor || editor.isDestroyed) return
    const { from, to, $from } = editor.state.selection
    const before = $from.parentOffset > 0 ? editor.state.doc.textBetween(from - 1, from, undefined, '￼') : null
    editor
      .chain()
      .command(({ tr }) => {
        tr.insertText(spaceDictation(text, before, null), from, to)
        return true
      })
      .run()
  }

  const options: MentionOption[] = mentionMembers && query ? mentionOptions(query.query, mentionMembers, everyone) : []
  const commands: CommandOption[] =
    commandAgents && slash
      ? filterCommands(slash.query, commandAgents, {
          afterTodo: slash.afterTodo,
          btw,
          todo: offersTodo(commandAgents),
          runWorkflow,
          engine: engineCommands
        })
      : []
  // The Workflows list shows only while it has names: typing past a name closes it.
  const workflowNames = runWorkflow && workflows && wfQuery ? filterWorkflowNames(wfQuery.query, workflows) : []
  // A `/` query, a workflow name and an `@` query never hold at once (the first needs the block to be `/name` alone, the second a space after `/run-workflow`).
  const commandOpen = slash !== null && focused && slashClosedAt !== slash.from && commands.length > 0
  const workflowOpen = wfQuery !== null && focused && wfClosedAt !== wfQuery.from && workflowNames.length > 0
  const menuOpen = !commandOpen && !workflowOpen && query !== null && focused && closedAt !== query.from && options.length > 0
  const count = commandOpen ? commands.length : workflowOpen ? workflowNames.length : options.length
  const activeIndex = Math.min(active, count - 1)

  const insert = (name: string): void => {
    if (!editor || !query) return
    const { from, to } = query
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(`@${name} `, from, to)
        return true
      })
      .run()
  }

  const pickCommand = (o: CommandOption): void => {
    if (!editor || !slash) return
    const { from, to } = slash
    const name = 'builtin' in o ? o.builtin : o.command.name
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(`/${name} `, from, to)
        return true
      })
      .run()
    // After the insert's own update, which saw no pick yet.
    // An engine row belongs to the chat's one agent (engine rows are offered only where `commandAgents` is that agent).
    setPick(
      'builtin' in o
        ? null
        : 'engine' in o
          ? commandAgents?.[0]
            ? { agent: commandAgents[0].name, name: o.command.name, engine: o.engine }
            : null
          : { agent: o.agent.name, name: o.command.name }
    )
  }

  const pickWorkflow = (w: WorkflowPick): void => {
    if (!editor || !wfQuery) return
    const { from, to } = wfQuery
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(`${w.name} `, from, to)
        return true
      })
      .run()
    // After the insert's own update, which saw no pick yet; the list then stays closed while the name is kept.
    setWfPick({ id: w.id, name: w.name })
    setWfQuery(null)
  }

  // Written in as if typed: the draft effect puts it in the box with the caret at the end, and nothing is sent.
  // Read live: an empty code block or list draws no new render, and Tab or the hint must not replace it.
  const boxBlank = (): boolean => !editor || isBlankBox(editor.getJSON())
  const takeSuggestion = (): void => {
    if (suggested === null || !boxBlank()) return
    onDraftChange(suggested)
    editor?.commands.focus('end')
  }

  /**
   * Keys the editor sees first: the @ list's, then Tab (take the suggested reply), Enter (send) and Esc (cancel the reply). True when handled.
   * A touch keyboard's Enter starts a new line instead, the way phone chat apps do: there the Send button sends
   * (and Ctrl or Cmd+Enter, for a keyboard attached to a tablet).
   */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if ((menuOpen || commandOpen || workflowOpen) && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
        return true
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (commandOpen) pickCommand(commands[activeIndex])
        else if (workflowOpen) pickWorkflow(workflowNames[activeIndex])
        else insert(mentionOptionName(options[activeIndex]))
        return true
      }
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (commandOpen) setSlashClosedAt(slash.from)
        else if (workflowOpen) setWfClosedAt(wfQuery.from)
        else if (query) setClosedAt(query.from)
        return true
      }
    }
    if (e.key === 'Tab' && suggested !== null && !e.isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && boxBlank()) {
      takeSuggestion()
      return true
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (recall(e.key === 'ArrowUp')) return true
    }
    const how = sendKeyAction(e, coarsePointer())
    if (how !== null) {
      submit(how)
      return true
    }
    if (e.key === 'Escape' && reply && onCancelReply) {
      onCancelReply()
      return true
    }
    return false
  }

  const onPaste = (view: EditorView, e: ClipboardEvent): boolean => {
    const data = e.clipboardData
    if (!data) return false
    const pasted = Array.from(data.files)
    if (pasted.length > 0 && onAddFiles) {
      onAddFiles(pasted, 'paste')
      return true
    }
    // Rich text from a page or another editor comes in as its plain text, so pasted code keeps its indentation.
    const text = data.getData('text/plain')
    if (!text) return false
    view.pasteText(text)
    return true
  }

  // The sent message the box shows, while walking the history with Up and Down.
  const browse = useRef<Browse | null>(null)

  /** Shows the previous (back) or next sent message. True when it did; false leaves the arrow to move the caret. */
  const recall = (back: boolean): boolean => {
    if (!editor || history.length === 0) return false
    const { view } = editor
    const { selection, doc } = view.state
    // Only from the box's top line (Up) or bottom line (Down): inside a longer message the arrows move the caret.
    const edge = back ? Selection.atStart(doc) : Selection.atEnd(doc)
    if (!selection.empty || selection.$from.start() !== edge.$from.start() || !view.endOfTextblock(back ? 'up' : 'down')) return false
    const current = latestText()
    const next = back ? older(history, browse.current, current) : newer(history, browse.current, current)
    if (!next) return false
    browse.current = next.browse
    // Up leaves the caret at the top, so the next Up goes on back; Down leaves it at the bottom.
    editor
      .chain()
      .setContent(fromMarkdown(next.text), { emitUpdate: false })
      .command(({ tr }) => {
        tr.setSelection(back ? Selection.atStart(tr.doc) : Selection.atEnd(tr.doc))
        return true
      })
      .scrollIntoView()
      .run()
    unseen.current.push(next.text)
    // A recalled message is resolved by name on the server, like one typed by hand.
    setPick(null)
    setWfPick(null)
    onDraftChange(next.text)
    return true
  }

  const onUpdate = (ed: Editor): void => {
    const text = toMarkdown(ed.getJSON())
    if (text !== (unseen.current.at(-1) ?? draft)) {
      unseen.current.push(text)
      onDraftChange(text)
    }
    setPick((p) => keepPick(text, p))
    setWfPick((p) => keepWorkflowPick(text, p))
    setNotice(null)
    setActive(0)
    if (editorQuery(ed.state) === null) setClosedAt(null)
    if (editorSlash(ed.state) === null) setSlashClosedAt(null)
    if (editorWorkflow(ed.state, latest.current.wfPick) === null) setWfClosedAt(null)
  }

  // The editor is made once; its handlers and props reach the latest render through this.
  const latest = useRef({
    label,
    placeholder: shownPlaceholder,
    cliFound,
    mentionMembers,
    everyone,
    commandAgents,
    pick,
    wfPick,
    onKeyDown,
    onPaste,
    onUpdate
  })
  latest.current = { label, placeholder: shownPlaceholder, cliFound, mentionMembers, everyone, commandAgents, pick, wfPick, onKeyDown, onPaste, onUpdate }

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
      Placeholder.configure({ placeholder: () => latest.current.placeholder, showOnlyWhenEditable: false }),
      ComposerKeys,
      MentionHighlight.configure({ members: () => latest.current.mentionMembers, everyone: () => latest.current.everyone }),
      CommandHighlight.configure({ agents: () => latest.current.commandAgents, pick: () => latest.current.pick })
    ],
    content: fromMarkdown(draft),
    // On a touch screen focus would slide the keyboard over the chat just opened; there the box waits for a tap.
    autofocus: coarsePointer() ? false : 'end',
    editorProps: {
      attributes: () => ({
        class: 'composer-input',
        'data-testid': 'composer-input',
        'aria-label': latest.current.label,
        'aria-multiline': 'true',
        'aria-disabled': latest.current.cliFound ? 'false' : 'true'
      }),
      handleKeyDown: (_view, e) => latest.current.onKeyDown(e),
      handlePaste: (view, e) => latest.current.onPaste(view, e),
      // Plain text pastes (and copies) as the draft markdown, so a pasted list or `code` shows styled.
      clipboardTextParser: (text, _context, _plain, view) =>
        Slice.maxOpen(view.state.schema.nodeFromJSON(fromMarkdown(text.replace(/\r\n?/g, '\n'))).content),
      clipboardTextSerializer: (slice) => toMarkdown({ type: 'doc', content: slice.content.toJSON() })
    },
    onUpdate: ({ editor }) => latest.current.onUpdate(editor),
    onTransaction: ({ editor }) => {
      const next = editorQuery(editor.state)
      setQuery((q) => (sameQuery(q, next) ? q : next))
      const nextSlash = editorSlash(editor.state)
      setSlash((q) => (sameSlash(q, nextSlash) ? q : nextSlash))
      // Esc then a cleared draft (emitUpdate:false) never reaches onUpdate, so reopen the menu here.
      if (nextSlash === null) setSlashClosedAt(null)
      const nextWf = editorWorkflow(editor.state, latest.current.wfPick)
      setWfQuery((q) => (sameQuery(q, nextWf) ? q : nextWf))
      if (nextWf === null) setWfClosedAt(null)
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false)
  }))
  const editor = useEditor(editorOptions)

  // A draft set from outside (another chat's, cleared after Send, restored after a failed one) replaces the content.
  // Also run after each send (`sends`), where the prop may not have changed; the draft it then holds is still the truth
  // (cleared in a chat; kept on the new-chat screen until its chat opens, or if starting it failed).
  useEffect(() => {
    if (!editor) return
    const echo = unseen.current.indexOf(draft)
    if (echo >= 0) {
      unseen.current.splice(0, echo + 1)
      return
    }
    if (toMarkdown(editor.getJSON()) === draft) return
    if (unseen.current.length > 0) repaint((n) => n + 1)
    unseen.current = []
    // Cleared after Send this drops the pick; the same text restored after a failed send gets it back.
    const sent = lastSent.current
    setPick((p) => keepPick(draft, p ?? (sent?.text === draft ? sent.pick : null)))
    setWfPick((p) => keepWorkflowPick(draft, p ?? (sent?.text === draft ? sent.workflow : null)))
    editor
      .chain()
      .setContent(fromMarkdown(draft), { emitUpdate: false })
      .command(({ tr }) => {
        tr.setSelection(Selection.atEnd(tr.doc))
        return true
      })
      .run()
  }, [editor, draft, sends])

  useEffect(() => {
    editor?.setEditable(cliFound, false)
  }, [editor, cliFound])

  // The label, placeholder, mention and command colors live outside the document: a no-op transaction repaints them.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('composerProps', true))
  }, [editor, label, shownPlaceholder, mentionMembers, everyone, commandAgents, pick])

  // Picking a message to reply to puts the caret in the box, ready to type the reply.
  const replyId = reply?.id ?? null
  useEffect(() => {
    if (replyId !== null) editor?.commands.focus()
  }, [editor, replyId])

  // After the draft effect above, so the quoted text is already in the box.
  useEffect(() => {
    if (focusRequest > 0) editor?.commands.focus('end')
  }, [editor, focusRequest])

  return (
    <div className="composer">
      {files && <DraftAttachments files={files.files} onRemove={(key) => onRemoveFile?.(key)} />}
      <DictationStrip d={dictation} />
      {notice !== null && (
        <div className="attach-error" role="alert" data-testid="composer-notice">
          {notice}
        </div>
      )}
      {files?.error && (
        <div className="attach-error" role="alert" data-testid="attach-error">
          {files.error}
        </div>
      )}
      {reply && (
        <div className="reply-strip" data-testid="reply-strip" style={quoteTint(reply.agent)}>
          <ReplyIcon />
          <div className="reply-strip-body">
            <span className="reply-strip-name">Replying to {displayName(reply.agent.name)}</span>
            <span className="reply-strip-text">{replySnippet(reply.text)}</span>
          </div>
          <button type="button" className="attach-remove" aria-label="Cancel reply" data-tip="Cancel reply" onClick={onCancelReply}>
            ✕
          </button>
        </div>
      )}
      <div className="composer-box">
        {onPickFiles && (
          <button
            type="button"
            className="attach-btn"
            data-testid="attach-button"
            aria-label="Attach files"
            data-tip="Attach files"
            disabled={!cliFound}
            onClick={onPickFiles}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M13.2 7.4 8.1 12.5a3 3 0 0 1-4.2-4.2l5.4-5.4a2 2 0 0 1 2.8 2.8L6.7 11.1a1 1 0 0 1-1.4-1.4l4.9-4.9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <div className="composer-field">
          <EditorContent editor={editor} className="composer-scroll" />
          {commandOpen && (
            <CommandMenu
              options={commands}
              grouped={mentionMembers !== undefined && everyone}
              active={activeIndex}
              onActive={setActive}
              onPick={pickCommand}
            />
          )}
          {workflowOpen && <WorkflowMenu workflows={workflowNames} active={activeIndex} onActive={setActive} onPick={pickWorkflow} />}
          {menuOpen && mentionMembers && (
            <MentionMenu options={options} members={mentionMembers} active={activeIndex} onActive={setActive} onPick={insert} />
          )}
        </div>
        {suggested !== null && (
          <button
            type="button"
            className="composer-suggestion"
            data-testid="composer-suggestion"
            aria-label={`Use suggested reply: ${suggested}`}
            data-tip={coarsePointer() ? 'Use suggested reply' : 'Press Tab to use it'}
            disabled={!cliFound}
            onMouseDown={keepFocus}
            onClick={takeSuggestion}
          >
            {coarsePointer() ? 'Use' : 'Tab'}
          </button>
        )}
        {micVisible(voiceOn, dictation.state) && <DictationButton d={dictation} disabled={micDisabled(!cliFound, dictation.state)} />}
        {showStop && pause !== null && onPause !== undefined && (
          <button
            type="button"
            className="send-btn pause"
            data-testid="pause-button"
            aria-label="Pause"
            data-tip={pause === 'pausing' ? 'Pausing…' : 'Pause'}
            disabled={pause === 'pausing'}
            onMouseDown={keepFocus}
            onClick={onPause}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4.5" y="4.5" width="2.5" height="7" rx="0.8" fill="currentColor" />
              <rect x="9" y="4.5" width="2.5" height="7" rx="0.8" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={showStop ? 'send-btn stop' : 'send-btn'}
          data-testid="send-button"
          aria-label={showStop ? 'Stop' : 'Send'}
          data-tip={showStop ? 'Stop' : (blockedReason ?? (steers && inFlight && canSend ? STEER_TIP : 'Send'))}
          // Held for a dictation's text: a second press must not send twice.
          disabled={showStop ? false : !canSend || dictation.state.sendAfter}
          onMouseDown={keepFocus}
          onPointerDown={startPress}
          onPointerUp={endPress}
          onPointerLeave={endPress}
          onPointerCancel={endPress}
          // A long press's menu would cover the button on a phone.
          onContextMenu={(e) => {
            if (steers && inFlight && !showStop) e.preventDefault()
          }}
          onClick={() => {
            endPress()
            if (pressed.current) {
              pressed.current = false
              return
            }
            if (showStop) onStop()
            else submit('steer')
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {showStop ? (
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
            ) : (
              <path
                d="M8 13V3.5M3.75 7.5L8 3.25l4.25 4.25"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
          {/* The button's text stays "Send"/"Stop" for screen readers and the e2e checks. */}
          <span className="sr-only">{showStop ? 'Stop' : 'Send'}</span>
        </button>
      </div>
      {children}
    </div>
  )
}
