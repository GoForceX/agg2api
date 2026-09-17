/**
 * Stacked request/error bars over the usage series.
 *
 * Hand-drawn rather than charted: the gateway serves this bundle from the binary it
 * was compiled into, and a charting library would add more to the download than the
 * whole console weighs today. The series is a fixed-width histogram, which is a
 * handful of divs.
 */
import { cn } from "cn"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { BarChartIcon } from "lucide-react"
import { COPY } from "@/lib/copy.ts"
import { formatClock, formatInt } from "@/lib/format.ts"
import type { UsagePoint } from "@/lib/types.ts"

const HEIGHT = 160

export function BarChart({ points, label }: { points: UsagePoint[]; label: string }) {
  const peak = points.reduce((max, point) => Math.max(max, point.requests), 0)

  if (points.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BarChartIcon />
          </EmptyMedia>
          <EmptyTitle>{COPY.chart.noRequests}</EmptyTitle>
          <EmptyDescription>{label}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <figure className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="flex flex-col justify-between py-px text-right text-xs text-muted-foreground tabular-nums">
          <span>{formatInt(peak)}</span>
          <span>{formatInt(Math.round(peak / 2))}</span>
          <span>0</span>
        </div>
        {/* Bars are capped and centred: with a sparse window there may be one bucket, and
            a single full-width slab reads as a rendering fault rather than as one column. */}
        <ol
          className="flex flex-1 items-end justify-center gap-px"
          style={{ height: `${HEIGHT}px` }}
          aria-label={label}
        >
          {points.map((point) => {
            const total = peak === 0 ? 0 : point.requests / peak
            const errors = peak === 0 ? 0 : point.errors / peak
            return (
              <li
                key={point.ts}
                className="group relative flex max-w-16 min-w-0.5 flex-1 items-end"
                style={{ height: `${HEIGHT}px` }}
                title={COPY.chart.tooltip(formatClock(point.ts), formatInt(point.requests), formatInt(point.errors))}
              >
                <span
                  className="w-full rounded-t-[2px] bg-primary/70"
                  style={{ height: `${(total * 100).toFixed(2)}%` }}
                >
                  {/* Errors stack at the top of the bar so the total height still reads as requests. */}
                  <span
                    className="block w-full rounded-t-[2px] bg-destructive"
                    style={{ height: total === 0 ? "0%" : `${((errors / total) * 100).toFixed(2)}%` }}
                  />
                </span>
              </li>
            )
          })}
        </ol>
      </div>
      <div className="flex justify-between pl-10 text-xs text-muted-foreground">
        {axisTicks(points).map((tick) => (
          <span key={tick.ts}>{tick.text}</span>
        ))}
      </div>
      <figcaption className="flex items-center gap-4 pl-10 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-sm bg-primary/70")} /> {COPY.chart.requests}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-sm bg-destructive")} /> {COPY.chart.errors}
        </span>
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
