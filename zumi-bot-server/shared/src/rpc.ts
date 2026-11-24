import type { SideQuestion } from './btw'
import type { NotifyClear, NotifyPayload } from './notify'
import type { RoutinesSnapshot } from './routines'
import type { SidebarLayout } from './sidebarLayout'
import type { UpdateStatus } from './update'
import type { AgentRename, WirePush } from './types'
import type { VoiceStatus } from './voice'
import type { WorkflowsSnapshot } from './workflows'

export type RpcRequest = { id: number; method: string; args: unknown[] }
export type RpcResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }
export type RpcEvent =
  | { event: 'btw:changed'; payload: { chatId: string; entry: SideQuestion } }
  | { event: 'chats:push'; payload: WirePush }
  | { event: 'agents:changed'; payload: AgentRename[] }
  | { event: 'sidebar:changed'; payload: SidebarLayout }
  | { event: 'app:suggestedReplies'; payload: { on: boolean } } // the Suggested replies switch changed: every tab shows or hides them at once
  | { event: 'approvals:changed'; payload: { agent: string } }
  | { event: 'memory:changed'; payload: { agent: string } }
  | { event: 'todos:changed'; payload: { rev: number } } // the board changed (also at an unchanged rev: a task's own change)
  | { event: 'dispatch:changed'; payload: { chatId: string } }
  | { event: 'processes:changed'; payload: { chatId: string; running: number } }
  | { event: 'processes:output'; payload: { chatId: string; id: string; to: number } }
  | { event: 'routines:changed'; payload: RoutinesSnapshot }
  | { event: 'workflows:changed'; payload: WorkflowsSnapshot }
  | { event: 'inbox:changed'; payload: Record<string, never> } // no text: the tab refetches
  | { event: 'usage:changed'; payload: { chatId: string | null } }
  | { event: 'voice:changed'; payload: VoiceStatus }
  | { event: 'vault:changed'; payload: null }
  | { event: 'update:changed'; payload: UpdateStatus } // the check, a download or the last result changed; never the token
  | { event: 'audit:changed'; payload: Record<string, never> } // new records: an open Audit page offers to load them
  | { event: 'extensions:changed'; payload: null } // a server, plugin, skill or hook was written: refetch the loadout
  | { event: 'connectors:changed'; payload: null } // a switch, the switch-over or the catalog's servers changed: refetch
  | { event: 'channels:changed'; payload: null } // a channel's token, pairing, state or switches changed: Settings › Channels refetches
  | { event: 'notify:show'; payload: NotifyPayload }
  | { event: 'notify:clear'; payload: NotifyClear }
/**
 * Answered by the hub itself, before any handler and even while draining: the client sends it to learn whether the socket is
 * still alive when the browser gives no sign (a phone waking up, a network change on a half-open connection).
 */
export const PING_METHOD = 'rpc:ping'
/** Close code the server sends when the session is gone; the client must not reconnect. */
export const CLOSE_SIGNED_OUT = 4401
