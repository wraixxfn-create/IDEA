import * as THREE from 'three';
import { isPointInsideHex } from './hexGrid.js';
import { between, makeRandom } from './random.js';
import { applyWindSway } from './wind.js';

/**
 * The ground layer of the forest biome: grass and fern tufts, shrubs, mossy
 * rocks, fallen logs, mushroom clusters and the drifting mist. Everything is
 * seeded, planted on the terrain relief, kept inside HEX_S and merged into one
 * instanced mesh per type, so the extra richness costs a handful of draw calls.
 */

const GRASS_ROOT_COLORS = [0x27401f, 0x2f4a26, 0x37542b].map((c) => new THREE.Color(c));
const GRASS_TIP_COLORS = [0x6f9c3f, 0x82b04a, 0x9bbd52, 0xc0c25a].map((c) => new THREE.Color(c));
const SHRUB_DARK_COLORS = [0x1b3a20, 0x224027, 0x2a4a2e].map((c) => new THREE.Color(c));
const SHRUB_LIGHT_COLORS = [0x3d7d38, 0x4d8c3f, 0x5e9c4a].map((c) => new THREE.Color(c));
const ROCK_COLORS = [0x4a4a4a, 0x5c5750, 0x6b645c, 0x3f403d].map((c) => new THREE.Color(c));
const ROCK_MOSS_COLORS = [0x35502c, 0x44603a, 0x2f4a30].map((c) => new THREE.Color(c));
const BARK_DARK_COLORS = [0x2a1e17, 0x35271c, 0x412d20].map((c) => new THREE.Color(c));
const BARK_LIGHT_COLORS = [0x57402c, 0x6a4e34, 0x7b5b3d].map((c) => new THREE.Color(c));
const SAPWOOD_COLORS = [0xa8895f, 0xb99a6d, 0x8f7550].map((c) => new THREE.Color(c));
const MOSS_ON_WOOD = [0x3d5f34, 0x4b6f3a, 0x57784a].map((c) => new THREE.Color(c));
const STEM_COLORS = [0xdccfb2, 0xe6dcc2, 0xcfc0a0].map((c) => new THREE.Color(c));
const CAP_COLORS = [0x9c4a34, 0xb2603c, 0x7d4128].map((c) => new THREE.Color(c));

const MIST_VERTEX_SHADER = /* glsl */`
  varying vec3 vWorldPosition;
  varying vec2 vLocal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vLocal = position.xz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const MIST_FRAGMENT_SHADER = /* glsl */`
  varying vec3 vWorldPosition;
  varying vec2 vLocal;

  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uRadius;
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
    for (int octave = 0; octave < 4; octave += 1) {
      total += amplitude * valueNoise(p);
      p = rotation * p * 2.11;
      amplitude *= 0.5;
    }
    return total;
  }

  void main() {
    float radius = length(vLocal) / uRadius;
    float edge = 1.0 - smoothstep(0.25, 1.0, radius);
    float drift = fbm(vLocal * 0.018 + vec2(uTime * 0.021, uTime * 0.013));
    float wisps = fbm(vLocal * 0.052 - vec2(uTime * 0.035, uTime * 0.017));
    float nearFade = smoothstep(3.0, 26.0, distance(cameraPosition, vWorldPosition));
    float alpha = uOpacity * edge * nearFade * (0.30 + 0.85 * drift * (0.55 + 0.45 * wisps));
    vec3 color = uColor * (0.82 + 0.32 * drift);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

function createMistDiscGeometry(radius, segments = 96) {
  const positions = [];
  const indices = [];
  positions.push(0, 0, 0);
  for (let i = 0; i <= segments; i += 1) {
    const angle = i / segments * Math.PI * 2;
    positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  }
  for (let i = 1; i < segments; i += 1) {
    indices.push(0, i + 1, i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A slow layer of ground mist. Two discs drifting at different speeds read as
 * humidity hanging between the trunks after rain; the falloff is procedural,
 * so the layer never shows a hard rim or a texture seam.
 */
export function buildForestMist(sector, config = MAP_CONFIG) {
  const layers = Math.max(0, Math.floor(config.forestMistLayers ?? 2));
  const group = new THREE.Group();
  group.name = 'ForestMist_HEX_S';
  group.userData.sectorId = sector.id;
  group.userData.layerCount = layers;
  group.position.set(sector.center.x, config.floorHeight, sector.center.z);
  if (layers === 0) return { group, update: () => {} };

  const uniforms = { value: 0 };
  const radius = config.hexRadius * 0.92;
  const color = new THREE.Color(config.forestMistColor ?? 0xdcecf0);
  const meshes = [];

  for (let layer = 0; layer < layers; layer += 1) {
    const material = new THREE.ShaderMaterial({
      name: `ForestMistMaterial_${layer}`,
      uniforms: {
        uColor: { value: color },
        uOpacity: { value: (config.forestMistOpacity ?? 0.2) * (1 - layer * 0.28) },
        uRadius: { value: radius },
        uTime: uniforms,
      },
      vertexShader: MIST_VERTEX_SHADER,
      fragmentShader: MIST_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(createMistDiscGeometry(radius), material);
    mesh.name = `ForestMistLayer_${layer}`;
    mesh.position.y = (config.forestMistHeight ?? 5.5) + layer * (config.forestMistSpacing ?? 4.5);
    mesh.renderOrder = 30 + layer;
    mesh.userData.sectorId = sector.id;
    mesh.userData.driftSpeed = (config.forestMistDriftSpeed ?? 0.012) * (layer % 2 === 0 ? 1 : -0.72);
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  return {
    group,
    update(delta) {
      uniforms.value += delta;
      for (const mesh of meshes) mesh.rotation.y += mesh.userData.driftSpeed * delta;
    },
  };
}

const scratchColor = new THREE.Color();
const scratchVector = new THREE.Vector3();
const scratchSecond = new THREE.Vector3();

function pickColor(random, palette) {
  return palette[Math.min(palette.length - 1, Math.floor(random() * palette.length))];
}

function pushTriangle(builder, a, b, c, colorA, colorB, colorC) {
  const normal = scratchVector.subVectors(b, a).cross(scratchSecond.subVectors(c, a));
  if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
  normal.normalize();
  for (const [point, color] of [[a, colorA], [b, colorB], [c, colorC]]) {
    builder.positions.push(point.x, point.y, point.z);
    builder.normals.push(normal.x, normal.y, normal.z);
    builder.colors.push(color.r, color.g, color.b);
  }
}

function makeBuilder() {
  return { positions: [], normals: [], colors: [] };
}

function finishGeometry(builder, name) {
  const geometry = new THREE.BufferGeometry();
  geometry.name = name;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(builder.normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(builder.colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A tuft of curved, tapered blades. Each blade bends away from the centre, so
 * the silhouette reads as grass rather than as a flat star of triangles.
 */
function createGrassTuftGeometry(seed = 0x67a55) {
  const random = makeRandom(seed);
  const builder = makeBuilder();
  const bladeCount = 6;
  const levels = 3;

  for (let blade = 0; blade < bladeCount; blade += 1) {
    const angle = (blade / bladeCount) * Math.PI * 2 + between(random, -0.4, 0.4);
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const perpX = -dirZ;
    const perpZ = dirX;
    const height = between(random, 0.85, 1.95);
    const baseWidth = between(random, 0.07, 0.13);
    const lean = between(random, 0.32, 0.95);
    const root = pickColor(random, GRASS_ROOT_COLORS);
    const tip = pickColor(random, GRASS_TIP_COLORS);

    const centers = [];
    for (let level = 0; level <= levels; level += 1) {
      const t = level / levels;
      const bend = lean * t * t;
      centers.push(new THREE.Vector3(dirX * bend, height * t, dirZ * bend));
    }
    const widths = centers.map((_, index) => baseWidth * (1 - 0.88 * (index / levels)));

    for (let level = 0; level < levels; level += 1) {
      const a = centers[level];
      const b = centers[level + 1];
      const widthA = widths[level];
      const widthB = widths[level + 1];
      const leftA = a.clone().add(new THREE.Vector3(perpX * -widthA, 0, perpZ * -widthA));
      const rightA = a.clone().add(new THREE.Vector3(perpX * widthA, 0, perpZ * widthA));
      const leftB = b.clone().add(new THREE.Vector3(perpX * -widthB, 0, perpZ * -widthB));
      const rightB = b.clone().add(new THREE.Vector3(perpX * widthB, 0, perpZ * widthB));
      const colorA = scratchColor.copy(root).lerp(tip, level / levels).clone();
      const colorB = scratchColor.copy(root).lerp(tip, (level + 1) / levels).clone();
      pushTriangle(builder, leftA, rightA, rightB, colorA, colorA, colorB);
      pushTriangle(builder, leftA, rightB, leftB, colorA, colorB, colorB);
    }
  }

  return finishGeometry(builder, 'ForestGrassTuftGeometry');
}

/** A shrub: a squat cluster of overlapping blobs with a lit crown. */
function createShrubGeometry(seed = 0x5a7b1) {
  const random = makeRandom(seed);
  const builder = makeBuilder();
  const blobs = [];
  blobs.push({ x: 0, y: 0.42, z: 0, rx: 0.62, ry: 0.44, rz: 0.58 });
  for (let i = 1; i < 5; i += 1) {
    const angle = random() * Math.PI * 2;
    const spread = between(random, 0.22, 0.56);
    blobs.push({
      x: Math.cos(angle) * spread,
      y: between(random, 0.30, 0.62),
      z: Math.sin(angle) * spread,
      rx: between(random, 0.28, 0.46),
      ry: between(random, 0.22, 0.36),
      rz: between(random, 0.26, 0.44),
    });
  }

  let maxY = 0;
  for (const blob of blobs) maxY = Math.max(maxY, blob.y + blob.ry);

  for (const blob of blobs) {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const positions = geometry.attributes.position;
    const dark = pickColor(random, SHRUB_DARK_COLORS);
    const light = pickColor(random, SHRUB_LIGHT_COLORS);
    for (let i = 0; i < positions.count; i += 3) {
      const vertices = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const unitX = positions.getX(i + corner);
        const unitY = positions.getY(i + corner);
        const unitZ = positions.getZ(i + corner);
        const wobble = 1
          + 0.14 * Math.sin(unitX * 3.3 + blob.x * 7.1)
          + 0.10 * Math.cos(unitY * 2.9 - blob.z * 5.3);
        vertices.push(new THREE.Vector3(
          blob.x + unitX * blob.rx * wobble,
          blob.y + unitY * blob.ry * wobble,
          blob.z + unitZ * blob.rz * wobble,
        ));
      }
      const shade = (vertices[0].y + vertices[1].y + vertices[2].y) / (3 * Math.max(maxY, 0.001));
      const color = scratchColor.copy(dark).lerp(light, THREE.MathUtils.smoothstep(shade, 0.1, 0.95)).clone();
      pushTriangle(builder, vertices[0], vertices[1], vertices[2], color, color, color);
    }
    geometry.dispose();
  }

  const geometry = finishGeometry(builder, 'ForestShrubGeometry');
  geometry.translate(0, -geometry.boundingBox.min.y, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A mossy boulder: one angular blob, green where the rain collects. */
function createRockGeometry(seed = 0x10c4f) {
  const random = makeRandom(seed);
  const builder = makeBuilder();
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const positions = geometry.attributes.position;
  const stone = pickColor(random, ROCK_COLORS);
  const moss = pickColor(random, ROCK_MOSS_COLORS);

  for (let i = 0; i < positions.count; i += 3) {
    const vertices = [];
    let averageY = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const unitX = positions.getX(i + corner);
      const unitY = positions.getY(i + corner);
      const unitZ = positions.getZ(i + corner);
      const facet = 1
        - 0.22 * Math.abs(Math.sin(unitX * 2.1 + unitZ * 3.3))
        - 0.14 * Math.abs(Math.cos(unitY * 2.7 - unitX * 1.7));
      vertices.push(new THREE.Vector3(
        unitX * facet,
        unitY * facet * 0.62,
        unitZ * facet,
      ));
      averageY += unitY;
    }
    averageY /= 3;
    const mossAmount = THREE.MathUtils.smoothstep(averageY, 0.30, 0.85);
    const color = scratchColor.copy(stone).lerp(moss, mossAmount * 0.85).clone();
    pushTriangle(builder, vertices[0], vertices[1], vertices[2], color, color, color);
  }
  geometry.dispose();

  const result = finishGeometry(builder, 'ForestRockGeometry');
  result.translate(0, -result.boundingBox.min.y, 0);
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

/** A fallen log with sapwood ends and a mossy upper surface. */
function createLogGeometry(seed = 0x10953) {
  const random = makeRandom(seed);
  const builder = makeBuilder();
  const source = new THREE.CylinderGeometry(0.82, 0.94, 6, 7, 3, false).toNonIndexed();
  const positions = source.attributes.position;
  const dark = pickColor(random, BARK_DARK_COLORS);
  const light = pickColor(random, BARK_LIGHT_COLORS);
  const sapwood = pickColor(random, SAPWOOD_COLORS);
  const moss = pickColor(random, MOSS_ON_WOOD);

  for (let i = 0; i < positions.count; i += 3) {
    const vertices = [];
    for (let corner = 0; corner < 3; corner += 1) {
      vertices.push(new THREE.Vector3(
        positions.getX(i + corner),
        positions.getY(i + corner),
        positions.getZ(i + corner),
      ));
    }
    const averageX = (vertices[0].x + vertices[1].x + vertices[2].x) / 3;
    const averageY = (vertices[0].y + vertices[1].y + vertices[2].y) / 3;
    const averageZ = (vertices[0].z + vertices[1].z + vertices[2].z) / 3;
    const radial = Math.hypot(averageX, averageZ);
    const endCap = THREE.MathUtils.smoothstep(Math.abs(averageY), 2.55, 2.95);
    const upward = THREE.MathUtils.smoothstep(averageX / Math.max(radial, 0.001), -0.1, 0.7);
    const color = scratchColor.copy(dark).lerp(light, upward).clone();
    color.lerp(moss, upward * (1 - endCap) * 0.55);
    color.lerp(sapwood, endCap * 0.8);
    pushTriangle(builder, vertices[0], vertices[1], vertices[2], color, color, color);
  }
  source.dispose();

  const result = finishGeometry(builder, 'ForestLogGeometry');
  // Lay the trunk down and rest it on the forest floor.
  result.rotateZ(Math.PI / 2);
  result.translate(0, -result.boundingBox.min.y, 0);
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

/** A small mushroom: tapered stem plus a domed, slightly tilted cap. */
function createMushroomGeometry(seed = 0x5a551f) {
  const random = makeRandom(seed);
  const builder = makeBuilder();
  const stem = new THREE.CylinderGeometry(0.075, 0.1, 0.34, 6, 1, false).toNonIndexed();
  const cap = new THREE.SphereGeometry(0.22, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  cap.scale(1, 0.78, 1);
  const stemColor = pickColor(random, STEM_COLORS);
  const capColor = pickColor(random, CAP_COLORS);

  const append = (geometry, offset, color, shadeWithHeight = false) => {
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i += 3) {
      const vertices = [];
      for (let corner = 0; corner < 3; corner += 1) {
        vertices.push(new THREE.Vector3(
          positions.getX(i + corner) + offset.x,
          positions.getY(i + corner) + offset.y,
          positions.getZ(i + corner) + offset.z,
        ));
      }
      const shade = shadeWithHeight
        ? THREE.MathUtils.clamp((vertices[0].y + vertices[1].y + vertices[2].y) / 3 / 0.24, 0, 1)
        : 0.5;
      const color2 = scratchColor.copy(color).multiplyScalar(0.72 + shade * 0.42).clone();
      pushTriangle(builder, vertices[0], vertices[1], vertices[2], color2, color2, color2);
    }
    geometry.dispose();
  };

  append(stem, new THREE.Vector3(0, 0.17, 0), stemColor);
  append(cap, new THREE.Vector3(0, 0.33, 0), capColor, true);

  return finishGeometry(builder, 'ForestMushroomGeometry');
}

/**
 * A cheap, deterministic density field. Undergrowth grows in drifts and
 * clearings instead of an even sprinkle, which is what makes a scatter read as
 * a real woodland floor.
 */
function patchDensity(x, z) {
  const value = (
    Math.sin(x * 0.021 + 0.6) * Math.cos(z * 0.018 - 1.1)
    + 0.62 * Math.sin((x * 0.7 + z) * 0.033 + 2.2)
    + 0.36 * Math.cos((z * 0.8 - x * 0.4) * 0.057)
  ) / 1.98;
  return value * 0.5 + 0.5;
}

function scatter(random, count, { radius, padding = 6, avoid = [], minSpacing = 0, density = null }) {
  const placements = [];
  const limit = Math.max(0, radius - padding);
  let attempts = 0;
  const maxAttempts = count * (density ? 220 : 80) + 40;
  while (placements.length < count && attempts < maxAttempts) {
    attempts += 1;
    const x = between(random, -limit, limit);
    const z = between(random, -limit, limit);
    if (!isPointInsideHex(x, z, 0, 0, limit)) continue;
    if (density && random() > density(x, z)) continue;
    if (avoid.some((zone) => Math.hypot(zone.x - x, zone.z - z) < zone.radius)) continue;
    if (minSpacing > 0
      && placements.some((placed) => Math.hypot(placed.x - x, placed.z - z) < minSpacing)) continue;
    placements.push({ x, z });
  }
  return placements;
}

function clusterAround(random, origin, count, minRadius, maxRadius) {
  const placements = [];
  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const distance = between(random, minRadius, maxRadius);
    placements.push({
      x: origin.x + Math.cos(angle) * distance,
      z: origin.z + Math.sin(angle) * distance,
    });
  }
  return placements;
}

const LAYER_UP = new THREE.Vector3(0, 1, 0);
const IDENTITY_QUATERNION = new THREE.Quaternion();

function createInstancedLayer({
  name,
  geometry,
  material,
  placements,
  floorHeightAt,
  normalAt,
  alignToNormal = 0,
  sector,
  config,
  transformFor,
}) {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, placements.length));
  mesh.name = name;
  mesh.count = placements.length;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.sectorId = sector.id;

  const transform = new THREE.Object3D();
  const tint = new THREE.Color();
  const groundNormal = new THREE.Vector3();
  const alignment = new THREE.Quaternion();
  const canAlign = alignToNormal > 0 && typeof normalAt === 'function';
  placements.forEach((placement, index) => {
    const worldX = sector.center.x + placement.x;
    const worldZ = sector.center.z + placement.z;
    const floor = typeof floorHeightAt === 'function'
      ? floorHeightAt(worldX, worldZ)
      : config.floorHeight;
    const offset = Number.isFinite(floor) ? floor : 0;
    transformFor(transform, placement, offset);
    if (canAlign) {
      // Lay the instance on the slope it stands on: boulders and logs bed
      // into the bank instead of hovering with one end in the air.
      normalAt(worldX, worldZ, groundNormal);
      alignment.setFromUnitVectors(LAYER_UP, groundNormal);
      alignment.slerpQuaternions(IDENTITY_QUATERNION, alignment, alignToNormal);
      transform.quaternion.premultiply(alignment);
    }
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
    const brightness = 0.86 + ((index * 37) % 29) / 100;
    tint.setRGB(brightness, brightness, brightness);
    mesh.setColorAt(index, tint);
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * Build the whole HEX_S ground layer. `treePlacements` comes from the pine
 * grove so nothing grows straight through a trunk.
 */
export function buildForestFloorDetail({
  sector,
  config,
  floorHeightAt = null,
  normalAt = null,
  treePlacements = [],
  windUniforms = null,
}) {
  const group = new THREE.Group();
  group.name = 'ForestFloorDetail_HEX_S';
  group.userData.sectorId = sector.id;
  group.userData.biome = 'forest-undergrowth';
  group.userData.windDriven = Boolean(windUniforms);

  const random = makeRandom(0xf10a5 + sector.order * 131);
  const radius = config.hexRadius;
  const trunkZones = treePlacements.map((tree) => ({
    x: tree.x,
    z: tree.z,
    radius: 2.6 + (tree.scale ?? 1) * 1.9,
  }));
  // A clear lane is kept in front of every gate so arrivals can read the path.
  const gateZones = (config.forestKeepClear ?? []).map((zone) => ({
    x: zone.x,
    z: zone.z,
    radius: zone.radius ?? 12,
  }));
  const avoid = [...trunkZones, ...gateZones];

  const grassCount = Math.max(0, Math.floor(config.forestGrassCount ?? 820));
  const shrubCount = Math.max(0, Math.floor(config.forestShrubCount ?? 84));
  const rockCount = Math.max(0, Math.floor(config.forestRockCount ?? 62));
  const logCount = Math.max(0, Math.floor(config.forestLogCount ?? 16));
  const mushroomCount = Math.max(0, Math.floor(config.forestMushroomCount ?? 70));

  const grassMaterial = new THREE.MeshStandardMaterial({
    name: 'ForestGrassMaterial',
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const shrubMaterial = new THREE.MeshStandardMaterial({
    name: 'ForestShrubMaterial',
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });
  const rockMaterial = new THREE.MeshStandardMaterial({
    name: 'ForestRockMaterial',
    vertexColors: true,
    roughness: 0.98,
    metalness: 0,
    flatShading: true,
  });
  const woodMaterial = new THREE.MeshStandardMaterial({
    name: 'ForestDeadWoodMaterial',
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  });

  if (windUniforms) {
    applyWindSway(grassMaterial, windUniforms, {
      strength: 0.16,
      frequency: 2.15,
      heightScale: 1.6,
      bend: 1.35,
    });
    applyWindSway(shrubMaterial, windUniforms, {
      strength: 0.09,
      frequency: 1.55,
      heightScale: 1.1,
      bend: 1.6,
    });
  }

  const layers = [];

  if (grassCount > 0) {
    // Grass follows the density field, so the soil, the leaf litter and the
    // moss all stay visible between the tufts.
    const placements = scatter(random, grassCount, {
      radius,
      padding: 8,
      avoid,
      minSpacing: 1.3,
      density: (x, z) => THREE.MathUtils.smoothstep(patchDensity(x, z), 0.34, 0.86),
    });
    layers.push(createInstancedLayer({
      name: 'ForestGrassTufts_HEX_S',
      geometry: createGrassTuftGeometry(0x67a55 + sector.order),
      material: grassMaterial,
      placements,
      floorHeightAt,
      normalAt,
      alignToNormal: 0.45,
      sector,
      config,
      transformFor: (transform, placement, offset) => {
        const scale = between(random, 0.75, 1.85);
        transform.position.set(
          sector.center.x + placement.x,
          offset - 0.05,
          sector.center.z + placement.z,
        );
        transform.rotation.set(between(random, -0.09, 0.09), random() * Math.PI * 2, between(random, -0.09, 0.09));
        transform.scale.set(scale, scale * between(random, 0.85, 1.35), scale);
      },
    }));
    group.userData.grassCount = placements.length;
  }

  if (shrubCount > 0) {
    const shrubPlacements = scatter(random, Math.round(shrubCount * 0.72), {
      radius,
      padding: 14,
      avoid,
      minSpacing: 6,
      density: (x, z) => THREE.MathUtils.smoothstep(patchDensity(z, x), 0.28, 0.8),
    });
    // Shrubs also gather under the canopies, where the light is dimmest.
    for (const tree of treePlacements) {
      if (random() > 0.55) continue;
      for (const spot of clusterAround(random, tree, 2, 3.6, 6.4)) {
        if (isPointInsideHex(spot.x, spot.z, 0, 0, radius - 14)) shrubPlacements.push(spot);
      }
    }
    layers.push(createInstancedLayer({
      name: 'ForestShrubs_HEX_S',
      geometry: createShrubGeometry(0x5b7ab + sector.order),
      material: shrubMaterial,
      placements: shrubPlacements,
      floorHeightAt,
      normalAt,
      alignToNormal: 0.4,
      sector,
      config,
      transformFor: (transform, placement, offset) => {
        const scale = between(random, 1.5, 3.4);
        transform.position.set(
          sector.center.x + placement.x,
          offset - 0.12,
          sector.center.z + placement.z,
        );
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.set(scale, scale * between(random, 0.72, 1.05), scale);
      },
    }));
    group.userData.shrubCount = shrubPlacements.length;
  }

  if (rockCount > 0) {
    const rockPlacements = scatter(random, rockCount, {
      radius,
      padding: 12,
      avoid: gateZones,
      minSpacing: 5,
    });
    layers.push(createInstancedLayer({
      name: 'ForestRocks_HEX_S',
      geometry: createRockGeometry(0x10c41 + sector.order),
      material: rockMaterial,
      placements: rockPlacements,
      floorHeightAt,
      normalAt,
      alignToNormal: 0.85,
      sector,
      config,
      transformFor: (transform, placement, offset) => {
        const scale = between(random, 0.55, 2.1);
        transform.position.set(
          sector.center.x + placement.x,
          offset - scale * 0.14,
          sector.center.z + placement.z,
        );
        transform.rotation.set(between(random, -0.25, 0.25), random() * Math.PI * 2, between(random, -0.25, 0.25));
        transform.scale.set(scale * between(random, 0.85, 1.2), scale * between(random, 0.6, 0.95), scale);
      },
    }));
    group.userData.rockCount = rockPlacements.length;
  }

  if (logCount > 0) {
    const logPlacements = scatter(random, logCount, {
      radius,
      padding: 26,
      avoid: gateZones,
      minSpacing: 22,
    });
    layers.push(createInstancedLayer({
      name: 'ForestFallenLogs_HEX_S',
      geometry: createLogGeometry(0x10953 + sector.order),
      material: woodMaterial,
      placements: logPlacements,
      floorHeightAt,
      normalAt,
      alignToNormal: 0.9,
      sector,
      config,
      transformFor: (transform, placement, offset) => {
        const scale = between(random, 0.7, 1.35);
        transform.position.set(
          sector.center.x + placement.x,
          offset - 0.15,
          sector.center.z + placement.z,
        );
        transform.rotation.set(0, random() * Math.PI * 2, between(random, -0.05, 0.05));
        transform.scale.set(scale, scale, scale);
      },
    }));
    group.userData.logCount = logPlacements.length;
  }

  if (mushroomCount > 0) {
    const mushroomPlacements = [];
    while (mushroomPlacements.length < mushroomCount && treePlacements.length > 0) {
      const tree = treePlacements[Math.floor(random() * treePlacements.length)];
      for (const spot of clusterAround(random, tree, 3, 3.2, 7.5)) {
        if (isPointInsideHex(spot.x, spot.z, 0, 0, radius - 10)) mushroomPlacements.push(spot);
      }
    }
    for (const spot of scatter(random, Math.round(mushroomCount * 0.3), {
      radius,
      padding: 12,
      avoid,
      minSpacing: 3,
    })) mushroomPlacements.push(spot);

    layers.push(createInstancedLayer({
      name: 'ForestMushrooms_HEX_S',
      geometry: createMushroomGeometry(0x5a5b1 + sector.order),
      material: woodMaterial,
      placements: mushroomPlacements,
      floorHeightAt,
      normalAt,
      alignToNormal: 0.6,
      sector,
      config,
      transformFor: (transform, placement, offset) => {
        const scale = between(random, 0.75, 1.5);
        transform.position.set(
          sector.center.x + placement.x,
          offset - 0.04,
          sector.center.z + placement.z,
        );
        transform.rotation.set(between(random, -0.16, 0.16), random() * Math.PI * 2, between(random, -0.16, 0.16));
        transform.scale.set(scale, scale, scale);
      },
    }));
    group.userData.mushroomCount = mushroomPlacements.length;
  }

  for (const layer of layers) group.add(layer);
  group.userData.layerCount = layers.length;
  return group;
}
