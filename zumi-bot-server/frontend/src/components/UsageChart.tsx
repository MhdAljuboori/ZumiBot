import { formatMetric, type Bar, type UsageMetric } from '../state/usageReport'

const H = 100
const STEP = 10 // viewBox units per day; the SVG stretches to the box, so bars shrink on a phone

/** One bar per day, exact solid and estimated hatched on top. Hand-drawn SVG: no chart library. */
export function UsageChart({ bars, metric }: { bars: Bar[]; metric: UsageMetric }) {
  if (bars.length === 0) return <div className="usg-chart-empty">No daily data yet</div>
  return (
    <div className="usg-chart">
      <svg
        viewBox={`0 0 ${bars.length * STEP} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={metric === 'cost' ? 'Daily cost' : 'Daily tokens'}
      >
        <defs>
          <pattern id="usg-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="3" height="3" className="usg-hatch-bg" />
            <rect width="1.2" height="3" className="usg-hatch-line" />
          </pattern>
        </defs>
        {bars.map((b, i) => {
          const eh = b.exactHeight * H
          const sh = b.estimatedHeight * H
          const x = i * STEP + 1
          return (
            <g
              key={b.day}
              data-day={b.day}
              data-tip={`${b.day}: ${formatMetric(b.exact + b.estimated, metric)}${b.estimated > 0 ? ` (${formatMetric(b.estimated, metric)} estimated)` : ''}`}
            >
              <rect x={i * STEP} y={0} width={STEP} height={H} fill="transparent" />
              {eh > 0 && <rect className="usg-bar-exact" x={x} y={H - eh} width={STEP - 2} height={eh} />}
              {sh > 0 && <rect className="usg-bar-est" x={x} y={H - eh - sh} width={STEP - 2} height={sh} fill="url(#usg-hatch)" />}
            </g>
          )
        })}
      </svg>
      <div className="usg-chart-axis">
        <span>{bars[0].day}</span>
        <span>{bars[bars.length - 1].day}</span>
      </div>
    </div>
  )
}
