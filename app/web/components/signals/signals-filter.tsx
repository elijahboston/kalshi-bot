import { useId } from "react"
import { CalendarDays } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export type DateRange = "today" | "7d" | "30d" | "all"

interface SignalsFilterProps {
  minEdge: number
  onMinEdgeChange: (value: number) => void
  marketType: string
  onMarketTypeChange: (value: string) => void
  dateRange: DateRange
  onDateRangeChange: (value: DateRange) => void
}

const MARKET_TYPES = [
  { value: "all", label: "All Markets" },
  { value: "hightemp", label: "High Temp" },
  { value: "lowtemp", label: "Low Temp" },
  { value: "precipitation", label: "Precipitation" },
  { value: "wind", label: "Wind Speed" },
]

const DATE_PRESETS: { value: DateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
]

export function SignalsFilter({
  minEdge,
  onMinEdgeChange,
  marketType,
  onMarketTypeChange,
  dateRange,
  onDateRangeChange,
}: SignalsFilterProps) {
  const id = useId()
  const marketTypeId = `${id}-market-type`

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        {/* Min Edge slider */}
        <div className="flex flex-col gap-2 sm:w-52">
          <div className="flex items-center justify-between">
            <label
              htmlFor={`${id}-slider`}
              className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"
            >
              Min Edge
            </label>
            <span className="font-mono text-xs font-semibold text-foreground">
              {minEdge}%
            </span>
          </div>
          <Slider
            id={`${id}-slider`}
            min={0}
            max={50}
            step={1}
            value={[minEdge]}
            onValueChange={([v]) => onMinEdgeChange(v)}
            className="w-full"
          />
        </div>

        {/* Market Type select */}
        <div className="flex flex-col gap-1.5 sm:w-44">
          <label
            htmlFor={marketTypeId}
            className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"
          >
            Market Type
          </label>
          <Select value={marketType} onValueChange={onMarketTypeChange}>
            <SelectTrigger id={marketTypeId} className="h-9 bg-card text-sm">
              <SelectValue placeholder="All Markets" />
            </SelectTrigger>
            <SelectContent>
              {MARKET_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Date range */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Date Range
          </span>
          <div className="flex items-center gap-1">
            <CalendarDays className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
            {DATE_PRESETS.map((p) => (
              <Button
                key={p.value}
                variant="outline"
                size="sm"
                onClick={() => onDateRangeChange(p.value)}
                className={cn(
                  "h-9 px-3 text-xs",
                  dateRange === p.value &&
                    "border-primary/50 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                )}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
