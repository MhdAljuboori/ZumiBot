import { useEffect, useId, useState, type CSSProperties } from 'react'
import { EYE_SHIFT, SHAPE_PATHS, ZUMI_PATHS } from '../botShapes'
import { agentColor, bobTiming, nextTilt, shapeOf, TILT_EVERY_MS } from '../state/bot'

// The shapes are drawn in a 100 box; this places them in the 1024 view box the bob and tilt origins (styles/bot-icon.css) use,
// with room left so a tilted, bobbing icon is not clipped.
const PLACE = 'translate(62 62) scale(9)'

export function BotIcon({
  icon,
  color,
  working,
  size,
  builtIn = false
}: {
  icon: string | null
  color: string | null
  working: boolean
  size: number
  builtIn?: boolean
}) {
  const [timing] = useState(() => bobTiming(Math.random))
  // useId's characters are not all safe inside url(#…).
  const maskId = `bot-eyes-${useId().replace(/[^\w-]/g, '')}`
  const [tilt, setTilt] = useState(0)

  useEffect(() => {
    if (!working) {
      setTilt(0)
      return
    }
    const id = setInterval(() => {
      // Checked per tick so enabling reduce-motion mid-work stops the tilt.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setTilt(0)
      else setTilt((t) => nextTilt(t, Math.random))
    }, TILT_EVERY_MS)
    return () => clearInterval(id)
  }, [working])

  // Zumi Bot always has its own shape and color. Otherwise the agent's color, or the text color without one.
  const fill = builtIn ? 'var(--bot-zumi)' : (agentColor(color) ?? 'var(--bot-fg)')
  const shape = builtIn ? ZUMI_PATHS : SHAPE_PATHS[shapeOf(icon)]
  const style = { '--bob-duration': timing.duration, '--bob-delay': timing.delay, '--eye-shift': `${EYE_SHIFT}px` } as CSSProperties

  return (
    <svg
      // Not `working`: that is a thread rule (a flex row aligned to the start), which pinned a working icon to the top of
      // its tile in every flex parent.
      className={working ? 'bot bot-working' : 'bot'}
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      aria-hidden="true"
      style={style}
    >
      <g className="bot-bob">
        <g className="bot-tilt" style={{ transform: `rotate(${tilt}deg)` }}>
          <g transform={PLACE}>
            {!working ? (
              <path d={`${shape.body} ${shape.eyes}`} fill={fill} fillRule="evenodd" />
            ) : shape.filledEyes ? (
              <>
                <path d={shape.body} fill={fill} fillRule="evenodd" />
                <path className="bot-eyes" d={shape.eyes} fill={fill} />
              </>
            ) : (
              // The eyes are holes, so a moving eye is a moving cut: a mask, not a shape drawn in the background's color,
              // since the background differs per row, hover and theme. Only a working icon pays for the mask.
              <>
                <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
                  <rect width="100" height="100" fill="white" />
                  <path className="bot-eyes" d={shape.eyes} fill="black" />
                </mask>
                <path d={shape.body} fill={fill} fillRule="evenodd" mask={`url(#${maskId})`} />
              </>
            )}
          </g>
        </g>
      </g>
    </svg>
  )
}
