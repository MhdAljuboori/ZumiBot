// Translates the control_response objects ChatService builds for the Claude CLI into Codex's JSON-RPC answers.

export type CodexRequestKind = 'command' | 'fileChange' | 'permissions' | 'elicitation' | 'userInput'
export type CodexAnswer = { result: unknown } | { error: { code: number; message: string } }

const err = (code: number, message: string): CodexAnswer => ({ error: { code, message } })

const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null

// The card answers by question text (a string, or a list when several were picked); Codex wants them by question id.
// Ids come from the mapped questions' `codexId`, and only ones the request really asked are answered.
function questionAnswers(updatedInput: unknown, request: any): Record<string, { answers: string[] }> {
  const input = obj(updatedInput)
  const given = obj(input?.answers)
  if (!input || !given || !Array.isArray(input.questions)) return {}
  const asked = Array.isArray(request?.questions) ? new Set(request.questions.map((q: any) => q?.id)) : null
  const out: Record<string, { answers: string[] }> = {}
  for (const q of input.questions) {
    const id = obj(q)?.codexId
    if (typeof id !== 'string' || (asked && !asked.has(id)) || typeof q.question !== 'string' || !Object.hasOwn(given, q.question)) continue
    const v = given[q.question]
    const list = (Array.isArray(v) ? v : [v]).filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    if (list.length) out[id] = { answers: list }
  }
  return out
}

export function codexAnswer(kind: CodexRequestKind, controlResponse: object, request: any): CodexAnswer {
  const r = (controlResponse as any)?.response
  if (r?.subtype === 'error') return err(-32603, typeof r.error === 'string' ? r.error : 'Request failed')
  const behavior = r?.subtype === 'success' ? r.response?.behavior : undefined
  // Anything but an explicit allow or deny is never taken as consent.
  if (behavior !== 'allow' && behavior !== 'deny') return err(-32603, 'Unrecognised answer')
  const allow = behavior === 'allow'
  switch (kind) {
    case 'userInput':
      // Skip (deny) answers with no answers: the model carries on without them.
      return { result: { answers: allow ? questionAnswers(r.response?.updatedInput, request) : {} } }
    case 'command':
    case 'fileChange':
      return { result: { decision: allow ? 'accept' : 'decline' } }
    case 'permissions':
      return { result: { permissions: allow ? request?.permissions : {}, scope: 'turn' } }
    case 'elicitation':
      return { result: { action: allow ? 'accept' : 'decline', content: null, _meta: null } }
  }
}
