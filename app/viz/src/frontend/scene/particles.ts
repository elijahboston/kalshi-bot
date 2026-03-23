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
    size: 0.06,
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
  // On flat terrain, normal is straight up
  const normal = new THREE.Vector3(0, 1, 0);
  const tangent1 = new THREE.Vector3(1, 0, 0);
  const tangent2 = new THREE.Vector3(0, 0, 1);

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

    // Velocity: upward along normal + random tangential spread
    const spread = 0.3;
    p.velocity
      .copy(normal)
      .multiplyScalar(0.4 + Math.random() * 0.4)
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
  const color = win
    ? new THREE.Color(0x4caf50)
    : new THREE.Color(0xf44336);

  const tangent1 = new THREE.Vector3(1, 0, 0);
  const tangent2 = new THREE.Vector3(0, 0, 1);

  let spawned = 0;
  for (const p of particles) {
    if (spawned >= count) break;
    if (p.alive) continue;

    p.alive = true;
    p.age = 0;
    p.position.copy(surfacePos);
    p.color.copy(color);

    // Ring pattern: mostly horizontal, slight upward
    const angle = (spawned / count) * Math.PI * 2;
    const ringDir = tangent1
      .clone()
      .multiplyScalar(Math.cos(angle))
      .add(tangent2.clone().multiplyScalar(Math.sin(angle)));

    const upward = win ? 0.2 : -0.05;
    p.velocity
      .copy(ringDir)
      .multiplyScalar(0.3 + Math.random() * 0.15)
      .addScaledVector(new THREE.Vector3(0, 1, 0), upward + Math.random() * 0.3);

    spawned++;
  }
}

export function updateParticles(delta: number): void {
  const gravity = new THREE.Vector3(0, -0.5 * delta, 0);
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

    // Apply gravity (pull downward)
    p.velocity.add(gravity);

    // Integrate
    p.position.addScaledVector(p.velocity, delta);

    // Don't let particles go below terrain
    if (p.position.y < 0) {
      p.position.y = 0;
      p.velocity.y = Math.abs(p.velocity.y) * 0.3; // slight bounce
    }

    // Fade by darkening color (additive blending makes dark = invisible)
    const t = p.age / PARTICLE_LIFETIME;
    const fade = 1 - t * t;
    colorAttr.setXYZ(i, p.color.r * fade, p.color.g * fade, p.color.b * fade);
    positionAttr.setXYZ(i, p.position.x, p.position.y, p.position.z);
  }

  positionAttr.needsUpdate = true;
  colorAttr.needsUpdate = true;
}
