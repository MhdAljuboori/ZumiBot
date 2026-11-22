import { visibleJson, visibleLines, visibleText } from '@zumibot/shared/visibleText'

/**
 * One top-level input field as an approval card lists it. `key` is the real name (a React key, never shown); `label` and
 * `title` are what the card shows of it. `block`: shown as its own box (long, multi-line or structured).
 */
export interface InputField {
  key: string
  label: string
  title: string
  value: string
  block: boolean
}

const ACRONYMS: Record<string, string> = {
  id: 'ID',
  ids: 'IDs',
  url: 'URL',
  urls: 'URLs',
  uri: 'URI',
  api: 'API',
  html: 'HTML',
  json: 'JSON',
  csv: 'CSV',
  pdf: 'PDF',
  cc: 'CC',
  bcc: 'BCC'
}

/**
 * `channel_id` / `channelId` / `send-message` → `Channel ID` / `Channel ID` / `Send message`. Names come from the agent or a
 * tool server, so hidden and reordering characters show as escapes (`visibleText`), as everywhere else on the card.
 */
export function humanizeName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .map((w) => ACRONYMS[w] ?? w)
  if (words.length === 0) return visibleText(name)
  words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1)
  return visibleText(words.join(' '))
}

/** A connector tool as words, without the service's own prefix: (`slack`, `slack_send_message`) → `Send message`. */
export function connectorAction(serviceId: string, tool: string): string {
  const id = serviceId.toLowerCase()
  const lower = tool.toLowerCase()
  for (const p of [`${id}_`, `${id}-`, `${id.replace(/-/g, '_')}_`]) {
    if (lower.startsWith(p) && tool.length > p.length) return humanizeName(tool.slice(p.length))
  }
  return humanizeName(tool)
}

/**
 * The input as labelled fields, or null when it is not a non-empty plain object (the card then shows the JSON). Text keeps
 * its line breaks; every other hidden character still shows as an escape, as in the JSON (`visibleLines`).
 */
export function inputFields(input: unknown): InputField[] | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return null
  return entries.map(([key, v]) => {
    const label = humanizeName(key)
    const title = visibleText(key)
    if (typeof v === 'string') {
      const value = visibleLines(v)
      return { key, label, title, value, block: value.includes('\n') || value.length > 80 }
    }
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return { key, label, title, value: String(v), block: false }
    return { key, label, title, value: visibleJson(v), block: true }
  })
}
