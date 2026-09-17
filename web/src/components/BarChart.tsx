/**
 * Stacked request/error bars over the usage series.
 *
 * Hand-drawn rather than charted: the gateway serves this bundle from the binary it was
 * compiled into, and a charting library would add more to the download than the whole
 * console weighs today. The series is a fixed-width histogram, which is a handful of
 * divs and one overlay.
 *
 * The hover readout is a single absolutely-positioned panel driven by a pointer handler
 * on the plot, not a `<title>` per bar: a native tooltip takes about a second to appear,
 * cannot be styled, and cannot show a column of aligned figures.
 */
import { useMemo, useState } from "react"
import { BarChartIcon } from "lucide-react"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { COPY } from "@/lib/copy.ts"
import { formatClock, formatCompact, formatCost, formatInt, formatMs, formatTps } from "@/lib/format.ts"
import { cn } from "cn"
import type { UsagePoint } from "@/lib/types.ts"

const HEIGHT = 180

export function BarChart({ points, label }: { points: UsagePoint[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const peak = useMemo(() => points.reduce((max, point) => Math.max(max, point.requests), 0), [points])
  const ticks = useMemo(() => axisTicks(points), [points])

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

  const active = hover === null ? null : (points[hover] ?? null)

  return (
    <figure className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div
          className="flex flex-col justify-between py-px text-right text-xs text-muted-foreground tabular-nums"
          style={{ height: `${HEIGHT}px` }}
        >
          <span>{formatInt(peak)}</span>
          <span>{formatInt(Math.round(peak / 2))}</span>
          <span>0</span>
        </div>

        <div className="relative flex-1" style={{ height: `${HEIGHT}px` }}>
          <ol
            className="flex size-full items-end justify-center gap-px"
            aria-label={label}
            onPointerLeave={() => setHover(null)}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              const ratio = (event.clientX - box.left) / box.width
              const index = Math.floor(ratio * points.length)
              setHover(index >= 0 && index < points.length ? index : null)
            }}
          >
            {points.map((point, index) => {
              const total = peak === 0 ? 0 : point.requests / peak
              const errors = peak === 0 ? 0 : point.errors / peak
              return (
                <li
                  key={point.ts}
                  className={cn(
                    "relative flex max-w-16 min-w-0.5 flex-1 items-end rounded-t-[2px]",
                    // The hovered bucket is tinted rather than outlined: at a hundred
                    // buckets the outline is wider than the bar.
                    hover === index && "bg-muted"
                  )}
                  style={{ height: `${HEIGHT}px` }}
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

          {active === null ? null : (
            <Readout
              point={active}
              // Pinned to whichever side has room, so the panel never leaves the plot.
              alignRight={(hover ?? 0) > points.length / 2}
            />
          )}
        </div>
      </div>

      <div className="flex justify-between pl-10 text-xs text-muted-foreground">
        {ticks.map((tick) => (
          <span key={tick.ts}>{tick.text}</span>
        ))}
      </div>
      <figcaption className="flex flex-wrap items-center gap-4 pl-10 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary/70" /> {COPY.chart.requests}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-destructive" /> {COPY.chart.errors}
        </span>
      </figcaption>
    </figure>
  )
}

function Readout({ point, alignRight }: { point: UsagePoint; alignRight: boolean }) {
  const rate = point.prompt_tokens > 0 ? point.cached_tokens / point.prompt_tokens : null
  return (
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none absolute top-1 z-10 w-52 rounded-lg border bg-popover p-2.5 text-xs shadow-md",
        alignRight ? "right-1" : "left-1"
      )}
    >
      <div className="mb-1.5 font-medium">{formatClock(point.ts)}</div>
      <dl className="flex flex-col gap-0.5">
        <ReadoutRow label={COPY.chart.requests} value={formatInt(point.requests)} />
        <ReadoutRow
          label={COPY.chart.errors}
          value={formatInt(point.errors)}
          tone={point.errors > 0 ? "bad" : undefined}
        />
        <ReadoutRow label={COPY.metric.promptTokens} value={formatCompact(point.prompt_tokens)} />
        <ReadoutRow label={COPY.metric.completionTokens} value={formatCompact(point.completion_tokens)} />
        <ReadoutRow
          label={COPY.metric.cacheRate}
          value={rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
        />
        <ReadoutRow label={COPY.chart.throughput} value={formatTps(point.tps)} />
        <ReadoutRow label={COPY.metric.avgLatency} value={formatMs(point.avg_latency_ms)} />
        <ReadoutRow label={COPY.metric.avgTtft} value={formatMs(point.avg_ttft_ms)} />
        <ReadoutRow label={COPY.metric.cost} value={formatCost(point.cost)} />
      </dl>
      {/* Named so the readout is not mistaken for the whole window's figures. */}
      <p className="mt-1.5 text-muted-foreground">{COPY.chart.bucketNote}</p>
    </div>
  )
}

function ReadoutRow({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", tone === "bad" && "text-destructive")}>{value}</dd>
    </div>
  )
}

/**
 * At most five evenly spaced time labels, so the axis stays readable when the window is
 * dense. The last bucket is labelled too: without it a chart whose final label sits well
 * before the right edge reads as if it stopped early.
 */
function axisTicks(points: UsagePoint[]): { ts: number; text: string }[] {
  const wanted = Math.min(5, points.length)
  const step = Math.max(1, Math.floor((points.length - 1) / Math.max(1, wanted - 1)))
  const ticks: { ts: number; text: string }[] = []
  for (let index = 0; index < points.length; index += step) {
    const point = points[index]
    if (point !== undefined) ticks.push({ ts: point.ts, text: formatClock(point.ts) })
  }
  const last = points[points.length - 1]
  if (last !== undefined && ticks[ticks.length - 1]?.ts !== last.ts) ticks.push({ ts: last.ts, text: formatClock(last.ts) })
  return ticks.slice(0, wanted)
}
