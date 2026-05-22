import { useMemo, useState, useCallback } from "react"
import { TrendingUp, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useApiContext } from "@/src/lib/api-context"
import { fmtMoney, fmtPnl, fmtRelTime } from "@/src/lib/format"

type SortKey = "ticker" | "quantity" | "avgEntry" | "costBasis" | "marketValue" | "unrealizedPnl" | "openedAt"
type SortDir = "asc" | "desc"

function SortableHead({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  className,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  currentDir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}) {
  const isActive = currentKey === sortKey
  return (
    <TableHead
      className={cn(
        "h-9 cursor-pointer select-none text-[11px] font-semibold uppercase tracking-widest transition-colors hover:text-foreground",
        className
      )}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="h-3 w-3 text-primary" />
          ) : (
            <ArrowDown className="h-3 w-3 text-primary" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </TableHead>
  )
}

export function PositionsTable() {
  const { positions } = useApiContext()

  const [sortKey, setSortKey] = useState<SortKey>("unrealizedPnl")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
      } else {
        setSortKey(key)
        setSortDir("desc")
      }
    },
    [sortKey]
  )

  const sorted = useMemo(() => {
    const data = [...positions]
    data.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case "ticker":
          cmp = a.ticker.localeCompare(b.ticker)
          break
        case "quantity":
          cmp = a.quantity - b.quantity
          break
        case "avgEntry":
          cmp = a.avgEntryPrice - b.avgEntryPrice
          break
        case "costBasis":
          cmp = a.costBasis - b.costBasis
          break
        case "marketValue":
          cmp = (a.marketValue ?? 0) - (b.marketValue ?? 0)
          break
        case "unrealizedPnl":
          cmp = (a.unrealizedPnl ?? 0) - (b.unrealizedPnl ?? 0)
          break
        case "openedAt":
          cmp = new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()
          break
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return data
  }, [positions, sortKey, sortDir])

  const totalCostBasis = positions.reduce((s, p) => s + p.costBasis, 0)
  const totalMarketValue = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0)
  const totalUnrealizedPnl = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <TrendingUp className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight text-foreground">
            Positions
          </h1>
          <p className="text-xs text-muted-foreground">
            {positions.length} open position{positions.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Summary cards */}
      {positions.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card>
            <CardContent className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Cost Basis
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums text-foreground">
                {fmtMoney(totalCostBasis)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Market Value
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums text-foreground">
                {fmtMoney(totalMarketValue)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Unrealized P&L
              </p>
              <p
                className={cn(
                  "mt-1 text-lg font-bold tabular-nums",
                  totalUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"
                )}
              >
                {fmtPnl(totalUnrealizedPnl)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Open Positions
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums text-foreground">
                {positions.length}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {positions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              No open positions
            </p>
            <p className="text-xs text-muted-foreground/70">
              Positions will appear here once the bot opens trades.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead label="Ticker" sortKey="ticker" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="pl-4" />
                  <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">Side</TableHead>
                  <SortableHead label="Qty" sortKey="quantity" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortableHead label="Avg Entry" sortKey="avgEntry" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortableHead label="Cost Basis" sortKey="costBasis" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortableHead label="Mkt Value" sortKey="marketValue" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortableHead label="Unrlzd P&L" sortKey="unrealizedPnl" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortableHead label="Opened" sortKey="openedAt" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="pr-4 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((pos) => {
                  const side = pos.side.toUpperCase()
                  const pnl = pos.unrealizedPnl ?? 0
                  return (
                    <TableRow key={pos.ticker}>
                      <TableCell className="py-2.5 pl-4 font-mono text-[13px] font-medium text-foreground whitespace-nowrap">
                        {pos.ticker}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
                            side === "YES"
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                              : "border-red-500/30 bg-red-500/10 text-red-500"
                          )}
                        >
                          {side}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2.5 text-right tabular-nums text-foreground">
                        {pos.quantity.toLocaleString()}
                      </TableCell>
                      <TableCell className="py-2.5 text-right font-mono text-[13px] tabular-nums text-muted-foreground">
                        {fmtMoney(pos.avgEntryPrice)}
                      </TableCell>
                      <TableCell className="py-2.5 text-right font-mono text-[13px] tabular-nums text-muted-foreground">
                        {fmtMoney(pos.costBasis)}
                      </TableCell>
                      <TableCell className="py-2.5 text-right font-mono text-[13px] tabular-nums text-foreground">
                        {pos.marketValue != null ? fmtMoney(pos.marketValue) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "py-2.5 text-right font-mono text-[13px] font-semibold tabular-nums",
                          pnl >= 0 ? "text-emerald-500" : "text-red-500"
                        )}
                      >
                        {pos.unrealizedPnl != null ? fmtPnl(pnl) : "—"}
                      </TableCell>
                      <TableCell className="py-2.5 pr-4 text-right text-xs text-muted-foreground whitespace-nowrap">
                        {fmtRelTime(pos.openedAt)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
