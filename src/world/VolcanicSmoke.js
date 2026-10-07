import * as THREE from 'three';
import { makeRandom, between } from './random.js';
import { measureLavaPoolShoreline } from './LavaPool.js';
import { resolveSunDirection } from './SkyDome.js';

/**
 * VolcanicSmoke — the subtle smoke and steam of HEX_SE.
 *
 * The sector already has its ground, its crater, its vents, its cracks and its
 * lava. This module adds only the breath of that field: a few columns of dark
 * volcanic smoke rising from the crater, from the breach it leaves the lava
 * through and from three small vents, and a few thin, pale wisps of steam over
 * two cracks and the hot margins of the molten rock. Nothing else changes.
 *
 * Three decisions shape it.
 *
 * 1. **Sources are data, anchored to the features they belong to.** Each source
 *    (see `VOLCANIC_SMOKE_DEFAULTS.sources`) names what it is cut from — the
 *    crater's own vent, the breach in its rim, a small vent by id, a stretch
 *    of a fissure's spine, a stretch of a lava channel, or a bearing on the
 *    pool's shoreline. The anchors are resolved against the baked terrain once,
 *    at build time, so a plume always rises from the ground (or the lava) it is
 *    named for, and the layout can move with the terrain without a hand-placed
 *    coordinate going stale.
 *
 * 2. **The particles live on the GPU.** Every puff is one billboard quad drawn
 *    from one instanced mesh per kind — one for smoke, one for steam — so the
 *    whole sector costs two draw calls. The two materials share one noise
 *    texture, one quad and one clock. A puff's origin, seed and shape are written once, into
 *    instanced attributes. Its rise, its drift, its spread, its wobble, its
 *    growth and its fade are all computed in the vertex shader from a single
 *    clock uniform, so per frame the CPU does exactly one float write. There
 *    are no emitter objects, no per-particle updates and no buffer uploads.
 *
 * 3. **Each puff loops, but never the same way twice.** A puff restarts when its
 *    life runs out, and every restart draws a new heading, spread and noise
 *    offset from a hash of the loop number. A plume is therefore a continuous,
 *    shifting column rather than a chain of identical bubbles, and nothing
 *    repeats on a visible period.
 *
 * Keeping the view clear is part of the design. Puffs fade out as they come
 * within about 7 units of the camera, so a plume never sits in the lens; they
 * dissolve again far away; and both kinds are small, thin and low in opacity, so a
 * sector with its plumes standing in it still reads as open ground underneath.
 * Smoke is dark, lit by the sun on the side it faces and warmed for a moment by
 * the lava at its foot; steam is pale, thinner, shorter-lived and wispier, so it
 * never reads as a second copy of the smoke.
 *
 * The module is inert in every other sense: no collider, no light, no damage,
 * no sound and no gameplay of any kind. It writes no height, no attribute and
 * no matrix into the terrain, the rocks, the debris, the lava or the crust.
 */

const TAU = Math.PI * 2;
const clamp01 = (value) => (value < 0 ? 0 : (value > 1 ? 1 : value));
const mix = (a, b, t) => a + (b - a) * t;

/**
 * The defaults. Plain data: the look of each kind, the breeze, the camera
 * fade and the sources themselves. `sources` replaces the list when given.
 *
 * Every source is one plume or one wisp field:
 *   • `anchor`  — what it is cut from (see `resolveEmitter`);
 *   • `puffs`   — how many puffs carry it (its density along the column);
 *   • `height`  — how far a puff rises over its life, in units;
 *   • `size`    — a puff's diameter at full growth, in units;
 *   • `spread`  — how far a puff drifts sideways over its life, in units;
 *   • `wobble`  — the meander amplitude of the column, in units;
 *   • `jitter`  — the radius the puffs are scattered over at their origin;
 *   • `opacity` — a multiplier on the kind's puff opacity;
 *   • `life`    — a multiplier on the kind's puff life;
 *   • `warm`    — how much the lava warms the puffs as they leave it.
 */
export const VOLCANIC_SMOKE_DEFAULTS = Object.freeze({
  seed: 0x5a0c3e1,
  // The shared noise tile every puff samples: one seamless texture, built once.
  noiseSize: 128,
  // The horizontal drift of the air, in units per second. Shared by both kinds,
  // so the steam and the smoke lean the same way.
  breeze: Object.freeze({ x: 0.85, z: 0.4 }),
  // Puffs fade out inside `cameraNear`, are fully visible from `cameraFull`
  // out, and dissolve again as they approach `cameraFar`.
  cameraNear: 7,
  cameraFull: 18,
  cameraFar: 240,
  smoke: Object.freeze({
    life: Object.freeze([9, 14]),
    opacity: 0.085,
    // How the rise eases off. Close to 1 the column climbs evenly, so its base
    // is as dense as its middle; well above 1 the puffs would bunch up at the
    // top instead.
    riseCurve: 1.15,
    stretch: 1.0,
    edge: 0.2,
    bias: 0,
    wobbleSpeed: 0.6,
    shadow: 0x3b3834,
    light: 0xa39e96,
    warm: 0xff7a3a,
    warmStrength: 0.4,
  }),
  steam: Object.freeze({
    life: Object.freeze([3.2, 5.2]),
    opacity: 0.07,
    riseCurve: 1.0,
    // Steam is drawn a little taller than it is wide, with a nearly full disc.
    stretch: 1.35,
    edge: 0.06,
    // Lifts the body of the puff: the steam tile is mostly dark ridges, so
    // without this lift the wisps would thin out to almost nothing.
    bias: 0.25,
    wobbleSpeed: 1.6,
    shadow: 0xaebfc6,
    light: 0xf5f9fa,
    warm: 0xffe6d2,
    warmStrength: 0.12,
  }),
  sources: Object.freeze([
    // --- The main crater: the plume over the lake, the landmark of the sector.
    Object.freeze({
      id: 'smoke-crater-vent',
      kind: 'smoke',
      anchor: Object.freeze({ on: 'crater' }),
      puffs: 90,
      height: 40,
      size: 8.5,
      spread: 4.5,
      wobble: 1.2,
      jitter: 5.5,
      opacity: 0.9,
      warm: 1,
    }),
    // The breach: the low saddle the lava leaves the crater through, so a
    // smaller plume goes up beside the outflow.
    Object.freeze({
      id: 'smoke-crater-breach',
      kind: 'smoke',
      anchor: Object.freeze({ on: 'crater-breach' }),
      puffs: 44,
      height: 30,
      size: 6.5,
      spread: 3.4,
      wobble: 1.0,
      jitter: 2.5,
      opacity: 0.7,
      warm: 0.8,
    }),
    // Three of the small vents: a thin, slow thread from each throat.
    Object.freeze({
      id: 'smoke-basin-throat',
      kind: 'smoke',
      anchor: Object.freeze({ on: 'vent', id: 'vent-basin-throat' }),
      puffs: 14,
      height: 16,
      size: 4.2,
      spread: 1.8,
      wobble: 0.6,
      jitter: 1.4,
      opacity: 1,
      warm: 0.5,
    }),
    Object.freeze({
      id: 'smoke-plain-opening',
      kind: 'smoke',
      anchor: Object.freeze({ on: 'vent', id: 'vent-plain-opening' }),
      puffs: 16,
      height: 19,
      size: 4.6,
      spread: 2,
      wobble: 0.6,
      jitter: 1.8,
      opacity: 1,
      warm: 0.6,
    }),
    Object.freeze({
      id: 'smoke-dyke-opening',
      kind: 'smoke',
      anchor: Object.freeze({ on: 'vent', id: 'vent-dyke-opening' }),
      puffs: 12,
      height: 14,
      size: 3.8,
      spread: 1.5,
      wobble: 0.5,
      jitter: 1.3,
      opacity: 0.9,
      warm: 0.4,
    }),
    // --- Steam: pale wisps along two cracks and over the hot margins of lava.
    Object.freeze({
      id: 'steam-dyke-fissure',
      kind: 'steam',
      anchor: Object.freeze({ on: 'crack', id: 'vent-dyke-fissure', from: 0.12, to: 0.88 }),
      puffs: 26,
      height: 7,
      size: 3.2,
      spread: 1.6,
      wobble: 0.5,
      jitter: 0.5,
      opacity: 1,
      warm: 0.3,
    }),
    Object.freeze({
      id: 'steam-south-fissure',
      kind: 'steam',
      anchor: Object.freeze({ on: 'crack', id: 'vent-south-fissure', from: 0.15, to: 0.85 }),
      puffs: 18,
      height: 6,
      size: 3,
      spread: 1.4,
      wobble: 0.5,
      jitter: 0.5,
      opacity: 0.9,
      warm: 0.3,
    }),
    Object.freeze({
      id: 'steam-branch',
      kind: 'steam',
      anchor: Object.freeze({ on: 'flow', id: 'lava-secondary-flow-hex-se', from: 0.4, to: 0.55 }),
      puffs: 14,
      height: 5,
      size: 2.6,
      spread: 1.2,
      wobble: 0.4,
      jitter: 0.6,
      opacity: 0.9,
      warm: 0.6,
    }),
    Object.freeze({
      id: 'steam-pool-margin',
      kind: 'steam',
      anchor: Object.freeze({ on: 'pool', bearing: -0.25, reach: 1.02 }),
      puffs: 14,
      height: 6,
      size: 3.2,
      spread: 1.6,
      wobble: 0.5,
      jitter: 2,
      opacity: 0.9,
      warm: 0.6,
    }),
  ]),
});

/**
 * Resolve the settings the sector should carry: `config.volcanicSmokeEnabled`
 * switches the whole effect off, `config.volcanicSmoke` overrides the defaults
 * (`false` or `null` removes it outright), and an override's `smoke` / `steam`
 * blocks merge key by key.
 */
export function resolveVolcanicSmokeSettings(config = {}) {
  const override = config.volcanicSmoke;
  if (config.volcanicSmokeEnabled === false || override === false || override === null) return null;
  const extra = override && typeof override === 'object' ? override : {};
  return {
    ...VOLCANIC_SMOKE_DEFAULTS,
    ...extra,
    breeze: { ...VOLCANIC_SMOKE_DEFAULTS.breeze, ...(extra.breeze ?? {}) },
    smoke: { ...VOLCANIC_SMOKE_DEFAULTS.smoke, ...(extra.smoke ?? {}) },
    steam: { ...VOLCANIC_SMOKE_DEFAULTS.steam, ...(extra.steam ?? {}) },
    sources: Array.isArray(extra.sources) ? extra.sources : VOLCANIC_SMOKE_DEFAULTS.sources,
  };
}

/* ---- Anchors -------------------------------------------------------------
 * Each anchor resolves to an emitter, measured on the baked terrain:
 *
 *   • `area` emitters are a point (or a small disc) on the ground or on the
 *     lava. Every puff takes the surface height under its own origin, so a
 *     plume over the lake rises from the lake and one over the rock rises from
 *     the rock.
 *   • `line` emitters run between two points on a crack or a channel. Every
 *     puff takes a random place along the run, at the height of the line there.
 */

/** Lookup tables the anchors read from, built once per planning pass. */
function createAnchorContext(terrain) {
  const crater = terrain.layout?.crater ?? null;
  const pool = terrain.lavaPool ?? null;
  const shoreline = pool
    ? (terrain.lavaFlow?.sourceShoreline ?? measureLavaPoolShoreline(terrain, pool))
    : null;
  const vents = new Map((terrain.vents ?? []).map((vent) => [vent.id, vent]));
  const flows = new Map();
  for (const flow of [terrain.lavaFlow, terrain.lavaSecondaryFlow]) {
    if (flow) flows.set(flow.id, flow);
  }
  return { terrain, crater, pool, shoreline, vents, flows };
}

/** The measured shoreline's radius on the bearing of a point (interpolated). */
function shoreRadiusAt(ctx, bearing) {
  const radii = ctx.shoreline.radii;
  const count = radii.length;
  const at = ((bearing % TAU) + TAU) % TAU / TAU * count;
  const index = Math.floor(at) % count;
  return mix(radii[index], radii[(index + 1) % count], at - Math.floor(at));
}

function insideLake(ctx, x, z) {
  if (!ctx.pool || !ctx.shoreline) return false;
  const dx = x - ctx.pool.x;
  const dz = z - ctx.pool.z;
  return Math.hypot(dx, dz) < shoreRadiusAt(ctx, Math.atan2(dz, dx));
}

/** The surface a puff rises from at a sector-local point: lake or ground. */
function surfaceYAt(ctx, x, z) {
  if (insideLake(ctx, x, z)) return ctx.pool.level + ctx.pool.lift;
  return ctx.terrain.heightAt(x, z) + 0.12;
}

/** A point on the baked rim of the crater, on the bearing it is asked for. */
function craterRimPoint(ctx, bearing) {
  const crater = ctx.crater;
  const dx = Math.cos(bearing);
  const dz = Math.sin(bearing);
  // The rim's radius is measured at the point itself, so a few fixed-point
  // passes settle it on the crown the terrain actually has on this bearing.
  let radius = crater.rimRadius;
  for (let pass = 0; pass < 3; pass += 1) {
    radius = ctx.terrain.craterRimRadiusAt(dx * radius, dz * radius, crater);
  }
  return { x: crater.x + dx * radius, z: crater.z + dz * radius };
}

/** A point at a fraction of a polyline's length (points: {x, z}). */
function polylinePointAt(points, fraction) {
  if (!points || points.length === 0) return null;
  if (points.length === 1) return { x: points[0].x, z: points[0].z };
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  const target = clamp01(fraction) * total;
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (walked + length >= target || i === points.length - 1) {
      const t = length > 0 ? clamp01((target - walked) / length) : 0;
      return { x: mix(a.x, b.x, t), z: mix(a.z, b.z, t) };
    }
    walked += length;
  }
  return null;
}

/** A point along a lava channel's own samples, with the surface height there. */
function flowPointAt(flow, fraction) {
  const samples = flow.samples;
  if (!samples || samples.length === 0) return null;
  const at = clamp01(fraction) * (samples.length - 1);
  const i = Math.floor(at);
  const j = Math.min(samples.length - 1, i + 1);
  const t = at - i;
  const a = samples[i];
  const b = samples[j];
  return { x: mix(a.x, b.x, t), z: mix(a.z, b.z, t), y: mix(a.y, b.y, t) + 0.06 };
}

/**
 * Turn an anchor into an emitter, or `null` if the feature it names is not in
 * this world (a disabled channel, an unknown vent, a sector with no pool).
 */
function resolveEmitter(ctx, anchor = {}) {
  if (!ctx) return null;
  switch (anchor.on) {
    case 'crater': {
      if (!ctx.crater) return null;
      return { type: 'area', a: { x: ctx.crater.x, z: ctx.crater.z }, b: { x: ctx.crater.x, z: ctx.crater.z } };
    }
    case 'crater-breach': {
      if (!ctx.crater) return null;
      const point = craterRimPoint(ctx, ctx.crater.notchBearing);
      return { type: 'area', a: point, b: point };
    }
    case 'crater-rim': {
      if (!ctx.crater || !Number.isFinite(anchor.bearing)) return null;
      const point = craterRimPoint(ctx, anchor.bearing);
      return { type: 'area', a: point, b: point };
    }
    case 'vent': {
      const vent = ctx.vents.get(anchor.id);
      if (!vent) return null;
      return { type: 'area', a: { x: vent.x, z: vent.z }, b: { x: vent.x, z: vent.z } };
    }
    case 'crack': {
      const vent = ctx.vents.get(anchor.id);
      const points = vent?.spine?.points;
      if (!points) return null;
      const a = polylinePointAt(points, anchor.from ?? 0);
      const b = polylinePointAt(points, anchor.to ?? 1);
      if (!a || !b) return null;
      return {
        type: 'line',
        a: { x: a.x, z: a.z, y: ctx.terrain.heightAt(a.x, a.z) + 0.12 },
        b: { x: b.x, z: b.z, y: ctx.terrain.heightAt(b.x, b.z) + 0.12 },
      };
    }
    case 'flow': {
      const flow = ctx.flows.get(anchor.id);
      if (!flow) return null;
      const a = flowPointAt(flow, anchor.from ?? 0);
      const b = flowPointAt(flow, anchor.to ?? 1);
      if (!a || !b) return null;
      return { type: 'line', a, b };
    }
    case 'pool': {
      if (!ctx.pool || !ctx.shoreline || !Number.isFinite(anchor.bearing)) return null;
      const radius = shoreRadiusAt(ctx, anchor.bearing) * (anchor.reach ?? 1);
      const point = {
        x: ctx.pool.x + Math.cos(anchor.bearing) * radius,
        z: ctx.pool.z + Math.sin(anchor.bearing) * radius,
      };
      return { type: 'area', a: point, b: point };
    }
    default:
      return null;
  }
}

/* ---- Puffs ---------------------------------------------------------------- */

function seedOf(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Write one source's puffs into the kind's buffers, starting at `offset`.
 * Everything a puff is — where it is born, how long it lives, how high it
 * rises, how far it spreads, how it meanders, how big it grows and how dense
 * it is — is decided here, once, from the source's own seeded stream.
 */
function writeSourcePuffs(ctx, source, kindLook, buffers, offset, seed) {
  const random = makeRandom(seed);
  const jitter = Math.max(0, source.jitter ?? 1);
  const { origin, seeds, shape, motion, twist } = buffers;
  for (let n = 0; n < source.puffs; n += 1) {
    const index = offset + n;
    const along = random();
    const { a, b } = source.emitter;
    let x = mix(a.x, b.x, along);
    let z = mix(a.z, b.z, along);
    const ring = jitter * Math.sqrt(random());
    const ringAngle = random() * TAU;
    x += Math.cos(ringAngle) * ring;
    z += Math.sin(ringAngle) * ring;
    const y = source.emitter.type === 'area'
      ? surfaceYAt(ctx, x, z)
      : mix(a.y, b.y, along) + between(random, -0.05, 0.05);

    const life = between(random, kindLook.life[0], kindLook.life[1]) * (source.life ?? 1);
    const rise = source.height * between(random, 0.8, 1.2);
    const phase = random();
    const tone = random();
    const noiseX = random();
    const noiseY = random();
    const sizeBirth = source.size * between(random, 0.4, 0.6);
    const sizeFull = source.size * between(random, 0.85, 1.25);
    const spread = source.spread * between(random, 0.6, 1.25);
    const wobbleSpeed = kindLook.wobbleSpeed * between(random, 0.7, 1.3);
    const wobbleAmount = source.wobble * between(random, 0.5, 1.3);
    const opacity = kindLook.opacity * (source.opacity ?? 1) * between(random, 0.65, 1.15);
    const twistSeed = random();
    const wobblePhase = random() * TAU;

    origin[index * 3] = x;
    origin[index * 3 + 1] = y;
    origin[index * 3 + 2] = z;
    seeds[index * 4] = phase;
    seeds[index * 4 + 1] = tone;
    seeds[index * 4 + 2] = noiseX;
    seeds[index * 4 + 3] = noiseY;
    shape[index * 4] = life;
    shape[index * 4 + 1] = rise;
    shape[index * 4 + 2] = sizeBirth;
    shape[index * 4 + 3] = sizeFull;
    motion[index * 4] = spread;
    motion[index * 4 + 1] = wobbleSpeed;
    motion[index * 4 + 2] = wobbleAmount;
    motion[index * 4 + 3] = opacity;
    twist[index * 2] = twistSeed;
    twist[index * 2 + 1] = wobblePhase;
  }
}

function createBuffers(count) {
  return {
    count,
    origin: new Float32Array(count * 3),
    seeds: new Float32Array(count * 4),
    shape: new Float32Array(count * 4),
    motion: new Float32Array(count * 4),
    twist: new Float32Array(count * 2),
  };
}

/**
 * Plan the whole effect without making a single GPU object: which sources
 * resolve, how many puffs each kind carries, and every puff's numbers. The
 * plan *is* the effect — rebuilding it from the same terrain reproduces it.
 */
export function planVolcanicSmoke(terrain, config = {}) {
  if (!terrain || terrain.sectorId !== 'HEX_SE') return null;
  const settings = resolveVolcanicSmokeSettings(config);
  if (!settings) return null;

  const ctx = createAnchorContext(terrain);
  const sources = [];
  const skipped = [];
  for (const definition of settings.sources) {
    const emitter = resolveEmitter(ctx, definition.anchor);
    const puffs = Math.round(definition.puffs ?? 0);
    if (!emitter || puffs <= 0) {
      skipped.push(definition.id);
      continue;
    }
    sources.push({
      ...definition,
      kind: definition.kind === 'steam' ? 'steam' : 'smoke',
      emitter,
      puffs,
    });
  }

  const totals = { smoke: 0, steam: 0 };
  for (const source of sources) totals[source.kind] += source.puffs;
  const buffers = {
    smoke: createBuffers(totals.smoke),
    steam: createBuffers(totals.steam),
  };
  const cursor = { smoke: 0, steam: 0 };
  const placed = [];
  for (const source of sources) {
    const offset = cursor[source.kind];
    const seed = (seedOf(source.id) ^ settings.seed) >>> 0;
    writeSourcePuffs(ctx, source, settings[source.kind], buffers[source.kind], offset, seed);
    cursor[source.kind] += source.puffs;
    placed.push({
      id: source.id,
      kind: source.kind,
      anchor: source.anchor.on,
      emitter: source.emitter.type,
      puffs: source.puffs,
      offset,
      height: source.height,
      size: source.size,
      spread: source.spread,
      jitter: source.jitter ?? 1,
      opacity: source.opacity ?? 1,
      // The area a source can reach on the ground, for the coverage budget.
      reach: (source.jitter ?? 1) + source.spread + source.size,
      length: Math.hypot(
        source.emitter.b.x - source.emitter.a.x,
        source.emitter.b.z - source.emitter.a.z,
      ),
    });
  }

  return {
    settings,
    sources: placed,
    skipped,
    buffers,
    puffCount: totals.smoke + totals.steam,
    smokePuffs: totals.smoke,
    steamPuffs: totals.steam,
  };
}

/* ---- Shared resources ----------------------------------------------------- */

function hashUnit(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

const smoothStep01 = (t) => t * t * (3 - 2 * t);

/** Seamless value noise on a lattice that wraps every `period` cells. */
function periodicNoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smoothStep01(x - xi);
  const fy = smoothStep01(y - yi);
  const x0 = ((xi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y0 = ((yi % period) + period) % period;
  const y1 = (y0 + 1) % period;
  const top = mix(hashUnit(x0, y0, seed), hashUnit(x1, y0, seed), fx);
  const bottom = mix(hashUnit(x0, y1, seed), hashUnit(x1, y1, seed), fx);
  return mix(top, bottom, fy);
}

/** Fractal noise on a wrapping lattice; `base` is the first cell count. */
function periodicFbm(u, v, base, octaves, seed) {
  let total = 0;
  let amplitude = 1;
  let norm = 0;
  let frequency = base;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += amplitude * periodicNoise(u * frequency, v * frequency, frequency, seed + octave * 131);
    norm += amplitude;
    amplitude *= 0.55;
    frequency *= 2;
  }
  return total / norm;
}

let sharedNoise = null;

/**
 * The one noise tile every puff of every kind samples. Red carries the soft,
 * billowing density of smoke; blue carries thin, stringy ridges for steam. The
 * tile wraps seamlessly, so a puff can take any offset into it. It is built
 * once per process and reused by every plume.
 */
export function createPlumeNoiseTexture(size = VOLCANIC_SMOKE_DEFAULTS.noiseSize) {
  const dimension = Math.max(16, Math.round(size));
  if (sharedNoise && sharedNoise.image.width === dimension) return sharedNoise;

  const data = new Uint8Array(dimension * dimension * 4);
  const billow = new Float32Array(dimension * dimension);
  const ridge = new Float32Array(dimension * dimension);
  let billowMin = Infinity;
  let billowMax = -Infinity;
  let ridgeMin = Infinity;
  let ridgeMax = -Infinity;
  for (let y = 0; y < dimension; y += 1) {
    for (let x = 0; x < dimension; x += 1) {
      const u = x / dimension;
      const v = y / dimension;
      const index = y * dimension + x;
      const soft = periodicFbm(u, v, 4, 4, 0x1f3d5b79);
      // Stringy ridges: fold the noise about its mean and sharpen the crests.
      const folded = periodicFbm(u, v, 6, 3, 0x2c9277b5);
      const strand = Math.pow(1 - Math.abs(folded * 2 - 1), 2.2);
      billow[index] = soft;
      ridge[index] = strand;
      billowMin = Math.min(billowMin, soft);
      billowMax = Math.max(billowMax, soft);
      ridgeMin = Math.min(ridgeMin, strand);
      ridgeMax = Math.max(ridgeMax, strand);
    }
  }
  const billowSpan = Math.max(1e-6, billowMax - billowMin);
  const ridgeSpan = Math.max(1e-6, ridgeMax - ridgeMin);
  for (let index = 0; index < billow.length; index += 1) {
    data[index * 4] = Math.round(((billow[index] - billowMin) / billowSpan) * 255);
    data[index * 4 + 1] = Math.round(((billow[index] - billowMin) / billowSpan) * 255);
    data[index * 4 + 2] = Math.round(((ridge[index] - ridgeMin) / ridgeSpan) * 255);
    data[index * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, dimension, dimension, THREE.RGBAFormat);
  texture.name = 'VolcanicPlumeNoise';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  sharedNoise = texture;
  return texture;
}

/** The four corners of one quad every puff is drawn from, shared by all. */
function createQuadAttributes() {
  return {
    position: new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
      0.5, 0.5, 0,
      -0.5, 0.5, 0,
    ], 3),
    index: new THREE.Uint16BufferAttribute([0, 1, 2, 0, 2, 3], 1),
  };
}

/* ---- Shaders ---------------------------------------------------------------
 * One vertex and one fragment shader serve both kinds; the look of each kind
 * arrives as uniforms. Everything time-driven is computed here, from `uTime`.
 */

const PUFF_VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform vec2 uBreeze;
  uniform vec2 uSunXZ;
  uniform float uRiseCurve;
  uniform float uStretch;
  uniform float uNearFade;
  uniform float uFullFade;
  uniform float uFarFade;

  attribute vec3 aOrigin;
  attribute vec4 aSeed;
  attribute vec4 aShape;
  attribute vec4 aMotion;
  attribute vec2 aTwist;

  varying vec2 vUv;
  varying vec2 vNoise;
  varying float vAge;
  varying float vTone;
  varying float vSun;
  varying float vFade;
  varying float vOpacity;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    // The puff's own loop: it is born, rises, spreads and fades, then starts
    // again. \`cycle\` counts the loops, so each one can be given new dice.
    float life = max(aShape.x, 0.5);
    float cycleFloat = uTime / life + aSeed.x;
    float cycle = floor(cycleFloat);
    float age01 = fract(cycleFloat);
    float age = age01 * life;

    float h1 = hash12(vec2(cycle, aSeed.z * 61.0 + 0.37));
    float h2 = hash12(vec2(cycle + 17.31, aSeed.w * 43.0 + 0.91));
    float h3 = hash12(vec2(cycle + 5.77, aSeed.z * 29.0 + aSeed.w * 71.0 + 0.13));

    float heading = h1 * 6.2831853;
    vec2 outward = vec2(cos(heading), sin(heading));
    // The column rises quickly and then thins out as it slows.
    float rise = aShape.y * (1.0 - pow(1.0 - age01, uRiseCurve));
    float spread = aMotion.x * age01 * (0.55 + 0.45 * h2);
    float sway = sin(age * aMotion.y + aTwist.y + h3 * 2.0) * aMotion.z * age01;
    vec2 drift = uBreeze * age;

    vec3 centre = aOrigin + vec3(
      drift.x + outward.x * spread + sway,
      rise,
      drift.y + outward.y * spread + sway * 0.6
    );

    // Fade by distance to the lens first: a puff never sits in front of the
    // camera, and nothing pops in or out at the far edge of the sector.
    vec4 worldCentre = modelMatrix * vec4(centre, 1.0);
    float cameraDistance = distance(worldCentre.xyz, cameraPosition);
    float nearFade = smoothstep(uNearFade, uFullFade, cameraDistance);
    float farFade = 1.0 - smoothstep(uFarFade * 0.82, uFarFade, cameraDistance);
    float lifeFade = smoothstep(0.0, 0.12, age01) * (1.0 - smoothstep(0.55, 1.0, age01));
    float fade = nearFade * farFade * lifeFade;

    vUv = position.xy + 0.5;
    vNoise = vec2(h3, fract(h3 * 13.7)) * 2.0 + aSeed.zw;
    vAge = age01;
    vTone = fract(aSeed.y + h3 * 0.35);
    vSun = dot(outward, uSunXZ) * 0.5 + 0.5;
    vOpacity = aMotion.w * (0.75 + 0.25 * h2);
    vFade = fade;

    if (fade <= 0.002) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // A billboard in view space, turned a little each loop so no two puffs
    // share a silhouette.
    float size = mix(aShape.z, aShape.w, smoothstep(0.0, 1.0, age01)) * (0.85 + 0.3 * h2);
    float twist = aTwist.x * 6.2831853 + age01 * (h1 - 0.5) * 1.2;
    vec2 corner = position.xy;
    corner.y *= uStretch;
    float c = cos(twist);
    float s = sin(twist);
    corner = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    vec4 viewCentre = modelViewMatrix * vec4(centre, 1.0);
    viewCentre.xy += corner * size;
    gl_Position = projectionMatrix * viewCentre;
  }
`;

const PUFF_FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D uNoise;
  uniform vec3 uShadow;
  uniform vec3 uLight;
  uniform vec3 uWarm;
  uniform float uWarmStrength;
  uniform float uWisp;
  uniform float uEdge;
  uniform float uBias;

  varying vec2 vUv;
  varying vec2 vNoise;
  varying float vAge;
  varying float vTone;
  varying float vSun;
  varying float vFade;
  varying float vOpacity;

  void main() {
    // A soft blob that falls away from its centre. The shared noise tile
    // decides where the puff is dense and where it breaks up: smoke reads the
    // tile's billows at two scales, steam reads its thin ridges, so the edges
    // are ragged rather than a clean disc and steam stays stringy.
    vec2 centred = vUv - 0.5;
    float radius = length(centred) * 2.0;
    float falloff = 1.0 - smoothstep(uEdge, 1.0, radius);
    falloff *= falloff;
    vec4 coarse = texture2D(uNoise, vUv * 0.9 + vNoise);
    vec4 fine = texture2D(uNoise, vUv * 2.3 + vNoise * 1.37 + 0.31);
    float density = mix(
      0.65 * coarse.r + 0.35 * fine.r,
      0.65 * coarse.b + 0.35 * fine.b,
      uWisp
    );
    // The bias lifts a kind's body: steam's ridged tile is mostly dark, so
    // without it the wisps would thin out to almost nothing.
    float body = smoothstep(0.2, 0.9, density * 0.8 + falloff * 0.45 + uBias);
    float alpha = body * falloff * vFade * vOpacity;
    if (alpha < 0.002) discard;

    // Lit by the sun on the side it faces, a little brighter at the top, and
    // warmed by the lava at its foot for as long as it is still young. The
    // denser billows take a touch of shadow, so each puff has some body to it.
    float lit = clamp(0.38 + 0.42 * vSun + 0.22 * vTone + 0.18 * vAge, 0.0, 1.0);
    vec3 color = mix(uShadow, uLight, lit);
    color *= 0.9 + 0.2 * density;
    color = mix(color, uWarm, uWarmStrength * pow(1.0 - vAge, 3.0));
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

/** The look of one kind, as uniforms. Shared ones are passed in by the caller. */
function createKindMaterial(kind, look, shared) {
  return new THREE.ShaderMaterial({
    name: `VolcanicPuffMaterial_${kind}_HEX_SE`,
    uniforms: {
      uTime: shared.uTime,
      uNoise: shared.uNoise,
      uBreeze: shared.uBreeze,
      uSunXZ: shared.uSunXZ,
      uNearFade: shared.uNearFade,
      uFullFade: shared.uFullFade,
      uFarFade: shared.uFarFade,
      uRiseCurve: { value: look.riseCurve },
      uStretch: { value: look.stretch },
      uEdge: { value: look.edge },
      uBias: { value: look.bias ?? 0 },
      uWisp: { value: kind === 'steam' ? 1 : 0 },
      uShadow: { value: new THREE.Color(look.shadow) },
      uLight: { value: new THREE.Color(look.light) },
      uWarm: { value: new THREE.Color(look.warm) },
      uWarmStrength: { value: look.warmStrength },
    },
    vertexShader: PUFF_VERTEX_SHADER,
    fragmentShader: PUFF_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // Each quad is a billboard built in view space, so it always faces the
    // camera. One pass draws it, and no frame is spent on a second pass.
    side: THREE.DoubleSide,
    forceSinglePass: true,
    fog: false,
  });
}

function createPuffGeometry(name, buffers, quad) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = name;
  geometry.setIndex(quad.index);
  geometry.setAttribute('position', quad.position);
  geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(buffers.origin, 3));
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(buffers.seeds, 4));
  geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(buffers.shape, 4));
  geometry.setAttribute('aMotion', new THREE.InstancedBufferAttribute(buffers.motion, 4));
  geometry.setAttribute('aTwist', new THREE.InstancedBufferAttribute(buffers.twist, 2));
  geometry.instanceCount = buffers.count;
  return geometry;
}

/**
 * Build HEX_SE's smoke and steam. Returns `null` when the sector is not HEX_SE,
 * the effect is switched off or no source resolves.
 *
 * The group is in sector-local coordinates, like the lava, the rocks and the
 * debris, so the caller places it at the sector's own centre. `update(delta)`
 * advances the one clock; `setVisible(false)` steps the plumes aside, for the
 * overview.
 */
export function buildVolcanicSmoke(terrain, config = {}, options = {}) {
  const plan = planVolcanicSmoke(terrain, config);
  if (!plan || plan.puffCount === 0) return null;
  const settings = plan.settings;
  const sun = options.sunDirection ?? resolveSunDirection(config);

  const group = new THREE.Group();
  group.name = 'VolcanicSmoke_HEX_SE';
  group.userData.sectorId = 'HEX_SE';
  group.userData.featureType = 'volcanic-smoke-and-steam';
  group.userData.animates = true;
  group.userData.collidable = false;
  group.userData.lights = 0;
  group.userData.particles = plan.puffCount;
  group.userData.smokePuffs = plan.smokePuffs;
  group.userData.steamPuffs = plan.steamPuffs;
  group.userData.sources = plan.sources.map((source) => source.id);
  group.userData.skippedSources = plan.skipped.slice();

  // Everything the materials share lives in one set of uniform objects, so a
  // single write to `uTime` drives every plume of every kind.
  const shared = {
    uTime: { value: 0 },
    uNoise: { value: createPlumeNoiseTexture(settings.noiseSize) },
    uBreeze: { value: new THREE.Vector2(settings.breeze.x, settings.breeze.z) },
    uSunXZ: { value: new THREE.Vector2(sun.x, sun.z).normalize() },
    uNearFade: { value: settings.cameraNear },
    uFullFade: { value: settings.cameraFull },
    uFarFade: { value: settings.cameraFar },
  };
  const quad = createQuadAttributes();
  const materials = {};
  const geometries = {};
  const meshes = {};
  const drawOrder = { smoke: 24, steam: 25 };
  for (const kind of ['smoke', 'steam']) {
    const buffers = plan.buffers[kind];
    if (buffers.count === 0) continue;
    materials[kind] = createKindMaterial(kind, settings[kind], shared);
    geometries[kind] = createPuffGeometry(`VolcanicPuffGeometry_${kind}_HEX_SE`, buffers, quad);
    const mesh = new THREE.Mesh(geometries[kind], materials[kind]);
    mesh.name = kind === 'smoke' ? 'VolcanicSmokePlumes_HEX_SE' : 'VolcanicSteamWisps_HEX_SE';
    mesh.userData.sectorId = 'HEX_SE';
    mesh.userData.featureType = `volcanic-${kind}-puffs`;
    mesh.userData.puffs = buffers.count;
    mesh.userData.collidable = false;
    // The quads are placed by the shader, so the mesh's own bounds mean
    // nothing: the fade does the culling instead.
    mesh.frustumCulled = false;
    mesh.renderOrder = drawOrder[kind];
    group.add(mesh);
    meshes[kind] = mesh;
  }

  let time = 0;
  return {
    group,
    meshes,
    materials,
    geometries,
    uniforms: shared,
    plan,
    sources: plan.sources,
    puffCount: plan.puffCount,
    get time() {
      return time;
    },
    /** One clock drives every plume: the only per-frame work is this write. */
    update(delta) {
      time += Math.max(0, delta);
      shared.uTime.value = time;
    },
    setVisible(visible) {
      group.visible = Boolean(visible);
    },
  };
}
