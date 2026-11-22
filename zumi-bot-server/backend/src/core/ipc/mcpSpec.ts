/** One bridge, described once: the Claude CLI renders it as `--mcp-config` JSON, other providers render it their own way. */
export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  /** Env names whose values the run's env carries (capability token, IPC path); the token stays out of argv. */
  passEnv: string[]
  /** Literal env values, such as ELECTRON_RUN_AS_NODE. */
  fixedEnv: Record<string, string>
  /** With many MCP tools the CLI defers the rest behind tool search; an agent that never searches would never reach ours. */
  alwaysLoad?: true
  timeoutMs?: number
}

/** Key order is part of the argv the CLI gets (and the prompt-cache prefix), so it is fixed: alwaysLoad, then timeout, then env. */
export function claudeMcpConfig(s: McpServerSpec): { mcpServers: Record<string, unknown> } {
  const env: Record<string, string> = {}
  for (const name of s.passEnv) env[name] = '${' + name + '}'
  Object.assign(env, s.fixedEnv)
  return {
    mcpServers: {
      [s.name]: {
        type: 'stdio',
        command: s.command,
        args: s.args,
        ...(s.alwaysLoad ? { alwaysLoad: true } : {}),
        ...(s.timeoutMs !== undefined ? { timeout: s.timeoutMs } : {}),
        env
      }
    }
  }
}

/**
 * Stand-in for a turn that carries no bridge of its own (an unavailable browser or desktop, a merged side-run turn): its argv,
 * if any, is Claude-only. Codex must never read `.mcp` from a merged side-run turn: it takes each bridge turn's own spec, and
 * skips one with no command (codexServers in chatService.ts).
 */
export const NO_MCP: McpServerSpec = { name: '', command: '', args: [], passEnv: [], fixedEnv: {} }
