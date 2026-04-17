import { createFileRoute } from "@tanstack/react-router"
import { DashboardHeader } from "@/components/dashboard/dashboard-header"
import { EquityCurve } from "@/components/dashboard/equity-curve"
import { ActivePositions } from "@/components/dashboard/active-positions"

export const Route = createFileRoute("/")({
  component: DashboardPage,
})

function DashboardPage() {
  return (
    <>
      <DashboardHeader />
      <EquityCurve />
      <ActivePositions />
    </>
  )
}
