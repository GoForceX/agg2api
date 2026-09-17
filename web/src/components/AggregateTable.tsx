/** The per-group rollup table shared by the overview and the usage breakdown. */
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TableIcon } from "lucide-react"

import { ToneBadge } from "@/components/common"
import { COPY } from "@/lib/copy.ts"
import { formatCompact, formatCost, formatInt, formatMs, formatPercent, formatTps } from "@/lib/format.ts"
import type { UsageAggregate } from "@/lib/types.ts"

export function AggregateTable({ rows, empty }: { rows: UsageAggregate[]; empty: string }) {
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TableIcon />
          </EmptyMedia>
          <EmptyTitle>{COPY.state.empty}</EmptyTitle>
          <EmptyDescription>{empty}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{COPY.dashboard.aggregateKey}</TableHead>
          <TableHead className="text-right">{COPY.column.requests}</TableHead>
          <TableHead className="text-right">{COPY.column.errors}</TableHead>
          <TableHead className="text-right">{COPY.column.promptTokens}</TableHead>
          <TableHead className="text-right">{COPY.column.completionTokens}</TableHead>
          <TableHead className="text-right">{COPY.column.cacheRate}</TableHead>
          <TableHead className="text-right">{COPY.column.cost}</TableHead>
          <TableHead className="text-right">{COPY.column.avgLatency}</TableHead>
          <TableHead className="text-right">{COPY.column.avgTtft}</TableHead>
          <TableHead className="text-right">{COPY.column.tps}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const rate = row.prompt_tokens > 0 ? row.cached_tokens / row.prompt_tokens : null
          return (
            <TableRow key={row.key}>
              <TableCell className="font-mono text-xs">{row.key.length > 0 ? row.key : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(row.requests)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {row.errors > 0 ? <ToneBadge tone="warn">{formatInt(row.errors)}</ToneBadge> : formatInt(row.errors)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCompact(row.prompt_tokens)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCompact(row.completion_tokens)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatPercent(rate)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCost(row.cost)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMs(row.avg_latency_ms)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMs(row.avg_ttft_ms)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatTps(row.avg_tps)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
