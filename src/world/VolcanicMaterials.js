import * as THREE from 'three';

/**
 * VolcanicMaterials — the material palette of HEX_SE.
 *
 * The sector already has its final shape: the massif, the main crater, the
 * basin, the fissure ridges, the vents, the lava pool with its two channels,
 * the cooled crust beside them and the rock props that sit on top. This module
 * does not add a single vertex to any of that. It only answers one question —
 * *what is this piece of ground made of* — and gives every answer a look.
 *
 * Six materials, and only six:
 *
 *   1. `darkSoil`    — dark volcanic soil: the warm, dusty brown-black ground
 *                      of the open plains and the gentler flanks.
 *   2. `blackBasalt` — the sector's bedrock: wherever the ground tips, creases
 *                      into a ridge or breaks around a vent throat, the soil is
 *                      gone and the rock itself is exposed.
 *   3. `darkAsh`     — the pale, dry, slightly lighter fall that settles on the
 *                      high flats and drifts across the open ground. It is the
 *                      brightest *cold* note in the sector, and it is what keeps
 *                      HEX_SE from reading as one black plate.
 *   4. `cooledLava`  — black, glassy, chilled rock: the crater floor and the
 *                      ground the lava has already run over. Darker than basalt
 *                      but noticeably smoother, so it catches the sky instead of
 *                      disappearing.
 *   5. `heatedRock`  — rock that has not finished cooling: a desaturated, dull
 *                      red-brown with a trace of its own heat in the emission.
 *                      It only appears as a narrow margin around molten rock and
 *                      around the hottest vents.
 *   6. `moltenLava`  — the lava itself. It is the one bright thing in HEX_SE and
 *                      it stays that way: nothing else in this palette is
 *                      allowed near its brightness, and the heat that leaks onto
 *                      the surrounding rock is a fraction of it.
 *
 * Two rules shape every number below. The field is *dark*, so the cold palette
 * lives between roughly 0.08 and 0.3 luminance — but nothing is pure black,
 * because black ground reads as a hole, not as rock. And the field is *hot*,
 * so the warmth is spent where heat actually is (lava, its margins, vent
 * throats) instead of being sprayed over the sector as red tint.
 *
 * Variation is deliberate rather than random: two slow noise fields nudge the
 * mix between soil, ash and basalt by a few percent, so neighbouring ground
 * differs the way weathering differs — never by hue, only by how much of which
 * material is showing.
 *
 * The palette is applied in three places, and nowhere else:
 *
 *   • the terrain lattice (src/world/VolcanicTerrain.js) blends it per vertex
 *     from the relief itself — height, slope, vent shading and lava proximity —
 *     and writes the result into the `color` attribute it already had, plus one
 *     small `aVolcanicSurface` attribute carrying the per-vertex roughness and
 *     heat this palette asks for;
 *   • the ground material (installed here, used by src/world/HexMap.js) reads
 *     that attribute, so one draw call still covers the whole sector while ash,
 *     soil, basalt and chilled crust each keep their own finish;
 *   • the rock props (formations, medium rocks, debris) take their facet tones
 *     from `BASALT_TONES` below, so a boulder is cut from the same basalt as
 *     the ridge it fell off.
 *
 * The molten lava keeps its own material (src/world/LavaPool.js) and the cooled
 * crust beside it keeps its own tile pass (src/world/CooledCrust.js); this
 * module only states what they are in the palette so the six read as one set.
 */

function clamp01(value) {
  return value < 0 ? 0 : (value > 1 ? 1 : value);
}

/* ---- The six materials --------------------------------------------------
 * `color` is the albedo in sRGB, `roughness` / `metalness` the finish, and
 * `emissive` / `emissiveIntensity` the heat the material carries on its own.
 * Only the last two entries are allowed to emit anything at all.
 */

export const VOLCANIC_MATERIALS = Object.freeze({
  darkSoil: Object.freeze({
    id: 'darkSoil',
    name: 'DarkVolcanicSoil',
    label: 'dark volcanic soil',
    color: 0x3b332c,
    roughness: 0.99,
    metalness: 0,
    emissive: 0x000000,
    emissiveIntensity: 0,
  }),
  blackBasalt: Object.freeze({
    id: 'blackBasalt',
    name: 'BlackBasalt',
    label: 'black basalt',
    color: 0x26282d,
    roughness: 0.93,
    metalness: 0.04,
    emissive: 0x000000,
    emissiveIntensity: 0,
  }),
  darkAsh: Object.freeze({
    id: 'darkAsh',
    name: 'DarkAsh',
    label: 'dark ash',
    color: 0x4c4842,
    roughness: 1,
    metalness: 0,
    emissive: 0x000000,
    emissiveIntensity: 0,
  }),
  cooledLava: Object.freeze({
    id: 'cooledLava',
    name: 'CooledLava',
    label: 'cooled lava',
    color: 0x1c1b1d,
    roughness: 0.64,
    metalness: 0.06,
    emissive: 0x000000,
    emissiveIntensity: 0,
  }),
  heatedRock: Object.freeze({
    id: 'heatedRock',
    name: 'HeatedRock',
    label: 'slightly reddish heated rock',
    color: 0x4e302a,
    roughness: 0.82,
    metalness: 0.03,
    emissive: 0xff3c0a,
    emissiveIntensity: 0.22,
  }),
  moltenLava: Object.freeze({
    id: 'moltenLava',
    name: 'MoltenLava',
    label: 'molten lava',
    color: 0xff7a2a,
    roughness: 0.86,
    metalness: 0.03,
    emissive: 0xffc27a,
    emissiveIntensity: 1,
  }),
});

/** The palette in a fixed order — handy for tests, previews and overviews. */
export const VOLCANIC_MATERIAL_ORDER = Object.freeze([
  'darkSoil', 'blackBasalt', 'darkAsh', 'cooledLava', 'heatedRock', 'moltenLava',
]);

/** The palette as live THREE colours, resolved once. */
const PALETTE_COLORS = Object.freeze(Object.fromEntries(
  VOLCANIC_MATERIAL_ORDER.map((id) => [id, new THREE.Color(VOLCANIC_MATERIALS[id].color)]),
));

export function volcanicMaterialColor(id) {
  return PALETTE_COLORS[id] ?? null;
}

/**
 * The five facet tones the rock props are cut from: the palette's basalt with
 * a little soil and ash mixed through it, so a boulder is visibly the same
 * stone as the ground it sits on and still has light and dark faces.
 */
export const BASALT_TONES = Object.freeze([
  0x1f2126,
  0x282a2f,
  0x313339,
  0x3b3c40,
  0x47474b,
].map((hex) => new THREE.Color(hex)));

/* ---- Where each material goes ------------------------------------------
 * One function, driven only by signals the terrain already computes. No new
 * features, no new placement data: the ground decides what it is made of from
 * its own height, its own slope, the vents already cut into it and the lava
 * already lying on it.
 */

const SURFACE_PALETTE = Object.freeze({
  soil: PALETTE_COLORS.darkSoil,
  basalt: PALETTE_COLORS.blackBasalt,
  ash: PALETTE_COLORS.darkAsh,
  cooled: PALETTE_COLORS.cooledLava,
  heated: PALETTE_COLORS.heatedRock,
});

const surfaceScratch = new THREE.Color();

/** Two slow, independent fields: weathering, not noise for its own sake. */
function drift(x, z, phase) {
  return (
    Math.sin(x * 0.0135 + phase) * Math.cos(z * 0.0113 - phase * 0.7)
    + 0.45 * Math.sin((x - z) * 0.0268 + phase * 1.9)
  ) / 1.45;
}

/**
 * Blend the palette for one point of the volcanic ground.
 *
 * Returns the mixed albedo (as a shared, reused `THREE.Color` — copy it if you
 * keep it), the finish that mix asks for, the heat it carries, and the weight
 * each of the five ground materials ended up with. The weights always sum to
 * one, so they can be read as "this ground is 70% soil, 20% ash, 10% basalt".
 */
export function volcanicSurfaceAt({
  x = 0,
  z = 0,
  height = 0,
  slope = 0,
  ventThroat = 0,
  ventRim = 0,
  lavaCrust = 0,
  lavaEmber = 0,
} = {}) {
  const weathering = drift(x, z, 1.7);
  const fall = drift(x * 0.62, z * 0.62, -0.4);

  const flatness = 1 - clamp01(slope / 0.5);
  // Ash falls and *stays* where the ground is high and level; a little of it
  // drifts across the plains as well, which is where `fall` is spent.
  const ash = clamp01(
    THREE.MathUtils.smoothstep(height, 2.5, 14) * (0.3 + 0.7 * flatness) * 0.62
    + clamp01(fall) * 0.14 * flatness,
  );
  // Basalt is the rock under everything: it shows wherever the ground tips,
  // creases, or has been blown open by a vent.
  const basalt = clamp01(
    THREE.MathUtils.smoothstep(slope, 0.16, 0.52) * 0.72
    + clamp01(ventThroat) * 0.55
    + clamp01(weathering) * 0.1,
  );
  // The chilled, glassy rock: everything the lava has already covered, plus
  // the deep floor of the crater, which is the oldest lava in the sector.
  const cooled = clamp01(
    clamp01(lavaCrust) * 0.92
    + THREE.MathUtils.smoothstep(-height, 2, 11) * 0.22,
  );
  // Heat is the narrowest band of all: the rock that the lava is still
  // cooking, and the lip of a vent throat.
  const heated = clamp01(clamp01(lavaEmber) * 0.85 + clamp01(ventRim) * 0.18);

  // Soil takes whatever the others leave; the order below is the geological
  // one — soil on top, rock through it, ash over that, then what the lava did.
  const soil = Math.max(0, 1 - Math.max(ash, basalt * 0.9));
  let wSoil = soil;
  let wAsh = ash * (1 - basalt * 0.45);
  let wBasalt = basalt;
  const cold = wSoil + wAsh + wBasalt;
  const lavaShare = clamp01(cooled + heated);
  const coldShare = 1 - lavaShare;
  const scale = cold > 1e-5 ? coldShare / cold : 0;
  wSoil *= scale;
  wAsh *= scale;
  wBasalt *= scale;
  let wCooled = lavaShare * (cooled / Math.max(1e-5, cooled + heated));
  let wHeated = lavaShare - wCooled;
  // A trace of heat never fully cools: keep the margin readable but thin.
  wHeated = Math.min(wHeated, 0.72);
  wCooled = Math.min(wCooled, 1 - wHeated);

  surfaceScratch.setRGB(
    SURFACE_PALETTE.soil.r * wSoil + SURFACE_PALETTE.ash.r * wAsh
    + SURFACE_PALETTE.basalt.r * wBasalt + SURFACE_PALETTE.cooled.r * wCooled
    + SURFACE_PALETTE.heated.r * wHeated,
    SURFACE_PALETTE.soil.g * wSoil + SURFACE_PALETTE.ash.g * wAsh
    + SURFACE_PALETTE.basalt.g * wBasalt + SURFACE_PALETTE.cooled.g * wCooled
    + SURFACE_PALETTE.heated.g * wHeated,
    SURFACE_PALETTE.soil.b * wSoil + SURFACE_PALETTE.ash.b * wAsh
    + SURFACE_PALETTE.basalt.b * wBasalt + SURFACE_PALETTE.cooled.b * wCooled
    + SURFACE_PALETTE.heated.b * wHeated,
  );
  // The only brightness variation in the whole pass: a few percent, applied to
  // the mix rather than to a hue, so the ground breathes without turning
  // patchy or colourful.
  const breath = 1 + weathering * 0.045 + fall * 0.03;
  surfaceScratch.multiplyScalar(breath);

  const roughness = (
    VOLCANIC_MATERIALS.darkSoil.roughness * wSoil
    + VOLCANIC_MATERIALS.darkAsh.roughness * wAsh
    + VOLCANIC_MATERIALS.blackBasalt.roughness * wBasalt
    + VOLCANIC_MATERIALS.cooledLava.roughness * wCooled
    + VOLCANIC_MATERIALS.heatedRock.roughness * wHeated
  );
  const heat = clamp01(wHeated * (0.6 + 0.4 * clamp01(lavaEmber)));

  return {
    color: surfaceScratch,
    roughness: THREE.MathUtils.clamp(roughness, 0.4, 1),
    heat,
    weights: {
      darkSoil: wSoil,
      blackBasalt: wBasalt,
      darkAsh: wAsh,
      cooledLava: wCooled,
      heatedRock: wHeated,
    },
  };
}

/** The name of the material that dominates a point — for tests and previews. */
export function dominantVolcanicMaterial(weights) {
  let best = null;
  let bestWeight = -Infinity;
  for (const [id, weight] of Object.entries(weights ?? {})) {
    if (weight > bestWeight) {
      best = id;
      bestWeight = weight;
    }
  }
  return best;
}

/* ---- The ground material ------------------------------------------------
 * The sector's ground is one mesh with one material, and it stays that way.
 * The six materials differ in more than colour, though, so the material reads
 * two extra floats per vertex — the finish and the heat the blend above asked
 * for — and applies them in the shader. That is the entire patch: no maps, no
 * second pass, no draw call.
 */

const SURFACE_VERTEX_PARS = `
#ifdef USE_VOLCANIC_SURFACE
\tattribute vec2 aVolcanicSurface;
\tvarying vec2 vVolcanicSurface;
#endif`;

const SURFACE_VERTEX_MAIN = `
#ifdef USE_VOLCANIC_SURFACE
\tvVolcanicSurface = aVolcanicSurface;
#endif`;

const SURFACE_FRAGMENT_PARS = `
#ifdef USE_VOLCANIC_SURFACE
\tuniform vec3 volcanicHeatColor;
\tuniform float volcanicHeatIntensity;
\tvarying vec2 vVolcanicSurface;
#endif`;

const SURFACE_FRAGMENT_MAIN = `
#ifdef USE_VOLCANIC_SURFACE
\ttotalEmissiveRadiance += volcanicHeatColor * volcanicHeatIntensity
\t\t* clamp( vVolcanicSurface.y, 0.0, 1.0 );
#endif`;

const SURFACE_FRAGMENT_ROUGHNESS = `
#ifdef USE_VOLCANIC_SURFACE
\troughnessFactor = clamp( vVolcanicSurface.x, 0.04, 1.0 );
#endif`;

export const VOLCANIC_SURFACE_ANCHORS = Object.freeze({
  vertexPars: '#include <common>',
  vertexMain: '#include <begin_vertex>',
  fragmentPars: '#include <common>',
  fragmentMain: '#include <color_fragment>',
  fragmentRoughness: '#include <roughnessmap_fragment>',
});

function inject(source, anchor, insertion, report, key) {
  const at = source.indexOf(anchor);
  if (at < 0) {
    report.missing.push(key);
    return source;
  }
  report.landed += 1;
  return `${source.slice(0, at + anchor.length)}\n${insertion}${source.slice(at + anchor.length)}`;
}

export function patchVolcanicSurfaceVertexShader(source, report = { landed: 0, missing: [] }) {
  let patched = inject(source, VOLCANIC_SURFACE_ANCHORS.vertexPars, SURFACE_VERTEX_PARS, report, 'vertexPars');
  patched = inject(patched, VOLCANIC_SURFACE_ANCHORS.vertexMain, SURFACE_VERTEX_MAIN, report, 'vertexMain');
  return patched;
}

export function patchVolcanicSurfaceFragmentShader(source, report = { landed: 0, missing: [] }) {
  let patched = inject(source, VOLCANIC_SURFACE_ANCHORS.fragmentPars, SURFACE_FRAGMENT_PARS, report, 'fragmentPars');
  patched = inject(patched, VOLCANIC_SURFACE_ANCHORS.fragmentMain, SURFACE_FRAGMENT_MAIN, report, 'fragmentMain');
  patched = inject(patched, VOLCANIC_SURFACE_ANCHORS.fragmentRoughness, SURFACE_FRAGMENT_ROUGHNESS, report, 'fragmentRoughness');
  return patched;
}

export function resolveVolcanicHeat(config = {}) {
  return {
    color: config.volcanicHeatColor ?? VOLCANIC_MATERIALS.heatedRock.emissive,
    intensity: config.volcanicHeatIntensity ?? VOLCANIC_MATERIALS.heatedRock.emissiveIntensity,
  };
}

/**
 * Install the per-vertex finish and heat into a material. The material keeps
 * everything it was; ground without the `aVolcanicSurface` attribute simply
 * reads zeros and renders as the plain blend. A previous `onBeforeCompile` is
 * chained, not replaced, so the cooled crust can still be installed on top of
 * this one (and should be: whatever is installed last wins at the anchor).
 */
export function installVolcanicSurface(material, config = {}) {
  if (!material) return null;
  const heat = resolveVolcanicHeat(config);
  const uniforms = {
    volcanicHeatColor: { value: new THREE.Color(heat.color) },
    volcanicHeatIntensity: { value: heat.intensity },
  };
  const previous = material.onBeforeCompile;
  const report = { landed: 0, missing: [] };
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof previous === 'function') previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    report.landed = 0;
    report.missing = [];
    shader.vertexShader = `#define USE_VOLCANIC_SURFACE\n${patchVolcanicSurfaceVertexShader(shader.vertexShader, report)}`;
    shader.fragmentShader = `#define USE_VOLCANIC_SURFACE\n${patchVolcanicSurfaceFragmentShader(shader.fragmentShader, report)}`;
  };
  material.customProgramCacheKey = () => `volcanic-surface:${heat.color}|${heat.intensity}`;
  material.userData.volcanicSurface = {
    palette: VOLCANIC_MATERIAL_ORDER.slice(),
    heatColor: heat.color,
    heatIntensity: heat.intensity,
    patches: report,
    animates: false,
  };
  return material;
}

/**
 * The one material the volcanic ground is drawn with: the palette's own basalt
 * finish, vertex colours carrying the blend, and the finish/heat patch above.
 * The cooled crust is installed on top of this by the caller.
 */
export function createVolcanicGroundMaterial(config = {}) {
  const material = new THREE.MeshStandardMaterial({
    name: 'VolcanicGroundMaterial_HEX_SE',
    color: config.volcanicRockColor ?? 0xffffff,
    vertexColors: true,
    roughness: VOLCANIC_MATERIALS.blackBasalt.roughness,
    metalness: VOLCANIC_MATERIALS.blackBasalt.metalness,
  });
  installVolcanicSurface(material, config);
  return material;
}

/** The dark basalt band around the sector's rim — the palette's darkest rock. */
export function createVolcanicBorderMaterial(config = {}) {
  return new THREE.MeshStandardMaterial({
    name: 'VolcanicBorderBasalt_HEX_SE',
    color: config.volcanicRockDarkColor ?? 0x191b1f,
    roughness: 0.97,
    metalness: 0.03,
  });
}

/** A prop material cut from the same basalt as the ground (rocks, debris, spires). */
export function createVolcanicPropMaterial(name, overrides = {}) {
  return new THREE.MeshStandardMaterial({
    name,
    color: 0xffffff,
    vertexColors: true,
    roughness: VOLCANIC_MATERIALS.blackBasalt.roughness + 0.04,
    metalness: VOLCANIC_MATERIALS.blackBasalt.metalness * 0.5,
    flatShading: true,
    side: THREE.DoubleSide,
    ...overrides,
  });
}
