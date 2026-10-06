import * as THREE from 'three';
import { ForestTerrain } from './ForestTerrain.js';

/**
 * VolcanicTerrain — the ground model of HEX_SE and its collision surface.
 *
 * The southeast sector stops being a flat crimson plate and becomes a large
 * volcanic landscape: one major elevated massif with a shallow summit crater,
 * one lower basin, fissure ridges, scattered rocky ground, shallow depressions
 * and broad ash-field undulations between them. This step is deliberately
 * bare — no lava, no props, no particles — only the shape of the ground.
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
 * cone is convex (steeper below the summit, easing into the plains), the
 * basin is a flat-floored bowl, the ridges are *ridged* multifractal noise —
 * creases instead of blobs — and the roughness is confined to a few rocky
 * patches, so most of the sector remains open ground the player can cross
 * comfortably.
 *
 * Gate approaches are kept clear: every portal of the sector carries a radial
 * apron that flattens the relief to the shared floor height well before the
 * doorway, so the explorer always walks into HEX_SE on level ground.
 */

function clamp01(value) {
  return value < 0 ? 0 : (value > 1 ? 1 : value);
}

function smoothStep(value, start, end) {
  if (end <= start) return value >= end ? 1 : 0;
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
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
  // The one major elevated region: a broad cone in the south of the sector
  // with a shallow summit crater (the shape only — nothing inside it yet).
  cone: Object.freeze({
    x: 46, z: 74, radius: 96, height: 1, exponent: 1.35,
    craterRadius: 26, craterDepth: 0.34, irregularity: 0.16,
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
 * A simple gray/dark volcanic palette, per vertex: ash-gray plains, darker
 * rock pooling in the hollows and the basin, pale dry ash on the high flats
 * and slightly exposed scree wherever the ground tips. Deliberately subtle
 * and desaturated — this pass is only about reading the shape of the relief.
 */

const ROCK_BASE_TINT = new THREE.Color(0.97, 0.97, 1.0);
const ROCK_DEEP_TINT = new THREE.Color(0.56, 0.57, 0.62);
const ROCK_ASH_TINT = new THREE.Color(1.17, 1.16, 1.13);
const ROCK_SCREE_TINT = new THREE.Color(0.8, 0.8, 0.84);
const rockScratch = new THREE.Color();

export function volcanicRockTintAt(x, z, height, slope = 0) {
  const mottle = (
    Math.sin(x * 0.043 + 2.1) * Math.cos(z * 0.037 - 1.3)
    + 0.5 * Math.sin((x + z) * 0.021 + 0.6)
  ) / 1.5;
  const hollowAmount = THREE.MathUtils.smoothstep(-height, 1, 9);
  const flatness = 1 - clamp01(slope / 0.5);
  const ashAmount = THREE.MathUtils.smoothstep(height, 3.5, 13) * (0.4 + 0.6 * flatness);
  const screeAmount = THREE.MathUtils.smoothstep(slope, 0.26, 0.6);

  rockScratch.copy(ROCK_BASE_TINT);
  rockScratch.lerp(ROCK_DEEP_TINT, hollowAmount * 0.6);
  rockScratch.lerp(ROCK_ASH_TINT, ashAmount * 0.55);
  rockScratch.lerp(ROCK_SCREE_TINT, screeAmount * 0.6);
  const grain = 1 + mottle * 0.05;
  rockScratch.multiplyScalar(grain);
  return rockScratch;
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

    shape += this.coneAt(x, z, layout.cone);
    shape -= this.basinAt(x, z, layout.basin);
    for (const zone of layout.ridges) shape += this.ridgeZoneAt(x, z, zone);
    for (const patch of layout.rocks) shape += this.rockPatchAt(x, z, patch);
    for (const pit of layout.pits) shape -= this.pitAt(x, z, pit);

    return THREE.MathUtils.clamp(shape, -1.25, 1.25);
  }

  /**
   * The major elevated region: an irregular cone, convex like a real volcanic
   * edifice (steepest below the summit, easing to zero gradient on the plains)
   * with a shallow saucer at the top — the crater's shape, and nothing more.
   */
  coneAt(x, z, cone) {
    const dx = x - cone.x;
    const dz = z - cone.z;
    const distance = Math.hypot(dx, dz);
    const wobble = fbm(dx * 0.011 + 91.3, dz * 0.011 - 47.8, this.seed + 311, 3, 0.5, 2);
    const radius = cone.radius * (1 + cone.irregularity * wobble);
    const t = distance / radius;
    if (t >= 1) return 0;
    const profile = Math.pow(1 - t, cone.exponent);
    const craterT = distance / cone.craterRadius;
    const crater = craterT < 1 ? cone.craterDepth * (1 - craterT * craterT) : 0;
    return cone.height * profile - crater;
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
    for (let v = 0; v < this.vertexCount; v += 1) {
      const up = THREE.MathUtils.clamp(normals.getY(v), 1e-4, 1);
      const slope = Math.sqrt(Math.max(0, 1 - up * up)) / up;
      const tint = volcanicRockTintAt(
        this.positions[v * 3],
        this.positions[v * 3 + 2],
        this.heights[v],
        slope,
      );
      colors.setXYZ(v, tint.r, tint.g, tint.b);
    }
    colors.needsUpdate = true;

    geometry.userData.terrain = 'baked-hex-lattice-volcanic';
    geometry.userData.biome = 'volcanic-rock';
    // During the base constructor's placeholder bake the aprons do not exist
    // yet; the real bake below overwrites the count.
    geometry.userData.gateAprons = this.gateAprons?.length ?? 0;
    return geometry;
  }
}

export function createVolcanicTerrain(radius, config, sectorId = 'HEX_SE', gateAprons = []) {
  return new VolcanicTerrain({ radius, config, sectorId, gateAprons });
}
