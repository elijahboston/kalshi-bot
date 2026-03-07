import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

let controls: OrbitControls | null = null;
let autoRotate = true;
let interactionTimeout: ReturnType<typeof setTimeout> | null = null;

export function setupCamera(
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer
): OrbitControls {
  camera.position.set(0, 0.8, 2.5);
  camera.lookAt(0, 0, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 1.5;
  controls.maxDistance = 6;
  controls.enablePan = false;

  // Pause auto-rotate on interaction
  const pauseAutoRotate = () => {
    autoRotate = false;
    if (interactionTimeout) clearTimeout(interactionTimeout);
    interactionTimeout = setTimeout(() => {
      autoRotate = true;
    }, 5000);
  };

  renderer.domElement.addEventListener("pointerdown", pauseAutoRotate);
  renderer.domElement.addEventListener("wheel", pauseAutoRotate);

  return controls;
}

export function updateCamera(
  camera: THREE.PerspectiveCamera,
  _delta: number
): void {
  if (controls) {
    if (autoRotate) {
      // Slow auto-rotation
      const target = controls.object;
      const angle = 0.001;
      const x = target.position.x;
      const z = target.position.z;
      target.position.x = x * Math.cos(angle) + z * Math.sin(angle);
      target.position.z = -x * Math.sin(angle) + z * Math.cos(angle);
    }
    controls.update();
  }
}
