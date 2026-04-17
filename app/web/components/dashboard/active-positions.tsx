import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { LayoutList } from "lucide-react"
import { useApiContext } from "@/src/lib/api-context"

const MAX_ROWS = 10

function formatCents(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPnl(value: number): string {
  const prefix = value >= 0 ? "+" : ""
  return prefix + formatCents(value)
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
        <LayoutList className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">
        No open positions
      </p>
      <p className="text-xs text-muted-foreground/70">
        Positions will appear here once the bot opens trades.
      </p>
    </div>
  )
}

export function ActivePositions() {
  const { positions: rawPositions } = useApiContext()
  const positions = rawPositions.map((p) => ({
    id: p.ticker,
    ticker: p.ticker,
    side: p.side.toUpperCase() as "YES" | "NO",
    size: p.quantity,
    avgEntry: p.avgEntryPrice / 100,
    currentPrice: p.marketValue != null ? p.marketValue / (p.quantity * 100) : p.avgEntryPrice / 100,
    unrealizedPnl: (p.unrealizedPnl ?? 0) / 100,
  }))

  const displayedPositions = positions.slice(0, MAX_ROWS)
  const hasMore = positions.length > MAX_ROWS

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 px-5 pb-3 pt-4">
        <div className="flex items-baseline gap-2">
          <CardTitle className="text-sm font-semibold text-foreground">
            Active Positions
          </CardTitle>
          {positions.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {positions.length} open
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {positions.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-9 pl-5 text-[11px] font-semibold uppercase tracking-widest">
                    Ticker
                  </TableHead>
                  <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">
                    Side
                  </TableHead>
                  <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">
                    Size
                  </TableHead>
                  <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">
                    Avg Entry
                  </TableHead>
                  <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">
                    Price
                  </TableHead>
                  <TableHead className="h-9 pr-5 text-right text-[11px] font-semibold uppercase tracking-widest">
                    Unrlzd P&L
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayedPositions.map((pos) => (
                  <TableRow key={pos.id}>
                    <TableCell className="py-2.5 pl-5 font-mono text-[13px] font-medium text-foreground">
                      {pos.ticker}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
                          pos.side === "YES"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                            : "border-red-500/30 bg-red-500/10 text-red-500"
                        )}
                      >
                        {pos.side}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-2.5 text-right tabular-nums text-foreground">
                      {pos.size.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-2.5 text-right font-mono text-[13px] tabular-nums text-muted-foreground">
                      {formatCents(pos.avgEntry)}
                    </TableCell>
                    <TableCell className="py-2.5 text-right font-mono text-[13px] tabular-nums text-foreground">
                      {formatCents(pos.currentPrice)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "py-2.5 pr-5 text-right font-mono text-[13px] font-semibold tabular-nums",
                        pos.unrealizedPnl >= 0
                          ? "text-emerald-500"
                          : "text-red-500"
                      )}
                    >
                      {formatPnl(pos.unrealizedPnl)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasMore && (
              <div className="border-t border-border px-5 py-2.5">
                <button className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
                  View all {positions.length} positions
                </button>
              </div>
            )}
            {!hasMore && <div className="h-1" />}
          </>
        )}
      </CardContent>
    </Card>
  )
}
