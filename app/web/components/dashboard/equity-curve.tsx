import { useMemo } from "react"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useApiStore } from "@/src/lib/store"
import type { EquitySpan } from "@/src/lib/store"
import { cn } from "@/lib/utils"

const SPANS: { value: EquitySpan; label: string }[] = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
]

interface SpanToggleProps {
  value: EquitySpan
  onChange: (span: EquitySpan) => void
}

function SpanToggle({ value, onChange }: SpanToggleProps) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5">
      {SPANS.map((s) => (
        <button
          key={s.value}
          type="button"
          onClick={() => onChange(s.value)}
          aria-pressed={value === s.value}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
            value === s.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}

interface DataPoint {
  time: string
  cash: number
  position: number
  equity: number
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

function formatUsdFull(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string
}

function ChartTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const cash = payload.find((p) => p.name === "cash")
  const position = payload.find((p) => p.name === "position")
  const equity = cash && position ? cash.value + position.value : 0

  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2.5 shadow-xl">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[hsl(200,70%,50%)]" />
            <span className="text-xs text-muted-foreground">Cash</span>
          </div>
          <span className="text-xs font-semibold text-foreground">
            {cash ? formatUsdFull(cash.value) : "$0.00"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[hsl(200,70%,70%)]" />
            <span className="text-xs text-muted-foreground">Positions</span>
          </div>
          <span className="text-xs font-semibold text-foreground">
            {position ? formatUsdFull(position.value) : "$0.00"}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-6 border-t border-border pt-1.5">
          <span className="text-xs font-medium text-muted-foreground">Total</span>
          <span className="text-xs font-bold text-foreground">{formatUsdFull(equity)}</span>
        </div>
      </div>
    </div>
  )
}

export function EquityCurve() {
  const equityHistory = useApiStore((s) => s.equityHistory)
  const equitySpan = useApiStore((s) => s.equitySpan)
  const setEquitySpan = useApiStore((s) => s.setEquitySpan)

  const data: DataPoint[] = useMemo(() => {
    return equityHistory.map((p) => {
      const cash = p.balance / 100
      const equity = p.totalEquity / 100
      const position = Math.max(0, equity - cash)
      const d = new Date(p.recordedAt)
      return {
        time: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        cash,
        position,
        equity,
      }
    })
  }, [equityHistory])

  const yDomain = useMemo(() => {
    if (data.length === 0) return [0, 100]
    const equities = data.map((d) => d.equity)
    const min = Math.min(...equities)
    const max = Math.max(...equities)
    const padding = (max - min) * 0.1 || 10
    return [Math.floor((min - padding) / 10) * 10, Math.ceil((max + padding) / 10) * 10]
  }, [data])

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader className="px-5 pb-2 pt-4">
          <CardTitle className="text-sm font-semibold">Equity Curve</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center justify-center gap-3 px-5 pb-4 pt-2">
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            {equitySpan === "all"
              ? "Waiting for balance history..."
              : `No balance history in the last ${equitySpan === "7d" ? "7 days" : "30 days"}.`}
          </div>
          <SpanToggle value={equitySpan} onChange={setEquitySpan} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="px-5 pb-2 pt-4">
        <CardTitle className="text-sm font-semibold">Equity Curve</CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-3 pt-0">
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradCash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(200, 70%, 50%)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="hsl(200, 70%, 50%)" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradPosition" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(200, 70%, 70%)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="hsl(200, 70%, 70%)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(224, 12%, 18%)" vertical={false} />
            <XAxis dataKey="time" tick={{ fontSize: 11, fill: "hsl(220, 10%, 55%)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={40} />
            <YAxis domain={yDomain} tick={{ fontSize: 11, fill: "hsl(220, 10%, 55%)" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatUsd(v)} width={64} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(220, 10%, 35%)", strokeDasharray: "4 4" }} />
            <Area type="monotone" dataKey="cash" stackId="1" stroke="hsl(200, 70%, 50%)" strokeWidth={1.5} fill="url(#gradCash)" isAnimationActive={false} />
            <Area type="monotone" dataKey="position" stackId="1" stroke="hsl(200, 70%, 70%)" strokeWidth={1.5} fill="url(#gradPosition)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        <div className="flex items-center justify-between gap-4 px-3 pt-2">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-3 rounded-sm bg-[hsl(200,70%,50%)]" />
              <span className="text-[11px] text-muted-foreground">Cash</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-3 rounded-sm bg-[hsl(200,70%,70%)]" />
              <span className="text-[11px] text-muted-foreground">Position Value</span>
            </div>
          </div>
          <SpanToggle value={equitySpan} onChange={setEquitySpan} />
        </div>
      </CardContent>
    </Card>
  )
}
