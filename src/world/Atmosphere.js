import * as THREE from 'three';

const SKY_VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  varying vec3 vWorldPosition;
  void main() {
    float h = normalize(vWorldPosition).y;
    float t = clamp(h * 0.55 + 0.42, 0.0, 1.0);
    gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
  }
`;

export function createAtmosphere(scene, renderer, config) {
  const fogColor = new THREE.Color(config.fogColor ?? 0x7e8a8d);
  scene.background = fogColor;
  scene.fog = new THREE.Fog(fogColor, config.fogNear ?? 420, config.fogFar ?? 2100);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(config.skyRadius ?? 2400, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(config.skyTopColor ?? 0xb7c4c6) },
        bottomColor: { value: fogColor.clone() },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
    }),
  );
  sky.name = 'WorldSky';
  sky.renderOrder = -1;
  scene.add(sky);

  const voidMesh = new THREE.Mesh(
    new THREE.CircleGeometry(config.voidRadius ?? 1800, 64),
    new THREE.MeshStandardMaterial({
      color: config.voidColor ?? 0x2c3335,
      roughness: 1,
      metalness: 0,
    }),
  );
  voidMesh.geometry.rotateX(-Math.PI / 2);
  voidMesh.name = 'WorldVoid';
  voidMesh.position.y = config.voidHeight ?? -48;
  voidMesh.receiveShadow = true;
  scene.add(voidMesh);

  const sun = new THREE.DirectionalLight(0xfff4e6, config.sunIntensity ?? 1.35);
  sun.name = 'WorldSun';
  sun.position.set(-320, 540, -220);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.35;
  const extent = config.shadowExtent ?? 780;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = 40;
  sun.shadow.camera.far = 1600;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xc9d6dc, 0.28);
  fill.name = 'WorldFill';
  fill.position.set(260, 180, 340);
  scene.add(fill);

  return { sky, voidMesh, sun, fill };
}
