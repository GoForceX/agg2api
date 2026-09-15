/**
 * Stacked request/error bars over the usage series. Plain SVG and CSS grid — the
 * bundle ships no chart library and makes no network request at runtime.
 */
import { formatClock, formatInt } from "../lib/format.ts"
import type { UsagePoint } from "../lib/types.ts"

const HEIGHT = 160

export function BarChart({ points, label }: { points: UsagePoint[]; label: string }) {
  const peak = points.reduce((max, point) => Math.max(max, point.requests), 0)

  if (points.length === 0) {
    return <p className="muted padded">No requests in this window.</p>
  }

  const axis = axisTicks(points)

  return (
    <figure className="chart">
      <div className="chart-plot" style={{ height: `${HEIGHT + 28}px` }}>
        <div className="chart-grid" aria-hidden="true">
          <span>{formatInt(peak)}</span>
          <span>{formatInt(Math.round(peak / 2))}</span>
          <span>0</span>
        </div>
        <ol className="chart-bars" aria-label={label}>
          {points.map((point) => {
            const total = peak === 0 ? 0 : point.requests / peak
            const errors = point.requests === 0 ? 0 : point.errors / peak
            return (
              <li key={point.ts} className="chart-bar">
                <span
                  className="chart-tooltip"
                  title={`${formatClock(point.ts)} · ${formatInt(point.requests)} requests · ${formatInt(point.errors)} errors`}
                />
                <span className="chart-track">
                  <span className="chart-fill" style={{ height: `${(total * 100).toFixed(2)}%` }}>
                    <span className="chart-errors" style={{ height: `${(errors * 100).toFixed(2)}%` }} />
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      </div>
      <div className="chart-axis" aria-hidden="true">
        {axis.map((tick) => (
          <span key={tick.ts}>{tick.text}</span>
        ))}
      </div>
      <figcaption className="chart-legend muted small">
        <span className="legend-swatch legend-requests" /> requests
        <span className="legend-swatch legend-errors" /> errors
      </figcaption>
    </figure>
  )
}

/** At most five evenly spaced time labels, so the axis stays readable when the window is dense. */
function axisTicks(points: UsagePoint[]): { ts: number; text: string }[] {
  const wanted = Math.min(5, points.length)
  const step = Math.max(1, Math.floor(points.length / wanted))
  const ticks: { ts: number; text: string }[] = []
  for (let index = 0; index < points.length; index += step) {
    const point = points[index]
    if (point !== undefined) ticks.push({ ts: point.ts, text: formatClock(point.ts) })
  }
  return ticks.slice(0, wanted)
}
