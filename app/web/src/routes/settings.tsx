import { createFileRoute } from "@tanstack/react-router"
import { SettingsView } from "@/components/settings/settings-view"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  return <SettingsView />
}
