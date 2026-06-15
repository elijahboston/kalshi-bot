import { StatCard } from "@/components/dashboard/stat-card"
import { ControlBar } from "@/components/dashboard/control-bar"
import { LayoutDashboard } from "lucide-react"
import { useApiContext } from "@/src/lib/api-context"

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPnl(value: number): string {
  const prefix = value >= 0 ? "+" : ""
  return prefix + formatCurrency(value)
}

export function DashboardHeader() {
  const { performance } = useApiContext()

  return (
    <header className="flex flex-col gap-5">
      {/* Title row */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <LayoutDashboard className="h-4.5 w-4.5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight text-foreground">
            Dashboard
          </h1>
          <p className="text-xs text-muted-foreground">
            Portfolio overview and bot controls
          </p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Balance"
          value={performance ? formatCurrency(performance.cash / 100) : "—"}
          type="currency"
          icon="balance"
        />
        <StatCard
          label="Total Equity"
          value={performance ? formatCurrency(performance.portfolio / 100) : "—"}
          type="currency"
          icon="equity"
        />
        <StatCard
          label="Total P&L"
          value={performance ? formatPnl(performance.realizedPnl / 100) : "—"}
          type="pnl"
          isPositive={performance ? performance.realizedPnl >= 0 : undefined}
          icon="pnl"
        />
        <StatCard
          label="Win Rate"
          value={performance ? `${(performance.winRate * 100).toFixed(1)}%` : "—"}
          type="percentage"
          icon="winrate"
        />
      </div>

      {/* Control bar */}
      <ControlBar />
    </header>
  )
}
