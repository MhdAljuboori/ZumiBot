const COPY_SUFFIX = /\s\((\d+)\)$/

/**
 * The name of a copy: "API room" -> "API room (2)", the first number no name in `taken` has. A trailing "(n)" is
 * bumped, not stacked. The base is cut so the result fits `max` with its number showing; a blank base is `fallback`.
 */
export function copyTitle(title: string, taken: readonly string[], max: number, fallback: string): string {
  let base = title.trim()
  let n = 2
  const m = COPY_SUFFIX.exec(base)
  if (m) {
    base = base.slice(0, m.index).trim()
    n = Number(m[1]) + 1
  }
  if (!base) base = fallback
  const used = new Set(taken)
  for (; ; n++) {
    const suffix = ` (${n})`
    // Cut the base, not the suffix, so the number always shows.
    const cut = base.slice(0, Math.max(1, max - suffix.length)).trimEnd()
    const candidate = cut + suffix
    if (!used.has(candidate)) return candidate
  }
}
