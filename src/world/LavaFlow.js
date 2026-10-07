import * as THREE from 'three';
import { distanceToHexEdge } from './ForestTerrain.js';
import { createLavaMaterial, LAVA_MATERIAL_DEFAULTS, measureLavaPoolShoreline } from './LavaPool.js';

/**
 * The ONE outlet of HEX_SE's existing pool. A winding spillway through the
 * crater's low northwest saddle reaches the near side of the lower basin.
 *
 * The pool is below its enclosing rim, so simply draping a ribbon over the
 * old ground would run uphill. First measure a descending profile against the
 * baked relief, then cut its bed into that same collision/render lattice.
 * Only the bed and the slopes needed to join it to the old ground are cut.
 * The surface is a static, crust-edged tongue, not a water shader or a hazard.
 */
export const LAVA_FLOW_DEFAULTS = Object.freeze({
  id: 'lava-flow-hex-se',
  width: 9,
  depth: 0.38,
  minimumGrade: 0.014,
  sampleSpacing: 0.85,
  crossSegments: 16,
  // Five centimetres also clear interpolation across coarse terrain edges.
  lift: 0.055,
  seed: 0x1a7af10,
  // Sector-local offsets from the EXISTING pool, not a second lava source.
  // The broad bends pass through the saddle, then follow the basin's flank.
  path: Object.freeze([
    Object.freeze({ x: -6, z: -3 }),
    Object.freeze({ x: -16, z: -9 }),
    Object.freeze({ x: -23, z: -19 }),
    Object.freeze({ x: -34, z: -22 }),
    Object.freeze({ x: -46, z: -20 }),
    Object.freeze({ x: -58, z: -27 }),
    Object.freeze({ x: -65, z: -37 }),
    Object.freeze({ x: -75, z: -41 }),
    Object.freeze({ x: -86, z: -39 }),
  ]),
});

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const mix = (a, b, t) => a + (b - a) * t;
function smooth(a, b, n) {
  const t = clamp01((n - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Seeded, smoothly interpolated 1D noise; each bank has its own phase. */
function noise(n, seed) {
  const hash = (i) => {
    let h = Math.imul(i, 0x45d9f3b) ^ seed;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
  };
  const i = Math.floor(n);
  return mix(hash(i), hash(i + 1), smooth(0, 1, n - i));
}

function shoreRadius(shoreline, pool, x, z) {
  const bearing = (Math.atan2(z - pool.z, x - pool.x) + Math.PI * 2) % (Math.PI * 2);
  const at = bearing / (Math.PI * 2) * shoreline.radii.length;
  const i = Math.floor(at);
  return mix(shoreline.radii[i], shoreline.radii[(i + 1) % shoreline.radii.length], at - i);
}

/** Plan one unbranched spine; every height is measured before carving. */
export function planLavaFlow(terrain, pool, config = {}) {
  if (!terrain || !pool || terrain.sectorId !== 'HEX_SE'
    || config.lavaFlowEnabled === false || config.lavaFlow === false || config.lavaFlow === null) return null;
  const settings = { ...LAVA_FLOW_DEFAULTS, ...(config.lavaFlow ?? {}) };
  if (!Array.isArray(settings.path) || settings.path.length < 2) return null;
  const controls = settings.path.map((p) => new THREE.Vector3(pool.x + p.x, 0, pool.z + p.z));
  if (controls.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) return null;
  const width = Math.max(3, Math.min(14, settings.width));
  const curve = new THREE.CatmullRomCurve3(controls, false, 'centripetal');
  curve.arcLengthDivisions = 600;
  const length = curve.getLength();
  if (length < 10) return null;
  const count = Math.ceil(length / Math.max(0.5, settings.sampleSpacing));
  const points = curve.getSpacedPoints(count);
  // Never put lava (or its cut banks) on a doorway or a shared boundary.
  if (points.some((p) => distanceToHexEdge(p.x, p.z, terrain.radius) < width + 32
    || terrain.gateAprons?.some((gate) => Math.hypot(p.x - gate.x, p.z - gate.z) < gate.outer + width + 18))) return null;

  const sourceShoreline = measureLavaPoolShoreline(terrain, pool);
  const first = points[0];
  if (Math.hypot(first.x - pool.x, first.z - pool.z) + width * 0.5
    >= shoreRadius(sourceShoreline, pool, first.x, first.z)) return null;
  const end = points.at(-1);
  if (terrain.heightAt(end.x, end.z) >= pool.level - 1) return null;

  const spacing = length / count;
  const outletIndex = points.findIndex((p) => Math.hypot(p.x - pool.x, p.z - pool.z)
    >= shoreRadius(sourceShoreline, pool, p.x, p.z));
  const outletDistance = Math.max(0, outletIndex) * spacing;
  const depth = Math.max(0.15, Math.min(0.65, settings.depth));
  // The submerged overlap stays wholly below the pool, including its bevel.
  // Crossing two nearly coplanar surfaces here would shimmer at the mouth.
  const sourceLevel = pool.level + pool.lift - 0.035;
  const grade = Math.max(0.004, Math.min(0.04, settings.minimumGrade));
  const raw = points.map((p, i) => {
    const s = i * spacing;
    const spillway = sourceLevel - grade * Math.max(0, s - outletDistance - 2);
    return s < outletDistance + 6 ? spillway : Math.min(spillway, terrain.heightAt(p.x, p.z) + depth);
  });
  // Soften the change from the outlet's shallow grade onto the steeper flank.
  // Then enforce downstream-only motion: no hump can turn the lava uphill.
  const samples = [];
  for (let i = 0; i <= count; i += 1) {
    const s = i * spacing;
    let total = 0;
    for (let k = -4; k <= 4; k += 1) total += raw[Math.max(0, Math.min(count, i + k))];
    const previous = samples.at(-1);
    const drop = grade * Math.min(spacing, Math.max(0, s - outletDistance - 2));
    const y = Math.min(total / 9, previous ? previous.y - drop : sourceLevel);
    const tangent = curve.getTangentAt(i / count).normalize();
    // Long contractions/expansions, plus independent small scallops on each
    // bank. A single rounded toe closes the tongue, never a second pool.
    const breadth = width * (0.92 + 0.24 * Math.sin(s * 0.105 + 1.1) + 0.1 * Math.sin(s * 0.233 + 0.8));
    const toe = clamp01((s - (length - 9)) / 9);
    const taper = Math.sqrt(Math.max(0, 1 - toe * toe));
    const half = breadth * 0.5 * taper;
    const left = half * (1 + 0.11 * noise(s * 0.31, settings.seed) + 0.055 * noise(s * 0.93, settings.seed + 17));
    const right = half * (1 + 0.12 * noise(s * 0.27 + 5, settings.seed + 91) + 0.05 * noise(s * 1.07, settings.seed + 331));
    samples.push({ x: points[i].x, z: points[i].z, y, s, nx: -tangent.z, nz: tangent.x, left, right });
  }
  const bounds = new THREE.Box2();
  for (const p of samples) bounds.expandByPoint(new THREE.Vector2(p.x, p.z));
  bounds.expandByScalar(width + 36);
  const mouth = samples[Math.max(0, outletIndex)];
  const outlet = {
    bearing: Math.atan2(mouth.z - pool.z, mouth.x - pool.x),
    halfAngle: Math.atan2((mouth.left + mouth.right) * 0.5, Math.hypot(mouth.x - pool.x, mouth.z - pool.z)),
  };
  return { ...settings, width, depth, length, spacing, samples, sourceShoreline, sourceLevel, outletDistance, outlet, pool, bounds };
}

/** Nearest point on the single spine, shared by the bed and its cooled banks. */
export function lavaFlowSampleAt(x, z, flow) {
  if (!flow || x < flow.bounds.min.x || x > flow.bounds.max.x || z < flow.bounds.min.y || z > flow.bounds.max.y) return null;
  let nearest = null;
  let bestSq = Infinity;
  for (let i = 1; i < flow.samples.length; i += 1) {
    const a = flow.samples[i - 1];
    const b = flow.samples[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = clamp01(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz));
    const ox = x - mix(a.x, b.x, t);
    const oz = z - mix(a.z, b.z, t);
    const distanceSq = ox * ox + oz * oz;
    if (distanceSq >= bestSq) continue;
    bestSq = distanceSq;
    const side = ox * mix(a.nx, b.nx, t) + oz * mix(a.nz, b.nz, t);
    nearest = {
      s: mix(a.s, b.s, t),
      y: mix(a.y, b.y, t),
      distance: Math.sqrt(distanceSq),
      halfWidth: side < 0 ? mix(a.left, b.left, t) : mix(a.right, b.right, t),
    };
  }
  return nearest;
}

/**
 * Cut the channel; propagate ONLY downward to maintain the lattice's existing
 * edge-slope budget. This is the smallest walkable cut around the bed: no
 * whole-sector relaxation, no new raised banks, no rocks or separate collider.
 */
export function carveLavaFlow(terrain, flow) {
  if (!terrain || !flow) return null;
  const { heights, positions, indices, vertexCount, isRim } = terrain;
  const before = heights.slice();
  const queue = [];
  for (let v = 0; v < vertexCount; v += 1) {
    if (isRim[v]) continue;
    const sample = lavaFlowSampleAt(positions[v * 3], positions[v * 3 + 2], flow);
    // A lattice-cell shoulder lets the sheet's fine mesh sit entirely below
    // the bank, rather than being pierced by a coarse terrain triangle.
    if (!sample || sample.distance > sample.halfWidth + terrain.cellSize * 1.1) continue;
    const target = sample.y - flow.depth;
    if (heights[v] <= target) continue;
    heights[v] = target;
    queue.push(v);
  }
  const neighbors = Array.from({ length: vertexCount }, () => new Set());
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e += 1) {
      const a = indices[t + e];
      const b = indices[t + (e + 1) % 3];
      neighbors[a].add(b);
      neighbors[b].add(a);
    }
  }
  const limit = terrain.maxSlope * terrain.cellSize;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const a = queue[cursor];
    for (const b of neighbors[a]) {
      if (isRim[b] || heights[b] <= heights[a] + limit + 1e-6) continue;
      heights[b] = heights[a] + limit;
      queue.push(b);
    }
  }
  let vertices = 0;
  let deepestCut = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    if (before[v] === heights[v]) continue;
    vertices += 1;
    deepestCut = Math.max(deepestCut, before[v] - heights[v]);
  }
  return { id: flow.id, vertices, deepestCut };
}

/** A thin dark transition on the existing basalt, confined to the channel. */
export function lavaFlowShadeAt(x, z, height, flow) {
  const sample = lavaFlowSampleAt(x, z, flow);
  if (!sample) return { crust: 0, ember: 0 };
  const outside = Math.max(0, sample.distance - sample.halfWidth);
  const reach = 1 - smooth(0.6, 4.5, outside);
  const heightFade = 1 - smooth(0.3, 2, height - sample.y);
  return { crust: reach * heightFade, ember: reach * heightFade * (1 - smooth(0, 1.2, outside)) * 0.25 };
}

const COLD = new THREE.Color(0.13, 0.06, 0.035);
const WARM = new THREE.Color(0.57, 0.13, 0.035);
const MOLTEN = new THREE.Color(1.05, 0.41, 0.105);
const HOT = new THREE.Color(1.2, 0.64, 0.22);

/** One indexed strip and one rounded end, sharing the pool's static material. */
export function buildLavaFlow(terrain, flow, config = {}) {
  if (!terrain || !flow) return null;
  const crossSegments = Math.max(8, Math.min(32, Math.round(flow.crossSegments / 2) * 2));
  const rows = flow.samples.length - 1;
  const rowSize = crossSegments + 1;
  const vertexCount = rows * rowSize + 1;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];
  const tile = Math.max(1, config.lavaCrustTile ?? LAVA_MATERIAL_DEFAULTS.crustTile);
  const color = new THREE.Color();

  const write = (v, p, cross) => {
    const side = cross < 0 ? p.left : p.right;
    const x = p.x + p.nx * cross * side;
    const z = p.z + p.nz * cross * side;
    const ground = terrain.heightAt(x, z);
    const edge = smooth(0.65, 1, Math.abs(cross));
    const toe = smooth(flow.length - 6, flow.length, p.s);
    // The centre carries the downhill surface. Its chilled edges and its toe
    // meet the actual triangles underfoot, eliminating a floating ribbon edge.
    const seat = Math.max(edge, toe);
    const y = mix(p.y, Math.min(p.y, ground + flow.lift), seat);
    positions.set([x, y, z], v * 3);

    // Frozen streaks of cooling skin stretch down the current. These are only
    // vertex colours: there is no time uniform, moving UV, light or particle.
    const streak = Math.sin(cross * 14 + noise(p.s * 0.065, flow.seed + 71) * 2.3);
    const raft = smooth(0.1, 0.75, noise(p.s * 0.16 + cross * 1.7, flow.seed + 211)) * (0.5 + 0.5 * streak);
    const grain = 0.5 + 0.5 * noise(p.s * 0.8 + cross * 3.8, flow.seed + 449);
    const heat = (1 - edge) * (1 - toe * 0.92) * (0.74 + grain * 0.2) * (1 - raft * 0.65);
    color.copy(COLD).lerp(WARM, smooth(0.02, 0.28, heat));
    color.lerp(MOLTEN, smooth(0.24, 0.85, heat));
    color.lerp(HOT, smooth(0.78, 1, heat) * 0.55);
    colors.set([color.r, color.g, color.b], v * 3);
    // Same world-space projection as the pool, so the shared crust tile does
    // not jump orientation at their join.
    uvs.set([(x * Math.cos(0.37) - z * Math.sin(0.37)) / tile,
      (x * Math.sin(0.37) + z * Math.cos(0.37)) / tile], v * 2);
  };

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c <= crossSegments; c += 1) write(r * rowSize + c, flow.samples[r], c / crossSegments * 2 - 1);
    if (r === 0) continue;
    for (let c = 0; c < crossSegments; c += 1) {
      const a = (r - 1) * rowSize + c;
      const b = r * rowSize + c;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const tip = vertexCount - 1;
  write(tip, flow.samples.at(-1), 0);
  for (let c = 0; c < crossSegments; c += 1) {
    const a = (rows - 1) * rowSize + c;
    indices.push(a, a + 1, tip);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'LavaFlowGeometry_HEX_SE';
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = indices.slice(t, t + 3).map((v) => v * 3);
    area += Math.abs((positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2])
      - (positions[b + 2] - positions[a + 2]) * (positions[c] - positions[a])) * 0.5;
  }
  const material = createLavaMaterial(config);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'LavaFlowMesh_HEX_SE';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData = { sectorId: 'HEX_SE', surface: 'molten-lava', flowId: flow.id, lavaArea: area };
  const group = new THREE.Group();
  group.name = 'LavaFlow_HEX_SE';
  group.userData = { sectorId: 'HEX_SE', flowId: flow.id, poolId: flow.pool.id, meshes: 1,
    animates: false, particles: 0, lights: 0, area };
  group.add(mesh);
  geometry.userData.lava = { flow: flow.id, length: flow.length, vertexCount, triangleCount: indices.length / 3, lavaArea: area };
  return { group, mesh, material, geometry, flow, area, vertexCount, triangleCount: indices.length / 3 };
}
