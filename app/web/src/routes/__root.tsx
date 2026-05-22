import { createRootRoute, Outlet } from "@tanstack/react-router"
import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { ApiProvider } from "@/src/lib/api-context"

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <ApiProvider>
      <DashboardShell>
        <Outlet />
      </DashboardShell>
    </ApiProvider>
  )
}
