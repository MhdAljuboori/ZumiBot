import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from './errors'
import { liveLines, nextExpiry, pressAnswer, settleAnswer, type AnsweredLine } from './state/inbox'

/**
 * The Inbox's answered lines and failed answers. Kept by the app, not the page: a send still on its way must keep its
 * card held when the chip hides the Waiting section or the page is left and opened again, or the card could be pressed
 * twice. The rules are pure (state/inbox.ts); this only runs the clock.
 */
export function useInboxHolds(): {
  lines: AnsweredLine[]
  errors: Record<string, string>
  hold: (line: AnsweredLine, sending: Promise<void>) => void
} {
  const [lines, setLines] = useState<AnsweredLine[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    const wait = nextExpiry(lines, Date.now())
    if (wait === null) return
    const t = setTimeout(() => setLines((prev) => liveLines(prev, Date.now())), wait)
    return () => clearTimeout(t)
  }, [lines])
  const hold = useCallback((line: AnsweredLine, sending: Promise<void>) => {
    const key = line.key
    setErrors(({ [key]: _old, ...rest }) => rest)
    setLines((prev) => pressAnswer(liveLines(prev, Date.now()), line))
    sending.then(
      () => setLines((prev) => settleAnswer(prev, key, true, Date.now())),
      (e: unknown) => {
        setLines((prev) => settleAnswer(prev, key, false, Date.now()))
        setErrors((prev) => ({ ...prev, [key]: errorMessage(e) }))
      }
    )
  }, [])
  return { lines, errors, hold }
}
