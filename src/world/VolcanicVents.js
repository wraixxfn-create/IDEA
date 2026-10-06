/**
 * VolcanicVents — the small openings in the HEX_SE ground.
 *
 * `VolcanicTerrain` owns the shape of the sector: the massif, the single main
 * crater (about a hundred units across and thirteen deep), the basin, the
 * fissure ridges, the rocky patches and the pits. This module adds the small
 * stuff that belongs to a volcanic field and is *not* a landmark: a handful of
 * vents — the little openings a dying field leaves in its own flanks and
 * plains.
 *
 * They are carved into the same baked hexagonal lattice the terrain engine
 * already uses, after the landscape has settled, so the crater, the basin, the
 * ridges and every gate approach keep the exact shape they were baked with,
 * and a vent is ground the eye sees and the feet stand on rather than a prop
 * dropped on top of it. Nothing else about the sector changes: no particles,
 * no prop meshes, no damage, no collision volumes — the vents are a shape in
 * the rock, about two units of relief at their deepest, and about a quarter of
 * the crater's width at their widest. (The lava pool added later keeps the same
 * discipline, and the vents stay well outside its bowl.)
 *
 * A vent is one profile in a normalised coordinate `u`:
 *
 *   1. **Throat** — a funnel: a floor that climbs a wall to nothing at the lip
 *      line (`u = 1`). The wall is broken up by gullies sampled in the vent's
 *      own units, and the floor is dished so it never reads as a plate.
 *   2. **Rampart** — the low ring the vent threw up around its own lip line:
 *      zero on the lip line, a crest a fraction of a unit high just outside
 *      it, and back to nothing at the foot of the ejecta. It is uneven along
 *      its length, may lean to one side of a fissure, and may be missing where
 *      the lip has slumped.
 *
 * `u` is the distance to the vent's core — the centre of a `pit`, or the
 * wandering spine of a `crack` — divided by that bearing's own lip radius, so
 * the outline is lobed rather than round. Everything is measured on the vent's
 * own scale, which is why two vents of very different size read as the same
 * kind of landform without sharing a single number.
 *
 * Two rules keep the vents honest:
 *
 *   • **Walkable by construction.** Each profile is authored under the sector's
 *     slope limit, so the terrain's own slope limiter has (almost) nothing to
 *     correct and a vent keeps the depth it was authored with instead of being
 *     flattened after the fact. A vent is something to walk into and out of.
 *   • **Compact support.** A vent's relief is exactly zero outside its own
 *     footprint, so no lattice vertex outside it moves a bit — the main crater,
 *     the neighbouring sectors and the gate aprons cannot be touched by it.
 */

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
 * is built from (see VolcanicTerrain.js): a wall that is a scree apron, a
 * straight flank and a rounded crest, instead of one long ease in and out.
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

/** ---- Deterministic value noise ----------------------------------------
 * The same hash family the terrain engine bakes with, kept local so the vents
 * are seeded, stable across machines and independent of the terrain module.
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

/** ---- The vent layout ---------------------------------------------------
 * Plain data, in sector-local units (the hexagon has radius 220 and apothem
 * ~190.5). `depth` and `lip` are fractions of the configured amplitude, like
 * the crater's own numbers, so the vents scale with the sector's relief;
 * `radius`, the crack spines and `lipOuter` are distances in sector units.
 *
 * The seven vents are placed where the sector already has a reason for them
 * rather than spread evenly over it: two parasitic openings off the massif's
 * flanks, a fissure and the small round vent beside it on the eastern dyke
 * trend, one shallow dish on the open ash plain, one throat in the basin, and
 * one short crack out on the southern plain. They are small, they are far
 * apart, and they leave the main crater, the ridges and every gate approach
 * alone.
 */

export const VENT_DEFAULTS = Object.freeze({
  kind: 'pit',
  // How much of the run inside the lip line is flat throat floor.
  floorEdge: 0.2,
  // The rounded join of the profile ramps: 0 is a straight cone, 0.45 is all
  // curve. Small values keep small vents deep — a vent has no run to spare.
  join: 0.12,
  // How wide the ejecta ring is inside the lip line, in units of radius: the
  // ring's crest sits on the lip line, and its inner foot — where the throat
  // ends — is this far back from it.
  lipInner: 0.32,
  // How far the ejecta ring reaches beyond the lip line, in units of radius.
  lipOuter: 0.5,
  // How far the lip line itself wanders off the nominal radius.
  irregularity: 0.2,
  // How uneven the rampart is along its length (share of the lip height).
  lipVariation: 0.45,
  // Gullies in the throat wall (share of the depth).
  wallRoughness: 0.06,
  // Extra depth in the middle of the floor (share of the depth).
  floorDish: 0.16,
  // Asymmetry of a crack's ramparts: a positive value piles one side higher.
  lipBias: 0,
  // A slumped, missing piece of the ring: { bearing, depth, width }.
  breach: null,
  seedOffset: 0,
});

export const DEFAULT_VOLCANIC_VENTS = Object.freeze([
  Object.freeze({
    // The deepest of the seven, on the flat floor of the basin: a scoria vent
    // with a full, uneven ring, highest on the north side and settled away on
    // the south — the one that still looks like it threw its own ejecta.
    id: 'vent-basin-throat',
    kind: 'pit',
    x: -38,
    z: -6,
    radius: 9.5,
    depth: 0.072,
    lip: 0.029,
    lipInner: 0.34,
    lipOuter: 0.45,
    floorEdge: 0.16,
    irregularity: 0.27,
    lipVariation: 0.4,
    wallRoughness: 0.07,
    floorDish: 0.14,
    breach: Object.freeze({ bearing: 2.3, depth: 0.45, width: 0.5 }),
    seedOffset: 211,
  }),
  Object.freeze({
    // A wider, half-slumped vent on the basin's northern rim, on the low ash
    // between the bowl and the plains: the ring survives only as a shoulder on
    // one side of it.
    id: 'vent-basin-fringe',
    kind: 'pit',
    x: -76,
    z: 26,
    radius: 8,
    depth: 0.06,
    lip: 0.02,
    lipInner: 0.3,
    lipOuter: 0.42,
    floorEdge: 0.2,
    irregularity: 0.3,
    lipVariation: 0.45,
    wallRoughness: 0.08,
    floorDish: 0.18,
    breach: Object.freeze({ bearing: -0.35, depth: 0.62, width: 0.4 }),
    seedOffset: 337,
  }),
  Object.freeze({
    // The shallow one: a wide, half-filled dish out on the open ash plain south
    // of the massif, a saucer rather than a hole — a vent that has already
    // silted up, its ring no more than a pale lip.
    id: 'vent-ash-dish',
    kind: 'pit',
    x: 46,
    z: -54,
    radius: 11,
    depth: 0.032,
    lip: 0.007,
    lipInner: 0.35,
    lipOuter: 0.5,
    floorEdge: 0.45,
    irregularity: 0.24,
    lipVariation: 0.6,
    wallRoughness: 0.05,
    floorDish: 0.1,
    breach: Object.freeze({ bearing: 0.7, depth: 0.55, width: 0.6 }),
    seedOffset: 523,
  }),
  Object.freeze({
    // A small round opening in the ash below the eastern dyke: nearly no ring
    // at all, just a neat throat in the ground and one side of it slipped.
    id: 'vent-dyke-opening',
    kind: 'pit',
    x: 96,
    z: -40,
    radius: 6.5,
    depth: 0.05,
    lip: 0.015,
    lipInner: 0.3,
    lipOuter: 0.45,
    floorEdge: 0.16,
    irregularity: 0.24,
    lipVariation: 0.5,
    wallRoughness: 0.08,
    floorDish: 0.2,
    breach: Object.freeze({ bearing: -0.6, depth: 0.68, width: 0.34 }),
    seedOffset: 419,
  }),
  Object.freeze({
    // The fissure itself: a narrow crack running along the dyke trend south of
    // the eastern ridge, deepest in the middle and closing out to a point at
    // both ends, its spatter piled a little higher on the northern side.
    id: 'vent-dyke-fissure',
    kind: 'crack',
    x: 58,
    z: -26,
    radius: 6,
    depth: 0.03,
    lip: 0.011,
    lipInner: 0.55,
    lipOuter: 0.35,
    floorEdge: 0.24,
    irregularity: 0.2,
    lipVariation: 0.5,
    lipBias: 0.35,
    wallRoughness: 0.07,
    floorDish: 0.12,
    seedOffset: 641,
    spine: Object.freeze([
      Object.freeze({ x: 44, z: -21, w: 0.34, d: 0.38 }),
      Object.freeze({ x: 51, z: -24, w: 0.72, d: 0.82 }),
      Object.freeze({ x: 58, z: -27, w: 1, d: 1 }),
      Object.freeze({ x: 65, z: -30, w: 0.76, d: 0.84 }),
      Object.freeze({ x: 71, z: -32, w: 0.36, d: 0.34 }),
    ]),
  }),
  Object.freeze({
    // A second, shorter crack out on the southern plain near the shallow pits,
    // kinked halfway along and running a different way than the eastern one,
    // its ramparts heaviest on the side the ground falls away to.
    id: 'vent-south-fissure',
    kind: 'crack',
    x: 37,
    z: -106,
    radius: 5.4,
    depth: 0.026,
    lip: 0.011,
    lipInner: 0.55,
    lipOuter: 0.38,
    floorEdge: 0.24,
    irregularity: 0.22,
    lipVariation: 0.45,
    lipBias: -0.3,
    wallRoughness: 0.07,
    floorDish: 0.14,
    seedOffset: 757,
    spine: Object.freeze([
      Object.freeze({ x: 26, z: -113, w: 0.36, d: 0.34 }),
      Object.freeze({ x: 33, z: -108, w: 0.78, d: 0.86 }),
      Object.freeze({ x: 40, z: -103, w: 1, d: 1 }),
      Object.freeze({ x: 46, z: -99, w: 0.6, d: 0.62 }),
      Object.freeze({ x: 50, z: -95, w: 0.3, d: 0.26 }),
    ]),
  }),
  Object.freeze({
    // One more round opening, out on the plain between the basin and the
    // southern pits, with the deepest throat and the crispest ring of the
    // small vents — the one that has been opened most recently.
    id: 'vent-plain-opening',
    kind: 'pit',
    x: 28,
    z: -84,
    radius: 7.5,
    depth: 0.06,
    lip: 0.022,
    lipInner: 0.32,
    lipOuter: 0.5,
    floorEdge: 0.18,
    irregularity: 0.26,
    lipVariation: 0.45,
    wallRoughness: 0.07,
    floorDish: 0.16,
    seedOffset: 863,
  }),
]);

/**
 * Resolve the vents the sector should carry: `config.volcanicVents` replaces
 * the default layout when it is an array (`[]` removes them), and `false`
 * removes them outright.
 */
export function planVolcanicVentLayout(config = {}) {
  const override = config.volcanicVents;
  if (override === false || override === null) return [];
  const source = Array.isArray(override) ? override : DEFAULT_VOLCANIC_VENTS;
  return source.map((vent) => resolveVent(vent));
}

/** Merge one vent's data with the defaults and derive what the shape needs. */
function resolveVent(vent) {
  const merged = { ...VENT_DEFAULTS, ...vent };
  const seed = (0x51ed0000 ^ Math.imul(merged.seedOffset | 0, 0x9e3779b1)) >>> 0;
  const radius = Math.max(0.5, merged.radius);
  const reach = radius * (1 + merged.irregularity) * (1 + merged.lipOuter);
  const spine = merged.kind === 'crack' ? resolveSpine(merged, radius) : null;
  // Everything outside the footprint is exactly zero, so the early reject in
  // `ventSampleAt` only has to be *bigger* than the shape, never exact.
  const support = (spine ? spine.reach : 0) + reach * 1.02;
  return {
    ...merged,
    radius,
    spine,
    seed,
    // The outline wobble is sampled in sector units — the baked lattice has to
    // carry it — but at a wavelength tied to the vent itself, so a small vent
    // is just as lobed as a large one.
    wobbleScale: 1 / Math.max(2, radius * 0.9),
    support,
    supportSq: support * support,
  };
}

/** The wandering spine of a crack: points, widths and depth taper. */
function resolveSpine(vent, radius) {
  const points = (vent.spine ?? []).map((point) => ({
    x: point.x,
    z: point.z,
    width: Math.max(0.15, point.w ?? 1),
    depth: Math.max(0.1, point.d ?? 1),
  }));
  if (points.length < 2) {
    // A crack without a spine is a pit: fall back to a two-point line through
    // the centre so an authored mistake still carves something sane.
    points.length = 0;
    points.push({ x: vent.x - radius * 4, z: vent.z, width: 0.4, depth: 0.4 });
    points.push({ x: vent.x + radius * 4, z: vent.z, width: 0.4, depth: 0.4 });
  }
  const segments = [];
  let reach = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.max(1e-4, Math.hypot(dx, dz));
    segments.push({ ax: a.x, az: a.z, dx, dz, length, a, b });
    reach = Math.max(reach, Math.hypot(a.x - vent.x, a.z - vent.z), Math.hypot(b.x - vent.x, b.z - vent.z));
  }
  return { points, segments, reach };
}

/** ---- The shape -------------------------------------------------------- */

/**
 * The vent's own fields at a sector-local point, or `null` outside it.
 *
 * `u` is the normalised distance to the core — 0 on the core, 1 on the lip
 * line — after the vent's irregularities are applied. `throat` is the funnel
 * (1 on the floor, 0 at the lip line), `rampart` is the ejecta ring (0 on the
 * lip line, 1 on its crest), `lipMask` is how much of that ring is really
 * there on this bearing, and `wall` is the gully modulation of the wall.
 */
export function ventSampleAt(x, z, vent) {
  const dx = x - vent.x;
  const dz = z - vent.z;
  if (dx * dx + dz * dz > vent.supportSq) return null;

  // All of the vent's own noise is sampled in *sector units* with wavelengths
  // a couple of lattice cells long: long enough for the baked surface to carry
  // them, short enough that a vent's outline is lobed several times over.
  const wobble = fbm(x * vent.wobbleScale + 12.4, z * vent.wobbleScale - 6.8, vent.seed, 2, 0.45, 2);

  // 1. How far the point sits from the vent's core, in its own units, and the
  //    taper the core carries there (a fissure closes out at its tips).
  let u;
  let depthScale = 1;
  let side = 0;
  if (vent.spine) {
    let best = Infinity;
    let bestSegment = null;
    let bestT = 0;
    for (const segment of vent.spine.segments) {
      const t = clamp01(((x - segment.ax) * segment.dx + (z - segment.az) * segment.dz) / (segment.length * segment.length));
      const px = segment.ax + segment.dx * t;
      const pz = segment.az + segment.dz * t;
      const distance = Math.hypot(x - px, z - pz);
      if (distance < best) {
        best = distance;
        bestSegment = segment;
        bestT = t;
      }
    }
    if (!bestSegment) return null;
    const width = bestSegment.a.width + (bestSegment.b.width - bestSegment.a.width) * bestT;
    depthScale = bestSegment.a.depth + (bestSegment.b.depth - bestSegment.a.depth) * bestT;
    u = best / (width * vent.radius);
    // Which side of the spine the point lies on: what a fissure's own ramparts
    // are measured against.
    side = ((x - bestSegment.ax) * -bestSegment.dz + (z - bestSegment.az) * bestSegment.dx) / bestSegment.length;
  } else {
    u = Math.hypot(dx, dz) / vent.radius;
  }

  // 2. The lip line wanders, so no two bearings of the same vent agree on
  //    where the rim is — the outline is lobed instead of round.
  u *= 1 + vent.irregularity * wobble;
  if (u >= 1 + vent.lipOuter) return null;

  // 3. The throat: a floor, a wall climbing out of it, and the inner foot of
  //    the ring where the wall runs out. The wall is broken up by its own
  //    gullies and the floor is dished, so neither reads as a mould.
  const lipFoot = 1 - vent.lipInner;
  const wall = fbm(x * 0.2 - 4.1, z * 0.2 + 9.3, vent.seed + 97, 2, 0.45, 2);
  const floorMask = 1 - smoothStep(u, 0, vent.floorEdge);
  const throat = (1 - roundedRamp(u, vent.floorEdge, lipFoot, vent.join))
    * (1 + vent.wallRoughness * wall)
    * (1 + vent.floorDish * floorMask);

  // 4. The rampart: the ring the vent threw up around its own lip line. It
  //    starts where the throat ends (so the two never stack into one very
  //    steep face), crests on the lip line and wears out to nothing by the
  //    foot of its ejecta — the crater's own crest, at a vent's scale.
  const rampart = roundedRamp(u, lipFoot, 1, vent.join)
    - roundedRamp(u, 1, 1 + vent.lipOuter, vent.join);

  // 5. How much of that ring is there on this bearing. A pit is uneven around
  //    its rim and may be slumped on one side of it; a fissure is uneven along
  //    its length and may have thrown its spatter to one side.
  const rimNoise = vent.spine
    ? fbm(x * 0.13 + 3.3, side * 0.2 - 1.1, vent.seed + 53, 2, 0.45, 2)
    : fbm(x * 0.13 + 5.5, z * 0.13 - 2.7, vent.seed + 53, 2, 0.45, 2);
  let lipMask = 1 + vent.lipVariation * rimNoise;
  if (vent.lipBias !== 0 && vent.spine) {
    lipMask *= 1 + vent.lipBias * Math.tanh(side * 0.9);
  }
  if (vent.breach) {
    const radius = Math.hypot(dx, dz);
    const bearingX = radius > 1e-4 ? dx / radius : 0;
    const bearingZ = radius > 1e-4 ? dz / radius : 0;
    const alignment = Math.max(0, bearingX * Math.cos(vent.breach.bearing)
      + bearingZ * Math.sin(vent.breach.bearing));
    lipMask *= 1 - vent.breach.depth * Math.pow(alignment, 2 / Math.max(1e-3, vent.breach.width));
  }

  return { u, throat, rampart, lipMask: Math.max(0, lipMask), wall, depthScale };
}

/**
 * The relief a vent adds to the ground at a sector-local point, in sector
 * units. Positive where the ring stands, negative inside the throat, and
 * *exactly* zero outside the vent's footprint.
 */
export function ventReliefAt(x, z, vent, amplitude = 1) {
  const sample = ventSampleAt(x, z, vent);
  if (!sample) return 0;
  const ring = vent.lip * sample.rampart * sample.lipMask;
  const throat = vent.depth * sample.throat;
  return amplitude * sample.depthScale * (ring - throat);
}

/**
 * What the vents do to the ground at a point, as shares of the shape rather
 * than heights: 1 means the point is on a vent's floor, or on the crest of its
 * ring. The terrain shades the rock with this, so a vent reads as a dark
 * throat with a pale scoria ring whatever its size and depth.
 */
export function ventShadeAt(x, z, vents) {
  let throat = 0;
  let rim = 0;
  for (const vent of vents) {
    const sample = ventSampleAt(x, z, vent);
    if (!sample) continue;
    const depth = sample.throat * sample.depthScale;
    if (depth > throat) throat = depth;
    const ring = sample.rampart * sample.lipMask * sample.depthScale;
    if (ring > rim) rim = ring;
  }
  return { throat, rim };
}

/** ---- Carving ----------------------------------------------------------- */

/**
 * The terrain's own walkability sweep, restricted to the vents.
 *
 * `ForestTerrain.limitSlopes` splits a too-steep lattice edge between both of
 * its ends. Run over the whole lattice after the carve it would also carry on
 * converging the floats of the rest of the sector (the bake settles by a few
 * millionths of a unit per pass), which would mean the main crater could
 * technically move. This version locks every vertex outside the vents the way
 * the base sweep locks the sector rim, so a vent that was authored too steep
 * is flattened into its own footprint and nothing else in HEX_SE can shift by
 * so much as one float.
 */
function limitVentSlopes(terrain, inVent, passes = 64) {
  const { heights, indices, isRim } = terrain;
  const limit = terrain.maxSlope * terrain.cellSize;
  const locked = (v) => !inVent[v] || isRim[v];
  for (let pass = 0; pass < passes; pass += 1) {
    let corrections = 0;
    for (let t = 0; t < indices.length; t += 3) {
      for (let edge = 0; edge < 3; edge += 1) {
        const a = indices[t + edge];
        const b = indices[t + ((edge + 1) % 3)];
        if (!inVent[a] && !inVent[b]) continue;
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
        corrections += 1;
      }
    }
    if (corrections === 0) break;
  }
}

/**
 * Carve the vents into a baked terrain and re-limit its slopes.
 *
 * The terrain must have been baked (`build()` + `writeHeights()`) before this
 * runs: a vent is a modification *of* the landscape, not a feature inside the
 * height field, which is what keeps the main crater and every other baked
 * feature bit-for-bit what it was. Only vertices inside a vent's footprint are
 * touched, the sector's own mask still fades the relief out at the boundary
 * and over the gate aprons, and the limiter runs afterwards so the surface
 * still keeps the engine's walkability guarantee. The caller writes the
 * heights through to the geometry (`writeHeights()`, `createGeometry()`).
 *
 * Returns one report per vent: what it was authored to be, and what the baked
 * surface actually ended up doing.
 */
export function carveVolcanicVents(terrain, vents = terrain?.vents ?? []) {
  if (!vents.length || !terrain) return [];
  const { positions, heights, isRim } = terrain;
  const amplitude = terrain.amplitude;
  // Every vertex the vents touch, with the height it had before them: what is
  // left of the authored relief after the limiter is a measurement of the vent
  // itself rather than of the slope it happens to sit on.
  const touched = [];
  // Which vertices are inside a vent at all. Everything else is *locked*: the
  // limiter below is the terrain's own walkability sweep with the rest of the
  // sector pinned, so the vents reshape their own footprints and not one
  // millimetre of anything else — the crater above all.
  const inVent = new Uint8Array(terrain.vertexCount);

  for (let v = 0; v < terrain.vertexCount; v += 1) {
    if (isRim[v]) continue;
    const x = positions[v * 3];
    const z = positions[v * 3 + 2];
    let relief = 0;
    let owner = -1;
    let reach = 0;
    for (let i = 0; i < vents.length; i += 1) {
      const value = ventReliefAt(x, z, vents[i], amplitude);
      if (value === 0) continue;
      relief += value;
      if (Math.abs(value) > reach) {
        reach = Math.abs(value);
        owner = i;
      }
    }
    if (owner < 0) continue;
    touched.push({ index: v, owner, before: heights[v] });
    inVent[v] = 1;
    // The same mask that flattens the sector's rim and its gate approaches:
    // a vent can never reach a shared edge or a doorway, whatever it is
    // authored to do.
    heights[v] += relief * terrain.maskAt(x, z);
  }

  // The vents are authored under the slope limit, so this pass has little or
  // nothing to correct; it is here so the guarantee holds whatever a layout
  // asks for. Where it does have to correct something, it takes it out of the
  // vent rather than out of the surrounding ground.
  limitVentSlopes(terrain, inVent);

  const report = vents.map((vent) => ({
    id: vent.id,
    kind: vent.kind,
    x: vent.x,
    z: vent.z,
    radius: vent.radius,
    footprintRadius: vent.support,
    authoredRelief: (vent.depth + vent.lip) * amplitude,
    depth: 0,
    rim: 0,
    vertices: 0,
  }));

  for (const entry of touched) {
    const change = heights[entry.index] - entry.before;
    const vent = report[entry.owner];
    vent.vertices += 1;
    if (change < 0) {
      if (-change > vent.depth) vent.depth = -change;
    } else if (change > vent.rim) {
      vent.rim = change;
    }
  }

  return report;
}
