import * as THREE from "three";

let dotTexture: THREE.Texture | null = null;

/** Shared circular dot texture for Points materials */
export function getDotTexture(): THREE.Texture {
  if (dotTexture) return dotTexture;

  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;

  const gradient = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gradient.addColorStop(0, "rgba(255,255,255,1.0)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.2)");
  gradient.addColorStop(1, "rgba(255,255,255,0.0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  dotTexture = new THREE.CanvasTexture(canvas);
  return dotTexture;
}
