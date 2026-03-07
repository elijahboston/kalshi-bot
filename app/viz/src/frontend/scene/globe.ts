import * as THREE from "three";

/** Create the Earth globe with atmosphere and starfield */
export function createGlobe(scene: THREE.Scene): {
  earth: THREE.Mesh;
  atmosphere: THREE.Mesh;
} {
  // Earth sphere — night map used as emissive so city lights glow
  const earthGeo = new THREE.SphereGeometry(1, 64, 64);
  const earthMat = new THREE.MeshStandardMaterial({
    color: 0x0a1a2a,
    emissive: 0xffffff,
    emissiveIntensity: 1.5,
    roughness: 0.9,
    metalness: 0.1,
  });

  // Try loading texture, fall back to procedural if not available
  const loader = new THREE.TextureLoader();
  loader.load(
    "/assets/earth-dark.jpg",
    (tex) => {
      earthMat.emissiveMap = tex;
      earthMat.needsUpdate = true;
    },
    undefined,
    () => {
      // Texture failed to load — use procedural wireframe overlay
      earthMat.emissive.setHex(0x0a1520);
      earthMat.emissiveIntensity = 1;
      const wireGeo = new THREE.SphereGeometry(1.001, 36, 18);
      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x0a3040,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
      });
      const wireframe = new THREE.Mesh(wireGeo, wireMat);
      scene.add(wireframe);
    }
  );

  const earth = new THREE.Mesh(earthGeo, earthMat);
  scene.add(earth);

  // Atmosphere — Fresnel glow
  const atmosGeo = new THREE.SphereGeometry(1.02, 64, 64);
  const atmosMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vec3 viewDir = normalize(-vPosition);
        float fresnel = 1.0 - dot(viewDir, vNormal);
        fresnel = pow(fresnel, 3.0);
        gl_FragColor = vec4(0.0, 1.0, 1.0, fresnel * 0.6);
      }
    `,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const atmosphere = new THREE.Mesh(atmosGeo, atmosMat);
  scene.add(atmosphere);

  // Starfield
  const starCount = 2000;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 20 + Math.random() * 80;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    starPositions[i * 3 + 2] = r * Math.cos(phi);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.15,
    sizeAttenuation: true,
  });
  scene.add(new THREE.Points(starGeo, starMat));

  // Lighting
  const ambient = new THREE.AmbientLight(0x334455, 0.8);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 1.0);
  directional.position.set(5, 3, 5);
  scene.add(directional);

  return { earth, atmosphere };
}

/** Convert lat/lng to 3D position on unit sphere */
export function latLngToVec3(
  lat: number,
  lng: number,
  radius = 1
): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}
