import type { PermissionMode } from '../chat/claudeRunner'
import type { UserContent } from '../chat/controlProtocol'
import type { McpServerSpec } from '../ipc/mcpSpec'

/**
 * Without this feature a model's question is a plain message and the turn sleeps for good (probe check 15), so every
 * Codex process runs with it while question cards are on: `requestUserInput` then arrives as a request, which becomes a card.
 */
export const CODEX_QUESTION_FEATURE = 'default_mode_request_user_input'

/**
 * A command hook ZumiBot hands one Codex process. Probe check 11: only `preToolUse`, it runs before shell, MCP, patch and
 * collab calls (auto-run reads too), exit 2 blocks with its stderr, and exit 1 or a timeout let the call run.
 */
export interface CodexHook {
  event: 'preToolUse'
  matcher: string | null
  command: string
  timeoutSec: number
}

export interface CodexThreadInput {
  cwd: string
  model?: string
  /** `baseInstructions`, not `developerInstructions`: the latter is ignored on thread/resume. */
  baseInstructions: string
  permissionMode: PermissionMode
  mcpServers: McpServerSpec[]
  /** Default `workspace-write`; a side run asks for `read-only`, so a decline is not all that stands between it and the files. */
  sandbox?: 'read-only' | 'workspace-write'
  /** The agent's `autoCompactWindow`; Codex compacts itself past this many tokens. A config key, so it rides on every start kind. */
  autoCompactTokenLimit?: number
  /** The process's hooks. They go on the app-server's argv (`hookConfig`), never in a request: check 11 found `config` hooks ignored. */
  hooks?: CodexHook[]
}

/** Below this a limit is sent before the model's window is known: Codex windows seen so far are larger (258 400 in the smoke). */
export const CODEX_COMPACT_FLOOR = 200_000

/**
 * The auto-compact limit to send, or null to send none, so codex compacts by itself near its window. A limit at or past the
 * window would never fire before the window fills, so one is sent only below the window, or below the floor while the window
 * is not known yet (Agent Studio offers 300K-600K, and Zumi Bot gives new agents 400K).
 */
export function codexCompactLimit(compactAt: number | null, window: number | null): number | null {
  return compactAt !== null && compactAt < (window ?? CODEX_COMPACT_FLOOR) ? compactAt : null
}

// Only these two policy pairs are ever sent: no `never`, no full-access sandbox, nothing that skips approvals.
const POLICY: Record<PermissionMode, { approvalPolicy: string; approvalsReviewer: string }> = {
  manual: { approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
  auto: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
}

function mcpEntry(s: McpServerSpec): Record<string, unknown> {
  return {
    command: s.command,
    args: s.args,
    env: s.fixedEnv,
    env_vars: s.passEnv,
    ...(s.timeoutMs !== undefined ? { tool_timeout_sec: Math.ceil(s.timeoutMs / 1000) } : {})
  }
}

/**
 * Env names codex reads for itself (its login, endpoint and home: OPENAI_API_KEY, OPENAI_BASE_URL, CODEX_HOME…). A vault key so
 * named would switch them on a Codex run, so it never goes in one; Claude agents may keep it.
 */
export const isCodexOwnEnv = (name: string): boolean => /^(CODEX|OPENAI)_/i.test(name)

/** The agent file's `model:` as Codex takes it: `inherit` (any case) and blank are Claude's words for no model, so none is sent. */
export function codexModel(model: string | null | undefined): string | undefined {
  const m = model?.trim()
  return !m || m.toLowerCase() === 'inherit' ? undefined : m
}

/**
 * The parameters of `thread/start`, `thread/resume` and `thread/fork`; the same on all so a resumed or forked thread keeps its policy.
 * With subagents the thread-level switch is left out, as in probe check 13, so the process's `--enable multi_agent` decides.
 */
export function threadParams(i: CodexThreadInput, o: { subagents?: boolean } = {}): Record<string, unknown> {
  const mcp: Record<string, unknown> = {}
  // Dotted key with an object value: the form the Phase 0 probe proved the CLI accepts.
  for (const s of i.mcpServers) mcp[`mcp_servers.${s.name}`] = mcpEntry(s)
  return {
    cwd: i.cwd,
    ...(i.model !== undefined ? { model: i.model } : {}),
    baseInstructions: i.baseInstructions,
    ...POLICY[i.permissionMode],
    sandbox: i.sandbox ?? 'workspace-write',
    config: {
      'sandbox_workspace_write.network_access': true,
      ...(o.subagents ? {} : { 'features.multi_agent': false }),
      // The thought rows: without it a reasoning item's summary comes empty (codex 0.164.0). On every start kind, so a resumed
      // or forked thread (a side run) asks the same.
      model_reasoning_summary: 'auto',
      ...(i.autoCompactTokenLimit !== undefined ? { model_auto_compact_token_limit: i.autoCompactTokenLimit } : {}),
      ...mcp
    }
  }
}

// TOML forbids control characters in a string and has no escape for a lone surrogate (its \u must name a scalar value), so a
// string holding one is refused rather than sent in a form codex may read differently. Tab and line feed stay: TOML's own
// \t and \n escapes, which JSON.stringify writes, carry them.
const UNENCODABLE = /[\u0000-\u0008\u000B-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

class TomlError extends Error {}

// A value as TOML inline, for `codex -c key=<value>`: a JSON string is a valid TOML basic string once the above is refused,
// numbers are whole (all ZumiBot sends), and TOML has no null. Throws TomlError on anything else.
function toml(v: unknown): string {
  if (typeof v === 'string') {
    if (UNENCODABLE.test(v)) throw new TomlError('Not a TOML string')
    return JSON.stringify(v)
  }
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TomlError('Not a TOML integer')
    return String(v)
  }
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`
  if (!v || typeof v !== 'object') throw new TomlError('Not a TOML value')
  const key = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : toml(k))
  return `{${Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== null && x !== undefined)
    .map(([k, x]) => `${key(k)}=${toml(x)}`)
    .join(',')}}`
}

/**
 * The app-server arguments that give a process its hooks, in the one form probe check 11 saw run: `-c hooks.PreToolUse=[…]`
 * (one group per hook, so hook i is `…:pre_tool_use:<i>:0`), plus, once their hashes are known, `-c hooks.state={…}` trusting
 * exactly those keys. A `-c` hook nobody trusts is skipped silently, and the dotted `hooks.state."<key>"` form is ignored.
 * Never a trust bypass: that would run the user's and any project's hooks too.
 * `[]` when any hook (or trust entry) cannot be encoded: a string TOML forbids, or a timeout that is not a whole number of
 * seconds of at least 1. The whole set goes, so a run never gets part of its hooks; runCodex then fails closed.
 */
export function hookConfig(hooks: CodexHook[], trust?: ReadonlyMap<string, string> | null): string[] {
  if (!hooks.length || hooks.some((h) => !Number.isSafeInteger(h.timeoutSec) || h.timeoutSec < 1)) return []
  const groups = hooks.map((h) => ({
    ...(h.matcher !== null ? { matcher: h.matcher } : {}),
    hooks: [{ type: 'command', command: h.command, timeout: h.timeoutSec }]
  }))
  try {
    const args = ['-c', `hooks.PreToolUse=${toml(groups)}`]
    if (trust?.size)
      args.push('-c', `hooks.state=${toml(Object.fromEntries([...trust].map(([key, hash]) => [key, { trusted_hash: hash }])))}`)
    return args
  } catch (e) {
    if (e instanceof TomlError) return []
    throw e
  }
}

export function codexInput(c: UserContent): Array<Record<string, unknown>> {
  if (typeof c === 'string') return [{ type: 'text', text: c, text_elements: [] }]
  return c.map((b) =>
    b.type === 'text'
      ? { type: 'text', text: b.text, text_elements: [] }
      : { type: 'image', url: `data:${b.source.media_type};base64,${b.source.data}` }
  )
}
