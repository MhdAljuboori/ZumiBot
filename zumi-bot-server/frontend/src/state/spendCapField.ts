import { SPEND_CAP_MAX, parseSpendCap } from '@zumibot/shared/spendCaps'

/** What a cap field's text means: empty is no cap, an amount is the cap, anything else an error the field shows (and saves nothing new). */
export function capField(text: string): { value: number | null; error: string | null } {
  if (text.trim() === '') return { value: null, error: null }
  const value = parseSpendCap(text)
  return value === null
    ? { value: null, error: `Enter an amount from $0.01 to $${SPEND_CAP_MAX.toLocaleString('en-US')}` }
    : { value, error: null }
}

/** A saved cap as the field shows it: "5", "2.50"; none is empty. */
export const capText = (v: number | null | undefined): string =>
  v === null || v === undefined ? '' : Number.isInteger(v) ? String(v) : v.toFixed(2)

/** Whether the field's text already means this value, so a value set from outside need not replace what the user typed. */
export const textMeans = (text: string, v: number | null): boolean => {
  const f = capField(text)
  return f.error === null && f.value === v
}
