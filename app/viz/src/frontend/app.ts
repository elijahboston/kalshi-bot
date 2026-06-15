import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createMap, updateMap } from "./scene/map";
import {
  createStations,
  findStationForTicker,
  setStationState,
  updateStations,
  updateStationWeather,
} from "./scene/stations";
import { setupCamera, updateCamera } from "./scene/camera";
import {
  initParticles,
  emitParticles,
  emitSettlement,
  updateParticles,
} from "./scene/particles";
import {
  createSettlementRing,
  createSignalRipple,
  updateEffects,
} from "./scene/effects";
import {
  initWeatherLayer,
  updateWeatherLayer,
  updateWeatherData,
  type WeatherStation,
} from "./scene/weather-layer";
import { connectWs, onMessage } from "./lib/ws-client";
import { initHud, handleHudMessage } from "./hud/overlay";
import { initPerformancePanel, loadPerformance } from "./hud/performance";
import { initStationDetail } from "./hud/station-detail";
import type { WsMessage, StationInfo } from "./lib/types";
import "./styles.css";

// Three.js setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  200
);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000510);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// Bloom post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.25,  // strength — very subtle
  0.3,   // radius
  0.4    // threshold — only brightest elements bloom
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Camera + scene setup (non-map elements)
const controls = setupCamera(camera, renderer);
initParticles(scene);
initWeatherLayer(scene);

// HUD
initHud();
initPerformancePanel();
initStationDetail(scene, camera, renderer.domElement);
loadPerformance();

// Load initial data and connect WebSocket
async function init() {
  // Create the flat map (async — fetches state boundary data)
  await createMap(scene);

  // Parallel: station markers + snapshot for immediate HUD population
  const [stationsRes, snapshotRes] = await Promise.allSettled([
    fetch("/api/stations"),
    fetch("/api/snapshot"),
  ]);

  if (stationsRes.status === "fulfilled" && stationsRes.value.ok) {
    try {
      const stations: StationInfo[] = await stationsRes.value.json();
      createStations(scene, stations);
    } catch (e) {
      console.warn("Failed to parse stations:", e);
    }
  } else {
    console.warn("Failed to load stations");
  }

  if (snapshotRes.status === "fulfilled" && snapshotRes.value.ok) {
    try {
      const snapshot = await snapshotRes.value.json();
      handleHudMessage({ type: "snapshot", data: snapshot });
      handleSceneMessage({ type: "snapshot", data: snapshot });
    } catch (e) {
      console.warn("Failed to parse snapshot:", e);
    }
  }

  // Load initial weather data (updates both weather overlay and station pillars)
  loadWeather();

  connectWs();

  // Periodic refreshes
  setInterval(() => loadPerformance(), 60_000);
  setInterval(() => loadWeather(), 300_000);

  onMessage((msg: WsMessage) => {
    handleHudMessage(msg);
    handleSceneMessage(msg);

    if (msg.type === "bot:status" || msg.type === "market:resolved") {
      loadPerformance();
    }
  });
}

async function loadWeather(): Promise<void> {
  try {
    const res = await fetch("/api/weather");
    if (res.ok) {
      const data: WeatherStation[] = await res.json();
      // Update weather canvas overlay
      updateWeatherData(data);
      // Update station pillar heights and colors
      for (const ws of data) {
        if (ws.temp !== undefined) {
          updateStationWeather(ws.id, ws.temp);
        }
      }
    }
  } catch {
    // Weather data is optional
  }
}

function handleSceneMessage(msg: WsMessage): void {
  switch (msg.type) {
    case "snapshot":
      createStations(scene, msg.data.stations);
      break;

    case "signal:new": {
      const station = findStationForTicker(msg.data.ticker);
      if (station) {
        setStationState(station.id, "signal");
        createSignalRipple(scene, station.position);
      }
      break;
    }

    case "order:placed": {
      const station = findStationForTicker(msg.data.ticker);
      if (station) {
        emitParticles(station.position, msg.data.action, 30);
      }
      break;
    }

    case "order:update": {
      const station = findStationForTicker(msg.data.ticker);
      if (station && msg.data.filledQuantity > 0) {
        setStationState(station.id, "active");
      }
      break;
    }

    case "market:resolved": {
      const station = findStationForTicker(msg.data.ticker);
      if (station) {
        const win =
          msg.data.realizedPnl !== undefined && msg.data.realizedPnl > 0;
        emitSettlement(station.position, win, 50);
        createSettlementRing(scene, station.position, win);
        setTimeout(() => setStationState(station.id, "idle"), 3000);
      }
      break;
    }

    case "position:update": {
      const station = findStationForTicker(msg.data.ticker);
      if (station) {
        setStationState(station.id, msg.data.quantity > 0 ? "active" : "idle");
      }
      break;
    }
  }
}

// Render loop
const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  updateCamera(camera, delta);
  updateMap(delta);
  updateStations(delta);
  updateParticles(delta);
  updateEffects(scene, delta);
  updateWeatherLayer(delta);

  composer.render();
}

// Handle resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

init();
animate();
