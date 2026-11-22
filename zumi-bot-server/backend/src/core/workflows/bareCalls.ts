import { spawn } from 'node:child_process'
import { MATERIAL_RULE } from '@zumibot/shared/workflowTemplate'
import { BARE_CALLS_MAX, CONDITION_TIMEOUT_MS, LLM_TIMEOUT_MS, OUTPUT_MAX, type Effort, type ModelAlias } from '@zumibot/shared/workflows'
import { parseRunCost, type RunCost } from '../usage/runCost'

export const LLM_SYSTEM = `Do what the prompt asks and answer with the result only.\n\n${MATERIAL_RULE}`
export const CONDITION_SYSTEM = `Answer the question about the material with yes or no, and give a one-sentence reason.\n\n${MATERIAL_RULE}`
export const CONDITION_SCHEMA =
  '{"type":"object","properties":{"answer":{"enum":["yes","no"]},"reason":{"type":"string"}},"required":["answer","reason"]}'

export const CALL_FAILED = 'The model call failed'
export const CALL_TIMED_OUT = 'The model call timed out'
export const CALL_STOPPED = 'Stopped'
export const NO_ANSWER = 'The model did not answer yes or no'

// Always the bare call: no tools, no settings, no MCP, no session file. The material rule is never left out.
const bare = (model: ModelAlias): string[] => [
  '-p',
  '--model',
  model,
  '--tools',
  '',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--output-format',
  'json'
]

export function llmArgs(model: ModelAlias, effort: Effort | undefined, system: string | undefined): string[] {
  return [...bare(model), ...(effort ? ['--effort', effort] : []), '--system-prompt', system ? `${system}\n\n${MATERIAL_RULE}` : LLM_SYSTEM]
}

export function conditionArgs(model: ModelAlias): string[] {
  return [...bare(model), '--json-schema', CONDITION_SCHEMA, '--system-prompt', CONDITION_SYSTEM]
}

export type BareResult =
  | { ok: true; text: string; answer?: 'yes' | 'no'; reason?: string; cost: RunCost | null; id: string | null }
  | { ok: false; limit: { resetsAt: number | null } | null; error: string }

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)

function parseJson(s: unknown): unknown {
  if (typeof s !== 'string') return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// The CLI's reset is epoch seconds (as in its rate_limit_event); a value that large is already milliseconds.
function resetMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  return v > 1e11 ? v : v * 1000
}

// A usage-limit end of a `--output-format json` call: an error result with status 429, or the CLI's usage-limit
// wording. Narrow on purpose: any other error waited out (a context limit, say) would only fail again after the reset.
export function limitOf(root: Obj): { resetsAt: number | null } | null {
  if (root.is_error !== true) return null
  const text = `${typeof root.result === 'string' ? root.result : ''} ${typeof root.subtype === 'string' ? root.subtype : ''}`
  if (root.api_error_status !== 429 && !/usage limit|hit your limit/i.test(text)) return null
  const info = asObj(root.rate_limit_info)
  return { resetsAt: resetMs(info?.resetsAt) ?? resetMs(root.resetsAt) }
}

interface Slot {
  grant(): void
  drop(): void
}

export interface BareCallsDeps {
  bin(): Promise<string | null>
  env(): Promise<NodeJS.ProcessEnv>
  cwd: string
  max?: number
  llmTimeoutMs?: number
  conditionTimeoutMs?: number
}

/** LLM and Condition steps: bare `claude` calls, at most `max` at once, the rest wait in order. */
export class BareCalls {
  private active = 0
  private readonly waiting: Slot[] = []
  private readonly stops = new Set<AbortController>()

  constructor(private readonly d: BareCallsDeps) {}

  llm(o: { model: ModelAlias; effort?: Effort; system?: string; prompt: string }, signal: AbortSignal): Promise<BareResult> {
    return this.call(llmArgs(o.model, o.effort, o.system), o.prompt, this.d.llmTimeoutMs ?? LLM_TIMEOUT_MS, signal)
  }

  condition(o: { model: ModelAlias; prompt: string }, signal: AbortSignal): Promise<BareResult> {
    return this.call(conditionArgs(o.model), o.prompt, this.d.conditionTimeoutMs ?? CONDITION_TIMEOUT_MS, signal, true)
  }

  stopAll(): void {
    for (const ac of [...this.stops]) ac.abort()
  }

  private async call(args: string[], prompt: string, timeoutMs: number, outer: AbortSignal, condition = false): Promise<BareResult> {
    const ac = new AbortController()
    this.stops.add(ac)
    const onOuter = (): void => ac.abort()
    if (outer.aborted) ac.abort()
    else outer.addEventListener('abort', onOuter)
    try {
      if (!(await this.acquire(ac.signal))) return { ok: false, limit: null, error: CALL_STOPPED }
      try {
        return await this.exec(args, prompt, timeoutMs, ac.signal, condition)
      } finally {
        this.release()
      }
    } finally {
      outer.removeEventListener('abort', onOuter)
      this.stops.delete(ac)
    }
  }

  // Resolves true with a slot, false when stopped while waiting; a granted slot goes straight to the next in line on release.
  private acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (this.active < (this.d.max ?? BARE_CALLS_MAX)) {
      this.active++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const slot: Slot = {
        grant: () => {
          signal.removeEventListener('abort', slot.drop)
          resolve(true)
        },
        drop: () => {
          const i = this.waiting.indexOf(slot)
          if (i >= 0) this.waiting.splice(i, 1)
          resolve(false)
        }
      }
      signal.addEventListener('abort', slot.drop, { once: true })
      this.waiting.push(slot)
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next)
      next.grant() // the slot passes on, so active stays
    else this.active--
  }

  private async exec(args: string[], prompt: string, timeoutMs: number, signal: AbortSignal, condition: boolean): Promise<BareResult> {
    let bin: string | null
    let env: NodeJS.ProcessEnv
    try {
      bin = await this.d.bin()
      env = await this.d.env()
    } catch {
      return { ok: false, limit: null, error: CALL_FAILED }
    }
    if (signal.aborted) return { ok: false, limit: null, error: CALL_STOPPED }
    if (!bin) return { ok: false, limit: null, error: CALL_FAILED }
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(bin, args, { cwd: this.d.cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
      } catch {
        return resolve({ ok: false, limit: null, error: CALL_FAILED })
      }
      let stdout = ''
      let done = false
      let ended: string | null = null // why the call was cut short, if it was
      const kill = (): void => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* gone */
        }
      }
      const finish = (r: BareResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(r)
      }
      const cut = (error: string): void => {
        ended = error
        kill()
        finish({ ok: false, limit: null, error })
      }
      const onAbort = (): void => cut(CALL_STOPPED)
      const timer = setTimeout(() => cut(CALL_TIMED_OUT), timeoutMs)
      signal.addEventListener('abort', onAbort)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (d: string) => {
        stdout += d
      })
      child.on('error', () => finish({ ok: false, limit: null, error: CALL_FAILED }))
      child.on('close', (code) => {
        if (ended !== null) return
        finish(this.result(stdout, code === 0, condition))
      })
      child.stdin?.on('error', () => {
        /* child died early */
      })
      child.stdin?.end(prompt)
    })
  }

  // Never puts CLI text or output into an error: only the fixed strings.
  private result(stdout: string, clean: boolean, condition: boolean): BareResult {
    const root = asObj(parseJson(stdout))
    const fail = (error: string): BareResult => ({ ok: false, limit: null, error })
    if (!root) return fail(CALL_FAILED)
    const limit = limitOf(root)
    if (limit) return { ok: false, limit, error: CALL_FAILED }
    if (!clean || root.is_error === true || typeof root.result !== 'string') return fail(CALL_FAILED)
    const cost = parseRunCost(root)
    const id = typeof root.uuid === 'string' ? root.uuid : null
    const text = root.result.slice(0, OUTPUT_MAX)
    if (!condition) return { ok: true, text, cost, id }
    const raw = asObj(root.structured_output)?.answer !== undefined ? asObj(root.structured_output) : asObj(parseJson(root.result))
    const answer = raw?.answer
    if (answer !== 'yes' && answer !== 'no') return fail(NO_ANSWER)
    const reason = typeof raw?.reason === 'string' ? raw.reason.slice(0, OUTPUT_MAX) : ''
    return { ok: true, text, answer, reason, cost, id }
  }
}
