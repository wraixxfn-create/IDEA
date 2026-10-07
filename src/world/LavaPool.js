import * as THREE from 'three';

/**
 * LavaPool — the single lava pool of HEX_SE, and the reusable material it and
 * any later lava feature are drawn with.
 *
 * HEX_SE already owns its ground (src/world/VolcanicTerrain.js) and the small
 * openings in it (src/world/VolcanicVents.js). This module adds the one thing
 * the sector was still missing: the molten rock pooled in the floor of its main
 * crater.
 *
 * Four decisions shape it.
 *
 * 1. **The pool is a level sheet inside a basin, not a disc laid on the
 *    ground.** Lava is a liquid: its surface is horizontal. The pool therefore
 *    has exactly one flat plane — the sheet at `pool.level` — and its outline
 *    is not authored at all: it is wherever the ground that basins the lava
 *    rises through that plane, found bearing by bearing on the baked lattice.
 *    The shape the eye reads is the basin's own contour, so the lobes, the
 *    bays and the spits can never be a circle someone drew.
 *
 * 2. **The ground the eye sees and the ground the feet use still agree.** A
 *    flat sheet laid over a dished bowl would leave the explorer standing a
 *    metre below the lava they are walking across, so the pool carries its own
 *    basin: `carveLavaPool` raises the ground under the pool onto a bed — a
 *    dished pond floor, the cooled bank it has thrown up around its own edge,
 *    and the tail that dives back under the crater floor past the crest — and
 *    it raises *only* ground the sheet actually covers, capped by that bed, so
 *    nothing is ever lifted proud of the lava. The bank is the whole trick
 *    twice over: it is the ridge the explorer walks over on the way in, and it
 *    is what closes the pool, because the surface runs under its crest on every
 *    bearing and so can never leak out of its own shore.
 *
 * 3. **The transition is a sequence, not a gradient.** Coming down to the
 *    pool the eye reads: volcanic rock, a band of dark cooled crust hugging
 *    the shore (baked into the terrain's vertex colours, with a faint ember
 *    bleeding onto the rock at the waterline), a chilled margin of crusted-over
 *    lava at the edge of the sheet, a thin hot line where the crust has pulled
 *    away from the shore, rafts of cooled skin drifting on the molten rock, and
 *    the bright molten rock itself. The sheet's vertex colours carry that
 *    sequence; a small procedural crust texture (cooled plates with glowing
 *    cracks between them) carries the fine detail.
 *
 * 4. **One material, reusable.** `createLavaMaterial` builds the whole look
 *    from configuration alone — no pool data goes into it — and hands back a
 *    cached instance, so a second lava feature (a river, another pool, a
 *    fountain) drawn in the same sector shares one material, one texture and
 *    one draw state.
 *
 * Deliberately absent, because this step is only about the pool: no animation
 * (the sheet is static geometry with no clock in it), no particles, no smoke,
 * no light source and no gameplay effect. `buildLavaPool` returns no `update`,
 * so there is nothing to tick.
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

/**
 * A rounded ramp: 0 below `start`, 1 above `end`, a *constant* slope through
 * the middle and a short rounded join at either end. The same ramp the crater
 * and the vents are built from (see VolcanicTerrain.js): the tool for a bed
 * that has to fall away under the sector's slope limit instead of easing out
 * over its whole run.
 */
function roundedRamp(value, start, end, join = 0.22) {
  if (end <= start) return value >= end ? 1 : 0;
  const t = clamp01((value - start) / (end - start));
  const joinFraction = Math.min(0.45, Math.max(1e-4, join));
  const slope = 1 / (1 - joinFraction);
  if (t < joinFraction) return (slope * t * t) / (2 * joinFraction);
  if (t > 1 - joinFraction) {
    const remaining = 1 - t;
    return 1 - (slope * remaining * remaining) / (2 * joinFraction);
  }
  return slope * (t - joinFraction / 2);
}

/* ---- Deterministic value noise -----------------------------------------
 * The same hash family the terrain engine bakes with, kept local so the pool
 * is seeded, stable across machines and independent of the ground module.
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

/* ---- The pool layout ---------------------------------------------------
 * Plain data, in sector-local units (the hexagon has radius 220 and apothem
 * ~190.5). `basin`, `depth`, `dish`, `bank` and `tail` are fractions of the
 * sector's relief amplitude, so the pool scales with the whole landscape like
 * the crater and the vents do; `radius`, `x` and `z` are distances.
 */

export const LAVA_POOL_DEFAULTS = Object.freeze({
  // The basin the pool fills: the lava surface is set this far above the lowest
  // ground the pool covers (fraction of the amplitude). The pool is then as
  // wide as the crater's own bowl is at that height, which is what makes its
  // size a measurement of the crater rather than a number someone chose.
  basin: 0.155,
  // The molten rock itself: how deep the lava is over its own bed, and how far
  // that bed is dished in the middle so the pool floor is never a plate
  // (fractions of the amplitude).
  depth: 0.035,
  dish: 0.006,
  // The cooled bank: the ridge of crust the pool has raised around its own
  // edge, crested just outside the shoreline, and the tail it dives into under
  // the crater floor past the crest — which is what wears the pool out into
  // the rock instead of leaving a rim standing on it. Both are fractions of
  // the amplitude; the tail only has to reach below the highest floor the pool
  // is likely to sit in, and the carve stops by itself where the bed meets the
  // ground that was already baked.
  bank: 0.075,
  tail: 0.08,
  // The bed's profile, in units of the pool's own radius: flat to `bankFoot`,
  // crested at `bankCrest`, at its lowest by `bankOuter`. The rises are spread
  // over these runs on purpose — a bank that climbs 2.7 units in 7 and falls
  // 4.3 in 11 is a slope the sector's own walkable limit already likes.
  bankFoot: 0.34,
  bankCrest: 0.85,
  bankOuter: 1.05,
  join: 0.2,
  // How far the bank's reach and height wander off the pool's centre line and
  // crest (shares): the lobes the shoreline is made of. Nothing about the pool
  // is a circle because of them.
  bankLobes: 0.34,
  bankVariation: 0.3,
  // The pool's nominal radius, and how much the outline's own wobble moves it —
  // the second scale of irregularity, on top of the bank's lobes.
  radius: 26,
  irregularity: 0.42,
  // The molten sheet. The shoreline is where the detail lives, so the rings
  // crowd towards it (`ringBias` below 1 pushes them outwards), and `segments`
  // sets how finely the pool's outline is resolved.
  segments: 160,
  rings: 28,
  ringBias: 0.8,
  // How far the sheet floats above the waterline — enough to stay clear of the
  // ground it meets without reading as a step — and the smallest radius a
  // bearing may be clamped to, so a shoreline running close past the vent
  // cannot leave the fan with slivers for triangles.
  lift: 0.035,
  minShoreRadius: 4.2,
  seedOffset: 0,
});

export const DEFAULT_LAVA_POOL = Object.freeze({
  id: 'lava-pool-hex-se',
  // The main crater's vent sits at (38, 84) in sector-local units; the lake
  // sits a few units south-west of it, over the deepest ground of the bowl.
  x: 34,
  z: 79,
});

/**
 * The band of ground the pool paints as its cooled margin, in height above the
 * waterline: full crust at the shore, gone `POOL_CRUST_FEATHER` further up,
 * with the ember bleeding onto the rock right at the lava's edge. The band also
 * fades out with the distance from the pool, so the margin is a ring around it
 * rather than a contour drawn over the whole crater floor.
 */
const POOL_CRUST_BAND = 1.05;
const POOL_CRUST_FEATHER = 2.6;
const POOL_EMBER_BAND = 0.5;
const POOL_EMBER_FEATHER = 0.9;
const POOL_SHORE_REACH = POOL_CRUST_BAND * 1.3 + POOL_CRUST_FEATHER + 1e-3;

/** Resolve the footprint: the noise scales, the bank and the reach of the bed. */
function resolveFootprint(pool) {
  // Wide enough for the bank's furthest lobe and the outline's wobble both, so
  // the bed always carries the shape the eye reads — the bound the early reject
  // uses, never the shape itself.
  const reach = pool.radius * pool.bankOuter * (1 + pool.bankLobes) * (1 + pool.irregularity);
  return {
    ...pool,
    seed: (0x1a7a0000 ^ Math.imul(pool.seedOffset | 0, 0x9e3779b1)) >>> 0,
    wobbleScale: 1 / Math.max(2, pool.radius * 0.9),
    // The bank's own outline. The wavelength is a fraction of the pool's own
    // radius, so the pool always spans two or three of the bank's shoulders and
    // the shoreline is lobed however large the pool is drawn.
    bankScale: 1 / Math.max(2.5, pool.radius * 0.52),
    // The bed's outer end, in the ridge coordinate: the pool is exactly zero
    // outside it, which is what bounds the bed and lets the carve reject a
    // vertex with one multiplication.
    bedEnd: pool.bankOuter,
    // Everything outside the footprint is exactly zero, so the early reject in
    // `lavaPoolSampleAt` only has to be *bigger* than the bed, never exact.
    support: reach,
    supportSq: reach * reach,
  };
}

/**
 * Resolve the pool the sector should carry. `config.lavaPool` overrides the
 * default placement (`false` or `null` removes the pool outright).
 *
 * `context` carries what the pool cannot know by itself:
 *
 *   • `terrain` — the baked lattice, used to measure the lowest ground the
 *     pool's footprint covers. The lava surface is then set `basin` above that
 *     ground, so the pool fills whatever bowl the crater actually has.
 *   • `amplitude` — the sector's relief amplitude, which `basin`, `depth`,
 *     `dish`, `bank` and `tail` are fractions of.
 *   • `floorLevel` — an explicit floor height, for a caller with no terrain.
 *   • `crater` — the crater's layout, only as the analytic fallback for the
 *     floor when neither of the two above is given.
 */
export function planLavaPool(config = {}, context = {}) {
  if (config.lavaPoolEnabled === false) return null;
  const override = config.lavaPool;
  if (override === false || override === null) return null;
  const amplitude = Math.max(1e-3, context.amplitude ?? 1);
  const pool = resolveFootprint({
    ...LAVA_POOL_DEFAULTS,
    ...DEFAULT_LAVA_POOL,
    ...(override ?? {}),
  });

  const floorLevel = Number.isFinite(context.floorLevel)
    ? context.floorLevel
    : (context.terrain
      ? lowestGroundUnderPool(context.terrain, pool)
      : (context.crater
        ? (context.crater.summitLevel - context.crater.depth - context.crater.floorDish) * amplitude
        : 0));
  pool.floorLevel = floorLevel;
  pool.level = floorLevel + pool.basin * amplitude;
  pool.depthUnits = pool.depth * amplitude;
  pool.dishDepth = pool.dish * amplitude;
  pool.bankHeight = pool.bank * amplitude;
  pool.tailDepth = pool.tail * amplitude;
  // The crest has to clear the waterline on every bearing, or the surface could
  // run past its own edge; with the variation below it never drops below this.
  pool.minCrestClearance = pool.bankHeight * (1 - pool.bankVariation) - pool.depthUnits - pool.dishDepth;
  pool.bedLevel = pool.level - pool.depthUnits - pool.dishDepth;
  pool.levelFrom = Number.isFinite(context.floorLevel)
    ? 'given'
    : (context.terrain ? 'measured' : (context.crater ? 'crater' : 'none'));
  return pool;
}

/** The lowest lattice height inside the pool's footprint: what it fills from. */
function lowestGroundUnderPool(terrain, pool) {
  const { positions, heights, vertexCount } = terrain;
  let lowest = Infinity;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = positions[v * 3];
    const z = positions[v * 3 + 2];
    if (!lavaPoolSampleAt(x, z, pool)) continue;
    if (heights[v] < lowest) lowest = heights[v];
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

/* ---- The shape ---------------------------------------------------------
 * Measured along `u` — the distance from the pool's centre as a fraction of
 * that bearing's own footprint radius — so the footprint's edge is lobed
 * rather than round.
 */

/**
 * The outline's own wobble at a sector-local point, at two scales: a coarse one
 * that moves whole bays and spits, and a finer one that breaks the shore
 * between them. Nothing about the pool is a circle because of this.
 */
function poolWobbleAt(x, z, pool) {
  const coarse = fbm(x * pool.bankScale * 0.62 + 12.4, z * pool.bankScale * 0.62 - 6.8, pool.seed, 2, 0.5, 2);
  const fine = fbm(x * pool.bankScale * 1.9 - 5.3, z * pool.bankScale * 1.9 + 8.9, pool.seed + 449, 2, 0.45, 2);
  return coarse * 0.62 + fine * 0.38;
}

/**
 * The pool's own fields at a sector-local point, or `null` outside its
 * footprint. `fill` is the bed's height *relative to the lava surface*: a
 * little under zero over the pond floor, climbing through zero into the cooled
 * bank, over its crest and back down the tail until the bed has sunk below the
 * crater floor the bake already made. The shoreline is exactly where `fill`
 * crosses zero on the way up.
 */
export function lavaPoolSampleAt(x, z, pool) {
  const dx = x - pool.x;
  const dz = z - pool.z;
  if (dx * dx + dz * dz > pool.supportSq) return null;

  // The outline's own wobble, at two sizes: a coarse one that moves whole bays
  // and spits, and a finer one that breaks the shore between them.
  const u = (Math.hypot(dx, dz) / pool.radius) * (1 + pool.irregularity * poolWobbleAt(x, z, pool));

  // The bank: the ridge of cooled crust the pool has raised around its own
  // edge. Two noises shape it — a slow one that pushes whole shoulders of the
  // bank in and out, and a finer one that breaks its crest — so the ridge
  // wanders around the pool instead of ringing it. Its *lobes* (`lobe`) move
  // the crest in and out, which is what draws the bays, the spits and the
  // inlets of the shoreline; its *breath* (`scale`) lifts and lowers the crest,
  // which is what leaves one stretch steep and another nearly drowned. Both are
  // clamped so the crest always clears the waterline: the lava can never run
  // out of its own bank.
  const shoulder = fbm(x * pool.bankScale + 4.7, z * pool.bankScale - 9.2, pool.seed + 331, 2, 0.5, 2);
  const crest = fbm(x * pool.bankScale * 2.2 - 2.3, z * pool.bankScale * 2.2 + 6.1, pool.seed + 97, 2, 0.5, 2);
  const lobeShape = shoulder * 0.66 + crest * 0.34;
  const lobe = Math.max(0.35, 1 + pool.bankLobes * lobeShape);
  const breath = clamp01(0.5 + 0.5 * (shoulder * 0.55 + crest * 0.45));
  const scale = 1 + pool.bankVariation * (breath * 2 - 1);
  const ridge = u / lobe;
  if (ridge >= pool.bedEnd) return null;

  // One profile through the bed: the dished pond floor at the vent, the bank
  // climbing out of it, and the tail diving under the crater floor past the
  // crest. Everything is a rounded ramp, so both joins are round and the run
  // between them is a clean, walkable slope.
  const pondLevel = -pool.depthUnits - pool.dishDepth;
  const crestLevel = pool.bankHeight * scale;
  const tailLevel = -pool.depthUnits - pool.tailDepth;
  const climb = roundedRamp(ridge, pool.bankFoot, pool.bankCrest, pool.join);
  const fall = roundedRamp(ridge, pool.bankCrest, pool.bedEnd, pool.join);
  const fill = pondLevel
    + (crestLevel - pondLevel) * climb
    - (crestLevel - tailLevel) * fall;
  return { u, ridge, lobe, bank: crestLevel * (climb - fall), fill };
}

/**
 * The height of the pool's bed at a sector-local point — the sheet of ground
 * the lava ponds over — or `null` outside the footprint. It is below
 * `pool.level` everywhere the lava is (the pond floor and the inner climb), the
 * crest of the bank is above it, and past the crest the bed falls away under
 * the crater floor so the pool wears out into the rock instead of ending on a
 * rim.
 */
export function lavaPoolBedAt(x, z, pool) {
  const sample = lavaPoolSampleAt(x, z, pool);
  return sample ? pool.level + sample.fill : null;
}

/**
 * What the pool tells the *terrain* about itself at a point, as shares rather
 * than colours: `crust` is how much of the ground's cooled margin the point
 * belongs to (1 right at the waterline, 0 by the time the rock is a few units
 * above it), and `ember` is the faint warmth the shore throws onto the rock it
 * is about to melt. The terrain shades its basalt with this, so the transition
 * into the pool starts on the rock and not on the lava.
 */
export function lavaPoolShadeAt(x, z, height, pool) {
  if (!pool) return { crust: 0, ember: 0 };
  const above = height - pool.level;
  if (above >= POOL_SHORE_REACH) return { crust: 0, ember: 0 };
  const dx = x - pool.x;
  const dz = z - pool.z;
  if (dx * dx + dz * dz > pool.supportSq) return { crust: 0, ember: 0 };
  // How much of the pool's neighbourhood this point is in at all: the margin
  // belongs to the bank and its inner slope, not to the whole crater floor.
  const u = (Math.hypot(dx, dz) / pool.radius) * (1 + pool.irregularity * poolWobbleAt(x, z, pool));
  const near = 1 - smoothStep(u, 0.7, 1.0);
  if (near <= 0) return { crust: 0, ember: 0 };
  // The band is measured in height above the waterline, so it hugs the shore
  // wherever the shore runs — and its width breathes with the ground, so the
  // margin never reads as a contour line drawn round the pool.
  const breath = 0.78 + 0.44 * fbm(x * 0.055 + 3.1, z * 0.055 - 7.4, pool.seed + 601, 2, 0.5, 2);
  const band = Math.max(0.35, POOL_CRUST_BAND * breath);
  const crust = (1 - smoothStep(above, band, band + POOL_CRUST_FEATHER)) * near;
  const ember = (1 - smoothStep(above, POOL_EMBER_BAND, POOL_EMBER_BAND + POOL_EMBER_FEATHER))
    * (1 - smoothStep(u, 0.74, 1.0));
  return { crust, ember };
}

/* ---- Raising the bed ---------------------------------------------------
 * The pool lifts the ground under it onto its bed, and nothing else: every
 * vertex the waterline does not cover keeps its exact baked height.
 */

/** The terrain's own walkability sweep, restricted to the pool's footprint. */
function limitPoolSlopes(terrain, inPool, passes = 64) {
  const { heights, indices, isRim } = terrain;
  const limit = terrain.maxSlope * terrain.cellSize;
  const locked = (v) => !inPool[v] || isRim[v];
  let corrections = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    let passCorrections = 0;
    for (let t = 0; t < indices.length; t += 3) {
      for (let edge = 0; edge < 3; edge += 1) {
        const a = indices[t + edge];
        const b = indices[t + ((edge + 1) % 3)];
        if (!inPool[a] && !inPool[b]) continue;
        const delta = heights[a] - heights[b];
        const excess = Math.abs(delta) - limit;
        if (excess <= 0) continue;
        const sign = delta > 0 ? 1 : -1;
        const lockedA = locked(a);
        const lockedB = locked(b);
        if (lockedA && lockedB) continue;
        if (lockedA) heights[b] += sign * excess;
        else if (lockedB) heights[a] -= sign * excess;
        else {
          heights[a] -= sign * excess * 0.5;
          heights[b] += sign * excess * 0.5;
        }
        passCorrections += 1;
      }
    }
    corrections += passCorrections;
    if (passCorrections === 0) break;
  }
  return corrections;
}

/**
 * Raise the pool's bed into a baked terrain and re-limit the slopes inside its
 * footprint.
 *
 * The terrain must have been baked (`build()` + `writeHeights()`) before this
 * runs, exactly like the vents: the pool is a modification *of* the crater, not
 * a feature inside the height field, which is what keeps the crater's walls,
 * its crest, the neighbouring sectors and every gate approach exactly what they
 * were. Three rules keep it honest:
 *
 *   • only ground **under** the waterline is touched — anything above
 *     `pool.level` is left bit-for-bit as it was, so the crater's own shape and
 *     the sector's own statistics cannot move;
 *   • the raise is capped by the bed, and the bed is below the lava everywhere
 *     the lava reaches, so nothing is ever lifted proud of the surface; where
 *     the bed is already under the baked ground (past the bank) the ground is
 *     not touched at all, which is what wears the pool out into the rock;
 *   • the sector's mask still applies (the rim and the gate aprons), and the
 *     slope limiter runs with every vertex outside the footprint locked, so the
 *     walkability guarantee holds without the rest of HEX_SE shifting by so
 *     much as one float.
 *
 * Returns a report of what was authored and what the lattice actually did.
 */
export function carveLavaPool(terrain, pool) {
  if (!terrain || !pool) return null;
  const { positions, heights, isRim, vertexCount } = terrain;
  const inPool = new Uint8Array(vertexCount);
  let vertices = 0;
  let deepest = 0;
  let total = 0;
  let lowestBed = Infinity;
  let highestBed = -Infinity;

  for (let v = 0; v < vertexCount; v += 1) {
    if (isRim[v]) continue;
    const x = positions[v * 3];
    const z = positions[v * 3 + 2];
    const sample = lavaPoolSampleAt(x, z, pool);
    if (!sample) continue;
    const bed = pool.level + sample.fill;
    const before = heights[v];
    if (before >= bed) continue;
    // The same mask that flattens the sector's rim and its gate approaches: a
    // pool can never lift ground near a shared edge or a doorway, whatever it
    // is authored to do.
    const mask = typeof terrain.maskAt === 'function' ? terrain.maskAt(x, z) : 1;
    const after = before + (bed - before) * mask;
    if (after <= before) continue;
    heights[v] = after;
    inPool[v] = 1;
    vertices += 1;
    const raise = after - before;
    total += raise;
    if (raise > deepest) deepest = raise;
    if (after < lowestBed) lowestBed = after;
    if (after > highestBed) highestBed = after;
  }

  const corrections = vertices > 0 ? limitPoolSlopes(terrain, inPool) : 0;

  return {
    id: pool.id,
    x: pool.x,
    z: pool.z,
    level: pool.level,
    levelFrom: pool.levelFrom,
    // `floorLevel` is the crater floor the pool found; `basinDepth` is how far
    // the lava surface floats above it, and `depth` is how deep the molten rock
    // itself is over the bed it ponds on.
    floorLevel: pool.floorLevel,
    basinDepth: Math.max(0, pool.level - pool.floorLevel),
    bedLevel: pool.bedLevel,
    depth: pool.depthUnits + pool.dishDepth,
    footprintRadius: pool.support,
    bedRadius: pool.radius,
    bankHeight: pool.bankHeight,
    minCrestClearance: pool.minCrestClearance,
    vertices,
    deepestRaise: deepest,
    meanRaise: vertices > 0 ? total / vertices : 0,
    bedRange: vertices > 0 ? [lowestBed, highestBed] : null,
    slopeCorrections: corrections,
  };
}

/* ---- The reusable lava material ----------------------------------------
 * Built from configuration alone — the pool contributes nothing but its own
 * vertex colours and UVs — so any later lava feature can ask for the same
 * look, and the same configuration hands back the same instance: one material,
 * one texture pair and one draw state per palette.
 */

export const LAVA_MATERIAL_DEFAULTS = Object.freeze({
  // A warm, near-white glow: the crust texture and the sheet's own vertex
  // colours carry the colour of the heat, so the emissive only has to say how
  // hot the whole surface is.
  color: 0xffffff,
  emissive: 0xffe3c2,
  // Bright enough to read as molten rock under the sky's own light, low enough
  // that the crater is not a white hole in the world. The crust tile multiplies
  // this, so what the eye gets over a plate is about four fifths of it.
  emissiveIntensity: 1,
  roughness: 0.86,
  metalness: 0.03,
  // The crust pattern: a seamless tile of cooled plates and glowing cracks,
  // repeated every `crustTile` sector units.
  crustTextureSize: 256,
  crustTile: 19,
  crustCells: 7,
  crustSeed: 0x1a7a5eed,
});

const lavaMaterialCache = new Map();

/**
 * The whole look of a lava surface, from configuration alone.
 *
 * Vertex colours are the heat of the surface (dark crust where it has cooled,
 * bright orange where it has not) and the crust texture is its skin (dark
 * plates, glowing cracks between them). The material multiplies the two into
 * both the diffuse and the emissive — the vertex colour drives the glow, so a
 * cooled margin genuinely stops emitting instead of merely going dark — which
 * is why one texture is enough for the albedo and the emission.
 *
 * `overrides` wins over `config`, so a caller can ask for a variation of the
 * shared palette without touching the world configuration.
 */
export function createLavaMaterial(config = {}, overrides = {}) {
  const settings = {
    color: config.lavaColor ?? LAVA_MATERIAL_DEFAULTS.color,
    emissive: config.lavaEmissiveColor ?? LAVA_MATERIAL_DEFAULTS.emissive,
    emissiveIntensity: config.lavaEmissiveIntensity ?? LAVA_MATERIAL_DEFAULTS.emissiveIntensity,
    roughness: config.lavaRoughness ?? LAVA_MATERIAL_DEFAULTS.roughness,
    metalness: config.lavaMetalness ?? LAVA_MATERIAL_DEFAULTS.metalness,
    crustTextureSize: Math.max(32, Math.round(config.lavaCrustTextureSize ?? LAVA_MATERIAL_DEFAULTS.crustTextureSize)),
    crustTile: Math.max(1, config.lavaCrustTile ?? LAVA_MATERIAL_DEFAULTS.crustTile),
    crustCells: Math.max(2, Math.round(config.lavaCrustCells ?? LAVA_MATERIAL_DEFAULTS.crustCells)),
    crustSeed: config.lavaCrustSeed ?? LAVA_MATERIAL_DEFAULTS.crustSeed,
    ...overrides,
  };
  const key = `${settings.color}|${settings.emissive}|${settings.emissiveIntensity}|${settings.roughness}|${settings.metalness}|${settings.crustTextureSize}|${settings.crustTile}|${settings.crustCells}|${settings.crustSeed}`;
  const cached = lavaMaterialCache.get(key);
  if (cached) return cached;

  const texture = createLavaCrustTexture(settings);
  const material = new THREE.MeshStandardMaterial({
    name: 'LavaMaterial',
    color: new THREE.Color(settings.color),
    map: texture,
    emissive: new THREE.Color(settings.emissive),
    emissiveIntensity: settings.emissiveIntensity,
    emissiveMap: texture,
    vertexColors: true,
    roughness: settings.roughness,
    metalness: settings.metalness,
  });
  // The stock standard shader tints the diffuse with the vertex colour but
  // leaves the emission uniform. Multiplying the emissive by the same colour is
  // what makes the sheet's own heat map — cold crust at the margin, molten rock
  // in the middle — govern the glow as well as the albedo.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
    );
  };
  material.userData.lava = {
    // What the material was built from, and how it is meant to be used: a
    // static, emissive, vertex-coloured surface with no clock in it.
    animates: false,
    crustTile: settings.crustTile,
    emissiveIntensity: settings.emissiveIntensity,
    textureSize: settings.crustTextureSize,
    textureSeed: settings.crustSeed,
  };
  lavaMaterialCache.set(key, material);
  return material;
}

/** The crust texture a lava material is skinned with, for the curious. */
export function lavaCrustTextureOf(material) {
  return material?.map ?? null;
}

/* ---- The crust pattern -------------------------------------------------
 * A small seamless tile: cooled plates of basalt with warm, glowing cracks
 * between them, and a slow heat field that leaves some plates still hot.
 * Seamless matters — the tile repeats across the sheet, and a visible seam
 * would read as a line drawn across the lava.
 */

function wrapCell(value, period) {
  const wrapped = value % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/** Value noise whose lattice wraps every `period` cells, so the tile is seamless. */
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

/** Where a plate's own point sits inside cell (cx, cy) of a wrapped grid. */
function platePoint(cx, cy, seed) {
  return {
    x: cx + 0.5 + hash2d(cx, cy, seed) * 0.36,
    y: cy + 0.5 + hash2d(cx, cy, seed + 7919) * 0.36,
  };
}

/**
 * Build the crust tile: a seamless square (256 texels by default) of cooled
 * lava skin. Every texel is the colour the surface should be at *full* heat —
 * a dark plate, a warm plate or a glowing crack — and the material multiplies
 * it by the sheet's own vertex colour, so the same texel reads as warm rock
 * where the crust has cooled and as molten rock where it has not.
 */
export function createLavaCrustTexture(settings = {}) {
  const size = Math.max(32, Math.round(settings.crustTextureSize ?? LAVA_MATERIAL_DEFAULTS.crustTextureSize));
  const cells = Math.max(2, Math.round(settings.crustCells ?? LAVA_MATERIAL_DEFAULTS.crustCells));
  const seed = settings.crustSeed ?? LAVA_MATERIAL_DEFAULTS.crustSeed;
  const data = new Uint8Array(size * size * 4);

  // The tile is a *modulation* of the heat the vertex colours carry, not a
  // colour of its own: its plates are bright and slightly warm, and the seams
  // between them are brighter still, so multiplying it into the sheet darkens
  // the cooled skin and leaves the glowing cracks standing out. Keeping it
  // bright matters — it multiplies the emission as well as the albedo, and a
  // mid-grey plate would halve the lava's own glow.
  const PLATE = [196, 190, 184];
  const PLATE_WARM = [222, 206, 188];
  const CRACK = [246, 238, 228];
  const CRACK_HOT = [255, 252, 246];

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px / size) * cells;
      const y = (py / size) * cells;
      const cx = Math.floor(x);
      const cy = Math.floor(y);

      // 1. The plates: the distance to this cell's own point and to the next
      //    one along. Their difference is zero exactly on a plate boundary,
      //    which makes it the crack.
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
      const crack = 1 - smoothStep(second - first, 0.055, 0.17);

      // 2. The heat: a slow field over the whole tile, so some plates are
      //    still glowing while others have gone black, a per-plate tone so two
      //    neighbours never read as the same piece of rock, and a fine grain.
      const heatField = tileableFbm(x * 0.55, y * 0.55, cells, seed + 271, 3) * 0.5 + 0.5;
      const plateHeat = clamp01(
        smoothStep(heatField, 0.42, 0.86) * (0.7 + 0.3 * (hash2d(ownerX, ownerY, seed + 613) * 0.5 + 0.5)),
      );
      const grain = tileableFbm(x * 2.4, y * 2.4, cells, seed + 907, 2) * 0.5 + 0.5;
      const crackHeat = clamp01(0.55 + 0.45 * plateHeat) * (0.82 + 0.18 * grain);

      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const plate = PLATE[channel] + (PLATE_WARM[channel] - PLATE[channel]) * plateHeat;
        const hot = CRACK[channel] + (CRACK_HOT[channel] - CRACK[channel]) * plateHeat;
        const value = plate + (hot - plate) * crack * crackHeat;
        data[offset + channel] = Math.max(0, Math.min(255, Math.round(value * (0.94 + 0.12 * grain))));
      }
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'LavaCrustTexture';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/* ---- The molten sheet --------------------------------------------------
 * The pool's visible surface: one flat fan of triangles at the waterline,
 * built on the shoreline the terrain itself draws — bisected, bearing by
 * bearing, out of the baked lattice — so the lava ends exactly where the rock
 * begins to climb.
 */

const MOLTEN_SKIN = new THREE.Color();
const MOLTEN_OUT = new THREE.Color();

// The sequence the eye reads, from the shore inwards. Linear scene values: the
// material multiplies its diffuse *and* its emission by these, so a crust
// colour is both dark and cold, which is the whole point of the transition.
const CRUST_COLOR = new THREE.Color(0.15, 0.072, 0.05);    // chilled, iron-stained skin
const CRUST_WARM = new THREE.Color(0.25, 0.108, 0.062);    // its warmer side
const EMBER_COLOR = new THREE.Color(0.55, 0.135, 0.045);   // heat-glazed crust
const MOLTEN_COLOR = new THREE.Color(1.02, 0.4, 0.115);    // molten rock
const MOLTEN_HOT = new THREE.Color(1.22, 0.66, 0.235);     // its hottest skin

/**
 * The shoreline's radius on one bearing: where the lava stops.
 *
 * That is the *first* place, walking outwards from the vent, where the ground
 * climbs through the sheet's own plane — so the lava ends exactly where the
 * rock comes up to meet it, flush, with no gap to see under and no shelf of
 * molten rock floating over ground the pool never lifted. Walking outwards
 * (rather than bisecting the whole footprint) also means the bank's far side,
 * which is above the lava again, can never be mistaken for a second shore.
 *
 * The crawl is coarse and the crossing is bisected inside the last step, so the
 * outline is resolved to a fraction of a millimetre. The pool's own footprint
 * is the outer bound: the sheet can never leave the bed that carries it.
 */
function shorelineRadiusAt(heightAt, sampleAt, pool, dirX, dirZ) {
  const plane = pool.level + pool.lift;
  const supported = (radius) => sampleAt(pool.x + dirX * radius, pool.z + dirZ * radius, pool) !== null;
  const ground = (radius) => heightAt(pool.x + dirX * radius, pool.z + dirZ * radius);
  if (!supported(0)) return 0;
  if (ground(0) >= plane) return 0;
  const step = Math.max(0.3, pool.radius * 0.024);
  let previous = 0;
  for (let radius = step; ; radius += step) {
    const reach = Math.min(radius, pool.support);
    const open = supported(reach) && ground(reach) < plane;
    if (open) {
      previous = reach;
      if (reach >= pool.support) return pool.support;
      continue;
    }
    let low = previous;
    let high = reach;
    for (let k = 0; k < 22; k += 1) {
      const mid = (low + high) * 0.5;
      if (supported(mid) && ground(mid) < plane) low = mid;
      else high = mid;
    }
    return low;
  }
}

/**
 * Capture the closed pool's contour before an outlet is cut. The flow keeps
 * this shoreline: re-solving it on an open spillway would flood the descending
 * channel with an extension of the pool's horizontal plane.
 */
export function measureLavaPoolShoreline(terrain, pool) {
  if (!terrain || !pool) return null;
  const heightAt = (x, z) => terrain.heightAt(x, z);
  const segments = Math.max(24, Math.round(pool.segments));
  // 1. The shoreline, bearing by bearing. `minShoreRadius` keeps a spur that
  //    runs close past the vent from leaving the fan with slivers; the sheet is
  //    simply buried under the rock there, which is invisible.
  const shoreRadii = new Float32Array(segments);
  const meshRadii = new Float32Array(segments);
  let minRadius = Infinity;
  let maxRadius = 0;
  let sum = 0;
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const radius = shorelineRadiusAt(heightAt, lavaPoolSampleAt, pool, Math.cos(angle), Math.sin(angle));
    shoreRadii[i] = radius;
    meshRadii[i] = Math.max(pool.minShoreRadius, radius);
    minRadius = Math.min(minRadius, radius);
    maxRadius = Math.max(maxRadius, radius);
    sum += radius;
  }
  const meanRadius = sum / segments;
  let variance = 0;
  for (let i = 0; i < segments; i += 1) variance += (shoreRadii[i] - meanRadius) ** 2;
  const deviation = Math.sqrt(variance / segments);

  return { radii: shoreRadii, meshRadii, min: minRadius, max: maxRadius, mean: meanRadius, deviation };
}

/**
 * Build the pool's molten sheet on a baked terrain and return it with the
 * measurements a caller (or a test) wants to reason about: the shoreline's
 * radii, the area the lava covers and the level it sits at.
 *
 * The pool is one mesh and one material — static geometry, no clock, no
 * particles, no light — and it is the caller's job to add `group` to the
 * sector's group at the sector's own centre, because the geometry is in
 * sector-local coordinates exactly like the terrain it sits in.
 * `options.materialOverrides` can retune the shared lava material for this
 * pool without touching the world configuration.
 */
export function buildLavaPool(terrain, pool, config = {}, options = {}) {
  if (!terrain || !pool) return null;
  const segments = Math.max(24, Math.round(pool.segments));
  const rings = Math.max(4, Math.round(pool.rings));
  const bias = Math.min(1, Math.max(0.4, pool.ringBias));

  const flow = terrain.lavaFlow?.pool === pool ? terrain.lavaFlow : null;
  const shoreline = flow?.sourceShoreline ?? measureLavaPoolShoreline(terrain, pool);
  const { radii: shoreRadii, meshRadii, min: minRadius, max: maxRadius, mean: meanRadius, deviation } = shoreline;

  // 2. The fan: a centre vertex, then `rings` rings per bearing, all on the
  //    waterline. Ring 0 is the vent, ring `rings` is the shore.
  const vertexCount = 1 + segments * rings;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tile = Math.max(1, config.lavaCrustTile ?? LAVA_MATERIAL_DEFAULTS.crustTile);
  const uvCos = Math.cos(0.37);
  const uvSin = Math.sin(0.37);
  const surface = pool.level + pool.lift;

  const writeVertex = (index, x, z, heat) => {
    positions[index * 3] = x;
    positions[index * 3 + 1] = surface;
    positions[index * 3 + 2] = z;
    colors[index * 3] = heat.r;
    colors[index * 3 + 1] = heat.g;
    colors[index * 3 + 2] = heat.b;
    // A planar projection, turned a little off the axes so the pattern never
    // lines up with the fan's own spokes.
    uvs[index * 2] = (x * uvCos - z * uvSin) / tile;
    uvs[index * 2 + 1] = (x * uvSin + z * uvCos) / tile;
  };

  // The heat of the surface at a point, from the vent outwards: the cooled
  // margin that has crept in from the shore, the bright line where the crust
  // has pulled away from it, the plates of skin drifting on the molten rock,
  // and the molten rock itself.
  const seed = pool.seed + 1201;
  const heatAt = (x, z, fraction) => {
    // Only the outlet is opened in the old chilled rim: the existing pool
    // stays the same everywhere else, but no cold crossbar dams the flow.
    const outlet = flow?.outlet;
    if (outlet) {
      const angle = Math.atan2(z - pool.z, x - pool.x) - outlet.bearing;
      const delta = Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)));
      fraction *= smoothStep(delta, outlet.halfAngle * 0.65, outlet.halfAngle * 1.2);
    }
    // How far the cooled margin reaches at this bearing, and how dark it goes:
    // both breathe with the ground, because a crust does not spread evenly.
    const breath = fbm(x * 0.042 + 8.3, z * 0.042 - 3.9, seed + 17, 2, 0.5, 2);
    const inner = 1 - (0.3 + 0.1 * breath);
    const chill = smoothStep(fraction, inner, inner + 0.22 + 0.06 * breath);
    // The bright line where the crust has pulled away from the shore: a crack
    // running inside the margin, not a glow painted along the edge of the
    // sheet. It dies out before the shore itself, so the outermost lava is
    // crusted over — which is what makes the edge read as cooled rock.
    const rim = Math.exp(-(((fraction - (inner + 0.035)) / 0.045) ** 2))
      * (1 - smoothStep(fraction, 0.955, 0.995));
    // Plates of skin that have cooled and drifted on the molten rock, mottled
    // at three scales — broad drift sheets, the plates themselves and their
    // broken edges — so the sheet never reads as a spot pattern.
    const drift = fbm(x * 0.028 - 6.2, z * 0.028 + 2.4, seed + 211, 2, 0.5, 2);
    const plate = fbm(x * 0.062 - 2.7, z * 0.062 + 5.1, seed + 53, 3, 0.5, 2)
      + 0.36 * fbm(x * 0.185 + 11.3, z * 0.185 - 4.4, seed + 307, 2, 0.5, 2);
    const raft = (1 - chill * 0.3)
      * clamp01(smoothStep(plate, 0.2, 0.68) * 0.72 + Math.max(0, drift) * 0.55);
    const grain = fbm(x * 0.4 + 1.1, z * 0.4 + 6.6, seed + 913, 2, 0.5, 2) * 0.5 + 0.5;

    let heat = (1 - chill) * (0.5 + 0.36 * grain) * (1 - 0.9 * raft);
    heat = Math.max(heat, rim * 0.95);
    heat = clamp01(heat);

    MOLTEN_SKIN.copy(CRUST_COLOR);
    MOLTEN_SKIN.lerp(CRUST_WARM, clamp01(chill * 0.7 + (1 - raft) * 0.22 * (1 - chill) + heat * 0.2));
    MOLTEN_SKIN.lerp(EMBER_COLOR, smoothStep(heat, 0.06, 0.34));
    MOLTEN_SKIN.lerp(MOLTEN_COLOR, smoothStep(heat, 0.3, 0.82));
    MOLTEN_SKIN.lerp(MOLTEN_HOT, smoothStep(heat, 0.74, 1) * (0.4 + 0.6 * grain));
    // A hair of the grain in the colour itself: the crust is never a flat tint.
    MOLTEN_OUT.copy(MOLTEN_SKIN).multiplyScalar(0.93 + 0.14 * grain);
    return MOLTEN_OUT;
  };

  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    for (let ring = 1; ring <= rings; ring += 1) {
      const fraction = (ring / rings) ** bias;
      const radius = meshRadii[i] * fraction;
      const x = pool.x + dirX * radius;
      const z = pool.z + dirZ * radius;
      writeVertex(1 + (ring - 1) * segments + i, x, z, heatAt(x, z, fraction));
    }
  }
  writeVertex(0, pool.x, pool.z, heatAt(pool.x, pool.z, 0));

  // 3. The faces: a fan at the vent, quads between the rings. Wound so every
  //    face looks up, and the whole sheet shares one plane, so the pool reads
  //    as the level surface of a liquid.
  const indices = new Uint32Array(segments * (rings * 2 - 1) * 3);
  let cursor = 0;
  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    indices[cursor] = 0;
    indices[cursor + 1] = 1 + next;
    indices[cursor + 2] = 1 + i;
    cursor += 3;
  }
  for (let ring = 1; ring < rings; ring += 1) {
    const inner = 1 + (ring - 1) * segments;
    const outer = 1 + ring * segments;
    for (let i = 0; i < segments; i += 1) {
      const next = (i + 1) % segments;
      indices[cursor] = inner + i;
      indices[cursor + 1] = outer + next;
      indices[cursor + 2] = outer + i;
      cursor += 3;
      indices[cursor] = inner + i;
      indices[cursor + 1] = inner + next;
      indices[cursor + 2] = outer + next;
      cursor += 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = `LavaPoolGeometry_${terrain.sectorId ?? 'HEX_SE'}`;
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The sheet is a plane: its normal is the world's up everywhere, which is
  // exactly what the level surface of a liquid looks like under the sky.
  const normals = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v += 1) normals[v * 3 + 1] = 1;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // The area the lava covers, exactly as the fan covers it.
  const step = (Math.PI * 2) / segments;
  let area = 0;
  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    area += 0.5 * meshRadii[i] * meshRadii[next] * Math.sin(step);
  }

  const material = createLavaMaterial(config, options.materialOverrides ?? {});
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `LavaPoolMesh_${terrain.sectorId ?? 'HEX_SE'}`;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.sectorId = terrain.sectorId ?? 'HEX_SE';
  mesh.userData.surface = 'molten-lava';
  mesh.userData.level = pool.level;
  mesh.userData.lavaArea = area;

  const group = new THREE.Group();
  group.name = `LavaPool_${terrain.sectorId ?? 'HEX_SE'}`;
  group.userData.sectorId = terrain.sectorId ?? 'HEX_SE';
  group.userData.poolId = pool.id;
  group.userData.lava = 'molten-sheet';
  // The shape's own numbers, so anything reading the world (the debug view, a
  // test, a later gameplay step) can see the pool without re-deriving it.
  group.userData.shoreline = { min: minRadius, max: maxRadius, mean: meanRadius, deviation };
  group.userData.level = pool.level;
  group.userData.area = area;
  group.userData.meshes = 1;
  group.userData.lights = 0;
  group.userData.particles = 0;
  group.userData.animates = false;
  group.add(mesh);

  geometry.userData.lava = {
    pool: pool.id,
    level: pool.level,
    radius: pool.radius,
    rings,
    segments,
    vertexCount,
    triangleCount: indices.length / 3,
    lavaArea: area,
    shoreline: { min: minRadius, max: maxRadius, mean: meanRadius, deviation },
  };

  return {
    group,
    mesh,
    material,
    geometry,
    pool,
    level: pool.level,
    area,
    shoreline: { radii: shoreRadii, meshRadii, min: minRadius, max: maxRadius, mean: meanRadius, deviation },
    vertexCount,
    triangleCount: indices.length / 3,
  };
}
