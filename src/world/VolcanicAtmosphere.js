import * as THREE from 'three';
import { isPointInsideHex } from './hexGrid.js';
import { between, makeRandom } from './random.js';
import { measureLavaPoolShoreline } from './LavaPool.js';

/**
 * VolcanicAtmosphere — the visual atmosphere pass of HEX_SE.
 *
 * The sector already has its ground, its crater, its vents, its rocks, its
 * lava and the smoke and steam above it. This module adds only the air itself:
 * a breath of distant haze, a thin fall of ash, a shimmer of heat over the
 * molten rock, a slight darkening of the sky and a faint glow where the lava
 * warms the ground beside it. Nothing else changes.
 *
 * Five decisions shape it.
 *
 * 1. **Everything is subtle and stays out of the way.** Two haze discs at a
 *    twentieth of the forest mist's thickness, a few hundred grains of ash the
 *    size of grit, a hundred heat wisps thinner than the steam, a sky dimmed
 *    by a few percent (see `SkyDome.js`, HEX_SE only) and two small warm
 *    lights with a short reach. The crater, the lava, the formations, the
 *    paths, the boundaries and the gates stay clearly readable.
 *
 * 2. **Everything is local to HEX_SE.** Ash is scattered inside the hex, heat
 *    rises only from the pool and the two channels that already exist, the
 *    haze discs are centred on the sector, and the glow lights die out tens of
 *    units before any shared edge. No other sector is touched.
 *
 * 3. **The animation lives on the GPU.** Ash and heat are each one instanced
 *    billboard mesh driven by a single shared clock; the haze discs drift like
 *    the forest mist. Per frame the CPU writes one float, turns two discs and
 *    breathes two lights. Four draw calls in all, no fullscreen pass, no render
 *    target, no post-processing.
 *
 * 4. **Heat is suggested, not simulated.** True refraction would need a scene
 *    colour target per frame — far too expensive for a browser game. The heat
 *    here is faint, fast, short-lived wisps rising off the lava: the eye reads
 *    them as shimmer without any pixel of the terrain being hidden or warped.
 *
 * 5. **Nothing is placed that was not there.** The module samples the baked
 *    terrain and the lava that already exists to seat its particles and its
 *    lights. It writes no height, no attribute, no carve, no collider, no
 *    damage and no gameplay of any kind.
 */

const TAU = Math.PI * 2;
const clamp01 = (value) => (value < 0 ? 0 : (value > 1 ? 1 : value));

/**
 * The defaults. Plain data: the breeze the ash leans on, the haze discs, the
 * ash fall, the heat wisps and the lava glow. `volcanicAtmosphere` overrides
 * these key by key; `volcanicAtmosphereEnabled: false` (or `false` / `null`)
 * removes the whole pass without a trace.
 */
export const VOLCANIC_ATMOSPHERE_DEFAULTS = Object.freeze({
  seed: 0x4d05e691,
  // The same breeze the smoke leans on, so ash and plumes agree on the air.
  breeze: Object.freeze({ x: 0.85, z: 0.4 }),
  haze: Object.freeze({
    layers: 2,
    // Warm grey-beige, desaturated: heat in the air, never a red screen.
    color: 0xc7a68c,
    // Per-layer opacity before the height falloff. The two discs together are
    // about a twentieth of the forest mist's thickness.
    opacity: 0.055,
    // Disc radius as a share of the hex radius; heights are sector units above
    // the shared floor, floating over the relief instead of pooling on it.
    radiusFactor: 0.9,
    height: 10,
    spacing: 9,
    driftSpeed: 0.008,
    // The haze keeps clear of the lens like the mist does, so the ground
    // underfoot stays crisp while the distance softens.
    cameraNear: 8,
    cameraFull: 30,
  }),
  ash: Object.freeze({
    // A few hundred grains over a whole sector: present, never a snowfall.
    count: 420,
    size: Object.freeze([0.1, 0.26]),
    opacity: 0.3,
    color: 0xb8b0a6,
    // Each grain falls this far, from `ground + fallRange` down to the ground.
    fallRange: 32,
    // World units per second: ash hangs in the air, it does not pour like rain.
    speed: Object.freeze([1.5, 3.1]),
    wobble: Object.freeze([0.4, 1.2]),
    cameraNear: 3,
    cameraFull: 9,
    cameraFar: 175,
  }),
  heat: Object.freeze({
    // The whole shimmer budget, split over the lava that already exists. A
    // share whose lava is disabled simply stays unspent.
    pool: 52,
    main: 34,
    branch: 18,
    life: Object.freeze([1.7, 2.8]),
    rise: Object.freeze([3.2, 5.5]),
    size: Object.freeze([1.3, 2.6]),
    spread: Object.freeze([0.5, 1.2]),
    wobble: Object.freeze([0.25, 0.6]),
    // Thinner than the steam (0.07) and far thinner than the smoke (0.085):
    // the lava must read straight through it.
    opacity: 0.055,
    color: 0xffd9b8,
    cameraNear: 4,
    cameraFull: 12,
    cameraFar: 130,
  }),
  glow: Object.freeze({
    // Two small warm lights with a short reach: one over the pool, one over
    // the main channel. They warm the nearby rock and die out long before any
    // shared edge. No shadows, no flicker the eye can catch.
    pool: Object.freeze({
      color: 0xff6a22, intensity: 0.62, distance: 85, decay: 2, height: 7,
    }),
    flow: Object.freeze({
      color: 0xff7a2e, intensity: 0.4, distance: 62, decay: 2, height: 6,
    }),
    flicker: 0.06,
  }),
});

/**
 * Resolve the settings the sector should carry: `volcanicAtmosphereEnabled`
 * switches the whole pass off, `volcanicAtmosphere` overrides the defaults
 * (`false` or `null` removes it outright), and the `haze` / `ash` / `heat` /
 * `glow` blocks merge key by key.
 */
export function resolveVolcanicAtmosphereSettings(config = {}) {
  const override = config.volcanicAtmosphere;
  if (config.volcanicAtmosphereEnabled === false || override === false || override === null) return null;
  const extra = override && typeof override === 'object' ? override : {};
  return {
    ...VOLCANIC_ATMOSPHERE_DEFAULTS,
    ...extra,
    breeze: { ...VOLCANIC_ATMOSPHERE_DEFAULTS.breeze, ...(extra.breeze ?? {}) },
    haze: { ...VOLCANIC_ATMOSPHERE_DEFAULTS.haze, ...(extra.haze ?? {}) },
    ash: { ...VOLCANIC_ATMOSPHERE_DEFAULTS.ash, ...(extra.ash ?? {}) },
    heat: { ...VOLCANIC_ATMOSPHERE_DEFAULTS.heat, ...(extra.heat ?? {}) },
    glow: {
      ...VOLCANIC_ATMOSPHERE_DEFAULTS.glow,
      ...(extra.glow ?? {}),
      pool: { ...VOLCANIC_ATMOSPHERE_DEFAULTS.glow.pool, ...(extra.glow?.pool ?? {}) },
      flow: { ...VOLCANIC_ATMOSPHERE_DEFAULTS.glow.flow, ...(extra.glow?.flow ?? {}) },
    },
  };
}

/* ---- Planning ------------------------------------------------------------
 * Everything is decided once, from the terrain and the lava that already
 * exist. Rebuilding from the same terrain reproduces every number exactly.
 */

function scatterAshOrigins(terrain, hexRadius, count, random) {
  const fieldRadius = Math.max(8, hexRadius - 10);
  const origins = [];
  let attempts = 0;
  const maxAttempts = count * 40 + 40;
  while (origins.length < count && attempts < maxAttempts) {
    attempts += 1;
    const x = (random() * 2 - 1) * fieldRadius;
    const z = (random() * 2 - 1) * fieldRadius;
    if (!isPointInsideHex(x, z, 0, 0, fieldRadius)) continue;
    origins.push({ x, z, ground: terrain.heightAt(x, z) });
  }
  return origins;
}

function poolHeatOrigins(terrain, pool, count, random) {
  if (!pool || count <= 0) return [];
  const shoreline = measureLavaPoolShoreline(terrain, pool);
  const radius = Math.max(3, (shoreline?.mean ?? pool.radius * 0.55) * 0.62);
  const surface = pool.level + (pool.lift ?? 0.035) + 0.08;
  const origins = [];
  for (let i = 0; i < count; i += 1) {
    const ring = radius * Math.sqrt(random());
    const angle = random() * TAU;
    origins.push({
      x: pool.x + Math.cos(angle) * ring,
      y: surface,
      z: pool.z + Math.sin(angle) * ring,
      on: 'pool',
    });
  }
  return origins;
}

function flowHeatOrigins(flow, count, random) {
  if (!flow?.samples || flow.samples.length < 4 || count <= 0) return [];
  const samples = flow.samples;
  // The middle of the channel: clear of the mouth's overlap and the cooled toe.
  const from = Math.floor(samples.length * 0.08);
  const to = Math.floor(samples.length * 0.9);
  const origins = [];
  for (let i = 0; i < count; i += 1) {
    const sample = samples[from + Math.floor(random() * (to - from))];
    const half = (sample.left + sample.right) * 0.25;
    const offset = between(random, -0.45, 0.45) * (sample.left + sample.right) * 0.5;
    const across = Math.max(-half, Math.min(half, offset));
    origins.push({
      x: sample.x + sample.nx * across,
      y: sample.y + 0.12,
      z: sample.z + sample.nz * across,
      on: flow.parentFlowId ? 'branch' : 'main',
    });
  }
  return origins;
}

/**
 * Plan the whole pass without making a single GPU object: the ash scatter,
 * the heat origins on the lava that exists, and the glow lights over it.
 */
export function planVolcanicAtmosphere(terrain, config = {}) {
  if (!terrain || terrain.sectorId !== 'HEX_SE') return null;
  const settings = resolveVolcanicAtmosphereSettings(config);
  if (!settings) return null;
  const hexRadius = config.hexRadius ?? 220;

  const random = makeRandom(settings.seed >>> 0);
  const ashCount = Math.max(0, Math.round(settings.ash.count ?? 0));
  const ashOrigins = scatterAshOrigins(terrain, hexRadius, ashCount, random);
  const ash = {
    count: ashOrigins.length,
    origin: new Float32Array(ashOrigins.length * 3),
    params: new Float32Array(ashOrigins.length * 4),
    wobble: new Float32Array(ashOrigins.length * 2),
  };
  ashOrigins.forEach((point, index) => {
    ash.origin[index * 3] = point.x;
    ash.origin[index * 3 + 1] = point.ground;
    ash.origin[index * 3 + 2] = point.z;
    ash.params[index * 4] = random();
    ash.params[index * 4 + 1] = between(random, settings.ash.speed[0], settings.ash.speed[1]);
    ash.params[index * 4 + 2] = between(random, settings.ash.size[0], settings.ash.size[1]);
    ash.params[index * 4 + 3] = random();
    ash.wobble[index * 2] = random();
    ash.wobble[index * 2 + 1] = between(random, settings.ash.wobble[0], settings.ash.wobble[1]);
  });

  const heatOrigins = [
    ...poolHeatOrigins(terrain, terrain.lavaPool, Math.max(0, Math.round(settings.heat.pool ?? 0)), random),
    ...flowHeatOrigins(terrain.lavaFlow, Math.max(0, Math.round(settings.heat.main ?? 0)), random),
    ...flowHeatOrigins(terrain.lavaSecondaryFlow, Math.max(0, Math.round(settings.heat.branch ?? 0)), random),
  ];
  const heat = {
    count: heatOrigins.length,
    origin: new Float32Array(heatOrigins.length * 3),
    params: new Float32Array(heatOrigins.length * 4),
    misc: new Float32Array(heatOrigins.length * 4),
  };
  heatOrigins.forEach((point, index) => {
    heat.origin[index * 3] = point.x;
    heat.origin[index * 3 + 1] = point.y;
    heat.origin[index * 3 + 2] = point.z;
    heat.params[index * 4] = random();
    heat.params[index * 4 + 1] = between(random, settings.heat.life[0], settings.heat.life[1]);
    heat.params[index * 4 + 2] = between(random, settings.heat.rise[0], settings.heat.rise[1]);
    heat.params[index * 4 + 3] = between(random, settings.heat.size[0], settings.heat.size[1]);
    heat.misc[index * 4] = between(random, settings.heat.spread[0], settings.heat.spread[1]);
    heat.misc[index * 4 + 1] = settings.heat.opacity * between(random, 0.65, 1.15);
    heat.misc[index * 4 + 2] = between(random, settings.heat.wobble[0], settings.heat.wobble[1]);
    heat.misc[index * 4 + 3] = random();
  });

  const glow = [];
  const pool = terrain.lavaPool;
  if (pool) {
    glow.push({
      on: 'pool',
      x: pool.x,
      y: pool.level + settings.glow.pool.height,
      z: pool.z,
      ...settings.glow.pool,
      phase: 0,
    });
  }
  const flow = terrain.lavaFlow ?? terrain.lavaSecondaryFlow;
  if (flow?.samples?.length) {
    const mid = flow.samples[Math.floor(flow.samples.length * 0.45)];
    glow.push({
      on: flow.parentFlowId ? 'branch' : 'main',
      x: mid.x,
      y: mid.y + settings.glow.flow.height,
      z: mid.z,
      ...settings.glow.flow,
      phase: 1.7,
    });
  }

  return {
    settings,
    ash,
    heat,
    glow,
    hazeLayers: Math.max(0, Math.floor(settings.haze.layers ?? 0)),
    particleCount: ash.count + heat.count,
  };
}

/* ---- Shared resources ----------------------------------------------------- */

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

function createHazeDiscGeometry(radius, segments = 72) {
  const positions = [0, 0, 0];
  const indices = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * TAU;
    positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  }
  for (let i = 1; i < segments; i += 1) indices.push(0, i + 1, i);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---- Shaders --------------------------------------------------------------- */

const HAZE_VERTEX_SHADER = /* glsl */`
  varying vec3 vWorldPosition;
  varying vec2 vLocal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vLocal = position.xz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const HAZE_FRAGMENT_SHADER = /* glsl */`
  varying vec3 vWorldPosition;
  varying vec2 vLocal;

  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uRadius;
  uniform float uTime;
  uniform vec2 uPhase;
  uniform float uNearFade;
  uniform float uFullFade;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 offset = fract(p);
    vec2 fade = offset * offset * (3.0 - 2.0 * offset);
    float a = hash21(cell);
    float b = hash21(cell + vec2(1.0, 0.0));
    float c = hash21(cell + vec2(0.0, 1.0));
    float d = hash21(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
  }

  float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);
    for (int octave = 0; octave < 4; octave += 1) {
      total += amplitude * valueNoise(p);
      p = rotation * p * 2.11;
      amplitude *= 0.5;
    }
    return total;
  }

  void main() {
    float radius = length(vLocal) / uRadius;
    float edge = 1.0 - smoothstep(0.25, 1.0, radius);
    vec2 phased = vLocal + uPhase;
    float drift = fbm(phased * 0.016 + vec2(uTime * 0.016, uTime * 0.010));
    float wisps = fbm(phased * 0.047 - vec2(uTime * 0.028, uTime * 0.013));
    // The haze keeps well clear of the lens: the ground underfoot stays crisp
    // while the distance softens behind it.
    float nearFade = smoothstep(uNearFade, uFullFade, distance(cameraPosition, vWorldPosition));
    float alpha = uOpacity * edge * nearFade * (0.24 + 0.72 * drift * (0.55 + 0.45 * wisps));
    vec3 color = uColor * (0.84 + 0.30 * drift);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

const ASH_VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uRange;
  uniform vec2 uBreeze;
  uniform float uNearFade;
  uniform float uFullFade;
  uniform float uFarFade;

  attribute vec3 aOrigin;
  attribute vec4 aParams;
  attribute vec2 aWobble;

  varying vec2 vUv;
  varying float vTone;
  varying float vFade;

  void main() {
    // One slow fall per grain: from the air above its own ground back down to
    // it, then around again. fall is 0 at the top of the drop, uRange at the
    // ground it lands on.
    float fall = mod(uTime * aParams.y + aParams.x * uRange, uRange);
    float f = fall / uRange;
    vec3 centre = vec3(aOrigin.x, aOrigin.y + uRange - fall, aOrigin.z);
    centre.x += uBreeze.x * fall * 0.12
      + sin(uTime * 0.9 + aWobble.x * 6.2831 + fall * 0.15) * aWobble.y * f;
    centre.z += uBreeze.y * fall * 0.12
      + cos(uTime * 0.7 + aWobble.x * 8.1643) * aWobble.y * f;

    vec4 worldCentre = modelMatrix * vec4(centre, 1.0);
    float cameraDistance = distance(worldCentre.xyz, cameraPosition);
    float nearFade = smoothstep(uNearFade, uFullFade, cameraDistance);
    float farFade = 1.0 - smoothstep(uFarFade * 0.65, uFarFade, cameraDistance);
    float groundFade = smoothstep(0.0, 2.0, uRange - fall);
    float topFade = smoothstep(0.0, 4.0, fall);
    float fade = nearFade * farFade * groundFade * topFade;

    vUv = position.xy + 0.5;
    vTone = aParams.w;
    vFade = fade;
    if (fade <= 0.002) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec4 viewCentre = modelViewMatrix * vec4(centre, 1.0);
    viewCentre.xy += position.xy * aParams.z;
    gl_Position = projectionMatrix * viewCentre;
  }
`;

const ASH_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;

  varying vec2 vUv;
  varying float vTone;
  varying float vFade;

  void main() {
    vec2 centred = vUv - 0.5;
    float radius = length(centred) * 2.0;
    float disc = 1.0 - smoothstep(0.35, 1.0, radius);
    float alpha = uOpacity * vFade * disc;
    if (alpha < 0.002) discard;
    vec3 color = uColor * (0.82 + 0.36 * vTone);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

const HEAT_VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform vec2 uBreeze;
  uniform float uNearFade;
  uniform float uFullFade;
  uniform float uFarFade;

  attribute vec3 aOrigin;
  attribute vec4 aParams;
  attribute vec4 aMisc;

  varying vec2 vUv;
  varying float vTone;
  varying float vFade;
  varying float vOpacity;

  void main() {
    // A short, fast rise off the lava: born on the molten rock, gone within a
    // couple of seconds. The heading is fixed per wisp; the wobble and the
    // breeze keep the column from ever standing still.
    float life = max(aParams.y, 0.5);
    float age01 = fract(uTime / life + aParams.x);
    float age = age01 * life;
    float tone = aMisc.w;
    vec2 heading = vec2(cos(tone * 6.2831), sin(tone * 6.2831));
    vec2 drift = uBreeze * age * 0.3;
    float wobbleSpeed = 1.8 + tone * 1.6;
    float wobble = sin(age * wobbleSpeed + aParams.x * 6.2831) * aMisc.z * age01;
    vec3 centre = aOrigin + vec3(
      drift.x + heading.x * aMisc.x * age01 + wobble,
      aParams.z * (1.0 - pow(1.0 - age01, 1.2)),
      drift.y + heading.y * aMisc.x * age01 + wobble * 0.6
    );

    vec4 worldCentre = modelMatrix * vec4(centre, 1.0);
    float cameraDistance = distance(worldCentre.xyz, cameraPosition);
    float nearFade = smoothstep(uNearFade, uFullFade, cameraDistance);
    float farFade = 1.0 - smoothstep(uFarFade * 0.7, uFarFade, cameraDistance);
    float lifeFade = smoothstep(0.0, 0.18, age01) * (1.0 - smoothstep(0.55, 1.0, age01));
    float fade = nearFade * farFade * lifeFade;

    vUv = position.xy + 0.5;
    vTone = tone;
    vFade = fade;
    vOpacity = aMisc.y;
    if (fade <= 0.002) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float size = mix(aParams.w * 0.55, aParams.w, smoothstep(0.0, 1.0, age01));
    vec2 corner = position.xy;
    corner.y *= 1.35;
    vec4 viewCentre = modelViewMatrix * vec4(centre, 1.0);
    viewCentre.xy += corner * size;
    gl_Position = projectionMatrix * viewCentre;
  }
`;

const HEAT_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;

  varying vec2 vUv;
  varying float vTone;
  varying float vFade;
  varying float vOpacity;

  void main() {
    vec2 centred = vUv - 0.5;
    float radius = length(centred) * 2.0;
    float soft = 1.0 - smoothstep(0.15, 1.0, radius);
    soft *= soft;
    float alpha = vOpacity * vFade * soft;
    if (alpha < 0.002) discard;
    vec3 color = uColor * (0.95 + 0.10 * vTone);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

function createBillboardGeometry(name, origin, params, misc, quad, paramName, miscName) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = name;
  geometry.setIndex(quad.index);
  geometry.setAttribute('position', quad.position);
  geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
  geometry.setAttribute(paramName, new THREE.InstancedBufferAttribute(params, 4));
  geometry.setAttribute(miscName, new THREE.InstancedBufferAttribute(misc, misc.length / (origin.length / 3)));
  geometry.instanceCount = origin.length / 3;
  return geometry;
}

/**
 * Build HEX_SE's atmosphere: distant haze, falling ash, heat shimmer over the
 * lava and a faint warm glow beside it. Returns `null` when the sector is not
 * HEX_SE or the pass is switched off.
 *
 * The group is in sector-local coordinates, like the lava and the smoke, so
 * the caller places it at the sector's own centre. `update(delta)` advances
 * the one clock, drifts the haze and breathes the lights; `setVisible(false)`
 * steps the whole pass aside, for the overview.
 */
export function buildVolcanicAtmosphere(terrain, config = {}, options = {}) {
  const plan = planVolcanicAtmosphere(terrain, config);
  if (!plan) return null;
  const settings = plan.settings;
  const hexRadius = config.hexRadius ?? 220;

  const group = new THREE.Group();
  group.name = 'VolcanicAtmosphere_HEX_SE';
  group.userData.sectorId = 'HEX_SE';
  group.userData.featureType = 'volcanic-atmosphere';
  group.userData.animates = true;
  group.userData.collidable = false;
  group.userData.lights = plan.glow.length;
  group.userData.particles = plan.particleCount;
  group.userData.ashCount = plan.ash.count;
  group.userData.heatCount = plan.heat.count;
  group.userData.hazeLayers = plan.hazeLayers;

  // One clock and one breeze drive every layer of the pass.
  const shared = {
    uTime: { value: 0 },
    uBreeze: { value: new THREE.Vector2(settings.breeze.x, settings.breeze.z) },
  };

  // --- Distant haze: two faint discs floating over the relief. -------------
  const hazeMeshes = [];
  const hazeRandom = makeRandom((settings.seed ^ 0x1a2e) >>> 0);
  const hazeRadius = hexRadius * (settings.haze.radiusFactor ?? 0.9);
  const hazeColor = new THREE.Color(settings.haze.color);
  const hazeGeometry = createHazeDiscGeometry(hazeRadius);
  for (let layer = 0; layer < plan.hazeLayers; layer += 1) {
    const opacity = settings.haze.opacity * (layer === 0 ? 1 : 0.75);
    const material = new THREE.ShaderMaterial({
      name: `VolcanicHazeMaterial_${layer}_HEX_SE`,
      uniforms: {
        uColor: { value: hazeColor },
        uOpacity: { value: opacity },
        uRadius: { value: hazeRadius },
        uTime: shared.uTime,
        uPhase: { value: new THREE.Vector2(hazeRandom() * 240, hazeRandom() * 240) },
        uNearFade: { value: settings.haze.cameraNear },
        uFullFade: { value: settings.haze.cameraFull },
      },
      vertexShader: HAZE_VERTEX_SHADER,
      fragmentShader: HAZE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(hazeGeometry, material);
    mesh.name = `VolcanicHazeLayer_${layer}_HEX_SE`;
    mesh.position.y = settings.haze.height + layer * settings.haze.spacing;
    mesh.rotation.y = hazeRandom() * TAU;
    mesh.renderOrder = 22 + layer;
    mesh.frustumCulled = false;
    mesh.userData.sectorId = 'HEX_SE';
    mesh.userData.featureType = 'volcanic-haze';
    mesh.userData.collidable = false;
    mesh.userData.layer = layer;
    mesh.userData.opacity = opacity;
    mesh.userData.driftSpeed = settings.haze.driftSpeed * (layer % 2 === 0 ? 1 : -0.72);
    group.add(mesh);
    hazeMeshes.push(mesh);
  }

  // --- Ash and heat: one instanced billboard mesh each. --------------------
  const quad = createQuadAttributes();
  const meshes = {};
  const materials = {};
  const geometries = {};
  if (plan.ash.count > 0) {
    const material = new THREE.ShaderMaterial({
      name: 'VolcanicAshMaterial_HEX_SE',
      uniforms: {
        uTime: shared.uTime,
        uRange: { value: settings.ash.fallRange },
        uBreeze: shared.uBreeze,
        uNearFade: { value: settings.ash.cameraNear },
        uFullFade: { value: settings.ash.cameraFull },
        uFarFade: { value: settings.ash.cameraFar },
        uColor: { value: new THREE.Color(settings.ash.color) },
        uOpacity: { value: settings.ash.opacity },
      },
      vertexShader: ASH_VERTEX_SHADER,
      fragmentShader: ASH_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      fog: false,
    });
    const geometry = createBillboardGeometry(
      'VolcanicAshGeometry_HEX_SE',
      plan.ash.origin, plan.ash.params, plan.ash.wobble,
      quad, 'aParams', 'aWobble',
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'VolcanicAshFall_HEX_SE';
    mesh.userData.sectorId = 'HEX_SE';
    mesh.userData.featureType = 'volcanic-ash';
    mesh.userData.particles = plan.ash.count;
    mesh.userData.collidable = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 27;
    group.add(mesh);
    meshes.ash = mesh;
    materials.ash = material;
    geometries.ash = geometry;
  }
  if (plan.heat.count > 0) {
    const material = new THREE.ShaderMaterial({
      name: 'VolcanicHeatMaterial_HEX_SE',
      uniforms: {
        uTime: shared.uTime,
        uBreeze: shared.uBreeze,
        uNearFade: { value: settings.heat.cameraNear },
        uFullFade: { value: settings.heat.cameraFull },
        uFarFade: { value: settings.heat.cameraFar },
        uColor: { value: new THREE.Color(settings.heat.color) },
      },
      vertexShader: HEAT_VERTEX_SHADER,
      fragmentShader: HEAT_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      fog: false,
    });
    const geometry = createBillboardGeometry(
      'VolcanicHeatGeometry_HEX_SE',
      plan.heat.origin, plan.heat.params, plan.heat.misc,
      quad, 'aParams', 'aMisc',
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'VolcanicHeatShimmer_HEX_SE';
    mesh.userData.sectorId = 'HEX_SE';
    mesh.userData.featureType = 'volcanic-heat-shimmer';
    mesh.userData.particles = plan.heat.count;
    mesh.userData.collidable = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 26;
    group.add(mesh);
    meshes.heat = mesh;
    materials.heat = material;
    geometries.heat = geometry;
  }

  // --- Lava glow: two small warm lights with a short reach. ----------------
  const lights = [];
  for (const placement of plan.glow) {
    const light = new THREE.PointLight(
      placement.color, placement.intensity, placement.distance, placement.decay,
    );
    light.name = placement.on === 'pool' ? 'VolcanicGlowPool_HEX_SE' : 'VolcanicGlowFlow_HEX_SE';
    light.position.set(placement.x, placement.y, placement.z);
    light.userData.sectorId = 'HEX_SE';
    light.userData.featureType = 'volcanic-lava-glow';
    light.userData.baseIntensity = placement.intensity;
    light.userData.phase = placement.phase ?? 0;
    light.userData.collidable = false;
    group.add(light);
    lights.push(light);
  }
  void options;

  let time = 0;
  const flicker = settings.glow.flicker ?? 0.06;
  return {
    group,
    meshes,
    hazeMeshes,
    materials,
    geometries,
    lights,
    uniforms: shared,
    plan,
    particleCount: plan.particleCount,
    get time() {
      return time;
    },
    /** One clock, two drifting discs and two breathing lights. */
    update(delta) {
      time += Math.max(0, delta);
      shared.uTime.value = time;
      for (const mesh of hazeMeshes) mesh.rotation.y += mesh.userData.driftSpeed * Math.max(0, delta);
      for (const light of lights) {
        const base = light.userData.baseIntensity ?? light.intensity;
        const phase = light.userData.phase ?? 0;
        light.intensity = base * (
          1 + flicker * (0.6 * Math.sin(time * 2.1 + phase) + 0.4 * Math.sin(time * 5.3 + phase * 1.7))
        );
      }
    },
    setVisible(visible) {
      group.visible = Boolean(visible);
    },
  };
}
