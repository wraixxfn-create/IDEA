import * as THREE from 'three';
import { lavaFlowSampleAt } from './LavaFlow.js';
import { measureLavaPoolShoreline } from './LavaPool.js';

/**
 * CooledCrust — the crust the existing lava of HEX_SE has left on the ground
 * around it.
 *
 * The sector already carries its molten rock: one crater pool
 * (src/world/LavaPool.js), one main outlet and one narrower branch
 * (src/world/LavaFlow.js). What the ground *beside* them still lacked is the
 * third state of a lava field: the crust the lava chilled into. Where a flow
 * stops, its skin goes black, breaks into plates and keeps a dull red heat
 * under the cracks nearest the molten rock. That is what this module puts on
 * the rock immediately around the pool and both channels — and nothing else.
 *
 * Four decisions shape it.
 *
 * 1. **It is a skin on ground that already exists, not new ground.** The crust
 *    never moves a vertex: `planCooledCrust` measures the lava that is already
 *    baked and `writeCooledCrustAttribute` only fills a four-float attribute on
 *    the terrain's own lattice — coverage, heat and the crust pattern's UV. The
 *    heights, the collision surface, the slope budget, the crater, the vents,
 *    the gate aprons and the sector statistics are bit-for-bit what they were.
 *    No mesh, no props, no rocks and no draw call are added either: the sector
 *    floor keeps its single mesh and its single material.
 *
 * 2. **It belongs to the lava, so it is measured from the lava.** The band is
 *    solved against the three surfaces that are actually there: the pool's own
 *    shoreline (the same bearing-by-bearing contour the sheet is built on), and
 *    each channel's spine and its local half-width — so a wide bend of the main
 *    flow wears a wide crust, the slim branch wears a slim one, and the crust
 *    stops where the toe of a channel pinches out. Every margin is then walked
 *    by noise at two scales and broken into irregular plates, so no stretch of
 *    crust is a band of constant width and some stretches are bare rock.
 *
 * 3. **The transition is a sequence.** Out of the lava the eye reads: the
 *    molten sheet → a solid black margin at the waterline, still holding a dull
 *    red heat in its cracks → crust that breaks up into irregular plates as it
 *    cools → plates scattered over the basalt → the sector's ordinary gray rock.
 *    Coverage carries that sequence in the attribute; the heat channel carries
 *    the red, and it dies out within a few units of the lava, so the crust is
 *    warm where it is young and cold where it is old.
 *
 * 4. **The detail is a tile, because a lattice cannot carry it.** The baked
 *    ground is 12,481 vertices over a 220-unit hexagon: about one vertex every
 *    3.4 units, far too coarse for plates and fissures. So the fine skin is a
 *    small seamless pair of procedural tiles — a dark albedo of cooled plates
 *    split by cracked sections, and a heat map that is black everywhere except
 *    those cracks — sampled in the sector's own material through a four-line
 *    shader patch, and blended by the per-vertex coverage.
 *
 * Deliberately absent, because this step is only the crust: no animation (no
 * clock, no uniform is ever rewritten), no light source, no particles, no
 * smoke, no damage, no collider and nothing in the world update loop. The
 * attribute is written once, at bake time.
 */

/* ---- Small maths -------------------------------------------------------- */

function clamp01(value) {
  return value < 0 ? 0 : (value > 1 ? 1 : value);
}

function smoothStep(value, start, end) {
  if (end <= start) return value >= end ? 1 : 0;
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
}

const mix = (a, b, t) => a + (b - a) * t;

/* ---- Deterministic value noise -----------------------------------------
 * The same hash family the terrain and the pool bake with, kept local so the
 * crust is seeded, stable across machines and independent of both.
 */

function hash2d(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = quintic(x - x0);
  const fy = quintic(y - y0);
  const n00 = hash2d(x0, y0, seed);
  const n10 = hash2d(x0 + 1, y0, seed);
  const n01 = hash2d(x0, y0 + 1, seed);
  const n11 = hash2d(x0 + 1, y0 + 1, seed);
  const top = n00 + (n10 - n00) * fx;
  const bottom = n01 + (n11 - n01) * fx;
  return top + (bottom - top) * fy;
}

function fbm(x, y, seed, octaves, gain, lacunarity) {
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  let normalisation = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += amplitude * valueNoise(x * frequency, y * frequency, seed + octave * 1013);
    normalisation += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return normalisation > 0 ? total / normalisation : 0;
}

function wrapCell(value, period) {
  const wrapped = value % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/** Value noise whose lattice wraps every `period` cells, so a tile is seamless. */
function tileableNoise(x, y, period, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = quintic(x - x0);
  const fy = quintic(y - y0);
  const xa = wrapCell(x0, period);
  const xb = wrapCell(x0 + 1, period);
  const ya = wrapCell(y0, period);
  const yb = wrapCell(y0 + 1, period);
  const n00 = hash2d(xa, ya, seed);
  const n10 = hash2d(xb, ya, seed);
  const n01 = hash2d(xa, yb, seed);
  const n11 = hash2d(xb, yb, seed);
  const top = n00 + (n10 - n00) * fx;
  const bottom = n01 + (n11 - n01) * fx;
  return top + (bottom - top) * fy;
}

function tileableFbm(x, y, period, seed, octaves = 3, gain = 0.5, lacunarity = 2) {
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  let normalisation = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += amplitude * tileableNoise(x * frequency, y * frequency, period * frequency, seed + octave * 1013);
    normalisation += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return normalisation > 0 ? total / normalisation : 0;
}

/* ---- The crust layout --------------------------------------------------
 * Plain data, in sector-local units (the hexagon has radius 220). Reaches,
 * bands and feathers are distances; the pool's own heights are measured from
 * its waterline and a channel's from the surface it carries, so the crust
 * follows the lava's level rather than the crater's walls.
 */

export const COOLED_CRUST_DEFAULTS = Object.freeze({
  id: 'cooled-crust-hex-se',
  // The main pool's shore: the widest crust in the sector, because the pool is
  // the widest lava. `reach` is the nominal crawl out over the crater floor,
  // `inner` the short overlap that runs *under* the sheet so no bare basalt
  // ever shows at the waterline, and the height band keeps the crust on the
  // pool's own level — it covers the cooled bank the pool threw up and dies out
  // before it could climb the crater wall.
  pool: Object.freeze({
    reach: 13,
    inner: 2.4,
    lobes: 0.55,
    scallop: 0.3,
    heightBand: 2,
    heightFeather: 3.2,
    heatReach: 6.5,
  }),
  // The main channel: its crust is scaled by the local half-width, so the wide
  // bends carry a wide margin and the pinches a narrow one.
  channel: Object.freeze({
    reach: 3.2,
    reachPerWidth: 0.75,
    inner: 1,
    lobes: 0.45,
    scallop: 0.3,
    heightBand: 1.1,
    heightFeather: 2.4,
    heatReach: 3.6,
  }),
  // The slim branch: the same recipe, a smaller crust.
  branch: Object.freeze({
    reach: 1.6,
    reachPerWidth: 0.95,
    inner: 0.7,
    lobes: 0.45,
    scallop: 0.32,
    heightBand: 0.9,
    heightFeather: 2,
    heatReach: 2.5,
  }),
  // The crust's own break-up at ground scale. Solid black at the waterline,
  // then irregular plates: a coarse plate field and a finer one that breaks the
  // plates' edges, separated by creases of bare rock. `blendInner` / `blendOuter`
  // say over what run the crust stops being a sheet and starts being plates.
  plates: Object.freeze({
    coarseScale: 13.5,
    fineScale: 5.4,
    threshold: 0.3,
    blendInner: 0.9,
    blendOuter: 7.5,
  }),
  // Long bare stretches: some shores the lava never quite covered.
  gaps: Object.freeze({ scale: 31, strength: 0.55 }),
  // How patchy the red heat is, and how far it wanders off the lava's edge.
  heat: Object.freeze({ patch: 0.5, wander: 0.4 }),
  seedOffset: 0xc001ed,
});

/** The look of the crust: two tiles and five numbers, all from configuration. */
export const COOLED_CRUST_MATERIAL_DEFAULTS = Object.freeze({
  // The albedo tile is dark enough to be the crust's own colour, so the
  // material colour only has to say how much of it the sector's light keeps.
  color: 0xffffff,
  // Multiplied into the crust where it is still warm: reds kept, blues dropped,
  // so a hot patch reads as heat-stained rock rather than as a lamp.
  warmth: 0xffa070,
  // The heat itself: what the cracks emit, and how much.
  emissive: 0xff4d10,
  emissiveIntensity: 0.5,
  // Cooled crust is glassier than ash: it catches the sun where the rock does not.
  roughness: 0.74,
  crustTextureSize: 256,
  // The tile repeats every `crustTile` sector units, split into `crustCells`
  // plates across — plates of a couple of units, the size a lava skin breaks at.
  crustTile: 12,
  crustCells: 5,
  crustSeed: 0xc001ed5,
});

/** Merge the plain-data layout: `config.cooledCrust` overrides, defaults win. */
function resolveCrustSettings(override) {
  const base = COOLED_CRUST_DEFAULTS;
  if (!override) return base;
  return {
    id: override.id ?? base.id,
    pool: { ...base.pool, ...(override.pool ?? {}) },
    channel: { ...base.channel, ...(override.channel ?? {}) },
    branch: { ...base.branch, ...(override.branch ?? {}) },
    plates: { ...base.plates, ...(override.plates ?? {}) },
    gaps: { ...base.gaps, ...(override.gaps ?? {}) },
    heat: { ...base.heat, ...(override.heat ?? {}) },
    seedOffset: override.seedOffset ?? base.seedOffset,
  };
}

/** The crust's material settings, resolved from the world configuration. */
export function resolveCooledCrustMaterial(config = {}) {
  const base = COOLED_CRUST_MATERIAL_DEFAULTS;
  return {
    color: config.cooledCrustColor ?? base.color,
    warmth: config.cooledCrustWarmth ?? base.warmth,
    emissive: config.cooledCrustEmissive ?? base.emissive,
    emissiveIntensity: config.cooledCrustEmissiveIntensity ?? base.emissiveIntensity,
    roughness: config.cooledCrustRoughness ?? base.roughness,
    crustTextureSize: Math.max(64, Math.round(config.cooledCrustTextureSize ?? base.crustTextureSize)),
    crustTile: Math.max(2, config.cooledCrustTile ?? base.crustTile),
    crustCells: Math.max(2, Math.round(config.cooledCrustCells ?? base.crustCells)),
    crustSeed: config.cooledCrustSeed ?? base.crustSeed,
  };
}

/* ---- Planning ----------------------------------------------------------
 * The crust is measured from the lava the sector already carries, so it can
 * only be planned once the pool's bed and both channels are baked.
 */

/** The pool's shoreline radius on one bearing, from the measured contour. */
function shoreRadiusAt(shoreline, dx, dz) {
  const count = shoreline.radii.length;
  const bearing = (Math.atan2(dz, dx) + Math.PI * 2) % (Math.PI * 2);
  const at = (bearing / (Math.PI * 2)) * count;
  const i = Math.floor(at);
  return mix(shoreline.radii[i % count], shoreline.radii[(i + 1) % count], at - i);
}

/**
 * Plan the cooled crust of a baked volcanic terrain, or `null` when there is
 * nothing to crust over: no pool, no sector, or the switch turned off.
 *
 * The plan is plain data plus the measurements the crust cannot make up: the
 * pool's own shoreline contour and the two channel spines. `cooledCrustFieldAt`
 * then answers for any point of the sector from that plan alone.
 */
export function planCooledCrust(terrain, config = {}) {
  if (!terrain || terrain.sectorId !== 'HEX_SE') return null;
  if (config.cooledCrustEnabled === false) return null;
  const override = config.cooledCrust;
  if (override === false || override === null) return null;
  const pool = terrain.lavaPool;
  if (!pool) return null;
  // The shoreline the sheet is actually built on: once an outlet is open, the
  // flow keeps the contour it measured on the closed pool, and so does the crust.
  const shoreline = terrain.lavaFlow?.sourceShoreline ?? measureLavaPoolShoreline(terrain, pool);
  if (!shoreline?.radii?.length) return null;

  const basinCrusts = (terrain.lavaBasins ?? []).map(({ pool }) => planCooledCrust({
    sectorId: terrain.sectorId, lavaPool: pool,
    heightAt: (x, z) => terrain.heightAt(x, z),
  }, config)).filter(Boolean);
  const settings = resolveCrustSettings(override);
  const material = resolveCooledCrustMaterial(config);
  const seed = (0xc001ed00 ^ Math.imul(settings.seedOffset | 0, 0x9e3779b1)) >>> 0;

  const channels = [];
  if (terrain.lavaFlow) {
    channels.push(Object.freeze({ kind: 'main', flow: terrain.lavaFlow, ...settings.channel }));
  }
  if (terrain.lavaSecondaryFlow) {
    channels.push(Object.freeze({ kind: 'branch', flow: terrain.lavaSecondaryFlow, ...settings.branch }));
  }

  // One bound for the whole crust, so a vertex on the far side of the sector is
  // rejected with four comparisons instead of a walk down two channel spines.
  const bounds = new THREE.Box2();
  const poolReach = settings.pool.reach * (1 + settings.pool.lobes + settings.pool.scallop);
  const poolSpan = Math.max(...shoreline.radii) + poolReach + settings.pool.inner + 2;
  bounds.expandByPoint(new THREE.Vector2(pool.x - poolSpan, pool.z - poolSpan));
  bounds.expandByPoint(new THREE.Vector2(pool.x + poolSpan, pool.z + poolSpan));
  for (const channel of channels) {
    const reach = channel.reach + channel.reachPerWidth * channel.flow.width;
    for (const sample of channel.flow.samples) {
      const span = Math.max(sample.left, sample.right) + reach + 2;
      bounds.expandByPoint(new THREE.Vector2(sample.x - span, sample.z - span));
      bounds.expandByPoint(new THREE.Vector2(sample.x + span, sample.z + span));
    }
  }

  for (const basin of basinCrusts) bounds.union(basin.bounds);

  return Object.freeze({
    basinCrusts: Object.freeze(basinCrusts),
    id: settings.id,
    seed,
    settings,
    material,
    shoreline,
    bounds,
    pool: Object.freeze({
      id: pool.id,
      x: pool.x,
      z: pool.z,
      level: pool.level,
      span: poolSpan,
      spanSq: poolSpan * poolSpan,
      ...settings.pool,
    }),
    channels: Object.freeze(channels),
    // What the crust is measured from, so a reader can see it adds no lava.
    sources: Object.freeze([
      pool.id,
      ...channels.map((channel) => channel.flow.id),
      ...basinCrusts.map((basin) => basin.pool.id),
    ]),
  });
}

/* ---- The field ---------------------------------------------------------
 * Coverage and heat at any point of the sector, both exactly zero away from
 * the lava. This is the whole of the crust's geography: the pool's shore, the
 * two channels, and the noise that breaks both into irregular plates.
 */

/**
 * Irregular plates at ground scale: a coarse cell field and a finer one that
 * breaks the plates' own edges. Ridged noise folded about zero gives crease
 * lines, and inverting it gives the plates between them — so the crust covers
 * whole plates and leaves bare rock in the creases, at two sizes at once.
 */
function plateFieldAt(x, z, plates, seed) {
  const coarse = fbm(x / plates.coarseScale + 11.3, z / plates.coarseScale - 4.7, seed + 71, 2, 0.5, 2);
  const fine = fbm(x / plates.fineScale - 7.1, z / plates.fineScale + 2.9, seed + 353, 2, 0.5, 2);
  // Either scale can cut a crease: the whole plate field is the highest crest
  // line through the point, so plates break at two sizes at once.
  const ridged = Math.max(
    Math.pow(1 - Math.abs(coarse), 3.2),
    Math.pow(1 - Math.abs(fine), 3) * 0.85,
  );
  return smoothStep(1 - ridged, plates.threshold - 0.02, plates.threshold + 0.22);
}

/** Long bare stretches: how much of a shore the lava never quite covered. */
function gapFieldAt(x, z, gaps, seed) {
  const drift = fbm(x / gaps.scale - 3.4, z / gaps.scale + 8.8, seed + 977, 3, 0.5, 2);
  return 1 - gaps.strength * smoothStep(drift, 0.05, 0.62);
}

/** Patchy heat: the red that survives under the cracks nearest the lava. */
function heatFieldAt(x, z, seed) {
  return clamp01(0.62 + 0.5 * fbm(x * 0.061 - 5.5, z * 0.061 + 3.3, seed + 1229, 2, 0.5, 2));
}

/**
 * The crust's two shares at a sector-local point:
 *
 *   • `coverage` — how much of the ground here is cooled crust rather than the
 *     sector's ordinary basalt. 1 at the waterline, breaking into plates and
 *     then out to zero over the band's own reach.
 *   • `heat` — how much dull red the crust still holds. Strongest against the
 *     lava, gone within a few units, and patchy so the glow lies in areas
 *     rather than in a ring.
 *
 * Both are exactly zero outside the crust's bound, so the rest of HEX_SE keeps
 * the rock it was baked with.
 */
export function cooledCrustFieldAt(x, z, height, crust) {
  if (!crust) return { coverage: 0, heat: 0 };
  const bounds = crust.bounds;
  if (x < bounds.min.x || x > bounds.max.x || z < bounds.min.y || z > bounds.max.y) {
    return { coverage: 0, heat: 0 };
  }
  const { settings, seed } = crust;
  let coverage = 0;
  let heat = 0;

  // --- The pool's shore -------------------------------------------------
  const pool = crust.pool;
  const dx = x - pool.x;
  const dz = z - pool.z;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq < pool.spanSq) {
    const distance = Math.sqrt(distanceSq);
    const shore = shoreRadiusAt(crust.shoreline, dx, dz);
    const outside = distance - shore;
    if (outside > -pool.inner && outside < pool.reach * (1 + pool.lobes + pool.scallop)) {
      // The margin's own reach on this bearing: whole lobes of crust pushing
      // out over the crater floor, and a finer scallop breaking them up.
      const lobe = fbm(x * 0.041 + 6.2, z * 0.041 - 9.1, seed + 131, 2, 0.5, 2);
      const scallop = fbm(x * 0.128 - 2.7, z * 0.128 + 5.4, seed + 613, 2, 0.5, 2);
      const reach = Math.max(2, pool.reach * (1 + pool.lobes * lobe + pool.scallop * scallop));
      const spread = 1 - smoothStep(outside, reach * 0.55, reach * 0.98);
      // Under the sheet the crust is hidden anyway; it fades out there so the
      // pool's own bed stays the pool's own bed.
      const under = 1 - smoothStep(-outside, pool.inner * 0.35, pool.inner);
      // The crust belongs to the waterline: it wears the cooled bank the pool
      // threw up and stops before the crater wall.
      const rise = 1 - smoothStep(height - pool.level, pool.heightBand,
        pool.heightBand + pool.heightFeather);
      const plates = plateFieldAt(x, z, settings.plates, seed);
      const gaps = gapFieldAt(x, z, settings.gaps, seed);
      const broken = smoothStep(outside, settings.plates.blendInner, settings.plates.blendOuter * 0.7);
      const surface = spread * under * rise;
      const local = surface * mix(1, plates * gaps, broken);
      if (local > coverage) {
        coverage = local;
        const heatWobble = 1 + settings.heat.wander
          * fbm(x * 0.052 + 1.9, z * 0.052 - 6.6, seed + 419, 2, 0.5, 2);
        const glow = 1 - smoothStep(outside, pool.heatReach * 0.2, pool.heatReach * heatWobble);
        heat = clamp01(glow * mix(1, settings.heat.patch + heatFieldAt(x, z, seed), 0.7) * rise
          * clamp01(local * 2.2));
      }
    }
  }

  // --- The two channels -------------------------------------------------
  for (const channel of crust.channels) {
    const sample = lavaFlowSampleAt(x, z, channel.flow);
    if (!sample) continue;
    const outside = sample.distance - sample.halfWidth;
    const reach = Math.max(1.2, channel.reach + channel.reachPerWidth * sample.halfWidth * 2)
      * (1 + channel.lobes * fbm(x * 0.055 - 4.4, z * 0.055 + 7.7, seed + 271, 2, 0.5, 2)
        + channel.scallop * fbm(x * 0.17 + 9.2, z * 0.17 - 3.1, seed + 853, 2, 0.5, 2));
    if (outside >= reach || outside <= -channel.inner) continue;
    const spread = 1 - smoothStep(outside, reach * 0.5, reach * 0.96);
    const under = 1 - smoothStep(-outside, channel.inner * 0.3, channel.inner);
    const rise = 1 - smoothStep(height - sample.y, channel.heightBand,
      channel.heightBand + channel.heightFeather);
    const plates = plateFieldAt(x, z, settings.plates, seed + 17);
    const gaps = gapFieldAt(x, z, settings.gaps, seed + 29);
    const broken = smoothStep(outside, settings.plates.blendInner * 0.7, settings.plates.blendOuter * 0.75);
    const surface = spread * under * rise;
    const local = surface * mix(1, plates * gaps, broken);
    if (local > coverage) {
      coverage = local;
      const heatWobble = 1 + settings.heat.wander
        * fbm(x * 0.07 - 8.2, z * 0.07 + 4.4, seed + 577, 2, 0.5, 2);
      const glow = 1 - smoothStep(outside, channel.heatReach * 0.18, channel.heatReach * heatWobble);
      heat = clamp01(glow * mix(1, settings.heat.patch + heatFieldAt(x, z, seed + 43), 0.7) * rise
        * clamp01(local * 2.2));
    }
  }

  for (const basin of crust.basinCrusts ?? []) {
    const field = cooledCrustFieldAt(x, z, height, basin);
    if (field.coverage > coverage) {
      coverage = field.coverage;
      heat = field.heat;
    }
  }
  return { coverage: clamp01(coverage), heat: clamp01(heat) };
}

/* ---- The attribute -----------------------------------------------------
 * Four floats per lattice vertex: coverage, heat, and the crust tile's UV in
 * the same world-space projection the lava sheets use, so the pattern never
 * jumps orientation where the crust meets the molten rock.
 */

const CRUST_UV_ANGLE = 0.37;
const CRUST_UV_COS = Math.cos(CRUST_UV_ANGLE);
const CRUST_UV_SIN = Math.sin(CRUST_UV_ANGLE);

/**
 * Bake the crust onto the terrain's own lattice. Nothing else is touched: the
 * heights, the colours, the normals and the index buffer are exactly what the
 * bake before this produced.
 *
 * Returns the attribute plus the numbers a caller (or a test) reasons about:
 * how many vertices the crust reached, what share of the sector that is, and
 * how hot the hottest point of it is.
 */
export function writeCooledCrustAttribute(terrain, crust = terrain?.cooledCrust ?? null) {
  if (!terrain || !crust) return null;
  const { positions, heights, vertexCount } = terrain;
  const tile = Math.max(2, crust.material.crustTile);
  const array = new Float32Array(vertexCount * 4);
  let vertices = 0;
  let coverageTotal = 0;
  let hottest = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = positions[v * 3];
    const z = positions[v * 3 + 2];
    const field = cooledCrustFieldAt(x, z, heights[v], crust);
    const offset = v * 4;
    array[offset] = field.coverage;
    array[offset + 1] = field.heat;
    array[offset + 2] = (x * CRUST_UV_COS - z * CRUST_UV_SIN) / tile;
    array[offset + 3] = (x * CRUST_UV_SIN + z * CRUST_UV_COS) / tile;
    if (field.coverage > 0.02) {
      vertices += 1;
      coverageTotal += field.coverage;
    }
    if (field.heat > hottest) hottest = field.heat;
  }
  const attribute = new THREE.BufferAttribute(array, 4);
  attribute.name = 'aCooledCrust';
  return {
    attribute,
    array,
    vertices,
    share: vertices / vertexCount,
    meanCoverage: vertices > 0 ? coverageTotal / vertices : 0,
    hottest,
  };
}

/* ---- The crust tile ----------------------------------------------------
 * A small seamless pair: cooled plates of black basalt split by cracked
 * sections, and the heat that still sits in those cracks. Two textures from
 * one pass, because the pattern is one pattern — the albedo says what the
 * crust looks like and the heat map says which of its cracks are still warm.
 */

/** Where a plate's own point sits inside cell (cx, cy) of a wrapped grid. */
function platePoint(cx, cy, seed) {
  return {
    x: cx + 0.5 + hash2d(cx, cy, seed) * 0.38,
    y: cy + 0.5 + hash2d(cx, cy, seed + 7919) * 0.38,
  };
}

/** Nearest and second-nearest plate point of a wrapped cell grid. */
function plateDistances(x, y, cells, seed) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let first = Infinity;
  let second = Infinity;
  let ownerX = 0;
  let ownerY = 0;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const gx = wrapCell(cx + ox, cells);
      const gy = wrapCell(cy + oy, cells);
      const point = platePoint(gx, gy, seed);
      const dx = x - (point.x + (cx + ox - gx));
      const dy = y - (point.y + (cy + oy - gy));
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < first) {
        second = first;
        first = distance;
        ownerX = gx;
        ownerY = gy;
      } else if (distance < second) {
        second = distance;
      }
    }
  }
  return { first, second, ownerX, ownerY };
}

const CRUST_CRACK_DEEP = [9, 8, 10];       // the fissure between plates: deepest black
const CRUST_PLATE_BLACK = [20, 19, 22];    // a plate that has chilled right through
const CRUST_PLATE_COOL = [34, 35, 41];     // a younger plate: glassy, faintly blue
const CRUST_PLATE_ASH = [56, 52, 47];      // an old plate dusted with ash
const CRUST_HEAT_STAIN = [84, 32, 20];     // dull red where the crust is still warm
const CRUST_HEAT_CRACK = [214, 74, 26];    // what a warm crack emits
const CRUST_HEAT_GLOW = [96, 28, 12];      // the broad warmth under a hot plate

/**
 * Build the crust's two tiles: a seamless square of cooled plates and the heat
 * map that goes with it. Every texel of the albedo is the crust at full
 * strength; the per-vertex coverage decides how much of the sector's basalt is
 * left showing through, and the per-vertex heat decides how much of the heat
 * map glows.
 */
export function createCooledCrustTextures(settings = {}) {
  const resolved = { ...COOLED_CRUST_MATERIAL_DEFAULTS, ...settings };
  const size = Math.max(64, Math.round(resolved.crustTextureSize));
  const cells = Math.max(2, Math.round(resolved.crustCells));
  const fineCells = Math.max(3, Math.round(cells * 2.7));
  const seed = resolved.crustSeed ?? COOLED_CRUST_MATERIAL_DEFAULTS.crustSeed;
  const albedo = new Uint8Array(size * size * 4);
  const heat = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px / size) * cells;
      const y = (py / size) * cells;
      const fx = (px / size) * fineCells;
      const fy = (py / size) * fineCells;

      // 1. The plates, and the cracks between them: the difference between the
      //    distance to this plate's own point and to the next one along is zero
      //    exactly on a plate boundary.
      const major = plateDistances(x, y, cells, seed);
      const crackMajor = 1 - smoothStep(major.second - major.first, 0.03, 0.1);
      // 2. Cracked sections *inside* the plates: a finer plate field, kept only
      //    where this plate's own hash says it fractured as it cooled, so some
      //    plates are whole and some are broken through.
      const fine = plateDistances(fx, fy, fineCells, seed + 6151);
      const fractured = smoothStep(0.5 + 0.5 * hash2d(major.ownerX, major.ownerY, seed + 3313), 0.42, 0.72);
      const crackFine = (1 - smoothStep(fine.second - fine.first, 0.018, 0.062)) * fractured;
      const crack = clamp01(Math.max(crackMajor, crackFine * 0.85));

      // 3. Two slow fields: how weathered the plate is, and how much heat is
      //    still under it. Plus a fine grain so no plate is a flat tone.
      const tone = 0.5 + 0.5 * hash2d(major.ownerX, major.ownerY, seed + 1901);
      const weather = tileableFbm(x * 0.42 + 3.3, y * 0.42 - 1.7, cells, seed + 271, 3) * 0.5 + 0.5;
      const grain = tileableFbm(x * 2.6 - 5.1, y * 2.6 + 2.2, cells, seed + 907, 2) * 0.5 + 0.5;
      const warm = smoothStep(tileableFbm(x * 0.33 + 8.4, y * 0.33 - 4.9, cells, seed + 1301, 3) * 0.5 + 0.5,
        0.46, 0.92);

      // 4. The albedo: a black plate, cooled or ash-dusted, split by the
      //    deepest black of the fissures, stained dull red where it is warm.
      const plate = [0, 0, 0];
      for (let channel = 0; channel < 3; channel += 1) {
        const young = CRUST_PLATE_BLACK[channel]
          + (CRUST_PLATE_COOL[channel] - CRUST_PLATE_BLACK[channel]) * tone * 0.75;
        const weathered = young + (CRUST_PLATE_ASH[channel] - young) * smoothStep(weather, 0.35, 0.9) * 0.5;
        const stained = weathered + (CRUST_HEAT_STAIN[channel] - weathered) * warm * (0.3 + 0.45 * crack);
        plate[channel] = stained * (0.9 + 0.2 * grain);
      }
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = mix(plate[channel], CRUST_CRACK_DEEP[channel], crack * 0.85);
        albedo[offset + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
      albedo[offset + 3] = 255;

      // 5. The heat map: black rock almost everywhere, a dull red in the warm
      //    cracks and a broad faint glow under a hot plate. Subtle on purpose —
      //    this is a crust that is cooling, not a surface that is melting.
      const glow = warm * warm;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = CRUST_HEAT_CRACK[channel] * crack * glow * 0.55
          + CRUST_HEAT_GLOW[channel] * glow * (0.18 + 0.1 * grain);
        heat[offset + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
      heat[offset + 3] = 255;
    }
  }

  return { map: crustTexture(albedo, size, 'CooledCrustAlbedo'), heat: crustTexture(heat, size, 'CooledCrustHeat') };
}

function crustTexture(data, size, name) {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = name;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const cooledCrustTextureCache = new Map();

/** The crust's tile pair for a configuration, cached: one pair per look. */
export function cooledCrustTextures(config = {}) {
  const settings = resolveCooledCrustMaterial(config);
  const key = `${settings.crustTextureSize}|${settings.crustCells}|${settings.crustSeed}`;
  const cached = cooledCrustTextureCache.get(key);
  if (cached) return cached;
  const textures = createCooledCrustTextures(settings);
  cooledCrustTextureCache.set(key, textures);
  return textures;
}

/* ---- The shader patch --------------------------------------------------
 * Four insertions into the sector's own standard material. The crust is a
 * property of the ground, so it is drawn by the ground: one mesh, one draw
 * call, no decal floating above the surface the explorer stands on.
 *
 * The attribute is vec4 — coverage, heat and the tile's UV — and the patch
 * mixes the crust's albedo over the basalt's own shaded colour, adds the heat
 * map's dull red to the emission, and takes the crust's roughness where the
 * crust is. Everything is guarded by `USE_COOLED_CRUST`, which only a material
 * this module has installed ever defines.
 */

const CRUST_VERTEX_PARS = `
#ifdef USE_COOLED_CRUST
\tattribute vec4 aCooledCrust;
\tvarying vec4 vCooledCrust;
#endif`;

const CRUST_VERTEX_MAIN = `
#ifdef USE_COOLED_CRUST
\tvCooledCrust = aCooledCrust;
#endif`;

const CRUST_FRAGMENT_PARS = `
#ifdef USE_COOLED_CRUST
\tuniform sampler2D cooledCrustMap;
\tuniform sampler2D cooledCrustHeatMap;
\tuniform vec3 cooledCrustColor;
\tuniform vec3 cooledCrustWarmth;
\tuniform vec3 cooledCrustEmissive;
\tuniform float cooledCrustEmissiveIntensity;
\tuniform float cooledCrustRoughness;
\tvarying vec4 vCooledCrust;
#endif`;

const CRUST_FRAGMENT_MAIN = `
#ifdef USE_COOLED_CRUST
\tfloat cooledCrustCoverage = clamp( vCooledCrust.x, 0.0, 1.0 );
\tfloat cooledCrustHeat = clamp( vCooledCrust.y, 0.0, 1.0 ) * cooledCrustCoverage;
\tvec3 cooledCrustAlbedo = texture2D( cooledCrustMap, vCooledCrust.zw ).rgb * cooledCrustColor;
\tcooledCrustAlbedo *= mix( vec3( 1.0 ), cooledCrustWarmth, cooledCrustHeat );
\tdiffuseColor.rgb = mix( diffuseColor.rgb, cooledCrustAlbedo, cooledCrustCoverage );
\ttotalEmissiveRadiance += texture2D( cooledCrustHeatMap, vCooledCrust.zw ).rgb
\t\t* cooledCrustEmissive * cooledCrustEmissiveIntensity * cooledCrustHeat;
#endif`;

const CRUST_FRAGMENT_ROUGHNESS = `
#ifdef USE_COOLED_CRUST
\troughnessFactor = mix( roughnessFactor, cooledCrustRoughness, clamp( vCooledCrust.x, 0.0, 1.0 ) );
#endif`;

/** Every anchor the patch needs, in the order it looks for them. */
export const COOLED_CRUST_ANCHORS = Object.freeze({
  vertexPars: '#include <common>',
  vertexMain: '#include <begin_vertex>',
  fragmentPars: '#include <common>',
  fragmentMain: '#include <color_fragment>',
  fragmentRoughness: '#include <roughnessmap_fragment>',
});

/** Insert `insertion` just after `anchor`, counting whether the anchor was there. */
function inject(source, anchor, insertion, report, key) {
  const at = source.indexOf(anchor);
  if (at < 0) {
    report.missing.push(key);
    return source;
  }
  report.landed += 1;
  return `${source.slice(0, at + anchor.length)}\n${insertion}${source.slice(at + anchor.length)}`;
}

/** Patch a vertex shader for the cooled crust. Returns the source unchanged if it has no anchors. */
export function patchCooledCrustVertexShader(source, report = { landed: 0, missing: [] }) {
  let patched = inject(source, COOLED_CRUST_ANCHORS.vertexPars, CRUST_VERTEX_PARS, report, 'vertexPars');
  patched = inject(patched, COOLED_CRUST_ANCHORS.vertexMain, CRUST_VERTEX_MAIN, report, 'vertexMain');
  return patched;
}

/** Patch a fragment shader for the cooled crust. */
export function patchCooledCrustFragmentShader(source, report = { landed: 0, missing: [] }) {
  let patched = inject(source, COOLED_CRUST_ANCHORS.fragmentPars, CRUST_FRAGMENT_PARS, report, 'fragmentPars');
  patched = inject(patched, COOLED_CRUST_ANCHORS.fragmentMain, CRUST_FRAGMENT_MAIN, report, 'fragmentMain');
  patched = inject(patched, COOLED_CRUST_ANCHORS.fragmentRoughness, CRUST_FRAGMENT_ROUGHNESS, report, 'fragmentRoughness');
  return patched;
}

/**
 * Install the cooled crust into the material the sector's ground is drawn with.
 *
 * The material keeps everything it was — its basalt colour, its vertex colours,
 * its roughness — and gains the crust as a blend driven by the terrain's own
 * `aCooledCrust` attribute, so ground the crust never reached renders exactly
 * as it did before. A previous `onBeforeCompile` is chained, not replaced.
 *
 * Returns the same material. With no crust to install the material comes back
 * exactly as it went in, so a switched-off crust costs nothing and changes
 * nothing — not even the program it compiles to.
 */
export function installCooledCrust(material, crust, config = {}) {
  if (!material || !crust) return material ?? null;
  const settings = crust.material ?? resolveCooledCrustMaterial(config);
  const textures = cooledCrustTextures(settings);
  const uniforms = {
    cooledCrustMap: { value: textures.map },
    cooledCrustHeatMap: { value: textures.heat },
    cooledCrustColor: { value: new THREE.Color(settings.color) },
    cooledCrustWarmth: { value: new THREE.Color(settings.warmth) },
    cooledCrustEmissive: { value: new THREE.Color(settings.emissive) },
    cooledCrustEmissiveIntensity: { value: settings.emissiveIntensity },
    cooledCrustRoughness: { value: settings.roughness },
  };
  const previous = material.onBeforeCompile;
  const report = { landed: 0, missing: [] };
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof previous === 'function') previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    // A program can be rebuilt (a switch, a context loss): count this compile,
    // not every compile that ever happened.
    report.landed = 0;
    report.missing = [];
    shader.vertexShader = `#define USE_COOLED_CRUST\n${patchCooledCrustVertexShader(shader.vertexShader, report)}`;
    shader.fragmentShader = `#define USE_COOLED_CRUST\n${patchCooledCrustFragmentShader(shader.fragmentShader, report)}`;
  };
  // The patched program is not the stock standard program: keep the two apart
  // in three's own program cache.
  material.customProgramCacheKey = () => `cooled-crust:${settings.crustTextureSize}|${settings.crustTile}|${settings.crustCells}|${settings.crustSeed}|${settings.emissiveIntensity}`;
  material.userData.cooledCrust = {
    id: crust.id,
    sources: crust.sources,
    tile: settings.crustTile,
    cells: settings.crustCells,
    textureSize: settings.crustTextureSize,
    textureSeed: settings.crustSeed,
    emissiveIntensity: settings.emissiveIntensity,
    roughness: settings.roughness,
    patches: report,
    // The crust is baked once and never ticked: no clock, no uniform is
    // rewritten, and nothing about it enters the world update loop.
    animates: false,
  };
  return material;
}
