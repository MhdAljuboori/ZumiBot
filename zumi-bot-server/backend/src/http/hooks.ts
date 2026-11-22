import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SECRET_HEADER, WEBHOOK_CALLS_PER_MIN, WEBHOOK_MAX_BYTES, type WebhookCall } from '@zumibot/shared/routines'
import type { Limiter } from '../auth/rateLimit'
import { clientIp } from '../auth/guard'
import { MIN_SECRET_LENGTH, secretMatches, type HookFile } from '../core/hooks/hookFile'
import type { RoutineRunner } from '../core/routines/routineRunner'
import type { RoutineStore } from '../core/routines/routineStore'
import type { WorkflowRunner } from '../core/workflows/workflowRunner'
import type { WorkflowStore } from '../core/workflows/workflowStore'
import { readBody } from './body'
import { sendJson } from './headers'

/** One owner of hooks (routines, workflows): its hook file, and what a valid, rate-checked call does. */
export interface HookTarget {
  hooks: Pick<HookFile, 'hook' | 'recordCall'>
  fire(id: string, call: WebhookCall): Promise<{ status: number; body: Record<string, unknown> }>
}

export interface HookDeps {
  targets: HookTarget[]
  badSecrets: Limiter // its own instance, never the login one
  now(): number
}

export const SIGNATURE_HEADER = 'x-hub-signature-256'
const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/

/** GitHub's scheme: `sha256=<hex HMAC-SHA256 of the exact raw body>`; equal-length buffers, constant-time compare. */
export function signatureMatches(secret: string, raw: Buffer, header: unknown): boolean {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH || typeof header !== 'string') return false
  const m = SIGNATURE.exec(header)
  if (!m) return false
  return timingSafeEqual(Buffer.from(m[1]!, 'hex'), createHmac('sha256', secret).update(raw).digest())
}

/** The routines' side of a call: the routine-only checks that used to sit in the handler, unchanged. */
export function routineHookTarget(d: {
  store: Pick<RoutineStore, 'hook' | 'recordCall' | 'get'>
  runner: Pick<RoutineRunner, 'run'>
}): HookTarget {
  return {
    hooks: d.store,
    async fire(id, call) {
      const routine = await d.store.get(id)
      if (!routine || routine.trigger.kind !== 'webhook') return { status: 202, body: { status: 'test call captured' } }
      if (!routine.enabled) return { status: 409, body: { error: 'Routine is disabled' } }
      const run = await d.runner.run(routine, 'webhook', { call })
      return { status: 202, body: run.status === 'skipped' ? { runId: run.id, skipped: true } : { runId: run.id } }
    }
  }
}

/** The workflows' side of a call, answered as a routine's is. A filtered-out call is a skipped run, still a 202. */
export function workflowHookTarget(d: { store: Pick<WorkflowStore, 'hooks' | 'get'>; runner: Pick<WorkflowRunner, 'run'> }): HookTarget {
  return {
    hooks: d.store.hooks,
    async fire(id, call) {
      const workflow = await d.store.get(id)
      if (!workflow || workflow.trigger.kind !== 'webhook') return { status: 202, body: { status: 'test call captured' } }
      if (!workflow.enabled) return { status: 409, body: { error: 'Workflow is disabled' } }
      const run = await d.runner.run(workflow, 'webhook', { call })
      return { status: 202, body: run.status === 'skipped' ? { runId: run.id, skipped: true } : { runId: run.id } }
    }
  }
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const ID = /^[A-Za-z0-9-]{1,64}$/
const WINDOW_MS = 60_000

// Repeated keys keep the first value; entries() + fromEntries keeps a "__proto__" key an own property.
function firstValues(params: URLSearchParams): Record<string, string> {
  const seen = new Map<string, string>()
  for (const [k, v] of params) if (!seen.has(k)) seen.set(k, v)
  return Object.fromEntries(seen)
}

const MAX_JSON_DEPTH = 64

// Scans the raw text, not the parsed value: no recursion, and deep nesting never reaches JSON.parse.
function tooDeep(text: string): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[' || c === '{') {
      if (++depth > MAX_JSON_DEPTH) return true
    } else if (c === ']' || c === '}') depth--
  }
  return false
}

type Parsed = { ok: true; body: unknown } | { ok: false; status: 400 | 415 }

function parseBody(raw: Buffer, contentType: string | undefined): Parsed {
  if (raw.length === 0) return { ok: true, body: null }
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const text = raw.toString('utf8')
  if (type === 'application/json') {
    if (tooDeep(text)) return { ok: false, status: 400 }
    try {
      return { ok: true, body: JSON.parse(text) }
    } catch {
      return { ok: false, status: 400 }
    }
  }
  if (type === 'application/x-www-form-urlencoded') return { ok: true, body: firstValues(new URLSearchParams(text)) }
  if (type === 'text/plain') return { ok: true, body: text }
  return { ok: false, status: 415 }
}

export function createHookHandler(d: HookDeps): (req: IncomingMessage, res: ServerResponse, id: string) => Promise<void> {
  const recent = new Map<string, number[]>() // hook id -> times of valid calls

  // Drops expired times first, so an idle hook's entry does not linger.
  function overLimit(hookId: string, now: number): boolean {
    const live = (recent.get(hookId) ?? []).filter((t) => now - t < WINDOW_MS)
    if (live.length >= WEBHOOK_CALLS_PER_MIN) {
      recent.set(hookId, live)
      return true
    }
    live.push(now)
    recent.set(hookId, live)
    return false
  }

  // Ids are random, so at most one target holds a given id.
  async function find(id: string): Promise<{ target: HookTarget; secret: string } | null> {
    if (!ID.test(id)) return null
    for (const target of d.targets) {
      const hook = await target.hooks.hook(id)
      if (hook) return { target, secret: hook.secret }
    }
    return null
  }

  return async (req, res, id) => {
    const ip = clientIp(req)
    if (!d.badSecrets.check(ip).allowed) return sendJson(res, 429, { error: 'Too many requests' })

    const unauthorized = (): void => {
      d.badSecrets.fail(ip)
      sendJson(res, 401, { error: 'Unauthorized' })
    }
    const given = req.headers[SECRET_HEADER]
    const signature = req.headers[SIGNATURE_HEADER]
    const found = await find(id)
    // Wrong id, no hook, a wrong secret and a bad signature all answer alike, so ids cannot be probed.
    if (!found) return unauthorized()
    const { target, secret } = found
    let raw: Buffer | null = null
    // The header form keeps the old order: checked before any body is read.
    if (given !== undefined) {
      if (typeof given !== 'string' || !secretMatches(secret, given)) return unauthorized()
    } else if (signature === undefined) return unauthorized()

    const method = (req.method ?? 'GET').toUpperCase()
    const declared = Number(req.headers['content-length'])
    const tooBig = Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES
    if (given !== undefined) {
      if (!METHODS.has(method)) return sendJson(res, 405, { error: 'Method not allowed' })
      // Connection: close, so an oversized body is never read; the socket goes down after the answer.
      if (tooBig) return sendJson(res, 413, { error: 'Payload too large' }, { Connection: 'close' })
      raw = await readBody(req, WEBHOOK_MAX_BYTES)
      if (raw === null) return sendJson(res, 413, { error: 'Payload too large' })
    } else {
      // A signature needs the body first. Until it checks out nothing may differ from an unknown id (no 405, no 413).
      if (tooBig) return unauthorized()
      raw = await readBody(req, WEBHOOK_MAX_BYTES)
      if (raw === null || !signatureMatches(secret, raw, signature)) return unauthorized()
      if (!METHODS.has(method)) return sendJson(res, 405, { error: 'Method not allowed' })
    }

    const parsed = parseBody(raw, req.headers['content-type'])
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.status === 400 ? 'Invalid JSON' : 'Unsupported content type' })

    const now = d.now()
    const query = firstValues(new URL(req.url ?? '/', 'http://localhost').searchParams)
    const call: WebhookCall = { method, query, body: parsed.body, receivedAt: now }
    // The body may have taken minutes: re-check the secret against the store, so a rotation or removal meanwhile wins.
    if (!(await target.hooks.recordCall(id, typeof given === 'string' ? given : secret, call))) return unauthorized()

    if (overLimit(id, now)) return sendJson(res, 429, { error: 'Too many requests' })
    const out = await target.fire(id, call)
    sendJson(res, out.status, out.body)
  }
}
