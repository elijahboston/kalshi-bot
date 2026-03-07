import * as THREE from "three";
import { latLngToVec3 } from "./globe";
import type { StationInfo } from "../lib/types";

export type StationMesh = {
  id: string;
  position: THREE.Vector3;
  /** Solid circle marker — always visible */
  marker: THREE.Sprite;
  /** Pulsing glow — shown on signal, fades out */
  glow: THREE.Sprite;
  label: THREE.Sprite;
  state: "idle" | "active" | "signal";
  /** Signal pulse timer — counts down from 1 to 0 */
  pulseT: number;
};

let stationMeshes: StationMesh[] = [];
let circleTexture: THREE.Texture | null = null;
let glowTexture: THREE.Texture | null = null;

/** Solid filled circle with a bright edge */
function getCircleTexture(): THREE.Texture {
  if (circleTexture) return circleTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;

  // Filled circle
  ctx.beginPath();
  ctx.arc(cx, cx, cx * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();

  // Bright ring edge
  ctx.beginPath();
  ctx.arc(cx, cx, cx * 0.7, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,1.0)";
  ctx.stroke();

  circleTexture = new THREE.CanvasTexture(canvas);
  return circleTexture;
}

/** Soft radial glow for signal pulse */
function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;

  const gradient = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gradient.addColorStop(0, "rgba(255,255,255,1.0)");
  gradient.addColorStop(0.2, "rgba(255,255,255,0.6)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.2)");
  gradient.addColorStop(1, "rgba(255,255,255,0.0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

// Colors
const COLOR_IDLE = 0x00cccc;
const COLOR_ACTIVE = 0x00ff88;
const COLOR_SIGNAL = 0xffcc00;

export function createStations(
  scene: THREE.Scene,
  stations: StationInfo[]
): StationMesh[] {
  for (const s of stationMeshes) {
    scene.remove(s.marker);
    scene.remove(s.glow);
    scene.remove(s.label);
  }
  stationMeshes = [];

  const circleTex = getCircleTexture();
  const glowTex = getGlowTexture();

  for (const station of stations) {
    const pos = latLngToVec3(station.lat, station.lon, 1.01);

    // Solid circle marker
    const markerMat = new THREE.SpriteMaterial({
      map: circleTex,
      color: station.activeMarkets > 0 ? COLOR_ACTIVE : COLOR_IDLE,
      transparent: true,
      depthTest: false,
    });
    const marker = new THREE.Sprite(markerMat);
    marker.position.copy(pos);
    marker.scale.set(0.04, 0.04, 1);
    scene.add(marker);

    // Glow sprite — hidden until signal
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: COLOR_SIGNAL,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.position.copy(pos);
    glow.scale.set(0.12, 0.12, 1);
    glow.visible = false;
    scene.add(glow);

    // Text label
    const labelSprite = createTextSprite(station.id);
    const labelPos = latLngToVec3(station.lat, station.lon, 1.05);
    labelSprite.position.copy(labelPos);
    labelSprite.scale.set(0.08, 0.04, 1);
    scene.add(labelSprite);

    stationMeshes.push({
      id: station.id,
      position: pos,
      marker,
      glow,
      label: labelSprite,
      state: station.activeMarkets > 0 ? "active" : "idle",
      pulseT: 0,
    });
  }

  return stationMeshes;
}

export function setStationState(
  stationId: string,
  state: StationMesh["state"]
): void {
  const s = stationMeshes.find((m) => m.id === stationId);
  if (!s) return;
  s.state = state;

  // Update marker color
  const markerColor = state === "active" ? COLOR_ACTIVE : COLOR_IDLE;
  (s.marker.material as THREE.SpriteMaterial).color.setHex(markerColor);

  if (state === "signal") {
    s.pulseT = 1; // start pulse countdown
    s.glow.visible = true;
  }
}

/** Call each frame to animate signal pulses */
export function updateStations(delta: number): void {
  for (const s of stationMeshes) {
    if (s.pulseT <= 0) continue;

    s.pulseT -= delta * 0.4; // ~2.5s full cycle
    if (s.pulseT <= 0) {
      s.pulseT = 0;
      s.glow.visible = false;
      (s.glow.material as THREE.SpriteMaterial).opacity = 0;
      if (s.state === "signal") s.state = "idle";
      continue;
    }

    // Pulsing: oscillate opacity and scale
    const pulse = Math.sin(s.pulseT * Math.PI * 4) * 0.5 + 0.5; // 2 full pulses
    const glowMat = s.glow.material as THREE.SpriteMaterial;
    glowMat.opacity = 0.4 + pulse * 0.6;

    const scale = 0.1 + pulse * 0.06;
    s.glow.scale.set(scale, scale, 1);

    // Also pulse the marker brightness
    const markerMat = s.marker.material as THREE.SpriteMaterial;
    markerMat.color.setHex(COLOR_SIGNAL);
    const markerScale = 0.04 + pulse * 0.015;
    s.marker.scale.set(markerScale, markerScale, 1);
  }

  // Reset marker color for non-pulsing stations
  for (const s of stationMeshes) {
    if (s.pulseT > 0) continue;
    const color = s.state === "active" ? COLOR_ACTIVE : COLOR_IDLE;
    (s.marker.material as THREE.SpriteMaterial).color.setHex(color);
    s.marker.scale.set(0.04, 0.04, 1);
  }
}

export function getStationMeshes(): StationMesh[] {
  return stationMeshes;
}

/**
 * Kalshi uses city suffixes (NY, CHI, LAX) not ICAO codes (KNYC, KORD, KLAX).
 * Tickers look like KXHIGHNY-25FEB19-B37 — extract the suffix after the
 * series prefix (KXHIGH, KXLOW, KXRAIN, KXSNOW) and map to ICAO.
 */
const SUFFIX_TO_ICAO: Record<string, string> = {
  NY: "KNYC",
  CHI: "KORD",
  LAX: "KLAX",
  DFW: "KDFW",
  IAH: "KIAH",
  DEN: "KDEN",
  PHL: "KPHL",
  ATL: "KATL",
  SFO: "KSFO",
  MIA: "KMIA",
  AUS: "KAUS",
};

/** Find which station a ticker belongs to */
export function findStationForTicker(ticker: string): StationMesh | undefined {
  const match = ticker.match(/^KX(?:HIGH|LOW|RAIN|SNOW)(.+?)(?:-|$)/);
  if (match?.[1]) {
    const icao = SUFFIX_TO_ICAO[match[1]];
    if (icao) return stationMeshes.find((s) => s.id === icao);
  }
  for (const s of stationMeshes) {
    if (ticker.includes(s.id)) return s;
  }
  return undefined;
}

function createTextSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 24px monospace";
  ctx.fillStyle = "#00ffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 32);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  return new THREE.Sprite(mat);
}
