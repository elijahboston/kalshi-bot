import * as THREE from "three";
import { createGlobe } from "./scene/globe";
import { createStations, findStationForTicker, setStationState, updateStations } from "./scene/stations";
import { setupCamera, updateCamera } from "./scene/camera";
import { initParticles, emitParticles, emitSettlement, updateParticles } from "./scene/particles";
import { createSettlementRing, createSignalRipple, updateEffects } from "./scene/effects";
import { connectWs, onMessage } from "./lib/ws-client";
import { initHud, handleHudMessage } from "./hud/overlay";
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
document.body.appendChild(renderer.domElement);

// Scene
const { earth } = createGlobe(scene);
const controls = setupCamera(camera, renderer);
initParticles(scene);

// HUD
initHud();

// Load initial data and connect WebSocket
async function init() {
  try {
    const res = await fetch("/api/stations");
    const stations: StationInfo[] = await res.json();
    createStations(scene, stations);
  } catch (e) {
    console.warn("Failed to load stations:", e);
  }

  connectWs();

  onMessage((msg: WsMessage) => {
    handleHudMessage(msg);
    handleSceneMessage(msg);
  });
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
      // Mark station as active when an order fills
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
        // Reset to idle after settlement animation
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
  updateStations(delta);
  updateParticles(delta);
  updateEffects(scene, delta);

  renderer.render(scene, camera);
}

// Handle resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

init();
animate();
