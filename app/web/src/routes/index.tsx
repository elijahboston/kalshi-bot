import { createFileRoute } from "@tanstack/react-router"
import { DashboardHeader } from "@/components/dashboard/dashboard-header"
import { EquityCurve } from "@/components/dashboard/equity-curve"
import { WeeklyWinRateHeatmap } from "@/components/dashboard/weekly-win-rate-heatmap"
import { ActivePositions } from "@/components/dashboard/active-positions"

export const Route = createFileRoute("/")({
  component: DashboardPage,
})

function DashboardPage() {
  return (
    <>
      <DashboardHeader />
      <EquityCurve />
      <WeeklyWinRateHeatmap />
      <ActivePositions />
    </>
  )
}
