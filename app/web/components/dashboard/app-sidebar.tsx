import { useApiContext } from "@/src/lib/api-context"
import { Link, useLocation } from "@tanstack/react-router"
import {
  LayoutDashboard,
  BarChart3,
  Zap,
  TrendingUp,
  FileText,
  Target,
  Settings,
  Terminal,
  type LucideIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface NavItem {
  label: string
  icon: LucideIcon
  href: string
}

const navItems: NavItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/" },
  { label: "Markets", icon: BarChart3, href: "/markets" },
  { label: "Signals", icon: Zap, href: "/signals" },
  { label: "Positions", icon: TrendingUp, href: "/positions" },
  { label: "Orders", icon: FileText, href: "/orders" },
  { label: "Calibration", icon: Target, href: "/calibration" },
  { label: "Settings", icon: Settings, href: "/settings" },
  { label: "Logs", icon: Terminal, href: "/logs" },
]

interface AppSidebarProps {
  onNavigate?: () => void
}

export function AppSidebar({
  onNavigate,
}: AppSidebarProps) {
  const { pathname } = useLocation()
  const api = useApiContext()
  const connected = api.connected
  const botStatus: "Running" | "Stopped" | "Dry Run" =
    api.status?.running
      ? api.status.dryRun
        ? "Dry Run"
        : "Running"
      : "Stopped"
  const environment: "Production" | "Demo" =
    api.config?.bot.dryRun ? "Demo" : "Production"

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full flex-col bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]">
        {/* ── Brand ── */}
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground text-sm">
            CB
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight text-[hsl(var(--sidebar-foreground))]">
              Climate Bot
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  connected
                    ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]"
                    : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]"
                )}
                aria-hidden="true"
              />
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>

        <Separator className="bg-[hsl(var(--sidebar-border))]" />

        {/* ── Navigation ── */}
        <ScrollArea className="flex-1 px-3 py-3">
          <nav aria-label="Main navigation">
            <ul className="flex flex-col gap-0.5" role="list">
              {navItems.map((item) => {
                const isActive = pathname === item.href
                const Icon = item.icon
                return (
                  <li key={item.href}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link
                          to={item.href}
                          onClick={onNavigate}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                            isActive
                              ? "bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-primary))]"
                              : "text-muted-foreground hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))]"
                          )}
                          aria-current={isActive ? "page" : undefined}
                        >
                          <Icon
                            className={cn(
                              "h-4 w-4 shrink-0",
                              isActive
                                ? "text-[hsl(var(--sidebar-primary))]"
                                : "text-muted-foreground"
                            )}
                          />
                          {item.label}
                          {item.label === "Signals" && (
                            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                              3
                            </span>
                          )}
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="lg:hidden">
                        {item.label}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          </nav>
        </ScrollArea>

        {/* ── Footer ── */}
        <Separator className="bg-[hsl(var(--sidebar-border))]" />
        <div className="flex flex-col gap-2 px-4 py-4">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Status
            </span>
            <Badge
              variant="secondary"
              className={cn(
                "h-5 gap-1 border-0 px-2 text-[10px] font-semibold",
                botStatus === "Running" && "bg-emerald-500/15 text-emerald-500",
                botStatus === "Stopped" && "bg-muted text-muted-foreground",
                botStatus === "Dry Run" && "bg-amber-500/15 text-amber-500"
              )}
            >
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  botStatus === "Running" && "bg-emerald-500",
                  botStatus === "Stopped" && "bg-muted-foreground",
                  botStatus === "Dry Run" && "bg-amber-500"
                )}
              />
              {botStatus}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Environment
            </span>
            <Badge
              variant="outline"
              className={cn(
                "h-5 border px-2 text-[10px] font-semibold",
                environment === "Production"
                  ? "border-emerald-500/30 text-emerald-500"
                  : "border-amber-500/30 text-amber-500"
              )}
            >
              {environment === "Production" ? "Kalshi Prod" : "Kalshi Demo"}
            </Badge>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
