import { useId, useMemo, useState, useCallback, useEffect } from "react"
import { formatDistanceToNowStrict, format, subDays, subHours } from "date-fns"
import { Zap, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from "lucide-react"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { SignalsFilter, type DateRange } from "./signals-filter"

// ── Types ────────────────────────────────────────────────────────────────────

export interface Signal {
  id: string
  timestamp: Date
  ticker: string
  side: "BUY YES" | "BUY NO"
  estProb: number
  mktPrice: number
  edge: number
  confidence: number
  action: "Traded" | "Skipped" | "Pending"
  outcome?: "profit" | "loss"
}

type SortKey = "timestamp" | "ticker" | "edge" | "confidence" | "estProb" | "mktPrice"
type SortDir = "asc" | "desc"

// ── Sample data (offsets in ms from "now", resolved at render time) ───────────

interface RawSignal extends Omit<Signal, "timestamp"> {
  offsetMs: number
}

const SIGNAL_DATA: RawSignal[] = [
  { id: "s1",  offsetMs: 2 * 60_000,           ticker: "KXHIGHNY-25FEB10-B33",  side: "BUY YES", estProb: 0.53, mktPrice: 0.45, edge: 0.08,  confidence: 0.82, action: "Traded",  outcome: "profit" },
  { id: "s2",  offsetMs: 14 * 60_000,          ticker: "KXHIGHCHI-25FEB10-B22", side: "BUY NO",  estProb: 0.48, mktPrice: 0.52, edge: 0.04,  confidence: 0.61, action: "Skipped"  },
  { id: "s3",  offsetMs: 38 * 60_000,          ticker: "KXHIGHMIA-25FEB10-B78", side: "BUY YES", estProb: 0.72, mktPrice: 0.61, edge: 0.11,  confidence: 0.91, action: "Traded",  outcome: "profit" },
  { id: "s4",  offsetMs: 1.2 * 3_600_000,      ticker: "KXHIGHLA-25FEB10-B68",  side: "BUY YES", estProb: 0.46, mktPrice: 0.38, edge: 0.08,  confidence: 0.74, action: "Traded",  outcome: "loss"   },
  { id: "s5",  offsetMs: 2.5 * 3_600_000,      ticker: "KXHIGHDEN-25FEB10-B42", side: "BUY NO",  estProb: 0.39, mktPrice: 0.41, edge: 0.02,  confidence: 0.45, action: "Skipped"  },
  { id: "s6",  offsetMs: 4 * 3_600_000,        ticker: "KXHIGHATL-25FEB10-B55", side: "BUY YES", estProb: 0.42, mktPrice: 0.33, edge: 0.09,  confidence: 0.77, action: "Pending"  },
  { id: "s7",  offsetMs: 5.5 * 3_600_000,      ticker: "KXHIGHNY-25FEB10-B35",  side: "BUY YES", estProb: 0.28, mktPrice: 0.32, edge: -0.04, confidence: 0.33, action: "Skipped"  },
  { id: "s8",  offsetMs: 8 * 3_600_000,        ticker: "KXHIGHCHI-25FEB10-B24", side: "BUY YES", estProb: 0.35, mktPrice: 0.28, edge: 0.07,  confidence: 0.68, action: "Traded",  outcome: "profit" },
  { id: "s9",  offsetMs: 24 * 3_600_000,       ticker: "KXHIGHNY-25FEB09-B31",  side: "BUY NO",  estProb: 0.15, mktPrice: 0.12, edge: 0.03,  confidence: 0.52, action: "Traded",  outcome: "loss"   },
  { id: "s10", offsetMs: 26 * 3_600_000,       ticker: "KXHIGHMIA-25FEB09-B80", side: "BUY YES", estProb: 0.19, mktPrice: 0.25, edge: -0.06, confidence: 0.29, action: "Skipped"  },
  { id: "s11", offsetMs: 2 * 86_400_000,       ticker: "KXHIGHLA-25FEB08-B70",  side: "BUY YES", estProb: 0.56, mktPrice: 0.44, edge: 0.12,  confidence: 0.88, action: "Traded",  outcome: "profit" },
  { id: "s12", offsetMs: 3 * 86_400_000,       ticker: "KXHIGHDEN-25FEB07-B40", side: "BUY YES", estProb: 0.61, mktPrice: 0.55, edge: 0.06,  confidence: 0.71, action: "Traded",  outcome: "profit" },
  { id: "s13", offsetMs: 4 * 86_400_000,       ticker: "KXHIGHCHI-25FEB06-B18", side: "BUY NO",  estProb: 0.11, mktPrice: 0.08, edge: 0.03,  confidence: 0.55, action: "Traded",  outcome: "loss"   },
  { id: "s14", offsetMs: 5 * 86_400_000,       ticker: "KXHIGHATL-25FEB05-B52", side: "BUY YES", estProb: 0.47, mktPrice: 0.36, edge: 0.11,  confidence: 0.84, action: "Traded",  outcome: "profit" },
  { id: "s15", offsetMs: 7 * 86_400_000,       ticker: "KXHIGHNY-25FEB03-B30",  side: "BUY YES", estProb: 0.38, mktPrice: 0.31, edge: 0.07,  confidence: 0.66, action: "Traded",  outcome: "profit" },
  { id: "s16", offsetMs: 10 * 86_400_000,      ticker: "KXHIGHLA-25JAN31-B65",  side: "BUY NO",  estProb: 0.22, mktPrice: 0.29, edge: 0.07,  confidence: 0.59, action: "Traded",  outcome: "loss"   },
  { id: "s17", offsetMs: 14 * 86_400_000,      ticker: "KXHIGHMIA-25JAN27-B76", side: "BUY YES", estProb: 0.68, mktPrice: 0.59, edge: 0.09,  confidence: 0.79, action: "Traded",  outcome: "profit" },
  { id: "s18", offsetMs: 21 * 86_400_000,      ticker: "KXHIGHDEN-25JAN20-B38", side: "BUY YES", estProb: 0.41, mktPrice: 0.33, edge: 0.08,  confidence: 0.72, action: "Traded",  outcome: "profit" },
]

function buildSignals(refTime: number): Signal[] {
  return SIGNAL_DATA.map(({ offsetMs, ...rest }) => ({
    ...rest,
    timestamp: new Date(refTime - offsetMs),
  }))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(v: number) {
  return `${Math.round(v * 100)}%`
}

function cents(v: number) {
  return `\u00A2${Math.round(v * 100)}`
}

function getRowTint(signal: Signal) {
  if (signal.action === "Pending" || signal.action === "Skipped") return ""
  if (signal.outcome === "profit") return "bg-emerald-500/[0.04]"
  if (signal.outcome === "loss") return "bg-red-500/[0.04]"
  return ""
}

// ── Sortable header helper ───────────────────────────────────────────────────

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

// ── Confidence bar ───────────────────────────────────────────────────────────

function ConfidenceBar({ value }: { value: number }) {
  const p = Math.round(value * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            p >= 70
              ? "bg-emerald-500"
              : p >= 40
                ? "bg-amber-500"
                : "bg-red-500"
          )}
          style={{ width: `${p}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums">{p}%</span>
    </div>
  )
}

// ── Relative time cell (hydration-safe: placeholder on server, live on client)

function RelativeTime({ date }: { date: Date }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const absolute = mounted ? format(date, "MMM d, yyyy HH:mm:ss") : ""
  const relative = mounted
    ? formatDistanceToNowStrict(date, { addSuffix: true })
    : ""

  // Re-compute relative time periodically
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!mounted) return
    const interval = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(interval)
  }, [mounted])

  if (!mounted) {
    return <span className="inline-block h-4 w-16 animate-pulse rounded bg-muted" />
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-muted-foreground">{relative}</span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="font-mono text-xs">{absolute}</span>
      </TooltipContent>
    </Tooltip>
  )
}

// ── Page sizes ───────────────────────────────────────────────────────────────

const PAGE_SIZES = [10, 25, 50]

// ── Main component ───────────────────────────────────────────────────────────

export function SignalsTable() {
  const id = useId()

  // Stable reference time (frozen on first client render)
  const [refTime] = useState(() => Date.now())
  const signals = useMemo(() => buildSignals(refTime), [refTime])

  // Filters
  const [minEdge, setMinEdge] = useState(0)
  const [marketType, setMarketType] = useState("all")
  const [dateRange, setDateRange] = useState<DateRange>("all")

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("timestamp")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  // Pagination
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
      } else {
        setSortKey(key)
        setSortDir("desc")
      }
      setPage(0)
    },
    [sortKey]
  )

  // Filtered + sorted data
  const filtered = useMemo(() => {
    let data = [...signals]

    // Edge filter
    if (minEdge > 0) {
      data = data.filter((s) => Math.abs(s.edge) * 100 >= minEdge)
    }

    // Market type (simple ticker prefix heuristic)
    if (marketType !== "all") {
      const prefixes: Record<string, string[]> = {
        hightemp: ["KXHIGH"],
        lowtemp: ["KXLOW"],
        precipitation: ["KXPRECIP"],
        wind: ["KXWIND"],
      }
      const px = prefixes[marketType] ?? []
      if (px.length > 0) {
        data = data.filter((s) => px.some((p) => s.ticker.startsWith(p)))
      }
    }

    // Date filter
    if (dateRange !== "all") {
      const ref = new Date(refTime)
      const cutoff =
        dateRange === "today"
          ? subHours(ref, 24)
          : dateRange === "7d"
            ? subDays(ref, 7)
            : subDays(ref, 30)
      data = data.filter((s) => s.timestamp >= cutoff)
    }

    // Sort
    data.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case "timestamp":
          cmp = a.timestamp.getTime() - b.timestamp.getTime()
          break
        case "ticker":
          cmp = a.ticker.localeCompare(b.ticker)
          break
        case "edge":
          cmp = Math.abs(a.edge) - Math.abs(b.edge)
          break
        case "confidence":
          cmp = a.confidence - b.confidence
          break
        case "estProb":
          cmp = a.estProb - b.estProb
          break
        case "mktPrice":
          cmp = a.mktPrice - b.mktPrice
          break
      }
      return sortDir === "asc" ? cmp : -cmp
    })

    return data
  }, [signals, refTime, minEdge, marketType, dateRange, sortKey, sortDir])

  // Pagination derived
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <TooltipProvider delayDuration={100}>
      <div className="flex flex-col gap-5">
        {/* Page header */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Zap className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight text-foreground">
              Signals
            </h1>
            <p className="text-xs text-muted-foreground">
              {filtered.length} signals found
            </p>
          </div>
        </div>

        {/* Filters */}
        <SignalsFilter
          minEdge={minEdge}
          onMinEdgeChange={(v) => {
            setMinEdge(v)
            setPage(0)
          }}
          marketType={marketType}
          onMarketTypeChange={(v) => {
            setMarketType(v)
            setPage(0)
          }}
          dateRange={dateRange}
          onDateRangeChange={(v) => {
            setDateRange(v)
            setPage(0)
          }}
        />

        {/* Table */}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Zap className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">
                No signals match your filters
              </p>
              <p className="text-xs text-muted-foreground/70">
                Try lowering the min edge or expanding the date range.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <SortableHead
                        label="Time"
                        sortKey="timestamp"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="pl-4"
                      />
                      <SortableHead
                        label="Ticker"
                        sortKey="ticker"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                      />
                      <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">
                        Side
                      </TableHead>
                      <SortableHead
                        label="Est. Prob"
                        sortKey="estProb"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Mkt Price"
                        sortKey="mktPrice"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Edge"
                        sortKey="edge"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Confidence"
                        sortKey="confidence"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                      />
                      <TableHead className="h-9 pr-4 text-[11px] font-semibold uppercase tracking-widest">
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map((s) => {
                      const edgePct = Math.round(s.edge * 100)
                      const edgeStr = (edgePct >= 0 ? "+" : "") + edgePct + "%"
                      const isBoldEdge = Math.abs(s.edge) > 0.1

                      return (
                        <TableRow
                          key={s.id}
                          className={cn("transition-colors", getRowTint(s))}
                        >
                          {/* Timestamp */}
                          <TableCell className="py-2.5 pl-4 text-xs whitespace-nowrap">
                            <RelativeTime date={s.timestamp} />
                          </TableCell>

                          {/* Ticker */}
                          <TableCell className="py-2.5 font-mono text-[13px] font-medium text-foreground whitespace-nowrap">
                            {s.ticker}
                          </TableCell>

                          {/* Side */}
                          <TableCell className="py-2.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                "whitespace-nowrap h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
                                s.side === "BUY YES"
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                                  : "border-red-500/30 bg-red-500/10 text-red-500"
                              )}
                            >
                              {s.side}
                            </Badge>
                          </TableCell>

                          {/* Est Prob */}
                          <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums text-foreground">
                            {pct(s.estProb)}
                          </TableCell>

                          {/* Mkt Price */}
                          <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                            {cents(s.mktPrice)}
                          </TableCell>

                          {/* Edge */}
                          <TableCell
                            className={cn(
                              "py-2.5 text-right font-mono text-xs tabular-nums",
                              s.edge >= 0 ? "text-emerald-500" : "text-red-500",
                              isBoldEdge && "font-bold"
                            )}
                          >
                            {edgeStr}
                          </TableCell>

                          {/* Confidence */}
                          <TableCell className="py-2.5">
                            <ConfidenceBar value={s.confidence} />
                          </TableCell>

                          {/* Action */}
                          <TableCell className="py-2.5 pr-4">
                            <Badge
                              variant="secondary"
                              className={cn(
                                "h-5 border-0 px-2 text-[10px] font-semibold",
                                s.action === "Traded" &&
                                  "bg-blue-500/15 text-blue-400",
                                s.action === "Skipped" &&
                                  "bg-muted text-muted-foreground",
                                s.action === "Pending" &&
                                  "bg-amber-500/15 text-amber-500"
                              )}
                            >
                              {s.action}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex flex-col items-center justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Rows per page</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => {
                      setPageSize(Number(v))
                      setPage(0)
                    }}
                  >
                    <SelectTrigger
                      id={`${id}-page-size`}
                      className="h-7 w-16 bg-transparent text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZES.map((s) => (
                        <SelectItem key={s} value={String(s)}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    Page {page + 1} of {totalPages}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={page === 0}
                      onClick={() => setPage((p) => p - 1)}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={page >= totalPages - 1}
                      onClick={() => setPage((p) => p + 1)}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
