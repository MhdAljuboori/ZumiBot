// The catalog of claude.ai connectors (route A: the Claude Code CLI already loads them) and the pure rules around it, shared by the server and the UI: no `node:` imports.
import { assertNever, type Engine } from './engine'
import { toolPrefix } from './extensions'
import type { ServerStatus } from './extensions'

export const CONNECTOR_IDS = ['gmail', 'google-calendar', 'google-drive', 'notion', 'github', 'slack', 'linear'] as const
export type ConnectorId = (typeof CONNECTOR_IDS)[number]

export interface Connector {
  readonly id: ConnectorId
  readonly name: string
  readonly blurb: string
  /** `deniedMcpServers` serverUrl patterns; `*` is any run of characters. */
  readonly urls: readonly string[]
  /** claude.ai display names. */
  readonly names: readonly string[]
  /** What Connect / Reconnect / Manage opens. */
  readonly connectUrl: string
  /** GitHub only: the URL to add as a custom connector. */
  readonly customUrl: string | null
  readonly read: readonly string[]
  readonly write: readonly string[]
}

// Frozen all the way down, so nothing can add an entry (a deny pattern or a name) at runtime.
function deepFreeze<T extends object>(v: T): T {
  for (const x of Object.values(v)) if (x !== null && typeof x === 'object') deepFreeze(x)
  return Object.freeze(v)
}

// GitHub's lists come from the Tools section of github/github-mcp-server's README (main at 67d4dc4, fetched 2026-11-17), with the remote-only
// Copilot Spaces and support-docs tools. Read = get_*, list_*, search_* and the named exceptions; every other tool is a write.
export const CONNECTORS: readonly Connector[] = deepFreeze([
  {
    id: 'gmail',
    name: 'Gmail',
    blurb: 'Search, read and draft email in your Gmail.',
    urls: ['https://gmailmcp.googleapis.com/*', 'https://gmail.mcp.claude.com/*'],
    names: ['claude.ai Gmail'],
    connectUrl: 'https://claude.ai/directory/2701e52f-b826-4aaf-8b25-11f2a97c98b0',
    customUrl: null,
    read: [
      'search_threads',
      'get_thread',
      'get_message',
      'list_labels',
      'list_filters',
      'list_drafts',
      'get_draft',
      'download_gmail_attachment'
    ],
    write: [
      'send_message',
      'reply',
      'forward',
      'create_draft',
      'update_draft',
      'delete_draft',
      'create_filter',
      'create_label',
      'update_label',
      'delete_label',
      'label_message',
      'label_thread',
      'unlabel_message',
      'unlabel_thread',
      'update_message_labels',
      'apply_sensitive_message_label',
      'apply_sensitive_thread_label',
      'mark_message_spam',
      'mark_thread_spam',
      'unmark_message_spam',
      'unmark_thread_spam',
      'trash_message',
      'trash_thread',
      'untrash_message',
      'untrash_thread'
    ]
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    blurb: 'Read your calendars, find free time and manage events.',
    urls: ['https://calendarmcp.googleapis.com/*', 'https://gcal.mcp.claude.com/*'],
    names: ['claude.ai Google Calendar'],
    connectUrl: 'https://claude.ai/directory/2a838eaa-f7b4-4bc2-bd47-c326f3c813c5',
    customUrl: null,
    read: ['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'],
    write: ['create_event', 'update_event', 'delete_event', 'respond_to_event']
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    blurb: 'Search and read files in your Google Drive.',
    urls: ['https://drivemcp.googleapis.com/*'],
    names: ['claude.ai Google Drive'],
    connectUrl: 'https://claude.ai/directory/b89f7865-a755-4f86-8062-c3bd651740ce',
    customUrl: null,
    read: [
      'search_files',
      'list_recent_files',
      'read_file_content',
      'download_file_content',
      'get_file_metadata',
      'get_file_permissions',
      'list_file_revisions',
      'list_shared_drives',
      'get_shared_drive_metadata'
    ],
    write: ['create_file', 'update_file', 'copy_file', 'share_file', 'trash_file']
  },
  {
    id: 'notion',
    name: 'Notion',
    blurb: 'Search, read and edit pages in your Notion workspace.',
    urls: ['https://mcp.notion.com/*'],
    names: ['claude.ai Notion'],
    connectUrl: 'https://claude.ai/directory/69f3a300-cc60-48c4-b237-dfac56530dbf',
    customUrl: null,
    read: [
      'notion-search',
      'notion-fetch',
      'notion-page-view',
      'notion-get-self',
      'notion-get-users',
      'notion-get-teams',
      'notion-get-groups',
      'notion-get-comments',
      'notion-query-data-sources',
      'notion-query-multiple-data-sources',
      'notion-query-meeting-notes',
      'notion-list-recent-pages',
      'notion-list-favorite-pages',
      'notion-list-private-pages',
      'notion-list-shared-pages',
      'notion-list-page-backlinks',
      'notion-view-version',
      'notion-get-version-changes',
      'notion-download-attachment',
      'notion-get-file-download-urls',
      'notion-get-suggested-edit',
      'notion-get-async-task',
      'notion-memory-search',
      'notion-calendar-list-events',
      'notion-calendar-list-calendars',
      'notion-calendar-list-calendar-resources',
      'notion-calendar-list-contacts',
      'notion-calendar-list-coworkers-events',
      'notion-ai-search',
      'notion-connector-search',
      'notion-get-tool-access',
      'notion-get-enabled-skills',
      'notion-download-skill',
      'notion-get-setup-guide',
      'notion-get-sidebar-tabs',
      'notion-search-agents',
      'notion-query-sessions',
      'notion-search-sessions',
      'notion-get-session-status',
      'notion-list-session-events',
      'notion-read-session-event',
      'notion-wait-session'
    ],
    write: [
      'notion-calendar-cancel-events',
      'notion-calendar-create-events',
      'notion-calendar-update-events',
      'notion-complete-mcp-setup',
      'notion-convert-page-to-skill',
      'notion-convert-to-meetings-database',
      'notion-create-attachment',
      'notion-create-comment',
      'notion-create-database',
      'notion-create-file-upload',
      'notion-create-folder',
      'notion-create-meeting-note',
      'notion-create-pages',
      'notion-create-suggested-edit',
      'notion-create-view',
      'notion-delete-comment',
      'notion-delete-databases',
      'notion-delete-pages',
      'notion-duplicate-page',
      'notion-link-meeting-note-to-calendar-event',
      'notion-move-pages',
      'notion-resolve-suggested-edit',
      'notion-restore-pages',
      'notion-restore-version',
      'notion-send-message-to-session',
      'notion-set-comment-reaction',
      'notion-set-discussion-resolved',
      'notion-spawn-session',
      'notion-stop-session',
      'notion-update-comment',
      'notion-update-data-source',
      'notion-update-folder',
      'notion-update-page',
      'notion-update-page-favorites',
      'notion-update-sidebar-tabs',
      'notion-update-skill-settings',
      'notion-update-view',
      'notion-upload-skill'
    ]
  },
  {
    id: 'github',
    name: 'GitHub',
    blurb: 'Read and change repositories, issues and pull requests on GitHub.',
    urls: ['https://api.githubcopilot.com/mcp*'],
    names: [],
    connectUrl: 'https://claude.ai/customize/connectors',
    customUrl: 'https://api.githubcopilot.com/mcp/',
    read: [
      'actions_get',
      'actions_list',
      'custom_properties_read',
      'get_code_quality_finding',
      'get_code_scanning_alert',
      'get_commit',
      'get_copilot_space',
      'get_dependabot_alert',
      'get_discussion',
      'get_discussion_comments',
      'get_file_contents',
      'get_gist',
      'get_global_security_advisory',
      'get_job_logs',
      'get_label',
      'get_latest_release',
      'get_me',
      'get_notification_details',
      'get_release_by_tag',
      'get_repository_tree',
      'get_secret_scanning_alert',
      'get_tag',
      'get_team_members',
      'get_teams',
      'github_support_docs_search',
      'issue_read',
      'list_branches',
      'list_code_scanning_alerts',
      'list_commits',
      'list_copilot_spaces',
      'list_dependabot_alerts',
      'list_discussion_categories',
      'list_discussions',
      'list_gists',
      'list_global_security_advisories',
      'list_issue_fields',
      'list_issues',
      'list_issue_types',
      'list_label',
      'list_notifications',
      'list_org_repository_security_advisories',
      'list_pull_requests',
      'list_releases',
      'list_repository_collaborators',
      'list_repository_security_advisories',
      'list_secret_scanning_alerts',
      'list_starred_repositories',
      'list_tags',
      'projects_get',
      'projects_list',
      'pull_request_read',
      'repository_ruleset_read',
      'search_code',
      'search_commits',
      'search_issues',
      'search_orgs',
      'search_pull_requests',
      'search_repositories',
      'search_users'
    ],
    write: [
      'actions_run_trigger',
      'add_comment_to_pending_review',
      'add_issue_comment',
      'add_reply_to_pull_request_comment',
      'assign_copilot_to_issue',
      'assign_copilot_to_issue_with_intent',
      'create_branch',
      'create_gist',
      'create_or_update_file',
      'create_pull_request',
      'create_pull_request_with_copilot',
      'create_repository',
      'create_repository_ruleset',
      'custom_properties_write',
      'delete_file',
      'delete_repository',
      'discussion_comment_write',
      'dismiss_notification',
      'fork_repository',
      'issue_write',
      'label_write',
      'manage_notification_subscription',
      'manage_repository_notification_subscription',
      'mark_all_notifications_read',
      'merge_pull_request',
      'projects_write',
      'pull_request_review_write',
      'push_files',
      'request_copilot_review',
      'star_repository',
      'sub_issue_write',
      'ui_get',
      'unstar_repository',
      'update_gist',
      'update_issue_comment',
      'update_pull_request',
      'update_pull_request_branch'
    ]
  },
  {
    id: 'slack',
    name: 'Slack',
    blurb: 'Search, read and send messages in your Slack workspace.',
    urls: ['https://mcp.slack.com/*'],
    names: ['claude.ai Slack'],
    connectUrl: 'https://claude.ai/directory/597f662f-36de-437e-836e-5a81013cbfbe',
    customUrl: null,
    read: [
      'slack_read_channel',
      'slack_read_thread',
      'slack_read_canvas',
      'slack_read_user_profile',
      'slack_search_channels',
      'slack_search_users',
      'slack_search_public',
      'slack_search_public_and_private'
    ],
    write: [
      'slack_send_message',
      'slack_send_message_draft',
      'slack_schedule_message',
      'slack_create_canvas',
      'slack_update_canvas',
      'slack_get_file_upload_url',
      'slack_complete_file_upload'
    ]
  },
  {
    id: 'linear',
    name: 'Linear',
    blurb: 'Read and update issues and projects in Linear.',
    urls: ['https://mcp.linear.app/*'],
    names: ['claude.ai Linear'],
    connectUrl: 'https://claude.ai/directory/fa50c30c-9f62-4f94-b851-217868185db6',
    customUrl: null,
    read: [
      'list_issues',
      'list_my_issues',
      'get_issue',
      'list_issue_statuses',
      'get_issue_status',
      'list_issue_labels',
      'list_comments',
      'list_cycles',
      'list_documents',
      'get_document',
      'list_projects',
      'get_project',
      'list_teams',
      'get_team',
      'list_users',
      'get_user',
      'search_documentation'
    ],
    write: ['create_issue', 'update_issue', 'create_comment', 'create_project', 'update_project']
  }
] satisfies Connector[])

export function isConnectorId(v: unknown): v is ConnectorId {
  return typeof v === 'string' && (CONNECTOR_IDS as readonly string[]).includes(v)
}

export function connectorById(id: ConnectorId): Connector {
  return CONNECTORS.find((c) => c.id === id)!
}

/** The whole URL must match; every character is literal except `*` (any run of characters). */
export function urlMatches(pattern: string, url: string): boolean {
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}$`, 's').test(url)
}

/** The catalog entry a server belongs to: its URL first, else its claude.ai name (a trailing ` (N)` removed). A missing or non-https URL skips the URL step. */
export function connectorOf(url: string | null, name: string): ConnectorId | null {
  if (url !== null && url.startsWith('https:')) {
    for (const c of CONNECTORS) if (c.urls.some((p) => urlMatches(p, url))) return c.id
  }
  const bare = name.replace(/ \(\d+\)$/, '')
  for (const c of CONNECTORS) if (c.names.includes(bare)) return c.id
  return null
}

export type ConnectorState = 'connected' | 'needs-attention' | 'not-connected' | 'off-in-claude-code' | 'unknown'

// Structural rows: `LoadoutServer` satisfies both once it has its `connector` field.
export interface ConnectorRow {
  connector: ConnectorId | null
  status: ServerStatus
  tools: string[]
}

const STATE_RANK: Record<Exclude<ConnectorState, 'unknown' | 'not-connected'>, number> = {
  connected: 3,
  'needs-attention': 2,
  'off-in-claude-code': 1
}

function stateOf(status: ServerStatus): keyof typeof STATE_RANK {
  if (status === 'connected') return 'connected'
  if (status === 'disabled') return 'off-in-claude-code'
  return 'needs-attention'
}

/** The best state among the connector's rows: connected, then needs-attention, then off-in-claude-code; no row is not-connected. */
export function connectorState(
  servers: ReadonlyArray<Pick<ConnectorRow, 'connector' | 'status'>>,
  id: ConnectorId
): Exclude<ConnectorState, 'unknown'> {
  let best: keyof typeof STATE_RANK | null = null
  for (const s of servers) {
    if (s.connector !== id) continue
    const st = stateOf(s.status)
    if (best === null || STATE_RANK[st] > STATE_RANK[best]) best = st
  }
  return best ?? 'not-connected'
}

/** The union of the matching rows' tools, in first-seen order. */
export function connectorTools(servers: ReadonlyArray<Pick<ConnectorRow, 'connector' | 'tools'>>, id: ConnectorId): string[] {
  const seen = new Set<string>()
  for (const s of servers) if (s.connector === id) for (const t of s.tools) seen.add(t)
  return [...seen]
}

/** Only a listed read tool is a read: a tool the catalog does not know is treated as a write. */
export function isReadTool(id: ConnectorId, tool: string): boolean {
  return connectorById(id).read.includes(tool)
}

export function unknownTools(id: ConnectorId, tools: readonly string[]): string[] {
  const c = connectorById(id)
  return tools.filter((t) => !c.read.includes(t) && !c.write.includes(t))
}

/** The run's deny entries for connectors that are not on: the URL patterns are the real guard (a name can change), the names and tool prefixes the belt. */
export function denyEntries(off: readonly ConnectorId[]): {
  deniedMcpServers: Array<{ serverUrl: string } | { serverName: string }>
  disallowedTools: string[]
} {
  const deniedMcpServers: Array<{ serverUrl: string } | { serverName: string }> = []
  const disallowed = new Set<string>()
  for (const c of CONNECTORS) {
    if (!off.includes(c.id)) continue
    for (const u of c.urls) deniedMcpServers.push({ serverUrl: u })
    for (const n of c.names) {
      deniedMcpServers.push({ serverName: n })
      disallowed.add(toolPrefix(n))
    }
  }
  return { deniedMcpServers, disallowedTools: [...disallowed] }
}

export interface ConnectorServerName {
  name: string
  connector: ConnectorId
}

/** Tool prefix (`mcp__<name as the CLI normalizes it>`) → catalog id, for every catalog name plus each given server. A fresh object each call. */
export function connectorPrefixes(servers: Iterable<ConnectorServerName>): Record<string, ConnectorId> {
  const out: Record<string, ConnectorId> = {}
  for (const c of CONNECTORS) for (const n of c.names) out[toolPrefix(n)] = c.id
  for (const s of servers) out[toolPrefix(s.name)] = s.connector
  return out
}

/** The connector call a tool name is: the LONGEST prefix p with the name starting `${p}__` and a non-empty rest (`Gmail (2)` is a prefix of `Gmail`'s tools plus `__2_`), else null. */
export function connectorCallOf(
  toolName: string,
  prefixes: Readonly<Record<string, ConnectorId>>
): { id: ConnectorId; tool: string } | null {
  let best: string | null = null
  for (const p of Object.keys(prefixes)) {
    if (toolName.length > p.length + 2 && toolName.startsWith(`${p}__`) && (best === null || p.length > best.length)) best = p
  }
  return best === null ? null : { id: prefixes[best]!, tool: toolName.slice(best.length + 2) }
}

/** `${p}__*` for every prefix p mapped to an id in `on`; sorted, no duplicates. */
export function askRules(on: readonly ConnectorId[], prefixes: Readonly<Record<string, ConnectorId>>): string[] {
  const rules = new Set<string>()
  for (const [p, id] of Object.entries(prefixes)) if (on.includes(id)) rules.add(`${p}__*`)
  return [...rules].sort()
}

/** The fixed refusal of a write in an unattended run. */
export function unattendedRefusal(id: ConnectorId, tool: string): string {
  return `${connectorById(id).name} ${tool} changes data outside this machine. Runs started by a routine or workflow may only read; ask the user to do this in a chat.`
}

/** The fixed denial of a call to a connector that is off for the agent (the CLI already denies it; this backs that up). */
export function offRefusal(id: ConnectorId): string {
  return `${connectorById(id).name} is not turned on for this agent on the Connectors page.`
}

// ---- What the page and the RPC carry ----

export interface ConnectorCardView {
  id: ConnectorId
  state: ConnectorState
  tools: string[]
  unknownTools: string[]
  /** Names of the agents this connector is on for. */
  on: string[]
  /** Whether a change's card offers Allow for this chat / Allow always. */
  remember: boolean
}

export interface ConnectorAgent {
  name: string
  engine: Engine
}

export type ConnectorMigration = 'running' | 'kept' | 'failed'

export interface ConnectorsView {
  /** The env var that makes the CLI skip claude.ai connectors, by name only. */
  keyVar: string | null
  migration: ConnectorMigration
  error: string | null
  agents: ConnectorAgent[]
  connectors: ConnectorCardView[]
  at: number
}

export const CONNECTOR_TEXT = {
  intro:
    'Services your agents can use, connected through your claude.ai account. Each one is off for every agent until you turn it on here.',
  machines:
    'Connections belong to your claude.ai account, so every machine signed in to it sees the same ones. The switches sync with the rest of ZumiBot.',
  keyVar: (v: string): string =>
    `Claude Code is using the key in ${v}, so it loads no claude.ai connectors. To use them, sign in with claude /login on a Claude subscription and remove ${v} from this server's environment.`,
  running: 'Reading your connectors for the first time. Switches open in a moment.',
  migrationFailed:
    'Claude Code could not list your connectors when this page was first set up, so every connector starts off for every agent.',
  probeFailed: 'Claude Code could not list your connectors just now. Try again in a moment.',
  labels: {
    connected: 'Connected',
    'needs-attention': 'Needs attention',
    'not-connected': 'Not connected',
    'off-in-claude-code': 'Turned off in Claude Code',
    unknown: 'Not checked'
  } satisfies Record<ConnectorState, string>,
  needsAttention: 'Reconnect it on claude.ai. If every connector shows this, run claude /login on this machine.',
  notConnected: 'Connect it on claude.ai, then come back here.',
  offInClaudeCode: "It is connected but turned off in Claude Code's own settings.",
  github: 'Add this URL as a custom connector on claude.ai (Customize › Connectors › Add custom connector).',
  unknown: (list: readonly string[]): string => `Tools ZumiBot does not know yet: ${list.join(', ')}.`,
  codex: 'Codex agents cannot use claude.ai connectors.',
  acp: 'ACP agents cannot use claude.ai connectors.',
  agui: 'Remote agents cannot use claude.ai connectors.',
  zumiBot: 'Zumi Bot never uses connectors.',
  cacheNote: 'Turning a connector on or off for an agent makes its next message re-read its whole context once.',
  onFor: (names: readonly string[]): string => (names.length === 0 ? 'Off for every agent' : `On for ${names.join(', ')}`),
  notSwitchable: 'Only a Claude agent other than Zumi Bot can have a connector.',
  settingUp: 'Connectors are still being set up. Try again in a moment.',
  toClaudeCode: 'Servers you set up yourself are on Settings › Claude Code.',
  toConnectors: 'claude.ai connectors (Gmail, Slack, Notion and others) are turned on per agent in Settings › Connectors.',
  agentRow: 'Set on the Connectors page',
  cardAccount: 'As connected on claude.ai',
  guardNote:
    'Agents read with a connector without asking. Anything that sends, changes or deletes asks you first, and runs started by a routine or workflow may only read.',
  rememberLabel: 'Remember approvals',
  rememberNote: 'Off: every change asks you each time. On: its card also offers Allow for this chat and Allow always for this agent.'
} as const

/** The note for each engine that gets no claude.ai connectors (only Claude's CLI loads them), or null for Claude. */
export function connectorEngineNote(engine: Engine): string | null {
  switch (engine) {
    case 'claude':
      return null
    case 'codex':
      return CONNECTOR_TEXT.codex
    case 'acp':
      return CONNECTOR_TEXT.acp
    case 'ag-ui':
      return CONNECTOR_TEXT.agui
    default:
      return assertNever(engine)
  }
}
