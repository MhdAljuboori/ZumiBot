import type { ExtensionsAnswers } from './extensionsProbe.mjs'
export type ConnectorsOutcome = 'PASS' | 'FAILED' | 'INCONCLUSIVE'
/** `tools` is the reads then the writes; the first `reads` are the read tools. */
export const CATALOG: ReadonlyArray<{ id: string; reads: number; urls: string[]; names: string[]; tools: string[] }>
export function urlMatches(pattern: string, url: string): boolean
export function connectorOf(url: string | null, name: string): string | null
export interface ConnectorsRow {
  name: string
  status: string
  url: string | null
  id: string | null
  tools: string[]
}
export function rowsOf(answers: ExtensionsAnswers | null | undefined): ConnectorsRow[]
export interface ConnectorsTarget {
  name: string
  id: string
  pattern: string
  tools: string[]
  hasName: boolean
}
/** Each connected catalog connector with a URL, once per catalog id. */
export function targetsOf(rows: ConnectorsRow[]): ConnectorsTarget[]
export function unknownTools(id: string, tools: readonly string[]): string[]
export function denyAllEntries(): Array<{ serverUrl: string } | { serverName: string }>
/** The merged --settings of check e: the connector deny and the vault guard's file deny rule in one object. */
export function mergedSettings(askPrefixes?: readonly string[]): {
  deniedMcpServers: Array<{ serverUrl: string } | { serverName: string }>
  permissions: { ask?: string[]; deny: string[] }
}
/** The tool prefix of every connected catalog connector's server, once each. */
export function connectedPrefixes(rows: ConnectorsRow[]): string[]
export interface AskTarget {
  id: string
  name: string
  tool: string
  prefix: string
}
/** The connected catalog server and read tool the ask check calls (preferred read tools first), or null. */
export function pickAskTarget(rows: ConnectorsRow[]): AskTarget | null
/** One ask run's record: `asked` the tool names of every can_use_tool, `unasked` the tool_use ids whose successful result came with none first (it ran), `refused` those whose error result did (the CLI refused it itself). */
export interface AskRun {
  version: string | null
  asked: string[]
  attempted: Array<{ id: string; name: string }>
  unasked: string[]
  refused: string[]
  result: { is_error: boolean; subtype: string | null } | null
  error: string | null
}
/** PASS: a can_use_tool for `tool` (its full `mcp__<server>__<tool>` name) arrived; FAILED: its successful result came with none first; an error result with none is INCONCLUSIVE; else INCONCLUSIVE. */
export function classifyAsk(run: AskRun, tool: string): { outcome: ConnectorsOutcome; text: string }
export interface ConnectorsCheck {
  key: 'a' | 'b' | 'c' | 'd' | 'e' | 'f'
  id?: string
  verdict: ConnectorsOutcome
  text: string
  rows?: Array<{ name: string; status: string; host: string | null; id: string | null }>
}
/** Each run is the raw answers of one CLI run (null = it could not be started); byUrl and byName map a catalog id to its deny run. */
export function judgeConnectors(o: {
  base: ExtensionsAnswers | null
  byUrl?: Record<string, ExtensionsAnswers | null>
  byName?: Record<string, ExtensionsAnswers | null>
  merged?: ExtensionsAnswers | null
  /** The ask check's result; absent = not run, so no check f. */
  ask?: { id?: string; outcome: ConnectorsOutcome; text: string }
}): { verdict: ConnectorsOutcome; checks: ConnectorsCheck[] }
export function probeConnectors(o?: {
  bin?: string
  log?: (line: string) => void
}): Promise<{ verdict: ConnectorsOutcome; checks: ConnectorsCheck[]; version: string }>
export function main(
  args?: string[],
  probe?: (o: object) => Promise<{ verdict: string; checks: ConnectorsCheck[]; version: string }>
): Promise<number>
