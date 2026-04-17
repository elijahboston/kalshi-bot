import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Percent,
  Wallet,
} from "lucide-react"

interface StatCardProps {
  label: string
  value: string
  type?: "currency" | "pnl" | "percentage"
  isPositive?: boolean
  icon?: "balance" | "equity" | "pnl" | "winrate"
}

const iconMap = {
  balance: Wallet,
  equity: DollarSign,
  pnl: TrendingUp,
  winrate: Percent,
}

export function StatCard({
  label,
  value,
  type = "currency",
  isPositive,
  icon = "balance",
}: StatCardProps) {
  const Icon =
    icon === "pnl" && isPositive === false ? TrendingDown : iconMap[icon]

  return (
    <Card className="relative overflow-hidden p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </span>
          <span
            className={cn(
              "text-xl font-bold tracking-tight sm:text-2xl",
              type === "pnl" && isPositive === true && "text-emerald-500",
              type === "pnl" && isPositive === false && "text-red-500"
            )}
          >
            {value}
          </span>
        </div>
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            type === "pnl" &&
              isPositive === true &&
              "bg-emerald-500/10 text-emerald-500",
            type === "pnl" &&
              isPositive === false &&
              "bg-red-500/10 text-red-500",
            type !== "pnl" && "bg-primary/10 text-primary"
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
      </div>
    </Card>
  )
}
