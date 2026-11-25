// Pure. The argv a commands-only probe adds to its fixed ones, from a run config's `extraArgs`. The probe only asks `initialize`
// for the command list, so it gets what decides which commands exist (switched-off skills, enabled plugins) and nothing that runs
// code or starts a server: hooks are off, no `--mcp-config`, and `--strict-mcp-config` keeps project and user servers from starting.
const KEPT = ['skillOverrides', 'enabledPlugins'] as const

export function commandsProbeArgs(extraArgs: readonly string[]): string[] {
  // `buildAgentRunConfig` emits at most one `--settings <json>`; one that does not parse adds nothing but the hooks-off line.
  const at = extraArgs.indexOf('--settings')
  let parsed: unknown = null
  try {
    parsed = at >= 0 ? JSON.parse(extraArgs[at + 1] ?? '') : null
  } catch {
    parsed = null
  }
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  const settings: Record<string, unknown> = { disableAllHooks: true }
  for (const key of KEPT) if (source[key] !== undefined) settings[key] = source[key]
  return ['--settings', JSON.stringify(settings), '--strict-mcp-config']
}
