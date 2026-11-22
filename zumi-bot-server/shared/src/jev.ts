/**
 * enabled is the master switch: off, nothing calls Jev and ZumiBot behaves as it did before Jev. The others pick
 * what Jev may decide while it is on.
 */
export interface JevSwitches {
  enabled: boolean
  moderator: boolean
  approvalRisk: boolean
  agentSuggest: boolean
}
/** The key itself never leaves the server: the UI learns only whether one is set. */
export interface JevStatus extends JevSwitches {
  keySet: boolean
}
export type JevCheck = { ok: true } | { ok: false; error: string }

/** Jev's guess of how risky a pending tool call is; a hint on the card, never an answer to it. */
export type ApprovalRisk = 'low' | 'medium' | 'high'

export const JEV_KEY_MAX = 512
export const JEV_CONDITION_MAX = 500
/** A new chat's draft gets an agent suggestion from this many characters on. */
export const SUGGEST_MIN_CHARS = 12

/** Jev runs only with a key and the master switch on; a feature also needs its own switch. */
export const jevActive = (s: JevStatus): boolean => s.enabled && s.keySet
