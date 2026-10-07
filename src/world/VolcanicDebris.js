import * as THREE from 'three';
import { BASALT_TONES, createVolcanicPropMaterial } from './VolcanicMaterials.js';
import { distanceToHexEdge } from './ForestTerrain.js';
import { measureLavaPoolShoreline } from './LavaPool.js';
import { between, makeRandom } from './random.js';
import { DEFAULT_VOLCANIC_FORMATIONS } from './VolcanicFormations.js';
import { lavaEdgeDistance } from './VolcanicRocks.js';

/**
 * VolcanicDebris — the small debris layer of HEX_SE.
 *
 * The landmark formations (`src/world/VolcanicFormations.js`) are the
 * silhouettes of the sector and the medium rocks (`src/world/VolcanicRocks.js`)
 * are the knee-high lumps between them. This module is the last, quietest
 * layer under both: the **small stones, broken basalt fragments, tiny rock
 * pieces and volcanic rubble** that gather where a field of basalt has been
 * cracking, crumbling and sliding for a long time.
 *
 *   • **Small by construction.** An instance is drawn between about 0.10 and
 *     0.66 units across and 0.03 to 0.47 units tall — a chip, a splinter, a
 *     small stone, a little three-piece pile of rubble. Every shape is
 *     authored in a unit box and no shape is authored wider than 1.1 units or
 *     taller than 0.9, so the debris is always a fraction of the medium rock
 *     standing beside it and never a landmark of its own.
 *   • **A low-density scatter, never a carpet.** The whole layer is a few
 *     hundred chips in the sector's 125,747 square units, spent almost
 *     entirely on the four places debris actually collects — the crater's own
 *     edges, the feet of the six large formations, the banks of the three
 *     molten surfaces and ground steep enough for scree. Pieces keep a minimum
 *     spacing from one another and are additionally capped per coarse cell, so
 *     no pocket of the sector can turn into a field of rubble.
 *   • **Shared meshes, one material.** Six shapes are cut twice each from two
 *     seeds, so the layer holds **twelve shared geometries**; every piece in
 *     the sector is an instance of one of them, which keeps the whole layer at
 *     twelve instanced draw calls however large the scatter is.
 *   • **Nothing else moves.** The planner only samples the final baked terrain
 *     to seat each instance. It adds no gameplay system: no collider, no
 *     animation, no particles, no light, no update loop, no damage, no zone.
 *     The lattice, its collision surface, the crater, the vents, the lava
 *     pool, both channels, the cooled crust, the six formations and the medium
 *     rocks are bit-for-bit what they were before the layer was built.
 */

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const clampInt = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (value) => (value < 0 ? 0 : (value > 1 ? 1 : value));

/* ---- The collection ------------------------------------------------------
 * Every shape is authored in a unit box: a piece is about one unit across
 * before an instance scales it down. The profiles are cut low and chipped on
 * purpose — a chip of basalt breaks flat, so its silhouette is a stack of
 * short, faceted rings rather than a boulder.
 */

const DEBRIS_PROFILES = Object.freeze({
  // A thin, wide flake: the shape an ash chip breaks into.
  chip: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.84 }),
    Object.freeze({ y: 0.30, r: 1.00 }),
    Object.freeze({ y: 0.74, r: 0.88 }),
    Object.freeze({ y: 1.00, r: 0.50 }),
  ]),
  // A small, rounded stone, still faceted on every side.
  pebble: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.64 }),
    Object.freeze({ y: 0.22, r: 0.94 }),
    Object.freeze({ y: 0.62, r: 1.00 }),
    Object.freeze({ y: 0.88, r: 0.72 }),
    Object.freeze({ y: 1.00, r: 0.36 }),
  ]),
  // A splinter: narrow, climbing to a broken point.
  splinter: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.56 }),
    Object.freeze({ y: 0.14, r: 0.90 }),
    Object.freeze({ y: 0.50, r: 0.68 }),
    Object.freeze({ y: 0.82, r: 0.42 }),
    Object.freeze({ y: 1.00, r: 0.14 }),
  ]),
  // A low, chunky clod with a broken cap.
  clod: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.76 }),
    Object.freeze({ y: 0.28, r: 1.00 }),
    Object.freeze({ y: 0.70, r: 0.90 }),
    Object.freeze({ y: 1.00, r: 0.54 }),
  ]),
  // A flat platelet, chipped along one edge.
  platelet: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.78 }),
    Object.freeze({ y: 0.36, r: 1.04 }),
    Object.freeze({ y: 0.74, r: 0.94 }),
    Object.freeze({ y: 1.00, r: 0.60 }),
  ]),
  // A squat wedge: swells, then breaks into a short ridge.
  wedge: Object.freeze([
    Object.freeze({ y: 0.00, r: 0.68 }),
    Object.freeze({ y: 0.32, r: 1.00 }),
    Object.freeze({ y: 0.68, r: 0.66 }),
    Object.freeze({ y: 1.00, r: 0.20 }),
  ]),
});

/**
 * Six reusable shapes. Each one is cut twice from its own seed pair, so the
 * layer holds twelve geometries and no single silhouette repeats everywhere.
 * The last of them is a little pile rather than one stone, because volcanic
 * rubble collects in twos and threes.
 */
export const DEBRIS_VARIANTS = Object.freeze([
  Object.freeze({
    id: 'ash-chip',
    seed: 0x11d3,
    seeds: Object.freeze([0x0a17, 0x5c39]),
    kind: 'chip',
    masses: Object.freeze([
      Object.freeze({ profile: 'chip', sides: 5, width: 1.04, depth: 0.84, height: 0.46, yaw: 0.20 }),
    ]),
  }),
  Object.freeze({
    id: 'split-pebble',
    seed: 0x22e5,
    seeds: Object.freeze([0x1b83, 0x6d41]),
    kind: 'stone',
    masses: Object.freeze([
      Object.freeze({ profile: 'pebble', sides: 7, width: 0.86, depth: 0.80, height: 0.68, yaw: -0.28 }),
    ]),
  }),
  Object.freeze({
    id: 'basalt-splinter',
    seed: 0x33f7,
    seeds: Object.freeze([0x2c55, 0x7e13]),
    kind: 'fragment',
    masses: Object.freeze([
      Object.freeze({
        profile: 'splinter', sides: 5, width: 0.60, depth: 0.52, height: 0.88,
        yaw: -0.34, leanX: 0.18, leanZ: -0.09,
      }),
    ]),
  }),
  Object.freeze({
    id: 'cinder-clod',
    seed: 0x4409,
    seeds: Object.freeze([0x3d27, 0x8f05]),
    kind: 'stone',
    masses: Object.freeze([
      Object.freeze({ profile: 'clod', sides: 6, width: 0.92, depth: 0.86, height: 0.58, yaw: 0.36 }),
    ]),
  }),
  Object.freeze({
    id: 'broken-platelet',
    seed: 0x551b,
    seeds: Object.freeze([0x4e19, 0x91a7]),
    kind: 'fragment',
    masses: Object.freeze([
      Object.freeze({
        profile: 'platelet', sides: 6, width: 0.98, depth: 0.74, height: 0.34,
        yaw: 0.12, leanX: 0.07, leanZ: -0.11,
      }),
    ]),
  }),
  Object.freeze({
    id: 'rubble-pile',
    seed: 0x662d,
    seeds: Object.freeze([0x5f2b, 0xa3b9]),
    kind: 'rubble',
    masses: Object.freeze([
      Object.freeze({
        profile: 'chip', sides: 5, x: -0.25, z: 0.11, width: 0.70, depth: 0.60,
        height: 0.32, yaw: 0.42,
      }),
      Object.freeze({
        profile: 'pebble', sides: 6, x: 0.23, z: -0.15, width: 0.56, depth: 0.52,
        height: 0.44, yaw: -0.52,
      }),
      Object.freeze({
        profile: 'splinter', sides: 5, x: 0.09, z: 0.27, width: 0.34, depth: 0.32,
        height: 0.62, yaw: 0.94, leanX: 0.10, leanZ: -0.06,
      }),
    ]),
  }),
]);

/** Shared-geometry count: six shapes, two seeded cuts each. */
export const DEBRIS_GEOMETRY_COUNT = DEBRIS_VARIANTS
  .reduce((total, variant) => total + variant.seeds.length, 0);

/* ---- The scatter's own numbers ------------------------------------------- */

export const VOLCANIC_DEBRIS_DEFAULTS = Object.freeze({
  id: 'volcanic-small-debris-hex-se',
  seed: 0x5c1e0d0b,
  // A few hundred chips in a 125,000-unit sector, and all of them in the four
  // bands below: at this budget the layer reads as rubble where rubble belongs
  // and disappears completely on the open ash plains.
  targetCount: 880,
  // Two chips never tumble to rest closer than this (world units).
  minSpacing: 0.85,
  // ...and however they are sampled, no coarse cell may hold more than this
  // many: the low-density guarantee, independent of the random draw.
  cluster: Object.freeze({ cell: 5, max: 3 }),
  // Size of one instance, in world units. The largest chip in the sector is
  // still smaller than the smallest medium rock.
  size: Object.freeze({ min: 0.16, max: 0.52 }),
  // ...and how much taller or lower than it is wide the instance is drawn.
  heightFactor: Object.freeze({ min: 0.62, max: 1.00 }),
  // Where the slope-borne share of the scatter is allowed to sit: off the flat
  // plains (which stay clear) and under the terrain's own walkable limit.
  slope: Object.freeze({ minDeg: 9, maxDeg: 24 }),
  // The crater's edge band, as a fraction of the rim radius on that bearing.
  craterBand: Object.freeze({ inner: 0.80, outer: 1.36 }),
  // Inside this fraction of the rim radius the crater's floor stays clear —
  // unless the piece belongs to the band that hugs the molten rock.
  craterFloorClear: 0.74,
  // The bands that hug the molten rock: measured outwards from the lava edge.
  // Debris may sit right against the chilled margin, but never on the lava.
  lavaBand: Object.freeze({ near: 0.35, far: 4.2 }),
  channelBand: Object.freeze({ near: 0.30, far: 3.6 }),
  // How much of the lava band is spent on the two channels rather than on the
  // pool's own shoreline (the pool also wears the crater's edge band).
  channelShare: 0.7,
  // Pieces sit at a landmark's foot — from its own footprint outwards this far
  // — and never inside the landmark itself: `inner` is the fraction of a
  // formation's radius that no debris may come within.
  formationBand: Object.freeze({ inner: 0.94, outer: 7 }),
  // Debris may nestle right against a medium rock, but not inside one.
  rockClearance: 0.35,
  // The ways through the sector stay open: the portal aprons, and the two
  // direct corridors from every gate (to the crater and to the sector centre).
  gateClearance: 4,
  routeClearance: 8,
  hexMargin: 5,
  // How the limited budget is spent. The four collection zones are the whole
  // layer; there is no "everywhere" zone, because debris everywhere is litter.
  zones: Object.freeze({
    'crater-edges': 0.28,
    'rock-formations': 0.22,
    'lava-channels': 0.20,
    'steep-slopes': 0.30,
  }),
  // Rejection-sampling budget per wanted piece, per zone.
  attemptFactor: 120,
  // How far an instance leans into the slope it stands on, and how deep it is
  // bedded so a chip sits *in* the ground instead of lying on top of it.
  alignToSlope: 0.45,
  sinkFactor: 0.24,
  sinkBase: 0.02,
});

/* ---- Geometry ------------------------------------------------------------ */

// The same five basalt tones of the shared volcanic palette
// (src/world/VolcanicMaterials.js) the formations and the medium rocks are cut
// from, so a chip reads as a piece of the cliff it fell off.
const DEBRIS_TONES = BASALT_TONES;

function rotateXZ(x, z, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - z * sin, z: x * sin + z * cos };
}

function randomTone(random, top = false) {
  const index = top
    ? Math.min(DEBRIS_TONES.length - 1, 2 + Math.floor(random() * 3))
    : Math.floor(random() * DEBRIS_TONES.length);
  return DEBRIS_TONES[index];
}

class DebrisGeometryBuilder {
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
      variantKind: variant.kind,
      variantShape: variant.masses[0].profile,
      featureType: 'small-volcanic-debris',
      surface: 'broken-volcanic-basalt',
      cut,
      static: true,
    };
    return geometry;
  }
}

/**
 * One faceted chip, in unit space: a short stack of rings, each wobbled per
 * side and per ring, closed by a broken cap and a buried bottom. Angles,
 * radii and the top break are seeded, so the same shape cut from a second seed
 * is genuinely a different piece of rubble rather than the same piece scaled.
 */
function appendDebrisMass(builder, mass, random) {
  const profile = DEBRIS_PROFILES[mass.profile];
  if (!profile) throw new RangeError(`Unknown debris profile: ${mass.profile}`);

  const sides = clampInt(mass.sides ?? 5, 4, 8);
  const yaw = mass.yaw ?? 0;
  const leanX = mass.leanX ?? 0;
  const leanZ = mass.leanZ ?? 0;
  const offsetX = mass.x ?? 0;
  const offsetZ = mass.z ?? 0;
  const width = Math.max(0.05, mass.width ?? 1);
  const depth = Math.max(0.05, mass.depth ?? 1);
  const height = Math.max(0.05, mass.height ?? 1);
  const phase = random() * TAU;
  // A chip is cut, not carved: the per-side teeth are deeper than a boulder's,
  // which is what makes a 0.3-unit stone still read as broken basalt.
  const angleJitter = Array.from({ length: sides }, () => (random() - 0.5) * 0.34);
  const facetScale = Array.from({ length: sides }, () => 0.80 + random() * 0.38);

  const rings = profile.map((level, ringIndex) => {
    const vertices = [];
    for (let side = 0; side < sides; side += 1) {
      const angle = phase + (side / sides) * TAU + angleJitter[side];
      const ringNoise = ringIndex === 0 ? 0 : (random() - 0.5) * 0.26;
      const scale = level.r * facetScale[side] * (1 + ringNoise);
      const local = rotateXZ(
        Math.cos(angle) * width * 0.5 * scale,
        Math.sin(angle) * depth * 0.5 * scale,
        yaw,
      );
      const topBreak = ringIndex === profile.length - 1 ? (random() - 0.5) * 0.20 : 0;
      vertices.push({
        x: offsetX + local.x + leanX * level.y,
        y: Math.max(0, level.y + topBreak) * height,
        z: offsetZ + local.z + leanZ * level.y,
      });
    }
    return vertices;
  });

  // Flat side facets, each toned on its own: the fracture faces of the piece.
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

  // A broken cap, offset towards wherever the piece leans.
  const topRing = rings.at(-1);
  const topCenter = {
    x: offsetX + leanX,
    y: height * (0.90 + random() * 0.12),
    z: offsetZ + leanZ,
  };
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    builder.triangle(topCenter, topRing[next], topRing[side], randomTone(random, true));
  }

  // A buried bottom closes the volume; every instance beds into the ground.
  const bottomCenter = { x: offsetX, y: 0, z: offsetZ };
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    builder.triangle(bottomCenter, rings[0][side], rings[0][next], DEBRIS_TONES[0]);
  }
}

/** One shared geometry of the collection, from one shape and one seed cut. */
export function createDebrisGeometry(variant, cut) {
  const random = makeRandom(((variant.seed ?? 0) ^ (cut ?? 0)) >>> 0);
  const builder = new DebrisGeometryBuilder();
  for (const mass of variant.masses) appendDebrisMass(builder, mass, random);
  return builder.build(`VolcanicDebrisGeometry_${variant.id}_${cut.toString(16)}`, variant, cut);
}

/**
 * The shared geometries of the layer, in a stable order, with the variant each
 * one was cut from. The builder reuses these instances for every piece, which
 * is what keeps a scatter of hundreds of chips at twelve draw calls.
 */
export function createDebrisGeometries(variants = DEBRIS_VARIANTS) {
  const records = [];
  variants.forEach((variant, variantIndex) => {
    variant.seeds.forEach((cut, cutIndex) => {
      records.push({
        variantIndex,
        cut,
        cutIndex,
        variantId: variant.id,
        variantKind: variant.kind,
        variantShape: variant.masses[0].profile,
        geometry: createDebrisGeometry(variant, cut),
      });
    });
  });
  return records;
}

/* ---- Where the debris goes ----------------------------------------------- */

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

/**
 * Everything the scatter must respect, measured once from the world as it is:
 * the sector's portals and their direct routes, the crater's rim, the six
 * landmark formations, the three molten surfaces with the shoreline the pool
 * actually has, and the medium rocks already standing in the sector.
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

  // The formations that actually exist are what the debris gathers around; the
  // authored layout is only the fallback when the caller has none.
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

  // The medium rocks of the sector, as circles: a chip may tumble right up
  // against one, but never sits buried inside it.
  const rockSource = options.rocks?.userData?.placements
    ?? (Array.isArray(options.rocks) ? options.rocks : []);
  const mediumRocks = rockSource.map((rock) => {
    const span = rock.span
      ?? Math.max(rock.scale?.x ?? 0, rock.scale?.z ?? 0);
    return { x: rock.x, z: rock.z, radius: Math.max(0.2, span * 0.5) };
  }).filter((rock) => Number.isFinite(rock.x) && Number.isFinite(rock.z));

  return { crater, pool, shoreline, channels, gates, formations, routes, mediumRocks };
}

/**
 * A tiny uniform grid, so minimum spacing and the per-cell cap are each one
 * lookup instead of a scan over everything already placed.
 */
function createPlacementGrid({ minSpacing, cell, cellMax }) {
  const spaceCell = Math.max(0.5, minSpacing);
  const buckets = new Map();
  const counts = new Map();
  const key = (a, b) => `${a},${b}`;
  return {
    tooClose(x, z, spacing) {
      const ix = Math.floor(x / spaceCell);
      const iz = Math.floor(z / spaceCell);
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
    cellFull(x, z) {
      return (counts.get(key(Math.floor(x / cell), Math.floor(z / cell))) ?? 0) >= cellMax;
    },
    add(point) {
      const bucketKey = key(Math.floor(point.x / spaceCell), Math.floor(point.z / spaceCell));
      const bucket = buckets.get(bucketKey);
      if (bucket) bucket.push(point);
      else buckets.set(bucketKey, [point]);
      const countKey = key(Math.floor(point.x / cell), Math.floor(point.z / cell));
      counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
    },
  };
}

/* Each zone sampler proposes one candidate; the shared gate below then decides
 * whether that candidate may exist at all. Samplers never inspect clearance
 * rules, so the four zones stay independent and readable. */

/** The crater's own edge: the rim band, inner wall and the first skirt. */
function sampleCraterEdge(random, terrain, model, settings) {
  const crater = model.crater;
  if (!crater) return null;
  const bearing = random() * TAU;
  const cos = Math.cos(bearing);
  const sin = Math.sin(bearing);
  const nominal = terrain.craterRimRadiusAt(cos * crater.rimRadius, sin * crater.rimRadius, crater);
  const rim = terrain.craterRimRadiusAt(cos * nominal, sin * nominal, crater);
  const u = between(random, settings.craterBand.inner, settings.craterBand.outer);
  const radius = rim * u;
  return { zone: 'crater-edges', x: crater.x + cos * radius, z: crater.z + sin * radius };
}

/** The foot of a large formation: where its own rock has shed its chips. */
function sampleRockFormation(random, terrain, model, settings) {
  if (model.formations.length === 0) return null;
  const formation = model.formations[Math.floor(random() * model.formations.length)];
  const bearing = random() * TAU;
  // Outside the landmark's own footprint, never inside it: rubble lies at the
  // base of the cliff, not in the middle of the rock.
  const distance = formation.radius + between(random, 0.4, settings.formationBand.outer);
  return {
    zone: 'rock-formations',
    x: formation.x + Math.cos(bearing) * distance,
    z: formation.z + Math.sin(bearing) * distance,
  };
}

/** The banks of the molten rock: mostly the two channels, then the pool. */
function sampleLavaChannel(random, terrain, model, settings) {
  const useChannel = random() < settings.channelShare;
  if (useChannel && model.channels.length > 0) {
    const channel = model.channels[Math.floor(random() * model.channels.length)];
    const sample = channel.samples[Math.floor(random() * channel.samples.length)];
    const side = random() < 0.5 ? -1 : 1;
    const halfWidth = side < 0 ? sample.left : sample.right;
    const offset = halfWidth + between(random, settings.channelBand.near, settings.channelBand.far);
    return {
      zone: 'lava-channels',
      x: sample.x + sample.nx * offset * side,
      z: sample.z + sample.nz * offset * side,
    };
  }
  if (!model.pool || !model.shoreline) return null;
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
  return { zone: 'lava-channels', x: model.pool.x + cos * distance, z: model.pool.z + sin * distance };
}

/** Ground steep enough to hold scree, biased onto the massif's own flanks. */
function sampleSteepSlope(random, terrain, model, settings) {
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
      zone: 'steep-slopes',
      x: model.crater.x + cos * rim * u,
      z: model.crater.z + sin * rim * u,
    };
  }
  const reach = terrain.radius * 0.86;
  return { zone: 'steep-slopes', x: between(random, -reach, reach), z: between(random, -reach, reach) };
}

const ZONE_SAMPLERS = Object.freeze({
  'crater-edges': sampleCraterEdge,
  'rock-formations': sampleRockFormation,
  'lava-channels': sampleLavaChannel,
  'steep-slopes': sampleSteepSlope,
});

/** The zones the scatter is drawn from, in the order the budget is spent. */
export const DEBRIS_ZONES = Object.freeze(Object.keys(ZONE_SAMPLERS));

/**
 * The shared gate every candidate passes before it becomes a chip: inside the
 * sector with a margin, out of every portal apron and direct gate route, off
 * the lava, off the crater floor, at the skirt of a landmark rather than
 * inside it, clear of the medium rocks, on ground gentler than the walkable
 * limit, not crowding the cell it lands in and at least `minSpacing` away from
 * every piece already placed.
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
  // Never on the molten rock, and never so close that a chip reads as part of
  // the lava's own chilled margin. (No lava at all leaves every band moot.)
  if (Number.isFinite(lavaDistance) && lavaDistance < settings.lavaBand.near) return null;

  if (model.crater) {
    const rim = terrain.craterRimRadiusAt(x - model.crater.x, z - model.crater.z, model.crater);
    const u = Math.hypot(x - model.crater.x, z - model.crater.z) / rim;
    // The crater's floor stays a walking floor: only the band that hugs the
    // pool is allowed inside it.
    if (u < settings.craterFloorClear && lavaDistance > settings.lavaBand.far) return null;
  }

  for (const formation of model.formations) {
    const distance = Math.hypot(x - formation.x, z - formation.z);
    if (distance < formation.radius * settings.formationBand.inner) return null;
  }

  for (const rock of model.mediumRocks) {
    if (Math.hypot(x - rock.x, z - rock.z) < rock.radius + settings.rockClearance) return null;
  }

  // The low-density guarantee: no cell may collect more than its cap, however
  // the sampler happened to draw.
  if (grid.cellFull(x, z)) return null;

  const slopeDeg = Math.atan(terrain.slopeAt(x, z)) * DEG;
  if (slopeDeg > settings.slope.maxDeg) return null;
  if (candidate.zone === 'steep-slopes' && slopeDeg < settings.slope.minDeg) return null;

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

const ANCHOR_ZONES = Object.freeze(['crater-edges', 'rock-formations', 'lava-channels']);

/**
 * The layer's settings: the defaults, plus whatever `mapConfig.volcanicDebris`
 * overrides. The nested bands are merged one by one, so retuning the lava band
 * never silently drops the crater band beside it.
 */
export function resolveVolcanicDebrisSettings(override = null) {
  const settings = {
    ...VOLCANIC_DEBRIS_DEFAULTS,
    ...(override && typeof override === 'object' ? override : {}),
  };
  for (const key of [
    'size', 'heightFactor', 'slope', 'craterBand', 'lavaBand', 'channelBand',
    'formationBand', 'cluster', 'zones',
  ]) {
    settings[key] = { ...VOLCANIC_DEBRIS_DEFAULTS[key], ...(settings[key] ?? {}) };
  }
  return settings;
}

/**
 * Plan the whole layer without building a single mesh: a seeded, weighted
 * scatter whose every number — position, size, yaw, tilt, shape — is decided
 * here, so the plan *is* the layer and rebuilding it always reproduces it.
 */
export function planVolcanicDebrisPlacements(terrain, config = {}, options = {}) {
  if (!terrain || terrain.sectorId !== 'HEX_SE') return null;
  const override = config.volcanicDebris;
  if (config.volcanicDebrisEnabled === false || override === false || override === null) return null;

  const settings = resolveVolcanicDebrisSettings(override);
  const zones = settings.zones;
  const variants = options.variants ?? DEBRIS_VARIANTS;
  const geometryRecords = variants.flatMap((variant, variantIndex) => (
    variant.seeds.map((cut, cutIndex) => ({ variantIndex, cut, cutIndex, variantId: variant.id }))
  ));
  const geometryCount = geometryRecords.length;

  const random = makeRandom(settings.seed >>> 0);
  const model = buildClearanceModel(terrain, config, options);
  const grid = createPlacementGrid({
    minSpacing: settings.minSpacing,
    cell: Math.max(1, settings.cluster.cell),
    cellMax: Math.max(1, Math.round(settings.cluster.max)),
  });
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
    placement.tiltX = between(random, -0.16, 0.16);
    placement.tiltZ = between(random, -0.16, 0.16);
    placement.scale = {
      x: size * between(random, 0.82, 1.20),
      y: size * between(random, settings.heightFactor.min, settings.heightFactor.max),
      z: size * between(random, 0.80, 1.22),
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
  // Chips that lie on ground flat enough to walk: these are the ones the
  // anchors are allowed to put there, and no others exist.
  const flatCount = placements.filter((placement) => placement.slopeDeg < settings.slope.minDeg).length;
  // How much of the sector's own ground the layer touches, in 5-unit cells.
  const cells = new Set();
  for (const placement of placements) {
    cells.add(`${Math.floor(placement.x / settings.cluster.cell)},${Math.floor(placement.z / settings.cluster.cell)}`);
  }

  const stats = {
    count: placements.length,
    variantCount: variants.length,
    geometryCount,
    zoneCounts: { ...zoneCounts },
    anchorShare,
    slopeShare,
    flatCount,
    flatShare: placements.length === 0 ? 0 : flatCount / placements.length,
    cellsUsed: cells.size,
    cellShare: cells.size / (sectorArea / settings.cluster.cell ** 2),
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
export function debrisGeometries() {
  sharedGeometries ??= createDebrisGeometries();
  return sharedGeometries;
}

/**
 * Build the small debris layer of HEX_SE and return it as one group of
 * instanced meshes, or null when the sector is not the volcanic one or the
 * layer is switched off. Positions are sector-local (the caller puts the group
 * at the sector's centre), exactly like the terrain, the lava and the rocks.
 *
 * The six large formations are passed in as `options.formations` and the
 * medium rocks as `options.rocks`, so the debris gathers around the rocks that
 * actually exist rather than around the authored layout; when they are absent
 * the plan simply has fewer things to avoid.
 */
export function buildVolcanicDebris(terrain, config = {}, options = {}) {
  const plan = planVolcanicDebrisPlacements(terrain, config, options);
  if (!plan || plan.placements.length === 0) return null;

  const geometries = options.geometries ?? debrisGeometries();
  const group = new THREE.Group();
  group.name = 'VolcanicDebris_HEX_SE';

  // One material for every chip in the sector, and one geometry per shape cut:
  // the whole layer is twelve shared meshes drawn as instances.
  const material = createVolcanicPropMaterial('SmallVolcanicDebrisBasalt_HEX_SE', {
    roughness: 0.98,
    metalness: 0.02,
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
    mesh.name = `DebrisLayer_${record.variantId}_${record.cutIndex}_HEX_SE`;
    mesh.count = bucket.length;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      sectorId: 'HEX_SE',
      variantId: record.variantId,
      variantKind: record.variantKind,
      variantShape: record.variantShape,
      instanceCount: bucket.length,
      featureType: 'small-volcanic-debris-instances',
      static: true,
      collidable: false,
    };

    bucket.forEach((placement, instance) => {
      // Measure the instance against the shape it was dealt, so the amount it
      // is bedded into the ground follows the piece's real height.
      const span = Math.max(placement.scale.x, placement.scale.z) * unitSpan;
      const height = placement.scale.y * unitHeight;
      placement.span = span;
      placement.height = height;
      placement.sink = plan.settings.sinkBase + height * plan.settings.sinkFactor;
      // Bed the chip into the ground it rests on, leaning part of the way into
      // the slope so it sits in the scree instead of floating on it.
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
      // neighbouring chips of the same shape never read as one repeated prop.
      const brightness = 0.82 + ((instance * 29 + index * 13) % 26) / 100;
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
    featureType: 'small-volcanic-debris-layer',
    debrisCount: plan.placements.length,
    variantCount: plan.variantCount,
    geometryCount: plan.geometryCount,
    meshCount: meshes.length,
    instanced: true,
    static: true,
    collidable: false,
    animates: false,
    zoneCounts: { ...plan.zoneCounts },
    stats,
    placements: plan.placements,
  };

  return group;
}
