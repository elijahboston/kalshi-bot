import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

let controls: OrbitControls | null = null;
let autoMove = true;
let interactionTimeout: ReturnType<typeof setTimeout> | null = null;
let time = 0;

export function setupCamera(
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer
): OrbitControls {
  // Angled top-down view looking at the center of the US
  camera.position.set(0, 7, 6);
  camera.lookAt(0, 0, -0.5);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 0, -0.5);

  // Zoom limits
  controls.minDistance = 3;
  controls.maxDistance = 14;

  // Angle limits — prevent going under the terrain or fully horizontal
  controls.minPolarAngle = 0.2;           // near top-down
  controls.maxPolarAngle = Math.PI / 2.3; // don't go edge-on

  // Allow panning across the map
  controls.enablePan = true;
  controls.panSpeed = 0.8;

  // Pause auto-movement on interaction
  const pauseAutoMove = () => {
    autoMove = false;
    if (interactionTimeout) clearTimeout(interactionTimeout);
    interactionTimeout = setTimeout(() => {
      autoMove = true;
    }, 8000);
  };

  renderer.domElement.addEventListener("pointerdown", pauseAutoMove);
  renderer.domElement.addEventListener("wheel", pauseAutoMove);

  return controls;
}

export function updateCamera(
  _camera: THREE.PerspectiveCamera,
  delta: number
): void {
  if (controls) {
    if (autoMove) {
      time += delta;
      // Gentle breathing — slow sinusoidal drift in Y and lateral position
      const baseY = 7;
      const breathY = Math.sin(time * 0.15) * 0.15;
      const breathX = Math.sin(time * 0.1) * 0.3;
      const breathZ = Math.cos(time * 0.08) * 0.2;

      controls.object.position.y = baseY + breathY;
      controls.object.position.x += (breathX - controls.object.position.x) * 0.005;
      controls.object.position.z += (6 + breathZ - controls.object.position.z) * 0.005;
    }
    controls.update();
  }
}
