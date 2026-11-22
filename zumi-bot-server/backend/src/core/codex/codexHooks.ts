import { existsSync } from 'node:fs'
import { pauseCommand, pauseHookOf } from '../chat/pauseSettings'
import { vaultGuardCommand, type GuardPaths } from '../vault/vaultGuard'
import type { CodexHook } from './codexParams'

// The hooks ZumiBot gives a Codex run (probe check 11). Codex lets a call run on every exit but 2 (exit 1 and a timeout
// fail open), so each command exits only 0 or 2, and the timeouts sit far above the work they cover. No matcher: a hook with
// none runs for shell, MCP and patch calls alike. A subagent's call carries a top-level `agent_id`, as Claude's does, so the
// pause rule (`blocks`, in the hook entry) reads Codex's input unchanged; it also lets the main thread wait for its subagents.

const TIMEOUT_SEC = 30

/** The vault guard: blocks a call whose input names the key folder or vault.json, whatever the tool. */
export function codexVaultHooks(o: GuardPaths): CodexHook[] {
  return [{ event: 'preToolUse', matcher: null, command: vaultGuardCommand(o, true), timeoutSec: TIMEOUT_SEC }]
}

/** The pause hook, or null exactly when `pauseHookOf` is (no built entry, a relative path), so Pause is then refused as for Claude. */
export function codexPauseHook(
  rt: { node: string; pauseHookEntry: string; electronNode: boolean },
  exists: (path: string) => boolean = existsSync
): CodexHook | null {
  if (!pauseHookOf(rt, exists)) return null
  return {
    event: 'preToolUse',
    matcher: null,
    command: pauseCommand({ node: rt.node, entry: rt.pauseHookEntry, electronNode: rt.electronNode }, true),
    timeoutSec: TIMEOUT_SEC
  }
}

/** A side answer's guard: every call is blocked, with the text Claude's side guard gives. */
export const CODEX_SIDE_DENY_HOOK: CodexHook = {
  event: 'preToolUse',
  matcher: null,
  command: "echo 'No tools in a side answer' >&2; exit 2",
  timeoutSec: TIMEOUT_SEC
}
