import { useState } from "react"
import { Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { PaperModeBanner } from "@/components/dashboard/paper-mode-banner"
import { cn } from "@/lib/utils"

const SIDEBAR_WIDTH = "16rem" // 256px

interface DashboardShellProps {
  children: React.ReactNode
}

export function DashboardShell({ children }: DashboardShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* ── Desktop sidebar ── */}
      <aside
        className={cn(
          "hidden shrink-0 border-r border-[hsl(var(--sidebar-border))] lg:block"
        )}
        style={{ width: SIDEBAR_WIDTH }}
      >
        <AppSidebar />
      </aside>

      {/* ── Mobile sidebar (Sheet) ── */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-72 p-0 bg-[hsl(var(--sidebar-background))] border-[hsl(var(--sidebar-border))]"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <AppSidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* ── Main content area ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Persistent dry-run banner on every page (no-op when live) */}
        <PaperModeBanner />
        {/* Mobile header bar */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">
              CB
            </div>
            <span className="text-sm font-semibold text-foreground">
              Climate Bot
            </span>
          </div>
        </header>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl flex flex-col gap-5 p-4 md:p-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
