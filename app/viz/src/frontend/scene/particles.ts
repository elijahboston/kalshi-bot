import * as THREE from "three";
import { getDotTexture } from "./dot-texture";

const MAX_PARTICLES = 2000;
const PARTICLE_LIFETIME = 2.0; // seconds
const HIDE_POS = 9999; // off-screen position for dead particles

type Particle = {
  alive: boolean;
  age: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  color: THREE.Color;
};

let particles: Particle[] = [];
let geometry: THREE.BufferGeometry;
let points: THREE.Points;
let positionAttr: THREE.BufferAttribute;
let colorAttr: THREE.BufferAttribute;

export function initParticles(scene: THREE.Scene): void {
  particles = Array.from({ length: MAX_PARTICLES }, () => ({
    alive: false,
    age: 0,
    position: new THREE.Vector3(HIDE_POS, HIDE_POS, HIDE_POS),
    velocity: new THREE.Vector3(),
    color: new THREE.Color(),
  }));

  const positions = new Float32Array(MAX_PARTICLES * 3);
  const colors = new Float32Array(MAX_PARTICLES * 3);

  // Initialize all positions off-screen
  for (let i = 0; i < MAX_PARTICLES; i++) {
    positions[i * 3] = HIDE_POS;
    positions[i * 3 + 1] = HIDE_POS;
    positions[i * 3 + 2] = HIDE_POS;
  }

  geometry = new THREE.BufferGeometry();
  positionAttr = new THREE.BufferAttribute(positions, 3);
  colorAttr = new THREE.BufferAttribute(colors, 3);

  geometry.setAttribute("position", positionAttr);
  geometry.setAttribute("color", colorAttr);

  const mat = new THREE.PointsMaterial({
    size: 0.02,
    map: getDotTexture(),
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  points = new THREE.Points(geometry, mat);
  scene.add(points);
}

/** Emit particles at a surface position. action: "buy" | "sell" */
export function emitParticles(
  surfacePos: THREE.Vector3,
  action: "buy" | "sell",
  count = 30
): void {
  const normal = surfacePos.clone().normalize();
  const color =
    action === "buy" ? new THREE.Color(0x4caf50) : new THREE.Color(0xff9800);

  let spawned = 0;
  for (const p of particles) {
    if (spawned >= count) break;
    if (p.alive) continue;

    p.alive = true;
    p.age = 0;
    p.position.copy(surfacePos);
    p.color.copy(color);

    // Velocity: outward along normal + random tangential spread
    const tangent1 = new THREE.Vector3()
      .crossVectors(normal, new THREE.Vector3(0, 1, 0))
      .normalize();
    const tangent2 = new THREE.Vector3()
      .crossVectors(normal, tangent1)
      .normalize();

    const spread = 0.1;
    p.velocity
      .copy(normal)
      .multiplyScalar(0.15 + Math.random() * 0.15)
      .add(tangent1.clone().multiplyScalar((Math.random() - 0.5) * spread))
      .add(tangent2.clone().multiplyScalar((Math.random() - 0.5) * spread));

    spawned++;
  }
}

/** Emit a settlement effect: ring-like burst */
export function emitSettlement(
  surfacePos: THREE.Vector3,
  win: boolean,
  count = 50
): void {
  const normal = surfacePos.clone().normalize();
  const color = win
    ? new THREE.Color(0x4caf50)
    : new THREE.Color(0xf44336);

  const tangent1 = new THREE.Vector3()
    .crossVectors(normal, new THREE.Vector3(0, 1, 0))
    .normalize();
  const tangent2 = new THREE.Vector3()
    .crossVectors(normal, tangent1)
    .normalize();

  let spawned = 0;
  for (const p of particles) {
    if (spawned >= count) break;
    if (p.alive) continue;

    p.alive = true;
    p.age = 0;
    p.position.copy(surfacePos);
    p.color.copy(color);

    // Ring pattern: mostly tangential, slight outward
    const angle = (spawned / count) * Math.PI * 2;
    const ringDir = tangent1
      .clone()
      .multiplyScalar(Math.cos(angle))
      .add(tangent2.clone().multiplyScalar(Math.sin(angle)));

    const outward = win ? 0.08 : -0.03; // Win: fountain up, loss: inward
    p.velocity
      .copy(ringDir)
      .multiplyScalar(0.1 + Math.random() * 0.05)
      .add(normal.clone().multiplyScalar(outward + Math.random() * 0.1));

    spawned++;
  }
}

export function updateParticles(delta: number): void {
  const gravity = new THREE.Vector3();
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = particles[i]!;
    if (!p.alive) {
      // Park dead particles off-screen
      positionAttr.setXYZ(i, HIDE_POS, HIDE_POS, HIDE_POS);
      continue;
    }

    p.age += delta;
    if (p.age >= PARTICLE_LIFETIME) {
      p.alive = false;
      p.position.set(HIDE_POS, HIDE_POS, HIDE_POS);
      positionAttr.setXYZ(i, HIDE_POS, HIDE_POS, HIDE_POS);
      continue;
    }

    // Apply gravity (pull back toward center)
    gravity.copy(p.position).normalize().multiplyScalar(-0.02 * delta);
    p.velocity.add(gravity);

    // Integrate
    p.position.addScaledVector(p.velocity, delta);

    // Fade by darkening color (additive blending makes dark = invisible)
    const t = p.age / PARTICLE_LIFETIME;
    const fade = 1 - t * t;
    colorAttr.setXYZ(i, p.color.r * fade, p.color.g * fade, p.color.b * fade);
    positionAttr.setXYZ(i, p.position.x, p.position.y, p.position.z);
  }

  positionAttr.needsUpdate = true;
  colorAttr.needsUpdate = true;
}
