import { useId } from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface MarketsFilterProps {
  series: string
  onSeriesChange: (value: string) => void
  sortBy: string
  onSortChange: (value: string) => void
  search: string
  onSearchChange: (value: string) => void
}

const SERIES_OPTIONS = [
  { value: "all", label: "All Series" },
  { value: "nyc", label: "NYC High Temp" },
  { value: "chi", label: "Chicago High Temp" },
  { value: "mia", label: "Miami High Temp" },
  { value: "la", label: "LA High Temp" },
  { value: "den", label: "Denver High Temp" },
  { value: "atl", label: "Atlanta High Temp" },
]

const SORT_OPTIONS = [
  { value: "edge", label: "Edge" },
  { value: "volume", label: "Volume" },
  { value: "liquidity", label: "Liquidity" },
]

export function MarketsFilter({
  series,
  onSeriesChange,
  sortBy,
  onSortChange,
  search,
  onSearchChange,
}: MarketsFilterProps) {
  const id = useId()
  const seriesId = `${id}-series`
  const sortId = `${id}-sort`
  const searchId = `${id}-search`

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Select value={series} onValueChange={onSeriesChange}>
        <SelectTrigger id={seriesId} className="h-9 w-full bg-card text-sm sm:w-44">
          <SelectValue placeholder="All Series" />
        </SelectTrigger>
        <SelectContent>
          {SERIES_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={sortBy} onValueChange={onSortChange}>
        <SelectTrigger id={sortId} className="h-9 w-full bg-card text-sm sm:w-36">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={searchId}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search markets..."
          className="h-9 bg-card pl-8 text-sm"
        />
      </div>
    </div>
  )
}
