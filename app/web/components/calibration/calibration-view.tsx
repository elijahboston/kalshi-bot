import { useMemo } from "react"
import { Target, Check, X } from "lucide-react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from "recharts"
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
import { fmtMoney, fmtPnl, fmtPct, fmtEdge, fmtRelTime } from "@/src/lib/format"

interface ChartTooltipProps {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string
}

function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  const predicted = payload.find((p) => p.name === "predicted")
  const actual = payload.find((p) => p.name === "actual")

  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2.5 shadow-xl">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        Bucket: {label}
      </p>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[hsl(200,70%,50%)]" />
            <span className="text-xs text-muted-foreground">Predicted</span>
          </div>
          <span className="text-xs font-semibold text-foreground">
            {predicted ? (predicted.value * 100).toFixed(1) + "%" : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[hsl(142,70%,45%)]" />
            <span className="text-xs text-muted-foreground">Actual</span>
          </div>
          <span className="text-xs font-semibold text-foreground">
            {actual ? (actual.value * 100).toFixed(1) + "%" : "—"}
          </span>
        </div>
      </div>
    </div>
  )
}

export function CalibrationView() {
  const { calibration, resolutions, performance } = useApiContext()

  const chartData = useMemo(
    () =>
      calibration.map((b) => ({
        bucket: b.bucket,
        predicted: b.avgPredicted,
        actual: b.actualRate,
        total: b.total,
      })),
    [calibration]
  )

  const avgEdge = useMemo(() => {
    if (resolutions.length === 0) return 0
    return resolutions.reduce((s, r) => s + r.edge, 0) / resolutions.length
  }, [resolutions])

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Target className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight text-foreground">
            Calibration
          </h1>
          <p className="text-xs text-muted-foreground">
            Model calibration and prediction accuracy
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Brier Score
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums text-foreground">
              {performance ? performance.brierScore.toFixed(3) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Resolutions
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums text-foreground">
              {resolutions.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Avg Edge
            </p>
            <p
              className={cn(
                "mt-1 text-lg font-bold tabular-nums",
                avgEdge >= 0 ? "text-emerald-500" : "text-red-500"
              )}
            >
              {fmtEdge(avgEdge)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Calibration chart */}
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 px-5 pb-2 pt-4">
          <CardTitle className="text-sm font-semibold">
            Predicted vs Actual
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {calibration.length} buckets
          </span>
        </CardHeader>
        <CardContent className="px-2 pb-3 pt-0">
          {chartData.length === 0 ? (
            <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
              Waiting for calibration data...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={chartData}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(224, 12%, 18%)"
                  vertical={false}
                />
                <XAxis
                  dataKey="bucket"
                  tick={{ fontSize: 11, fill: "hsl(220, 10%, 55%)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(220, 10%, 55%)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                  width={48}
                  domain={[0, 1]}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(220, 10%, 15%)", opacity: 0.5 }} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  formatter={(value: string) =>
                    value === "predicted" ? "Avg Predicted" : "Actual Rate"
                  }
                />
                <ReferenceLine
                  segment={[
                    { x: chartData[0]?.bucket, y: 0 },
                    { x: chartData[chartData.length - 1]?.bucket, y: 1 },
                  ]}
                  stroke="hsl(220, 10%, 35%)"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  label=""
                />
                <Bar
                  dataKey="predicted"
                  fill="hsl(200, 70%, 50%)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={32}
                />
                <Bar
                  dataKey="actual"
                  fill="hsl(142, 70%, 45%)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={32}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Resolutions table */}
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 px-5 pb-3 pt-4">
          <CardTitle className="text-sm font-semibold">
            Recent Resolutions
          </CardTitle>
          {resolutions.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {resolutions.length} resolved
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
                    {resolutions.map((r, i) => (
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
                          {fmtMoney(r.marketPrice)}
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
              <div className="h-1" />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
