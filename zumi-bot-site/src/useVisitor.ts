import { useEffect, useState } from 'react'
import { archFromHint, detectVisitor, type Arch, type Visitor } from './downloads.ts'

// Chromium's client hints; other browsers have none, and the user agent alone has to do.
interface UaData {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>
}

/** The visitor's system, at once from the user agent, then their CPU when the browser will say (Chromium only). */
export function useVisitor(): { visitor: Visitor; arch: Arch | null } {
  const [visitor] = useState<Visitor>(() => {
    const ua = (navigator as Navigator & { userAgentData?: UaData }).userAgentData
    return detectVisitor({ userAgent: navigator.userAgent, platform: ua?.platform, maxTouchPoints: navigator.maxTouchPoints })
  })
  const [arch, setArch] = useState<Arch | null>(null)

  useEffect(() => {
    const ua = (navigator as Navigator & { userAgentData?: UaData }).userAgentData
    if (!ua?.getHighEntropyValues) return
    let live = true
    ua.getHighEntropyValues(['architecture', 'bitness'])
      .then((v) => {
        if (live) setArch(archFromHint(v.architecture, v.bitness))
      })
      .catch(() => {}) // no hint: the default build stays featured
    return () => {
      live = false
    }
  }, [])

  return { visitor, arch }
}
