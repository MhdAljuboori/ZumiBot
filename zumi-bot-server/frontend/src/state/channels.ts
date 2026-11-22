import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { CHANNEL_LABELS, showPairCode, type ChannelPlatform, type ChannelStatus } from '@zumibot/shared/channels'
import type { AgentSummary } from '@zumibot/shared/types'

/** The connection line under the bot token. */
export function stateLine(s: ChannelStatus): string {
  const label = CHANNEL_LABELS[s.platform]
  if (!s.configured) return s.platform === 'slack' ? 'No tokens saved.' : 'No bot token saved.'
  if (!s.run) return 'Runs on the other machine. Turn on "Run the bot here" to use it from this one.'
  switch (s.state) {
    case 'connected':
      return s.bot ? `Connected as @${s.bot}.` : 'Connected.'
    case 'connecting':
      return 'Connecting…'
    case 'conflict':
      return 'Another machine (or a webhook) is using this bot. Turn it off there, or turn "Run the bot here" off.'
    case 'badToken':
      return s.platform === 'slack' ? 'Slack refused a token. Paste both again.' : 'Telegram refused the bot token. Paste a new one.'
    case 'vault':
      return `The saved ${s.platform === 'slack' ? 'tokens' : 'token'} can't be opened: the vault key is missing or changed. Paste ${s.platform === 'slack' ? 'them' : 'the token'} again.`
    case 'error':
      return `Can't reach ${label} right now. Retrying.`
    case 'off':
      return 'Off.'
  }
}

/** The agents Settings lists: every loadable agent but Zumi Bot, which a channel never uses. */
export const channelAgents = (agents: readonly AgentSummary[]): AgentSummary[] =>
  agents.filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME).sort((a, b) => a.name.localeCompare(b.name))

/** The new list after one checkbox flips. */
export const toggleAgent = (on: readonly string[], name: string, checked: boolean): string[] =>
  checked ? [...new Set([...on, name])] : on.filter((n) => n !== name)

/** "ABCD-EFGH · 9 min left": the code as typed into Telegram. */
export function pairLine(code: string, expiresAt: number, now: number): string {
  const min = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
  return `${showPairCode(code)} · ${min === 0 ? 'expired' : `${min} min left`}`
}

/** Test ids: Telegram's kept from phase 1 (`channel-…`), Slack's under its own prefix. */
export const channelTid = (p: ChannelPlatform, name: string): string => (p === 'telegram' ? `channel-${name}` : `slack-${name}`)
