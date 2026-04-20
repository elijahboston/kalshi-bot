import { createFileRoute } from "@tanstack/react-router"
import { LogsViewer } from "@/components/logs/logs-viewer"

export const Route = createFileRoute("/logs")({
  component: LogsPage,
})

function LogsPage() {
  return <LogsViewer />
}
