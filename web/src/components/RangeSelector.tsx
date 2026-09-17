/**
 * Draggable time range selector.
 *
 * Sits under a chart as a backdrop of the whole window with two handles, so the operator
 * chooses a slice of history by pointing at the shape of the traffic rather than by
 * guessing timestamps. The selection is reported as an inclusive millisecond range and is
 * the same range the chart above is drawn from, which makes the two views of one window
 * impossible to disagree.
 *
 * The backdrop is the *unfiltered* history, deliberately: it is the thing being selected
 * from, so it must not shrink to the current selection and remove the way back out.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { COPY } from "@/lib/copy.ts"
import { formatBucket, formatClock, formatInt, formatRangeLabel } from "@/lib/format.ts"
import { cn } from "cn"
import type { UsagePoint } from "@/lib/types.ts"

export type RangeSelection = { from: number; to: number }

/** Handles are grabbed within this many pixels of an edge before a new drag starts. */
const GRAB_PX = 10
/** A selection narrower than this is treated as a click, and cleared. */
const MIN_SELECTION_MS = 1_000

type Drag = { kind: "from" | "to" | "new"; originX: number; originFrom: number; originTo: number }

export function RangeSelector({
  series,
  from,
  to,
  selection,
  onSelect,
  onReset
}: {
  series: UsagePoint[]
  from: number
  to: number
  selection: RangeSelection | null
  onSelect: (next: RangeSelection) => void
  onReset: () => void
}) {
  const plot = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  /** Live selection while dragging, so the handles track the pointer without a round trip. */
  const [preview, setPreview] = useState<RangeSelection | null>(null)

  const span = Math.max(1, to - from)
  const shown = preview ?? selection

  const ratioOf = useCallback((ts: number) => Math.min(1, Math.max(0, (ts - from) / span)), [from, span])

  /** Client x → timestamp, clamped to the window. */
  const timeAt = useCallback(
    (clientX: number) => {
      const box = plot.current?.getBoundingClientRect()
      if (box === undefined || box.width === 0) return from
      const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
      return Math.round(from + ratio * span)
    },
    [from, span]
  )

  const nearestEdge = useCallback(
    (clientX: number): "from" | "to" | null => {
      if (shown === null) return null
      const box = plot.current?.getBoundingClientRect()
      if (box === undefined || box.width === 0) return null
      const fromX = box.left + ratioOf(shown.from) * box.width
      const toX = box.left + ratioOf(shown.to) * box.width
      if (Math.abs(clientX - fromX) <= GRAB_PX) return "from"
      if (Math.abs(clientX - toX) <= GRAB_PX) return "to"
      return null
    },
    [shown, ratioOf]
  )

  useEffect(() => {
    if (drag === null) return
    const move = (event: PointerEvent) => {
      const at = timeAt(event.clientX)
      if (drag.kind === "from") {
        setPreview({ from: Math.min(at, drag.originTo), to: drag.originTo })
        return
      }
      if (drag.kind === "to") {
        setPreview({ from: drag.originFrom, to: Math.max(at, drag.originFrom) })
        return
      }
      // Dragging on the backdrop sweeps a new selection out of the press point.
      setPreview({
        from: Math.min(drag.originX, at),
        to: Math.max(drag.originX, at)
      })
    }
    const up = () => {
      setPreview((current) => {
        if (current !== null && current.to - current.from >= MIN_SELECTION_MS) onSelect(current)
        else if (current !== null) onReset()
        return null
      })
      setDrag(null)
    }
    // On window, not on the element: a drag that leaves the plot must still track and
    // still end, or the handles stick to the pointer.
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }, [drag, timeAt, onSelect, onReset])

  const peak = series.reduce((max, point) => Math.max(max, point.requests), 0)
  const bucketMs = series.length > 1 ? (series[1]?.ts ?? 0) - (series[0]?.ts ?? 0) : 0
  /** A band per bucket, so the selection snaps to the bars it is choosing between. */
  const bandPct = series.length > 0 ? 100 / series.length : 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {shown === null ? COPY.range.wholeWindow : formatRangeLabel(shown.from, shown.to)}
        </span>
        <div className="flex items-center gap-2">
          {selection === null ? null : (
            <>
              <span className="text-muted-foreground">
                {COPY.range.bucketSize(formatBucket(bucketMs > 0 ? bucketMs : span / Math.max(1, series.length)))}
              </span>
              <Button variant="ghost" size="sm" onClick={onReset}>
                <RotateCcwIcon data-icon="inline-start" />
                {COPY.range.reset}
              </Button>
            </>
          )}
        </div>
      </div>

      <div
        ref={plot}
        role="group"
        aria-label={COPY.range.label}
        className="relative h-14 cursor-crosshair touch-none rounded-md border bg-muted/30 select-none"
        onPointerDown={(event) => {
          const edge = nearestEdge(event.clientX)
          const at = timeAt(event.clientX)
          setDrag(
            edge === null
              ? { kind: "new", originX: at, originFrom: at, originTo: at }
              : { kind: edge, originX: at, originFrom: shown?.from ?? at, originTo: shown?.to ?? at }
          )
          if (edge === null) setPreview({ from: at, to: at })
        }}
      >
        <div className="absolute inset-0 flex items-end gap-px px-px py-px">
          {series.map((point) => (
            <span
              key={point.ts}
              className="min-w-0 flex-1 rounded-t-[2px] bg-foreground/25"
              style={{ height: `${peak === 0 ? 0 : (point.requests / peak) * 100}%` }}
              title={COPY.chart.tooltip(formatClock(point.ts), formatInt(point.requests), formatInt(point.errors))}
            />
          ))}
        </div>

        {/* Everything outside the selection is dimmed rather than the selection being
            highlighted: the bars keep their color, so the selection reads as a window. */}
        {shown === null ? null : (
          <>
            <div
              className="absolute inset-y-0 left-0 bg-background/70"
              style={{ width: `${ratioOf(shown.from) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-background/70"
              style={{ width: `${(1 - ratioOf(shown.to)) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 border-x-2 border-primary bg-primary/10"
              style={{
                left: `${ratioOf(shown.from) * 100}%`,
                width: `${(ratioOf(shown.to) - ratioOf(shown.from)) * 100}%`
              }}
            >
              {(["from", "to"] as const).map((edge) => (
                <span
                  key={edge}
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-y-0 w-2.5 cursor-ew-resize bg-primary/40 hover:bg-primary/70",
                    edge === "from" ? "left-0 -translate-x-1/2 rounded-l" : "right-0 translate-x-1/2 rounded-r"
                  )}
                />
              ))}
            </div>
          </>
        )}
        {/* The band under the cursor while sweeping, so the new selection is visible
            before the pointer is released. */}
        {drag?.kind === "new" && shown !== null ? (
          <div
            className="absolute inset-y-0 border-x border-dashed border-primary/60"
            style={{
              left: `${ratioOf(shown.from) * 100}%`,
              width: `${Math.max(bandPct / 4, (ratioOf(shown.to) - ratioOf(shown.from)) * 100)}%`
            }}
          />
        ) : null}
      </div>

      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatClock(from)}</span>
        <span>{COPY.range.dragHint}</span>
        <span>{formatClock(to)}</span>
      </div>
    </div>
  )
}
