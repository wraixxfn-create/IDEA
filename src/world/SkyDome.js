import * as THREE from 'three';
import { MAP_CONFIG, getSectorInfo } from '../config/mapConfig.js';
import {
  createHexDomeGeometry,
  createHexDomeRibGeometry,
  hexBoundaryDistanceAtAngle,
} from './hexGeometry.js';
import { between, makeRandom } from './random.js';

/**
 * Each sector is capped by an opaque cupola painted with a real sky instead of
 * a see-through shell: a vertical gradient, a sun disc with its halo and a
 * drifting cloud deck. The shading is computed from the view direction, so the
 * sky behaves as if it were at infinity while the cupola keeps its hexagonal
 * architectural silhouette from the outside.
 */

const SKY_VERTEX_SHADER = /* glsl */`
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */`
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  uniform vec3 uZenithColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uHazeColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uSunGlow;
  uniform vec3 uCloudLightColor;
  uniform vec3 uCloudShadowColor;
  uniform float uCloudThreshold;
  uniform float uCloudSoftness;
  uniform float uCloudScale;
  uniform float uCloudDrift;
  uniform float uCloudStrength;
  uniform float uTime;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 offset = fract(p);
    vec2 fade = offset * offset * (3.0 - 2.0 * offset);
    float a = hash21(cell);
    float b = hash21(cell + vec2(1.0, 0.0));
    float c = hash21(cell + vec2(0.0, 1.0));
    float d = hash21(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
  }

  float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);
    for (int octave = 0; octave < 5; octave += 1) {
      total += amplitude * valueNoise(p);
      p = rotation * p * 2.03;
      amplitude *= 0.5;
    }
    return total;
  }

  void main() {
    vec3 toCamera = normalize(cameraPosition - vWorldPosition);
    // Positive when the fragment is seen from outside the cupola: neighbouring
    // domes then read as distant architecture instead of a second sky.
    float exterior = step(0.0, dot(toCamera, vWorldNormal));
    vec3 direction = normalize(vWorldPosition - cameraPosition);

    float elevation = clamp(direction.y, -1.0, 1.0);
    float gradient = pow(clamp(elevation, 0.0, 1.0), 0.45);
    vec3 sky = mix(uHorizonColor, uZenithColor, gradient);

    float haze = exp(-max(elevation, 0.0) * 6.5);
    sky = mix(sky, uHazeColor, haze * 0.55 * (1.0 - exterior * 0.35));

    float sunCos = dot(direction, uSunDirection);
    float sunAmount = max(sunCos, 0.0);
    float visibleSun = 1.0 - exterior * 0.85;
    float disc = smoothstep(0.99958, 0.99986, sunCos);
    float glow = pow(sunAmount, 260.0) * 0.55
      + pow(sunAmount, 12.0) * 0.14
      + pow(sunAmount, 3.0) * 0.055;
    sky += uSunColor * (disc * 4.0 + glow * uSunGlow) * visibleSun;

    float cloudFade = smoothstep(0.015, 0.30, elevation);
    vec2 cloudCoordinates = direction.xz / max(elevation, 0.06) * uCloudScale
      + vec2(uTime * uCloudDrift, uTime * uCloudDrift * 0.42);
    float base = fbm(cloudCoordinates);
    float detail = fbm(cloudCoordinates * 2.6 + vec2(-uTime * uCloudDrift * 0.5, 0.0));
    float density = base * 0.72 + detail * 0.28;
    // The threshold is calibrated against the noise distribution in JS, so a
    // requested coverage really means "this fraction of the sky carries cloud"
    // instead of leaving a milky veil over the whole gradient.
    float cover = smoothstep(uCloudThreshold, uCloudThreshold + uCloudSoftness, density);
    cover *= 0.80 + 0.32 * smoothstep(0.30, 0.72, density);
    float cloud = clamp(cover, 0.0, 1.0) * cloudFade * uCloudStrength * (1.0 - exterior * 0.55);

    float sunSide = pow(sunAmount, 5.0);
    vec3 cloudColor = mix(
      uCloudShadowColor,
      uCloudLightColor,
      clamp(0.42 + sunSide * 0.70 + smoothstep(0.40, 0.85, density) * 0.30, 0.0, 1.0)
    );
    cloudColor += uSunColor * pow(sunAmount, 24.0) * 0.45;
    sky = mix(sky, cloudColor, clamp(cloud, 0.0, 1.0));

    // A whisper of dither keeps the wide gradient free of visible banding.
    sky += (hash21(gl_FragCoord.xy) - 0.5) * 0.0035;

    gl_FragColor = vec4(max(sky, 0.0), 1.0);
    #include <colorspace_fragment>
  }
`;

/** Shared, normalized direction pointing from the world towards the sun. */
export function resolveSunDirection(config = MAP_CONFIG) {
  const { x = -0.42, y = 0.56, z = -0.72 } = config.sunDirection ?? {};
  return new THREE.Vector3(x, y, z).normalize();
}

const WHITE = new THREE.Color(0xffffff);

// The sky's five-octave fbm lands on mean 0.49 with a standard deviation of
// 0.0958. Mapping a requested coverage onto that normal distribution keeps the
// cloud deck at the coverage the designers asked for.
const CLOUD_DENSITY_MEAN = 0.4896;
const CLOUD_DENSITY_STDDEV = 0.0958;

function normalQuantile(p) {
  const clamped = THREE.MathUtils.clamp(p, 1e-4, 1 - 1e-4);
  // Acklam's rational approximation of the inverse normal CDF.
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const lower = 0.02425;
  if (clamped < lower) {
    const q = Math.sqrt(-2 * Math.log(clamped));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (clamped <= 1 - lower) {
    const q = clamped - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - clamped));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Turn a requested cloud coverage into the matching noise threshold. */
export function cloudThresholdFor(coverage, softnessHint = 0.075) {
  const clamped = THREE.MathUtils.clamp(coverage, 0.02, 0.9);
  const z = normalQuantile(1 - clamped);
  return {
    threshold: CLOUD_DENSITY_MEAN + CLOUD_DENSITY_STDDEV * z,
    softness: softnessHint,
  };
}

/**
 * Build the sky palette of one sector: a realistic daytime gradient nudged
 * towards the sector's own accent so every cupola keeps its identity.
 */
export function createSkyPalette(sector, config = MAP_CONFIG) {
  const info = getSectorInfo(sector.id, sector.order);
  const isForest = sector.id === 'HEX_S';
  const strength = config.skyTintStrength ?? 0.28;
  const accent = new THREE.Color(info.accent ?? info.color);
  const pastel = accent.clone().lerp(WHITE, 0.45);
  const deep = accent.clone().lerp(WHITE, 0.10).multiplyScalar(0.72);

  const zenith = new THREE.Color(config.skyZenithColor ?? 0x2a6fc0).lerp(deep, strength);
  const horizon = new THREE.Color(config.skyHorizonColor ?? 0xa9cfe4).lerp(pastel, strength * 0.9);
  const haze = new THREE.Color(config.skyHazeColor ?? 0xe6eff3).lerp(pastel, strength * 0.75);
  const cloudLight = new THREE.Color(config.cloudLightColor ?? 0xfffaf1).lerp(pastel, 0.08);
  const cloudShadow = new THREE.Color(config.cloudShadowColor ?? 0xa9bfd0).lerp(deep, 0.16);

  const coverage = isForest
    ? (config.forestCloudCoverage ?? 0.42)
    : (config.cloudCoverage ?? 0.28);
  const { threshold, softness } = cloudThresholdFor(
    coverage,
    isForest ? (config.forestCloudSoftness ?? 0.068) : (config.cloudSoftness ?? 0.08),
  );

  return {
    info,
    isForest,
    cloudThreshold: threshold,
    cloudSoftness: softness,
    zenith,
    horizon,
    haze,
    cloudLight,
    cloudShadow,
    sunGlow: isForest
      ? (config.forestSunGlowStrength ?? config.sunGlowStrength ?? 1.05)
      : (config.sunGlowStrength ?? 0.95),
    cloudCoverage: isForest
      ? (config.forestCloudCoverage ?? 0.42)
      : (config.cloudCoverage ?? 0.28),
    cloudStrength: isForest
      ? (config.forestCloudStrength ?? 0.95)
      : (config.cloudStrength ?? 0.85),
    cloudSoftness: isForest
      ? (config.forestCloudSoftness ?? 0.068)
      : (config.cloudSoftness ?? 0.08),
    cloudCount: Math.max(0, Math.floor(isForest
      ? (config.forestCloudCount ?? 20)
      : (config.cloudCount ?? 10))),
  };
}

function lumpyBlobGeometry(detail, seed, squash) {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const positions = geometry.attributes.position;
  const wobble = (x, y, z) => 1
    + 0.17 * Math.sin(x * 3.1 + seed)
    + 0.11 * Math.cos(y * 2.7 - seed * 1.7)
    + 0.08 * Math.sin(z * 4.3 + seed * 2.3);
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const scale = wobble(x, y, z);
    positions.setXYZ(i, x * scale, y * scale * squash, z * scale);
  }
  return geometry;
}

/**
 * One cloud: a handful of overlapping, softly lumpy blobs merged into a single
 * geometry so a whole deck of them costs one instanced draw call. Vertices are
 * shaded from a cool base to a bright crown, which reads as self-shadowing
 * volume without any texture.
 */
export function createCloudPuffGeometry(seed, { detail = 2, blobs = 8 } = {}) {
  const random = makeRandom(seed);
  const positions = [];
  const normals = [];
  const colors = [];
  // The shaded underside stays bright enough to read as lit cloud rather than
  // as a grey hole in the sky: real cloud bases scatter a lot of light back.
  const bottom = new THREE.Color(0xa9bed1);
  const top = new THREE.Color(0xffffff);
  const scratch = new THREE.Color();
  let minY = Infinity;
  let maxY = -Infinity;

  const cluster = [];
  cluster.push({ x: 0, y: 0, z: 0, rx: 1, ry: 0.62, rz: 0.82, squash: 0.72 });
  for (let i = 1; i < blobs; i += 1) {
    const spread = 0.55 + random() * 0.75;
    const angle = random() * Math.PI * 2;
    cluster.push({
      x: Math.cos(angle) * spread * 1.35,
      y: between(random, -0.16, 0.22),
      z: Math.sin(angle) * spread * 0.62,
      rx: between(random, 0.46, 0.86),
      ry: between(random, 0.30, 0.50),
      rz: between(random, 0.44, 0.76),
      squash: between(random, 0.62, 0.82),
    });
  }

  for (const blob of cluster) {
    minY = Math.min(minY, blob.y - blob.ry);
    maxY = Math.max(maxY, blob.y + blob.ry);
  }

  cluster.forEach((blob, index) => {
    const geometry = lumpyBlobGeometry(detail, seed * 0.017 + index * 3.7, blob.squash);
    const attribute = geometry.attributes.position;
    for (let i = 0; i < attribute.count; i += 1) {
      const unitX = attribute.getX(i);
      const unitY = attribute.getY(i);
      const unitZ = attribute.getZ(i);
      const x = blob.x + unitX * blob.rx;
      const y = blob.y + unitY * blob.ry;
      const z = blob.z + unitZ * blob.rz;
      positions.push(x, y, z);
      // Exact ellipsoid normals keep the soft blobs from faceting.
      const nx = unitX / blob.rx;
      const ny = unitY / blob.ry;
      const nz = unitZ / blob.rz;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / length, ny / length, nz / length);
      const height = (y - minY) / Math.max(0.001, maxY - minY);
      const shade = THREE.MathUtils.smoothstep(height, 0.12, 0.92);
      scratch.copy(bottom).lerp(top, shade * (0.86 + random() * 0.28));
      colors.push(scratch.r, scratch.g, scratch.b);
    }
    geometry.dispose();
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  // Centre the cluster and stand it on its base, so an instance transform
  // positions the visible body of the cloud rather than an arbitrary corner.
  const box = geometry.boundingBox;
  geometry.translate(
    -(box.min.x + box.max.x) / 2,
    -box.min.y,
    -(box.min.z + box.max.z) / 2,
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.canonicalSize = geometry.boundingBox.max.clone().sub(geometry.boundingBox.min);
  return geometry;
}

/** One sector's cupola: painted sky shell, structural ribs and a cloud deck. */
export class SkyDome {
  constructor({ sector, config = MAP_CONFIG, sunDirection = resolveSunDirection(config) }) {
    this.sector = sector;
    this.config = config;
    this.palette = createSkyPalette(sector, config);
    this.elapsed = 0;

    const baseHeight = config.domeBaseHeight ?? config.wallHeight;
    const domeHeight = config.domeHeight ?? 150;
    const radialSegments = config.domeRadialSegments ?? 16;
    const verticalSegments = config.domeVerticalSegments ?? 12;
    const floorY = config.floorHeight;

    this.group = new THREE.Group();
    this.group.name = `SkyDome_${sector.id}`;
    this.group.userData.sectorId = sector.id;
    this.group.userData.roofType = 'painted-sky-cupola';
    this.group.userData.skyHeight = domeHeight;

    this.shellMaterial = new THREE.ShaderMaterial({
      name: `SkyMaterial_${sector.id}`,
      uniforms: {
        uZenithColor: { value: this.palette.zenith },
        uHorizonColor: { value: this.palette.horizon },
        uHazeColor: { value: this.palette.haze },
        uSunColor: { value: new THREE.Color(config.sunColor ?? 0xfff2d2) },
        uSunDirection: { value: sunDirection.clone() },
        uSunGlow: { value: this.palette.sunGlow },
        uCloudLightColor: { value: this.palette.cloudLight },
        uCloudShadowColor: { value: this.palette.cloudShadow },
        uCloudThreshold: { value: this.palette.cloudThreshold },
        uCloudSoftness: { value: this.palette.cloudSoftness },
        uCloudScale: { value: config.cloudScale ?? 1.25 },
        uCloudDrift: { value: config.cloudDriftSpeed ?? 0.012 },
        uCloudStrength: { value: this.palette.cloudStrength },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: false,
    });

    this.shell = new THREE.Mesh(
      createHexDomeGeometry(
        config.hexRadius,
        0,
        domeHeight,
        radialSegments,
        verticalSegments,
      ),
      this.shellMaterial,
    );
    this.shell.name = `Sky_${sector.id}`;
    this.shell.position.set(sector.center.x, floorY + baseHeight, sector.center.z);
    this.shell.renderOrder = 20;
    this.shell.userData.sectorId = sector.id;
    this.shell.userData.roofType = 'sky-cupola';
    this.shell.userData.collidable = false;
    this.group.add(this.shell);

    this.ribMaterial = new THREE.LineBasicMaterial({
      color: config.domeRibColor ?? 0xdff3ea,
      transparent: true,
      opacity: config.domeRibOpacity ?? 0.34,
      depthWrite: false,
      fog: false,
    });
    this.ribs = new THREE.LineSegments(
      createHexDomeRibGeometry(
        config.hexRadius * 0.995,
        0.14,
        domeHeight * 0.995,
        radialSegments,
        verticalSegments,
      ),
      this.ribMaterial,
    );
    this.ribs.name = `SkyRibs_${sector.id}`;
    this.ribs.position.copy(this.shell.position);
    this.ribs.renderOrder = 21;
    this.ribs.userData.sectorId = sector.id;
    this.group.add(this.ribs);

    this.buildClouds();
  }

  buildClouds() {
    const { sector, config, palette } = this;
    const count = palette.cloudCount;
    this.cloudGroup = new THREE.Group();
    this.cloudGroup.name = `CloudDeck_${sector.id}`;
    this.cloudGroup.userData.sectorId = sector.id;
    this.cloudGroup.userData.cloudCount = count;
    this.cloudGroup.position.set(sector.center.x, config.floorHeight, sector.center.z);
    this.group.add(this.cloudGroup);
    this.cloudMeshes = [];
    if (count === 0) return;

    const seedBase = 0xc10d0d + sector.order * 7919;
    const scatter = makeRandom(seedBase);
    const variants = [0, 1, 2].map((variant) => createCloudPuffGeometry(
      seedBase + variant * 131,
      { detail: 2, blobs: 8 },
    ));
    this.cloudMaterial = new THREE.MeshStandardMaterial({
      name: `CloudMaterial_${sector.id}`,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      // Clouds are translucent volumes: a measured self-lit term keeps their
      // shaded bases bright while the sun still shapes the crowns.
      emissive: new THREE.Color(0xeef4fb),
      emissiveIntensity: 0.32,
      fog: false,
    });

    const meshes = variants.map((geometry, variant) => {
      const mesh = new THREE.InstancedMesh(geometry, this.cloudMaterial, count);
      mesh.name = `CloudPuffs_${sector.id}_${variant}`;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.userData.sectorId = sector.id;
      mesh.frustumCulled = false;
      this.cloudGroup.add(mesh);
      this.cloudMeshes.push(mesh);
      return mesh;
    });

    const transform = new THREE.Object3D();
    const tint = new THREE.Color();
    const hexRadius = config.hexRadius;
    const baseHeight = config.domeBaseHeight ?? config.wallHeight;
    const domeHeight = config.domeHeight ?? 150;
    const minRadius = hexRadius * (config.cloudMinRadiusFactor ?? 0.28);
    const maxRadius = hexRadius * (config.cloudRadiusFactor ?? 0.74);
    const altitudeMin = config.cloudAltitudeMin ?? 58;
    const altitudeMax = config.cloudAltitudeMax ?? 104;
    // Horizontal room inside the cupola at a given height and bearing. Clouds
    // are clamped against it, so no puff can ever poke through the sky.
    const cupolaRadiusAt = (height, angle) => {
      const profile = Math.sqrt(Math.max(0.0001, 1 - ((height - baseHeight) / domeHeight) ** 2));
      return hexBoundaryDistanceAtAngle(hexRadius, angle) * profile;
    };

    for (let index = 0; index < count; index += 1) {
      const angle = scatter() * Math.PI * 2;
      const radius = between(scatter, minRadius, maxRadius);
      const width = between(scatter, 26, 56) * (palette.isForest ? 1.08 : 1);
      const height = width * between(scatter, 0.30, 0.44);
      const depth = width * between(scatter, 0.62, 0.86);
      const brightness = between(scatter, 0.88, 1.12);

      meshes.forEach((mesh, variant) => {
        // Every variant drifts on its own lane round the sector, so the deck
        // never reads as a rigid carousel of identical puffs.
        const size = mesh.geometry.userData.canonicalSize;
        const laneAngle = angle + variant * 2.1;
        const y = between(scatter, altitudeMin, altitudeMax) + variant * 4.5;
        const halfSpan = 0.46 * Math.hypot(width, depth);
        const clearance = Math.max(
          minRadius,
          Math.min(
            cupolaRadiusAt(y, laneAngle) - halfSpan - 6,
            cupolaRadiusAt(y + height, laneAngle) - 8,
          ),
        );
        const laneRadius = Math.min(radius * (1 + variant * 0.11), clearance);
        transform.position.set(
          Math.cos(laneAngle) * laneRadius,
          y,
          Math.sin(laneAngle) * laneRadius,
        );
        transform.rotation.set(
          between(scatter, -0.08, 0.08),
          scatter() * Math.PI * 2,
          between(scatter, -0.09, 0.09),
        );
        transform.scale.set(width / size.x, height / size.y, depth / size.z);
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
        tint.setRGB(brightness, brightness, brightness);
        mesh.setColorAt(index, tint);
      });
    }

    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  update(delta) {
    const dt = Math.max(0, delta);
    this.elapsed += dt;
    this.shellMaterial.uniforms.uTime.value = this.elapsed;
    if (this.cloudGroup) {
      // The deck turns imperceptibly slowly and breathes on the vertical,
      // which keeps the sky alive without ever looking like a moving object.
      const speed = this.config.cloudDeckDriftSpeed ?? 0.0075;
      this.cloudGroup.rotation.y += speed * dt * (this.palette.isForest ? 1.35 : 1);
      this.cloudGroup.position.y = this.config.floorHeight
        + Math.sin(this.elapsed * 0.09) * 1.6;
    }
  }
}

export function buildSkyDome(options) {
  return new SkyDome(options);
}
