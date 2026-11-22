import { OUTPUT_MAX, TRANSFORM_PATH_MAX, spaced, type TransformField } from './workflows'

// A Transform step picks fields out of JSON by path. Pure, so the editor's Run step and the server read paths alike.

export type PathSeg = string | number | '*'

export const NOT_JSON = 'The input is not JSON'
export const transformTooBig = (): string => `The output is over ${spaced(OUTPUT_MAX)} characters`

/**
 * `a.b.0.c`, `a[0].c`, `a[].c`, `a[*].c` and `a.*.c` (each element or value), an optional leading `$`; '' is the whole
 * value. Null for a path it can't read (an empty segment, a stray bracket).
 */
export function parsePath(path: string): PathSeg[] | null {
  let p = path.trim()
  if (p.length > TRANSFORM_PATH_MAX) return null
  if (p === '$') p = ''
  else if (p.startsWith('$.')) p = p.slice(2)
  else if (p.startsWith('$[')) p = p.slice(1)
  // Brackets become dot segments: [] and [*] map, [n] indexes.
  p = p.replace(/\[(\*?)\]/g, '.*').replace(/\[(\d+)\]/g, '.$1')
  if (p.startsWith('.')) p = p.slice(1)
  if (p === '') return []
  if (/[[\]]/.test(p)) return null
  const segs = p.split('.')
  if (segs.some((s) => s === '')) return null
  return segs.map((s): PathSeg => (s === '*' ? '*' : /^\d+$/.test(s) && s.length < 10 ? Number(s) : s))
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// One step down from each value; own keys only, so `constructor` reads nothing inherited.
function step(values: unknown[], seg: PathSeg): unknown[] {
  const out: unknown[] = []
  for (const v of values) {
    if (seg === '*') {
      if (Array.isArray(v)) out.push(...v)
      else if (isObj(v)) out.push(...Object.values(v))
    } else if (Array.isArray(v) && typeof seg === 'number') {
      if (seg < v.length) out.push(v[seg])
    } else if (isObj(v)) {
      const key = String(seg)
      if (Object.hasOwn(v, key)) out.push(v[key])
    }
  }
  return out
}

/** What a path reads from a value: one value, a list (once a `*` maps), or nothing found. */
export function readPath(value: unknown, segs: PathSeg[]): { found: true; value: unknown } | { found: false } {
  let values = [value]
  let many = false
  for (const seg of segs) {
    if (seg === '*') many = true
    values = step(values, seg)
    if (!many && values.length === 0) return { found: false }
  }
  if (many) return { found: true, value: values }
  return values.length ? { found: true, value: values[0] } : { found: false }
}

// A value as one line: text as is (its line breaks made spaces, so one value stays one line), JSON for the rest.
function lineOf(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const text = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
  return text.replace(/\r?\n|\r/g, ' ')
}

export type TransformResult = { ok: true; output: string; missing: string[] } | { ok: false; error: string; missing: string[] }

/** The step's output for its input. A field whose path finds nothing is null (json) or left out (lines), and listed in missing. */
export function runTransform(input: string, fields: TransformField[], format: 'json' | 'lines'): TransformResult {
  let data: unknown
  try {
    data = JSON.parse(input)
  } catch {
    return { ok: false, error: NOT_JSON, missing: [] }
  }
  const missing: string[] = []
  const found = fields.map((f) => {
    const segs = parsePath(f.path)
    const r = segs ? readPath(data, segs) : { found: false as const }
    if (!r.found && !missing.includes(f.path)) missing.push(f.path)
    return { name: f.name, ...r }
  })
  let output: string
  if (format === 'json') {
    // fromEntries defines own keys, so a field named __proto__ is a plain key, not the object's prototype.
    output = JSON.stringify(Object.fromEntries(found.map((f) => [f.name, f.found ? f.value : null])), null, 2)
  } else {
    const lines: string[] = []
    for (const f of found) {
      if (!f.found) continue
      for (const v of Array.isArray(f.value) ? f.value : [f.value]) {
        const line = lineOf(v)
        if (line !== null) lines.push(line)
      }
    }
    output = lines.join('\n')
  }
  if (output.length > OUTPUT_MAX) return { ok: false, error: transformTooBig(), missing }
  return { ok: true, output, missing }
}

/** A field name from its path's last named segment, for a field the user just added a path to. */
export function nameFromPath(path: string): string {
  const segs = parsePath(path) ?? []
  const last = [...segs].reverse().find((s): s is string => typeof s === 'string' && s !== '*')
  return (last ?? 'value').slice(0, 64)
}
