export const DESKTOP_ASK_SETTINGS: string
export const ASK_FAILED: string
export function askSettings(withAllow?: boolean): string
export type ProbeOutcome = 'pass' | 'fail' | 'inconclusive'
export function classify(r: unknown): { outcome: ProbeOutcome; reason: string | null }
export function probeDesktopAsk(o?: {
  bin?: string
  log?: (line: string) => void
  withAllowRule?: boolean
}): Promise<{ outcome: ProbeOutcome; version: string; reason: string | null; runs: number }>
export function main(args?: string[]): Promise<number>
