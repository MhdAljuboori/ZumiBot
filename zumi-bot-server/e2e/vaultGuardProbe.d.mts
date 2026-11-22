export const VAULT_GUARD_TEXT: string
export const GUARD_FAILED: string
export type VaultProbeOutcome = 'PASS' | 'FAILED' | 'INCONCLUSIVE'
export function classify(lines: string[], value: string): { outcome: VaultProbeOutcome; reason: string | null }
export function verdict(lines: string[], value: string): VaultProbeOutcome
export function probeVaultGuard(o?: {
  bin?: string
  log?: (line: string) => void
}): Promise<{ outcome: VaultProbeOutcome; version: string; reason: string | null }>
export function main(args?: string[], probe?: () => Promise<{ outcome: string; version: string; reason: string | null }>): Promise<number>
