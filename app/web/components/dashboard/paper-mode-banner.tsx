import { FlaskConical } from "lucide-react"
import { useApiContext } from "@/src/lib/api-context"

/**
 * Persistent top-of-page banner shown whenever the bot is in dry-run mode.
 * Visible on every page via DashboardShell to make it unmissable — balance
 * and PnL figures reflect simulated trades, not real Kalshi activity.
 */
export function PaperModeBanner() {
  const { status } = useApiContext()
  if (!status?.dryRun) return null

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" />
      <span className="font-semibold uppercase tracking-wide">
        Paper Trading Mode
      </span>
      <span className="text-amber-600/80 dark:text-amber-400/80">
        — Orders are not placed on Kalshi. Balance and PnL are simulated.
      </span>
    </div>
  )
}
