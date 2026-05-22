import { useMemo, useState } from "react"
import { BarChart3 } from "lucide-react"
import { MarketsFilter } from "@/components/markets/markets-filter"
import { MarketCard, type MarketData } from "@/components/markets/market-card"

// ── Sample data ──────────────────────────────────────────────────────────────

const SAMPLE_MARKETS: MarketData[] = [
  {
    id: "1",
    ticker: "KXHIGHNY-25FEB10-B33",
    subtitle: "32\u00B0 to 33\u00B0",
    yesPrice: 0.45,
    estimate: 0.53,
    edge: 0.08,
    status: "Open",
    volume: 12400,
    liquidity: 3200,
  },
  {
    id: "2",
    ticker: "KXHIGHNY-25FEB10-B35",
    subtitle: "34\u00B0 to 35\u00B0",
    yesPrice: 0.32,
    estimate: 0.28,
    edge: -0.04,
    status: "Open",
    volume: 8900,
    liquidity: 2100,
  },
  {
    id: "3",
    ticker: "KXHIGHNY-25FEB10-B37",
    subtitle: "36\u00B0 to 37\u00B0",
    yesPrice: 0.18,
    estimate: 0.24,
    edge: 0.06,
    status: "Open",
    volume: 5600,
    liquidity: 1400,
  },
  {
    id: "4",
    ticker: "KXHIGHCHI-25FEB10-B22",
    subtitle: "21\u00B0 to 22\u00B0",
    yesPrice: 0.52,
    estimate: 0.48,
    edge: -0.04,
    status: "Open",
    volume: 10200,
    liquidity: 2800,
  },
  {
    id: "5",
    ticker: "KXHIGHCHI-25FEB10-B24",
    subtitle: "23\u00B0 to 24\u00B0",
    yesPrice: 0.28,
    estimate: 0.35,
    edge: 0.07,
    status: "Open",
    volume: 7800,
    liquidity: 1900,
  },
  {
    id: "6",
    ticker: "KXHIGHMIA-25FEB10-B78",
    subtitle: "77\u00B0 to 78\u00B0",
    yesPrice: 0.61,
    estimate: 0.72,
    edge: 0.11,
    status: "Open",
    volume: 15600,
    liquidity: 4200,
  },
  {
    id: "7",
    ticker: "KXHIGHMIA-25FEB10-B80",
    subtitle: "79\u00B0 to 80\u00B0",
    yesPrice: 0.25,
    estimate: 0.19,
    edge: -0.06,
    status: "Closed",
    volume: 4300,
    liquidity: 800,
  },
  {
    id: "8",
    ticker: "KXHIGHLA-25FEB10-B68",
    subtitle: "67\u00B0 to 68\u00B0",
    yesPrice: 0.38,
    estimate: 0.46,
    edge: 0.08,
    status: "Open",
    volume: 9100,
    liquidity: 2400,
  },
  {
    id: "9",
    ticker: "KXHIGHDEN-25FEB10-B42",
    subtitle: "41\u00B0 to 42\u00B0",
    yesPrice: 0.41,
    estimate: 0.39,
    edge: -0.02,
    status: "Settled",
    volume: 11000,
    liquidity: 3100,
  },
  {
    id: "10",
    ticker: "KXHIGHATL-25FEB10-B55",
    subtitle: "54\u00B0 to 55\u00B0",
    yesPrice: 0.33,
    estimate: 0.42,
    edge: 0.09,
    status: "Open",
    volume: 6700,
    liquidity: 1600,
  },
  {
    id: "11",
    ticker: "KXHIGHNY-25FEB10-B31",
    subtitle: "30\u00B0 to 31\u00B0",
    yesPrice: 0.12,
    estimate: 0.15,
    edge: 0.03,
    status: "Open",
    volume: 3400,
    liquidity: 900,
  },
  {
    id: "12",
    ticker: "KXHIGHCHI-25FEB10-B20",
    subtitle: "19\u00B0 to 20\u00B0",
    yesPrice: 0.08,
    estimate: 0.11,
    edge: 0.03,
    status: "Open",
    volume: 2100,
    liquidity: 500,
  },
]

// ── Series matcher ───────────────────────────────────────────────────────────

const SERIES_PREFIX: Record<string, string> = {
  nyc: "KXHIGHNY",
  chi: "KXHIGHCHI",
  mia: "KXHIGHMIA",
  la: "KXHIGHLA",
  den: "KXHIGHDEN",
  atl: "KXHIGHATL",
}

// ── Component ────────────────────────────────────────────────────────────────

export function MarketsGrid() {
  const [series, setSeries] = useState("all")
  const [sortBy, setSortBy] = useState("edge")
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    let result = [...SAMPLE_MARKETS]

    // Series filter
    if (series !== "all") {
      const prefix = SERIES_PREFIX[series]
      if (prefix) {
        result = result.filter((m) => m.ticker.startsWith(prefix))
      }
    }

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (m) =>
          m.ticker.toLowerCase().includes(q) ||
          m.subtitle.toLowerCase().includes(q)
      )
    }

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case "edge":
          return Math.abs(b.edge) - Math.abs(a.edge)
        case "volume":
          return (b.volume ?? 0) - (a.volume ?? 0)
        case "liquidity":
          return (b.liquidity ?? 0) - (a.liquidity ?? 0)
        default:
          return 0
      }
    })

    return result
  }, [series, sortBy, search])

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <BarChart3 className="h-4.5 w-4.5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight text-foreground">
            Markets
          </h1>
          <p className="text-xs text-muted-foreground">
            {filtered.length} markets found
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <MarketsFilter
        series={series}
        onSeriesChange={setSeries}
        sortBy={sortBy}
        onSortChange={setSortBy}
        search={search}
        onSearchChange={setSearch}
      />

      {/* Grid or empty state */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-16">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">
            No markets match your filters
          </p>
          <p className="text-xs text-muted-foreground/70">
            Try adjusting the series or search query.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      )}
    </div>
  )
}
