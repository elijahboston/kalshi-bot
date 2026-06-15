import { useState } from "react"
import { Settings, FlaskConical } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { useApiStore } from "@/src/lib/store"
import { fmtMoney, fmtPct } from "@/src/lib/format"
import { API_BASE } from "@/src/lib/config"

/**
 * Interactive dry-run toggle. Optimistically flips, then PATCHes the config
 * endpoint and persists to runtime_config. On failure, rolls back.
 */
function DryRunRow({ initialValue }: { initialValue: boolean }) {
  const [checked, setChecked] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    const prev = checked
    setChecked(next)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/config/dry-run`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: next }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
    } catch (err) {
      // Revert optimistic update
      setChecked(prev)
      setError(err instanceof Error ? err.message : "unknown error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Dry Run
        </span>
        {checked && (
          <Badge
            variant="outline"
            className="gap-1 border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-500"
          >
            <FlaskConical className="h-3 w-3" />
            Paper
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        {error && (
          <span className="text-xs text-red-500" title={`Failed to save: ${error}`}>
            save failed
          </span>
        )}
        <Switch
          checked={checked}
          disabled={saving}
          onCheckedChange={handleChange}
        />
      </div>
    </div>
  )
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm text-foreground">{children}</span>
    </div>
  )
}

function SettingSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="px-5 pb-2 pt-4">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-4">
        <div className="divide-y divide-border">{children}</div>
      </CardContent>
    </Card>
  )
}

export function SettingsView() {
  const config = useApiStore((s) => s.config)

  if (!config) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Settings className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight text-foreground">
              Settings
            </h1>
            <p className="text-xs text-muted-foreground">
              Loading configuration...
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            Waiting for config data...
          </CardContent>
        </Card>
      </div>
    )
  }

  const { bot, calibration, log } = config

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Settings className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight text-foreground">
            Settings
          </h1>
          <p className="text-xs text-muted-foreground">
            Current bot configuration (read-only)
          </p>
        </div>
      </div>

      {/* Trading Parameters */}
      <SettingSection title="Trading Parameters">
        <DryRunRow initialValue={bot.dryRun} />
        <SettingRow label="Edge Threshold">{fmtPct(bot.edgeThreshold)}</SettingRow>
        <SettingRow label="Min Confidence">{fmtPct(bot.minConfidence)}</SettingRow>
        <SettingRow label="Max Kelly Fraction">{fmtPct(bot.maxKellyFraction)}</SettingRow>
        <SettingRow label="Max Open Positions">{bot.maxOpenPositions}</SettingRow>
        <SettingRow label="Max Contracts / Order">{bot.maxContractsPerOrder}</SettingRow>
        <SettingRow label="Tick Interval">{bot.tickIntervalSec}s</SettingRow>
        <SettingRow label="Min Contract Price">{fmtMoney(bot.minContractPrice)}</SettingRow>
      </SettingSection>

      {/* Risk Management */}
      <SettingSection title="Risk Management">
        <SettingRow label="Max Exposure / Ticker">{fmtMoney(bot.maxExposurePerTicker)}</SettingRow>
        <SettingRow label="Stop Loss">{fmtPct(bot.stopLossPct)}</SettingRow>
        <SettingRow label="Stop Loss Min Edge">{fmtPct(bot.stopLossMinEdge)}</SettingRow>
        <SettingRow label="Min Balance Floor">{fmtMoney(bot.minBalanceFloor)}</SettingRow>
        <SettingRow label="Seed Capital">{fmtMoney(bot.seedCapital)}</SettingRow>
        <SettingRow label="Profit Reserve">{fmtPct(bot.profitReservePct)}</SettingRow>
      </SettingSection>

      {/* Exit Strategy */}
      <SettingSection title="Exit Strategy">
        <SettingRow label="Exit Edge Threshold">{fmtPct(bot.exitEdgeThreshold)}</SettingRow>
        <SettingRow label="Days Before Close">{bot.exitTimeDaysBeforeClose}</SettingRow>
        <SettingRow label="Exit Time Min Edge">{fmtPct(bot.exitTimeMinEdge)}</SettingRow>
        <SettingRow label="Exit Cooldown Ticks">{bot.exitCooldownTicks}</SettingRow>
        <SettingRow label="Sniper Horizon">{bot.sniperHorizonHours}h</SettingRow>
      </SettingSection>

      {/* Calibration */}
      <SettingSection title="Calibration">
        <SettingRow label="Bias Window">{calibration.biasWindowDays} days</SettingRow>
        <SettingRow label="Calibration Window">{calibration.calibrationWindowDays} days</SettingRow>
        <SettingRow label="Max Calibration Error">{fmtPct(calibration.maxCalibrationError)}</SettingRow>
      </SettingSection>

      {/* Series & Stations */}
      <SettingSection title="Enabled Series & Stations">
        <div className="py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Series
          </span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {bot.enabledSeries.map((s) => (
              <Badge key={s} variant="secondary" className="text-xs">
                {s}
              </Badge>
            ))}
          </div>
        </div>
        <Separator />
        <div className="py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Stations
          </span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {bot.enabledStations.map((s) => (
              <Badge key={s} variant="secondary" className="font-mono text-xs">
                {s}
              </Badge>
            ))}
          </div>
        </div>
      </SettingSection>

      {/* Logging */}
      <SettingSection title="Logging">
        <SettingRow label="Log Level">
          <Badge variant="outline" className="text-xs capitalize">
            {log.level}
          </Badge>
        </SettingRow>
      </SettingSection>
    </div>
  )
}
