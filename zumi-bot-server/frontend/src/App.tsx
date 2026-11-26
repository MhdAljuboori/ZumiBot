import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { ATTACH_MAX_BYTES, stageErrors } from '@zumibot/shared/attachments'
import type { CommandPick } from '@zumibot/shared/commands'
import { sideParts } from '@zumibot/shared/btw'
import { isArchived } from '@zumibot/shared/archive'
import type { SearchHit } from '@zumibot/shared/search'
import type { Routine, RoutinesSnapshot } from '@zumibot/shared/routines'
import { groupKey, type SidebarSection } from '@zumibot/shared/sidebarLayout'
import type { DesktopTarget } from '@zumibot/shared/desktop'
import type { IslandLayout } from '@zumibot/shared/island'
import {
  isAccent,
  isGroup,
  type Accent,
  type AgentSummary,
  type ChatMeta,
  type ClaudeAccount,
  type ConnectionStatus,
  type StageResult,
  type ThemePref
} from '@zumibot/shared/types'
import { chatEngine, engineOfAgent, type CodexInfo } from '@zumibot/shared/engine'
import { modelFits } from '@zumibot/shared/chatModel'
import { DEFAULT_EFFORT, engineChatEffort, engineChatMode } from '@zumibot/shared/chatRun'
import { api } from './api'
import { AgentBrowserContext, useAgentBrowser } from './useAgentBrowser'
import { AgentDesktopContext, DesktopShowContext, useAgentDesktop } from './useAgentDesktop'
import { BrowserPanel } from './components/BrowserPanel'
import { DesktopPanel } from './components/DesktopPanel'
import type { AskEnv } from './components/AskCard'
import { FilesPanel } from './components/FilesPanel'
import { GitChangesPanel } from './components/GitChangesPanel'
import { useChatFiles } from './useChatFiles'
import { useSideQuestions } from './useSideQuestions'
import { useTodos } from './useTodos'
import { useBoard } from './useBoard'
import { TodosPanel } from './components/TodosPanel'
import { useDispatch } from './useDispatch'
import { DispatchPanel } from './components/DispatchPanel'
import { ProcessesPanel } from './components/ProcessesPanel'
import { useProcessCounts, useProcesses } from './useProcesses'
import { processesBadge, processMark } from './state/processes'
import { DispatchLinkContext, type DispatchLink } from './components/dispatchLink'
import { RunLinkContext, type RunLink } from './components/runLink'
import { cliMissing } from './state/agentEngine'
import { dispatchBadge, linkState, waitingIds } from './state/dispatchPanel'
import { TodoBoard } from './components/TodoBoard'
import { TodoCardEnvContext, type TodoCardEnv } from './components/TodoCard'
import { NO_FILTER, boardBadge, type BoardFilter } from './state/todoBoard'
import type { TodoView } from './state/todoGrid'
import { InboxPage } from './components/InboxPage'
import { InboxMessages } from './components/InboxMessages'
import { InboxWaiting } from './components/InboxWaiting'
import { useInboxMessages, useMarkInboxSeen } from './net/useInboxMessages'
import { useWorkflowApprovals } from './net/useWorkflowApprovals'
import { useInboxHolds } from './useInboxHolds'
import {
  answeredLine,
  anyNewMessage,
  countText,
  filterOnOpen,
  heldSeenAt,
  loadKey,
  messageView,
  needsOlder,
  ownPending,
  waitingChats,
  waitingEntries,
  type InboxAnswer,
  type InboxFilter,
  type WaitingEntry
} from './state/inbox'
import { historyComplete, panelView } from './state/todosPanel'
import { SidePanel } from './components/SidePanel'
import { routeSend, sideThreads } from './state/sideQuestions'
import { clearNotice, setNotice, startedNotice, type SendNotice } from './state/sendNotices'
import { useNotifications } from './useNotifications'
import { useTalkShown, useVoiceStatus } from './useDictation'
import { VoiceTalkView } from './components/VoiceTalkView'
import { askableAgents } from './state/agentAsk'
import { chatToOpen, islandAgents, islandMarks, popupAgentOf, type IslandTarget } from './state/island'
import { islandOpenAsk, islandTargetOf, recentRows, sameTarget } from './state/islandView'
import { useSidebarLayout } from './useSidebarLayout'
import { AgentEditor, type EditorHandle, type SavedAgent } from './components/AgentEditor'
import { ArchivedNav } from './components/ArchivedNav'
import { BotIcon } from './components/BotIcon'
import { ChatView } from './components/ChatView'
import { ClaudeBanner } from './components/ClaudeBanner'
import { CloneRoomDialog } from './components/CloneRoomDialog'
import { ExportDialog } from './components/ExportDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { UpdateHost } from './components/UpdateHost'
import { ConnectionBar, OFFLINE_REASON } from './components/ConnectionBar'
import { AppLinkContext } from './components/Markdown'
import { islandLinkTarget } from './state/appLink'
import { IslandNewChat, IslandView, type IslandIcon, type IslandPopup } from './components/IslandView'
import { CONNECTION_GRACE_MS, connectionBarLabel } from './state/connectionBar'
import { FolderPickerHost } from './components/FolderPickerHost'
import { MemberStack } from './components/MemberStack'
import { MobileBar } from './components/MobileBar'
import { NewChatView } from './components/NewChatView'
import { RoutineEditor } from './components/RoutineEditor'
import { RoutinesSidebar } from './components/RoutinesSidebar'
import { Sidebar } from './components/Sidebar'
import { SettingsNav, SettingsPage } from './components/Settings'
import { Rail, type RailEntry } from './components/Rail'
import { TabBar } from './components/TabBar'
import { CommandPalette } from './components/CommandPalette'
import { ViewerHost } from './components/FileViewer'
import type { PaletteSources, PaletteTarget } from './state/commandPalette'
import { WorkflowsMode, WorkflowsNav, type WorkflowsRoute } from './components/WorkflowsMode'
import { useWorkflows } from './net/useWorkflows'
import { anyWaiting as anyWorkflowWaiting } from './state/workflows'
import { ProcessMark, SidePanelMenu, SidePanelToggle } from './components/SidePanelMenu'
import { loadRailMode, saveRailMode, type RailMode } from './state/railMode'
import { anyWaiting } from './state/routinesList'
import { errorMessage } from './errors'
import { NARROW_QUERY, useNarrow } from './media'
import { watchMode } from './net/modeProbe'
import { islandBridge } from './net/island'
import { onBeforeSignedOut } from './net/signedOut'
import { accentFromStorage, applyAccent, applyTheme, cacheAccent, cacheTheme, themeFromStorage } from './theme'
import { applyApprovalCount, mergeApprovalCounts, type ApprovalReply } from './state/approvals'
import { anyUnread, listedChats, unreadElsewhere } from './state/unread'
import { liveChats } from './state/archive'
import { loadDrafts, saveDrafts, sessionDrafts } from './state/draftStore'
import { createGate, isNotConnected, pendingFromItems } from './state/resync'
import {
  addStaging,
  draftFileName,
  emptyDraftFiles,
  isStaging,
  readyIds,
  removeFile,
  settle,
  type DraftFiles,
  type FileOrigin
} from './state/draftFiles'
import {
  applyPush,
  emptyChatView,
  loadedPage,
  newChatView,
  prependPage,
  renameViewAuthors,
  skipPush,
  type ChatViewState
} from './state/chatView'
import { loadFailed, loadStarted, onItemsPush, onLoaded, unsynced, type ItemSync } from './state/itemSync'
import { failSend, retried, unconfirmed, unqueued, type PendingSend, type UserItem } from './state/pendingSends'
import { forgetPreview, rememberPreview } from './state/localPreviews'
import { emptyNewChatDraft, newChatTarget, newGroupTarget, renameDraftAgent, type NewChatDraft } from './state/newChat'
import { failureMessage, quietRejection, rejectedSendState, shouldRestoreDraft } from './state/sendFailure'
import { applyAgentRenames, chatTitle, reusableChat, type NewChatFolder } from './state/sidebarTree'
import { isScratchRoot } from '@zumibot/shared/scratch'
import { friendlyText } from './state/agentNames'
import { itemKeys, placeAfter } from './state/sidebarLayout'
import { canSummarizeView } from './state/cloneRoom'
import { CONTINUE_TEXT, findAgent, memberAgents, workingMembers } from './state/groupChat'
import { barTitle, pendingElsewhere } from './state/mobileBar'
import { settingsLabel, shownSection, visibleSections } from './state/settings'
import { sendsAsTask } from './state/tasks'
import { explainText } from './state/reply'
import { explainFileText, filesCount, withFileQuote } from './state/filesPanel'
import {
  browserMoved,
  closeSide,
  isChatView,
  isOpenBrowser,
  isOpenDesktop,
  liveMoved,
  panelLive,
  pendingHandoff,
  shownSide,
  sideFocusAfter,
  toggleChanges,
  toggleSide,
  type LiveView,
  type SideFocus,
  type SideState
} from './state/sidePanel'
import { useGitStatus } from './useGitStatus'
import { desktopApprovalPending } from './state/desktopView'
import {
  VOICE,
  archivedFromPath,
  archivedPath,
  chatIdFromPath,
  historyStep,
  inboxFromPath,
  inboxPath,
  pathFor,
  routinesFromPath,
  routinesPath,
  settingsFromPath,
  settingsPath,
  todosFromPath,
  todosPath,
  voiceFromPath,
  workflowsFromPath,
  workflowsPath,
  type SettingsSection
} from './state/route'

// Unsent text saved at an expiry sign-out, read once at load ('new' = the new-chat screen's text).
const restoredDrafts = loadDrafts(sessionDrafts())
const { new: restoredNewText = '', ...restoredChatDrafts } = restoredDrafts
// The chat or Settings section the page was loaded at (a reload, or a saved link).
const loadedAtChat = chatIdFromPath(location.pathname)
const loadedAtSettings = settingsFromPath(location.pathname)
const loadedAtArchived = archivedFromPath(location.pathname)
const loadedAtTodos = todosFromPath(location.pathname)
const loadedAtInbox = inboxFromPath(location.pathname)
const loadedAtRoutines = routinesFromPath(location.pathname)
const loadedAtWorkflows = workflowsFromPath(location.pathname)
const loadedAtVoice = voiceFromPath(location.pathname, location.search)

export type View =
  | { kind: 'empty' }
  // The new-chat screen opened from an agent row: its agent picked and introduced, its folder not.
  | { kind: 'start' }
  | { kind: 'chat'; chatId: string }
  | { kind: 'editor'; filePath: string | null; focusMemory?: boolean }

// What the Routines mode shows in the main area: a saved routine, or a new one (id null).
export type RoutineView = { id: string | null } | null

// A live view the Inbox opens in the chat it moves to: an approval card's desktop, or a handoff's desktop or browser.
type LiveAsk =
  | { kind: 'desktop'; chatId: string; agent: string; point: { x: number; y: number } | null }
  | { kind: 'handoff'; chatId: string; surface: 'desktop' | 'browser'; target: { agent: string; chatId: string; requestId: string } }

// Settings take the whole window over whatever was open; usageChat filters the Usage section to one chat.
type SettingsView = { section: SettingsSection; usageChat: string | null } | null

const noRoutines: RoutinesSnapshot = { routines: [], runs: {} }
const MINUTE_MS = 60_000
const ACCOUNT_REFRESH_MS = 1000
const NO_SECTIONS: readonly SidebarSection[] = [] // while the sidebar layout loads

// Test-only: main passes ZUMIBOT_TEST_OPEN=editor:<file> as ?testOpen=<file>.
const testOpenFile = (): string | null => new URLSearchParams(location.search).get('testOpen')

function upsertChat(list: ChatMeta[], meta: ChatMeta): ChatMeta[] {
  return list.some((c) => c.id === meta.id) ? list.map((c) => (c.id === meta.id ? meta : c)) : [...list, meta]
}

// Opening a chat or an editor leaves the new-chat screen's group mode; its text and picks stay.
const leaveGroupMode = (d: NewChatDraft): NewChatDraft => (d.mode === 'single' ? d : { ...d, mode: 'single' })

// Only a desktop shell new enough to have the island offers its Settings section.
const hasIsland = api.desktop?.island !== undefined

export default function App() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [view, setView] = useState<View>({ kind: 'empty' })
  const [chatViews, setChatViews] = useState<Record<string, ChatViewState>>({})
  // undefined until the first status check resolves; null means the claude binary was not found
  const [claudePath, setClaudePath] = useState<string | null | undefined>(undefined)
  // What Codex reports here: a Codex chat's composer waits on codex, not claude. Undefined until it answers (counted as found).
  const [codexInfo, setCodexInfo] = useState<CodexInfo | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  // Per chat, so they survive switching chats mid-turn and a late send rejection still has somewhere to land.
  const [drafts, setDrafts] = useState<Record<string, string>>(restoredChatDrafts)
  // Files waiting to go with each chat's next message, keyed by chat id ('new' for the new-chat screen).
  const [draftFiles, setDraftFiles] = useState<Record<string, DraftFiles>>({})
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({})
  // The info line beside the send error: a workflow a chat's `/run-workflow` started. The chat's next send clears it.
  const [sendNotices, setSendNotices] = useState<Record<string, SendNotice>>({})
  // Chats loading an older page of their history (the user scrolled up to it).
  const [loadingOlder, setLoadingOlder] = useState<Record<string, boolean>>({})
  // Messages sent but not yet in their chat's items (drawn as sent at once), and ones that never got there.
  const [pendingSends, setPendingSends] = useState<Record<string, PendingSend[]>>({})
  // The agent message each chat's next message replies to, by message id.
  const [replies, setReplies] = useState<Record<string, string>>({})
  // Whether each chat shows its tool runs open: one toggle for every run in the chat.
  const [toolsOpen, setToolsOpen] = useState<Record<string, boolean>>({})
  // The no-chat-open screen's text and picks; kept while other views are open, cleared once sent.
  const [newDraft, setNewDraft] = useState<NewChatDraft>({ ...emptyNewChatDraft, text: restoredNewText })
  // Pending approval requests per chat, from main's `approvals` pushes.
  const [approvals, setApprovals] = useState<Record<string, number>>({})
  const [theme, setTheme] = useState<ThemePref | null>(null)
  // The chosen theme shows on the page, is kept for the next load's first paint, and reaches the desktop shell's window.
  useEffect(() => {
    if (theme === null) return
    applyTheme(theme)
    cacheTheme(theme)
    api.desktop?.setTheme(theme)
  }, [theme])
  const [accent, setAccent] = useState<Accent | null>(null)
  useEffect(() => {
    if (accent === null) return
    applyAccent(accent)
    cacheAccent(accent)
  }, [accent])
  // The island window shares the main window's origin: its page loads the theme once, so a change made in the main
  // window's Settings reaches it through the cached key's storage event. The color theme travels the same way.
  useEffect(() => {
    if (!islandBridge) return
    const onStorage = (e: StorageEvent): void => {
      const next = themeFromStorage(e.key, e.newValue)
      if (next) setTheme(next)
      const nextAccent = accentFromStorage(e.key, e.newValue)
      if (nextAccent) setAccent(nextAccent)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const [account, setAccount] = useState<ClaudeAccount | null>(null)
  // Bumped per navigation into an editor so it starts fresh; a rename keeps the key and so keeps the user's state.
  const [editorKey, setEditorKey] = useState(0)
  // Reconnecting disables send; the first connect is a plain load, later ones a resync.
  const [connection, setConnection] = useState<ConnectionStatus>('reconnecting')
  const [everConnected, setEverConnected] = useState(false)
  const [graceElapsed, setGraceElapsed] = useState(false)
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null)
  // The room the Clone room dialog copies, as it was when the dialog opened: a source deleted meanwhile fails on the
  // server, and the dialog shows why.
  const [cloneSource, setCloneSource] = useState<ChatMeta | null>(null)
  // The Export dialog: a chat, and the agent message whose reply it offers (null = the whole chat only).
  const [exportTarget, setExportTarget] = useState<{ chat: ChatMeta; item: string | null } | null>(null)
  // On a small screen the sidebar is a drawer over the main area; this is whether it is out.
  const [navOpen, setNavOpen] = useState(false)
  const navToggle = useRef<HTMLButtonElement>(null)
  const [mode, setMode] = useState<RailMode>(() =>
    loadedAtChat !== null ? 'agents' : loadedAtRoutines !== null ? 'routines' : loadedAtWorkflows !== null ? 'workflows' : loadRailMode()
  )
  // A chat named by the URL, opened once the chat and agent lists are in; the main area stays blank until then.
  const [routeChat, setRouteChat] = useState<string | null>(loadedAtChat ?? loadedAtArchived?.chatId ?? null)
  const [chatsLoaded, setChatsLoaded] = useState(false)
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [routines, setRoutines] = useState<RoutinesSnapshot>(noRoutines)
  const [routinesLoaded, setRoutinesLoaded] = useState(false)
  const workflows = useWorkflows(connection === 'connected' && islandBridge === null)
  // A routine named by the URL is checked once the list is in (see routineMissing).
  const [routineView, setRoutineView] = useState<RoutineView>(loadedAtRoutines?.routine ?? null)
  const [newRoutineKey, setNewRoutineKey] = useState(0)
  // What the Workflows mode shows: the list, a workflow, or one of its runs; it is also the address.
  const [workflowsRoute, setWorkflowsRoute] = useState<WorkflowsRoute>(loadedAtWorkflows ?? { workflowId: null, runId: null })
  // Closed explicitly by each way out, not by a change of view: a view can change underneath (an agent deleted
  // elsewhere) while Settings stay open.
  const [settings, setSettings] = useState<SettingsView>(loadedAtSettings === null ? null : { section: loadedAtSettings, usageChat: null })
  // The Archived list in the sidebar's place, the way Settings' list takes it; the main area shows the chat opened from it.
  const [archive, setArchive] = useState(loadedAtArchived !== null)
  // The task board, over the main area with no column beside it (as the Inbox); `taskId` is the card open in its drawer.
  const [todosPage, setTodosPage] = useState<{ taskId: string | null } | null>(loadedAtTodos)
  // Kanban each time the app starts; a switch to Grid lasts while the To-dos page is left and opened again.
  const [todosView, setTodosView] = useState<TodoView>('kanban')
  const [todosFilter, setTodosFilter] = useState<BoardFilter>(NO_FILTER)
  // The Inbox page: no column beside it; `messageId` is a message the address named, lit once and then dropped.
  const [inboxPage, setInboxPage] = useState<{ messageId: string | null } | null>(loadedAtInbox)
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('all')
  // The voice conversation page, over the whole app (which stays mounted under it, so an open editor keeps its edits); `start`: the address asked it to begin.
  const [voicePage, setVoicePage] = useState<{ start: boolean } | null>(loadedAtVoice)
  const talkShown = useTalkShown()
  const voiceStatus = useVoiceStatus()
  // Sign-out lives on a server that holds a login; unknown until the server answers, so Account stays hidden till then.
  const [vps, setVps] = useState(false)
  useEffect(() => watchMode(api.connection.onStatus, api.session.mode, (m) => setVps(m === 'vps')), [])
  // The right side panel (its list, Files, side questions, the browser or the desktop): one for every chat, so a chat view follows
  // the open chat. A Show in chat asks the list to scroll to an item; `n` makes a repeat of the same item a new request.
  // `composerFocus` is bumped when a file quote went into a draft.
  const [side, setSide] = useState<SideState>(null)
  // Set where the shown chat and the live views are known, below: Esc needs both and is wired before them.
  const listShown = useRef(false) // a chat view (the list, Files, side questions) is on screen, not just chosen
  const liveBehind = useRef<LiveView | null>(null) // a browser or desktop open in the panel waits behind a chat view
  const [sideFocus, setSideFocus] = useState<SideFocus | null>(null)
  // A reply chip asks the To-dos view to scroll to that reply's group (keyed by the reply's item id).
  const [todosFocus, setTodosFocus] = useState<{ chatId: string; itemId: string; n: number } | null>(null)
  const [dispatchFocus, setDispatchFocus] = useState<{ chatId: string; id: string; n: number } | null>(null)
  const [processFocus, setProcessFocus] = useState<{ chatId: string; id: string; n: number } | null>(null)
  const askingSides = useRef(new Set<string>())
  const startingRuns = useRef(new Set<string>()) // chats with a /run-workflow on its way
  // query: a search hit's, whose words the message lights (a search jump opens no tool runs).
  const [showRequest, setShowRequest] = useState<{ chatId: string; itemId: string; n: number; query?: string } | null>(null)
  // A search hit waiting for its chat's view to mount: a request already there when the list mounts reads as handled.
  // No query: the Audit log's Show in chat, which opens the tool runs the call sits in.
  const [jump, setJump] = useState<{ chatId: string; itemId: string; query?: string } | null>(null)
  // The Ctrl+K palette.
  const [palette, setPalette] = useState(false)
  const [composerFocus, setComposerFocus] = useState(0)
  // The island page (islandBridge set; the shell's island window): the agents the user picked, the agent whose popup is open
  // (null = closed), where each popup last stood, the shell's rects for the strip and popup, and where a new chat would run.
  const [islandPicks, setIslandPicks] = useState<string[] | null>(null)
  const [islandAgent, setIslandAgent] = useState<string | null>(null)
  // The agent a voice request just went to: its chat shows in the island popup though it isn't on the strip.
  const [islandVoiceAgent, setIslandVoiceAgent] = useState<string | null>(null)
  const [islandLast, setIslandLast] = useState<Record<string, IslandTarget>>({})
  const [islandLayout, setIslandLayout] = useState<IslandLayout | null>(null)
  // A voice conversation the desk shortcut started in the island popup; the shell asked for it and waits for voiceEnded.
  const [islandVoice, setIslandVoice] = useState(false)
  const [islandFolder, setIslandFolder] = useState<{ agent: string; cwd: string } | null>(null)
  // The sidebar's "next in" text; once a minute is fine-grained enough.
  const [now, setNow] = useState(() => Date.now())

  // Latest values for async callbacks (a send can settle minutes after the render that started it).
  const latest = useRef({ chats, chatViews, drafts, view, newDraft, pendingSends, settings, todosPage, inboxPage, mode, agents, workflows })
  latest.current = { chats, chatViews, drafts, view, newDraft, pendingSends, settings, todosPage, inboxPage, mode, agents, workflows }

  // Synchronous mirror of draftFiles, so two quick drops count against the limit together.
  const filesRef = useRef<Record<string, DraftFiles>>({})

  const loadedChats = useRef(new Set<string>()) // chats whose items were requested this session
  const olderLoads = useRef(new Set<string>()) // chats with an older page on its way
  const olderTried = useRef(new Map<string, { count: number; pages: number }>()) // the Inbox's older pages per chat, per count
  const itemSyncs = useRef(new Map<string, ItemSync>()) // which pushed list each chat's items are
  const syncOf = (chatId: string): ItemSync => itemSyncs.current.get(chatId) ?? unsynced
  const agentsRequest = useRef(0)
  const gates = useRef({ chatList: createGate(), items: createGate(), approvals: createGate() })
  // The chats an approvals push named since the last `chats:pending` request: their pushed counts are newer than its answer.
  const approvalPushes = useRef(new Set<string>())
  const themeRequest = useRef(0)
  const accentRequest = useRef(0)
  const creating = useRef(false)
  const initialLoaded = useRef(false)
  const editorHandle = useRef<EditorHandle | null>(null)
  const navigating = useRef(false)
  const newWorkflowSeq = useRef(0) // see newWorkflowGuarded
  const pendingTestOpen = useRef(testOpenFile())

  const report = useCallback((e: unknown) => setError(errorMessage(e)), [])
  // Loads that resync reruns: failing only because the socket is down again is not an error to show.
  const quiet = useCallback((e: unknown) => (isNotConnected(e) ? undefined : report(e)), [report])
  const sidebarLayout = useSidebarLayout(quiet)
  // Read when a clone lands, which can be minutes after its dialog opened: the agents and layout may have changed.
  const placing = useRef({ agents, layout: sidebarLayout.layout })
  placing.current = { agents, layout: sidebarLayout.layout }
  const loadAccount = useCallback(() => {
    if (islandBridge) return // the ring is the rail's, and the island has no rail
    api.app.account().then(setAccount, quiet)
  }, [quiet])

  const changeTheme = useCallback(
    (t: ThemePref) => {
      const request = ++themeRequest.current
      api.app.setTheme(t).then((applied) => {
        if (request === themeRequest.current) setTheme(applied)
      }, report)
    },
    [report]
  )

  const changeAccent = useCallback(
    (a: Accent) => {
      const request = ++accentRequest.current
      api.app.setAccent(a).then((applied) => {
        if (request === accentRequest.current) setAccent(applied)
      }, report)
    },
    [report]
  )

  const refreshAgents = useCallback(() => {
    const request = ++agentsRequest.current
    api.agents.list().then((list) => {
      if (request !== agentsRequest.current) return
      setAgents(list)
      setAgentsLoaded(true)
    }, quiet)
  }, [quiet])

  useEffect(() => {
    return api.agents.onChanged((renamed) => {
      refreshAgents()
      if (renamed.length > 0) {
        // The island's picks are the shell's: it carries a pick over to the new name.
        for (const r of renamed) api.desktop?.island?.renameAgent(r.from, r.to)
        setChats((prev) => applyAgentRenames(prev, renamed))
        // A loaded group chat is not reloaded, so its messages follow the new name here.
        setChatViews((prev) => renameViewAuthors(prev, renamed))
        setNewDraft((prev) => renameDraftAgent(prev, renamed))
      }
    })
  }, [refreshAgents])

  // The built-in agent is protected: it has no editor.
  const isBuiltInFile = useCallback((filePath: string | null) => agents.some((a) => a.builtIn && a.filePath === filePath), [agents])

  const openEditor = useCallback(
    (filePath: string | null, focusMemory = false) => {
      if (isBuiltInFile(filePath)) return
      // A memory line's View in the To-dos page's box: the editor is an Agents view, so it leaves the page for that mode.
      if (latest.current.todosPage !== null || latest.current.inboxPage !== null) {
        setTodosPage(null)
        setInboxPage(null)
        setMode('agents')
        saveRailMode('agents')
      }
      setEditorKey((k) => k + 1)
      setView(focusMemory ? { kind: 'editor', filePath, focusMemory } : { kind: 'editor', filePath })
      setNewDraft(leaveGroupMode)
    },
    [isBuiltInFile]
  )

  useEffect(() => {
    const file = pendingTestOpen.current
    const agent = file && agents.find((a) => a.filePath.endsWith(`/${file}`))
    if (!agent) return
    pendingTestOpen.current = null
    if (agent.builtIn) return
    openEditor(agent.filePath)
  }, [agents, openEditor])

  const loadItems = useCallback(
    (chatId: string) => {
      const request = gates.current.items.next(chatId)
      itemSyncs.current.set(chatId, loadStarted(syncOf(chatId)))
      api.chats.items(chatId).then(
        (page) => {
          // A newer load is out.
          if (!gates.current.items.isCurrent(request, chatId)) return
          const { next, take, reload } = onLoaded(syncOf(chatId), page.seq, page.start)
          itemSyncs.current.set(chatId, next)
          if (take) setChatViews((prev) => ({ ...prev, [chatId]: loadedPage(prev[chatId] ?? emptyChatView, page) }))
          if (reload) loadItems(chatId)
        },
        (e: unknown) => {
          if (gates.current.items.isCurrent(request, chatId)) itemSyncs.current.set(chatId, loadFailed(syncOf(chatId)))
          loadedChats.current.delete(chatId)
          quiet(e)
        }
      )
    },
    [quiet]
  )

  // The page before the oldest loaded item; one at a time per chat. `until`: an item to reach back to in the same
  // request (a jump to an old message), so a long history is not walked a page at a time.
  const loadOlder = useCallback(
    (chatId: string, until?: string) => {
      const view = latest.current.chatViews[chatId]
      const first = view?.items[0]
      if (!first || !view.start || olderLoads.current.has(chatId)) return
      olderLoads.current.add(chatId)
      setLoadingOlder((prev) => ({ ...prev, [chatId]: true }))
      api.chats
        .items(chatId, first.id, until)
        .then(
          (page) => setChatViews((prev) => (prev[chatId] ? { ...prev, [chatId]: prependPage(prev[chatId], page, first.id) } : prev)),
          quiet
        )
        .finally(() => {
          olderLoads.current.delete(chatId)
          setLoadingOlder(({ [chatId]: _done, ...rest }) => rest)
        })
    },
    [quiet]
  )

  useEffect(
    () =>
      api.chats.onPush((p) => {
        if (p.kind === 'meta') {
          setChats((prev) => upsertChat(prev, p.meta))
          return
        }
        if (p.kind === 'approvals') {
          approvalPushes.current.add(p.chatId)
          setApprovals((prev) => applyApprovalCount(prev, p))
          return
        }
        if (p.kind === 'items') {
          const { next, take, reload } = onItemsPush(syncOf(p.chatId), p, loadedChats.current.has(p.chatId))
          itemSyncs.current.set(p.chatId, next)
          setChatViews((prev) => ({ ...prev, [p.chatId]: (take ? applyPush : skipPush)(prev[p.chatId] ?? emptyChatView, p) }))
          if (reload) loadItems(p.chatId)
          return
        }
        setChatViews((prev) => ({ ...prev, [p.chatId]: applyPush(prev[p.chatId] ?? emptyChatView, p) }))
      }),
    [loadItems]
  )

  // A chat's items load once, and its pushes keep them current from then on.
  const ensureItems = useCallback(
    (chatId: string) => {
      if (loadedChats.current.has(chatId)) return
      loadedChats.current.add(chatId)
      // A whole list pushed since is the chat's latest.
      if (syncOf(chatId).held !== null) return
      loadItems(chatId)
    },
    [loadItems]
  )

  const openChat = useCallback(
    (chatId: string) => {
      // A chat shows in Agents mode: leaving the To-dos page for one (a fork or an ask card in its box) switches to it.
      if (latest.current.todosPage !== null || latest.current.inboxPage !== null) {
        setMode('agents')
        saveRailMode('agents')
      }
      setView({ kind: 'chat', chatId })
      setTodosPage(null) // every way to a chat leaves the To-dos page and the Inbox
      setInboxPage(null)
      setNewDraft(leaveGroupMode)
      ensureItems(chatId)
    },
    [ensureItems]
  )

  // What the ask cards need. The chat they ask is not the open one, so its items are loaded on request (an ask card
  // with cards waiting on the user) and then kept current by its pushes, as for any chat opened once. Answering and
  // opening reach the app's own functions through the ref, which the render below keeps current.
  const askActions = useRef<{ answer: AskEnv['answer']; open: AskEnv['open']; openSide: AskEnv['openSide'] } | null>(null)
  const loadAsked = useCallback(
    (chatId: string) => {
      loadedChats.current.add(chatId)
      if (syncOf(chatId).held !== null) return
      loadItems(chatId)
    },
    [loadItems]
  )
  const askEnv = useMemo<AskEnv>(
    () => ({
      chats,
      pendingByChat: approvals,
      itemsOf: (chatId) => chatViews[chatId]?.items,
      load: loadAsked,
      answer: (chatId, requestId, reply, agent) => askActions.current?.answer(chatId, requestId, reply, agent),
      open: (chatId) => askActions.current?.open(chatId),
      openSide: (chatId, entryId) => askActions.current?.openSide(chatId, entryId)
    }),
    [chats, approvals, chatViews, loadAsked]
  )

  // A layout effect, so Back to a chat never paints the blank in between; a chat that no longer exists leaves the
  // new-chat screen, and the address follows it there.
  useLayoutEffect(() => {
    if (routeChat === null || !chatsLoaded || !agentsLoaded) return
    setRouteChat(null)
    setSettings(null)
    setTodosPage(null)
    setInboxPage(null)
    if (!latest.current.chats.some((c) => c.id === routeChat)) {
      setView({ kind: 'empty' })
      return
    }
    setMode('agents')
    saveRailMode('agents')
    openChat(routeChat)
  }, [routeChat, chatsLoaded, agentsLoaded, openChat])

  // Pending approval counts live only in the server's memory and only for running turns, and are pushed only when they
  // change, so a page load or a reconnect asks the server for them (the Inbox and the badges would otherwise miss a card
  // that was already waiting). Not from each chat's items: a card above its newest page (a room member waits while the
  // others work on) would be missed. A reconnect clears the old counts first; pushes since the request are kept.
  const resyncApprovals = useCallback(
    (clear: boolean) => {
      const request = gates.current.approvals.next()
      approvalPushes.current = new Set()
      if (clear) setApprovals({})
      api.chats.pending().then((counts) => {
        if (!gates.current.approvals.isCurrent(request)) return
        const pushed = approvalPushes.current
        setApprovals((prev) => mergeApprovalCounts(prev, counts, pushed))
      }, quiet)
    },
    [quiet]
  )

  // The first connect loads everything; a reconnect reloads what may have changed while the socket was down.
  const resync = useCallback(
    (first: boolean) => {
      refreshAgents()
      loadAccount()
      api.routines.list().then((snapshot) => {
        setRoutines(snapshot)
        setRoutinesLoaded(true)
      }, quiet)
      const listRequest = gates.current.chatList.next()
      api.chats.list().then((list) => {
        if (!gates.current.chatList.isCurrent(listRequest)) return
        // A meta push that landed before the list resolved is newer than the list's copy of that chat.
        setChats((prev) => (first ? [...list.filter((c) => !prev.some((p) => p.id === c.id)), ...prev] : list))
        setChatsLoaded(true)
      }, quiet)
      resyncApprovals(!first)
      if (first) {
        api.app.claudeStatus().then((s) => setClaudePath(s.path), quiet)
        api.app.getTheme().then(setTheme, quiet)
        api.app.getAccent().then((a) => setAccent(isAccent(a) ? a : 'blue'), quiet)
        return
      }
      // Pushes sent while down were lost: every loaded chat is stale, the open one reloads now.
      const open = latest.current.view.kind === 'chat' ? latest.current.view.chatId : null
      loadedChats.current.clear()
      olderTried.current.clear()
      itemSyncs.current.clear()
      setChatViews((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([id, v]) => [id, { ...v, streaming: '', streamingBy: {}, thought: '', thoughtBy: {} }])
        )
      )
      if (open) {
        loadedChats.current.add(open)
        loadItems(open)
      }
    },
    [refreshAgents, loadAccount, loadItems, quiet, resyncApprovals]
  )

  // A socket that never opens (proxy drops the WS upgrade) must not look like an empty, working app.
  useEffect(() => {
    const t = setTimeout(() => setGraceElapsed(true), CONNECTION_GRACE_MS)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    onBeforeSignedOut(() => saveDrafts(sessionDrafts(), { ...latest.current.drafts, new: latest.current.newDraft.text }))
    return api.connection.onStatus((s) => {
      setConnection(s)
      if (s !== 'connected') return
      setEverConnected(true)
      // The server's zone is not the user's: tell it each connect (a trip changes it), and let a refusal pass.
      api.app.setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => undefined)
      resync(!initialLoaded.current)
      initialLoaded.current = true
    })
  }, [resync])

  // Asked only while some agent runs on Codex (the listing may start codex itself), and again on each connect, so a codex
  // installed meanwhile counts after a reconnect.
  const codexInUse = agents.some((a) => a.provider === 'codex')
  useEffect(() => {
    if (!codexInUse || connection !== 'connected') return
    let live = true
    api.codexInfo().then(
      (info) => {
        if (live) setCodexInfo(info)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [codexInUse, connection])

  useEffect(() => api.routines.onChanged(setRoutines), [])
  // A /routines or /workflows address opens that mode; it is remembered like a switch there, so the root opens it next time too.
  useEffect(() => {
    if (loadedAtRoutines !== null) saveRailMode('routines')
    else if (loadedAtWorkflows !== null) saveRailMode('workflows')
  }, [])

  // The ring shows the session percent, which every reply updates: read the account again after usage changes (trailing,
  // since a turn can record several times).
  useEffect(() => {
    if (islandBridge) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.usage.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(loadAccount, ACCOUNT_REFRESH_MS)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [loadAccount])

  // Only the Routines sidebar shows the time; refresh it on entering and then every minute.
  useEffect(() => {
    if (mode !== 'routines') return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(t)
  }, [mode])

  // Dismissing the drawer hands focus back to its toggle.
  const closeNav = useCallback(() => {
    setNavOpen(false)
    navToggle.current?.focus()
  }, [])

  // Esc closes the side panel's chat view (the list, Files, side questions) unless a field, menu or dialog takes the key.
  // Heard before the others (capture), so an open menu or selection menu is still in the page and gets the key first.
  // The browser keeps Esc for leaving its surface, and a desktop in control sends it to the desktop.
  useEffect(() => {
    if (!isChatView(side)) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || !listShown.current) return
      if (e.target instanceof Element) {
        // The panel's own pickers (the step picker, the list's browser agent) are not fields that need the key.
        const ownSelect = e.target.matches('.search-select') && e.target.closest('.files-panel, .side-menu') !== null
        if (
          !ownSelect &&
          e.target.closest(
            '.menu, [role="menu"], input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]'
          )
        )
          return
      }
      // An open menu (a to-do's status menu included) takes Esc first.
      if (document.querySelector('.menu, [role="menu"], .modal-backdrop, [role="dialog"]')) return
      setSide((s) => closeSide(s, liveBehind.current))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [side])

  // Esc closes the drawer unless a field, menu or dialog takes the key, or a popup in the drawer is open (Esc closes
  // that first); widening the window puts the sidebar back in place.
  useEffect(() => {
    if (!navOpen) return
    const narrow = window.matchMedia(NARROW_QUERY)
    const onWiden = (): void => {
      if (!narrow.matches) setNavOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.target instanceof Element && e.target.closest('.menu, input, textarea, [role="dialog"]')) return
      if (document.querySelector('#sidebar .menu, .rail .usage-pop')) return
      closeNav()
    }
    narrow.addEventListener('change', onWiden)
    window.addEventListener('keydown', onKey)
    return () => {
      narrow.removeEventListener('change', onWiden)
      window.removeEventListener('keydown', onKey)
    }
  }, [navOpen, closeNav])

  // Picking something in the drawer shows it and closes the drawer.
  const fromNav =
    <A extends unknown[]>(go: (...args: A) => void) =>
    (...args: A): void => {
      setNavOpen(false)
      go(...args)
    }

  // Every move away from the editor goes through here so unsaved edits are never dropped silently.
  const navigate = (go: () => void): void => {
    if (navigating.current) return
    if (editorHandle.current?.isDirty()) setPendingNav(() => go)
    else go()
  }

  // On a small screen Settings opened from the account open on their section list, which is their drawer.
  const openSettings = (section: SettingsSection, usageChat: string | null = null, list = false): void => {
    navigate(() => {
      setSettings({ section, usageChat })
      setNavOpen(list && window.matchMedia(NARROW_QUERY).matches)
    })
  }

  // The view under Settings is still there, so leaving them returns to it.
  const closeSettings = (): void => {
    setSettings(null)
    setNavOpen(false)
  }

  // The main area starts empty, so a live chat never shows beside the archived list. On a small screen it opens on
  // the list, which is its drawer.
  const openArchived = (): void => {
    navigate(() => {
      setSettings(null)
      setTodosPage(null)
      setInboxPage(null)
      setArchive(true)
      setView({ kind: 'empty' })
      setNavOpen(window.matchMedia(NARROW_QUERY).matches)
    })
  }

  // Like the Inbox: the board has no column, so a phone's drawer holds only the rail and closes on the pick. Opened again
  // from Settings (or the page itself), it keeps the card it showed.
  const openTodos = (): void => {
    navigate(() => {
      setSettings(null)
      setArchive(false)
      setInboxPage(null)
      setTodosPage((t) => t ?? { taskId: null })
      setView({ kind: 'empty' })
      setNavOpen(false)
    })
  }

  // The Inbox has no column, so a phone's drawer holds only the rail and closes on the pick. Opened again from Settings
  // (or the page itself), it stays as it was.
  const openInbox = (): void => {
    navigate(() => {
      setSettings(null)
      setArchive(false)
      setTodosPage(null)
      setInboxFilter((f) => filterOnOpen(f, latest.current.inboxPage !== null, null))
      setInboxPage((i) => i ?? { messageId: null })
      setView({ kind: 'empty' })
      setNavOpen(false)
    })
  }

  // The rail's logo: the root (Agents' new-chat screen) from any view, through the same guard.
  const openHome = (): void => {
    navigate(() => {
      toMode('agents')
      setView({ kind: 'empty' })
      setNavOpen(false)
    })
  }

  // A shell notification click on a Notify message: the Inbox with that message lit, through the same guard.
  const openInboxMessage = useCallback((messageId: string | null) => {
    setNavOpen(false)
    navigate(() => {
      setSettings(null)
      setArchive(false)
      setTodosPage(null)
      // The named message must be on screen to be lit, so the chip goes back to All.
      setInboxFilter((f) => filterOnOpen(f, latest.current.inboxPage !== null, messageId))
      setInboxPage({ messageId })
      setView({ kind: 'empty' })
    })
  }, []) // navigate reads only refs and setters

  // A chat opened from the list stays open, with its archived note, once the sidebar is back.
  const closeArchived = (): void => {
    setArchive(false)
    setNavOpen(false)
  }

  // Ctrl+K (Cmd+K on a Mac) opens the palette from anywhere, or closes it. Another dialog (unsaved changes, a confirm,
  // Clone room) keeps the keyboard; inside the palette its own box takes the key first.
  useEffect(() => {
    if (islandBridge) return // the island draws no palette, so the key stays the composer's
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'k' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.defaultPrevented) return
      if (document.querySelector('.modal-backdrop:not(.palette-backdrop)')) return
      e.preventDefault()
      if (!e.repeat) setPalette((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ctrl+, opens Settings. Esc leaves them unless a field, menu or dialog takes the key, or the drawer is out (Esc
  // closes that first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === ',' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        if (settings === null) openSettings('general', null, true)
        return
      }
      if (e.key !== 'Escape' || settings === null || navOpen) return
      if (e.target instanceof Element && e.target.closest('.menu, input:not([type="checkbox"]), textarea, select, [role="dialog"]')) return
      // The Usage popup sits on the rail, beside Settings: its Esc closes only the popup (useDismiss).
      if (document.querySelector('.rail .usage-pop')) return
      navigate(closeSettings) // the Vault section's open form may hold unsaved edits
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings, navOpen]) // openSettings and closeSettings read only refs and setters

  // The mic in the top bar: a tap, so the page may start listening at once.
  const openVoice = useCallback(() => {
    setNavOpen(false)
    setVoicePage({ start: true })
  }, [])

  // A notification click takes the same path as a /chat/<id> address, so a chat deleted since falls back to the
  // empty view; it goes through the unsaved-changes guard like any other move.
  const openChatFromNotification = useCallback((chatId: string) => {
    setNavOpen(false)
    navigate(() => {
      setArchive(false)
      setTodosPage(null)
      setInboxPage(null)
      setRouteChat(chatId)
    })
  }, []) // navigate reads only refs and setters

  // Back and Forward walk the chats and Settings sections this tab opened, through the same unsaved-changes guard as a
  // click.
  useEffect(() => {
    if (islandBridge) return // the island is one address and never walks history
    const onPop = (): void => {
      const section = settingsFromPath(location.pathname)
      const archived = archivedFromPath(location.pathname)
      const todosAt = todosFromPath(location.pathname)
      const inboxAt = inboxFromPath(location.pathname)
      const routinesAt = routinesFromPath(location.pathname)
      const workflowsAt = workflowsFromPath(location.pathname)
      const chatId = chatIdFromPath(location.pathname)
      const voiceAt = voiceFromPath(location.pathname, location.search)
      navigate(() => {
        // The voice page lies over the view it was opened from: Back to it, or away from it, only shows or hides the page.
        setVoicePage(voiceAt)
        if (voiceAt !== null) return
        if (section !== null) setSettings((s) => ({ section, usageChat: s?.section === section ? s.usageChat : null }))
        else if (routinesAt !== null) {
          setSettings(null)
          setArchive(false)
          setTodosPage(null)
          setInboxPage(null)
          setMode('routines')
          saveRailMode('routines')
          // A fresh key, as New routine gives: after Discard the old editor would otherwise keep its edits.
          if (routinesAt.routine?.id === null) setNewRoutineKey((k) => k + 1)
          setRoutineView(routinesAt.routine)
        } else if (todosAt !== null) {
          setSettings(null)
          setArchive(false)
          setInboxPage(null)
          setTodosPage(todosAt)
          setView({ kind: 'empty' })
        } else if (inboxAt !== null) {
          setSettings(null)
          setArchive(false)
          setTodosPage(null)
          setInboxFilter((f) => filterOnOpen(f, latest.current.inboxPage !== null, inboxAt.messageId))
          setInboxPage(inboxAt)
          setView({ kind: 'empty' })
        } else if (workflowsAt !== null) {
          setSettings(null)
          setArchive(false)
          setTodosPage(null)
          setInboxPage(null)
          setMode('workflows')
          saveRailMode('workflows')
          setWorkflowsRoute(workflowsAt)
        } else if (archived !== null) {
          setSettings(null)
          setTodosPage(null)
          setInboxPage(null)
          setArchive(true)
          if (archived.chatId === null) setView({ kind: 'empty' })
          else setRouteChat(archived.chatId)
        }
        // Back out of Settings to the root returns to the view under them, as their Back button does.
        else if (chatId === null && latest.current.settings !== null) {
          setSettings(null)
          setTodosPage(null)
          setInboxPage(null)
        } else if (chatId === null) {
          setArchive(false)
          setTodosPage(null)
          setInboxPage(null)
          // Back from Routines or Workflows to the root keeps the Agents view left there (the new-chat screen or an agent's
          // editor), as the rail's Agents entry does.
          if (latest.current.mode === 'agents' || latest.current.view.kind === 'chat') setView({ kind: 'empty' })
          setMode('agents')
          saveRailMode('agents')
        } else {
          setArchive(false)
          setTodosPage(null)
          setInboxPage(null)
          setRouteChat(chatId)
        }
      })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, []) // navigate reads only refs and setters, so the first render's copy stays right

  // The address follows the open chat, Settings section, To-dos page, Archived page, routine or Workflows view. Not while a URL's chat waits for the
  // lists or a routine is not in the list, nor while the unsaved-changes dialog decides whether a Back goes through (a cancelled one
  // is corrected after it closes).
  const lastPath = useRef<string | null>(null)
  const routineMissing = routineView !== null && routineView.id !== null && !routines.routines.some((r) => r.id === routineView.id)
  const wantPath =
    routeChat !== null
      ? null
      : voicePage !== null
        ? VOICE
        : settings !== null
          ? settingsPath(settings.section)
          : inboxPage !== null
            ? inboxPath(inboxPage.messageId)
            : todosPage !== null
              ? todosPath(todosPage.taskId)
              : archive
                ? archivedPath(view.kind === 'chat' ? view.chatId : null)
                : mode === 'routines'
                  ? routineMissing
                    ? null
                    : routinesPath(routineView)
                  : mode === 'workflows'
                    ? workflowsPath(workflowsRoute.workflowId, workflowsRoute.runId, workflowsRoute.audit === true)
                    : pathFor(view.kind === 'chat' ? view.chatId : null)
  useEffect(() => {
    if (islandBridge || wantPath === null || pendingNav) return
    const step = historyStep(location.pathname, wantPath, lastPath.current)
    if (step === 'push') history.pushState(null, '', wantPath)
    else if (step === 'replace') history.replaceState(null, '', wantPath)
    lastPath.current = wantPath
  })

  // A routine the URL named that does not exist, or one deleted elsewhere while open: once the list is in, Routines shows
  // nothing open and the address is corrected in place (the path was held back meanwhile, so lastPath is not this one).
  useLayoutEffect(() => {
    if (!routinesLoaded || !routineMissing) return
    setRoutineView(null)
    lastPath.current = null
  }, [routinesLoaded, routineMissing])

  // Leaving Agents for Routines unmounts the editor, so it gets the same unsaved-changes guard as any other navigation.
  // The rail is also there under Settings, To-dos and Archived: its Agents and Routines entries leave them, the drawer stays as it is.
  const switchMode = (m: RailMode): void => {
    if (m === mode && settings === null && !archive && todosPage === null && inboxPage === null) return
    const go = (): void => {
      setSettings(null)
      setArchive(false)
      setTodosPage(null)
      setInboxPage(null)
      if (m === mode) return
      setMode(m)
      saveRailMode(m)
    }
    navigate(go) // either editor may hold unsaved edits
  }

  // A workflow or run picked in the Workflows mode is only an address change, but it unmounts an editor with unsaved edits.
  const openWorkflowGuarded = (workflowId: string | null, runId: string | null = null, audit = false): void => {
    if (
      workflowsRoute.workflowId === workflowId &&
      workflowsRoute.runId === runId &&
      (workflowsRoute.audit === true) === audit &&
      workflowsRoute.fresh === undefined
    )
      return
    navigate(() => setWorkflowsRoute({ workflowId, runId, ...(audit ? { audit: true } : {}) }))
  }
  // A fresh number per New workflow, from a counter that only grows: a number used before may still be the key of the
  // editor a saved new workflow kept, which would then come back in place of a blank one.
  const newWorkflowGuarded = (): void => {
    navigate(() => setWorkflowsRoute({ workflowId: null, runId: null, fresh: ++newWorkflowSeq.current }))
  }

  // Re-clicking the open routine must not prompt or reset it.
  const openRoutineGuarded = (id: string | null): void => {
    if (routineView && routineView.id === id && id !== null) return
    // A fresh key per New routine: after Discard the old editor would otherwise keep its edits.
    navigate(() => {
      if (id === null) setNewRoutineKey((k) => k + 1)
      setRoutineView({ id })
    })
  }

  // Opening a run's chat leaves Routines, so it goes through the same unsaved-changes guard.
  const openRunChat = (chatId: string): void => {
    navigate(() => {
      setSettings(null)
      setTodosPage(null)
      setInboxPage(null)
      setMode('agents')
      saveRailMode('agents')
      openChat(chatId)
    })
  }

  // The bar over a workflow step's chat leaves Agents for the run, through the same guard.
  const openWorkflowRun = (workflowId: string, runId: string): void => {
    navigate(() => {
      setSettings(null)
      setArchive(false)
      setTodosPage(null)
      setInboxPage(null)
      setMode('workflows')
      saveRailMode('workflows')
      setWorkflowsRoute({ workflowId, runId })
    })
  }

  // The palette and a message hit go anywhere: each way there closes the views laid over the modes, as the rail does.
  const toMode = (m: RailMode): void => {
    setSettings(null)
    setArchive(false)
    setTodosPage(null)
    setInboxPage(null)
    setMode(m)
    saveRailMode(m)
  }

  // A message search hit: its chat, scrolled to the message once its view has mounted (see the jump effect).
  const openMessage = (hit: SearchHit, query: string): void => {
    setNavOpen(false)
    navigate(() => {
      toMode('agents')
      openChat(hit.chatId)
      setJump({ chatId: hit.chatId, itemId: hit.itemId, query })
    })
  }

  // The Audit log's Show in chat: the chat, scrolled to the call's row (or its subagent's Agent row), as a search hit is.
  const openItem = (chatId: string, itemId: string | null): void => {
    setNavOpen(false)
    navigate(() => {
      toMode('agents')
      openChat(chatId)
      if (itemId !== null) setJump({ chatId, itemId })
    })
  }

  // A palette row, through the same unsaved-changes guard as the rail and the sidebar. The views that pick their own
  // drawer state (To-dos, Archived) and Settings keep doing so.
  const pickPalette = (t: PaletteTarget): void => {
    setPalette(false)
    if (t.kind === 'view' && t.view === 'todos') return openTodos()
    if (t.kind === 'view' && t.view === 'inbox') return openInbox()
    if (t.kind === 'view' && t.view === 'archived') return openArchived()
    if (t.kind === 'settings') return openSettings(t.section)
    setNavOpen(false)
    switch (t.kind) {
      case 'view':
        if (t.view === 'agents' || t.view === 'routines' || t.view === 'workflows') switchMode(t.view)
        return
      case 'chat':
        return navigate(() => {
          toMode('agents')
          openChat(t.chatId)
        })
      case 'agent':
        return navigate(() => {
          toMode('agents')
          // An agent whose file has an error cannot chat: Agent Studio shows why. Zumi Bot has no editor.
          if (t.broken && !isBuiltInFile(t.filePath)) openEditor(t.filePath)
          else void openAgentChat(t.name)
        })
      case 'routine':
        return navigate(() => {
          toMode('routines')
          setRoutineView({ id: t.id })
        })
      case 'workflow':
        return navigate(() => {
          toMode('workflows')
          setWorkflowsRoute({ workflowId: t.id, runId: null })
        })
      case 'action':
        return navigate(() => {
          if (t.action === 'new-routine' || t.action === 'new-workflow') {
            toMode(t.action === 'new-routine' ? 'routines' : 'workflows')
            // Fresh keys, as their New buttons give: a blank editor even after an earlier one was discarded.
            if (t.action === 'new-routine') {
              setNewRoutineKey((k) => k + 1)
              setRoutineView({ id: null })
            } else setWorkflowsRoute({ workflowId: null, runId: null, fresh: ++newWorkflowSeq.current })
            return
          }
          toMode('agents')
          if (t.action === 'new-agent') openEditor(null)
          else if (t.action === 'new-group') newGroup()
          else {
            setView({ kind: 'empty' })
            setNewDraft(leaveGroupMode)
          }
        })
    }
  }

  // Show the saved routine at once; the pushed snapshot may arrive a moment later.
  const routineSaved = (saved: Routine): void => {
    setRoutines((s) => ({
      ...s,
      routines: s.routines.some((r) => r.id === saved.id) ? s.routines.map((r) => (r.id === saved.id ? saved : r)) : [...s.routines, saved]
    }))
    setRoutineView({ id: saved.id })
  }

  // A copy opens on its RPC answer, which may come before the push that lists it; listed first so it never reads as missing.
  const routineDuplicated = (copy: Routine): void => {
    setRoutines((s) => (s.routines.some((r) => r.id === copy.id) ? s : { ...s, routines: [...s.routines, copy] }))
    navigate(() => setRoutineView({ id: copy.id }))
  }

  // Re-clicking the agent that is already open must not prompt or reset it.
  const openEditorGuarded = (filePath: string | null): void => {
    if (view.kind === 'editor' && view.filePath === filePath) return
    if (isBuiltInFile(filePath)) return
    navigate(() => openEditor(filePath))
  }

  // From a chat's memory line: the editor opens scrolled to Memory, even when that agent's editor is already open (it remounts).
  const openAgentMemory = (agentName: string): void => {
    const agent = agents.find((a) => a.name === agentName)
    if (!agent || agent.builtIn) return
    navigate(() => openEditor(agent.filePath, true))
  }

  const resolveNavigation = async (choice: string | null): Promise<void> => {
    const go = pendingNav
    setPendingNav(null)
    if (!go || choice === null || choice === 'cancel') return
    if (choice === 'save') {
      navigating.current = true
      try {
        if (!(await editorHandle.current?.save())) return // the editor shows why
      } finally {
        navigating.current = false
      }
    }
    go()
  }

  const editorSaved = (saved: SavedAgent): void => {
    setView((v) => (v.kind === 'editor' && v.filePath !== saved.filePath ? { kind: 'editor', filePath: saved.filePath } : v))
    refreshAgents()
    const { renamedFrom, name } = saved
    if (renamedFrom && renamedFrom !== name) {
      // Main already rewrote the stored chats; mirror it on the local copies so concurrent meta pushes survive.
      api.desktop?.island?.renameAgent(renamedFrom, name)
      setChats((prev) => applyAgentRenames(prev, [{ from: renamedFrom, to: name }]))
      setChatViews((prev) => renameViewAuthors(prev, [{ from: renamedFrom, to: name }]))
      setNewDraft((prev) => renameDraftAgent(prev, [{ from: renamedFrom, to: name }]))
    }
  }

  /** Opens a new (or reused empty) chat; resolves to its id, or null when nothing was opened. */
  const newChat = async (agentName: string, folder: NewChatFolder): Promise<string | null> => {
    if (creating.current) return null
    creating.current = true
    try {
      // No folder: the server makes the chat a scratch folder of its own (null cwd).
      const scratch = folder === 'none' || (typeof folder === 'object' && isScratchRoot(folder.cwd))
      const cwd = scratch
        ? null
        : typeof folder === 'object'
          ? folder.cwd
          : ((folder === 'last' ? await api.app.lastFolder(agentName) : null) ?? (await api.app.pickFolder(agentName)))
      if (cwd === null && !scratch) return null
      // Clicking an agent again must not pile up empty chats in the same folder.
      // An isolated chat and a plain one in the same folder are different things, so the folder's toggle decides which to reuse.
      const builtIn = latest.current.agents.some((a) => a.name === agentName && a.builtIn)
      // Unknown (the lookup failed): reuse nothing and let the server decide, rather than guess "not isolated".
      const isolated =
        builtIn || cwd === null
          ? false
          : await api.app.gitFolder(cwd).then(
              (g) => g.worktree,
              () => null
            )
      const unused = isolated === null ? undefined : reusableChat(latest.current.chats, agentName, cwd, isolated)
      if (unused) {
        openChat(unused.id)
        return unused.id
      }
      const meta = await api.chats.create(agentName, cwd)
      loadedChats.current.add(meta.id)
      setChatViews((prev) => ({ ...prev, [meta.id]: newChatView }))
      setChats((prev) => upsertChat(prev, meta))
      setView({ kind: 'chat', chatId: meta.id })
      setNewDraft(leaveGroupMode)
      return meta.id
    } catch (e) {
      report(e)
      return null
    } finally {
      creating.current = false
    }
  }

  // The agent start screen keeps the draft's text and, for the same agent, its folder; it never opens the folder dialog.
  const showAgentStart = (agentName: string): void => {
    setNewDraft((prev) => ({ ...prev, mode: 'single', agentName, cwd: prev.agentName === agentName ? prev.cwd : null }))
    setView({ kind: 'start' })
  }

  /**
   * Clicking an agent: its start screen with no folder picked, since a chat's folder is locked once it is made.
   * The built-in agent has nothing to pick (it runs in its fixed folder), so it opens a chat straight away.
   */
  const openAgentChat = async (agentName: string): Promise<void> => {
    if (agents.some((a) => a.name === agentName && a.builtIn)) {
      let cwd: string | null
      try {
        cwd = await api.app.lastFolder(agentName)
      } catch (e) {
        report(e)
        return
      }
      if (cwd !== null) {
        await newChat(agentName, { cwd })
        return
      }
    }
    showAgentStart(agentName)
  }

  const deleteAgent = async (filePath: string): Promise<void> => {
    try {
      await api.agents.trash(filePath)
    } catch (e) {
      report(e)
      return
    }
    // The editor's own Delete leaves it the same way; its dirty flag is cleared when it unmounts.
    setView((v) => (v.kind === 'editor' && v.filePath === filePath ? { kind: 'empty' } : v))
    refreshAgents()
  }

  const updateFiles = (key: string, change: (d: DraftFiles) => DraftFiles): void => {
    filesRef.current = { ...filesRef.current, [key]: change(filesRef.current[key] ?? emptyDraftFiles) }
    setDraftFiles(filesRef.current)
  }

  const discardFile = (id: string): void => {
    api.attachments.discard(id).catch(report)
  }

  // Stages each job's file into the draft; a file whose chip was removed (or chat deleted) meanwhile is discarded.
  const stageJobs = (key: string, jobs: { name: string; run: () => Promise<StageResult> }[]): void => {
    const keyed = jobs.map((j) => ({ ...j, key: crypto.randomUUID() }))
    const { draft, accepted } = addStaging(filesRef.current[key] ?? emptyDraftFiles, keyed)
    updateFiles(key, () => draft)
    for (const job of keyed.filter((j) => accepted.includes(j.key))) {
      // A side ask on the new-chat screen can move this upload into its newly opened chat.
      const owner = (): string => Object.keys(filesRef.current).find((k) => filesRef.current[k].files.some((f) => f.key === job.key)) ?? key
      job.run().then(
        (r) => {
          const target = owner()
          if (r.ok && !filesRef.current[target]?.files.some((f) => f.key === job.key)) {
            forgetPreview(r.attachment.id)
            discardFile(r.attachment.id)
          }
          updateFiles(target, (d) => settle(d, job.key, r))
        },
        () => updateFiles(owner(), (d) => settle(d, job.key, { ok: false, name: job.name, error: stageErrors.unreadable(job.name) }))
      )
    }
  }

  const addFiles = (key: string, files: File[], origin: FileOrigin): void => {
    const now = new Date()
    stageJobs(
      key,
      files.map((file) => {
        const name = draftFileName(file, origin, now)
        return {
          name,
          run: async (): Promise<StageResult> => {
            if (file.size > ATTACH_MAX_BYTES) return { ok: false, name, error: stageErrors.tooBig(name) }
            const r = await api.attachments.stageBytes(name, new Uint8Array(await file.arrayBuffer()))
            if (r.ok) rememberPreview(r.attachment, file)
            return r
          }
        }
      })
    )
  }

  // The file dialog is a hidden input the "attach" buttons click; its files take the same path as a drop.
  const pickInput = useRef<HTMLInputElement>(null)
  const pickKey = useRef('new')
  const pickFiles = (key: string): void => {
    pickKey.current = key
    pickInput.current?.click()
  }

  const removeDraftFile = (key: string, fileKey: string): void => {
    const file = filesRef.current[key]?.files.find((f) => f.key === fileKey)
    if (file?.status === 'ready') {
      forgetPreview(file.attachment.id)
      discardFile(file.attachment.id)
    }
    updateFiles(key, (d) => removeFile(d, fileKey))
  }

  // Visible even while another chat is open; the open chat already shows it inline.
  const reportElsewhere = (chatId: string, message: string): void => {
    const { view: v, chats: cs, agents: as } = latest.current
    if (v.kind === 'chat' && v.chatId === chatId) return
    const chat = cs.find((c) => c.id === chatId)
    setError(`${chat ? chatTitle(chat, as) : 'New chat'}: ${message}`)
  }

  const failChat = (chatId: string, message: string): void => {
    setSendErrors((prev) => ({ ...prev, [chatId]: message }))
    reportElsewhere(chatId, message)
  }

  const updatePending = (chatId: string, change: (list: PendingSend[]) => PendingSend[]): void =>
    setPendingSends(({ [chatId]: list = [], ...rest }) => {
      const next = change(list)
      return next.length > 0 ? { ...rest, [chatId]: next } : rest
    })

  const setReply = (chatId: string, itemId: string | null): void =>
    setReplies(({ [chatId]: _old, ...rest }) => (itemId === null ? rest : { ...rest, [chatId]: itemId }))

  // fromComposer false (the Continue pill): the draft, its files and its reply are not what was sent, so they stay as they are.
  // command: the composer's `/` menu pick, so the server knows whose command it is. messageId: the id the caller already
  // knows the message by (the To-dos page's box starts its exchange there).
  const sendMessage = async (
    chatId: string,
    text: string,
    files: DraftFiles = emptyDraftFiles,
    replyTo?: string,
    fromComposer = true,
    command?: CommandPick,
    messageId?: string
  ): Promise<void> => {
    const at = latest.current
    const chat = at.chats.find((c) => c.id === chatId)
    const before = at.chatViews[chatId]?.items ?? []
    const startIndex = before.length
    // Sent while the chat runs, it waits as a task, which its row shows from the meta push: no bubble, or it shows twice.
    const asTask = chat !== undefined && sendsAsTask(chat, before, unconfirmed(before, at.pendingSends[chatId] ?? []))
    const attachments = files.files.flatMap((f) => (f.status === 'ready' ? [f.attachment] : []))
    // Shown as sent at once, under the id the server stores it with; sending a failed text again replaces the failed copy.
    const item: UserItem = {
      type: 'user',
      id: messageId ?? crypto.randomUUID(),
      text,
      ts: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo === undefined ? {} : { replyTo })
    }
    updatePending(chatId, (list) => (asTask ? retried(list, text) : [...retried(list, text), { item, error: null }]))
    setSendErrors(({ [chatId]: _cleared, ...rest }) => rest)
    setSendNotices((prev) => clearNotice(prev, chatId))
    // ChatService.send settles only when the turn ends, so clear the draft now and restore it on rejection.
    if (fromComposer) {
      setDrafts((prev) => ({ ...prev, [chatId]: '' }))
      updateFiles(chatId, () => emptyDraftFiles)
      setReply(chatId, null)
    }
    const ids = attachments.map((a) => a.id)
    const drop = (list: PendingSend[]) => list.filter((p) => p.item.id !== item.id)
    try {
      // Either way the bubble goes: 'queued' means one drawn in a race became a task, which its row now shows.
      await api.chats.send(chatId, text, ids.length > 0 ? ids : undefined, replyTo, item.id, command)
      updatePending(chatId, drop)
    } catch (e) {
      const { chats: cs, chatViews: views, drafts: ds } = latest.current
      const items = views[chatId]?.items ?? []
      const where = rejectedSendState(items, item.id, cs.find((c) => c.id === chatId)?.tasks)
      // Only the reply was lost (queued, or stored when the socket dropped mid-turn): nothing to restore or report.
      if (quietRejection(where, isNotConnected(e))) {
        updatePending(chatId, drop)
        return
      }
      // Stored: the message went through and the turn failed after it.
      const stored = where === 'stored'
      const restore = fromComposer && !stored && shouldRestoreDraft(items, startIndex, text, ds[chatId] ?? '')
      if (restore) {
        setDrafts((prev) => ({ ...prev, [chatId]: text }))
        if (replyTo !== undefined) setReplies((prev) => (chatId in prev ? prev : { ...prev, [chatId]: replyTo }))
        // Exactly as they were; not over files added since.
        if ((filesRef.current[chatId]?.files.length ?? 0) === 0) updateFiles(chatId, () => files)
      }
      if (stored) {
        updatePending(chatId, drop)
        failChat(chatId, failureMessage(errorMessage(e), text, false))
      } else if (asTask) {
        // No bubble to mark: the error says it, quoting the text when it could not go back in the box.
        failChat(chatId, failureMessage(`Message failed to send: ${errorMessage(e)}`, text, restore))
      } else {
        // It never reached the chat: it stays, dimmed, and its warning says why.
        updatePending(chatId, (list) => failSend(list, item.id, errorMessage(e)))
        reportElsewhere(chatId, `Message failed to send: ${errorMessage(e)}`)
      }
    }
  }

  const openSide = (chatId: string, id: string | null): void => {
    setSideFocus((prev) => sideFocusAfter(prev, chatId, id))
    setSide('btw')
  }

  // The chip under a reply: the panel opens on the group that reply made.
  const openTodosAt = (chatId: string, itemId: string): void => {
    setTodosFocus((prev) => ({ chatId, itemId, n: (prev?.n ?? 0) + 1 }))
    setSide('todos')
  }

  // Watch/View on an Agent row: the panel opens on that subagent's conversation.
  const openDispatchAt = (chatId: string, id: string): void => {
    setDispatchFocus((prev) => ({ chatId, id, n: (prev?.n ?? 0) + 1 }))
    setSide('dispatch')
  }

  // A shell block's run status: the panel opens on that run's log.
  const openProcessAt = (chatId: string, id: string): void => {
    setProcessFocus((prev) => ({ chatId, id, n: (prev?.n ?? 0) + 1 }))
    setSide('processes')
  }

  // `/run-workflow <name> <input>` in a chat: the server finds the workflow (the Workflows list's pick, else by the name)
  // and starts it with the input.
  const runWorkflowFromChat = async (chatId: string, text: string, workflowId?: string): Promise<void> => {
    if (startingRuns.current.has(chatId)) return
    startingRuns.current.add(chatId)
    setSendErrors(({ [chatId]: _cleared, ...rest }) => rest)
    setSendNotices((prev) => clearNotice(prev, chatId))
    try {
      const run = await api.workflows.runFromChat(chatId, text, workflowId)
      // A new draft typed while the call was in flight belongs to the next send.
      setDrafts((prev) => (prev[chatId] === text ? { ...prev, [chatId]: '' } : prev))
      const name = latest.current.workflows.workflows.find((w) => w.id === run.workflowId)?.name
      setSendNotices((prev) => setNotice(prev, chatId, startedNotice(name, run)))
    } catch (e) {
      failChat(chatId, errorMessage(e))
    } finally {
      startingRuns.current.delete(chatId)
    }
  }

  // Only ordinary composers come here; edits, resends and queued tasks keep their plain text path.
  const sendFromComposer = async (
    chatId: string,
    text: string,
    pick?: CommandPick,
    messageId?: string,
    workflowId?: string
  ): Promise<void> => {
    const route = routeSend(text)
    if (route.kind === 'send') {
      await sendMessage(chatId, text, filesRef.current[chatId], replies[chatId], true, pick, messageId)
      return
    }
    if (route.kind === 'workflow') {
      await runWorkflowFromChat(chatId, text, workflowId)
      return
    }
    if (!sideParts(route.question) || askingSides.current.has(chatId)) return
    askingSides.current.add(chatId)
    setSendErrors(({ [chatId]: _cleared, ...rest }) => rest)
    setSendNotices((prev) => clearNotice(prev, chatId))
    try {
      const entry = await api.btw.ask(chatId, route.question, crypto.randomUUID())
      // A new draft typed while the ask was in flight belongs to the next send.
      setDrafts((prev) => (prev[chatId] === text ? { ...prev, [chatId]: '' } : prev))
      const shown = latest.current
      if (shown.view.kind === 'chat' && shown.view.chatId === chatId && shown.settings === null) openSide(chatId, entry.id)
    } catch (e) {
      failChat(chatId, errorMessage(e))
    } finally {
      askingSides.current.delete(chatId)
    }
  }

  // Send on the no-chat-open screen: start the chat it describes, then send the text there. The text is the
  // composer's: a dictation's held send comes before this render's newDraft has its transcript.
  const startChat = async (text: string, pick?: CommandPick): Promise<void> => {
    const draft = { ...newDraft, text }
    const target = newChatTarget(draft, agents)
    const files = filesRef.current.new ?? emptyDraftFiles
    const route = routeSend(text)
    if (route.kind === 'workflow') return // a workflow starts from a chat; the composer already refused with its notice
    if (route.kind === 'btw' && !sideParts(route.question)) return
    if (!target || (draft.text.trim() === '' && readyIds(files).length === 0) || (isStaging(files) && route.kind !== 'btw')) return
    const chatId = await newChat(target.agentName, target.folder)
    if (chatId === null) return
    // A model picked on this screen is the new chat's own pick, when it fits the agent's engine: one picked before the agent
    // was switched to one on the other engine is dropped, as the picker already shows Default for it.
    const engine = engineOfAgent(agents.find((a) => a.name === target.agentName))
    if (draft.model && modelFits(engine, draft.model)) {
      await api.chats.setModel(chatId, draft.model).catch(report)
    }
    // The same for a mode or effort picked here: one the agent's engine can't run was shown as the default and is dropped.
    const mode = engineChatMode(engine, draft)
    if (mode) await api.chats.setPermissionMode(chatId, mode).catch(report)
    const effort = engineChatEffort(engine, draft)
    if (effort && effort !== DEFAULT_EFFORT) await api.chats.setEffort(chatId, effort).catch(report)
    setNewDraft(emptyNewChatDraft)
    if (route.kind === 'btw') {
      setDrafts((prev) => ({ ...prev, [chatId]: text }))
      // Uploads can settle while chat creation waits; transfer their current state.
      updateFiles(chatId, () => filesRef.current.new ?? emptyDraftFiles)
    }
    updateFiles('new', () => emptyDraftFiles)
    if (route.kind === 'btw') await sendFromComposer(chatId, text, pick)
    else await sendMessage(chatId, draft.text, files, undefined, true, pick)
  }

  // Send on the new-chat screen in group mode: create the group, then post the text there (send resolves once posted).
  const startGroup = async (text: string, pick?: CommandPick): Promise<void> => {
    const draft = { ...newDraft, text }
    const target = newGroupTarget(draft, agents)
    const files = filesRef.current.new ?? emptyDraftFiles
    const route = routeSend(text)
    if (route.kind === 'workflow') return // a workflow starts from a chat; the composer already refused with its notice
    if (route.kind === 'btw' && !sideParts(route.question)) return
    if (
      !target ||
      (draft.text.trim() === '' && readyIds(files).length === 0) ||
      (isStaging(files) && route.kind !== 'btw') ||
      creating.current
    )
      return
    creating.current = true
    let meta: ChatMeta
    try {
      meta = await api.chats.createGroup(target.members, target.cwd, target.role)
    } catch (e) {
      report(e)
      return
    } finally {
      creating.current = false
    }
    loadedChats.current.add(meta.id)
    setChatViews((prev) => ({ ...prev, [meta.id]: newChatView }))
    setChats((prev) => upsertChat(prev, meta))
    setView({ kind: 'chat', chatId: meta.id })
    setNewDraft(emptyNewChatDraft)
    if (route.kind === 'btw') {
      setDrafts((prev) => ({ ...prev, [meta.id]: text }))
      updateFiles(meta.id, () => filesRef.current.new ?? emptyDraftFiles)
    }
    updateFiles('new', () => emptyDraftFiles)
    if (route.kind === 'btw') await sendFromComposer(meta.id, text, pick)
    else await sendMessage(meta.id, draft.text, files, undefined, true, pick)
  }

  // The new-chat screen in group mode. No folder is pre-filled: a group with none runs in a scratch folder of its own.
  const newGroup = (): void => {
    setView({ kind: 'empty' })
    if (newDraft.mode === 'group') return
    setNewDraft((prev) => ({ ...prev, mode: 'group' }))
  }

  // The picked folder's git state: read again whenever the folder changes (and once the socket is back). Errors give null.
  const [newGit, setNewGit] = useState<{ cwd: string; repo: boolean; worktree: boolean } | null>(null)
  const newCwd = newDraft.cwd
  const online = connection === 'connected'
  const refreshNewGit = useCallback((cwd: string): Promise<void> => {
    return api.app.gitFolder(cwd).then(
      (g) => setNewGit((prev) => (latest.current.newDraft.cwd === cwd ? { cwd, ...g } : prev)),
      () => setNewGit((prev) => (latest.current.newDraft.cwd === cwd ? null : prev))
    )
  }, [])
  useEffect(() => {
    if (newCwd === null || !online) {
      setNewGit(null)
      return
    }
    void refreshNewGit(newCwd)
  }, [newCwd, online, refreshNewGit])
  const toggleNewWorktree = (on: boolean): void => {
    if (newCwd === null) return
    api.app.setWorktreeFolder(newCwd, on).then(() => refreshNewGit(newCwd), report)
  }

  const chooseNewChatFolder = (): void => {
    api.app.pickFolder(newDraft.mode === 'group' ? null : newDraft.agentName).then((cwd) => {
      if (cwd !== null) setNewDraft((prev) => ({ ...prev, cwd }))
    }, report)
  }

  const stopChat = (chatId: string): void => {
    api.chats.stop(chatId).catch((e: unknown) => failChat(chatId, errorMessage(e)))
  }

  // Both ask the server and show a refusal (not running, compacting, already paused) on the chat, as Stop does.
  const pauseChat = (chatId: string): void => {
    api.chats.pause(chatId).catch((e: unknown) => failChat(chatId, errorMessage(e)))
  }
  const resumeChat = (chatId: string): void => {
    api.chats.resume(chatId).catch((e: unknown) => failChat(chatId, errorMessage(e)))
  }

  // Both resolve false on failure (the chat shows why), so the tray knows the row stays.
  const dropTask = (chatId: string, taskId: string): Promise<boolean> =>
    api.chats.dropTask(chatId, taskId).then(
      () => true,
      (e: unknown) => {
        failChat(chatId, errorMessage(e))
        return false
      }
    )

  // Its row leaves with the meta push and the message comes in with the items; a single chat's call settles when the turn ends.
  const sendTask = (chatId: string, taskId: string): Promise<boolean> => {
    setSendErrors(({ [chatId]: _cleared, ...rest }) => rest)
    return api.chats.sendTask(chatId, taskId).then(
      () => true,
      (e: unknown) => {
        failChat(chatId, errorMessage(e))
        return false
      }
    )
  }

  // Edit, Resend and Switch resolve once settled and show a failure ("Message not found", "Chat is busy") as a send error.
  const settled = (chatId: string, request: Promise<unknown>): Promise<void> => {
    setSendErrors(({ [chatId]: _cleared, ...rest }) => rest)
    return request.then(
      () => undefined,
      (e: unknown) => failChat(chatId, errorMessage(e))
    )
  }

  const editMessage = (chatId: string, itemId: string, text: string, command?: CommandPick): Promise<void> =>
    settled(chatId, api.chats.edit(chatId, itemId, text, command))
  const resendMessage = (chatId: string, itemId: string): Promise<void> => settled(chatId, api.chats.resend(chatId, itemId))
  const switchVersion = (chatId: string, itemId: string, index: number): Promise<void> =>
    settled(chatId, api.chats.switchVersion(chatId, itemId, index))
  const compactChat = (chatId: string, note: string, agent?: string): Promise<void> =>
    settled(chatId, api.chats.compact(chatId, note, agent))

  // A room made from another (a clone, a fork) goes right under its source in the sidebar, in the same section. Rooms
  // never placed have no stored spot, so the order the user sees is written out first (placeAfter does that); a failed
  // save is reported by the hook and leaves the new room as is.
  const placeUnder = (sourceId: string, meta: ChatMeta): void => {
    const { agents: listed, layout } = placing.current
    if (layout === null) return
    const next = placeAfter(layout, itemKeys(listed, upsertChat(latest.current.chats, meta)), groupKey(meta.id), groupKey(sourceId))
    if (next !== layout) sidebarLayout.save(next)
  }

  // A user message's fork puts its text and files back in the new chat's composer, where the fork can send them again.
  const forkFrom = async (chatId: string, itemId: string): Promise<void> => {
    try {
      const { chat, draft } = await api.chats.fork(chatId, itemId)
      if (draft) {
        setDrafts((prev) => ({ ...prev, [chat.id]: draft.text }))
        updateFiles(chat.id, () => ({
          files: draft.attachments.map((a) => ({ key: a.id, name: a.name, status: 'ready' as const, attachment: a })),
          error: null
        }))
      }
      setChats((prev) => upsertChat(prev, chat))
      // A single chat's fork lists under its agent; only a room has a sidebar spot of its own.
      if (chat.group) placeUnder(chatId, chat)
      openChat(chat.id)
    } catch (e) {
      failChat(chatId, errorMessage(e))
    }
  }

  const roomCloned = (sourceId: string, meta: ChatMeta): void => {
    setCloneSource(null)
    setChats((prev) => upsertChat(prev, meta))
    placeUnder(sourceId, meta)
    navigate(() => openChat(meta.id))
  }

  const setGroupRole = (chatId: string, role: string): void => {
    api.chats.setRole(chatId, role).then((meta) => setChats((prev) => upsertChat(prev, meta)), report)
  }

  const reactTo = (chatId: string, itemId: string, emoji: string): void => {
    api.chats.react(chatId, itemId, emoji).then((meta) => setChats((prev) => upsertChat(prev, meta)), report)
  }

  const markUnread = (chatId: string, itemId: string): void => {
    api.chats.markUnread(chatId, itemId).then((meta) => setChats((prev) => upsertChat(prev, meta)), report)
  }

  const archiveChat = (chatId: string, on: boolean): void => {
    api.chats.archive(chatId, on).then((meta) => setChats((prev) => upsertChat(prev, meta)), report)
  }

  const sendAnswer = (chatId: string, requestId: string, reply: ApprovalReply, agent?: string): Promise<void> =>
    typeof reply === 'string'
      ? api.chats.answer(chatId, requestId, reply, agent)
      : 'plan' in reply
        ? api.chats.answerPlan(chatId, requestId, reply.plan.approve, reply.plan.feedback, agent)
        : api.chats.answerQuestions(chatId, requestId, reply.answers, agent)
  const answerApproval = (chatId: string, requestId: string, reply: ApprovalReply, agent?: string): void => {
    sendAnswer(chatId, requestId, reply, agent).catch((e: unknown) => failChat(chatId, errorMessage(e)))
  }
  // An ask card's Open in conversation on a side entry: the panel slot is shared by every chat and nothing resets it
  // when the chat changes, so the view and focus set with the move are still there when the other chat shows.
  const island = islandBridge
  askActions.current = island
    ? // The popup shows only its agent's own chats: an asked chat opens in the main window.
      {
        answer: answerApproval,
        open: (id: string) => island.openMain({ chatId: id, live: null }),
        openSide: (id: string) => island.openMain({ chatId: id, live: null })
      }
    : {
        answer: answerApproval,
        open: fromNav((id: string) => navigate(() => openChat(id))),
        openSide: fromNav((id: string, entryId: string | null) =>
          navigate(() => {
            openChat(id)
            openSide(id, entryId)
          })
        )
      }

  const renameChat = async (chatId: string, title: string): Promise<void> => {
    const trimmed = title.trim()
    if (trimmed === '') return
    try {
      const meta = await api.chats.rename(chatId, trimmed)
      setChats((prev) => upsertChat(prev, meta))
    } catch (e) {
      report(e)
    }
  }

  const deleteChat = async (chatId: string): Promise<void> => {
    try {
      await api.chats.remove(chatId)
    } catch (e) {
      report(e)
      return
    }
    loadedChats.current.delete(chatId)
    itemSyncs.current.delete(chatId)
    setChats((prev) => prev.filter((c) => c.id !== chatId))
    setChatViews(({ [chatId]: _removed, ...rest }) => rest)
    setDrafts(({ [chatId]: _removed, ...rest }) => rest)
    for (const f of filesRef.current[chatId]?.files ?? []) if (f.status === 'ready') discardFile(f.attachment.id)
    const { [chatId]: _files, ...otherFiles } = filesRef.current
    filesRef.current = otherFiles
    setDraftFiles(otherFiles)
    setSendErrors(({ [chatId]: _removed, ...rest }) => rest)
    setPendingSends(({ [chatId]: _removed, ...rest }) => rest)
    setToolsOpen(({ [chatId]: _removed, ...rest }) => rest)
    setApprovals(({ [chatId]: _removed, ...rest }) => rest)
    setView((v) => (v.kind === 'chat' && v.chatId === chatId ? { kind: 'empty' } : v))
  }

  const connectionLabel = connectionBarLabel(connection, everConnected, graceElapsed)
  const openChatMeta = view.kind === 'chat' ? chats.find((c) => c.id === view.chatId) : undefined
  const openChatAgent =
    openChatMeta &&
    (agents.find((a) => a.name === openChatMeta.agentName && a.error === null) ?? agents.find((a) => a.name === openChatMeta.agentName))
  // The small-screen bar shows the open chat's members, or its agent.
  const barIcon = openChatMeta?.group ? (
    <MemberStack agents={memberAgents(openChatMeta.group.members, agents)} size={26} working={workingMembers(openChatMeta)} max={2} />
  ) : openChatAgent ? (
    <BotIcon
      icon={openChatAgent.icon}
      color={openChatAgent.error === null ? openChatAgent.color : null}
      builtIn={openChatAgent.builtIn}
      working={false}
      size={24}
    />
  ) : undefined

  // The chat the main area shows right now, if any: the side panel's chat views follow it.
  const shownChat =
    islandBridge === null &&
    routeChat === null &&
    settings === null &&
    (archive || mode === 'agents') &&
    view.kind === 'chat' &&
    openChatMeta &&
    (isGroup(openChatMeta) || openChatAgent)
      ? openChatMeta
      : null
  // On a small screen the shown chat's side panel toggle sits in the mobile bar, not on a row of its own over the chat.
  const narrowScreen = useNarrow()
  // The open chat's branch and uncommitted count: its git chip and the side panel's Changes row both show it.
  const [chatGit, reloadChatGit] = useGitStatus(islandBridge === null ? (openChatMeta ?? null) : null)
  const chatFiles = useChatFiles(shownChat?.id ?? null, connection === 'connected')
  const sideQuestions = useSideQuestions(shownChat?.id ?? null, connection === 'connected')
  const todos = useTodos(shownChat?.id ?? null, connection === 'connected')
  const shownItems = shownChat ? chatViews[shownChat.id]?.items : undefined
  // A search hit's chat is on screen now (its list mounted with the request it had): ask it to scroll to the message.
  useEffect(() => {
    if (!jump || shownChat?.id !== jump.chatId) return
    setShowRequest((r) => ({
      chatId: jump.chatId,
      itemId: jump.itemId,
      ...(jump.query !== undefined ? { query: jump.query } : {}),
      n: (r?.n ?? 0) + 1
    }))
    setJump(null)
  }, [jump, shownChat?.id])
  const todoVisibleIds = useMemo(() => new Set((shownItems ?? []).map((i) => i.id)), [shownItems])
  const paletteSources = useMemo<PaletteSources>(
    () => ({
      chats,
      agents,
      routines: routines.routines,
      workflows: workflows.workflows,
      vps,
      desktop: api.desktop !== null,
      island: hasIsland
    }),
    [chats, agents, routines.routines, workflows.workflows, vps]
  )
  const todoHistoryDone = historyComplete(shownChat ? (chatViews[shownChat.id]?.start ?? null) : null)
  const todosLeft = useMemo(
    () => panelView(todos.items ?? [], todoVisibleIds, todoHistoryDone).left,
    [todos.items, todoVisibleIds, todoHistoryDone]
  )
  const dispatch = useDispatch(shownChat?.id ?? null, connection === 'connected')
  const processes = useProcesses(shownChat?.id ?? null, connection === 'connected')
  // Every chat's running count, for the header's mark (the island popup has no side panel, so it never asks).
  const processCounts = useProcessCounts(connection === 'connected' && islandBridge === null)
  // Tool calls of the shown chat waiting on an approval card: a subagent's shows on its row in the panel.
  const pendingToolIds = useMemo(
    () => new Set((shownItems ?? []).flatMap((i) => (i.type === 'approval' && i.status === 'pending' && i.toolUseId ? [i.toolUseId] : []))),
    [shownItems]
  )
  const dispatchWaiting = useMemo(() => waitingIds(dispatch.list ?? [], pendingToolIds), [dispatch.list, pendingToolIds])
  const dispatchShownId = shownChat?.id ?? null
  const dispatchLink = useMemo(
    (): DispatchLink => ({
      state: (toolId) => linkState(dispatch.list, toolId),
      open: (toolId) => {
        if (dispatchShownId !== null) openDispatchAt(dispatchShownId, toolId)
      }
    }),
    [dispatch.list, dispatchShownId]
  )
  // The shown chat's processes are the main chat view's: each shell block finds its latest run there.
  const runLink = useMemo(
    (): RunLink => ({
      list: processes.list,
      run: async (chatId, messageId, command) => {
        await api.processes.run(chatId, messageId, command)
      },
      open: openProcessAt
    }),
    [processes.list]
  )
  // The Files panel's Explain sends into the shown chat, which needs its own CLI (codex for a Codex chat).
  const canSend =
    connection === 'connected' && cliMissing(shownChat ? chatEngine(shownChat, agents) : 'claude', claudePath !== null, codexInfo) === null

  // The task board: fetched always, since it feeds the rail badge (the cards that wait on the user) and the Inbox's card
  // questions as well as the page.
  const board = useBoard(connection === 'connected' && islandBridge === null)
  const todosBadge = boardBadge(board.board, chats, approvals)
  // The Inbox: messages feed the rail dot always; the page holds the seenAt it opened with, so what was new stays marked
  // while it is read, and marks the Inbox seen once it shows on a visible tab.
  const inbox = useInboxMessages(connection === 'connected' && islandBridge === null)
  const inboxShown = inboxPage !== null && settings === null
  // Seen only while the Messages section itself shows (spec goal 14), not under the Waiting chip.
  const inboxMessagesShown = inboxShown && inboxFilter !== 'waiting'
  useMarkInboxSeen(inbox.data, inboxMessagesShown)
  const inboxHeld = useRef<number | null>(null)
  inboxHeld.current = heldSeenAt(inboxHeld.current, inboxPage !== null, inbox.data)
  // The Waiting section's list is built whether or not the Inbox shows, and the rail number is its length, so the two
  // never disagree. Its cards are each chat's own items: every listed chat with something waiting has them loaded (as an
  // ask card loads its asked chat's), and loaded again when its count moves; a synced chat is left as it is. A
  // reconnect forgets what was loaded, so they load again then.
  const workflowApprovals = useWorkflowApprovals(connection === 'connected' && islandBridge === null, workflows)
  const waitingLoad = loadKey(approvals, chats)
  useEffect(() => {
    if (connection !== 'connected' || islandBridge) return // the Inbox's cards: the island loads a chat when its popup opens it
    for (const id of waitingChats(approvals, chats)) loadAsked(id)
  }, [waitingLoad, connection, loadAsked]) // approvals and chats only matter through waitingLoad
  // Only the newest page of a chat loads, and a card can sit above it (a room member waits while the others work on):
  // while a chat's own count (its A→B chats' cards taken out) is above the cards its loaded items hold, older pages load,
  // one at a time, until they are found, the history starts, or OLDER_PAGES_MAX pages for that count were tried.
  useEffect(() => {
    if (connection !== 'connected' || islandBridge) return
    for (const id of waitingChats(approvals, chats)) {
      const view = chatViews[id]
      if (!view || view.start === null || loadingOlder[id]) continue
      const count = ownPending(id, approvals, chats)
      const t = olderTried.current.get(id)
      const tried = t && t.count === count ? t.pages : 0
      if (!needsOlder(pendingFromItems(view.items), count, historyComplete(view.start), tried)) continue
      olderTried.current.set(id, { count, pages: tried + 1 })
      loadOlder(id)
    }
  }, [chatViews, approvals, chats, connection, loadingOlder, loadOlder])
  const inboxEntries = useMemo(
    () =>
      waitingEntries({
        chats,
        pendingByChat: approvals,
        itemsOf: (id) => chatViews[id]?.items,
        approvals: workflowApprovals,
        cards: board.board?.open ?? []
      }),
    [chats, approvals, chatViews, workflowApprovals, board.board]
  )
  const inboxWaitingCount = inboxEntries.length
  const inboxHolds = useInboxHolds()
  // A desktop or browser the Inbox asked to open in the chat it moves to (see the effect after the live views).
  const [liveAsk, setLiveAsk] = useState<LiveAsk | null>(null)
  const inboxNewCount = useMemo(
    () =>
      inbox.data !== null && inboxHeld.current !== null && workflows.loaded
        ? messageView(inbox.data, inboxHeld.current, workflows).newCount
        : 0,
    [inbox.data, workflows, inboxPage] // inboxHeld.current only changes with inbox.data or inboxPage
  )
  // The address named a message: once it is lit, `/inbox/<id>` becomes `/inbox` in place, not a new history entry.
  const inboxFocused = (): void => {
    setInboxPage((i) => (i !== null && i.messageId !== null ? { messageId: null } : i))
    if (settings === null && inboxFromPath(location.pathname)?.messageId != null) {
      history.replaceState(null, '', inboxPath(null))
      lastPath.current = inboxPath(null)
    }
  }
  // The board looks at no chat: seeing a card is not reading the chat it came from.
  const todosShown = todosPage !== null && settings === null

  // The island's icons (the picked agents that can still run) and the agent whose popup shows; one picked agent that went
  // away closes its popup.
  const iconAgents = useMemo(() => (islandBridge ? islandAgents(islandPicks ?? [], agents) : []), [islandPicks, agents])
  const popupAgent = popupAgentOf(
    islandAgent,
    iconAgents.map((a) => a.name),
    islandVoiceAgent,
    agents
  )
  // `@` in the popup's new-chat box asks another agent, as in the main app's; Zumi Bot has no ask tool.
  const popupBuiltIn = agents.find((a) => a.name === popupAgent)?.builtIn === true
  const islandAskable = useMemo(
    () => (popupAgent !== null && !popupBuiltIn ? askableAgents(agents, popupAgent) : undefined),
    [agents, popupAgent, popupBuiltIn]
  )
  // The chat on screen, for presence. The board shows none.
  // The island looks at its chat only while its popup shows it; it is no notification device (presence only).
  const popupChat =
    popupAgent !== null && view.kind === 'chat'
      ? chats.find((c) => c.id === view.chatId && !isGroup(c) && c.agentName === popupAgent)
      : undefined
  useNotifications({
    api,
    viewChatId: islandBridge
      ? (popupChat?.id ?? null)
      : todosShown
        ? null
        : routeChat === null && settings === null && (archive || mode === 'agents') && view.kind === 'chat'
          ? view.chatId
          : null,
    viewOpens: !todosShown,
    pendingByChat: approvals,
    openChatFromNotification,
    openInboxFromNotification: openInboxMessage,
    openRunFromNotification: (workflowId, runId) => {
      setNavOpen(false)
      openWorkflowRun(workflowId, runId)
    },
    presenceOnly: islandBridge !== null
  })

  // The island adds its open agent, so closing the popup ends a browser it holds.
  const liveScope = `${mode}:${view.kind}:${view.kind === 'chat' ? view.chatId : view.kind === 'editor' ? view.filePath : (newDraft.agentName ?? '')}${islandBridge ? `:island:${popupAgent ?? ''}` : ''}`
  const browser = useAgentBrowser(liveScope)
  const desktop = useAgentDesktop(liveScope)
  const openItems = openChatMeta ? (chatViews[openChatMeta.id]?.items ?? []) : []
  const browserRequest = browser.state.target?.requestId
  // Desktop cards share the item type: only a browser card holds the browser inline.
  const pendingBrowserCard = pendingHandoff(openItems, browserRequest, 'browser')
  useEffect(() => {
    if (browserRequest && !pendingBrowserCard) browser.close()
  }, [browserRequest, pendingBrowserCard])
  const desktopRequest = desktop.state.target?.requestId
  const pendingDesktopCard = pendingHandoff(openItems, desktopRequest, 'desktop')
  useEffect(() => {
    if (desktopRequest && !pendingDesktopCard) desktop.close()
  }, [desktopRequest, pendingDesktopCard])
  // A handoff card shows its browser or desktop inline; every other open one belongs to the side panel.
  const browserInPanel = browser.state.open && !pendingBrowserCard
  const desktopInPanel = desktop.state.open && !pendingDesktopCard
  // "Waiting for approval": a desktop call of the viewed agent waits on a card in this chat.
  const desktopTarget = desktop.state.target
  const desktopApproval =
    !!desktopTarget &&
    !!openChatMeta &&
    desktopTarget.chatId === openChatMeta.id &&
    desktopApprovalPending(openItems, desktopTarget.agent, isGroup(openChatMeta) ? undefined : openChatMeta.agentName)
  // Only the edges move the panel, so a chat view opened over the browser still hides it.
  const browserWasOpen = useRef(browser.state.open)
  useEffect(() => {
    const was = browserWasOpen.current
    browserWasOpen.current = browser.state.open
    setSide((s) => browserMoved(s, was, browser.state.open, !pendingBrowserCard))
  }, [browser.state.open])
  const desktopWasOpen = useRef(desktop.state.open)
  useEffect(() => {
    const was = desktopWasOpen.current
    desktopWasOpen.current = desktop.state.open
    setSide((s) => liveMoved(s, 'desktop', was, desktop.state.open, !pendingDesktopCard))
  }, [desktop.state.open])
  // One live view at a time: the one opened last closes the other, which would keep streaming out of sight.
  const browserTarget = browser.state.target
  useEffect(() => {
    if (browser.state.open && desktop.state.open) desktop.close()
  }, [browserTarget])
  useEffect(() => {
    if (desktop.state.open && browser.state.open) browser.close()
  }, [desktopTarget])
  const liveInPanel = panelLive(side, browserInPanel, desktopInPanel)
  const shownSideView = settings === null ? shownSide(side, shownChat !== null, liveInPanel) : null
  listShown.current = isChatView(shownSideView)
  liveBehind.current = liveInPanel
  const closeSideView = (): void => setSide((s) => closeSide(s, liveInPanel))
  const closeFilesIfNarrow = (): void => {
    if (window.matchMedia(NARROW_QUERY).matches) closeSideView()
  }
  // The panel icon, by what is on screen (a browser moved into a handoff card leaves the slot empty). Closing the panel
  // ends a browser or desktop it holds, shown or behind a chat view: hidden, it would keep capturing.
  const toggleSidePanel = (): void => {
    if (shownSideView !== null && browserInPanel) browser.close()
    if (shownSideView !== null && desktopInPanel) desktop.close()
    setSide(toggleSide(shownSideView))
  }
  // The list's Open Browser. The same agent's browser already open here comes back as it is; another starts a view.
  const openSideBrowser = (agent: string, chatId: string): void => {
    if (!isOpenBrowser(browser.state.open, browser.state.target, agent, chatId)) browser.open({ agent, chatId })
    setSide('browser')
  }
  // The list's Open Desktop, the same way; Show on desktop always starts the view again with its mark.
  const openSideDesktop = (agent: string, chatId: string, marker?: { x: number; y: number }): void => {
    if (marker || !isOpenDesktop(desktop.state.open, desktop.state.target, agent, chatId)) desktop.open({ agent, chatId }, marker)
    setSide('desktop')
  }
  // An approval card in a single chat has no agent of its own: it is the chat's. Without a point it opens as the list does.
  const showOnDesktop = (agent: string | undefined, point: { x: number; y: number } | null): void => {
    if (shownChat) openSideDesktop(agent ?? shownChat.agentName, shownChat.id, point ?? undefined)
  }
  // The Inbox has no live view: it opens the chat, then the desktop or browser there. The move changes the live views'
  // scope, whose effect in their hooks (above, so run first) closes them; this opens the view after that close, once the
  // chat shows.
  useEffect(() => {
    if (liveAsk === null) return
    setLiveAsk(null)
    if (shownChat?.id !== liveAsk.chatId) return // the chat did not show (gone, or its agent is)
    if (liveAsk.kind === 'desktop') openSideDesktop(liveAsk.agent, liveAsk.chatId, liveAsk.point ?? undefined)
    else if (liveAsk.surface === 'desktop') desktop.open(liveAsk.target)
    else browser.open(liveAsk.target)
  }, [liveAsk])
  const openFromInbox = (chatId: string, ask: LiveAsk | null): void =>
    navigate(() => {
      openChat(chatId)
      setLiveAsk(ask)
    })
  // A card's Open to-do →: its list on the To-dos page with that card open, as the rail's To-dos opens the page.
  const openTodoFromInbox = (todoId: string): void =>
    navigate(() => {
      setSettings(null)
      setArchive(false)
      setInboxPage(null)
      setTodosPage({ taskId: todoId })
      setView({ kind: 'empty' })
      setNavOpen(false)
    })
  // The main window opens what the island asked for: its chat, and a live view beside it. The island has none of its own,
  // since a desktop stream or the side panel belong to the main window. Nothing else may be showing over the chat.
  const openFromIsland = (chatId: string, ask: LiveAsk | null): void => {
    if (!latest.current.chats.some((c) => c.id === chatId)) return
    navigate(() => {
      setSettings(null)
      setArchive(false)
      setTodosPage(null)
      setInboxPage(null)
      setMode('agents')
      saveRailMode('agents')
      openChat(chatId)
      setLiveAsk(ask)
    })
  }
  const islandOpen = useRef(openFromIsland)
  islandOpen.current = openFromIsland
  useEffect(
    () =>
      api.desktop?.onIslandOpen?.((t) => {
        const ask = islandOpenAsk(t)
        if (ask) islandOpen.current(ask.chatId, ask.live)
      }),
    []
  )

  // The island page. The layout and picks are listened to before the shape is sent, so the shell's first layout is not missed.
  const islandLoaded = islandPicks !== null && agentsLoaded
  useEffect(() => {
    if (!islandBridge) return
    document.documentElement.classList.add('island-page')
    let pushed = false
    const bridge = islandBridge
    const offs = [
      bridge.onLayout(setIslandLayout),
      bridge.onAgents((picks) => {
        pushed = true
        setIslandPicks(picks)
      })
    ]
    // The shortcut: on opens the voice popup in place of an agent's (the window has one popup), off stops the talk by closing
    // it (the hook releases the mic) and says so, which is what lets the shell drop a voice-only island.
    const offVoice = bridge.onVoice?.((on) => {
      setIslandVoice(on)
      if (on) {
        setIslandAgent(null)
        setIslandVoiceAgent(null)
      } else bridge.voiceEnded?.()
    })
    if (offVoice) offs.push(offVoice)
    islandBridge.agents().then(
      (picks) => {
        if (!pushed) setIslandPicks(picks)
      },
      () => {
        if (!pushed) setIslandPicks([])
      }
    )
    return () => {
      for (const off of offs) off()
    }
  }, [])
  const iconCount = iconAgents.length
  const popupOpen = popupAgent !== null || islandVoice
  useEffect(() => {
    if (islandBridge && islandLoaded) islandBridge.setShape(iconCount, popupOpen)
  }, [islandLoaded, iconCount, popupOpen])
  // Shown only once there is something true to draw: the picks, the agents and the chats (for the marks).
  const islandReadySent = useRef(false)
  useEffect(() => {
    if (!islandBridge || islandReadySent.current || !islandLoaded || !chatsLoaded) return
    islandReadySent.current = true
    islandBridge.ready()
  }, [islandLoaded, chatsLoaded])
  // A pick that stopped being an island agent (deleted, broken, unpicked) takes its popup with it.
  useEffect(() => {
    if (islandAgent !== null && islandLoaded && popupAgent === null) setIslandAgent(null)
  }, [islandAgent, islandLoaded, popupAgent])
  // Where this popup stands, kept for the icon's next click (a fork's new chat too).
  useEffect(() => {
    if (popupAgent === null) return
    const target = islandTargetOf(view, chats, popupAgent)
    if (target) setIslandLast((prev) => (sameTarget(prev[popupAgent], target) ? prev : { ...prev, [popupAgent]: target }))
  }, [popupAgent, view, chats])
  // The new-chat state names the folder its first message will run in.
  const newState = popupAgent !== null && popupChat === undefined
  useEffect(() => {
    if (!islandBridge || popupAgent === null || !newState || connection !== 'connected') return
    let live = true
    api.app.newChatFolder(popupAgent).then(
      (cwd) => {
        if (live) setIslandFolder({ agent: popupAgent, cwd })
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [popupAgent, newState, connection])
  const closeIsland = useCallback(() => {
    setIslandAgent(null)
    setIslandVoiceAgent(null)
  }, [])
  // Unmounting the voice view ends the talk and frees the mic; the shell is told it is over from here, whoever ended it.
  const endIslandVoice = useCallback(() => {
    setIslandVoice(false)
    islandBridge?.voiceEnded?.()
  }, [])
  // An icon: its popup closes when it is the open one, else opens at the chat or new-chat state chatToOpen picks.
  const clickIslandIcon = (name: string): void => {
    if (islandVoice) endIslandVoice()
    setIslandVoiceAgent(null)
    if (popupAgent === name) {
      setIslandAgent(null)
      return
    }
    const target = chatToOpen(chats, name, approvals, islandLast[name])
    setIslandAgent(name)
    if (target.kind === 'chat') openChat(target.chatId)
    else setView({ kind: 'empty' })
  }
  // The first message of the popup's new-chat state: an ordinary chat in the agent's last folder, then the send of startChat.
  const startIslandChat = async (agentName: string, text: string, pick?: CommandPick): Promise<void> => {
    const key = `island-new:${agentName}`
    const files = filesRef.current[key] ?? emptyDraftFiles
    const route = routeSend(text)
    if (route.kind === 'workflow') return // a workflow starts from a chat; the composer already refused with its notice
    if (route.kind === 'btw' && !sideParts(route.question)) return
    if ((text.trim() === '' && readyIds(files).length === 0) || (isStaging(files) && route.kind !== 'btw')) return
    let cwd: string
    try {
      cwd = await api.app.newChatFolder(agentName)
    } catch (e) {
      report(e)
      return
    }
    const chatId = await newChat(agentName, { cwd })
    if (chatId === null) return
    setDrafts(({ [key]: _sent, ...rest }) => rest)
    if (route.kind === 'btw') {
      setDrafts((prev) => ({ ...prev, [chatId]: text }))
      updateFiles(chatId, () => filesRef.current[key] ?? emptyDraftFiles)
    }
    updateFiles(key, () => emptyDraftFiles)
    if (route.kind === 'btw') await sendFromComposer(chatId, text, pick)
    else await sendMessage(chatId, text, files, undefined, true, pick)
  }

  // The Inbox answers through each card's own path: a chat card's RPC with its own chat id (an A→B card's is the A→B
  // chat's, as an ask card does), a handoff's socket answer, a workflow approval's RPC. A chat card's failure lands on its
  // chat as there; the Inbox shows it on the card rather than in the error strip.
  const sendInboxAnswer = (entry: WaitingEntry, a: InboxAnswer): Promise<void> => {
    if (entry.kind === 'workflow' && a.kind === 'workflow') {
      return api.workflows.approve(entry.approval.runId, entry.approval.visit.id, a.ok, a.text, a.note)
    }
    if (entry.kind === 'handoff' && a.kind === 'handoff') {
      const { handoff, agent, surface } = entry.item
      const target = { agent, chatId: handoff.chatId, requestId: handoff.id }
      return surface === 'desktop' ? desktop.answer(target, a.decision) : browser.answer(target, a.decision)
    }
    if (entry.kind === 'todo' && a.kind === 'todo') {
      return api.todos.answer(entry.item.id, a.answers)
    }
    if (entry.kind === 'card' && a.kind === 'card') {
      const chatId = entry.chatId
      return sendAnswer(chatId, entry.item.id, a.reply, entry.item.agent).catch((e: unknown) => {
        setSendErrors((prev) => ({ ...prev, [chatId]: errorMessage(e) }))
        throw e
      })
    }
    return Promise.reject(new Error('This answer does not fit its card'))
  }

  const routinesWaiting = anyWaiting(routines)
  const workflowsWaiting = anyWorkflowWaiting(workflows)
  const openRoutine = routineView?.id ? routines.routines.find((r) => r.id === routineView.id) : undefined
  // The sidebar and every unread roll-up leave archived chats out: a dot there could never be cleared from the list.
  const live = liveChats(chats)
  // What a to-do card reads: every chat (an archived task chat is still there), the approval counts, and a way to its chat.
  // Memoized so card rows do not redraw on every streamed token; `navigate` reads only refs, so an older one is the same.
  const todoCardEnv = useMemo<TodoCardEnv>(
    () => ({ agents, chats, approvals, board: board.board, openChat: (chatId) => navigate(() => openChat(chatId)) }),
    [agents, chats, approvals, board.board, openChat]
  )
  const railActive: RailEntry =
    settings !== null ? 'settings' : inboxPage !== null ? 'inbox' : todosPage !== null ? 'todos' : archive ? 'archived' : mode

  // What a chat's view gets: the open chat and the To-dos page's message box are the same view of the same chat.
  const chatViewProps = (chat: ChatMeta, agent: AgentSummary | null): ComponentProps<typeof ChatView> => {
    const id = chat.id
    // The room it was cloned from, for its handoff card's link; the chat another agent asked it from, for the asked bar's.
    const handoffFrom = chat.group?.handoff?.from.chatId ?? null
    const askedFrom = chat.asked?.from ?? null
    return {
      chat,
      agents,
      agent,
      state: chatViews[id] ?? emptyChatView,
      loadingOlder: loadingOlder[id] ?? false,
      onLoadOlder: (until) => loadOlder(id, until),
      pending: unqueued(unconfirmed(chatViews[id]?.items ?? [], pendingSends[id] ?? []), chat.tasks),
      draft: drafts[id] ?? '',
      sendError: sendErrors[id] ?? null,
      sendNotice: sendNotices[id] ?? null,
      onOpenSendNotice: () => {
        const notice = sendNotices[id]
        if (notice) openWorkflowRun(notice.workflowId, notice.runId)
      },
      onDismissSendNotice: () => setSendNotices((prev) => clearNotice(prev, id)),
      workflows: workflows.workflows,
      toolsOpen: toolsOpen[id] ?? false,
      claudeFound: claudePath !== null,
      codexInfo,
      offline: connection !== 'connected',
      onDraftChange: (text) => setDrafts((prev) => ({ ...prev, [id]: text })),
      onToolsOpenChange: (open) => setToolsOpen((prev) => ({ ...prev, [id]: open })),
      onViewMemory: fromNav(openAgentMemory),
      onOpenTodos: (itemId) => openTodosAt(id, itemId),
      onSend: (text, pick, workflowId) => void sendFromComposer(id, text, pick, undefined, workflowId),
      onContinue: () => void sendMessage(id, CONTINUE_TEXT, emptyDraftFiles, undefined, false),
      files: draftFiles[id] ?? emptyDraftFiles,
      onAddFiles: (files, origin) => addFiles(id, files, origin),
      onPickFiles: () => pickFiles(id),
      onRemoveFile: (fileKey) => removeDraftFile(id, fileKey),
      onStop: () => stopChat(id),
      onPause: () => pauseChat(id),
      onResume: () => resumeChat(id),
      // The side panel's list is of the open chat only; elsewhere (the To-dos page) the line has no count.
      runningAgents: shownChat?.id === id ? (dispatch.list ?? []).filter((s) => s.status === 'running').length : 0,
      onDismissError: () => setSendErrors(({ [id]: _d, ...rest }) => rest),
      onAnswerApproval: (requestId, reply, member) => answerApproval(id, requestId, reply, member),
      onSetRole: (role) => setGroupRole(id, role),
      replyTo: replies[id] ?? null,
      onReplyChange: (itemId) => setReply(id, itemId),
      onReact: (itemId, emoji) => reactTo(id, itemId, emoji),
      onExplain: (itemId, selected) => void sendMessage(id, explainText(selected), emptyDraftFiles, itemId, false),
      onEdit: (itemId, text, command) => editMessage(id, itemId, text, command),
      onResend: (itemId) => resendMessage(id, itemId),
      onSwitchVersion: (itemId, index) => switchVersion(id, itemId, index),
      onFork: (itemId) => forkFrom(id, itemId),
      onMarkUnread: (itemId) => markUnread(id, itemId),
      onExportReply: (itemId) => setExportTarget({ chat, item: itemId }),
      onDropTask: (taskId) => dropTask(id, taskId),
      onSendTask: (taskId) => sendTask(id, taskId),
      onCompact: (note, member) => void compactChat(id, note, member),
      onSetModel: (model) => void settled(id, api.chats.setModel(id, model)),
      onSetPermissionMode: (mode) => void settled(id, api.chats.setPermissionMode(id, mode)),
      onSetEffort: (effort) => void settled(id, api.chats.setEffort(id, effort)),
      onCancelResume: () => void settled(id, api.chats.cancelResume(id)),
      onContinueNow: () => void settled(id, api.chats.continueNow(id)),
      onOpenUsage: () => openSettings('usage', id),
      sideOpen: shownSideView !== null,
      onToggleSide: toggleSidePanel,
      processMark: processMark(processCounts[chat.id] ?? 0),
      onOpenProcesses: () => setSide('processes'),
      git: chat.id === openChatMeta?.id ? chatGit : null,
      changesOpen: shownSideView === 'changes' && shownChat?.id === chat.id,
      onToggleChanges: () => setSide(toggleChanges(shownSideView, liveInPanel)),
      sides: sideQuestions.list,
      onOpenSide: (sideId) => openSide(id, sideId),
      onCloneRoom: () => setCloneSource(chat),
      handoffSourceExists: handoffFrom !== null && chats.some((c) => c.id === handoffFrom),
      onOpenHandoffSource: () => {
        if (handoffFrom !== null) navigate(() => openChat(handoffFrom))
      },
      asks: askEnv,
      workflowStepName: chat.workflow
        ? workflows.workflows.find((x) => x.id === chat.workflow?.workflowId)?.steps.find((x) => x.id === chat.workflow?.stepId)?.name
        : undefined,
      // Sent like a typed message but not from the box: the draft stays as it is.
      onAllowed: (text) => void sendMessage(id, text, emptyDraftFiles, undefined, false),
      onPickReply: (text) => void sendMessage(id, text, emptyDraftFiles, undefined, false),
      onOpenWorkflowRun: () => {
        const link = chat.workflow
        if (link) openWorkflowRun(link.workflowId, link.runId)
      },
      askedSourceExists: askedFrom !== null && chats.some((c) => c.id === askedFrom),
      onOpenAskedSource: () => {
        if (askedFrom !== null) navigate(() => openChat(askedFrom))
      },
      archived: isArchived(chat),
      onUnarchive: () => archiveChat(id, false),
      showRequest: showRequest?.chatId === id ? showRequest : null,
      focusRequest: composerFocus
    }
  }

  // The hidden file dialog the "attach" buttons click, in the shell and in the island alike.
  const attachInput = (
    <input
      ref={pickInput}
      type="file"
      multiple
      hidden
      data-testid="attach-input"
      onChange={(e) => {
        const picked = Array.from(e.target.files ?? [])
        e.target.value = '' // so choosing the same file again still fires
        if (picked.length > 0) addFiles(pickKey.current, picked, 'pick')
      }}
    />
  )

  if (islandBridge) {
    const bridge = islandBridge
    const icons: IslandIcon[] = iconAgents.map((agent) => ({ agent, marks: islandMarks(chats, agent.name, approvals) }))
    const summary = popupAgent === null ? undefined : agents.find((a) => a.name === popupAgent)
    let popup: IslandPopup | null = null
    if (summary) {
      const key = `island-new:${summary.name}`
      const missing = cliMissing(engineOfAgent(summary), claudePath !== null, codexInfo)
      popup = {
        agent: summary,
        title: popupChat ? chatTitle(popupChat, agents) : 'New chat',
        chatId: popupChat?.id ?? null,
        recent: recentRows(chats, summary.name, approvals, popupChat?.id ?? null, Date.now(), agents),
        body: popupChat ? (
          <ChatView key={popupChat.id} {...chatViewProps(popupChat, summary)} compact />
        ) : (
          <IslandNewChat
            key={key}
            agent={summary}
            draft={drafts[key] ?? ''}
            folder={islandFolder?.agent === summary.name ? islandFolder.cwd : null}
            cliFound={missing === null}
            blockedReason={connection !== 'connected' ? OFFLINE_REASON : missing}
            askable={islandAskable}
            files={draftFiles[key] ?? emptyDraftFiles}
            onDraftChange={(text) => setDrafts((prev) => ({ ...prev, [key]: text }))}
            onSend={(text, pick) => void startIslandChat(summary.name, text, pick)}
            onAddFiles={(files, origin) => addFiles(key, files, origin)}
            onPickFiles={() => pickFiles(key)}
            onRemoveFile={(fileKey) => removeDraftFile(key, fileKey)}
          />
        )
      }
    }
    // A card's Show on desktop and a handoff's Open Desktop open the main window on the chat and the live view; a browser
    // handoff stays inline in its card, as in the main app.
    const show = (agent: string | undefined, point: { x: number; y: number } | null): void => {
      if (popupChat) bridge.openMain({ chatId: popupChat.id, live: { kind: 'desktop', agent: agent ?? popupChat.agentName, point } })
    }
    // An in-app link (a Zumi Bot reply's) opens the main window; the island's own address never changes.
    const openLink = (path: string): void => bridge.openMain(islandLinkTarget(path))
    const islandDesktop = {
      ...desktop,
      open: (target: DesktopTarget): void => {
        const { chatId, requestId } = target
        if (chatId === undefined) return
        bridge.openMain({
          chatId,
          live: requestId === undefined ? null : { kind: 'handoff', surface: 'desktop', target: { agent: target.agent, chatId, requestId } }
        })
      }
    }
    return (
      <AgentBrowserContext.Provider value={browser}>
        <AgentDesktopContext.Provider value={islandDesktop}>
          <DesktopShowContext.Provider value={show}>
            <AppLinkContext.Provider value={openLink}>
              <IslandView
                bridge={bridge}
                layout={islandLayout}
                icons={icons}
                openName={popupAgent}
                onIcon={clickIslandIcon}
                popup={popup}
                error={error}
                onDismissError={() => setError(null)}
                onNewChat={() => setView({ kind: 'empty' })}
                onPickChat={openChat}
                onClose={closeIsland}
                voice={
                  islandVoice ? (
                    <VoiceTalkView
                      agents={agents}
                      talk={voiceStatus?.talk ?? null}
                      available={talkShown}
                      autoStart
                      noTap
                      island
                      compact
                      onEnded={endIslandVoice}
                      onOpenChat={(id, agent) => {
                        // The request's chat opens in this popup; the shell keeps the window while the popup is up (no agent
                        // needs to be on the strip), and drops it when the popup closes.
                        endIslandVoice()
                        if (agent === null) return bridge.openMain({ chatId: id, live: null })
                        setIslandVoiceAgent(agent)
                        setIslandAgent(agent)
                        openChat(id)
                      }}
                    />
                  ) : null
                }
                onCloseVoice={endIslandVoice}
              />
              {attachInput}
            </AppLinkContext.Provider>
          </DesktopShowContext.Provider>
        </AgentDesktopContext.Provider>
      </AgentBrowserContext.Provider>
    )
  }

  return (
    <AgentBrowserContext.Provider value={browser}>
      <AgentDesktopContext.Provider value={desktop}>
        <DesktopShowContext.Provider value={showOnDesktop}>
          <TodoCardEnvContext.Provider value={todoCardEnv}>
            <div className="shell">
              <Rail
                active={railActive}
                open={navOpen}
                agentsPending={pendingElsewhere(approvals, null)}
                agentsUnread={anyUnread(listedChats(live, agents))}
                routinesWaiting={routinesWaiting}
                workflowsWaiting={workflowsWaiting}
                inboxBadge={countText(inboxWaitingCount)}
                inboxNew={anyNewMessage(inbox.data)}
                todosBadge={todosBadge}
                account={account}
                claudeFound={claudePath === undefined ? undefined : claudePath !== null}
                onAccountOpen={loadAccount}
                onHome={openHome}
                onAgents={() => switchMode('agents')}
                onRoutines={() => switchMode('routines')}
                onWorkflows={() => switchMode('workflows')}
                onInbox={openInbox}
                onTodos={openTodos}
                onArchived={openArchived}
                onSettings={() => openSettings('general', null, true)}
                onUsageDetails={() => openSettings('usage')}
                onPalette={() => setPalette(true)}
              />
              {settings !== null ? (
                <SettingsNav
                  open={navOpen}
                  onClose={closeNav}
                  section={shownSection(settings.section, hasIsland)}
                  sections={visibleSections(vps, hasIsland)}
                  backLabel={
                    inboxPage !== null
                      ? 'Back to inbox'
                      : todosPage !== null
                        ? 'Back to to-dos'
                        : archive
                          ? 'Back to archived'
                          : mode === 'routines'
                            ? 'Back to routines'
                            : mode === 'workflows'
                              ? 'Back to workflows'
                              : 'Back to chats'
                  }
                  pending={pendingElsewhere(approvals, null)}
                  unread={unreadElsewhere(listedChats(live, agents), null)}
                  onSection={fromNav((section) => navigate(() => setSettings({ section, usageChat: null })))}
                  onBack={() => navigate(closeSettings)}
                />
              ) : inboxPage !== null || todosPage !== null ? null : archive ? (
                <ArchivedNav
                  open={navOpen}
                  onClose={closeNav}
                  chats={chats}
                  agents={agents}
                  selectedChatId={view.kind === 'chat' ? view.chatId : null}
                  pending={pendingElsewhere(approvals, null)}
                  unread={unreadElsewhere(listedChats(live, agents), null)}
                  onBack={closeArchived}
                  onOpenChat={fromNav((id) => navigate(() => openChat(id)))}
                  onExportChat={fromNav((chat: ChatMeta) => setExportTarget({ chat, item: null }))}
                  onUnarchive={(ids) => {
                    for (const id of ids) archiveChat(id, false)
                  }}
                  onDeleteChats={(ids) => {
                    // One at a time, as single deletes go: each rewrites the chat index and the sidebar layout.
                    void (async () => {
                      for (const id of ids) await deleteChat(id)
                    })()
                  }}
                />
              ) : mode === 'routines' ? (
                <RoutinesSidebar
                  open={navOpen}
                  onClose={closeNav}
                  snapshot={routines}
                  agents={agents}
                  chats={chats}
                  now={now}
                  selectedId={routineView?.id ?? null}
                  onNew={fromNav(() => openRoutineGuarded(null))}
                  onOpen={fromNav(openRoutineGuarded)}
                />
              ) : mode === 'workflows' ? (
                <WorkflowsNav
                  open={navOpen}
                  onClose={closeNav}
                  snapshot={workflows}
                  now={now}
                  selectedId={workflowsRoute.workflowId}
                  selectedRunId={workflowsRoute.runId}
                  onNew={fromNav(newWorkflowGuarded)}
                  onOpen={fromNav((id: string) => openWorkflowGuarded(id))}
                  onOpenRun={fromNav((id: string, runId: string) => openWorkflowGuarded(id, runId))}
                  onError={report}
                />
              ) : (
                <Sidebar
                  open={navOpen}
                  onClose={closeNav}
                  agents={agents}
                  chats={live}
                  pendingByChat={approvals}
                  selectedChatId={view.kind === 'chat' ? view.chatId : null}
                  layout={sidebarLayout.layout}
                  onLayoutChange={sidebarLayout.save}
                  selectedAgentPath={
                    view.kind === 'editor'
                      ? view.filePath
                      : view.kind === 'start'
                        ? (agents.find((a) => a.name === newDraft.agentName)?.filePath ?? null)
                        : null
                  }
                  onNewAgent={fromNav(() => openEditorGuarded(null))}
                  onNewGroup={fromNav(() => navigate(newGroup))}
                  onOpenAgent={fromNav(openEditorGuarded)}
                  onPickAgent={fromNav((name) => navigate(() => void openAgentChat(name)))}
                  onNewChat={fromNav((name, folder) => navigate(() => void newChat(name, folder)))}
                  onDeleteAgent={(filePath) => void deleteAgent(filePath)}
                  onOpenChat={fromNav((id) => navigate(() => openChat(id)))}
                  onRenameChat={(id, title) => void renameChat(id, title)}
                  onCloneRoom={fromNav((chat: ChatMeta) => setCloneSource(chat))}
                  onDeleteChat={(id) => void deleteChat(id)}
                  onArchiveChat={(id) => archiveChat(id, true)}
                  onExportChat={fromNav((chat: ChatMeta) => setExportTarget({ chat, item: null }))}
                  allChats={chats}
                  connected={connection === 'connected'}
                  onOpenMessage={openMessage}
                />
              )}
              {navOpen && <div className="nav-backdrop" data-testid="nav-backdrop" onClick={closeNav} />}
              <main className="main" inert={navOpen || voicePage !== null}>
                <MobileBar
                  title={
                    settings
                      ? settingsLabel(shownSection(settings.section, hasIsland), api.desktop !== null)
                      : inboxPage !== null
                        ? 'Inbox'
                        : todosPage !== null
                          ? 'To-dos'
                          : archive && view.kind !== 'chat'
                            ? 'Archived'
                            : mode === 'routines' && !archive
                              ? (openRoutine?.name ?? (routineView?.id === null ? 'New routine' : 'Routines'))
                              : mode === 'workflows' && !archive
                                ? 'Workflows'
                                : barTitle(view.kind, openChatMeta, newDraft.mode === 'group', agents)
                  }
                  icon={settings || inboxPage !== null || todosPage !== null || (mode !== 'agents' && !archive) ? undefined : barIcon}
                  navOpen={navOpen}
                  pending={pendingElsewhere(approvals, openChatMeta?.id ?? null)}
                  unread={unreadElsewhere(listedChats(live, agents), openChatMeta?.id ?? null)}
                  onOpenNav={() => setNavOpen(true)}
                  toggleRef={navToggle}
                  onTalk={talkShown ? openVoice : undefined}
                  action={
                    narrowScreen && shownChat !== null && todosPage === null ? (
                      <>
                        <ProcessMark mark={processMark(processCounts[shownChat.id] ?? 0)} onOpen={() => setSide('processes')} />
                        <SidePanelToggle open={shownSideView !== null} onToggle={toggleSidePanel} />
                      </>
                    ) : undefined
                  }
                />
                {connectionLabel && <ConnectionBar label={connectionLabel} />}
                {error && (
                  <div className="error-strip" role="alert">
                    <span>{error}</span>
                    <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={() => setError(null)}>
                      ✕
                    </button>
                  </div>
                )}
                {claudePath === null && <ClaudeBanner onPathFound={setClaudePath} />}
                <div className="browser-workspace">
                  <div className="browser-chat">
                    {routeChat !== null ? null : settings ? (
                      <SettingsPage
                        section={shownSection(settings.section, hasIsland)}
                        vps={vps}
                        theme={theme}
                        onThemeChange={changeTheme}
                        accent={accent}
                        onAccentChange={changeAccent}
                        agents={agents}
                        usageChat={settings.usageChat}
                        usageChatTitle={friendlyText(chats.find((c) => c.id === settings.usageChat)?.title ?? '', agents) || null}
                        onClearUsageChat={() => setSettings({ section: 'usage', usageChat: null })}
                        onOpenChat={openRunChat}
                        onOpenItem={openItem}
                        chatTitle={(id) => {
                          const c = chats.find((x) => x.id === id)
                          return c ? friendlyText(c.title, agents) || c.title : null
                        }}
                        editorHandle={editorHandle}
                        onSection={(s) => openSettings(s)}
                      />
                    ) : inboxPage !== null ? (
                      <InboxPage
                        filter={inboxFilter}
                        onFilter={setInboxFilter}
                        waitingCount={inboxWaitingCount}
                        newCount={inboxNewCount}
                        waiting={
                          <InboxWaiting
                            entries={inboxEntries}
                            chats={chats}
                            agents={agents}
                            lines={inboxHolds.lines}
                            errors={inboxHolds.errors}
                            onAnswer={(e, a) => inboxHolds.hold(answeredLine(e, a, chats), sendInboxAnswer(e, a))}
                            onOpenChat={(chatId) => openFromInbox(chatId, null)}
                            onOpenRun={openWorkflowRun}
                            onOpenTodo={openTodoFromInbox}
                            onShowDesktop={(chatId, agent, point) => openFromInbox(chatId, { kind: 'desktop', chatId, agent, point })}
                            onOpenLive={(e) =>
                              openFromInbox(e.chatId, {
                                kind: 'handoff',
                                chatId: e.chatId,
                                surface: e.item.surface === 'desktop' ? 'desktop' : 'browser',
                                target: { agent: e.item.agent, chatId: e.item.handoff.chatId, requestId: e.item.handoff.id }
                              })
                            }
                          />
                        }
                        messages={
                          inbox.data === null || !workflows.loaded || inboxHeld.current === null ? (
                            <div className="file-note" data-testid="inbox-loading">
                              Loading…
                            </div>
                          ) : (
                            <InboxMessages
                              data={inbox.data}
                              runs={workflows}
                              heldSeenAt={inboxHeld.current}
                              focusId={inboxPage.messageId}
                              shown={inboxFilter !== 'waiting'}
                              onFocused={inboxFocused}
                              onChange={inbox.reload}
                              onOpenRun={openWorkflowRun}
                              now={now}
                            />
                          )
                        }
                      />
                    ) : todosPage !== null ? (
                      <TodoBoard
                        board={board.board}
                        agents={agents}
                        chats={chats}
                        approvals={approvals}
                        openId={todosPage.taskId}
                        onOpen={(taskId) => setTodosPage({ taskId })}
                        onRefresh={board.refresh}
                        now={now}
                        view={todosView}
                        onView={setTodosView}
                        filter={todosFilter}
                        onFilter={setTodosFilter}
                      />
                    ) : mode === 'routines' && !archive ? (
                      routineView && (routineView.id === null || openRoutine) ? (
                        <RoutineEditor
                          key={routineView.id ?? `new-${newRoutineKey}`}
                          routine={openRoutine ?? null}
                          agents={agents}
                          chats={chats}
                          sections={sidebarLayout.layout?.sections ?? NO_SECTIONS}
                          runs={openRoutine ? (routines.runs[openRoutine.id] ?? []) : []}
                          onOpenChat={openRunChat}
                          handle={editorHandle}
                          onSaved={routineSaved}
                          onDeleted={() => setRoutineView(null)}
                          onDuplicated={routineDuplicated}
                          onClose={() => setRoutineView(null)}
                          onError={report}
                        />
                      ) : (
                        <div className="routine-placeholder" data-testid="routine-placeholder">
                          Select a routine or add a new one.
                        </div>
                      )
                    ) : mode === 'workflows' && !archive ? (
                      <WorkflowsMode
                        route={workflowsRoute}
                        snapshot={workflows}
                        agents={agents}
                        chats={chats}
                        sections={sidebarLayout.layout?.sections ?? NO_SECTIONS}
                        handle={editorHandle}
                        onOpen={openWorkflowGuarded}
                        onNew={newWorkflowGuarded}
                        onOpenChat={openRunChat}
                        onError={report}
                      />
                    ) : view.kind === 'chat' && openChatMeta && (isGroup(openChatMeta) || openChatAgent) ? (
                      <DispatchLinkContext.Provider value={dispatchLink}>
                        {/* Here only: the island popup's chat view gets no Run, having no Processes panel to show a run in. */}
                        <RunLinkContext.Provider value={runLink}>
                          <ChatView key={openChatMeta.id} {...chatViewProps(openChatMeta, openChatAgent ?? null)} />
                        </RunLinkContext.Provider>
                      </DispatchLinkContext.Provider>
                    ) : view.kind === 'editor' ? (
                      <AgentEditor
                        key={editorKey}
                        filePath={view.filePath}
                        handle={editorHandle}
                        onSaved={editorSaved}
                        onDeleted={() => setView({ kind: 'empty' })}
                        onError={report}
                        focusMemory={view.focusMemory === true}
                        onOpenConnectors={() => openSettings('connectors')}
                      />
                    ) : archive ? (
                      <div className="routine-placeholder" data-testid="archived-placeholder">
                        Select an archived chat or room.
                      </div>
                    ) : (
                      <NewChatView
                        agents={agents}
                        chats={chats}
                        draft={newDraft}
                        intro={view.kind === 'start'}
                        claudeFound={claudePath !== null}
                        codexInfo={codexInfo}
                        offline={connection !== 'connected'}
                        onDraftChange={setNewDraft}
                        onChooseFolder={chooseNewChatFolder}
                        git={newGit !== null && newGit.cwd === newCwd ? newGit : null}
                        onToggleWorktree={toggleNewWorktree}
                        onSend={(text, pick) => void (newDraft.mode === 'group' ? startGroup(text, pick) : startChat(text, pick))}
                        files={draftFiles.new ?? emptyDraftFiles}
                        onAddFiles={(files, origin) => addFiles('new', files, origin)}
                        onPickFiles={() => pickFiles('new')}
                        onRemoveFile={(fileKey) => removeDraftFile('new', fileKey)}
                      />
                    )}
                  </div>
                  {/* One view in the side panel at a time: a browser or desktop is hidden while a chat view shows and comes back when it closes. */}
                  {shownSideView === 'menu' && shownChat ? (
                    <SidePanelMenu
                      chat={shownChat}
                      filesCount={filesCount(chatFiles.list)}
                      sidesCount={sideThreads(sideQuestions.list).length}
                      todosLeft={todosLeft}
                      offline={connection !== 'connected'}
                      agents={agents}
                      onOpenFiles={() => setSide('files')}
                      gitChanged={chatGit !== null && !chatGit.removed && shownChat.id === openChatMeta?.id ? chatGit.changed : null}
                      onOpenChanges={() => setSide('changes')}
                      onOpenSides={() => {
                        setSideFocus(null)
                        setSide('btw')
                      }}
                      onOpenTodos={() => {
                        setTodosFocus(null)
                        setSide('todos')
                      }}
                      dispatchBadge={dispatchBadge(dispatch.list ?? [])}
                      onOpenDispatch={() => {
                        setDispatchFocus(null)
                        setSide('dispatch')
                      }}
                      processesBadge={processesBadge(processes.list ?? [])}
                      onOpenProcesses={() => setSide('processes')}
                      onOpenBrowser={(agent) => openSideBrowser(agent, shownChat.id)}
                      onOpenDesktop={(agent) => openSideDesktop(agent, shownChat.id)}
                      onClose={closeSideView}
                    />
                  ) : shownSideView === 'btw' && shownChat ? (
                    <SidePanel
                      key={shownChat.id}
                      chat={shownChat}
                      chats={chats}
                      list={sideQuestions.list}
                      agents={agents}
                      focusId={sideFocus?.chatId === shownChat.id ? sideFocus.id : null}
                      focusRequest={sideFocus?.n ?? 0}
                      failed={sideQuestions.failed}
                      sourceExists={shownChat.asked ? chats.some((c) => c.id === shownChat.asked!.from) : true}
                      onRetry={sideQuestions.retry}
                      // The panel is already open and the composer's draft is not this text: unlike /btw, nothing else to do.
                      onAsk={async (text) => (await api.btw.ask(shownChat.id, text, crypto.randomUUID())).id}
                      onFollow={async (threadId, text) => {
                        await api.btw.follow(shownChat.id, threadId, text, crypto.randomUUID())
                      }}
                      onBack={() => setSide('menu')}
                      onClose={closeSideView}
                      onShowInChat={(id) => {
                        setShowRequest((r) => ({ chatId: shownChat.id, itemId: id, n: (r?.n ?? 0) + 1 }))
                        closeFilesIfNarrow()
                      }}
                      onStop={(id) => api.btw.stop(shownChat.id, id)}
                      onAgain={async (id) => {
                        await api.btw.again(shownChat.id, id)
                      }}
                      onOpenLink={(chatId, entryId) => askActions.current?.openSide(chatId, entryId)}
                    />
                  ) : shownSideView === 'dispatch' && shownChat ? (
                    <DispatchPanel
                      key={shownChat.id}
                      chat={shownChat}
                      list={dispatch.list}
                      failed={dispatch.failed}
                      onRetry={dispatch.retry}
                      connected={connection === 'connected'}
                      focusId={dispatchFocus?.chatId === shownChat.id ? dispatchFocus.id : null}
                      focusRequest={dispatchFocus?.n ?? 0}
                      waiting={dispatchWaiting}
                      onBack={() => setSide('menu')}
                      onClose={closeSideView}
                    />
                  ) : shownSideView === 'processes' && shownChat ? (
                    <ProcessesPanel
                      key={shownChat.id}
                      chat={shownChat}
                      list={processes.list}
                      failed={processes.failed}
                      onRetry={processes.retry}
                      connected={connection === 'connected'}
                      focusId={processFocus?.chatId === shownChat.id ? processFocus.id : null}
                      focusRequest={processFocus?.n ?? 0}
                      onBack={() => setSide('menu')}
                      onClose={closeSideView}
                    />
                  ) : shownSideView === 'todos' && shownChat ? (
                    <TodosPanel
                      key={shownChat.id}
                      chat={shownChat}
                      items={todos.items}
                      failed={todos.failed}
                      onRetry={todos.retry}
                      onRefresh={todos.refresh}
                      visibleIds={todoVisibleIds}
                      historyComplete={todoHistoryDone}
                      focusItemId={todosFocus?.chatId === shownChat.id ? todosFocus.itemId : null}
                      focusRequest={todosFocus?.n ?? 0}
                      onBack={() => setSide('menu')}
                      onClose={closeSideView}
                      onShowInChat={(itemId) => {
                        setShowRequest((r) => ({ chatId: shownChat.id, itemId, n: (r?.n ?? 0) + 1 }))
                        closeFilesIfNarrow()
                      }}
                    />
                  ) : shownSideView === 'files' && shownChat ? (
                    <FilesPanel
                      key={shownChat.id}
                      chat={shownChat}
                      list={chatFiles.list}
                      failed={chatFiles.failed}
                      onRetry={chatFiles.retry}
                      agents={agents}
                      onBack={() => setSide('menu')}
                      onClose={closeSideView}
                      onShow={(itemId) => {
                        setShowRequest((r) => ({ chatId: shownChat.id, itemId, n: (r?.n ?? 0) + 1 }))
                        closeFilesIfNarrow() // the sheet covers the chat
                      }}
                      onQuote={(block) => {
                        setDrafts((prev) => ({ ...prev, [shownChat.id]: withFileQuote(prev[shownChat.id] ?? '', block) }))
                        setComposerFocus((n) => n + 1)
                        closeFilesIfNarrow()
                      }}
                      onExplain={
                        canSend
                          ? (block, member) => {
                              void sendMessage(shownChat.id, explainFileText(block, member), emptyDraftFiles, undefined, false)
                              closeFilesIfNarrow()
                            }
                          : null
                      }
                    />
                  ) : shownSideView === 'changes' && shownChat ? (
                    <GitChangesPanel
                      key={shownChat.id}
                      chat={shownChat}
                      onBack={() => setSide('menu')}
                      onClose={closeSideView}
                      onLoaded={reloadChatGit}
                      onQuote={(block) => {
                        setDrafts((prev) => ({ ...prev, [shownChat.id]: withFileQuote(prev[shownChat.id] ?? '', block) }))
                        setComposerFocus((n) => n + 1)
                        closeFilesIfNarrow()
                      }}
                      onExplain={
                        canSend
                          ? (block, member) => {
                              void sendMessage(shownChat.id, explainFileText(block, member), emptyDraftFiles, undefined, false)
                              closeFilesIfNarrow()
                            }
                          : null
                      }
                      onSendReview={
                        canSend
                          ? (text) => {
                              void sendMessage(shownChat.id, text, emptyDraftFiles, undefined, false)
                              closeFilesIfNarrow() // the sheet covers the chat, and the review is now a message in it
                            }
                          : null
                      }
                    />
                  ) : shownSideView === 'browser' ? (
                    <BrowserPanel onBack={shownChat ? () => setSide('menu') : undefined} />
                  ) : shownSideView === 'desktop' ? (
                    <DesktopPanel onBack={shownChat ? () => setSide('menu') : undefined} approvalPending={desktopApproval} />
                  ) : null}
                </div>
                {narrowScreen && (
                  <TabBar
                    railActive={railActive}
                    agentsPending={pendingElsewhere(approvals, null)}
                    agentsUnread={anyUnread(listedChats(live, agents))}
                    routinesWaiting={routinesWaiting}
                    workflowsWaiting={workflowsWaiting}
                    inboxBadge={countText(inboxWaitingCount)}
                    inboxNew={anyNewMessage(inbox.data)}
                    todosBadge={todosBadge}
                    onGo={(tab) => (tab === 'inbox' ? openInbox() : tab === 'todos' ? openTodos() : switchMode(tab))}
                    onList={() => setNavOpen(true)}
                  />
                )}
              </main>
              {attachInput}
              <FolderPickerHost />
              {islandBridge === null && <UpdateHost onWhatsNew={() => openSettings('about')} />}
              {cloneSource && (
                <CloneRoomDialog
                  key={cloneSource.id}
                  chat={cloneSource}
                  takenTitles={chats.map((c) => c.title)}
                  memberCount={(chats.find((c) => c.id === cloneSource.id) ?? cloneSource).group?.members.length ?? 0}
                  canSummarize={canSummarizeView(chatViews[cloneSource.id])}
                  onClose={() => setCloneSource(null)}
                  onCreated={(meta) => roomCloned(cloneSource.id, meta)}
                />
              )}
              {exportTarget && (
                <ExportDialog
                  key={`${exportTarget.chat.id}:${exportTarget.item ?? ''}`}
                  chat={exportTarget.chat}
                  item={exportTarget.item}
                  onClose={() => setExportTarget(null)}
                />
              )}
              <ViewerHost />
              {palette && (
                <CommandPalette
                  sources={paletteSources}
                  connected={connection === 'connected'}
                  onPick={pickPalette}
                  onPickMessage={(hit, query) => {
                    setPalette(false)
                    openMessage(hit, query)
                  }}
                  onClose={() => setPalette(false)}
                />
              )}
              {voicePage !== null && (
                <div className="voice-page" role="dialog" aria-label="Voice conversation" data-testid="voice-page">
                  <VoiceTalkView
                    agents={agents}
                    talk={voiceStatus?.talk ?? null}
                    available={talkShown}
                    autoStart={voicePage.start}
                    onOpenChat={(id) => {
                      setVoicePage(null)
                      openChatFromNotification(id)
                    }}
                    onClose={() => setVoicePage(null)}
                  />
                </div>
              )}
              {pendingNav && (
                <ConfirmDialog
                  title="Unsaved changes"
                  message={`This ${settings !== null ? 'vault item' : mode === 'routines' ? 'routine' : mode === 'workflows' ? 'workflow' : 'agent'} has unsaved changes. Save them before leaving?`}
                  buttons={[
                    { label: 'Save', value: 'save' },
                    { label: 'Discard', value: 'discard', danger: true },
                    { label: 'Cancel', value: 'cancel' }
                  ]}
                  initialFocus="cancel"
                  onResolve={(choice) => void resolveNavigation(choice)}
                />
              )}
            </div>
          </TodoCardEnvContext.Provider>
        </DesktopShowContext.Provider>
      </AgentDesktopContext.Provider>
    </AgentBrowserContext.Provider>
  )
}
