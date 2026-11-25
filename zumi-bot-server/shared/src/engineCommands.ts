/** Which agent engine a `/` menu row comes from: Claude Code commands or Codex skills. */
export type CommandEngine = 'claude' | 'codex'

export interface EngineCommand {
  name: string
  description: string
  hint?: string
  // The menu lists an engine's skills before its other commands. Every Codex row is a skill.
  kind: 'skill' | 'command'
}

export interface EngineCommands {
  engine: CommandEngine
  commands: EngineCommand[]
}

// Claude built-ins that open a screen or change a setting; they do nothing useful sent as a chat message.
// Only rows the CLI marks builtin: true are checked against this list.
export const CLAUDE_DENIED: ReadonlySet<string> = new Set([
  'login', 'logout', 'model', 'effort', 'usage', 'usage-credits', 'extra-usage', 'config', 'color', 'clear',
  'fast', 'focus', 'rename', 'output-style', 'autocompact', 'compact', 'context', 'mcp', 'agents',
  'reload-plugins', 'reload-skills', 'heapdump', 'import', 'design-consent', 'design-revoke', 'auto-mode-setup',
  'workflow-launch-exec', 'help', 'exit', 'resume', 'permissions', 'hooks', 'memory', 'status', 'cost', 'theme',
  'vim', 'ide', 'terminal-setup', 'statusline', 'privacy-settings', 'release-notes', 'feedback', 'bug',
  'keybindings', 'add-dir', 'export', 'copy', 'plugin', 'upgrade', 'tasks', 'rewind',
])

// Same shape as the composer's own `/name` rule, plus `:` for plugin-namespaced commands.
const ENGINE_LEADING = /^\/([A-Za-z0-9][A-Za-z0-9_:.-]*)(?=\s|$)/

/** Only at index 0 of the untrimmed text, so a pasted path later in a message is never a command. */
export function engineLeading(text: string): { name: string; args: string } | null {
  const m = ENGINE_LEADING.exec(text)
  return m ? { name: m[1], args: text.slice(m[0].length).trim() } : null
}

/** Codex runs a skill when the message starts with `$name`. */
export function codexPrompt(name: string, args: string): string {
  return args === '' ? '$' + name : '$' + name + ' ' + args
}
