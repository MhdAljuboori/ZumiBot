/** Widths are measured from fractional boxes: a row within this much of fitting fits. */
export const FIT_SLACK = 1

/**
 * Whether the picker row under the message box shows its compact layout next. `need` is the width the full row took
 * the last time it was measured (just now when it shows), or null when that is no longer known (its content changed
 * while compact), which tries the full row again so it can be measured. Going back waits for the whole `need`, so the
 * two layouts never flip back and forth at one width.
 */
export function nextCompact(need: number | null, available: number): boolean {
  if (need === null) return false
  return need > available + FIT_SLACK
}
