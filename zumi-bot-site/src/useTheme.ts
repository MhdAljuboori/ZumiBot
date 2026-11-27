import { useEffect, useState } from 'react'

const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** The page follows the system until the theme button is pressed; the choice lasts for the visit. */
export function useTheme(): { dark: boolean; toggle: () => void } {
  const [forced, setForced] = useState<'light' | 'dark' | null>(null)
  const [systemDark, setSystemDark] = useState(() => darkQuery()?.matches ?? false)
  useEffect(() => {
    const mq = darkQuery()
    if (!mq) return
    const on = () => setSystemDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    if (forced) document.documentElement.dataset.theme = forced
    else delete document.documentElement.dataset.theme
  }, [forced])
  const dark = forced ? forced === 'dark' : systemDark
  return { dark, toggle: () => setForced(dark ? 'light' : 'dark') }
}
