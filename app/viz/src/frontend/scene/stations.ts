import * as THREE from "three";
import { latLngToVec3 } from "./map";
import type { StationInfo } from "../lib/types";

export type StationMesh = {
  id: string;
  position: THREE.Vector3;
  group: THREE.Group;
  basePlane: THREE.Mesh;
  outerRing: THREE.Mesh;
  hrrrRing: THREE.Mesh;
  column: THREE.Mesh;
  columnGlow: THREE.Mesh;
  tipSprite: THREE.Sprite;
  label: THREE.Sprite;
  labelCanvas: HTMLCanvasElement;
  labelTexture: THREE.CanvasTexture;
  state: "idle" | "active" | "signal";
  hrrrActive: boolean;
  observationActive: boolean;
  pulseT: number;
  temp: number | undefined;
  targetColumnH: number;
  currentColumnH: number;
};

let stationMeshes: StationMesh[] = [];

// ═══════════════════════════════════════════════════════════
// Temperature utilities
// ═══════════════════════════════════════════════════════════

const MIN_COL_H = 0.2;
const MAX_COL_H = 1.0;

function tempToColor(temp?: number): THREE.Color {
  if (temp === undefined) return new THREE.Color(0x00aacc);
  const t = Math.max(0, Math.min(1, (temp - 20) / 70));
  // Blue (cold) → cyan → green → orange (hot)
  const hue = 0.55 - t * 0.45;
  return new THREE.Color().setHSL(hue, 0.85, 0.4 + t * 0.1);
}

function tempToHeight(temp?: number): number {
  if (temp === undefined) return MIN_COL_H;
  const t = Math.max(0, Math.min(1, (temp - 20) / 70));
  return MIN_COL_H + t * (MAX_COL_H - MIN_COL_H);
}

// State colors
const COLOR_IDLE = new THREE.Color(0x00cccc);
const COLOR_ACTIVE = new THREE.Color(0x00ff88);
const COLOR_SIGNAL = new THREE.Color(0xffcc00);

function stateColor(state: string): THREE.Color {
  if (state === "active") return COLOR_ACTIVE;
  if (state === "signal") return COLOR_SIGNAL;
  return COLOR_IDLE;
}

// ═══════════════════════════════════════════════════════════
// Label rendering
// ═══════════════════════════════════════════════════════════

function createLabelCanvas(): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const texture = new THREE.CanvasTexture(canvas);
  return { canvas, texture };
}

function drawLabel(canvas: HTMLCanvasElement, id: string, temp?: number): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 128);

  // Station ID
  ctx.font = "bold 36px 'SF Mono', 'Fira Code', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#00ffff";
  ctx.shadowColor = "rgba(0, 255, 255, 0.5)";
  ctx.shadowBlur = 8;
  ctx.fillText(id, 128, 48);
  ctx.shadowBlur = 0;

  // Temperature
  if (temp !== undefined) {
    ctx.font = "26px 'SF Mono', 'Fira Code', monospace";
    ctx.fillStyle = "rgba(0, 200, 220, 0.8)";
    ctx.fillText(`${Math.round(temp)}°F`, 128, 88);
  }
}

// ═══════════════════════════════════════════════════════════
// Station creation
// ═══════════════════════════════════════════════════════════

export function createStations(
  scene: THREE.Scene,
  stations: StationInfo[]
): StationMesh[] {
  // Clean up existing
  for (const s of stationMeshes) {
    scene.remove(s.group);
  }
  stationMeshes = [];

  for (const station of stations) {
    const pos = latLngToVec3(station.lat, station.lon, 0);
    const group = new THREE.Group();
    group.position.copy(pos);
    group.userData = { stationId: station.id };

    const initColor = tempToColor(undefined);
    const ringColor = station.activeMarkets > 0 ? COLOR_ACTIVE : COLOR_IDLE;
    const columnH = MIN_COL_H;

    // ── Base disc (flat circle on the map surface) ──
    const baseGeo = new THREE.CircleGeometry(0.12, 32);
    const baseMat = new THREE.MeshBasicMaterial({
      color: initColor,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const basePlane = new THREE.Mesh(baseGeo, baseMat);
    basePlane.rotation.x = -Math.PI / 2;
    basePlane.position.y = 0.005;
    group.add(basePlane);

    // ── Outer activity ring ──
    const ringGeo = new THREE.RingGeometry(0.15, 0.175, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const outerRing = new THREE.Mesh(ringGeo, ringMat);
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.y = 0.006;
    group.add(outerRing);

    // ── HRRR inner ring (hidden by default, lights up blue when HRRR active) ──
    const hrrrRingGeo = new THREE.RingGeometry(0.10, 0.12, 32);
    const hrrrRingMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x0088ff),
      transparent: true,
      opacity: 0.0, // hidden initially
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const hrrrRing = new THREE.Mesh(hrrrRingGeo, hrrrRingMat);
    hrrrRing.rotation.x = -Math.PI / 2;
    hrrrRing.position.y = 0.007;
    group.add(hrrrRing);

    // ── Data column (thin beam) ──
    const colGeo = new THREE.CylinderGeometry(0.008, 0.008, 1.0, 6);
    const colMat = new THREE.MeshBasicMaterial({ color: initColor });
    const column = new THREE.Mesh(colGeo, colMat);
    column.scale.y = columnH;
    column.position.y = columnH / 2;
    group.add(column);

    // ── Column glow sleeve ──
    const glowGeo = new THREE.CylinderGeometry(0.025, 0.025, 1.0, 8);
    const glowMat = new THREE.MeshBasicMaterial({
      color: initColor,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const columnGlow = new THREE.Mesh(glowGeo, glowMat);
    columnGlow.scale.y = columnH;
    columnGlow.position.y = columnH / 2;
    group.add(columnGlow);

    // ── Tip dot ──
    const tipMat = new THREE.SpriteMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthTest: false,
    });
    const tipSprite = new THREE.Sprite(tipMat);
    tipSprite.scale.set(0.06, 0.06, 1);
    tipSprite.position.y = columnH;
    group.add(tipSprite);

    // ── Label ──
    const { canvas: labelCanvas, texture: labelTexture } = createLabelCanvas();
    drawLabel(labelCanvas, station.id);
    const labelMat = new THREE.SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthTest: false,
    });
    const label = new THREE.Sprite(labelMat);
    label.scale.set(0.6, 0.3, 1);
    label.position.y = columnH + 0.15;
    group.add(label);

    scene.add(group);

    stationMeshes.push({
      id: station.id,
      position: pos,
      group,
      basePlane,
      outerRing,
      hrrrRing,
      column,
      columnGlow,
      tipSprite,
      label,
      labelCanvas,
      labelTexture,
      state: station.activeMarkets > 0 ? "active" : "idle",
      hrrrActive: false,
      observationActive: false,
      pulseT: 0,
      temp: undefined,
      targetColumnH: columnH,
      currentColumnH: columnH,
    });
  }

  return stationMeshes;
}

// ═══════════════════════════════════════════════════════════
// Updates
// ═══════════════════════════════════════════════════════════

/** Update a station's temperature data — adjusts column height and color */
export function updateStationWeather(stationId: string, temp: number): void {
  const s = stationMeshes.find((m) => m.id === stationId);
  if (!s) return;
  s.temp = temp;
  s.targetColumnH = tempToHeight(temp);

  const color = tempToColor(temp);
  (s.basePlane.material as THREE.MeshBasicMaterial).color.copy(color);
  (s.column.material as THREE.MeshBasicMaterial).color.copy(color);
  (s.columnGlow.material as THREE.MeshBasicMaterial).color.copy(color);

  drawLabel(s.labelCanvas, s.id, temp);
  s.labelTexture.needsUpdate = true;
}

export function setStationState(
  stationId: string,
  state: StationMesh["state"]
): void {
  const s = stationMeshes.find((m) => m.id === stationId);
  if (!s) return;
  s.state = state;

  (s.outerRing.material as THREE.MeshBasicMaterial).color.copy(stateColor(state));

  if (state === "signal") {
    s.pulseT = 1;
  }
}

/** Set whether HRRR data is active for a station */
export function setStationHrrr(stationId: string, active: boolean): void {
  const s = stationMeshes.find((m) => m.id === stationId);
  if (!s) return;
  s.hrrrActive = active;
}

/** Set whether observation data is active for a station */
export function setStationObservation(stationId: string, active: boolean): void {
  const s = stationMeshes.find((m) => m.id === stationId);
  if (!s) return;
  s.observationActive = active;
}

/** Call each frame — animates columns, pulses, breathing */
export function updateStations(delta: number): void {
  const now = performance.now() / 1000;

  for (const s of stationMeshes) {
    // Smooth column height interpolation
    if (Math.abs(s.currentColumnH - s.targetColumnH) > 0.001) {
      s.currentColumnH += (s.targetColumnH - s.currentColumnH) * delta * 3;
      s.column.scale.y = s.currentColumnH;
      s.column.position.y = s.currentColumnH / 2;
      s.columnGlow.scale.y = s.currentColumnH;
      s.columnGlow.position.y = s.currentColumnH / 2;
      s.tipSprite.position.y = s.currentColumnH;
      s.label.position.y = s.currentColumnH + 0.15;
    }

    // Signal pulse animation
    if (s.pulseT > 0) {
      s.pulseT -= delta * 0.4;
      if (s.pulseT <= 0) {
        s.pulseT = 0;
        const restoreState = s.state === "signal" ? "idle" : s.state;
        if (s.state === "signal") s.state = "idle";
        (s.outerRing.material as THREE.MeshBasicMaterial).color.copy(
          stateColor(restoreState)
        );
        (s.outerRing.material as THREE.MeshBasicMaterial).opacity = 0.35;
        s.outerRing.scale.set(1, 1, 1);
        (s.tipSprite.material as THREE.SpriteMaterial).opacity = 0.9;
        s.tipSprite.scale.setScalar(0.06);
        continue;
      }

      const pulse = Math.sin(s.pulseT * Math.PI * 4) * 0.5 + 0.5;
      const ringMat = s.outerRing.material as THREE.MeshBasicMaterial;
      ringMat.color.copy(COLOR_SIGNAL);
      ringMat.opacity = 0.3 + pulse * 0.5;

      const scale = 1.0 + pulse * 0.3;
      s.outerRing.scale.set(scale, scale, 1);

      (s.tipSprite.material as THREE.SpriteMaterial).opacity = 0.7 + pulse * 0.3;
      s.tipSprite.scale.setScalar(0.06 + pulse * 0.03);
    } else {
      // Subtle idle breathing on outer ring
      const breath = Math.sin(now * 1.5 + s.position.x * 10) * 0.08;
      (s.outerRing.material as THREE.MeshBasicMaterial).opacity = 0.3 + breath;
    }

    // HRRR ring animation
    const hrrrMat = s.hrrrRing.material as THREE.MeshBasicMaterial;
    if (s.hrrrActive) {
      // Slow pulse when HRRR active
      const hrrrPulse = Math.sin(now * 2.0 + s.position.x * 5) * 0.15 + 0.35;
      hrrrMat.opacity = hrrrPulse;
      // Brighter cyan when both HRRR + observation are active
      if (s.observationActive) {
        hrrrMat.color.setHex(0x00ddff); // bright cyan
      } else {
        hrrrMat.color.setHex(0x0088ff); // blue
      }
    } else {
      hrrrMat.opacity = 0; // hidden
    }
  }
}

export function getStationMeshes(): StationMesh[] {
  return stationMeshes;
}

// ═══════════════════════════════════════════════════════════
// Ticker matching
// ═══════════════════════════════════════════════════════════

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
export function findStationForTicker(
  ticker: string
): StationMesh | undefined {
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
