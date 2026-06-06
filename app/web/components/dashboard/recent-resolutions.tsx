import { Link } from "@tanstack/react-router"
import { Target, Check, X } from "lucide-react"
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
import { useApiContext } from "@/src/lib/api-context"
import { fmtPrice, fmtPnl, fmtPct, fmtEdge, fmtRelTime } from "@/src/lib/format"
import type { Resolution } from "@/src/lib/types"

export interface ResolutionSummary {
  wins: number
  losses: number
  netPnl: number
}

export function resolutionSummary(resolutions: Resolution[]): ResolutionSummary {
  let wins = 0
  let losses = 0
  let netPnl = 0
  for (const r of resolutions) {
    if (r.realizedPnl == null) continue
    netPnl += r.realizedPnl
    if (r.realizedPnl > 0) wins++
    else if (r.realizedPnl < 0) losses++
  }
  return { wins, losses, netPnl }
}

interface RecentResolutionsProps {
  /** Max rows to display; omit to show all loaded resolutions. */
  limit?: number
  /** Show a "View all" link to the Calibration tab in the footer. */
  viewAllLink?: boolean
}

export function RecentResolutions({ limit, viewAllLink }: RecentResolutionsProps) {
  const { resolutions } = useApiContext()
  const displayed = limit != null ? resolutions.slice(0, limit) : resolutions
  const summary = resolutionSummary(resolutions)

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 px-5 pb-3 pt-4">
        <div className="flex items-baseline gap-2">
          <CardTitle className="text-sm font-semibold">
            Recent Resolutions
          </CardTitle>
          {resolutions.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {summary.wins}W / {summary.losses}L
            </span>
          )}
        </div>
        {resolutions.length > 0 && (
          <span
            className={cn(
              "font-mono text-xs font-semibold tabular-nums",
              summary.netPnl >= 0 ? "text-emerald-500" : "text-red-500"
            )}
          >
            {fmtPnl(summary.netPnl)}
          </span>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {resolutions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <Target className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              No resolutions yet
            </p>
            <p className="text-xs text-muted-foreground/70">
              Resolutions appear when markets settle.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-9 pl-5 text-[11px] font-semibold uppercase tracking-widest">
                      Ticker
                    </TableHead>
                    <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">
                      Category
                    </TableHead>
                    <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">
                      Predicted
                    </TableHead>
                    <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">
                      Actual
                    </TableHead>
                    <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">
                      Mkt Price
                    </TableHead>
                    <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">
                      Edge
                    </TableHead>
                    <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">
                      P&L
                    </TableHead>
                    <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">
                      Traded
                    </TableHead>
                    <TableHead className="h-9 pr-5 text-right text-[11px] font-semibold uppercase tracking-widest">
                      Resolved
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayed.map((r, i) => (
                    <TableRow key={`${r.ticker}-${i}`}>
                      <TableCell className="py-2.5 pl-5 font-mono text-[13px] font-medium text-foreground whitespace-nowrap">
                        {r.ticker}
                      </TableCell>
                      <TableCell className="py-2.5 text-xs capitalize text-muted-foreground">
                        {r.category.replace("_", " ")}
                      </TableCell>
                      <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums text-foreground">
                        {fmtPct(r.predictedProb)}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
                            r.actualOutcome === 1
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                              : "border-red-500/30 bg-red-500/10 text-red-500"
                          )}
                        >
                          {r.actualOutcome === 1 ? "Yes" : "No"}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {fmtPrice(r.marketPrice)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "py-2.5 text-right font-mono text-xs tabular-nums",
                          r.edge >= 0 ? "text-emerald-500" : "text-red-500"
                        )}
                      >
                        {fmtEdge(r.edge)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "py-2.5 text-right font-mono text-xs font-semibold tabular-nums",
                          r.realizedPnl != null && r.realizedPnl >= 0
                            ? "text-emerald-500"
                            : "text-red-500"
                        )}
                      >
                        {r.realizedPnl != null ? fmtPnl(r.realizedPnl) : "—"}
                      </TableCell>
                      <TableCell className="py-2.5">
                        {r.traded ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <X className="h-4 w-4 text-muted-foreground/50" />
                        )}
                      </TableCell>
                      <TableCell className="py-2.5 pr-5 text-right text-xs text-muted-foreground whitespace-nowrap">
                        {fmtRelTime(r.resolvedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {viewAllLink ? (
              <div className="border-t border-border px-5 py-2.5">
                <Link
                  to="/calibration"
                  className="text-xs font-medium text-primary transition-colors hover:text-primary/80"
                >
                  View all on Calibration →
                </Link>
              </div>
            ) : (
              <div className="h-1" />
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
