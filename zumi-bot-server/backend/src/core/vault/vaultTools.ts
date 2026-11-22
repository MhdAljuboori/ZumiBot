/** The one tool. It takes nothing: the agent is named by the capability, never by an argument. */
export const vaultTools = [
  {
    name: 'vault_items',
    description:
      "List what the user saved in ZumiBot's vault for you: logins, cards (never the number), contact details and API keys (their environment variable names). Never shows a password, code, card number or key value.",
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[], additionalProperties: false }
  }
]

export type VaultCall = { op: 'items' }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
const bad = (what: string) => new Error(`Invalid vault call: ${what}`)

/** Checks one tool call exactly: any argument (a chat or agent name included) is refused. Messages are plain and safe to show the agent. */
export function parseVaultCall(name: string, args: unknown): VaultCall {
  if (!record(args)) throw bad('arguments must be an object')
  if (name !== 'vault_items') throw bad('unknown tool')
  if (Object.keys(args).length > 0) throw bad('vault_items takes no arguments')
  return { op: 'items' }
}

/** The tool arguments of an already-built call (its `op` is the tool's short name). */
export function parseVaultWire(call: unknown): VaultCall {
  if (!record(call) || typeof call.op !== 'string') throw bad('missing op')
  const { op, ...args } = call
  return parseVaultCall(op === 'items' ? 'vault_items' : op, args)
}

/** What a stored `vault_items` row keeps of its result: the count and the item names, never ids, sites, users or variables. */
export function vaultRowResult(content: string, isError: boolean): string {
  if (isError) return 'Vault command failed.'
  let names: string[]
  try {
    const list: unknown = JSON.parse(content)
    if (!Array.isArray(list)) return 'Vault command failed.'
    names = list.map((i) => (record(i) && typeof i.name === 'string' ? i.name : '')).filter(Boolean)
  } catch {
    return 'Vault command failed.'
  }
  const head = `Checked the vault (${names.length} ${names.length === 1 ? 'item' : 'items'})`
  return names.length === 0 ? head : `${head}: ${names.join(', ')}`
}
