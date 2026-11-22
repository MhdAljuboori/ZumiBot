export type ExtensionsOutcome = 'PASS' | 'FAILED' | 'INCONCLUSIVE'
/** The raw answers of the base run (the shape of `ProbeAnswers`); `errors.<section>` is 'error' when the CLI answered with an error, any other string when it did not answer. */
export interface ExtensionsAnswers {
  version: string | null
  mcp: unknown
  skills: unknown
  hooks: unknown
  /** get_settings' answer, only when `listings` was asked for it. */
  effective?: unknown
  errors: Partial<Record<'mcp' | 'skills' | 'hooks' | 'settings', string>>
}
/** true = held, false = the CLI changed, null = could not be checked. */
export interface ExtensionsJudgeInput {
  answers: ExtensionsAnswers | null
  /** The stub server's name and whether it is still listed with deniedMcpServers; null when the control run did not list it. */
  denied: { name: string; present: boolean } | null
  overrides: { skillOff: boolean | null; pluginOff: boolean | null } | null
  /** What the plugin check's own listing (the user's real plugins) lost of the fields the page reads, or null/undefined when nothing. */
  pluginShape?: string | null
  /** A hook in the run's --settings is listed with source flagSettings. */
  flagHook?: boolean | null
  /**
   * Check g: one --settings merging the guard hook and the ask and deny rules with every hook shape the app applies from an agent file
   * keeps them (`guard`: get_hooks_listing, `rules`: get_settings' effective permissions). undefined = not asked for, null = the CLI
   * could not be started or asked.
   */
  merged?: { guard: boolean | null; rules: boolean | null } | null
  /** --model-check only: undefined = not asked for, null = the runs could not be made. */
  model?: {
    toolsHidden: boolean | null
    prefixOk: boolean | null
    prefixObserved?: string
    prefixExpected?: string
    agentKeysIgnored: boolean | null
    guardWins: boolean | null
  } | null
  /**
   * `claude mcp add -s local` keys by the real path of the nearest ancestor (the folder's real path first) holding a `.git` entry,
   * else the real path of the folder. `rule` true = held in every scenario, false = a key differed, null = one could not be made;
   * `observed` is one line per scenario with the key seen. undefined = not asked for, null = the CLI could not add a server.
   */
  localKey?: { rule: boolean | null; observed: string[] } | null
}
export const SIDE_GUARD_SETTINGS: string
type HookGroups = Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> }>
/** Check g's agent part: every hook shape the app's parser calls editable, beside the agent's other settings keys. */
export const AGENT_SETTINGS: {
  deniedMcpServers: Array<{ serverName: string }>
  enabledPlugins: Record<string, boolean>
  skillOverrides: Record<string, 'off'>
  hooks: Record<string, HookGroups>
}
/** Check g's run part: a guard hook on every tool, an ask rule and a deny rule. */
export const GUARD_SETTINGS: { hooks: { PreToolUse: HookGroups }; permissions: { ask: string[]; deny: string[] } }
export const ASK_RULE: string
export const DENY_RULE: string
/** The app's merge of several --settings into one (claudeRunner.ts `mergeJson`). */
export function mergeSettings(a: unknown, b: unknown): any
export function toolPrefix(serverName: string): string
export function judgeExtensions(o: ExtensionsJudgeInput): { verdict: ExtensionsOutcome; reasons: string[] }
export function exitCodeFor(verdict: ExtensionsOutcome | string, o?: { soft?: boolean }): number
export function probeExtensions(o?: {
  bin?: string
  modelCheck?: boolean
  log?: (line: string) => void
}): Promise<{ verdict: ExtensionsOutcome; reasons: string[]; version: string }>
export function main(
  args?: string[],
  probe?: (o: { modelCheck: boolean }) => Promise<{ verdict: string; reasons: string[]; version: string }>
): Promise<number>
/** One model-free CLI run with the given --settings (and --agent): the answers of initialize, mcp_status, get_skills_dialog and get_hooks_listing. */
export function listings(o: {
  bin: string
  cwd: string
  env: NodeJS.ProcessEnv
  settings: unknown
  agent?: string | null
  effective?: boolean
}): Promise<ExtensionsAnswers>
/** Ends every CLI the probe's runs still have going. */
export function killRunning(): void
