import type { PerformanceData } from "../lib/types";
import { categoryBadge, categoryFromTicker } from "../lib/category";

let perfData: PerformanceData | null = null;
let visible = false;
let chart: HTMLCanvasElement | null = null;

export function initPerformancePanel(): void {
  const panel = document.createElement("div");
  panel.id = "perf-panel";
  panel.classList.add("hidden");
  panel.innerHTML = `
    <div class="perf-header">
      <h3>PERFORMANCE</h3>
      <span class="perf-close" id="perf-close">&times;</span>
    </div>
    <div class="perf-grid">
      <div class="perf-stats" id="perf-stats"></div>
      <div class="perf-win-rates" id="perf-win-rates"></div>
    </div>
    <div class="perf-section">
      <h4>Equity <span id="equity-current" class="stat-value" style="float:right;font-size:12px"></span></h4>
      <canvas id="equity-chart" width="500" height="100"></canvas>
    </div>
    <div class="perf-section">
      <h4>Daily P&L</h4>
      <div id="perf-daily-pnl"></div>
    </div>
    <div class="perf-section">
      <h4>Recent Resolutions</h4>
      <div id="perf-resolutions"></div>
    </div>
  `;
  document.body.appendChild(panel);

  // Toggle button
  const btn = document.createElement("div");
  btn.id = "perf-toggle";
  btn.textContent = "PERF";
  btn.style.pointerEvents = "auto";
  btn.style.cursor = "pointer";
  document.getElementById("hud")?.appendChild(btn);

  btn.addEventListener("click", () => toggle());
  document.getElementById("perf-close")?.addEventListener("click", () => toggle(false));

  chart = document.getElementById("equity-chart") as HTMLCanvasElement;
}

function toggle(force?: boolean): void {
  visible = force !== undefined ? force : !visible;
  const panel = document.getElementById("perf-panel");
  if (panel) {
    panel.classList.toggle("hidden", !visible);
  }
  if (visible && perfData) render();
}

export async function loadPerformance(): Promise<void> {
  try {
    const res = await fetch("/api/performance");
    perfData = await res.json();
    if (visible) render();
  } catch {
    // ignore fetch errors
  }
}

function render(): void {
  if (!perfData) return;
  renderStats();
  renderWinRates();
  renderEquityChart();
  renderDailyPnl();
  renderResolutions();
}

function renderStats(): void {
  const el = document.getElementById("perf-stats");
  if (!el || !perfData) return;

  const d = perfData;
  const unrealClass = d.unrealizedPnl >= 0 ? "positive" : "negative";
  const realClass = d.realizedPnl >= 0 ? "positive" : "negative";

  // Update equity header with current portfolio value
  const eqLabel = document.getElementById("equity-current");
  if (eqLabel) eqLabel.textContent = `$${(d.portfolio / 100).toFixed(2)}`;

  el.innerHTML = `
    <div class="stat-row"><span class="stat-label">Cash</span><span class="stat-value">$${(d.cash / 100).toFixed(2)}</span></div>
    <div class="stat-row"><span class="stat-label">Portfolio</span><span class="stat-value">$${(d.portfolio / 100).toFixed(2)}</span></div>
    <div class="stat-row"><span class="stat-label">Unrealized</span><span class="stat-value ${unrealClass}">${d.unrealizedPnl >= 0 ? "+" : ""}$${(d.unrealizedPnl / 100).toFixed(2)}</span></div>
    <div class="stat-row"><span class="stat-label">Realized</span><span class="stat-value ${realClass}">${d.realizedPnl >= 0 ? "+" : ""}$${(d.realizedPnl / 100).toFixed(2)}</span></div>
    <div class="stat-row"><span class="stat-label">Win Rate</span><span class="stat-value">${(d.winRate * 100).toFixed(1)}%</span></div>
    <div class="stat-row"><span class="stat-label">Brier Score</span><span class="stat-value">${d.brierScore.toFixed(3)}</span></div>
    <div class="stat-row"><span class="stat-label">Orders</span><span class="stat-value">${d.orderCount}</span></div>
    <div class="stat-row"><span class="stat-label">Positions</span><span class="stat-value">${d.positionCount}</span></div>
  `;
}

function renderWinRates(): void {
  const el = document.getElementById("perf-win-rates");
  if (!el || !perfData) return;

  el.innerHTML = perfData.windowedWinRates.map((w) => {
    const rateClass = w.total === 0 ? "" : w.rate >= 0.5 ? "positive" : "negative";
    const rateStr = w.total === 0 ? "--" : `${(w.rate * 100).toFixed(1)}%`;
    return `<div class="win-rate-item">
      <span class="win-rate-label">${w.label}</span>
      <span class="stat-value ${rateClass}">${rateStr}</span>
      <span class="win-rate-detail">${w.wins}/${w.total}</span>
    </div>`;
  }).join("");
}

function renderEquityChart(): void {
  if (!chart || !perfData || perfData.equityHistory.length < 2) return;

  const ctx = chart.getContext("2d")!;
  const w = chart.width;
  const h = chart.height;
  const pts = perfData.equityHistory;

  ctx.clearRect(0, 0, w, h);

  const values = pts.map((p) => p.value / 100);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // Draw grid lines
  ctx.strokeStyle = "rgba(0, 255, 255, 0.1)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < pts.length; i++) {
    const x = (i / (pts.length - 1)) * w;
    const y = h - ((values[i]! - min) / range) * (h - 10) - 5;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill under
  const lastX = w;
  const lastY = h - ((values[values.length - 1]! - min) / range) * (h - 10) - 5;
  ctx.lineTo(lastX, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(0, 255, 136, 0.08)";
  ctx.fill();

  // Labels
  ctx.fillStyle = "#888";
  ctx.font = "10px monospace";
  ctx.fillText(`$${max.toFixed(0)}`, 2, 12);
  ctx.fillText(`$${min.toFixed(0)}`, 2, h - 2);
}

function renderDailyPnl(): void {
  const el = document.getElementById("perf-daily-pnl");
  if (!el || !perfData) return;

  if (perfData.dailyPnl.length === 0) {
    el.innerHTML = '<span class="muted">No daily data yet</span>';
    return;
  }

  const maxAbs = Math.max(...perfData.dailyPnl.map((d) => Math.abs(d.pnl)), 1);

  el.innerHTML = perfData.dailyPnl.map((d) => {
    const pct = Math.round((Math.abs(d.pnl) / maxAbs) * 100);
    const color = d.pnl >= 0 ? "#4caf50" : "#f44336";
    const sign = d.pnl >= 0 ? "+" : "-";
    const dayLabel = formatDay(d.date);
    return `<div class="pnl-row">
      <span class="pnl-label">${dayLabel}</span>
      <div class="pnl-bar-bg"><div class="pnl-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="pnl-value" style="color:${color}">${sign}$${(Math.abs(d.pnl) / 100).toFixed(2)}</span>
    </div>`;
  }).join("");
}

function renderResolutions(): void {
  const el = document.getElementById("perf-resolutions");
  if (!el || !perfData) return;

  if (perfData.resolutions.length === 0) {
    el.innerHTML = '<span class="muted">No resolutions yet</span>';
    return;
  }

  const header = `<div class="res-row res-header">
    <span class="res-ticker">Ticker</span>
    <span class="res-pred">Pred</span>
    <span class="res-actual">Actual</span>
    <span class="res-pnl">PnL</span>
  </div>`;

  const rows = perfData.resolutions.map((r) => {
    const pnl = r.realizedPnl;
    const pnlColor = pnl !== null && pnl > 0 ? "#4caf50" : pnl !== null && pnl < 0 ? "#f44336" : "#888";
    const pnlStr = pnl !== null
      ? `${pnl > 0 ? "+" : ""}$${(pnl / 100).toFixed(2)}`
      : "--";
    // Shorten ticker: KXHIGHNY-26MAR07-B50.5 → HIGHNY B50.5
    const short = r.ticker.replace(/^KX/, "").replace(/-\d{2}[A-Z]{3}\d{2}-/, " ");
    const badge = categoryBadge(categoryFromTicker(r.ticker));
    return `<div class="res-row">
      <span class="res-ticker">${badge}${short}</span>
      <span class="res-pred">${(r.predictedProb * 100).toFixed(0)}%</span>
      <span class="res-actual">${r.actualOutcome === 1 ? "YES" : "NO"}</span>
      <span class="res-pnl" style="color:${pnlColor}">${pnlStr}</span>
    </div>`;
  }).join("");

  el.innerHTML = header + rows;
}

function formatDay(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[d.getUTCDay()]} ${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}
