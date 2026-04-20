import { createFileRoute } from "@tanstack/react-router"
import { PositionsTable } from "@/components/positions/positions-table"

export const Route = createFileRoute("/positions")({
  component: PositionsPage,
})

function PositionsPage() {
  return <PositionsTable />
}
