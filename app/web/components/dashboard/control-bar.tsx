import { Clock, FlaskConical } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useApiContext } from "@/src/lib/api-context"

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`
  return `${s}s`
}

export function ControlBar() {
  const { status: botStatus } = useApiContext()

  const isRunning = botStatus?.running ?? false
  const isDryRun = botStatus?.dryRun ?? false
  const label = isRunning ? (isDryRun ? "Dry Run" : "Running") : "Stopped"

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
      {/* Left: tick info */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          Ticks:{" "}
          <span className="font-mono font-medium text-foreground">
            {botStatus?.tickCount ?? 0}
          </span>
        </span>
        {botStatus?.lastTickAt && (
          <span>
            Last tick:{" "}
            <span className="font-mono text-foreground">
              {botStatus.lastTickAt.slice(11, 19)}
            </span>
          </span>
        )}
      </div>

      {/* Right: status + uptime */}
      <div className="flex items-center gap-3">
        <Badge
          variant="secondary"
          className={cn(
            "gap-1.5 border-0 px-3 py-1 text-xs font-semibold",
            label === "Running" && "bg-emerald-500/15 text-emerald-500",
            label === "Stopped" && "bg-muted text-muted-foreground",
            label === "Dry Run" && "bg-amber-500/15 text-amber-500",
          )}
        >
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              label === "Running" &&
                "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]",
              label === "Stopped" && "bg-muted-foreground",
              label === "Dry Run" &&
                "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.7)]",
            )}
          />
          {label}
        </Badge>

        {isDryRun && (
          <Badge variant="outline" className="gap-1 border-amber-500/30 text-amber-500 text-xs">
            <FlaskConical className="h-3 w-3" />
            Dry Run
          </Badge>
        )}

        {isRunning && botStatus && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>
              {"Uptime "}
              <span className="font-mono font-medium text-foreground">
                {formatUptime(botStatus.uptime)}
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
