import { useMemo, useState, useRef, useEffect, useCallback } from "react"
import { Terminal, ArrowDown } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useApiStore } from "@/src/lib/store"

const LEVELS = ["all", "debug", "info", "warn", "error"] as const

function levelColor(level: string) {
  switch (level) {
    case "error":
      return "text-red-400 bg-red-500/15"
    case "warn":
      return "text-amber-400 bg-amber-500/15"
    case "info":
      return "text-blue-400 bg-blue-500/15"
    case "debug":
      return "text-muted-foreground bg-muted"
    default:
      return "text-muted-foreground bg-muted"
  }
}

function rowTint(level: string) {
  switch (level) {
    case "error":
      return "bg-red-500/[0.04]"
    case "warn":
      return "bg-amber-500/[0.04]"
    default:
      return ""
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function LogsViewer() {
  const logs = useApiStore((s) => s.logs)

  const [levelFilter, setLevelFilter] = useState<string>("all")
  const [moduleFilter, setModuleFilter] = useState<string>("all")
  const [autoScroll, setAutoScroll] = useState(true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevLengthRef = useRef(0)

  const modules = useMemo(() => {
    const set = new Set(logs.map((l) => l.module))
    return Array.from(set).sort()
  }, [logs])

  const filtered = useMemo(() => {
    let data = logs
    if (levelFilter !== "all") {
      data = data.filter((l) => l.level === levelFilter)
    }
    if (moduleFilter !== "all") {
      data = data.filter((l) => l.module === moduleFilter)
    }
    return data
  }, [logs, levelFilter, moduleFilter])

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (autoScroll && scrollRef.current && filtered.length > prevLengthRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevLengthRef.current = filtered.length
  }, [filtered.length, autoScroll])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  const jumpToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      setAutoScroll(true)
    }
  }, [])

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Terminal className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight text-foreground">
            Logs
          </h1>
          <p className="text-xs text-muted-foreground">
            {filtered.length} entr{filtered.length !== 1 ? "ies" : "y"}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-1.5">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => setLevelFilter(level)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                levelFilter === level
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {level}
            </button>
          ))}
        </div>
        <div className="h-5 w-px bg-border" />
        <Select value={moduleFilter} onValueChange={setModuleFilter}>
          <SelectTrigger className="h-8 w-40 bg-transparent text-xs">
            <SelectValue placeholder="All modules" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All modules</SelectItem>
            {modules.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Log viewer */}
      <div className="relative overflow-hidden rounded-lg border border-border bg-card">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <Terminal className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              No log entries
            </p>
            <p className="text-xs text-muted-foreground/70">
              Logs will stream here in real-time.
            </p>
          </div>
        ) : (
          <>
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="h-[calc(100vh-320px)] min-h-[300px] overflow-y-auto"
            >
              <table className="w-full">
                <tbody>
                  {filtered.map((entry, i) => (
                    <tr
                      key={`${entry.timestamp}-${i}`}
                      className={cn(
                        "border-b border-border/50 last:border-0",
                        rowTint(entry.level)
                      )}
                    >
                      <td className="whitespace-nowrap px-3 py-1.5 align-top font-mono text-[11px] text-muted-foreground">
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td className="px-1.5 py-1.5 align-top">
                        <span
                          className={cn(
                            "inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
                            levelColor(entry.level)
                          )}
                        >
                          {entry.level}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 align-top text-[11px] font-medium text-muted-foreground">
                        [{entry.module}]
                      </td>
                      <td className="px-3 py-1.5 align-top text-xs text-foreground">
                        {entry.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Jump to bottom */}
            {!autoScroll && (
              <div className="absolute bottom-3 right-3">
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 gap-1.5 rounded-full shadow-lg text-xs"
                  onClick={jumpToBottom}
                >
                  <ArrowDown className="h-3 w-3" />
                  Jump to bottom
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
