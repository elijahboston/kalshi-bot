import * as THREE from "three";

// Must match map.ts constants
const PLANE_WIDTH = 12;
const PLANE_HEIGHT = 7;
const MIN_LAT = 24;
const MAX_LAT = 50;
const MIN_LON = -125;
const MAX_LON = -66;

const CANVAS_W = 512;
const CANVAS_H = 320;

export type WeatherStation = {
  id: string;
  lat: number;
  lon: number;
  temp?: number;     // Fahrenheit
  precip?: number;   // mm last hour
  condition?: string; // "clear" | "rain" | "snow" | "cloudy"
  hrrrActive?: boolean; // Whether HRRR data is active for this station
};

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let texture: THREE.CanvasTexture;
let mesh: THREE.Mesh;
let stations: WeatherStation[] = [];
let time = 0;

export function initWeatherLayer(scene: THREE.Scene): void {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx = canvas.getContext("2d")!;

  texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const geo = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_HEIGHT);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.7,
  });

  mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  scene.add(mesh);
}

/** Update weather data and redraw the overlay */
export function updateWeatherData(newStations: WeatherStation[]): void {
  stations = newStations;
  drawWeather();
}

/** Animate rain/snow effects — call each frame */
export function updateWeatherLayer(delta: number): void {
  time += delta;

  // Only redraw animation every few frames for performance
  if (Math.floor(time * 4) !== Math.floor((time - delta) * 4)) {
    drawWeather();
  }
}

function latLngToCanvas(lat: number, lng: number): { x: number; y: number } {
  const u = (lng - MIN_LON) / (MAX_LON - MIN_LON);
  const v = 1 - (lat - MIN_LAT) / (MAX_LAT - MIN_LAT);
  return { x: u * CANVAS_W, y: v * CANVAS_H };
}

function drawWeather(): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  if (stations.length === 0) return;

  // Temperature gradient field
  drawTemperatureField();

  // HRRR grid overlay — denser grid around stations with active HRRR data
  for (const s of stations) {
    if (!s.hrrrActive) continue;
    const { x, y } = latLngToCanvas(s.lat, s.lon);
    drawHrrrGrid(x, y);
  }

  // Precipitation indicators
  for (const s of stations) {
    if (!s.condition || s.condition === "clear") continue;
    const { x, y } = latLngToCanvas(s.lat, s.lon);
    if (s.condition === "rain") {
      drawRain(x, y);
    } else if (s.condition === "snow") {
      drawSnow(x, y);
    } else if (s.condition === "cloudy") {
      drawClouds(x, y);
    }
  }

  texture.needsUpdate = true;
}

function drawTemperatureField(): void {
  const stationsWithTemp = stations.filter((s) => s.temp !== undefined);
  if (stationsWithTemp.length === 0) return;

  const imageData = ctx.createImageData(CANVAS_W, CANVAS_H);
  const data = imageData.data;

  for (let py = 0; py < CANVAS_H; py++) {
    for (let px = 0; px < CANVAS_W; px++) {
      const lat = MAX_LAT - (py / CANVAS_H) * (MAX_LAT - MIN_LAT);
      const lng = MIN_LON + (px / CANVAS_W) * (MAX_LON - MIN_LON);

      // Inverse-distance weighted temperature
      let weightSum = 0;
      let tempSum = 0;
      for (const s of stationsWithTemp) {
        const dlat = lat - s.lat;
        const dlng = lng - s.lon;
        const d2 = dlat * dlat + dlng * dlng;
        const w = 1 / (d2 + 0.5);
        weightSum += w;
        tempSum += s.temp! * w;
      }

      const temp = tempSum / weightSum;

      // Map temperature to sci-fi color palette
      // Range: 20°F to 90°F
      const t = Math.max(0, Math.min(1, (temp - 20) / 70));

      let r: number, g: number, b: number;
      if (t < 0.35) {
        // Cold: indigo/purple → cyan
        const s = t / 0.35;
        r = Math.floor(25 * (1 - s));
        g = Math.floor(s * 60);
        b = Math.floor(60 + s * 40);
      } else if (t < 0.65) {
        // Mild: cyan → teal
        const s = (t - 0.35) / 0.3;
        r = 0;
        g = Math.floor(60 + s * 40);
        b = Math.floor(100 - s * 30);
      } else {
        // Hot: teal → magenta/pink
        const s = (t - 0.65) / 0.35;
        r = Math.floor(s * 100);
        g = Math.floor(100 * (1 - s * 0.7));
        b = Math.floor(70 + s * 30);
      }

      const idx = (py * CANVAS_W + px) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 20; // very subtle alpha
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/** Draw a subtle 3km-like grid around stations with active HRRR data */
function drawHrrrGrid(cx: number, cy: number): void {
  const gridSize = 40; // area around station
  const cellSize = 4;  // ~3km equivalent on canvas
  ctx.strokeStyle = "rgba(0, 136, 255, 0.06)";
  ctx.lineWidth = 0.5;

  // Horizontal lines
  for (let y = cy - gridSize; y <= cy + gridSize; y += cellSize) {
    ctx.beginPath();
    ctx.moveTo(cx - gridSize, y);
    ctx.lineTo(cx + gridSize, y);
    ctx.stroke();
  }
  // Vertical lines
  for (let x = cx - gridSize; x <= cx + gridSize; x += cellSize) {
    ctx.beginPath();
    ctx.moveTo(x, cy - gridSize);
    ctx.lineTo(x, cy + gridSize);
    ctx.stroke();
  }

  // Glow at center
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, gridSize);
  glow.addColorStop(0, "rgba(0, 136, 255, 0.05)");
  glow.addColorStop(1, "rgba(0, 136, 255, 0.0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, gridSize, 0, Math.PI * 2);
  ctx.fill();
}

function drawRain(cx: number, cy: number): void {
  ctx.lineWidth = 1.5;

  const radius = 35;
  for (let i = 0; i < 25; i++) {
    const x = cx + (Math.random() - 0.5) * radius * 2;
    const y = cy + (Math.random() - 0.5) * radius * 2;
    const offset = (time * 50 + i * 7) % 14;

    // Bright cyan rain drops
    ctx.strokeStyle = `rgba(0, 200, 255, ${0.3 + Math.random() * 0.2})`;
    ctx.beginPath();
    ctx.moveTo(x, y + offset);
    ctx.lineTo(x - 0.5, y + offset + 5);
    ctx.stroke();

    // Tiny splash glow at bottom
    if (offset > 12) {
      ctx.fillStyle = "rgba(0, 200, 255, 0.15)";
      ctx.beginPath();
      ctx.arc(x - 0.5, y + offset + 5, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawSnow(cx: number, cy: number): void {
  const radius = 35;
  for (let i = 0; i < 18; i++) {
    const angle = (time * 0.5 + i * 0.4) % (Math.PI * 2);
    const r = Math.random() * radius;
    const x = cx + Math.cos(angle + i) * r;
    const y = cy + Math.sin(angle + i * 0.7) * r;

    // White sparkles with cyan tinge
    const bright = 0.3 + 0.3 * Math.sin(time * 3 + i * 1.5);
    ctx.fillStyle = `rgba(180, 230, 255, ${bright})`;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();

    // Glow around snowflakes
    ctx.fillStyle = `rgba(100, 200, 255, ${bright * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawClouds(cx: number, cy: number): void {
  const radius = 30;
  // Dark indigo/purple haze
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, "rgba(60, 30, 100, 0.15)");
  gradient.addColorStop(0.5, "rgba(40, 20, 80, 0.08)");
  gradient.addColorStop(1, "rgba(30, 15, 60, 0.0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // Pulsing inner glow
  const pulse = 0.5 + 0.5 * Math.sin(time * 1.5);
  const innerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.5);
  innerGrad.addColorStop(0, `rgba(80, 50, 140, ${0.06 * pulse})`);
  innerGrad.addColorStop(1, "rgba(60, 30, 100, 0.0)");
  ctx.fillStyle = innerGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
  ctx.fill();
}
