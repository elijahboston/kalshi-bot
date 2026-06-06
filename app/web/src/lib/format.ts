/** Format cents (integer) as dollars: 7594 → "$75.94" */
export function fmtMoney(cents: number): string {
  return "$" + (cents / 100).toFixed(2)
}

/** Format cents as signed PnL: 150 → "+$1.50", -200 → "-$2.00" */
export function fmtPnl(cents: number): string {
  const prefix = cents >= 0 ? "+" : ""
  return prefix + fmtMoney(Math.abs(cents))
}

/** Format probability (0-1) as percentage: 0.653 → "65.3%" */
export function fmtPct(prob: number): string {
  return (prob * 100).toFixed(1) + "%"
}

/** Format a contract price (0-1) as cents: 0.21 → "21¢" */
export function fmtPrice(price: number): string {
  return Math.round(price * 100) + "¢"
}

/** Format edge (0-1) as signed cents: 0.12 → "+12.0¢", -0.05 → "-5.0¢" */
export function fmtEdge(edge: number): string {
  const cents = edge * 100
  return (cents >= 0 ? "+" : "") + cents.toFixed(1) + "¢"
}

/** Format ISO string as relative time: "2m ago", "in 4h", "3d" */
export function fmtRelTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const abs = Math.abs(ms)
  const prefix = ms < 0 ? "in " : ""
  const suffix = ms >= 0 ? " ago" : ""

  if (abs < 60_000) return "just now"
  if (abs < 3600_000) return prefix + Math.floor(abs / 60_000) + "m" + suffix
  if (abs < 86400_000) return prefix + (abs / 3600_000).toFixed(1) + "h" + suffix
  return prefix + (abs / 86400_000).toFixed(1) + "d" + suffix
}

/** Format close time / target date as hours-to-close */
export function fmtTimeToClose(closeTime: string | null, targetDate: string | null): string {
  let closeMs: number
  if (closeTime) {
    closeMs = new Date(closeTime).getTime()
  } else if (targetDate) {
    closeMs = new Date(targetDate + "T23:59:00Z").getTime()
  } else {
    return "—"
  }
  const hoursLeft = (closeMs - Date.now()) / 3_600_000
  if (hoursLeft <= 0) return "closed"
  if (hoursLeft < 1) return `${(hoursLeft * 60).toFixed(0)}m`
  if (hoursLeft < 24) return `${hoursLeft.toFixed(1)}h`
  return `${(hoursLeft / 24).toFixed(1)}d`
}
