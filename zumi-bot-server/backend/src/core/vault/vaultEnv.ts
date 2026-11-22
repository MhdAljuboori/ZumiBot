import type { VaultItem } from '@zumibot/shared/vault'

/** The env vars an agent's API keys become, and what each value is replaced with in anything stored or shown. */
export function vaultEnvOf(items: readonly VaultItem[]): { env: Record<string, string>; scrub: Map<string, string> } {
  const env: Record<string, string> = {}
  const scrub = new Map<string, string>()
  for (const item of items) {
    if (item.kind !== 'apiKey' || item.value === '') continue
    env[item.env] = item.value
    scrub.set(item.value, `[vault: ${item.name}]`)
  }
  return { env, scrub }
}
