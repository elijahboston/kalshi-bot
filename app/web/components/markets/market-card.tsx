import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export interface MarketData {
  id: string
  ticker: string
  subtitle: string
  yesPrice: number
  estimate: number
  edge: number
  status: "Open" | "Closed" | "Settled"
  volume?: number
  liquidity?: number
}

function formatCents(value: number): string {
  return `\u00A2${Math.round(value * 100)}`
}

function formatPercent(value: number, showSign = false): string {
  const sign = showSign && value > 0 ? "+" : ""
  return `${sign}${Math.round(value * 100)}%`
}

interface MarketCardProps {
  market: MarketData
}

export function MarketCard({ market }: MarketCardProps) {
  const edgePositive = market.edge > 0
  const pricePercent = Math.round(market.yesPrice * 100)
  const estimatePercent = Math.round(market.estimate * 100)

  return (
    <Card className="flex flex-col gap-3 p-4 transition-colors hover:bg-accent/40">
      {/* Header row: ticker + status */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 overflow-hidden">
          <span className="truncate font-mono text-[13px] font-semibold leading-tight text-foreground">
            {market.ticker}
          </span>
          <span className="text-xs text-muted-foreground">
            {market.subtitle}
          </span>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
            market.status === "Open" &&
              "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
            market.status === "Closed" &&
              "border-muted-foreground/30 bg-muted text-muted-foreground",
            market.status === "Settled" &&
              "border-sky-500/30 bg-sky-500/10 text-sky-500"
          )}
        >
          {market.status}
        </Badge>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Yes Price
          </span>
          <span className="font-mono text-sm font-bold tabular-nums text-foreground">
            {formatCents(market.yesPrice)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Estimate
          </span>
          <span className="font-mono text-sm font-bold tabular-nums text-foreground">
            {formatPercent(market.estimate)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Edge
          </span>
          <span
            className={cn(
              "font-mono text-sm font-bold tabular-nums",
              edgePositive ? "text-emerald-500" : "text-red-500"
            )}
          >
            {formatPercent(market.edge, true)}
          </span>
        </div>
      </div>

      {/* Bar visualization: market price vs estimate */}
      <div className="flex flex-col gap-1.5">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
          {/* Market price bar (base) */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/30"
            style={{ width: `${pricePercent}%` }}
          />
          {/* Estimate overlay */}
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              edgePositive ? "bg-emerald-500/60" : "bg-red-500/60"
            )}
            style={{ width: `${estimatePercent}%` }}
          />
          {/* Price marker line */}
          <div
            className="absolute inset-y-0 w-0.5 bg-foreground/70 rounded-full"
            style={{ left: `${pricePercent}%` }}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {"Price " + formatCents(market.yesPrice)}
          </span>
          <span
            className={cn(
              "text-[10px] tabular-nums",
              edgePositive ? "text-emerald-500" : "text-red-500"
            )}
          >
            {"Est " + formatPercent(market.estimate)}
          </span>
        </div>
      </div>
    </Card>
  )
}
