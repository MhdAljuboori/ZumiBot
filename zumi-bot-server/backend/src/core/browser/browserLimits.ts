import { STYLE_VALUE_MAX } from './browserStyle'

/**
 * The most an agent gets of each page string. The worker hands strings over up to SCRUB_MARGIN longer, so a vault secret a
 * limit falls inside is still whole when the manager scrubs it; the manager cuts to these lengths only after the scrub
 * (cutBrowserResult). A cut made first would leave the secret's start, which no scrub can recognize without becoming an oracle.
 */
export const BROWSER_CUTS = {
  role: 80,
  name: 256,
  text: 256,
  pageText: 32000,
  title: 500,
  url: 8192,
  dialog: 2000,
  styleValue: STYLE_VALUE_MAX,
  styleProps: 40
} as const
/** The longest secret a page could show: an API key value is at most 8 000 characters. */
export const SECRET_MAX = 8000
/** At least the longest secret, so one a limit falls inside is still whole when the manager scrubs it. */
export const SCRUB_MARGIN = 8192
/**
 * The most characters the worker hands over for one observation, page text and element strings together: the scrub runs on
 * the server's event loop once per secret over all of it. A page under it reads exactly as before; past it, a string longer
 * than its limit is dropped rather than sent without its margin (browserObservation.ts).
 */
export const BROWSER_PAYLOAD = 1_000_000
/**
 * Of that, what element strings may carry past their limits. The rest never needs more than what is left: the page text with
 * its margin, the 32 000 the elements' kept lengths share, and 256 refs (36) with frame labels (253).
 */
export const MARGIN_PAYLOAD = BROWSER_PAYLOAD - (BROWSER_CUTS.pageText + SCRUB_MARGIN) - BROWSER_CUTS.pageText - 256 * (36 + 253)

/**
 * What one element's strings take of the observation's 32 000 characters, from their lengths as the worker hands them over: the
 * lengths an agent gets of them. The worker budgets with it, and the manager uses it to know where the worker cut the page text.
 */
export function describedCost(length: { role: number; name: number; text: number }): number {
  return Math.min(length.role, BROWSER_CUTS.role) + Math.min(length.name, BROWSER_CUTS.name) + Math.min(length.text, BROWSER_CUTS.text)
}
/** How far the worker reads the page text, given what its elements cost: what they leave of the 32 000, plus the margin. */
export const pageTextCap = (used: number): number => BROWSER_CUTS.pageText - used + SCRUB_MARGIN
