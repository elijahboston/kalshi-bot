import { createFileRoute } from "@tanstack/react-router"
import { MarketsGrid } from "@/components/markets/markets-grid"

export const Route = createFileRoute("/markets")({
  component: MarketsPage,
})

function MarketsPage() {
  return <MarketsGrid />
}
