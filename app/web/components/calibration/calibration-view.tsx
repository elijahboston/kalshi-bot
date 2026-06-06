import { useMemo } from "react"
import { Target } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { useApiContext } from "@/src/lib/api-context"
import { fmtEdge } from "@/src/lib/format"
import { RecentResolutions } from "@/components/dashboard/recent-resolutions"

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
      <RecentResolutions />
    </div>
  )
}
