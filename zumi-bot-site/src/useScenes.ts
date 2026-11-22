import { useEffect, useState } from 'react'
import { SCENES, type SceneId } from './showcase.ts'

/**
 * Which scenes are on screen (their animations run only then, styles.css `.in`) and which one sits in the middle of the
 * screen (the header cast follows it). Reads every element with a `data-scene`.
 */
export function useScenes(): { visible: ReadonlySet<SceneId>; active: SceneId } {
  const [visible, setVisible] = useState<ReadonlySet<SceneId>>(() => new Set())
  const [active, setActive] = useState<SceneId>('hero')

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(new Set(SCENES))
      return
    }
    const sceneOf = (el: Element): SceneId => el.getAttribute('data-scene') as SceneId
    const shown = new IntersectionObserver(
      (entries) =>
        setVisible((prev) => {
          const next = new Set(prev)
          for (const e of entries) {
            if (e.isIntersecting) next.add(sceneOf(e.target))
            else next.delete(sceneOf(e.target))
          }
          return next
        }),
      { threshold: 0.15 }
    )
    // A thin band across the middle of the viewport: the scene crossing it is the one being read.
    const middle = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(sceneOf(e.target))
      },
      { rootMargin: '-45% 0px -50% 0px' }
    )
    const els = document.querySelectorAll('[data-scene]')
    els.forEach((el) => {
      shown.observe(el)
      middle.observe(el)
    })
    return () => {
      shown.disconnect()
      middle.disconnect()
    }
  }, [])

  return { visible, active }
}
