// Translates the control_response objects ChatService builds for the Claude CLI into the answer to ACP's
// `session/request_permission`. Only an explicit allow or deny selects an option; anything else cancels (never consent).

export type AcpPermissionOutcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }

const CANCELLED: AcpPermissionOutcome = { outcome: { outcome: 'cancelled' } }

const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null

// The first option of exactly this kind. allow_always and reject_always are never chosen: "always" is ZumiBot's own rule.
function pick(options: unknown, kind: 'allow_once' | 'reject_once'): string | null {
  if (!Array.isArray(options)) return null
  for (const o of options) {
    const opt = obj(o)
    if (opt?.kind === kind && typeof opt.optionId === 'string') return opt.optionId
  }
  return null
}

export function acpPermissionAnswer(controlResponse: object, options: unknown): AcpPermissionOutcome {
  const r = obj(obj(controlResponse)?.response)
  const behavior = r?.subtype === 'success' ? obj(r.response)?.behavior : undefined
  if (behavior !== 'allow' && behavior !== 'deny') return CANCELLED
  const optionId = pick(options, behavior === 'allow' ? 'allow_once' : 'reject_once')
  return optionId === null ? CANCELLED : { outcome: { outcome: 'selected', optionId } }
}
