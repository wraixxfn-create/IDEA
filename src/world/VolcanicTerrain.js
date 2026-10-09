import * as THREE from 'three';
import { planLavaBasins } from './LavaBasins.js';
import { ForestTerrain } from './ForestTerrain.js';
import { carveVolcanicVents, planVolcanicVentLayout, ventShadeAt } from './VolcanicVents.js';
import { carveLavaPool, lavaPoolShadeAt, planLavaPool } from './LavaPool.js';
import {
  carveLavaFlow,
  lavaFlowShadeAt,
  planLavaFlow,
  planLavaSecondaryFlow,
} from './LavaFlow.js';
import { planCooledCrust, writeCooledCrustAttribute } from './CooledCrust.js';
import { VOLCANIC_MATERIAL_ORDER, volcanicSurfaceAt } from './VolcanicMaterials.js';

/**
 * VolcanicTerrain — the ground model of HEX_SE and its collision surface.
 *
 * The southeast sector stops being a flat crimson plate and becomes a large
 * volcanic landscape: one major elevated massif carrying the sector's single
 * main crater, one lower basin, fissure ridges, scattered rocky ground, shallow
 * depressions and broad ash-field undulations between them. This step is
 * deliberately bare — no lava, no props, no particles — only the shape of the
 * ground.
 *
 * The module reuses the baked hexagonal lattice engine of ForestTerrain
 * (src/world/ForestTerrain.js) instead of inventing a second ground model:
 *
 *   • the sector is one welded triangular lattice whose rim is pinned to the
 *     exact shared floor height, so HEX_SE stays seamless with HEX_CENTER,
 *     HEX_NE, HEX_E and HEX_S, and no geometry ever crosses a sector edge;
 *   • `heightAt` / `normalAt` / `slopeAt` read the *same* vertex buffer the
 *     GPU draws, so what the explorer sees is what the explorer stands on;
 *   • the relief is relaxed and slope-limited at bake time, so every face of
 *     the volcanic field stays walkable (gentle slopes, no cliffs);
 *   • the whole field is seeded: one number rebuilds the same landscape, and
 *     the layout below is plain data, so the terrain can be reshaped later
 *     (or lifted into another sector) without touching the engine.
 *
 * Volcanic character comes from the composition, not from louder noise: the
 * cone is convex (steeper below the summit, easing into the plains), its top is
 * levelled into the main crater (a deep bowl ringed by a high, wandering rim),
 * the basin is a flat-floored bowl, the ridges are *ridged* multifractal noise —
 * creases instead of blobs — and the roughness is confined to a few rocky
 * patches, so most of the sector remains open ground the player can cross
 * comfortably.
 *
 * Gate approaches are kept clear: every portal of the sector carries a radial
 * apron that flattens the relief to the shared floor height well before the
 * doorway, so the explorer always walks into HEX_SE on level ground.
 *
 * The landscape is what it is before the vents arrive: `carveVolcanicVents`
 * (src/world/VolcanicVents.js) cuts a handful of small openings into the
 * already-baked lattice afterwards, so the crater, the basin and the ridges
 * keep exactly the shape this module baked and the vents ride in the same
 * surface the explorer stands on.
 *
 * The lava pool raises its own bed (src/world/LavaPool.js). A local cut
 * (src/world/LavaFlow.js) opens its main outlet through the low saddle, then
 * one much narrower branch leaves that channel for the southern low hollow.
 * Both use the same terrain/collision lattice; the rest of the relief stays
 * put. Cooled margins shade the existing basalt without props, rocks, smoke,
 * animation or gameplay effects.
 *
 * The ground immediately around that lava then wears its crust
 * (src/world/CooledCrust.js): a black, cracked, irregular plate field measured
 * from the pool's own shoreline and from both channel spines, carrying a dull
 * red heat next to the molten rock and breaking up into bare basalt a few units
 * further out. It is planned here, once the lava is final, and it is written as
 * one attribute on this same lattice — so the crust changes what the rock looks
 * like beside the lava and not one float of what the rock is.
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
 * the middle and a short rounded join at either end.
 *
 * A single smoothstep spends its whole run easing in and out, so its steepest
 * point is 1.5x its average — far too steep for a walkable crater wall once
 * the wall also has to be deep. This ramp keeps the middle at
 * `1 / (1 - join)` times the average instead, which is what a real wall looks
 * like anyway: a rounded scree apron at the bottom, a straight flank, and a
 * rounded crest at the top.
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
 * The same hash family ForestTerrain bakes with, kept local so the volcanic
 * field is seeded, stable across machines and independent of the forest.
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

/** ---- The volcanic layout ------------------------------------------------
 * Plain data, in sector-local units (the hexagon has radius 220 and apothem
 * ~190.5). `height` / `depth` / `amount` are fractions of the configured
 * amplitude, so the whole landscape scales with one number. The footprints
 * below keep clear of the four portals — which sit on the west, northwest,
 * north and northeast sides — and lean towards the walled southeast flank,
 * and the gate aprons flatten whatever still drifts near a doorway.
 */

export const DEFAULT_VOLCANIC_LAYOUT = Object.freeze({
  // The one major elevated region: a broad cone in the south of the sector.
  // Its top is not a spike and not a saucer — the main crater below owns the
  // whole summit.
  cone: Object.freeze({
    x: 46, z: 74, radius: 96, height: 1, exponent: 1.35, irregularity: 0.16,
  }),
  // The one main crater: the landmark of HEX_SE, cut into the massif's summit
  // as a single geological feature — a broad outer rim, a long inner wall and a
  // deep floor, with every radius and every crest height left slightly
  // different from its neighbours so nothing about it is a circle. Lengths are
  // sector-local units, heights are fractions of the configured amplitude (so
  // the whole crater scales with `volcanicTerrainAmplitude` like the rest of
  // the layout). `u` below is always the distance from the vent as a fraction
  // of that bearing's own rim radius.
  crater: Object.freeze({
    x: 38, z: 84,           // vent centre, a little off the massif's apex
    rimRadius: 50,          // crown radius — about 100 units across
    summitLevel: 0.462,     // level the cone's top is levelled to
    crestHeight: 0.16,      // how far the rim crest stands above that level
    depth: 0.6,             // how far the floor sinks below it at the vent
    floorDish: 0.03,        // extra dish so the floor is not a plate
    floorEdge: 0.30,        // where the floor ends and the inner wall begins (u)
    crestInner: 0.17,       // the crown's inner flank, in u
    crestOuter: 0.32,       // its outer flank, in u
    capInner: 0.95,         // the cone is levelled this far out (u)…
    capOuter: 1.35,         // …and blends back into its own flank by here
    irregularity: 0.21,     // rim-radius wobble across the bearings
    crestVariation: 0.20,   // crest height across the bearings (saddles, shoulders)
    wallRoughness: 0.09,    // gullies and ledges carved into the inner wall
    notchBearing: -2.52,    // bearing of the breach in the crown (radians)
    notchWidth: 0.7,        // how narrow the breach is
    notchDepth: 0.6,        // how much of the crest the breach takes away
    join: 0.22,             // share of the wall run spent rounding base and crest
    seedOffset: 1223,
  }),
  // The one lower basin-like region: a flat-floored bowl in the west.
  basin: Object.freeze({ x: -78, z: -22, radius: 84, depth: 0.5, irregularity: 0.12 }),
  // Elevated volcanic ridges: fissure swarms as rotated elliptical zones of
  // ridged noise, so the crests wander like dykes instead of lying in rows.
  ridges: Object.freeze([
    Object.freeze({
      x: 118, z: 34, radiusX: 78, radiusZ: 44, angle: -0.35,
      amount: 0.34, scale: 0.0135, core: 0.35, seedOffset: 401,
    }),
    Object.freeze({
      x: -34, z: 122, radiusX: 84, radiusZ: 40, angle: 0.22,
      amount: 0.3, scale: 0.0125, core: 0.35, seedOffset: 853,
    }),
  ]),
  // Several irregular rocky areas: coarse, crested roughness on a noisy
  // footprint, standing slightly proud of the plain like outcrops and scree.
  rocks: Object.freeze([
    Object.freeze({ x: -148, z: 8, radius: 34, amount: 0.26, scale: 0.055, seedOffset: 137 }),
    Object.freeze({ x: 138, z: -26, radius: 30, amount: 0.24, scale: 0.06, seedOffset: 293 }),
    Object.freeze({ x: 6, z: 148, radius: 40, amount: 0.22, scale: 0.05, seedOffset: 611 }),
    Object.freeze({ x: -58, z: -138, radius: 36, amount: 0.24, scale: 0.055, seedOffset: 719 }),
  ]),
  // Shallow depressions on the open plains.
  pits: Object.freeze([
    Object.freeze({ x: -20, z: -90, radius: 30, depth: 0.16 }),
    Object.freeze({ x: 84, z: -84, radius: 24, depth: 0.14 }),
    Object.freeze({ x: 60, z: -140, radius: 26, depth: 0.13 }),
  ]),
  // Large uneven ground formations: the slow swell of the ash plains, plus a
  // fine grit that keeps even the flat ground from reading as a table.
  undulation: Object.freeze({ scale: 168, amount: 0.17, octaves: 4 }),
  detail: Object.freeze({ scale: 46, amount: 0.07, octaves: 3 }),
});

/** Resolve the layout: `config.volcanicFeatures` overrides, defaults win out. */
export function planVolcanicLayout(config = {}) {
  const base = DEFAULT_VOLCANIC_LAYOUT;
  const override = config.volcanicFeatures;
  if (!override) return base;
  return {
    cone: { ...base.cone, ...(override.cone ?? {}) },
    crater: { ...base.crater, ...(override.crater ?? {}) },
    basin: { ...base.basin, ...(override.basin ?? {}) },
    ridges: override.ridges ?? base.ridges,
    rocks: override.rocks ?? base.rocks,
    pits: override.pits ?? base.pits,
    undulation: { ...base.undulation, ...(override.undulation ?? {}) },
    detail: { ...base.detail, ...(override.detail ?? {}) },
  };
}

/** Map the volcanic settings onto the shared lattice engine's keys. */
function volcanicLatticeConfig(config = {}) {
  return {
    forestTerrainDivisions: config.volcanicTerrainDivisions ?? 64,
    forestTerrainAmplitude: config.volcanicTerrainAmplitude ?? 18,
    forestTerrainEdgeBlend: config.volcanicTerrainEdgeBlend ?? 44,
    forestTerrainBaseScale: config.volcanicTerrainBaseScale ?? 168,
    forestTerrainOctaves: config.volcanicTerrainOctaves ?? 4,
    forestTerrainGain: config.volcanicTerrainGain ?? 0.5,
    forestTerrainLacunarity: config.volcanicTerrainLacunarity ?? 2.05,
    forestTerrainWarp: config.volcanicTerrainWarp ?? 24,
    forestTerrainRelax: config.volcanicTerrainRelax ?? 3,
    forestTerrainMaxSlopeDeg: config.volcanicTerrainMaxSlopeDeg ?? 24,
    forestTerrainSeed: config.volcanicTerrainSeed ?? 0xba5a1700,
  };
}

/** ---- Rock shading -------------------------------------------------------
 * The sector's six volcanic materials (src/world/VolcanicMaterials.js), mixed
 * per vertex out of the relief that is already there: dark volcanic soil over
 * the open plains, black basalt wherever the ground tips or a vent has blown
 * it open, dark ash settling on the high flats, cooled lava across the crater
 * floor and everywhere the lava has run, and a narrow margin of slightly
 * reddish heated rock against the molten lava itself — which stays the only
 * bright thing in HEX_SE. The variation between them is a couple of slow
 * weathering fields worth a few percent, not random colour.
 */

const rockScratch = new THREE.Color();

/**
 * The palette blend for one point of the ground, as the terrain sees it.
 * Everything this takes already exists: the relief's own height and slope, the
 * shading the vents wrote, and how close the lava is. Nothing here places a
 * feature — it only decides which of the six volcanic materials is showing.
 */
export function volcanicSurfaceSampleAt(x, z, height, slope = 0, ventThroat = 0, ventRim = 0, lavaCrust = 0, lavaEmber = 0) {
  return volcanicSurfaceAt({ x, z, height, slope, ventThroat, ventRim, lavaCrust, lavaEmber });
}

/** The blended albedo only — the vertex colour the ground is drawn with. */
export function volcanicRockTintAt(x, z, height, slope = 0, ventThroat = 0, ventRim = 0, lavaCrust = 0, lavaEmber = 0) {
  const sample = volcanicSurfaceSampleAt(x, z, height, slope, ventThroat, ventRim, lavaCrust, lavaEmber);
  return rockScratch.copy(sample.color);
}

/** ---- The terrain -------------------------------------------------------- */

export class VolcanicTerrain extends ForestTerrain {
  /**
   * `gateAprons` is the list of the sector's portal centres in sector-local
   * coordinates ({x, z}); each one keeps a flat, walkable approach clear of
   * relief. The base engine bakes inside its own constructor, before a
   * subclass field can exist, so that first pass runs against `shapeAt`'s
   * placeholder (a flat sheet) and the real landscape is baked once, here,
   * from the very same lattice engine.
   */
  constructor({ radius = 220, config = {}, sectorId = 'HEX_SE', gateAprons = [] } = {}) {
    super({ radius, config: volcanicLatticeConfig(config), sectorId });

    this.layout = planVolcanicLayout(config);
    this.apronInner = Math.max(0, config.volcanicGateApronInner ?? 19);
    this.apronOuter = Math.max(this.apronInner + 1, config.volcanicGateApronOuter ?? 58);
    this.gateAprons = gateAprons.map((apron) => Object.freeze({
      x: apron.x,
      z: apron.z,
      inner: this.apronInner,
      outer: this.apronOuter,
    }));

    this.geometry?.dispose();
    this.build();
    // The inherited bake sweeps the slope limiter a fixed number of times.
    // The volcanic field is rougher than the forest floor and presses hard
    // against the walkable cap, so keep sweeping until every lattice edge
    // converges, then re-record the heights and rebuild the geometry from the
    // same buffers. `limitSlopes` exits as soon as a pass corrects nothing.
    this.limitSlopes(96);
    this.writeHeights();
    // The vents are cut into the landscape the bake above produced — small
    // seeded openings, each one authored under the sector's slope limit, and
    // each one confined to its own footprint — so nothing the terrain has
    // already built (the crater above all) can move.
    this.vents = planVolcanicVentLayout(config);
    this.ventReport = carveVolcanicVents(this, this.vents);
    // Keep the existing pool's bed and waterline. Its original shoreline is
    // measured before the main outlet opens the enclosing bank.
    this.lavaPool = planLavaPool(config, {
      terrain: this,
      amplitude: this.amplitude,
      crater: this.layout.crater,
    });
    this.lavaPoolReport = carveLavaPool(this, this.lavaPool);
    this.writeHeights();

    // Bake the established outlet first. The smaller side-channel attaches to
    // this carved spine and is the only secondary lava feature in HEX_SE.
    this.lavaFlow = planLavaFlow(this, this.lavaPool, config);
    this.lavaFlowReport = carveLavaFlow(this, this.lavaFlow);
    this.writeHeights();
    this.lavaSecondaryFlow = planLavaSecondaryFlow(this, this.lavaFlow, config);
    this.lavaSecondaryFlowReport = carveLavaFlow(this, this.lavaSecondaryFlow);
    this.writeHeights();
    // The cooled crust is measured from the lava that is now final — the pool's
    // own shoreline and both channel spines — and it moves nothing: it writes
    // one attribute onto the lattice the ground is already drawn with, so the
    // heights, the collision surface and every statistic above stay as baked.
    this.lavaBasins = planLavaBasins(this, config);
    this.cooledCrust = planCooledCrust(this, config);
    this.geometry.dispose();
    this.geometry = this.createGeometry();
  }

  /** ---- Height field ---------------------------------------------------- */

  /**
   * Relief allowance of a point: the inherited hexagonal rim mask (1 inside,
   * 0 on every shared edge) multiplied by the gate aprons, so the terrain
   * fades to the exact shared floor height both at the sector boundary and
   * around every doorway into it.
   */
  maskAt(x, z) {
    const base = super.maskAt(x, z);
    const aprons = this.gateAprons;
    if (base <= 0 || !aprons || aprons.length === 0) return base;
    let openness = 1;
    for (const apron of aprons) {
      const distance = Math.hypot(x - apron.x, z - apron.z);
      if (distance >= apron.outer) continue;
      openness = Math.min(openness, smoothStep(distance, apron.inner, apron.outer));
      if (openness <= 0) break;
    }
    return base * openness;
  }

  /** Normalised volcanic relief in roughly [-1, 1], before mask and amplitude. */
  shapeAt(x, z) {
    const layout = this.layout;
    // Placeholder while the base constructor runs its pre-bake (see above).
    if (!layout) return 0;
    const seed = this.seed;

    // Domain warp: a slow, broad drift bends the fine fields so nothing
    // lines up with an invisible grid. Feature footprints stay where they
    // were placed — only the noise that textures them is warped.
    const warpScale = 0.62 / 190;
    const warpX = fbm(x * warpScale + 31.7, z * warpScale - 12.4, seed + 77, 3, 0.5, 2) * this.warp;
    const warpZ = fbm(x * warpScale - 44.2, z * warpScale + 58.9, seed + 913, 3, 0.5, 2) * this.warp;
    const wx = x + warpX;
    const wz = z + warpZ;

    // Large uneven ground formations and the grit that keeps flats alive.
    let shape = layout.undulation.amount
      * fbm(wx / layout.undulation.scale, wz / layout.undulation.scale,
        seed + 11, layout.undulation.octaves, 0.5, 2.05);
    shape += layout.detail.amount
      * fbm(wx / layout.detail.scale, wz / layout.detail.scale,
        seed + 29, layout.detail.octaves, 0.5, 2.1);

    const edifice = this.coneAt(x, z, layout.cone);
    shape += edifice;
    if (layout.crater) shape += this.craterAt(x, z, layout.crater, edifice);
    shape -= this.basinAt(x, z, layout.basin);
    for (const zone of layout.ridges) shape += this.ridgeZoneAt(x, z, zone);
    for (const patch of layout.rocks) shape += this.rockPatchAt(x, z, patch);
    for (const pit of layout.pits) shape -= this.pitAt(x, z, pit);

    return THREE.MathUtils.clamp(shape, -1.25, 1.25);
  }

  /**
   * The major elevated region: an irregular cone, convex like a real volcanic
   * edifice (steepest below the summit, easing to zero gradient on the plains).
   * It carries no summit shape of its own — the crater reshapes its top.
   */
  coneAt(x, z, cone) {
    const dx = x - cone.x;
    const dz = z - cone.z;
    const distance = Math.hypot(dx, dz);
    const wobble = fbm(dx * 0.011 + 91.3, dz * 0.011 - 47.8, this.seed + 311, 3, 0.5, 2);
    const radius = cone.radius * (1 + cone.irregularity * wobble);
    const t = distance / radius;
    if (t >= 1) return 0;
    return cone.height * Math.pow(1 - t, cone.exponent);
  }

  /**
   * The main crater, expressed as a delta on the cone it is cut into.
   *
   * Three shapes added together, all measured along `u` — the distance from the
   * vent as a fraction of that bearing's own, wobbled rim radius:
   *
   *   1. **Levelling** — the cone's own rise inside the crown is exchanged for
   *      a level summit, so the crater (and not the old apex) decides the shape
   *      of the whole top. Outside the crown the same term raises the ground
   *      into the broad shoulder a real rim sits on, and it is gone by the time
   *      the cone's flank takes over.
   *   2. **Crest** — the outer rim: a rounded ring ridge of varying height, so
   *      the crown is a series of shoulders and saddles instead of the lip of a
   *      bowl. The high ground of the sector is this ring.
   *   3. **Bowl** — the floor, the long inner wall and its gullies, reaching
   *      from the vent out to the foot of the crest.
   *
   * Nothing here is circular: the rim radius is wobbled per bearing, the crest
   * height varies with its own noise, and the wall is broken up by a noise
   * sampled *on the unit circle of the bearing*, so the gullies wrap the wall
   * seamlessly and no two sides of the crater climb the same way.
   */
  craterAt(x, z, crater, coneValue = 0) {
    const dx = x - crater.x;
    const dz = z - crater.z;
    const distance = Math.hypot(dx, dz);
    const rimRadius = this.craterRimRadiusAt(dx, dz, crater);
    const u = distance / rimRadius;
    if (u >= crater.capOuter) return 0;

    const join = crater.join;
    const seed = this.seed + crater.seedOffset;
    // Everything angular in this crater is measured on the *unit circle of the
    // bearing*: radius-independent, continuous in every direction round the
    // rim, and seam-free — so gullies, terraces and the breach all wrap the
    // whole circle without a join.
    const unit = distance > 1e-4 ? 1 / distance : 0;
    const bearingX = dx * unit;
    const bearingZ = dz * unit;

    // 1. Level the summit under the crater.
    const levelling = (crater.summitLevel - coneValue)
      * (1 - smoothStep(u, crater.capInner, crater.capOuter));

    // 2. The crown: a ring ridge that stands proud, lower here, higher there,
    //    and breached on one bearing — a saddle deep enough to see through,
    //    the way a real crater rim is cut by the last thing that left it.
    const shoulderNoise = fbm(dx * 0.021 - 88.3, dz * 0.021 + 44.6, seed + 733, 3, 0.5, 2);
    let crestHeight = crater.crestHeight * (1 + crater.crestVariation * 2 * shoulderNoise);
    if (crater.notchDepth > 0) {
      const alignment = bearingX * Math.cos(crater.notchBearing)
        + bearingZ * Math.sin(crater.notchBearing);
      const reach = Math.max(0, alignment);
      const notch = 1 - crater.notchDepth * Math.pow(reach, 2 / Math.max(1e-3, crater.notchWidth));
      crestHeight *= notch;
    }
    const crest = crestHeight * (
      roundedRamp(u, 1 - crater.crestInner, 1, join)
      - roundedRamp(u, 1, 1 + crater.crestOuter, join)
    );

    // 3. The bowl: floor, wall, gullies. The wall is sampled on the unit
    //    circle of the bearing, so it has no seam at any angle and the crest
    //    can vary freely without the wall ever mirroring it.
    const wallNoise = fbm(bearingX * 2.3 + 5.1, bearingZ * 2.3 - 8.4, seed + 149, 3, 0.5, 2);
    const ledgeNoise = fbm(bearingX * 5.4 - 3.7, bearingZ * 5.4 + 9.2, seed + 907, 2, 0.5, 2);
    // Terraces: sampled along the *climb* rather than around the crater, and
    // warped by the bearing noise, so each side of the wall breaks into its
    // own steps at its own heights.
    const terraceNoise = fbm(u * 4.6 + 12.3, wallNoise * 1.8 - 4.1, seed + 611, 3, 0.5, 2);
    const wallBand = smoothStep(u, crater.floorEdge * 0.6, crater.floorEdge + 0.1)
      * (1 - smoothStep(u, 0.94, 1.12));
    const gullies = crater.wallRoughness * wallBand
      * (wallNoise * 0.52 + ledgeNoise * 0.16 + terraceNoise * 0.32);

    const bowl = -crater.depth * (1 - roundedRamp(u, crater.floorEdge, 1 - crater.crestInner, join))
      - crater.floorDish * (1 - smoothStep(0, crater.floorEdge, u));

    return levelling + crest + bowl + gullies;
  }

  /**
   * The main crater's rim radius on one bearing: a coarse and a fine wobble
   * added together, so the outline is lobed at more than one scale and no two
   * radii of the crown match. The wobble alone can move the rim by a third of
   * its nominal radius.
   */
  craterRimRadiusAt(dx, dz, crater) {
    const seed = this.seed + crater.seedOffset;
    const lobes = fbm(dx * 0.0185 + 57.1, dz * 0.0185 - 33.4, seed, 3, 0.5, 2);
    const detail = fbm(dx * 0.0445 - 12.7, dz * 0.0445 + 71.9, seed + 421, 2, 0.5, 2);
    const wobble = lobes * 0.68 + detail * 0.32;
    return crater.rimRadius * (1 + crater.irregularity * wobble);
  }

  /** The lower basin: a flat-floored bowl with an irregular, feathered rim. */
  basinAt(x, z, basin) {
    const dx = x - basin.x;
    const dz = z - basin.z;
    const distance = Math.hypot(dx, dz);
    const wobble = fbm(dx * 0.013 - 21.5, dz * 0.013 + 63.2, this.seed + 577, 3, 0.5, 2);
    const radius = basin.radius * (1 + basin.irregularity * wobble);
    const t = distance / radius;
    if (t >= 1) return 0;
    // smoothStep has zero gradient at both ends: a level floor that rises
    // back onto the plains without a crease.
    return basin.depth * (1 - smoothStep(0, 1, t));
  }

  /** A fissure-ridge zone: ridged multifractal creases inside a soft ellipse. */
  ridgeZoneAt(x, z, zone) {
    const cos = Math.cos(zone.angle);
    const sin = Math.sin(zone.angle);
    const dx = x - zone.x;
    const dz = z - zone.z;
    const u = (dx * cos - dz * sin) / zone.radiusX;
    const v = (dx * sin + dz * cos) / zone.radiusZ;
    const d = Math.hypot(u, v);
    if (d >= 1) return 0;
    const zoneMask = 1 - smoothStep(zone.core ?? 0.35, 1, d);
    // Folding the noise about zero turns smooth blobs into crest lines: the
    // signature of dyke swarms and fissure ridges rather than random hills.
    const n1 = fbm(x * zone.scale + zone.seedOffset, z * zone.scale - zone.seedOffset * 0.5,
      this.seed + zone.seedOffset, 3, 0.5, 2.1);
    const n2 = fbm(x * zone.scale * 2.3 - 17.1, z * zone.scale * 2.3 + 9.4,
      this.seed + zone.seedOffset + 53, 2, 0.5, 2.1);
    const ridge = Math.pow(1 - Math.abs(n1), 2.4) * 0.78
      + Math.pow(1 - Math.abs(n2), 2.4) * 0.22;
    return zone.amount * zoneMask * ridge;
  }

  /** An irregular rocky area: coarse crested roughness on a noisy footprint. */
  rockPatchAt(x, z, patch) {
    const dx = x - patch.x;
    const dz = z - patch.z;
    const distance = Math.hypot(dx, dz);
    const wobble = fbm(dx * 0.02 - 5.5, dz * 0.02 + 8.2, this.seed + patch.seedOffset, 2, 0.5, 2);
    const radius = patch.radius * (1 + 0.22 * wobble);
    const t = distance / radius;
    if (t >= 1) return 0;
    const mask = 1 - smoothStep(0.4, 1, t);
    const rough = fbm(x * patch.scale + patch.seedOffset * 0.13,
      z * patch.scale - patch.seedOffset * 0.07,
      this.seed + patch.seedOffset + 7, 4, 0.5, 2.2);
    const bumps = rough * 0.5 + 0.5;
    const crested = Math.pow(1 - Math.abs(rough), 2);
    // Slightly negative at the low end so the outcrop also bites shallow
    // hollows into the plain instead of only sitting on top of it.
    return patch.amount * mask * (bumps * 0.8 + crested * 0.2 - 0.25);
  }

  /** A shallow depression: the same gentle bowl as the basin, plain-sized. */
  pitAt(x, z, pit) {
    const t = Math.hypot(x - pit.x, z - pit.z) / pit.radius;
    if (t >= 1) return 0;
    return pit.depth * (1 - smoothStep(0, 1, t));
  }

  /** ---- Baking ---------------------------------------------------------- */

  /** Re-shade the baked lattice as plain gray/dark volcanic rock. */
  createGeometry() {
    const geometry = super.createGeometry();
    geometry.name = `VolcanicTerrainGeometry_${this.sectorId}`;

    const normals = geometry.getAttribute('normal');
    const colors = geometry.getAttribute('color');
    // During the base constructor's placeholder bake there are no vents and no
    // pool yet; the real bake below shades them in.
    const vents = this.vents ?? [];
    const pool = this.lavaPool ?? null;
    const secondaryFlow = this.lavaSecondaryFlow ?? null;
    // Two floats per vertex — the finish and the heat — read by the sector's
    // own ground material. Shading data only: no vertex moves in this pass.
    const surface = new Float32Array(this.vertexCount * 2);
    const mix = {
      darkSoil: 0, blackBasalt: 0, darkAsh: 0, cooledLava: 0, heatedRock: 0,
    };
    for (let v = 0; v < this.vertexCount; v += 1) {
      const up = THREE.MathUtils.clamp(normals.getY(v), 1e-4, 1);
      const slope = Math.sqrt(Math.max(0, 1 - up * up)) / up;
      const shade = vents.length
        ? ventShadeAt(this.positions[v * 3], this.positions[v * 3 + 2], vents)
        : null;
      const lava = pool
        ? lavaPoolShadeAt(this.positions[v * 3], this.positions[v * 3 + 2], this.heights[v], pool)
        : null;
      const flow = lavaFlowShadeAt(this.positions[v * 3], this.positions[v * 3 + 2], this.heights[v], this.lavaFlow);
      const branch = lavaFlowShadeAt(
        this.positions[v * 3], this.positions[v * 3 + 2], this.heights[v], secondaryFlow,
      );
      const sample = volcanicSurfaceAt({
        x: this.positions[v * 3],
        z: this.positions[v * 3 + 2],
        height: this.heights[v],
        slope,
        ventThroat: shade?.throat ?? 0,
        ventRim: shade?.rim ?? 0,
        lavaCrust: Math.max(lava?.crust ?? 0, flow.crust, branch.crust),
        lavaEmber: Math.max(lava?.ember ?? 0, flow.ember, branch.ember),
      });
      const tint = sample.color;
      colors.setXYZ(v, tint.r, tint.g, tint.b);
      // The finish and the heat the blend asked for: ash is matte, soil is
      // matte-dusty, basalt a touch tighter and chilled lava almost glassy,
      // and only rock the lava is still cooking carries any emission at all.
      surface[v * 2] = sample.roughness;
      surface[v * 2 + 1] = sample.heat;
      if (sample.weights.darkSoil >= 0.5) mix.darkSoil += 1;
      if (sample.weights.blackBasalt >= 0.5) mix.blackBasalt += 1;
      if (sample.weights.darkAsh >= 0.5) mix.darkAsh += 1;
      if (sample.weights.cooledLava >= 0.5) mix.cooledLava += 1;
      if (sample.weights.heatedRock >= 0.25) mix.heatedRock += 1;
    }
    colors.needsUpdate = true;
    geometry.setAttribute('aVolcanicSurface', new THREE.BufferAttribute(surface, 2));

    geometry.userData.terrain = 'baked-hex-lattice-volcanic';
    geometry.userData.biome = 'volcanic-rock';
    // Which of the six materials the sector actually ended up wearing, as the
    // share of vertices each one dominates. Diagnostics for the material pass;
    // nothing reads it at runtime.
    geometry.userData.materials = VOLCANIC_MATERIAL_ORDER.slice();
    geometry.userData.materialMix = this.vertexCount > 0
      ? Object.fromEntries(Object.entries(mix).map(([id, count]) => [id, count / this.vertexCount]))
      : mix;
    // During the base constructor's placeholder bake the aprons do not exist
    // yet; the real bake below overwrites the count.
    geometry.userData.gateAprons = this.gateAprons?.length ?? 0;
    geometry.userData.vents = vents.length;
    geometry.userData.lavaPool = pool?.id ?? null;
    geometry.userData.lavaLevel = pool?.level ?? null;
    geometry.userData.lavaFlow = this.lavaFlow?.id ?? null;
    geometry.userData.lavaSecondaryFlow = secondaryFlow?.id ?? null;
    // The cooled crust of that lava: one four-float attribute on this same
    // lattice — coverage, heat and the crust tile's UV — written only where the
    // pool and the two channels already are, and read by the sector's own
    // material. No vertex moves, so the ground the eye sees and the ground the
    // feet stand on stay exactly the surface the bake above produced.
    const crust = this.cooledCrust ?? null;
    const crustReport = crust ? writeCooledCrustAttribute(this, crust) : null;
    if (crustReport) geometry.setAttribute('aCooledCrust', crustReport.attribute);
    this.cooledCrustReport = crustReport;
    geometry.userData.cooledCrust = crust?.id ?? null;
    geometry.userData.cooledCrustVertices = crustReport?.vertices ?? 0;
    geometry.userData.cooledCrustShare = crustReport?.share ?? 0;
    geometry.userData.cooledCrustHeat = crustReport?.hottest ?? 0;
    return geometry;
  }
}

export function createVolcanicTerrain(radius, config, sectorId = 'HEX_SE', gateAprons = []) {
  return new VolcanicTerrain({ radius, config, sectorId, gateAprons });
}
