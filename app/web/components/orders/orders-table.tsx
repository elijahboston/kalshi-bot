import { useId, useMemo, useState, useCallback } from "react"
import {
  FileText,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
} from "lucide-react"
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
import { useApiContext } from "@/src/lib/api-context"
import { fmtMoney, fmtPct, fmtRelTime } from "@/src/lib/format"

type SortKey = "createdAt" | "ticker" | "limitPrice" | "status"
type SortDir = "asc" | "desc"

const PAGE_SIZES = [10, 25, 50]
const STATUS_FILTERS = ["all", "open", "filled", "canceled", "partial"] as const

function statusBadgeClass(status: string) {
  switch (status.toLowerCase()) {
    case "open":
    case "resting":
      return "bg-blue-500/15 text-blue-400"
    case "filled":
    case "executed":
      return "bg-emerald-500/15 text-emerald-500"
    case "canceled":
    case "cancelled":
      return "bg-muted text-muted-foreground"
    case "partial":
    case "partially_filled":
      return "bg-amber-500/15 text-amber-500"
    default:
      return "bg-muted text-muted-foreground"
  }
}

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

export function OrdersTable() {
  const id = useId()
  const { orders } = useApiContext()

  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [hideDryRun, setHideDryRun] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>("createdAt")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
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

  const filtered = useMemo(() => {
    let data = [...orders]

    if (statusFilter !== "all") {
      data = data.filter((o) => o.status.toLowerCase().includes(statusFilter))
    }
    if (hideDryRun) {
      data = data.filter((o) => !o.dryRun)
    }

    data.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case "createdAt":
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          break
        case "ticker":
          cmp = a.ticker.localeCompare(b.ticker)
          break
        case "limitPrice":
          cmp = a.limitPrice - b.limitPrice
          break
        case "status":
          cmp = a.status.localeCompare(b.status)
          break
      }
      return sortDir === "asc" ? cmp : -cmp
    })

    return data
  }, [orders, statusFilter, hideDryRun, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <TooltipProvider delayDuration={100}>
      <div className="flex flex-col gap-5">
        {/* Page header */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight text-foreground">
              Orders
            </h1>
            <p className="text-xs text-muted-foreground">
              {filtered.length} order{filtered.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-1.5">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setStatusFilter(s)
                  setPage(0)
                }}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                  statusFilter === s
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="h-5 w-px bg-border" />
          <button
            onClick={() => {
              setHideDryRun((v) => !v)
              setPage(0)
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              hideDryRun
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <FlaskConical className="h-3 w-3" />
            Hide dry run
          </button>
        </div>

        {/* Table */}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <FileText className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">
                No orders found
              </p>
              <p className="text-xs text-muted-foreground/70">
                Orders will appear here once the bot places trades.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-9 pl-4 text-[11px] font-semibold uppercase tracking-widest">
                        Order ID
                      </TableHead>
                      <SortableHead label="Ticker" sortKey="ticker" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">Action</TableHead>
                      <TableHead className="h-9 text-[11px] font-semibold uppercase tracking-widest">Side</TableHead>
                      <SortableHead label="Price" sortKey="limitPrice" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
                      <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">Filled</TableHead>
                      <SortableHead label="Status" sortKey="status" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <TableHead className="h-9 text-right text-[11px] font-semibold uppercase tracking-widest">Kelly</TableHead>
                      <SortableHead label="Time" sortKey="createdAt" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="pr-4 text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map((order) => {
                      const side = order.side.toUpperCase()
                      return (
                        <TableRow key={order.orderId}>
                          <TableCell className="py-2.5 pl-4">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default font-mono text-[12px] text-muted-foreground">
                                  {order.orderId.slice(0, 8)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <span className="font-mono text-xs">{order.orderId}</span>
                              </TooltipContent>
                            </Tooltip>
                            {order.dryRun && (
                              <FlaskConical className="ml-1.5 inline h-3 w-3 text-amber-500" />
                            )}
                          </TableCell>
                          <TableCell className="py-2.5 font-mono text-[13px] font-medium text-foreground whitespace-nowrap">
                            {order.ticker}
                          </TableCell>
                          <TableCell className="py-2.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
                                order.action.toLowerCase() === "buy"
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                                  : "border-red-500/30 bg-red-500/10 text-red-500"
                              )}
                            >
                              {order.action}
                            </Badge>
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
                          <TableCell className="py-2.5 text-right font-mono text-[13px] tabular-nums text-foreground">
                            {fmtMoney(order.limitPrice)}
                          </TableCell>
                          <TableCell className="py-2.5 text-right font-mono text-[13px] tabular-nums text-muted-foreground">
                            {order.filledQuantity}/{order.quantity}
                          </TableCell>
                          <TableCell className="py-2.5">
                            <Badge
                              variant="secondary"
                              className={cn(
                                "h-5 border-0 px-2 text-[10px] font-semibold capitalize",
                                statusBadgeClass(order.status)
                              )}
                            >
                              {order.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                            {order.kellyFraction != null ? fmtPct(order.kellyFraction) : "—"}
                          </TableCell>
                          <TableCell className="py-2.5 pr-4 text-right text-xs text-muted-foreground whitespace-nowrap">
                            {fmtRelTime(order.createdAt)}
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
                    <SelectTrigger id={`${id}-page-size`} className="h-7 w-16 bg-transparent text-xs">
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
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
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
