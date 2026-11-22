import { useId, useState, type CSSProperties } from 'react'
import type { BotShape } from '@zumibot/shared/frontmatter'
// The app's own icon set, read from its source so the page always draws the shapes the app draws (Vite inlines the data).
import { EYE_SHIFT, SHAPE_PATHS, ZUMI_PATHS } from '../../zumi-bot-server/frontend/src/botShapes.ts'
import { AGENTS, type AgentColor, type AgentId, type Look, type Tilt } from './showcase.ts'

/** Every shape an agent can pick, in the app picker's order. */
export const SHAPES = Object.keys(SHAPE_PATHS) as BotShape[]

// As in the app's BotIcon: the shapes are drawn in a 100 box, placed in the 1024 view box the bob and tilt origins use.
const PLACE = 'translate(62 62) scale(9)'

export function Bot({
  shape,
  zumi = false,
  color,
  size,
  working = false,
  tilt = 'a',
  look = 0,
  asleep = false
}: {
  shape?: BotShape
  /** Zumi Bot's own Z, in its own color: the ZumiBot logo. */
  zumi?: boolean
  color?: AgentColor
  size: number
  working?: boolean
  tilt?: Tilt
  look?: Look
  /** Eyes shut to slits: the theme button in dark. */
  asleep?: boolean
}) {
  // Random per icon, like the app, so a row of working agents never bobs in step.
  const [timing] = useState(() => ({ duration: `${(0.9 + Math.random() * 0.6).toFixed(2)}s`, delay: `-${Math.random().toFixed(2)}s` }))
  const maskId = `eyes-${useId().replace(/[^\w-]/g, '')}`
  const paths = zumi ? ZUMI_PATHS : SHAPE_PATHS[shape ?? 'robot']
  const fill = zumi ? 'var(--bot-zumi)' : color ? `var(--agent-${color})` : 'var(--bot-fg)'
  const style = { '--bob-duration': timing.duration, '--bob-delay': timing.delay, '--eye-shift': `${EYE_SHIFT}px` } as CSSProperties
  const eyesStyle = { '--look': `${look * EYE_SHIFT}px` } as CSSProperties
  const eyesClass = asleep ? 'bot-eyes asleep' : 'bot-eyes'
  // Only an icon whose eyes move pays for drawing them apart from the body.
  const plain = !working && look === 0 && !asleep

  return (
    <svg
      className={working ? `bot working tilt-${tilt}` : 'bot'}
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      aria-hidden="true"
      style={style}
    >
      <g className="bot-bob">
        <g className="bot-tilt">
          <g transform={PLACE}>
            {plain ? (
              <path d={`${paths.body} ${paths.eyes}`} fill={fill} fillRule="evenodd" />
            ) : paths.filledEyes ? (
              <>
                <path d={paths.body} fill={fill} fillRule="evenodd" />
                <path className={eyesClass} style={eyesStyle} d={paths.eyes} fill={fill} />
              </>
            ) : (
              // The eyes are holes, so moving eyes are a moving cut: a mask, not a shape in the background's color.
              <>
                <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
                  <rect width="100" height="100" fill="white" />
                  <path className={eyesClass} style={eyesStyle} d={paths.eyes} fill="black" />
                </mask>
                <path d={paths.body} fill={fill} fillRule="evenodd" mask={`url(#${maskId})`} />
              </>
            )}
          </g>
        </g>
      </g>
    </svg>
  )
}

/** A demo agent's icon in its own shape, color and tilt rhythm. */
export function AgentBot({ id, size, working = false, look = 0 }: { id: AgentId; size: number; working?: boolean; look?: Look }) {
  const a = AGENTS[id]
  return <Bot shape={a.shape} color={a.color} tilt={a.tilt} size={size} working={working} look={look} />
}
