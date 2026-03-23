import * as THREE from "three";

type RingEffect = {
  mesh: THREE.Mesh;
  age: number;
  maxAge: number;
  startScale: number;
  endScale: number;
};

const activeRings: RingEffect[] = [];

function addRing(
  scene: THREE.Scene,
  position: THREE.Vector3,
  color: number,
  opacity: number,
  innerR: number,
  outerR: number,
  maxAge: number,
  endScale: number
): void {
  const ringGeo = new THREE.RingGeometry(innerR, outerR, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(position);
  ring.position.y += 0.02;
  // Lay flat on XZ plane
  ring.rotation.x = -Math.PI / 2;

  scene.add(ring);
  activeRings.push({ mesh: ring, age: 0, maxAge, startScale: 1, endScale });
}

/** Create an expanding ring at a settlement location */
export function createSettlementRing(
  scene: THREE.Scene,
  position: THREE.Vector3,
  win: boolean
): void {
  addRing(scene, position, win ? 0x4caf50 : 0xf44336, 0.8, 0.08, 0.14, 1.5, 4);
}

/** Create a ripple (3 staggered rings) at a signal location */
export function createSignalRipple(
  scene: THREE.Scene,
  position: THREE.Vector3
): void {
  const color = 0x00ffcc;
  for (let i = 0; i < 3; i++) {
    const ringGeo = new THREE.RingGeometry(0.03, 0.06, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(position);
    ring.position.y += 0.02;
    ring.rotation.x = -Math.PI / 2;

    scene.add(ring);
    activeRings.push({
      mesh: ring,
      age: -i * 0.3, // negative age = delayed start
      maxAge: 1.8,
      startScale: 0.5,
      endScale: 6,
    });
  }
}

export function updateEffects(scene: THREE.Scene, delta: number): void {
  for (let i = activeRings.length - 1; i >= 0; i--) {
    const ring = activeRings[i]!;
    ring.age += delta;

    // Still waiting for staggered start
    if (ring.age < 0) {
      ring.mesh.visible = false;
      continue;
    }

    ring.mesh.visible = true;

    if (ring.age >= ring.maxAge) {
      scene.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      (ring.mesh.material as THREE.Material).dispose();
      activeRings.splice(i, 1);
      continue;
    }

    const t = ring.age / ring.maxAge;
    const scale = ring.startScale + (ring.endScale - ring.startScale) * t;
    ring.mesh.scale.set(scale, scale, scale);

    // Fade in quickly then fade out
    const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * Math.max(0, alpha);
  }
}
