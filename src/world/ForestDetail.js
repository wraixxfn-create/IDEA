import * as THREE from 'three';
import { isPointInsideHex } from './hexGrid.js';
import { between, makeRandom } from './random.js';
import { applyWindSway } from './wind.js';

/**
 * The ground layer of the forest biome: grass and fern tufts, shrubs, mossy
 * rocks, fallen logs and broken branches, mushroom clusters and the stacked
 * mist. Everything is seeded, planted on the terrain relief, kept inside HEX_S
 * and merged into one instanced mesh per type, so a floor of ten thousand
 * pieces still costs a handful of draw calls.
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
  // Every layer of the stack samples the same noise field through a different
  // offset, so eight layers of fog read as one deep volume instead of eight
  // copies of the same sheet of glass.
  uniform vec2 uPhase;

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
    vec2 phased = vLocal + uPhase;
    float drift = fbm(phased * 0.018 + vec2(uTime * 0.021, uTime * 0.013));
    float wisps = fbm(phased * 0.052 - vec2(uTime * 0.035, uTime * 0.017));
    // Eight thin layers stack up fast, so each one has to keep well clear of
    // the lens: the floor under the explorer's feet stays crisp and the fog
    // rolls in from about fifteen metres out; close layers would only wash
    // the whole screen white.
    float nearFade = smoothstep(5.5, 26.0, distance(cameraPosition, vWorldPosition));
    float alpha = uOpacity * edge * nearFade * (0.24 + 0.72 * drift * (0.55 + 0.45 * wisps));
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
  const baseOpacity = config.forestMistOpacity ?? 0.2;
  const color = new THREE.Color(config.forestMistColor ?? 0xdcecf0);
  const random = makeRandom(0x5015f0 + sector.order * 71);
  const meshes = [];
  let thickness = 0;

  for (let layer = 0; layer < layers; layer += 1) {
    // A tall stack thins out towards the top instead of fading to nothing:
    // the canopy fog is subtler than the ground fog, but it is still there.
    // The stack is deliberately deep and thin rather than shallow and opaque:
    // eight drifting layers read as real fog, one thick sheet reads as milk.
    const opacity = baseOpacity * Math.max(0.26, 1 - layer * 0.1);
    const phase = new THREE.Vector2(random() * 240, random() * 240);
    thickness += opacity;
    const material = new THREE.ShaderMaterial({
      name: `ForestMistMaterial_${layer}`,
      uniforms: {
        uColor: { value: color },
        uOpacity: { value: opacity },
        uRadius: { value: radius },
        uTime: uniforms,
        uPhase: { value: phase },
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
    mesh.userData.layer = layer;
    mesh.userData.opacity = opacity;
    mesh.userData.driftSpeed = (config.forestMistDriftSpeed ?? 0.012)
      * (layer % 2 === 0 ? 1 : -0.72)
      * (1 + layer * 0.05);
    // The stack is not a perfect tower of concentric discs: each layer is
    // rotated off its neighbours so the drifting noise never lines up.
    mesh.rotation.y = random() * Math.PI * 2;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  group.userData.thickness = thickness;

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

/**
 * A fallen branch: a tapered, slightly bent bough with three side twigs and a
 * snapped stub, bark-dark on the underside and mossy where it faces the sky.
 * It lies flat, so a few hundred of them can carpet the wood with the broken
 * wood a real forest floor is full of.
 */
function createBranchGeometry(seed = 0x8a41c) {
  const random = makeRandom(seed);
  const builder = makeBuilder();
  const dark = pickColor(random, BARK_DARK_COLORS);
  const light = pickColor(random, BARK_LIGHT_COLORS);
  const sapwood = pickColor(random, SAPWOOD_COLORS);
  const moss = pickColor(random, MOSS_ON_WOOD);
  const up = new THREE.Vector3(0, 1, 0);

  const appendSegment = (from, to, radiusFrom, radiusTo, radialSegments = 5, capped = false) => {
    const direction = new THREE.Vector3().subVectors(to, from);
    const length = Math.max(0.01, direction.length());
    const source = new THREE.CylinderGeometry(
      radiusTo, radiusFrom, length, radialSegments, 1, !capped,
    ).toNonIndexed();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      up, direction.clone().normalize(),
    );
    const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    source.applyQuaternion(quaternion);
    source.translate(midpoint.x, midpoint.y, midpoint.z);
    const positions = source.attributes.position;
    const normals = source.attributes.normal;
    const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const facing = new THREE.Vector3();

    for (let i = 0; i < positions.count; i += 3) {
      let capFacing = true;
      facing.set(0, 0, 0);
      for (let corner = 0; corner < 3; corner += 1) {
        const index = i + corner;
        vertices[corner].set(positions.getX(index), positions.getY(index), positions.getZ(index));
        const normalY = Math.abs(normals.getY(index));
        if (normalY < 0.9) capFacing = false;
        facing.x += normals.getX(index);
        facing.y += normals.getY(index);
        facing.z += normals.getZ(index);
      }
      if (capFacing) {
        // The cut face of the bough: pale, exposed sapwood.
        pushTriangle(builder, vertices[0], vertices[1], vertices[2], sapwood, sapwood, sapwood);
        continue;
      }
      // Anything facing the sky keeps moss and bleached bark; the underside
      // stays dark and damp.
      const upward = THREE.MathUtils.smoothstep(facing.normalize().y, -0.25, 0.8);
      const shade = scratchColor.copy(dark).lerp(light, upward).clone();
      shade.lerp(moss, upward * 0.45);
      pushTriangle(builder, vertices[0], vertices[1], vertices[2], shade, shade, shade);
    }
    source.dispose();
  };

  const bend = between(random, -0.16, 0.16);
  appendSegment(
    new THREE.Vector3(-1.08, 0.07, 0.02),
    new THREE.Vector3(0.02, 0.03, bend),
    0.095, 0.07, 5, true,
  );
  appendSegment(
    new THREE.Vector3(0.02, 0.03, bend),
    new THREE.Vector3(1.12, 0.05, -bend * 0.6),
    0.07, 0.028, 5, true,
  );
  for (let twig = 0; twig < 3; twig += 1) {
    const originX = between(random, -0.62, 0.72);
    const origin = new THREE.Vector3(originX, 0.05, bend * 0.4);
    const angle = between(random, -1.2, 1.2) + (twig % 2 === 0 ? 0.5 : 2.4);
    const length = between(random, 0.3, 0.62);
    appendSegment(
      origin,
      origin.clone().add(new THREE.Vector3(
        Math.cos(angle) * length,
        between(random, 0.02, 0.2),
        Math.sin(angle) * length,
      )),
      0.042, 0.016, 4, true,
    );
  }

  const geometry = finishGeometry(builder, 'ForestBranchGeometry');
  geometry.translate(0, -geometry.boundingBox.min.y, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
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

/**
 * Deterministic scatter inside the hex.
 *
 * The `minSpacing` test used to scan every placement already made, so the
 * scatter cost grew with the square of the count — fine for a few hundred
 * tufts, painful for the thousands HEX_S now carries. A uniform grid keyed on
 * the spacing distance answers the same question from the nine neighbouring
 * cells, which keeps the result identical while the cost stays flat.
 */
function scatter(random, count, { radius, padding = 6, avoid = [], minSpacing = 0, density = null }) {
  const placements = [];
  const limit = Math.max(0, radius - padding);
  let attempts = 0;
  const maxAttempts = count * (density ? 220 : 80) + 40;
  const cellSize = Math.max(0.001, minSpacing);
  const cells = new Map();
  const keyOf = (cellX, cellZ) => cellX * 1000003 + cellZ;
  const addToGrid = (placed) => {
    const key = keyOf(Math.floor(placed.x / cellSize), Math.floor(placed.z / cellSize));
    const bucket = cells.get(key);
    if (bucket) bucket.push(placed);
    else cells.set(key, [placed]);
  };
  const tooCloseToNeighbour = (x, z) => {
    const cellX = Math.floor(x / cellSize);
    const cellZ = Math.floor(z / cellSize);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
        const bucket = cells.get(keyOf(cellX + offsetX, cellZ + offsetZ));
        if (!bucket) continue;
        for (const placed of bucket) {
          if (Math.hypot(placed.x - x, placed.z - z) < minSpacing) return true;
        }
      }
    }
    return false;
  };

  while (placements.length < count && attempts < maxAttempts) {
    attempts += 1;
    const x = between(random, -limit, limit);
    const z = between(random, -limit, limit);
    if (!isPointInsideHex(x, z, 0, 0, limit)) continue;
    if (density && random() > density(x, z)) continue;
    if (avoid.some((zone) => Math.hypot(zone.x - x, zone.z - z) < zone.radius)) continue;
    if (minSpacing > 0 && tooCloseToNeighbour(x, z)) continue;
    const placed = { x, z };
    placements.push(placed);
    if (minSpacing > 0) addToGrid(placed);
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
  const branchCount = Math.max(0, Math.floor(config.forestBranchCount ?? 0));
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
        // Slightly tighter than the original tuft scale: with three times as
        // many clumps on the floor, a few three-metre blades would turn the
        // wood into a marsh, so the giants are trimmed back.
        const scale = between(random, 0.62, 1.62);
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

  if (branchCount > 0) {
    // Broken boughs lie wherever the wind dropped them: no density field, no
    // clustering, just a thick litter of dead wood over the whole floor.
    const branchPlacements = scatter(random, branchCount, {
      radius,
      padding: 12,
      avoid,
      minSpacing: 2.6,
    });
    layers.push(createInstancedLayer({
      name: 'ForestFallenBranches_HEX_S',
      geometry: createBranchGeometry(0x8b2a7 + sector.order),
      material: woodMaterial,
      placements: branchPlacements,
      floorHeightAt,
      normalAt,
      alignToNormal: 0.82,
      sector,
      config,
      transformFor: (transform, placement, offset) => {
        const scale = between(random, 0.75, 1.7);
        transform.position.set(
          sector.center.x + placement.x,
          offset - 0.03,
          sector.center.z + placement.z,
        );
        // A slight roll lifts one end of the bough off the ground, the way a
        // branch rests on the litter underneath it.
        transform.rotation.set(
          between(random, -0.24, 0.24),
          random() * Math.PI * 2,
          between(random, -0.3, 0.3),
        );
        transform.scale.set(scale * between(random, 0.85, 1.25), scale, scale);
      },
    }));
    group.userData.branchCount = branchPlacements.length;
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
