import { createFileRoute } from "@tanstack/react-router"
import { CalibrationView } from "@/components/calibration/calibration-view"

export const Route = createFileRoute("/calibration")({
  component: CalibrationPage,
})

function CalibrationPage() {
  return <CalibrationView />
}
