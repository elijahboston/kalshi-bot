import { useMemo } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip"
import { useApiStore } from "@/src/lib/store"
import type { DailyWinRate } from "@/src/lib/types"

const WEEKS = 12
const DAYS_PER_WEEK = 7
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

interface Cell {
  date: Date
  key: string // YYYY-MM-DD
  stat: DailyWinRate | null
}

function toKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function buildGrid(
  dailyWinRates: DailyWinRate[],
  today: Date = new Date(),
): Cell[][] {
  const byDate = new Map<string, DailyWinRate>()
  for (const r of dailyWinRates) byDate.set(r.date, r)

  // End = today. Start = Sunday of (WEEKS - 1) weeks ago.
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const currentDow = end.getDay() // 0 = Sun
  const daysBack = (WEEKS - 1) * DAYS_PER_WEEK + currentDow
  const start = new Date(end)
  start.setDate(end.getDate() - daysBack)

  const weeks: Cell[][] = []
  for (let w = 0; w < WEEKS; w++) {
    const col: Cell[] = []
    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      const date = new Date(start)
      date.setDate(start.getDate() + w * DAYS_PER_WEEK + d)
      const key = toKey(date)
      const stat = byDate.get(key) ?? null
      // Mask future dates (shouldn't happen, but defensive)
      col.push({ date, key, stat: date > end ? null : stat })
    }
    weeks.push(col)
  }
  return weeks
}

export function intensityClass(stat: DailyWinRate | null): string {
  if (!stat || stat.total === 0) return "bg-muted"
  const r = stat.winRate
  if (r < 0.25) return "bg-[hsl(152_60%_42%/0.15)]"
  if (r < 0.5) return "bg-[hsl(152_60%_42%/0.35)]"
  if (r < 0.75) return "bg-[hsl(152_60%_42%/0.6)]"
  if (r < 1) return "bg-[hsl(152_60%_42%/0.85)]"
  return "bg-[hsl(152_60%_42%)]"
}

function formatCellDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
}

function tooltipText(cell: Cell): string {
  const label = formatCellDate(cell.date)
  if (!cell.stat || cell.stat.total === 0) return `${label} — no trades`
  const pct = Math.round(cell.stat.winRate * 100)
  return `${label} — ${cell.stat.wins}/${cell.stat.total} wins (${pct}%)`
}

export function WeeklyWinRateHeatmap() {
  const dailyWinRates = useApiStore((s) => s.dailyWinRates)

  const weeks = useMemo(() => buildGrid(dailyWinRates), [dailyWinRates])

  const monthHeaders = useMemo(() => {
    // For each week column, the month label to show above it (or "" if same as previous).
    const labels: string[] = []
    let prevMonth = -1
    for (const col of weeks) {
      const firstDay = col[0].date
      const m = firstDay.getMonth()
      labels.push(m !== prevMonth ? MONTH_LABELS[m] : "")
      prevMonth = m
    }
    return labels
  }, [weeks])

  if (dailyWinRates.length === 0) {
    return (
      <Card>
        <CardHeader className="px-5 pb-2 pt-4">
          <CardTitle className="text-sm font-semibold">Weekly Win Rate</CardTitle>
        </CardHeader>
        <CardContent className="flex h-[140px] items-center justify-center text-sm text-muted-foreground">
          Waiting for resolved trades...
        </CardContent>
      </Card>
    )
  }

  const intensitySwatches: Array<DailyWinRate | null> = [
    null,
    { date: "", total: 1, wins: 0, winRate: 0.2 },
    { date: "", total: 1, wins: 0, winRate: 0.4 },
    { date: "", total: 1, wins: 0, winRate: 0.6 },
    { date: "", total: 1, wins: 0, winRate: 0.9 },
    { date: "", total: 1, wins: 1, winRate: 1 },
  ]

  return (
    <TooltipProvider delayDuration={100}>
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 px-5 pb-2 pt-4">
          <CardTitle className="text-sm font-semibold">Weekly Win Rate</CardTitle>
          <span className="text-xs text-muted-foreground">Past 12 weeks</span>
        </CardHeader>
        <CardContent className="px-5 pb-4 pt-1">
          <div className="flex flex-col gap-1">
            {/* Month row: narrow gutter + 12 week columns */}
            <div
              className="grid text-[10px] text-muted-foreground"
              style={{ gridTemplateColumns: "26px repeat(12, minmax(0, 1fr))" }}
            >
              <div />
              {monthHeaders.map((label, i) => (
                <div key={i} className="text-left">
                  {label}
                </div>
              ))}
            </div>

            {/* Heatmap body: day labels column + 12 week columns */}
            <div
              className="grid gap-[3px]"
              style={{ gridTemplateColumns: "26px repeat(12, minmax(0, 1fr))" }}
            >
              {/* Day labels — 7 stacked rows inside a single grid column */}
              <div
                className="grid gap-[3px] text-[10px] text-muted-foreground"
                style={{ gridTemplateRows: "repeat(7, 14px)" }}
              >
                {DAY_LABELS.map((lbl, i) => (
                  <div key={i} className="flex items-center leading-none">
                    {/* show Mon, Wed, Fri only to avoid clutter */}
                    {i === 1 || i === 3 || i === 5 ? lbl : ""}
                  </div>
                ))}
              </div>

              {/* One column per week; each column is 7 stacked cells */}
              {weeks.map((col, wi) => (
                <div
                  key={wi}
                  className="grid gap-[3px]"
                  style={{ gridTemplateRows: "repeat(7, 14px)" }}
                >
                  {col.map((cell) => (
                    <Tooltip key={cell.key}>
                      <TooltipTrigger asChild>
                        <div
                          data-date={cell.key}
                          data-testid="heatmap-cell"
                          className={`h-[14px] w-full rounded-sm ${intensityClass(cell.stat)}`}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {tooltipText(cell)}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              ))}
            </div>

            {/* Legend */}
            <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
              <span>Less</span>
              {intensitySwatches.map((s, i) => (
                <span
                  key={i}
                  className={`inline-block h-[10px] w-[10px] rounded-sm ${intensityClass(s)}`}
                />
              ))}
              <span>More</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  )
}
