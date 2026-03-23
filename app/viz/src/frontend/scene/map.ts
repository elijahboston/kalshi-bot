import * as THREE from "three";
import { getDotTexture } from "./dot-texture";

// CONUS bounding box
const MIN_LAT = 24;
const MAX_LAT = 50;
const MIN_LON = -125;
const MAX_LON = -66;

// Scene dimensions — wider than tall to match US aspect ratio
const PLANE_WIDTH = 12;
const PLANE_HEIGHT = 7;

// Canvas resolution for the map texture
const CANVAS_W = 2048;
const CANVAS_H = 1280;

const timeUniform = { value: 0 };

/** Update map shader animation — call each frame */
export function updateMap(delta: number): void {
  timeUniform.value += delta;
}

/** Convert lat/lng to a 3D position on the flat map plane */
export function latLngToVec3(
  lat: number,
  lng: number,
  elevationOffset = 0.05
): THREE.Vector3 {
  const x = ((lng - MIN_LON) / (MAX_LON - MIN_LON) - 0.5) * PLANE_WIDTH;
  const z = -((lat - MIN_LAT) / (MAX_LAT - MIN_LAT) - 0.5) * PLANE_HEIGHT;
  return new THREE.Vector3(x, elevationOffset, z);
}

// ═══════════════════════════════════════════════════════════
// Canvas projection
// ═══════════════════════════════════════════════════════════

function projectToCanvas(lng: number, lat: number): [number, number] {
  const x = ((lng - MIN_LON) / (MAX_LON - MIN_LON)) * CANVAS_W;
  const y = (1 - (lat - MIN_LAT) / (MAX_LAT - MIN_LAT)) * CANVAS_H;
  return [x, y];
}

// ═══════════════════════════════════════════════════════════
// GLSL Shaders
// ═══════════════════════════════════════════════════════════

const mapVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const mapFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    vec4 color = texture2D(uMap, vUv);

    // Scan line sweeping down
    float scanY = fract(uTime * 0.04);
    float sd = vUv.y - scanY;
    float scanLine = exp(-sd * sd * 15000.0);
    float scanTrail = exp(-max(0.0, sd) * 60.0) * step(0.0, sd);
    color.rgb += vec3(0.0, 0.7, 0.9) * scanLine * 0.1;
    color.rgb += vec3(0.0, 0.1, 0.18) * scanTrail * 0.05;

    // Subtle edge vignette
    float edge = max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0;
    float vignette = smoothstep(0.8, 1.0, edge);
    color.rgb *= (1.0 - vignette * 0.3);

    gl_FragColor = color;
  }
`;

const floorVertex = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const floorFragment = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorldPos;
  void main() {
    vec3 color = vec3(0.001, 0.003, 0.01);

    // Subtle grid on the floor
    float gs = 0.6;
    vec2 ga = abs(fract(vWorldPos.xz / gs - 0.5) - 0.5);
    vec2 gw = fwidth(vWorldPos.xz / gs);
    float gridLine = 1.0 - min(
      smoothstep(gw.x * 0.5, gw.x * 2.0, ga.x),
      smoothstep(gw.y * 0.5, gw.y * 2.0, ga.y)
    );
    color += vec3(0.0, 0.018, 0.035) * gridLine;

    // Fade with distance
    float d = length(vWorldPos.xz) / 14.0;
    color *= max(0.0, 1.0 - d * 0.6);

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ═══════════════════════════════════════════════════════════
// Scene construction
// ═══════════════════════════════════════════════════════════

type StatePolygonData = {
  polygons: number[][][];
};

/** Create the flat US map scene — fetches state boundaries async */
export async function createMap(scene: THREE.Scene): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d")!;

  // Draw placeholder while loading
  drawBackground(ctx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Map plane with scan line shader
  const mapGeo = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_HEIGHT);
  const mapMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uTime: timeUniform,
    },
    vertexShader: mapVertex,
    fragmentShader: mapFragment,
  });

  const mapPlane = new THREE.Mesh(mapGeo, mapMat);
  mapPlane.rotation.x = -Math.PI / 2;
  mapPlane.position.y = 0;
  scene.add(mapPlane);

  // Fetch actual state boundary data and redraw
  try {
    const res = await fetch("/api/us-map");
    const states: StatePolygonData[] = await res.json();
    drawBackground(ctx);
    drawStates(ctx, states);
    drawBorder(ctx);
    texture.needsUpdate = true;
  } catch (e) {
    console.warn("Failed to load US map data:", e);
  }

  // Dark floor extending beyond the map
  const floorGeo = new THREE.PlaneGeometry(30, 20);
  const floorMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform },
    vertexShader: floorVertex,
    fragmentShader: floorFragment,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  scene.add(floor);

  // Starfield
  addStarfield(scene);

  // Fog
  scene.fog = new THREE.FogExp2(0x000510, 0.025);
}

// ═══════════════════════════════════════════════════════════
// Canvas drawing
// ═══════════════════════════════════════════════════════════

function drawBackground(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#040810";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Lat/lng grid lines
  ctx.strokeStyle = "rgba(0, 160, 200, 0.05)";
  ctx.lineWidth = 1;

  // Longitude lines (every 5°)
  for (let lng = Math.ceil(MIN_LON / 5) * 5; lng <= MAX_LON; lng += 5) {
    const [x] = projectToCanvas(lng, 0);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_H);
    ctx.stroke();
  }

  // Latitude lines (every 5°)
  for (let lat = Math.ceil(MIN_LAT / 5) * 5; lat <= MAX_LAT; lat += 5) {
    const [, y] = projectToCanvas(0, lat);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_W, y);
    ctx.stroke();
  }
}

function drawStates(ctx: CanvasRenderingContext2D, states: StatePolygonData[]): void {
  // State fills — barely visible, distinguishes land from water
  ctx.fillStyle = "rgba(8, 16, 30, 0.85)";
  for (const state of states) {
    for (const ring of state.polygons) {
      if (ring.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = projectToCanvas(ring[i][0], ring[i][1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // State borders — thin glowing cyan
  ctx.strokeStyle = "rgba(0, 200, 240, 0.2)";
  ctx.lineWidth = 1.0;
  ctx.lineJoin = "round";
  for (const state of states) {
    for (const ring of state.polygons) {
      if (ring.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = projectToCanvas(ring[i][0], ring[i][1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  // Second pass: brighter outer edges (draw all borders again, slightly brighter)
  // The coastline and national borders naturally get brighter because
  // interior borders are shared between two states (drawn twice, additive look)
  ctx.strokeStyle = "rgba(0, 255, 255, 0.06)";
  ctx.lineWidth = 1.5;
  for (const state of states) {
    for (const ring of state.polygons) {
      if (ring.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = projectToCanvas(ring[i][0], ring[i][1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
}

function drawBorder(ctx: CanvasRenderingContext2D): void {
  // Thin border around the map plane
  ctx.strokeStyle = "rgba(0, 255, 255, 0.15)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);
}

function addStarfield(scene: THREE.Scene): void {
  const starCount = 400;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 40 + Math.random() * 80;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = Math.abs(r * Math.cos(phi));
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const cyan = 0.6 + Math.random() * 0.4;
    starColors[i * 3] = cyan * 0.7;
    starColors[i * 3 + 1] = cyan * 0.85;
    starColors[i * 3 + 2] = cyan;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starColors, 3));
  const starMat = new THREE.PointsMaterial({
    size: 0.1,
    map: getDotTexture(),
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
    vertexColors: true,
  });
  scene.add(new THREE.Points(starGeo, starMat));
}
