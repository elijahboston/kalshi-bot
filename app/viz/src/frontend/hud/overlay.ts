import type {
  BalanceData,
  PositionRow,
  WsMessage,
  BotStatusData,
} from "../lib/types";
import { categoryFromTicker, categoryLabel } from "../lib/category";

let balance: BalanceData | null = null;
let positionCount = 0;
let botStatus: BotStatusData | null = null;
const feedItems: string[] = [];
const MAX_FEED = 10;

export function initHud(): void {
  const hud = document.createElement("div");
  hud.id = "hud";
  hud.innerHTML = `
    <div id="bot-status">
      <span class="status-dot"></span>
      <span class="title">CLIMATEBOT</span>
      <div class="detail">Connecting...</div>
    </div>
    <div id="stats">
      <h3>Portfolio</h3>
      <div class="stat-row"><span class="stat-label">Cash</span><span class="stat-value" id="stat-cash">--</span></div>
      <div class="stat-row"><span class="stat-label">Portfolio</span><span class="stat-value" id="stat-portfolio">--</span></div>
      <div class="stat-row"><span class="stat-label">Positions</span><span class="stat-value" id="stat-positions">--</span></div>
    </div>
    <div id="feed">
      <h3>Activity</h3>
      <div id="feed-list"></div>
    </div>
  `;
  document.body.appendChild(hud);

  // CRT scan lines overlay
  const scanlines = document.createElement("div");
  scanlines.className = "scanlines";
  document.body.appendChild(scanlines);

  // Vignette overlay
  const vignette = document.createElement("div");
  vignette.className = "vignette";
  document.body.appendChild(vignette);
}

export function handleHudMessage(msg: WsMessage): void {
  switch (msg.type) {
    case "snapshot":
      balance = msg.data.balance;
      positionCount = msg.data.positions.length;
      updateStats();
      break;

    case "balance:update":
      balance = msg.data;
      updateStats();
      break;

    case "position:update":
      // We track count from snapshot; individual updates just refresh display
      updateStats();
      break;

    case "bot:status":
      botStatus = msg.data;
      updateBotStatus();
      addFeedItem(
        `Tick #${msg.data.tickCount} complete${msg.data.dryRun ? " [DRY]" : ""}`,
        "tick"
      );
      break;

    case "signal:new": {
      const cat = categoryLabel(categoryFromTicker(msg.data.ticker));
      addFeedItem(
        `Signal: [${cat}] ${msg.data.ticker} ${msg.data.recommendation} (edge ${(msg.data.edge * 100).toFixed(1)}%)`,
        "signal"
      );
      break;
    }

    case "order:placed": {
      const cat = categoryLabel(categoryFromTicker(msg.data.ticker));
      addFeedItem(
        `Order: ${msg.data.action.toUpperCase()} [${cat}] ${msg.data.quantity}x ${msg.data.ticker} @ ${msg.data.price}c`,
        msg.data.action === "buy" ? "order-buy" : "order-sell"
      );
      break;
    }

    case "market:resolved": {
      const win =
        msg.data.realizedPnl !== undefined && msg.data.realizedPnl > 0;
      const pnlStr = msg.data.realizedPnl
        ? `${msg.data.realizedPnl > 0 ? "+" : ""}${(msg.data.realizedPnl / 100).toFixed(2)}`
        : "";
      addFeedItem(
        `Settled: ${msg.data.ticker} → ${msg.data.result} ${pnlStr}`,
        win ? "resolved-win" : "resolved-loss"
      );
      break;
    }

    case "log": {
      // Show info+ log messages from key modules in the activity feed
      if (msg.data.level === "info" || msg.data.level === "warn" || msg.data.level === "error") {
        const cssClass = msg.data.level === "error" ? "error" : msg.data.level === "warn" ? "warn" : "log-info";
        addFeedItem(`[${msg.data.module}] ${msg.data.message}`, cssClass);
      }
      break;
    }
  }
}

function updateStats(): void {
  const cashEl = document.getElementById("stat-cash");
  const portfolioEl = document.getElementById("stat-portfolio");
  const posEl = document.getElementById("stat-positions");

  if (cashEl && balance) {
    cashEl.textContent = `$${(balance.cash / 100).toFixed(2)}`;
  }
  if (portfolioEl && balance) {
    portfolioEl.textContent = `$${(balance.portfolio / 100).toFixed(2)}`;
    portfolioEl.className =
      "stat-value " + (balance.portfolio >= 0 ? "positive" : "negative");
  }
  if (posEl) {
    posEl.textContent = String(positionCount);
  }
}

function updateBotStatus(): void {
  const dot = document.querySelector("#bot-status .status-dot");
  const detail = document.querySelector("#bot-status .detail");
  if (dot && botStatus) {
    dot.className =
      "status-dot" + (botStatus.running ? "" : " stopped");
  }
  if (detail && botStatus) {
    const upMin = Math.floor(botStatus.uptime / 60000);
    detail.textContent = botStatus.running
      ? `Running | Tick #${botStatus.tickCount} | ${upMin}m uptime`
      : "Stopped";
  }
}

function addFeedItem(text: string, cssClass: string): void {
  feedItems.unshift(text);
  if (feedItems.length > MAX_FEED) feedItems.pop();

  const list = document.getElementById("feed-list");
  if (!list) return;

  const now = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  list.innerHTML = feedItems
    .map(
      (item, i) =>
        `<div class="feed-item ${i === 0 ? cssClass : ""}"><span class="time">${now}</span>${item}</div>`
    )
    .join("");
}
