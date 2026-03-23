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
const HEIGHT_SCALE = 0.8;

// Heightmap resolution
const SEGMENTS_X = 256;
const SEGMENTS_Z = 160;

// Shared time uniform for terrain + ocean shaders
const timeUniform = { value: 0 };

/** Update terrain shader animation — call each frame */
export function updateTerrain(delta: number): void {
  timeUniform.value += delta;
}

/** Convert lat/lng to a 3D position on the terrain plane */
export function latLngToVec3(
  lat: number,
  lng: number,
  elevationOffset = 0.05
): THREE.Vector3 {
  const x = ((lng - MIN_LON) / (MAX_LON - MIN_LON) - 0.5) * PLANE_WIDTH;
  const z = -((lat - MIN_LAT) / (MAX_LAT - MIN_LAT) - 0.5) * PLANE_HEIGHT;
  const y = sampleHeight(lat, lng) + elevationOffset;
  return new THREE.Vector3(x, y, z);
}

// Height data sampled from the heightmap — populated when terrain loads
let heightData: Float32Array | null = null;
let heightWidth = 0;
let heightHeight = 0;

function sampleHeight(lat: number, lng: number): number {
  if (!heightData) return 0;
  const u = (lng - MIN_LON) / (MAX_LON - MIN_LON);
  const v = 1 - (lat - MIN_LAT) / (MAX_LAT - MIN_LAT);
  const px = Math.min(Math.floor(u * heightWidth), heightWidth - 1);
  const py = Math.min(Math.floor(v * heightHeight), heightHeight - 1);
  return (heightData[py * heightWidth + px] ?? 0) * HEIGHT_SCALE;
}

/** Generate a procedural US heightmap based on known mountain ranges */
function generateHeightmap(): { data: Float32Array; width: number; height: number } {
  const w = SEGMENTS_X + 1;
  const h = SEGMENTS_Z + 1;
  const data = new Float32Array(w * h);

  const features: { lat: number; lng: number; h: number; rx: number; ry: number }[] = [
    // Rocky Mountains
    { lat: 39, lng: -106, h: 1.0, rx: 3, ry: 8 },
    { lat: 44, lng: -110, h: 0.9, rx: 2.5, ry: 4 },
    { lat: 37, lng: -108, h: 0.85, rx: 3, ry: 5 },
    { lat: 46, lng: -114, h: 0.8, rx: 2, ry: 3 },
    // Sierra Nevada
    { lat: 37, lng: -119, h: 0.95, rx: 1.5, ry: 5 },
    { lat: 39, lng: -120, h: 0.85, rx: 1.5, ry: 3 },
    // Cascades
    { lat: 44, lng: -122, h: 0.75, rx: 1, ry: 4 },
    { lat: 47, lng: -121, h: 0.7, rx: 1, ry: 3 },
    // Appalachians
    { lat: 36, lng: -82, h: 0.4, rx: 2, ry: 6 },
    { lat: 40, lng: -78, h: 0.35, rx: 2, ry: 5 },
    { lat: 44, lng: -72, h: 0.3, rx: 1.5, ry: 3 },
    // Great Basin
    { lat: 40, lng: -116, h: 0.5, rx: 4, ry: 4 },
    // Ozarks
    { lat: 36.5, lng: -93, h: 0.2, rx: 2, ry: 2 },
    // Colorado Plateau
    { lat: 37, lng: -111, h: 0.6, rx: 3, ry: 3 },
    // Black Hills
    { lat: 44, lng: -103.5, h: 0.3, rx: 1, ry: 1 },
    // Great Plains gradual slope
    { lat: 40, lng: -100, h: 0.25, rx: 8, ry: 10 },
  ];

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = i / (w - 1);
      const v = j / (h - 1);
      const lng = MIN_LON + u * (MAX_LON - MIN_LON);
      const lat = MAX_LAT - v * (MAX_LAT - MIN_LAT);

      let elevation = 0;

      for (const f of features) {
        const dlat = (lat - f.lat) / f.ry;
        const dlng = (lng - f.lng) / f.rx;
        const d2 = dlat * dlat + dlng * dlng;
        elevation += f.h * Math.exp(-d2 * 2);
      }

      const isOcean = isWater(lat, lng);
      if (isOcean) elevation = -0.05;

      // Subtle noise for texture
      const noise = (Math.sin(lat * 47.3 + lng * 89.1) * 0.5 + 0.5) * 0.03
        + (Math.sin(lat * 123.7 + lng * 67.3) * 0.5 + 0.5) * 0.02;
      elevation += noise;

      data[j * w + i] = Math.max(0, elevation);
    }
  }

  return { data, width: w, height: h };
}

/** Simple ocean/water test for masking */
function isWater(lat: number, lng: number): boolean {
  if (lng < -124) return true;
  if (lng > -67 && lat < 44) return true;
  if (lat < 30 && lng > -98 && lng < -80) {
    const gulfEdge = 30 - (lng + 98) * 0.15;
    if (lat < gulfEdge) return true;
  }
  if (lat < 26 && lng > -98) return true;
  if (lat > 41 && lat < 49 && lng > -92 && lng < -76) {
    if (lat > 46 && lat < 49 && lng > -92 && lng < -84) return true;
    if (lat > 41.5 && lat < 46 && lng > -87.5 && lng < -85.5) return true;
    if (lat > 43 && lat < 46.5 && lng > -84.5 && lng < -79.5) return true;
    if (lat > 41.3 && lat < 42.8 && lng > -83.5 && lng < -79) return true;
    if (lat > 43.2 && lat < 44.2 && lng > -79.5 && lng < -76) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
// GLSL Shaders — holographic sci-fi terrain
// ═══════════════════════════════════════════════════════════

const terrainVertex = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vElevation;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    vElevation = position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const terrainFragment = /* glsl */ `
  uniform float uTime;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vElevation;

  void main() {
    float elevNorm = clamp(vElevation / 0.85, 0.0, 1.0);

    // ── WATER ──
    if (vElevation < 0.003) {
      vec3 wc = vec3(0.002, 0.008, 0.025);
      // Animated hex-ish water grid
      float wg1 = smoothstep(0.46, 0.5, abs(fract(vWorldPos.x * 1.2 + uTime * 0.035) - 0.5));
      float wg2 = smoothstep(0.46, 0.5, abs(fract(vWorldPos.z * 1.2 + uTime * 0.02) - 0.5));
      wc += vec3(0.0, 0.015, 0.035) * clamp(wg1 + wg2, 0.0, 1.0);
      // Subtle pulse
      wc += vec3(0.0, 0.003, 0.008) * (0.5 + 0.5 * sin(uTime * 0.8));
      gl_FragColor = vec4(wc, 1.0);
      return;
    }

    // ── BASE COLOR: deep navy → teal → bright cyan at peaks ──
    vec3 baseColor;
    if (elevNorm < 0.15) {
      baseColor = mix(vec3(0.005, 0.018, 0.05), vec3(0.0, 0.06, 0.12), elevNorm / 0.15);
    } else if (elevNorm < 0.5) {
      baseColor = mix(vec3(0.0, 0.06, 0.12), vec3(0.0, 0.22, 0.32), (elevNorm - 0.15) / 0.35);
    } else if (elevNorm < 0.8) {
      baseColor = mix(vec3(0.0, 0.22, 0.32), vec3(0.02, 0.45, 0.55), (elevNorm - 0.5) / 0.3);
    } else {
      baseColor = mix(vec3(0.02, 0.45, 0.55), vec3(0.15, 0.7, 0.8), (elevNorm - 0.8) / 0.2);
    }

    // ── GRID LINES (anti-aliased via fwidth) ──
    float gs = 0.25;
    vec2 ga = abs(fract(vWorldPos.xz / gs - 0.5) - 0.5);
    vec2 gw = fwidth(vWorldPos.xz / gs);
    float gridLine = 1.0 - min(
      smoothstep(gw.x * 0.5, gw.x * 1.5, ga.x),
      smoothstep(gw.y * 0.5, gw.y * 1.5, ga.y)
    );
    // Grid brighter on elevated terrain, subtler on flat ground
    float gridAlpha = 0.06 + elevNorm * 0.25;
    baseColor += vec3(0.0, 0.55, 0.75) * gridLine * gridAlpha;

    // ── CONTOUR LINES at elevation intervals ──
    float ci = 0.04;
    float cd = abs(fract(vElevation / ci + 0.5) - 0.5) * ci;
    float cw = fwidth(vElevation);
    float contourLine = 1.0 - smoothstep(cw * 0.2, cw * 1.2, cd);
    baseColor += vec3(0.0, 0.7, 0.5) * contourLine * 0.25 * elevNorm;

    // ── SLOPE / RIDGE GLOW — steep faces glow bright ──
    float slope = 1.0 - abs(dot(vNormal, vec3(0.0, 1.0, 0.0)));
    baseColor += vec3(0.0, 0.4, 0.55) * slope * slope * elevNorm * 0.9;

    // ── FRESNEL EDGE GLOW ──
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 3.0);
    baseColor += vec3(0.0, 0.4, 0.6) * fresnel * 0.35;

    // ── SCAN LINE — sweeps across the terrain ──
    float scanZ = mod(uTime * 0.8, 20.0) - 10.0;
    float sd = vWorldPos.z - scanZ;
    // Bright leading edge
    float scanLine = exp(-sd * sd * 6.0);
    // Fading trail behind
    float scanTrail = exp(-max(0.0, sd) * 1.8) * step(0.0, sd);
    baseColor += vec3(0.0, 1.0, 1.0) * scanLine * 0.5;
    baseColor += vec3(0.0, 0.3, 0.4) * scanTrail * 0.15;

    // ── DIRECTIONAL LIGHT for depth perception ──
    vec3 ld = normalize(vec3(0.4, 0.8, 0.3));
    float diff = max(dot(vNormal, ld), 0.0);
    baseColor *= (0.5 + 0.5 * diff);

    // ── SUBTLE PULSE on peaks ──
    float pulse = 0.5 + 0.5 * sin(uTime * 1.5 + vElevation * 20.0);
    baseColor += vec3(0.0, 0.15, 0.2) * pulse * pow(elevNorm, 3.0) * 0.3;

    gl_FragColor = vec4(baseColor, 1.0);
  }
`;

const oceanVertex = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const oceanFragment = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorldPos;

  void main() {
    vec3 color = vec3(0.001, 0.004, 0.012);

    // Subtle animated grid on the ocean floor
    float gs = 0.6;
    vec2 ga = abs(fract(vWorldPos.xz / gs - 0.5) - 0.5);
    vec2 gw = fwidth(vWorldPos.xz / gs);
    float gridLine = 1.0 - min(
      smoothstep(gw.x * 0.5, gw.x * 2.0, ga.x),
      smoothstep(gw.y * 0.5, gw.y * 2.0, ga.y)
    );
    color += vec3(0.0, 0.025, 0.05) * gridLine;

    // Distance fade
    float d = length(vWorldPos.xz) / 14.0;
    color *= max(0.0, 1.0 - d * 0.6);

    // Subtle pulse
    color += vec3(0.0, 0.002, 0.005) * (0.5 + 0.5 * sin(uTime * 0.5 + length(vWorldPos.xz) * 0.3));

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ═══════════════════════════════════════════════════════════
// Scene construction
// ═══════════════════════════════════════════════════════════

/** Create the 3D terrain, ocean, starfield — no scene lights needed (shaders self-lit) */
export function createTerrain(scene: THREE.Scene): { terrain: THREE.Mesh } {
  // Generate heightmap
  const hmap = generateHeightmap();
  heightData = hmap.data;
  heightWidth = hmap.width;
  heightHeight = hmap.height;

  // Terrain geometry
  const geo = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_HEIGHT, SEGMENTS_X, SEGMENTS_Z);
  geo.rotateX(-Math.PI / 2);

  // Displace vertices by heightmap
  const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i++) {
    const ix = i % (SEGMENTS_X + 1);
    const iz = Math.floor(i / (SEGMENTS_X + 1));
    const h = hmap.data[iz * hmap.width + ix] ?? 0;
    posAttr.setY(i, h * HEIGHT_SCALE);
  }
  geo.computeVertexNormals();

  // Holographic terrain material
  const terrainMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform },
    vertexShader: terrainVertex,
    fragmentShader: terrainFragment,
  });

  const terrain = new THREE.Mesh(geo, terrainMat);
  scene.add(terrain);

  // Wireframe overlay — very subtle structural lines
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    wireframe: true,
    transparent: true,
    opacity: 0.015,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const wireframe = new THREE.Mesh(geo.clone(), wireMat);
  scene.add(wireframe);

  // State borders
  addStateBorders(scene);

  // Ocean floor with animated grid shader
  const oceanGeo = new THREE.PlaneGeometry(PLANE_WIDTH * 2.5, PLANE_HEIGHT * 2.5);
  const oceanMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform },
    vertexShader: oceanVertex,
    fragmentShader: oceanFragment,
  });
  const ocean = new THREE.Mesh(oceanGeo, oceanMat);
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = -0.02;
  scene.add(ocean);

  // Starfield — sparse, slightly colored
  const starCount = 500;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 40 + Math.random() * 80;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = Math.abs(r * Math.cos(phi));
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    // Mostly white with slight cyan tinge
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

  // Fog for edge fadeout
  scene.fog = new THREE.FogExp2(0x000510, 0.025);

  return { terrain };
}

/** Draw approximate state boundaries as glowing lines */
function addStateBorders(scene: THREE.Scene): void {
  const borders: [number, number, number, number][] = [
    // US-Canada border
    [49, -125, 49, -95], [49, -95, 47, -95], [49, -95, 49, -67],
    // US-Mexico border
    [32, -117, 32, -108], [31.5, -108, 31.5, -106], [29.5, -103, 26, -97],
    // Mississippi River (rough)
    [47, -95, 45, -93], [45, -93, 43, -91], [43, -91, 40, -91],
    [40, -91, 37, -90], [37, -90, 35, -90], [35, -90, 33, -91], [33, -91, 30, -90],
    // East-West state lines
    [37, -109, 37, -102],
    [41, -109, 41, -102],
    [45, -111, 45, -104],
    [42, -124, 42, -117],
    [35, -114, 35, -107],
    [40, -80, 40, -75],
    [36.5, -90, 36.5, -82],
    [35, -106, 35, -94],
    // North-South state lines
    [37, -109, 42, -109],
    [37, -102, 41, -102],
    [42, -104, 45, -104],
    [30, -94, 36, -94],
  ];

  const lineMat = new THREE.LineBasicMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.07,
    linewidth: 1,
  });

  for (const [lat1, lng1, lat2, lng2] of borders) {
    const points: THREE.Vector3[] = [];
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lat = lat1 + (lat2 - lat1) * t;
      const lng = lng1 + (lng2 - lng1) * t;
      points.push(latLngToVec3(lat, lng, 0.015));
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    scene.add(new THREE.Line(lineGeo, lineMat));
  }
}
