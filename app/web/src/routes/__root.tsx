import { useEffect } from "react"
import { createRootRoute, Outlet } from "@tanstack/react-router"
import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { initApi } from "@/src/lib/store"

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  // Start the data layer (REST load + WebSocket) once for the app's lifetime.
  useEffect(() => initApi(), [])

  return (
    <DashboardShell>
      <Outlet />
    </DashboardShell>
  )
}
