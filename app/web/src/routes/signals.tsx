import { createFileRoute } from "@tanstack/react-router"
import { SignalsTable } from "@/components/signals/signals-table"

export const Route = createFileRoute("/signals")({
  component: SignalsPage,
})

function SignalsPage() {
  return <SignalsTable />
}
