import * as THREE from 'three';
import { distanceToHexEdge } from './ForestTerrain.js';
import { lavaFlowSampleAt } from './LavaFlow.js';
import { measureLavaPoolShoreline } from './LavaPool.js';
import { between, makeRandom } from './random.js';
import { DEFAULT_VOLCANIC_FORMATIONS } from './VolcanicFormations.js';

/**
 * VolcanicRocks — the medium rock layer of HEX_SE.
 *
 * The six landmark formations of `src/world/VolcanicFormations.js` are the
 * large silhouettes of the sector. This module is the other half of a rocky
 * field: a **limited** collection of medium rocks — the knee- to chest-high
 * lumps that gather at the foot of a cliff, along a crater rim and on the
 * banks of lava — deliberately never landmarks themselves.
 *
 *   • **A limited, reusable collection.** Six shapes (a block, a slab, a
 *     wedge, a boulder, a leaning shard and a two-lump cluster) are cut twice
 *     each from two seeds, so the whole layer is drawn from twelve shared
 *     geometries and one material. Every rock is an instance: the layer costs
 *     twelve draw calls no matter how many rocks the seed places.
 *   • **A weighted scatter, not a carpet.** Rocks are gathered around the
 *     crater's rim, at the skirts of the six formations, on the slopes of the
 *     massif, the ridges, the basin rim and the rocky ground, and along the
 *     banks of the three molten surfaces. Each instance then varies in size,
 *     yaw, tilt and shape, so no two look stamped from the same mould.
 *   • **The walking areas stay clear.** The portal aprons, the direct
 *     gate-to-crater routes, the crater floor and the open ash plains carry no
 *     scatter at all, so the sector keeps reading as a landscape with rocks in
 *     it rather than a field of rubble.
 *   • **Nothing else moves.** The planner only samples the final baked
 *     terrain to seat each instance. The lattice, its collision surface, the
 *     crater, the vents, the lava pool, both channels, the cooled crust and
 *     all six formations are bit-for-bit untouched, and the layer is static:
 *     no animation, no particles, no smoke, no collider, no update loop.
 */

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const clampInt = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (value) => (value < 0 ? 0 : (value > 1 ? 1 : value));

/* ---- The collection ------------------------------------------------------
 * Every shape is authored in a unit box: a rock is about one unit across and
 * one unit tall before an instance scales it. Widths, depths and heights below
 * are unit-space too, so the proportions of a shape never depend on the size
 * an instance happens to give it.
 */

const ROCK_PROFILES = Object.freeze({
  // Squat, chunky, broken-topped block.
  block: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.80 }),
    Object.freeze({ y: 0.18, r: 1.00 }),
    Object.freeze({ y: 0.56, r: 0.94 }),
    Object.freeze({ y: 0.84, r: 0.78 }),
    Object.freeze({ y: 1.00, r: 0.52 }),
  ]),
  // Flat, wide slab with a tilted top.
  slab: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.78 }),
    Object.freeze({ y: 0.16, r: 1.02 }),
    Object.freeze({ y: 0.50, r: 0.98 }),
    Object.freeze({ y: 0.78, r: 0.86 }),
    Object.freeze({ y: 1.00, r: 0.60 }),
  ]),
  // Wedge: swells fast, then narrows to a broken ridge.
  wedge: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.72 }),
    Object.freeze({ y: 0.22, r: 1.00 }),
    Object.freeze({ y: 0.62, r: 0.72 }),
    Object.freeze({ y: 0.88, r: 0.40 }),
    Object.freeze({ y: 1.00, r: 0.16 }),
  ]),
  // Rounded on plan, faceted everywhere: the classic lava boulder.
  boulder: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.62 }),
    Object.freeze({ y: 0.14, r: 0.94 }),
    Object.freeze({ y: 0.42, r: 1.00 }),
    Object.freeze({ y: 0.70, r: 0.86 }),
    Object.freeze({ y: 0.90, r: 0.58 }),
    Object.freeze({ y: 1.00, r: 0.32 }),
  ]),
  // Narrow blade that climbs to a broken point.
  shard: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.64 }),
    Object.freeze({ y: 0.12, r: 0.96 }),
    Object.freeze({ y: 0.44, r: 0.78 }),
    Object.freeze({ y: 0.78, r: 0.54 }),
    Object.freeze({ y: 1.00, r: 0.20 }),
  ]),
  // Low plate: the flattest of the six, chipped along one edge.
  plate: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.84 }),
    Object.freeze({ y: 0.26, r: 1.06 }),
    Object.freeze({ y: 0.68, r: 1.00 }),
    Object.freeze({ y: 0.90, r: 0.84 }),
    Object.freeze({ y: 1.00, r: 0.62 }),
  ]),
});

/**
 * Six reusable shapes. Each one is cut twice from its own seed pair, so the
 * layer holds twelve geometries and no single silhouette repeats everywhere.
 */
export const MEDIUM_ROCK_VARIANTS = Object.freeze([
  Object.freeze({
    id: 'ash-block',
    seed: 0x1a37,
    seeds: Object.freeze([0x11a3, 0x6b21]),
    masses: Object.freeze([
      Object.freeze({ profile: 'block', sides: 6, width: 1.00, depth: 0.88, height: 0.82, yaw: 0.14 }),
    ]),
  }),
  Object.freeze({
    id: 'tilted-slab',
    seed: 0x2b45,
    seeds: Object.freeze([0x2c19, 0x74d3]),
    masses: Object.freeze([
      Object.freeze({
        profile: 'slab', sides: 5, width: 1.26, depth: 0.92, height: 0.56,
        yaw: -0.22, leanX: 0.10, leanZ: -0.06,
      }),
    ]),
  }),
  Object.freeze({
    id: 'split-wedge',
    seed: 0x3d51,
    seeds: Object.freeze([0x9f2b, 0x4c77]),
    masses: Object.freeze([
      Object.freeze({ profile: 'wedge', sides: 6, width: 1.02, depth: 0.90, height: 1.02, yaw: 0.05 }),
    ]),
  }),
  Object.freeze({
    id: 'fractured-boulder',
    seed: 0x4e63,
    seeds: Object.freeze([0x5a0d, 0x1e83]),
    masses: Object.freeze([
      Object.freeze({ profile: 'boulder', sides: 7, width: 1.06, depth: 0.96, height: 0.94, yaw: 0.31 }),
    ]),
  }),
  Object.freeze({
    id: 'lean-shard',
    seed: 0x5f75,
    seeds: Object.freeze([0x77b1, 0x2a4f]),
    masses: Object.freeze([
      Object.freeze({
        profile: 'shard', sides: 5, width: 0.92, depth: 0.86, height: 1.18,
        yaw: -0.12, leanX: 0.13, leanZ: 0.07,
      }),
    ]),
  }),
  Object.freeze({
    id: 'shard-cluster',
    seed: 0x6b87,
    seeds: Object.freeze([0x3f5d, 0x8e21]),
    masses: Object.freeze([
      Object.freeze({
        profile: 'block', sides: 6, x: -0.22, z: 0.06, width: 0.86, depth: 0.80,
        height: 0.58, yaw: 0.34,
      }),
      Object.freeze({
        profile: 'shard', sides: 5, x: 0.24, z: -0.11, width: 0.72, depth: 0.74,
        height: 1.06, yaw: -0.42, leanX: 0.15, leanZ: -0.09,
      }),
    ]),
  }),
]);

/** Shared-geometry count: six shapes, two seeded cuts each. */
export const MEDIUM_ROCK_GEOMETRY_COUNT = MEDIUM_ROCK_VARIANTS
  .reduce((total, variant) => total + variant.seeds.length, 0);

/* ---- The scatter's own numbers ------------------------------------------- */

export const VOLCANIC_ROCK_DEFAULTS = Object.freeze({
  id: 'volcanic-medium-rocks-hex-se',
  seed: 0x3c0a17e5,
  // The whole layer is a few hundred lumps in a 125,000-unit sector: about one
  // percent of the ground carries a rock, and only around the anchors below.
  targetCount: 260,
  minSpacing: 3.6,
  // Size of one instance, in world units: a rock is roughly a metre to three
  // metres across and never much more than two and a half units tall.
  size: Object.freeze({ min: 0.86, max: 2.45 }),
  // ...and how much taller or lower than it is wide the instance is drawn.
  heightFactor: Object.freeze({ min: 0.72, max: 1.06 }),
  // Where the slope-borne share of the scatter is allowed to sit: off the flat
  // plains (which stay clear), under the terrain's own walkable limit.
  slope: Object.freeze({ minDeg: 8, maxDeg: 23 }),
  // The crater's rim band, as a fraction of the rim radius on that bearing.
  craterBand: Object.freeze({ inner: 0.84, outer: 1.32 }),
  // Inside this fraction of the rim radius the crater's floor stays clear —
  // unless the rock belongs to the band that hugs the pool.
  craterFloorClear: 0.72,
  // The bands that hug the molten rock: measured outwards from the lava edge.
  lavaBand: Object.freeze({ near: 0.9, far: 6.5 }),
  channelBand: Object.freeze({ near: 0.9, far: 5.5 }),
  // Rocks sit at a landmark's skirt, never inside the landmark itself.
  formationBand: Object.freeze({ inner: 0.90, outer: 13 }),
  // The ways through the sector stay open: the portal aprons, and the two
  // direct corridors from every gate (to the crater and to the sector centre).
  gateClearance: 6,
  routeClearance: 13,
  hexMargin: 9,
  // How the limited budget is spent. The three anchor zones take the bulk of
  // it; the rest rides the slopes between them.
  zones: Object.freeze({
    'crater-rim': 0.32,
    'formation-skirts': 0.22,
    slopes: 0.28,
    'lava-banks': 0.18,
  }),
  // Rejection-sampling budget per wanted rock, per zone.
  attemptFactor: 90,
  // How far an instance leans into the slope it stands on, and how deep it is
  // bedded into the ground so it never perches on one edge.
  alignToSlope: 0.35,
  sinkFactor: 0.16,
  sinkBase: 0.1,
});

/* ---- Geometry ------------------------------------------------------------ */

// The same five basalt tones the landmark formations are cut from, so a
// medium rock reads as the same rock as the spire it gathers under.
const ROCK_TONES = Object.freeze([
  0x33373e,
  0x3e434a,
  0x494e55,
  0x555a61,
  0x62676e,
].map((hex) => new THREE.Color(hex)));

function rotateXZ(x, z, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - z * sin, z: x * sin + z * cos };
}

function randomTone(random, top = false) {
  const index = top
    ? Math.min(ROCK_TONES.length - 1, 2 + Math.floor(random() * 3))
    : Math.floor(random() * ROCK_TONES.length);
  return ROCK_TONES[index];
}

class RockGeometryBuilder {
  constructor() {
    this.positions = [];
    this.colors = [];
  }

  triangle(a, b, c, color) {
    for (const point of [a, b, c]) {
      this.positions.push(point.x, point.y, point.z);
      this.colors.push(color.r, color.g, color.b);
    }
  }

  build(name, variant, cut) {
    const geometry = new THREE.BufferGeometry();
    geometry.name = name;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData = {
      sectorId: 'HEX_SE',
      variantId: variant.id,
      variantShape: variant.masses[0].profile,
      featureType: 'medium-volcanic-rock',
      surface: 'fractured-volcanic-basalt',
      cut,
      static: true,
    };
    return geometry;
  }
}

/**
 * One faceted mass, in unit space: rings of vertices around a vertical profile,
 * each ring wobbled per side and per ring, closed by a broken cap and a buried
 * bottom. Angles and radii are seeded, so the same shape cut from a different
 * seed is genuinely a different rock rather than the same rock scaled.
 */
function appendMass(builder, mass, random) {
  const profile = ROCK_PROFILES[mass.profile];
  if (!profile) throw new RangeError(`Unknown medium rock profile: ${mass.profile}`);

  const sides = clampInt(mass.sides ?? 6, 5, 9);
  const yaw = mass.yaw ?? 0;
  const leanX = mass.leanX ?? 0;
  const leanZ = mass.leanZ ?? 0;
  const offsetX = mass.x ?? 0;
  const offsetZ = mass.z ?? 0;
  const width = Math.max(0.1, mass.width ?? 1);
  const depth = Math.max(0.1, mass.depth ?? 1);
  const height = Math.max(0.1, mass.height ?? 1);
  const phase = random() * TAU;
  const angleJitter = Array.from({ length: sides }, () => (random() - 0.5) * 0.26);
  const facetScale = Array.from({ length: sides }, () => 0.84 + random() * 0.3);

  const rings = profile.map((level, ringIndex) => {
    const vertices = [];
    for (let side = 0; side < sides; side += 1) {
      const angle = phase + (side / sides) * TAU + angleJitter[side];
      const ringNoise = ringIndex === 0 ? 0 : (random() - 0.5) * 0.22;
      const scale = level.r * facetScale[side] * (1 + ringNoise);
      const local = rotateXZ(
        Math.cos(angle) * width * 0.5 * scale,
        Math.sin(angle) * depth * 0.5 * scale,
        yaw,
      );
      const topBreak = ringIndex === profile.length - 1 ? (random() - 0.5) * 0.16 : 0;
      vertices.push({
        x: offsetX + local.x + leanX * level.y,
        y: Math.max(0, level.y + topBreak) * height,
        z: offsetZ + local.z + leanZ * level.y,
      });
    }
    return vertices;
  });

  // Flat side facets, each deliberately toned on its own: this is what makes a
  // small rock read as a fractured piece of basalt rather than a pebble.
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const next = (side + 1) % sides;
      const lowerA = rings[ring][side];
      const lowerB = rings[ring][next];
      const upperA = rings[ring + 1][side];
      const upperB = rings[ring + 1][next];
      const tone = randomTone(random, ring >= profile.length - 3);
      builder.triangle(lowerA, upperA, upperB, tone);
      builder.triangle(lowerA, upperB, lowerB, tone);
    }
  }

  // A broken cap, offset towards wherever the mass leans.
  const topRing = rings.at(-1);
  const topCenter = {
    x: offsetX + leanX,
    y: height * (0.92 + random() * 0.1),
    z: offsetZ + leanZ,
  };
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    builder.triangle(topCenter, topRing[next], topRing[side], randomTone(random, true));
  }

  // A buried bottom closes the volume; instances bed slightly into the ground.
  const bottomCenter = { x: offsetX, y: 0, z: offsetZ };
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    builder.triangle(bottomCenter, rings[0][side], rings[0][next], ROCK_TONES[0]);
  }
}

/** One shared geometry of the collection, from one shape and one seed cut. */
export function createMediumRockGeometry(variant, cut) {
  const random = makeRandom(((variant.seed ?? 0) ^ (cut ?? 0)) >>> 0);
  const builder = new RockGeometryBuilder();
  for (const mass of variant.masses) appendMass(builder, mass, random);
  return builder.build(`MediumRockGeometry_${variant.id}_${cut.toString(16)}`, variant, cut);
}

/**
 * The shared geometries of the layer, in a stable order, with the variant each
 * one was cut from. The builder reuses these instances for every rock, which is
 * what keeps a scatter of hundreds of rocks at twelve draw calls.
 */
export function createMediumRockGeometries(variants = MEDIUM_ROCK_VARIANTS) {
  const records = [];
  variants.forEach((variant, variantIndex) => {
    variant.seeds.forEach((cut, cutIndex) => {
      records.push({
        variantIndex,
        cut,
        cutIndex,
        variantId: variant.id,
        variantShape: variant.masses[0].profile,
        geometry: createMediumRockGeometry(variant, cut),
      });
    });
  });
  return records;
}

/* ---- Where the rocks go -------------------------------------------------- */

function distanceToSegment(x, z, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0
    ? clamp01(((x - start.x) * dx + (z - start.z) * dz) / lengthSq)
    : 0;
  return Math.hypot(x - (start.x + dx * t), z - (start.z + dz * t));
}

/** The measured shoreline's radius on the bearing of a sector-local point. */
function shoreRadiusAt(shoreline, pool, x, z) {
  const count = shoreline.radii.length;
  const bearing = (Math.atan2(z - pool.z, x - pool.x) + TAU) % TAU;
  const at = (bearing / TAU) * count;
  const index = Math.floor(at) % count;
  return mix(shoreline.radii[index], shoreline.radii[(index + 1) % count], at - Math.floor(at));
}

/** The crater's rim radius on the bearing of a sector-local point. */
function rimRadiusAt(terrain, crater, x, z) {
  return terrain.craterRimRadiusAt(x - crater.x, z - crater.z, crater);
}

/**
 * Everything the scatter must respect, measured once from the world as it is:
 * the sector's portals and their direct routes, the crater's rim, the six
 * landmark formations, and the three molten surfaces with the shoreline the
 * pool actually has.
 */
function buildClearanceModel(terrain, config, options = {}) {
  const crater = terrain.layout?.crater ?? null;
  const pool = terrain.lavaPool ?? null;
  const shoreline = pool ? measureLavaPoolShoreline(terrain, pool) : null;
  const channels = [terrain.lavaFlow, terrain.lavaSecondaryFlow].filter(Boolean);

  const gates = (terrain.gateAprons ?? []).map((apron) => ({
    x: apron.x,
    z: apron.z,
    outer: apron.outer ?? 0,
  }));

  // The formations that actually exist are what the scatter gathers around;
  // the authored layout is only the fallback when the caller has none.
  const formationSource = options.formations?.children?.length
    ? options.formations.children
    : (Array.isArray(config.volcanicFormations)
      ? config.volcanicFormations
      : DEFAULT_VOLCANIC_FORMATIONS);
  const formations = formationSource.map((child) => ({
    id: child.userData?.formationId ?? child.id ?? 'formation',
    x: child.position ? child.position.x : child.x,
    z: child.position ? child.position.z : child.z,
    radius: child.userData?.footprintRadius ?? child.footprintRadius ?? 0,
  })).filter((formation) => Number.isFinite(formation.x) && Number.isFinite(formation.z));

  const routes = [];
  if (crater) {
    for (const gate of gates) {
      routes.push({ a: gate, b: { x: crater.x, z: crater.z } });
      routes.push({ a: gate, b: { x: 0, z: 0 } });
    }
  }

  return { crater, pool, shoreline, channels, gates, formations, routes };
}

/**
 * Signed distance to the nearest molten edge of the sector (pool shoreline,
 * main channel, branch): positive is dry ground, zero is the waterline.
 */
export function lavaEdgeDistance(model, x, z) {
  let nearest = Infinity;
  if (model.pool && model.shoreline) {
    const distance = Math.hypot(x - model.pool.x, z - model.pool.z);
    nearest = Math.min(nearest, distance - shoreRadiusAt(model.shoreline, model.pool, x, z));
  }
  for (const channel of model.channels) {
    const sample = lavaFlowSampleAt(x, z, channel);
    if (!sample) continue;
    nearest = Math.min(nearest, sample.distance - sample.halfWidth);
  }
  return nearest;
}

/** A tiny uniform grid, so minimum spacing is one cell lookup, not a scan. */
function createSpacingGrid(cell) {
  const buckets = new Map();
  const key = (ix, iz) => `${ix},${iz}`;
  return {
    cell,
    add(point) {
      const bucketKey = key(Math.floor(point.x / cell), Math.floor(point.z / cell));
      const bucket = buckets.get(bucketKey);
      if (bucket) bucket.push(point);
      else buckets.set(bucketKey, [point]);
    },
    tooClose(x, z, spacing) {
      const ix = Math.floor(x / cell);
      const iz = Math.floor(z / cell);
      for (let cx = ix - 1; cx <= ix + 1; cx += 1) {
        for (let cz = iz - 1; cz <= iz + 1; cz += 1) {
          const bucket = buckets.get(key(cx, cz));
          if (!bucket) continue;
          for (const point of bucket) {
            if (Math.hypot(point.x - x, point.z - z) < spacing) return true;
          }
        }
      }
      return false;
    },
  };
}

/* Each zone sampler proposes one candidate; the shared gate below then decides
 * whether that candidate may exist at all. Samplers never inspect clearance
 * rules, so the four zones stay independent and readable. */

function sampleCraterRim(random, terrain, model, settings) {
  const crater = model.crater;
  if (!crater) return null;
  const bearing = random() * TAU;
  const cos = Math.cos(bearing);
  const sin = Math.sin(bearing);
  const nominal = terrain.craterRimRadiusAt(cos * crater.rimRadius, sin * crater.rimRadius, crater);
  const rim = terrain.craterRimRadiusAt(cos * nominal, sin * nominal, crater);
  const u = between(random, settings.craterBand.inner, settings.craterBand.outer);
  const radius = rim * u;
  return { zone: 'crater-rim', x: crater.x + cos * radius, z: crater.z + sin * radius };
}

function sampleFormationSkirt(random, terrain, model, settings) {
  if (model.formations.length === 0) return null;
  const formation = model.formations[Math.floor(random() * model.formations.length)];
  const bearing = random() * TAU;
  const distance = formation.radius * settings.formationBand.inner
    + between(random, 1.5, settings.formationBand.outer);
  return {
    zone: 'formation-skirts',
    x: formation.x + Math.cos(bearing) * distance,
    z: formation.z + Math.sin(bearing) * distance,
  };
}

function sampleSlope(random, terrain, model, settings) {
  // One in every few attempts is pulled onto the massif's shoulders, so the
  // flanks above and below the rim fill in with the distant ridges.
  if (model.crater && random() < 0.35) {
    const bearing = random() * TAU;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    const u = between(random, 1.25, 2.5);
    const rim = terrain.craterRimRadiusAt(
      cos * model.crater.rimRadius,
      sin * model.crater.rimRadius,
      model.crater,
    );
    return {
      zone: 'slopes',
      x: model.crater.x + cos * rim * u,
      z: model.crater.z + sin * rim * u,
    };
  }
  const reach = terrain.radius * 0.86;
  return { zone: 'slopes', x: between(random, -reach, reach), z: between(random, -reach, reach) };
}

function sampleLavaBank(random, terrain, model, settings) {
  if (model.pool && model.shoreline && random() < 0.5) {
    const bearing = random() * TAU;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    const shore = shoreRadiusAt(
      model.shoreline,
      model.pool,
      model.pool.x + cos * model.pool.radius,
      model.pool.z + sin * model.pool.radius,
    );
    const distance = shore + between(random, settings.lavaBand.near, settings.lavaBand.far);
    return { zone: 'lava-banks', x: model.pool.x + cos * distance, z: model.pool.z + sin * distance };
  }
  if (model.channels.length === 0) return null;
  const channel = model.channels[Math.floor(random() * model.channels.length)];
  const sample = channel.samples[Math.floor(random() * channel.samples.length)];
  const side = random() < 0.5 ? -1 : 1;
  const halfWidth = side < 0 ? sample.left : sample.right;
  const offset = halfWidth + between(random, settings.channelBand.near, settings.channelBand.far);
  return {
    zone: 'lava-banks',
    x: sample.x + sample.nx * offset * side,
    z: sample.z + sample.nz * offset * side,
  };
}

const ZONE_SAMPLERS = Object.freeze({
  'crater-rim': sampleCraterRim,
  'formation-skirts': sampleFormationSkirt,
  slopes: sampleSlope,
  'lava-banks': sampleLavaBank,
});

/** The zones the scatter is drawn from, in the order the budget is spent. */
export const MEDIUM_ROCK_ZONES = Object.freeze(Object.keys(ZONE_SAMPLERS));

/**
 * The shared gate every candidate passes before it becomes a rock: inside the
 * sector with a margin, out of every portal apron and direct gate route, off
 * the lava and off the crater floor, at the skirt of a landmark rather than
 * inside it, on ground gentler than the walkable limit, and at least
 * `minSpacing` away from every rock already placed.
 */
function acceptCandidate(candidate, context) {
  const { terrain, model, settings, grid } = context;
  const { x, z } = candidate;

  if (distanceToHexEdge(x, z, terrain.radius) < settings.hexMargin) return null;

  for (const gate of model.gates) {
    if (Math.hypot(x - gate.x, z - gate.z) < gate.outer + settings.gateClearance) return null;
  }
  for (const route of model.routes) {
    if (distanceToSegment(x, z, route.a, route.b) < settings.routeClearance) return null;
  }

  const lavaDistance = lavaEdgeDistance(model, x, z);
  // Never on the molten rock, and never so close that a rock reads as part of
  // the lava's own chilled margin. (No lava at all leaves every band moot.)
  if (Number.isFinite(lavaDistance) && lavaDistance < settings.lavaBand.near) return null;

  if (model.crater) {
    const rim = rimRadiusAt(terrain, model.crater, x, z);
    const u = Math.hypot(x - model.crater.x, z - model.crater.z) / rim;
    // The crater's floor stays a walking floor: only the band that hugs the
    // pool is allowed inside it.
    if (u < settings.craterFloorClear && lavaDistance > settings.lavaBand.far) return null;
  }

  for (const formation of model.formations) {
    const distance = Math.hypot(x - formation.x, z - formation.z);
    if (distance < formation.radius * settings.formationBand.inner) return null;
  }

  const slopeDeg = Math.atan(terrain.slopeAt(x, z)) * DEG;
  if (slopeDeg > settings.slope.maxDeg) return null;
  if (candidate.zone === 'slopes' && slopeDeg < settings.slope.minDeg) return null;

  if (grid.tooClose(x, z, settings.minSpacing)) return null;

  return {
    zone: candidate.zone,
    x,
    z,
    y: terrain.heightAt(x, z),
    slopeDeg,
    lavaDistance,
  };
}

const ANCHOR_ZONES = Object.freeze(['crater-rim', 'formation-skirts', 'lava-banks']);

/**
 * The layer's settings: the defaults, plus whatever `mapConfig.volcanicRocks`
 * overrides. The nested bands are merged one by one, so retuning the lava band
 * never silently drops the crater band beside it.
 */
export function resolveVolcanicRockSettings(override = null) {
  const settings = {
    ...VOLCANIC_ROCK_DEFAULTS,
    ...(override && typeof override === 'object' ? override : {}),
  };
  for (const key of [
    'size', 'heightFactor', 'slope', 'craterBand', 'lavaBand', 'channelBand',
    'formationBand', 'zones',
  ]) {
    settings[key] = { ...VOLCANIC_ROCK_DEFAULTS[key], ...(settings[key] ?? {}) };
  }
  return settings;
}

/**
 * Plan the whole layer without building a single mesh: a seeded, weighted
 * scatter whose every number — position, size, yaw, tilt, shape — is decided
 * here, so the plan *is* the layer and rebuilding it always reproduces it.
 */
export function planVolcanicRockPlacements(terrain, config = {}, options = {}) {
  if (!terrain || terrain.sectorId !== 'HEX_SE') return null;
  const override = config.volcanicRocks;
  if (config.volcanicRocksEnabled === false || override === false || override === null) return null;

  const settings = resolveVolcanicRockSettings(override);
  const zones = settings.zones;
  const variants = options.variants ?? MEDIUM_ROCK_VARIANTS;
  const geometryRecords = variants.flatMap((variant, variantIndex) => (
    variant.seeds.map((cut, cutIndex) => ({ variantIndex, cut, cutIndex, variantId: variant.id }))
  ));
  const geometryCount = geometryRecords.length;

  const random = makeRandom(settings.seed >>> 0);
  const model = buildClearanceModel(terrain, config, options);
  const grid = createSpacingGrid(Math.max(0.5, settings.minSpacing));
  const context = { terrain, model, settings, grid };
  const placements = [];
  const zoneCounts = {};

  for (const [zone, weight] of Object.entries(zones)) {
    const sampler = ZONE_SAMPLERS[zone];
    if (!sampler || !(weight > 0)) { zoneCounts[zone] = 0; continue; }
    const wanted = Math.max(0, Math.round(settings.targetCount * weight));
    const attempts = wanted * Math.max(1, settings.attemptFactor);
    let placed = 0;
    for (let attempt = 0; attempt < attempts && placed < wanted; attempt += 1) {
      const candidate = sampler(random, terrain, model, settings);
      if (!candidate) continue;
      const point = acceptCandidate(candidate, context);
      if (!point) continue;
      grid.add(point);
      placements.push(point);
      placed += 1;
    }
    zoneCounts[zone] = placed;
  }

  // The shapes are dealt from a shuffled deck, so all twelve shared geometries
  // are used and no zone ends up built from one silhouette.
  const deck = [];
  for (let index = 0; index < placements.length; index += 1) deck.push(index % geometryCount);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  placements.forEach((placement, index) => {
    const record = geometryRecords[deck[index]];
    const size = between(random, settings.size.min, settings.size.max);
    placement.variant = deck[index];
    placement.variantIndex = record.variantIndex;
    placement.variantId = record.variantId;
    placement.cut = record.cut;
    placement.yaw = random() * TAU;
    placement.tiltX = between(random, -0.09, 0.09);
    placement.tiltZ = between(random, -0.09, 0.09);
    placement.scale = {
      x: size * between(random, 0.84, 1.18),
      y: size * between(random, settings.heightFactor.min, settings.heightFactor.max),
      z: size * between(random, 0.82, 1.2),
    };
    // Filled in by the builder, which knows each shape's real extent, but a
    // fresh plan already carries a sane estimate for anything reading it cold.
    placement.sink = settings.sinkBase + placement.scale.y * settings.sinkFactor;
  });

  const sectorArea = (3 * Math.sqrt(3) / 2) * terrain.radius * terrain.radius;
  const anchorShare = placements.length === 0
    ? 0
    : placements.filter((placement) => ANCHOR_ZONES.includes(placement.zone)).length / placements.length;
  const slopeShare = placements.length === 0
    ? 0
    : placements.filter((placement) => placement.slopeDeg >= settings.slope.minDeg).length / placements.length;
  // Rocks that stand on ground flat enough to walk: these are the ones the
  // anchors are allowed to put there, and no others exist.
  const flatCount = placements.filter((placement) => placement.slopeDeg < settings.slope.minDeg).length;

  const stats = {
    count: placements.length,
    variantCount: variants.length,
    geometryCount,
    zoneCounts: { ...zoneCounts },
    anchorShare,
    slopeShare,
    flatCount,
    flatShare: placements.length === 0 ? 0 : flatCount / placements.length,
    sectorArea,
  };

  return {
    placements,
    zoneCounts,
    stats,
    settings,
    model,
    variantCount: variants.length,
    geometryCount,
    geometryRecords,
  };
}

/* ---- The layer ----------------------------------------------------------- */

/** The layer's twelve shared geometries, built once and reused by every build. */
let sharedGeometries = null;
export function mediumRockGeometries() {
  sharedGeometries ??= createMediumRockGeometries();
  return sharedGeometries;
}

/**
 * Build the medium rock layer of HEX_SE and return it as one group of instanced
 * meshes, or null when the sector is not the volcanic one or the layer is
 * switched off. Positions are sector-local (the caller puts the group at the
 * sector's centre), exactly like the terrain, the lava and the formations.
 *
 * The six large landmark formations are passed in as `options.formations`, so
 * the scatter hugs the rocks that actually exist rather than the authored
 * layout; when they are absent the layout data stands in for them.
 */
export function buildVolcanicRocks(terrain, config = {}, options = {}) {
  const plan = planVolcanicRockPlacements(terrain, config, options);
  if (!plan || plan.placements.length === 0) return null;

  const geometries = options.geometries ?? mediumRockGeometries();
  const group = new THREE.Group();
  group.name = 'VolcanicMediumRocks_HEX_SE';

  // One material for every rock in the sector, and one geometry per shape cut:
  // the whole layer is twelve shared meshes drawn as instances.
  const material = new THREE.MeshStandardMaterial({
    name: 'MediumVolcanicBasalt_HEX_SE',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.02,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  const buckets = geometries.map(() => []);
  for (const placement of plan.placements) {
    const bucket = buckets[placement.variant % buckets.length];
    if (bucket) bucket.push(placement);
  }

  const up = new THREE.Vector3(0, 1, 0);
  const groundNormal = new THREE.Vector3();
  const alignment = new THREE.Quaternion();
  const identity = new THREE.Quaternion();
  const transform = new THREE.Object3D();
  const tint = new THREE.Color();
  const meshes = [];
  let minSpan = Infinity;
  let maxSpan = 0;
  let minHeight = Infinity;
  let maxHeight = 0;

  geometries.forEach((record, index) => {
    const bucket = buckets[index];
    if (!bucket || bucket.length === 0) return;
    const geometry = record.geometry;
    const box = geometry.boundingBox;
    const unitSpan = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const unitHeight = box.max.y;
    const mesh = new THREE.InstancedMesh(geometry, material, bucket.length);
    mesh.name = `MediumRockLayer_${record.variantId}_${record.cutIndex}_HEX_SE`;
    mesh.count = bucket.length;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      sectorId: 'HEX_SE',
      variantId: record.variantId,
      variantShape: record.variantShape,
      instanceCount: bucket.length,
      featureType: 'medium-volcanic-rock-instances',
      static: true,
      collidable: false,
    };

    bucket.forEach((placement, instance) => {
      // Measure the instance against the shape it was dealt, so the amount it
      // is bedded into the ground follows the rock's real height.
      const span = Math.max(placement.scale.x, placement.scale.z) * unitSpan;
      const height = placement.scale.y * unitHeight;
      placement.span = span;
      placement.height = height;
      placement.sink = plan.settings.sinkBase + height * plan.settings.sinkFactor;
      // Bed the rock into the ground it stands on, leaning part of the way into
      // the slope so it sits in the bank instead of perched on it.
      transform.position.set(placement.x, placement.y - placement.sink, placement.z);
      transform.scale.set(placement.scale.x, placement.scale.y, placement.scale.z);
      transform.rotation.set(placement.tiltX, placement.yaw, placement.tiltZ);
      terrain.normalAt(placement.x, placement.z, groundNormal);
      alignment.setFromUnitVectors(up, groundNormal);
      alignment.slerpQuaternions(identity, alignment, plan.settings.alignToSlope);
      transform.quaternion.premultiply(alignment);
      transform.updateMatrix();
      mesh.setMatrixAt(instance, transform.matrix);
      // A little per-instance brightness on top of the baked facet tones, so
      // neighbouring rocks of the same shape never read as one repeated prop.
      const brightness = 0.84 + ((instance * 37 + index * 11) % 22) / 100;
      tint.setRGB(brightness, brightness, brightness);
      mesh.setColorAt(instance, tint);

      minSpan = Math.min(minSpan, span);
      maxSpan = Math.max(maxSpan, span);
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    meshes.push(mesh);
    group.add(mesh);
  });

  const coveredArea = plan.placements.reduce(
    (total, placement) => total + Math.PI * (placement.span * 0.5) ** 2,
    0,
  );
  const stats = {
    ...plan.stats,
    meshCount: meshes.length,
    coveredArea,
    coverageShare: coveredArea / plan.stats.sectorArea,
    sizes: {
      minSpan,
      maxSpan,
      minHeight,
      maxHeight,
      meanSpan: plan.placements.reduce((total, placement) => total + placement.span, 0) / plan.placements.length,
      meanHeight: plan.placements.reduce((total, placement) => total + placement.height, 0) / plan.placements.length,
    },
  };

  group.userData = {
    sectorId: 'HEX_SE',
    featureType: 'medium-volcanic-rock-layer',
    rockCount: plan.placements.length,
    variantCount: plan.variantCount,
    geometryCount: plan.geometryCount,
    meshCount: meshes.length,
    instanced: true,
    static: true,
    collidable: false,
    zoneCounts: { ...plan.zoneCounts },
    stats,
    placements: plan.placements,
  };

  return group;
}
