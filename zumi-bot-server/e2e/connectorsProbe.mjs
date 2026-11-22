// Probe of the real claude CLI for Settings › Connectors (docs/architecture/connectors.md, "Phase 1"). The page and the run's deny
// rules rest on how the CLI lists and denies the user's claude.ai connectors, which nobody documents for this account:
//  a) a plain run lists `claude.ai ...` servers; each one's name, status, URL host and catalog id are printed (this settles which
//     Gmail and Calendar hosts the account gets), and a server the catalog knows by name must also match a catalog URL pattern,
//     since the deny by URL is the real guard (a name can change);
//  b) for EACH connected catalog connector, a run with `deniedMcpServers: [{serverUrl: <its catalog pattern>}]` no longer lists it;
//  c) the same with `{serverName: <its name>}` (not GitHub: the catalog has no name for it);
//  d) the tool names the CLI lists for each connected connector are the bare names the catalog lists (the belt and the page's
//     read/write lists key on them): not all of them unknown to the catalog;
//  e) one run whose --settings is what a main run merges (every catalog connector denied by URL and name, plus a permissions.deny
//     file rule in the vault guard's form) lists no catalog connector AND still applies the deny rule: a CLI that rejected a
//     `serverUrl` entry could drop the whole settings object, the vault guard with it.
//  f) the ask check (phase 3, "writes ask"): one real Haiku run in auto mode with `--settings` {permissions: {ask: [<prefix>__*],
//     allow: [<prefix>__<read tool>]}} and a prompt to call that one read tool of a connected catalog connector (Gmail
//     list_labels, else Calendar list_calendars, Slack slack_search_channels, Drive list_recent_files, else any listed read tool). The
//     CLI must send `can_use_tool` for it (PASS; the probe answers DENY, so nothing is read); a tool result that is not an error with no
//     `can_use_tool` first is FAILED (the ask rule did not hold in auto mode, or an allow rule beat it: connector writes would run
//     unasked); anything else, an error result included (the CLI refused it itself), after one retry, is INCONCLUSIVE. check e's merged settings also carry the ask rules of every connected connector.
// Checks a to e run no model, so no quota; f is one short Haiku run. The runs use the user's OWN HOME and login (the connectors belong
// to the claude.ai account, so a throwaway HOME would list none), and the CLI itself may touch ~/.claude.json, as in any run; the temp
// folder holds nothing else.
// Never run by `npm run e2e`: it reaches the real claude.ai account, so it is run only when the user says so
// (`npm run e2e:connectors-probe`). Never prints a token, a tool payload or a URL beyond its host.
// Run directly: node zumi-bot-server/e2e/connectorsProbe.mjs [--strict]
// Prints PASS / FAILED / INCONCLUSIVE per check. Exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE with --strict; without it (the default,
// --soft) INCONCLUSIVE exits 0 with a loud warning. INCONCLUSIVE: no claude.ai connector is listed or connected (not signed in with a
// subscription, a key variable is set, nothing connected), a run did not answer after one retry, the effective settings could not be read,
// or no connected connector lists a read tool for check f.
// ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the claude binary; the unit tests point it at a fake.
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DENY_RULE, exitCodeFor, killRunning, listings, mergeSettings, toolPrefix } from './extensionsProbe.mjs'

/** The app's catalog (shared/src/connectors.ts): id, deny URL patterns, claude.ai names and the bare tool names (the first `reads` are the read tools, then the writes), byte for byte; a unit test pins the two together. */
export const CATALOG = [
  {
    id: 'gmail',
    reads: 8,
    urls: ['https://gmailmcp.googleapis.com/*', 'https://gmail.mcp.claude.com/*'],
    names: ['claude.ai Gmail'],
    tools: [
      'search_threads',
      'get_thread',
      'get_message',
      'list_labels',
      'list_filters',
      'list_drafts',
      'get_draft',
      'download_gmail_attachment',
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
    reads: 5,
    urls: ['https://calendarmcp.googleapis.com/*', 'https://gcal.mcp.claude.com/*'],
    names: ['claude.ai Google Calendar'],
    tools: [
      'list_calendars',
      'list_events',
      'get_event',
      'search_events',
      'suggest_time',
      'create_event',
      'update_event',
      'delete_event',
      'respond_to_event'
    ]
  },
  {
    id: 'google-drive',
    reads: 9,
    urls: ['https://drivemcp.googleapis.com/*'],
    names: ['claude.ai Google Drive'],
    tools: [
      'search_files',
      'list_recent_files',
      'read_file_content',
      'download_file_content',
      'get_file_metadata',
      'get_file_permissions',
      'list_file_revisions',
      'list_shared_drives',
      'get_shared_drive_metadata',
      'create_file',
      'update_file',
      'copy_file',
      'share_file',
      'trash_file'
    ]
  },
  {
    id: 'notion',
    reads: 42,
    urls: ['https://mcp.notion.com/*'],
    names: ['claude.ai Notion'],
    tools: [
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
      'notion-wait-session',
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
    reads: 59,
    urls: ['https://api.githubcopilot.com/mcp*'],
    names: [],
    tools: [
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
      'search_users',
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
    reads: 8,
    urls: ['https://mcp.slack.com/*'],
    names: ['claude.ai Slack'],
    tools: [
      'slack_read_channel',
      'slack_read_thread',
      'slack_read_canvas',
      'slack_read_user_profile',
      'slack_search_channels',
      'slack_search_users',
      'slack_search_public',
      'slack_search_public_and_private',
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
    reads: 17,
    urls: ['https://mcp.linear.app/*'],
    names: ['claude.ai Linear'],
    tools: [
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
      'search_documentation',
      'create_issue',
      'update_issue',
      'create_comment',
      'create_project',
      'update_project'
    ]
  }
]

/** The app's urlMatches: the whole URL must match; every character is literal except `*` (any run of characters). */
export const urlMatches = (pattern, url) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    's'
  ).test(url)

/** The app's connectorOf: a catalog entry by URL first, else by claude.ai name (a trailing ` (N)` removed). */
export function connectorOf(url, name) {
  if (typeof url === 'string' && url.startsWith('https:')) for (const c of CATALOG) if (c.urls.some((p) => urlMatches(p, url))) return c.id
  const bare = name.replace(/ \(\d+\)$/, '')
  for (const c of CATALOG) if (c.names.includes(bare)) return c.id
  return null
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const arr = Array.isArray
const binary = () => process.env.ZUMIBOT_PROBE_CLAUDE || process.env.CLAUDE_BIN || 'claude'
const KEY_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/** The servers of a run's mcp_status answer, as {name, status, url, id, tools}; `url` is never printed beyond its host, `tools` only counted. */
export function rowsOf(answers) {
  const list = arr(obj(answers?.mcp)?.mcpServers) ? answers.mcp.mcpServers : []
  return list.flatMap((s) => {
    const o = obj(s)
    if (!o || typeof o.name !== 'string') return []
    const url = typeof obj(o.config)?.url === 'string' ? o.config.url : null
    const tools = arr(o.tools)
      ? o.tools.flatMap((t) => (typeof t === 'string' ? [t] : typeof obj(t)?.name === 'string' ? [t.name] : []))
      : []
    return [{ name: o.name, status: typeof o.status === 'string' ? o.status : '?', url, id: connectorOf(url, o.name), tools }]
  })
}

/** What the run could not tell: 'error' (the CLI answered with an error), another string (no answer), or null when mcp_status was answered. */
const mcpProblem = (answers) => (!answers ? 'no run' : (answers.errors?.mcp ?? null))

/** Each connected catalog connector with a URL, once per catalog id (its first row): the ones the deny runs aim at, with the catalog pattern that matches it. */
export function targetsOf(rows) {
  const out = []
  for (const r of rows) {
    if (r.status !== 'connected' || r.id === null || r.url === null || out.some((t) => t.id === r.id)) continue
    const pattern = CATALOG.find((c) => c.id === r.id)?.urls.find((p) => urlMatches(p, r.url))
    if (pattern) out.push({ name: r.name, id: r.id, pattern, tools: r.tools, hasName: CATALOG.find((c) => c.id === r.id).names.length > 0 })
  }
  return out
}

/** The app's unknownTools: the listed tools the catalog knows neither as read nor as write. */
export const unknownTools = (id, tools) => {
  const known = CATALOG.find((c) => c.id === id)?.tools ?? []
  return tools.filter((t) => !known.includes(t))
}

/** The app's denyEntries for every catalog connector: a serverUrl per pattern and a serverName per known name; a unit test pins the two together. */
export const denyAllEntries = () =>
  CATALOG.flatMap((c) => [...c.urls.map((serverUrl) => ({ serverUrl })), ...c.names.map((serverName) => ({ serverName }))])

/** What a main run's --settings holds that this probe cares about: the connector deny and the connected connectors' ask rules, merged with the vault guard's file rule, as ONE object. */
export const mergedSettings = (askPrefixes = []) =>
  mergeSettings(
    { deniedMcpServers: denyAllEntries(), ...(askPrefixes.length ? { permissions: { ask: askPrefixes.map((p) => `${p}__*`) } } : {}) },
    { permissions: { deny: [DENY_RULE] } }
  )

/** The tool prefixes of every connected catalog connector's server, once each, in the CLI's listing order. */
export const connectedPrefixes = (rows) => [
  ...new Set(rows.filter((r) => r.status === 'connected' && r.id !== null).map((r) => toolPrefix(r.name)))
]

// Preferred ask targets (a read tool that needs no arguments), in order; any other listed read tool is the fallback.
const ASK_PREFERRED = [
  ['gmail', 'list_labels'],
  ['google-calendar', 'list_calendars'],
  ['slack', 'slack_search_channels'],
  ['google-drive', 'list_recent_files']
]
const readsOf = (id) => {
  const c = CATALOG.find((x) => x.id === id)
  return c ? c.tools.slice(0, c.reads) : []
}

/** The connected catalog server and read tool the ask check calls, or null: the first preferred pair the CLI lists, else the first listed read tool of the first connected catalog server. */
export function pickAskTarget(rows) {
  const live = rows.filter((r) => r.status === 'connected' && r.id !== null)
  const target = (r, tool) => ({ id: r.id, name: r.name, tool, prefix: toolPrefix(r.name) })
  for (const [id, tool] of ASK_PREFERRED) {
    const r = live.find((x) => x.id === id && x.tools.includes(tool))
    if (r) return target(r, tool)
  }
  for (const r of live) {
    const tool = readsOf(r.id).find((t) => r.tools.includes(t))
    if (tool) return target(r, tool)
  }
  return null
}

/**
 * The ask check's verdict from one run's record {version, asked: [tool names], attempted: [{id, name}], refused: [tool_use ids whose ERROR
 * result came with no can_use_tool first: the CLI's own refusal], unasked: [tool_use ids whose successful result
 * came with no can_use_tool before it], result, error}; pure. PASS: a can_use_tool for `tool` arrived. FAILED: its successful result arrived
 * with none first (it provably ran unasked). INCONCLUSIVE: anything else, an error result with none included (the CLI refused it itself).
 * Never holds what the tool returned.
 */
export function classifyAsk(r, tool) {
  if (r.asked.includes(tool))
    return {
      outcome: 'PASS',
      text: `a can_use_tool for ${tool} arrived under the ask rule in auto mode, with an allow rule for it too (the probe denied it: nothing was read)`
    }
  if (r.unasked.length)
    return {
      outcome: 'FAILED',
      text: `${tool} ran with no can_use_tool: the ask rule did not hold in auto mode, so connector writes would run unasked`
    }
  const no = (text) => ({ outcome: 'INCONCLUSIVE', text })
  if (r.error) return no(r.error)
  if (r.version === null && !r.result) return no('the CLI reported no init (not installed, or not signed in?)')
  if (!r.attempted.some((t) => t.name === tool))
    return r.result?.is_error
      ? no(`the run ended with an error (not signed in?): ${r.result.subtype ?? 'no subtype'}`)
      : no(`the model never called ${tool}`)
  if (r.refused.length) return no(`${tool} was refused by the CLI itself: no can_use_tool, nothing ran`)
  return no(`${tool} was called but neither asked nor ran`)
}

const worst = (checks) =>
  checks.some((c) => c.verdict === 'FAILED') ? 'FAILED' : checks.some((c) => c.verdict === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : 'PASS'

/** The deny rules a run applies, from get_settings' answer: an array, or null when it could not be read. */
const effectiveDeny = (answers) => {
  const deny = obj(obj(obj(answers?.effective)?.effective)?.permissions)?.deny
  return Array.isArray(deny) ? deny : null
}

/**
 * The verdict from what the runs saw; pure. `base` is the plain run; `byUrl` and `byName` map a catalog id to the raw answers of its
 * deny run; `merged` is the run with the main run's merged settings (null / missing = could not be started); `ask` is the ask check's
 * {id?, outcome, text} (absent = not run, so no check f). Returns
 * {verdict, checks: [{key, id?, verdict, text, rows?}]}: FAILED when the CLI changed something the deny relies on, else INCONCLUSIVE
 * when something could not be checked, else PASS.
 */
export function judgeConnectors({ base, byUrl = {}, byName = {}, merged = null, ask }) {
  const checks = []
  const rows = rowsOf(base)
  // Only host, never the URL, leaves this function
  const shown = (list) => list.map((r) => ({ name: r.name, status: r.status, host: r.url === null ? null : hostOf(r.url), id: r.id }))
  const claudeAi = rows.filter((r) => r.name.startsWith('claude.ai ') || r.id !== null)

  // a
  const baseProblem = mcpProblem(base)
  if (baseProblem === 'error') checks.push({ key: 'a', verdict: 'FAILED', text: 'mcp_status was answered with an error' })
  else if (baseProblem) checks.push({ key: 'a', verdict: 'INCONCLUSIVE', text: `mcp_status got no answer (${baseProblem})` })
  else if (claudeAi.length === 0)
    checks.push({
      key: 'a',
      verdict: 'INCONCLUSIVE',
      text: 'no claude.ai connector is listed: not signed in with a subscription, a key variable is set, or none is connected'
    })
  else {
    // The deny by URL is the real guard: a connector the catalog knows by name must also match one of its URL patterns.
    const missed = claudeAi.filter((r) => r.url !== null && connectorOf(r.url, '') === null && connectorOf(null, r.name) !== null)
    const noUrl = claudeAi.filter((r) => r.url === null)
    if (missed.length)
      checks.push({
        key: 'a',
        verdict: 'FAILED',
        text: `a deny by URL would miss ${missed.map((r) => `${r.name} (${hostOf(r.url) ?? 'no host'})`).join(', ')}: its host is in no catalog pattern`,
        rows: shown(claudeAi)
      })
    else if (noUrl.length)
      checks.push({
        key: 'a',
        verdict: 'INCONCLUSIVE',
        text: `${noUrl.map((r) => r.name).join(', ')} listed with no URL: its pattern could not be checked`,
        rows: shown(claudeAi)
      })
    else
      checks.push({
        key: 'a',
        verdict: 'PASS',
        text: `${claudeAi.length} claude.ai server(s) listed, each URL matched by the catalog or no catalog name`,
        rows: shown(claudeAi)
      })
  }

  // b, c: every connected catalog connector, one check each
  const targets = targetsOf(rows)
  const denied = (key, target, answers, what) => {
    const id = target.id
    const problem = mcpProblem(answers)
    if (problem === 'error') return checks.push({ key, id, verdict: 'FAILED', text: `mcp_status was answered with an error under ${what}` })
    if (problem) return checks.push({ key, id, verdict: 'INCONCLUSIVE', text: `the run with ${what} got no answer (${problem})` })
    return rowsOf(answers).some((r) => r.name === target.name)
      ? checks.push({ key, id, verdict: 'FAILED', text: `${target.name} is still listed under ${what}: the CLI ignored it` })
      : checks.push({ key, id, verdict: 'PASS', text: `${target.name} is no longer listed under ${what}` })
  }
  if (targets.length === 0) {
    checks.push({ key: 'b', verdict: 'INCONCLUSIVE', text: 'no catalog connector is connected, so there is nothing to deny' })
    checks.push({ key: 'c', verdict: 'INCONCLUSIVE', text: 'no catalog connector is connected, so there is nothing to deny' })
  } else {
    for (const t of targets)
      denied('b', t, byUrl[t.id] ?? null, `deniedMcpServers {serverUrl: ${hostOf(t.pattern.replace('*', 'x')) ?? '?'}/*}`)
    for (const t of targets) if (t.hasName) denied('c', t, byName[t.id] ?? null, `deniedMcpServers {serverName: ${t.name}}`)
  }

  // d: the tool names are the bare names the catalog lists
  if (targets.length === 0)
    checks.push({ key: 'd', verdict: 'INCONCLUSIVE', text: 'no catalog connector is connected, so its tool names could not be checked' })
  for (const t of targets) {
    if (t.tools.length === 0)
      checks.push({ key: 'd', id: t.id, verdict: 'INCONCLUSIVE', text: `${t.name} lists no tools: their names could not be checked` })
    else {
      const unknown = unknownTools(t.id, t.tools).length
      checks.push(
        unknown === t.tools.length
          ? {
              key: 'd',
              id: t.id,
              verdict: 'FAILED',
              text: `the CLI's tool names are not the bare names the catalog lists: ${unknown} of ${t.tools.length} tools of ${t.name} are unknown to it`
            }
          : {
              key: 'd',
              id: t.id,
              verdict: 'PASS',
              text: `${t.tools.length - unknown} of ${t.tools.length} tools of ${t.name} are in the catalog (${unknown} unknown)`
            }
      )
    }
  }

  // e: the merged settings of a main run: no catalog connector, and the deny rule still in effect
  const problem = merged ? mcpProblem(merged) : 'no run'
  if (problem === 'error')
    checks.push({ key: 'e', verdict: 'FAILED', text: 'mcp_status was answered with an error under the merged settings' })
  else if (problem) checks.push({ key: 'e', verdict: 'INCONCLUSIVE', text: `the run with the merged settings got no answer (${problem})` })
  else {
    const left = rowsOf(merged).filter((r) => r.id !== null)
    const deny = effectiveDeny(merged)
    if (left.length)
      checks.push({
        key: 'e',
        verdict: 'FAILED',
        text: `${left.map((r) => r.name).join(', ')} still listed under the merged settings: the CLI ignored the connector deny`
      })
    else if (deny !== null && !deny.includes(DENY_RULE))
      checks.push({
        key: 'e',
        verdict: 'FAILED',
        text: 'the merged settings lost the file deny rule: the CLI dropped the whole settings object (the vault guard with it)'
      })
    else if (deny === null)
      checks.push({
        key: 'e',
        verdict: 'INCONCLUSIVE',
        text: `no connector is listed under the merged settings, but the effective deny rules could not be read${merged.errors?.settings ? ` (${merged.errors.settings})` : ''}`
      })
    else if (targets.length === 0 && claudeAi.length === 0)
      checks.push({
        key: 'e',
        verdict: 'INCONCLUSIVE',
        text: 'the deny rule is kept, but no catalog connector was listed in the plain run, so nothing shows the connector deny working'
      })
    else checks.push({ key: 'e', verdict: 'PASS', text: 'no catalog connector is listed and the file deny rule is still in effect' })
  }

  // f: a read tool still asks in auto mode
  if (ask) checks.push({ key: 'f', ...(ask.id ? { id: ask.id } : {}), verdict: ask.outcome, text: ask.text })
  return { verdict: worst(checks), checks }
}

// The CLI's temp root is the probe's own (as the app gives each chat one), so the per-run folders it makes there go with the probe.
const cleanEnv = (tmpRoot) => {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_TMPDIR: tmpRoot }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  return env
}

// A run that did not answer is repeated once, as the extensions probe does.
async function once(run) {
  const first = await run()
  return Object.values(first.errors).some((e) => e && e !== 'error') ? run() : first
}

const ASK_RUN_MS = 180_000
// The ask run's CLI, so a signal to the probe takes its process group down (listings' own runs are ended by killRunning).
let askChild = null
const killAskRun = () => {
  if (askChild?.pid) {
    try {
      process.kill(-askChild.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  askChild = null
}
const askPrompt = (tool) =>
  `This is a test of tool permissions; nothing is at stake. Call the tool ${tool} exactly once, with the simplest input it accepts (an empty one if it takes none). If the call is refused, do not retry it: reply with just the word DONE.`

/** One ask run: the app's main-run flags that matter here, the model asked to call `tool` once; every can_use_tool is answered DENY. Returns classifyAsk's record. */
async function askAttempt({ bin, cwd, env, target }) {
  const full = `${target.prefix}__${target.tool}`
  const settings = JSON.stringify({ permissions: { ask: [`${target.prefix}__*`], allow: [full] } })
  const argv = [
    '-p',
    '--model',
    'haiku',
    '--max-turns',
    '4',
    '--permission-mode',
    'auto',
    '--permission-prompt-tool',
    'stdio',
    '--no-session-persistence',
    '--settings',
    settings,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  const r = { version: null, asked: [], attempted: [], unasked: [], refused: [], result: null, error: null }
  const askedIds = new Set()
  let child
  try {
    child = spawn(bin, argv, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    askChild = child
    const send = (m) => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(m) + '\n')
    }
    child.stdin.on('error', () => {})
    let buf = ''
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c
      for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m?.type === 'system' && m.subtype === 'init')
          r.version = typeof m.claude_code_version === 'string' ? m.claude_code_version : 'unknown'
        if (m?.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          r.asked.push(m.request.tool_name)
          if (typeof m.request.tool_use_id === 'string') askedIds.add(m.request.tool_use_id)
          // The card ZumiBot would show, answered deny: the connector is never reached.
          send({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: m.request_id,
              response: { behavior: 'deny', message: 'Denied by the connectors probe.' }
            }
          })
        }
        const blocks = Array.isArray(m?.message?.content) ? m.message.content : []
        if (m?.type === 'assistant' && !m.parent_tool_use_id)
          for (const b of blocks) if (b?.type === 'tool_use') r.attempted.push({ id: b.id, name: b.name })
        if (m?.type === 'user' && !m.parent_tool_use_id) {
          for (const b of blocks) {
            const call = b?.type === 'tool_result' ? r.attempted.find((t) => t.id === b.tool_use_id) : undefined
            // A result before any can_use_tool for that call (matched by id, else by name when the CLI sent no id): a good one means
            // the tool ran unasked; an error one is the CLI refusing it itself (a classifier denial, MCP not ready), so nothing ran.
            if (call?.name === full && !askedIds.has(call.id) && !r.asked.includes(full)) (b.is_error ? r.refused : r.unasked).push(call.id)
          }
        }
        if (m?.type === 'result' && !r.result) {
          r.result = { is_error: !!m.is_error, subtype: typeof m.subtype === 'string' ? m.subtype : null }
          child.stdin.end()
        }
      }
    })
    send({ type: 'user', message: { role: 'user', content: askPrompt(full) } })
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        r.error = `the run took longer than ${ASK_RUN_MS / 1000} s`
        resolve()
      }, ASK_RUN_MS)
      child.on('error', (e) => {
        clearTimeout(timer)
        r.error = `claude could not start: ${e.message}`
        resolve()
      })
      child.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.on('exit', () => {
        setTimeout(() => {
          clearTimeout(timer)
          resolve()
        }, 1000).unref()
      })
    })
  } catch (e) {
    r.error = `claude could not start: ${e.message}`
  } finally {
    killAskRun()
  }
  return r
}

/** Check f: the ask run (once more when inconclusive) as a check {id?, outcome, text}; no target is inconclusive. */
async function askCheck({ bin, cwd, env, target, log }) {
  if (!target)
    return { outcome: 'INCONCLUSIVE', text: 'no connected catalog connector lists a read tool, so the ask rule could not be tried' }
  const full = `${target.prefix}__${target.tool}`
  let v
  for (let i = 1; i <= 2; i++) {
    const r = await askAttempt({ bin, cwd, env, target })
    v = classifyAsk(r, full)
    log(`connectors probe: ask run ${i}: ${target.id} ${target.tool}: asked ${r.asked.length}, ${v.outcome}`)
    if (v.outcome !== 'INCONCLUSIVE') break
  }
  return { id: target.id, outcome: v.outcome, text: v.text.replaceAll(full, `${target.id} ${target.tool}`) }
}

/** Runs the probe; returns {verdict, checks, version}. Throws only on local setup errors. */
export async function probeConnectors({ bin = binary(), log = console.log } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'connectors-probe-')))
  let tmpRoot = null
  try {
    // Short: the CLI nests claude-<uid>/<cwd as a name>/<session> under it, and a unix socket path stops near 104 bytes.
    tmpRoot = await realpath(await mkdtemp(join(tmpdir(), 'cbp-')))
    const env = cleanEnv(tmpRoot)
    const keyVar = KEY_VARS.find((k) => (env[k] ?? '') !== '')
    if (keyVar) log(`connectors probe: ${keyVar} is set in this environment, so the CLI loads no claude.ai connectors; expect INCONCLUSIVE`)
    const run = (settings, effective = false) => once(() => listings({ bin, cwd, env, settings, effective }))
    const base = await run({})
    const targets = targetsOf(rowsOf(base))
    const byUrl = {},
      byName = {}
    for (const t of targets) {
      byUrl[t.id] = await run({ deniedMcpServers: [{ serverUrl: t.pattern }] })
      if (t.hasName) byName[t.id] = await run({ deniedMcpServers: [{ serverName: t.name }] })
    }
    const merged = await run(mergedSettings(connectedPrefixes(rowsOf(base))), true)
    const ask = await askCheck({ bin, cwd, env, target: pickAskTarget(rowsOf(base)), log })
    return { ...judgeConnectors({ base, byUrl, byName, merged, ask }), version: base.version ?? 'unknown' }
  } finally {
    killRunning()
    killAskRun()
    await rm(cwd, { recursive: true, force: true })
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true })
  }
}

const LABEL = {
  a: 'a) a plain run lists the claude.ai connectors',
  b: 'b) deniedMcpServers {serverUrl} keeps a connector out',
  c: 'c) deniedMcpServers {serverName} keeps a connector out',
  d: "d) the tool names are the catalog's bare names",
  e: 'e) the merged settings of a main run deny the connectors and keep the file deny rule',
  f: 'f) a read tool of a connected connector still sends can_use_tool under the ask rule in auto mode'
}

/** The exit code of the probe's own run. */
export async function main(args = [], probe = probeConnectors) {
  const strict = args.includes('--strict')
  let r
  try {
    r = await probe({})
  } catch (e) {
    r = {
      verdict: 'INCONCLUSIVE',
      version: 'unknown',
      checks: [{ key: 'a', verdict: 'INCONCLUSIVE', text: `the probe could not run: ${e.message}` }]
    }
  }
  for (const c of r.checks) {
    console.log(`${c.verdict} ${LABEL[c.key]}${c.id ? ` [${c.id}]` : ''}: ${c.text}`)
    for (const row of c.rows ?? []) console.log(`  ${row.name}  ${row.status}  ${row.host ?? 'no url'}  ${row.id ?? 'not in the catalog'}`)
  }
  const code = exitCodeFor(r.verdict, { soft: !strict })
  if (r.verdict === 'PASS')
    console.log(
      `connectors probe: PASS (Claude Code ${r.version}): the CLI lists the claude.ai connectors, its tool names are the catalog's, the URL and name entries in deniedMcpServers keep each one out, the merged settings keep the file deny rule, and a connector tool still asks under the ask rule in auto mode`
    )
  else if (r.verdict === 'FAILED')
    console.error(`FAILED: Claude Code ${r.version}: the CLI no longer behaves as the connectors feature expects`)
  else {
    console.error(
      `INCONCLUSIVE: Claude Code ${r.version}: ${r.checks
        .filter((c) => c.verdict === 'INCONCLUSIVE')
        .map((c) => c.text)
        .join('; ')}`
    )
    if (!strict)
      console.error(
        '!!! WARNING: the connectors probe was INCONCLUSIVE: the connectors page and its deny rules are NOT verified against this account. Connect a catalog connector on claude.ai and run it again.'
      )
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A Ctrl-C or kill must not leave the CLI and its MCP servers running.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ])
    process.once(signal, () => {
      killRunning()
      killAskRun()
      process.exit(code)
    })
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
