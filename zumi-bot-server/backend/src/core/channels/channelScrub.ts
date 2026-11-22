// Vault values never leave through a channel: every outbound text loses each secret the server holds, whoever it is
// granted to (passwords of 6+ characters, API keys, bot tokens, and card numbers with or without spaces or dashes).

export const CHANNEL_HIDDEN = '[hidden by vault]'

export function scrubOutbound(text: string, s: { values: string[]; cards: string[] }): string {
  if (text === '') return text
  let out = text
  // Longest first, so a value that contains another one is replaced whole. Literal split/join: a value is never a pattern.
  for (const v of [...new Set(s.values.filter((x) => x !== ''))].sort((a, b) => b.length - a.length))
    out = out.split(v).join(CHANNEL_HIDDEN)
  for (const digits of new Set(s.cards)) {
    if (!/^\d{12,19}$/.test(digits)) continue
    // Built from validated digits only: one optional space or dash between any two.
    const re = new RegExp(`(?<!\\d)${digits.split('').join('[ -]?')}(?!\\d)`, 'g')
    out = out.replace(re, CHANNEL_HIDDEN)
  }
  return out
}
