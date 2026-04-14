import * as THREE from "three";
import { categoryBadge, categoryFromTicker } from "../lib/category";

let panel: HTMLElement;
let selectedStationId: string | null = null;

export function initStationDetail(
  scene: THREE.Scene,
  camera: THREE.Camera,
  domElement: HTMLElement
): void {
  panel = document.createElement("div");
  panel.id = "station-detail";
  panel.className = "hidden";
  panel.innerHTML = `
    <div class="sd-header">
      <h3 id="sd-title">—</h3>
      <span class="sd-close">&times;</span>
    </div>
    <div class="sd-weather" id="sd-weather">—</div>
    <div class="sd-section">
      <h4>OBSERVATION</h4>
      <div id="sd-observation" class="sd-content">—</div>
    </div>
    <div class="sd-section">
      <h4>POSITIONS</h4>
      <div id="sd-positions" class="sd-content">No positions</div>
    </div>
    <div class="sd-section">
      <h4>RECENT ORDERS</h4>
      <div id="sd-orders" class="sd-content">No orders</div>
    </div>
  `;
  document.body.appendChild(panel);

  // Close button
  panel.querySelector(".sd-close")!.addEventListener("click", () => {
    hideStationDetail();
  });

  // Raycasting for station clicks
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  domElement.addEventListener("click", (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);

    for (const hit of intersects) {
      // Walk up the parent chain to find a station group
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        if (obj.userData?.stationId) {
          showStationDetail(obj.userData.stationId);
          return;
        }
        obj = obj.parent;
      }
    }

    // Clicked elsewhere — hide panel
    hideStationDetail();
  });

  // Escape to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideStationDetail();
  });
}

async function showStationDetail(stationId: string): Promise<void> {
  selectedStationId = stationId;
  panel.classList.remove("hidden");

  // Loading state
  document.getElementById("sd-title")!.textContent = `${stationId} — Loading...`;
  document.getElementById("sd-weather")!.textContent = "—";
  document.getElementById("sd-positions")!.textContent = "Loading...";
  document.getElementById("sd-orders")!.textContent = "Loading...";

  try {
    const res = await fetch(`/api/station/${stationId}`);
    if (!res.ok) throw new Error("Not found");
    const data = await res.json();

    // Bail if user clicked a different station while loading
    if (selectedStationId !== stationId) return;

    // Title
    document.getElementById("sd-title")!.textContent =
      `${data.id} — ${data.name}`;

    // Weather
    const tempStr =
      data.temp !== undefined ? `${Math.round(data.temp)}°F` : "—";
    const condStr =
      data.condition && data.condition !== "unknown" ? data.condition : "";
    document.getElementById("sd-weather")!.innerHTML = `
      <span class="sd-temp">${tempStr}</span>
      ${condStr ? `<span class="sd-condition">${condStr}</span>` : ""}
    `;

    // Observation vs Forecast
    const obsEl = document.getElementById("sd-observation")!;
    if (data.observation != null && data.forecastMean != null) {
      obsEl.innerHTML = `
        <span>Observed: <strong>${data.observation.toFixed(1)}°F</strong></span>
        <span class="muted"> | Forecast: ${data.forecastMean.toFixed(1)}°F</span>
      `;
    } else {
      obsEl.innerHTML = '<span class="muted">No observation data</span>';
    }

    // Positions
    const posEl = document.getElementById("sd-positions")!;
    if (data.positions.length === 0) {
      posEl.innerHTML = '<span class="muted">No open positions</span>';
    } else {
      posEl.innerHTML = data.positions
        .map((p: any) => {
          const pnlClass =
            (p.unrealizedPnl ?? 0) >= 0 ? "positive" : "negative";
          const pnlStr =
            p.unrealizedPnl != null
              ? `${p.unrealizedPnl >= 0 ? "+" : ""}${(p.unrealizedPnl / 100).toFixed(2)}`
              : "";
          // Hours to close
          let closeStr = "";
          if (p.closeTime || p.targetDate) {
            const closeMs = p.closeTime
              ? new Date(p.closeTime).getTime()
              : new Date(p.targetDate + "T23:59:00Z").getTime();
            const hoursLeft = (closeMs - Date.now()) / 3_600_000;
            if (hoursLeft > 0) {
              closeStr = hoursLeft < 24
                ? `<span class="muted">${hoursLeft.toFixed(1)}h</span>`
                : `<span class="muted">${(hoursLeft / 24).toFixed(1)}d</span>`;
            }
          }
          return `<div class="sd-row">
            ${categoryBadge(categoryFromTicker(p.ticker))}
            <span class="sd-ticker">${shortenTicker(p.ticker)}</span>
            <span>${p.quantity}x ${p.side.toUpperCase()}</span>
            ${closeStr}
            <span class="stat-value ${pnlClass}">${pnlStr}</span>
          </div>`;
        })
        .join("");
    }

    // Orders
    const ordEl = document.getElementById("sd-orders")!;
    if (data.recentOrders.length === 0) {
      ordEl.innerHTML = '<span class="muted">No recent orders</span>';
    } else {
      ordEl.innerHTML = data.recentOrders
        .map((o: any) => {
          const actionClass =
            o.action === "buy" ? "sd-buy" : "sd-sell";
          const time = new Date(o.createdAt).toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          });
          return `<div class="sd-row">
            <span class="${actionClass}">${o.action.toUpperCase()}</span>
            ${categoryBadge(categoryFromTicker(o.ticker))}
            <span class="sd-ticker">${shortenTicker(o.ticker)}</span>
            <span>${o.filledQuantity}x @ ${o.limitPrice}¢</span>
            <span class="muted">${time}</span>
          </div>`;
        })
        .join("");
    }
  } catch {
    if (selectedStationId === stationId) {
      document.getElementById("sd-title")!.textContent = stationId;
      document.getElementById("sd-positions")!.textContent = "Failed to load";
      document.getElementById("sd-orders")!.textContent = "Failed to load";
    }
  }
}

function hideStationDetail(): void {
  selectedStationId = null;
  panel.classList.add("hidden");
}

function shortenTicker(ticker: string): string {
  // KXHIGHNY-26MAR18-B72 → HIGHNY-B72
  return ticker.replace(/^KX/, "").replace(/-\d{2}[A-Z]{3}\d{2}-/, "-");
}
