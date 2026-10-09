/**
 * LavaAnimation — the slow motion of HEX_SE's molten surfaces.
 *
 * The pool and both channels already exist as static, crust-edged sheets
 * (src/world/LavaPool.js, src/world/LavaFlow.js). This module makes only their
 * *molten* rock move. It does that with one patch to the shared lava material
 * and one clock shared by every lava surface; no geometry, vertex colour, UV or
 * boundary is changed by it, and nothing is created per frame.
 *
 * Four decisions shape it.
 *
 * 1. **Only molten rock moves.** The static vertex colours already say where
 *    the lava is cooling: a low green value is cold crust, a high one is molten.
 *    That value drives a mask, so the cooled margins, the rafts and the crust
 *    tile keep their exact static colour and never shift. The crust texture is
 *    still sampled with its original UVs, so it stays where it is.
 *
 * 2. **Channels flow along their own spine, not across the screen.** Each flow
 *    vertex carries its arc length and its place across the bed (see
 *    `aLavaFlow`). The noise is drawn in that channel frame and advected
 *    downstream, faster at the centre than at the banks. Features therefore
 *    follow the channel's direction and bend with its bends, the way a viscous
 *    flow shears, instead of sliding over the rock as a uniform texture would.
 *
 * 3. **The pool churns instead of scrolling.** The pool's noise turns slowly
 *    about its vent, faster towards the rim than at the centre, and a domain
 *    warp folds the heat field as it goes. Heat is then mapped between a dark
 *    red-orange and a bright orange-yellow, with a small emissive bloom where
 *    the heat peaks. Nothing repeats on a fixed cycle, so the surface does not
 *    read as water with a scrolling texture on it.
 *
 * 4. **Time is time, and the clock is shared.** `advanceLavaClock` integrates
 *    the frame's own elapsed seconds, so the motion is identical at 30, 60 or
 *    144 frames a second. Every lava material reads the same uniform object, so
 *    the whole sector advances with one addition per frame.
 *
 * Deliberately absent: no particles, no eruptions, no light, no collider, no
 * damage and no new lava. The animation can be switched off with
 * `lavaAnimationEnabled: false`, which returns the materials to their static
 * look.
 */

/** The look and speed of the molten surfaces, as plain data. */
export const LAVA_ANIMATION_DEFAULTS = Object.freeze({
  // Downstream speed of the molten rock on a channel's centre line, in sector
  // units per second: a slow, viscous creep, well under a walking pace.
  flowSpeed: 0.32,
  // The share of that speed lost at the banks. The centre runs fastest, so the
  // surface shears like a real channel rather than sliding as one sheet.
  shear: 0.75,
  // Noise cells per world unit on the surface. Features are a few units across.
  frequency: 0.16,
  // Extra stretch of the channel noise across the bed. Above 1, features are
  // narrower across the flow than along it, so they read as streaks downstream.
  crossScale: 3,
  // The pool's convection about its vent, in radians per second at the vent.
  // The rim turns more slowly than the centre, which keeps the motion from
  // rotating like a record.
  swirl: 0.04,
  // How hard the domain warp folds the heat field, and how fast the fold itself
  // turns over (per second). Larger warp and churn deform the heat more and
  // translate it less, so it reads as molten rock rather than a sliding texture.
  warp: 1.5,
  churn: 0.1,
  // The vertex heat (its green channel) below which a point is cold crust and
  // above which it is molten rock. Between them the motion fades in.
  maskLow: 0.17,
  maskHigh: 0.34,
  // The darkest and the brightest multipliers on the molten rock's glow: a
  // red-orange at the cooler end, an orange-yellow where the heat peaks.
  ember: Object.freeze([0.8, 0.42, 0.2]),
  glow: Object.freeze([1.16, 1.1, 0.88]),
  // The bloom added where the heat peaks, in the warm colour of the hottest rock.
  core: 0.32,
  coreColor: Object.freeze([1.0, 0.55, 0.15]),
});

/**
 * The one clock every animated lava surface reads. It is a plain uniform
 * object, shared by reference, so advancing it updates every lava material at
 * once and the materials themselves never change.
 */
export const LAVA_CLOCK = Object.freeze({ uTime: { value: 0 } });

/**
 * Advance the lava clock by one frame's elapsed seconds. Non-positive and
 * non-finite steps are ignored, so the clock never runs backwards or jumps.
 * Returns the clock's value after the step.
 */
export function advanceLavaClock(deltaSeconds) {
  const dt = Number(deltaSeconds);
  if (Number.isFinite(dt) && dt > 0) LAVA_CLOCK.uTime.value += dt;
  return LAVA_CLOCK.uTime.value;
}

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * The animation settings for a configuration, or `null` when the molten
 * surfaces are meant to stay static. `lavaAnimationEnabled: false` (or
 * `lavaAnimation: false` / `null`) switches it off; `lavaAnimation` overrides
 * individual defaults.
 */
export function resolveLavaAnimation(config = {}) {
  if (config.lavaAnimationEnabled === false || config.lavaAnimation === false
    || config.lavaAnimation === null) return null;
  const given = config.lavaAnimation ?? {};
  const d = LAVA_ANIMATION_DEFAULTS;
  const triple = (value, fallback) => (Array.isArray(value) && value.length === 3
    && value.every(Number.isFinite) ? Object.freeze([...value]) : fallback);
  return Object.freeze({
    flowSpeed: Math.max(0, finiteOr(given.flowSpeed, d.flowSpeed)),
    shear: Math.max(0, Math.min(1, finiteOr(given.shear, d.shear))),
    frequency: Math.max(0.01, finiteOr(given.frequency, d.frequency)),
    crossScale: Math.max(0.1, finiteOr(given.crossScale, d.crossScale)),
    swirl: finiteOr(given.swirl, d.swirl),
    warp: Math.max(0, finiteOr(given.warp, d.warp)),
    churn: Math.max(0, finiteOr(given.churn, d.churn)),
    maskLow: finiteOr(given.maskLow, d.maskLow),
    maskHigh: Math.max(finiteOr(given.maskLow, d.maskLow) + 1e-3, finiteOr(given.maskHigh, d.maskHigh)),
    ember: triple(given.ember, d.ember),
    glow: triple(given.glow, d.glow),
    core: Math.max(0, finiteOr(given.core, d.core)),
    coreColor: triple(given.coreColor, d.coreColor),
  });
}

/** A stable key for everything the compiled animation depends on. */
export function lavaAnimationKey(settings) {
  return [
    settings.flowSpeed, settings.shear, settings.frequency, settings.crossScale,
    settings.swirl, settings.warp, settings.churn, settings.maskLow, settings.maskHigh,
    ...settings.ember, ...settings.glow, settings.core, ...settings.coreColor,
  ].join('|');
}

/**
 * The molten mask on the CPU, for tests and tools. It is the same smooth ramp
 * the fragment shader evaluates from the vertex heat (`smoothstep` on green):
 * 0 on cold crust, 1 on molten rock.
 */
export function lavaMoltenMask(heat, settings = LAVA_ANIMATION_DEFAULTS) {
  const span = settings.maskHigh - settings.maskLow;
  const t = Math.max(0, Math.min(1, (heat - settings.maskLow) / span));
  return t * t * (3 - 2 * t);
}

/* ---- The shader patch --------------------------------------------------
 * Two insertions into the standard material's shaders, both guarded by
 * `USE_ANIMATED_LAVA`, which only an animated lava material defines.
 *   vertex:   pass each vertex's flow coordinates to the fragment stage;
 *   fragment: after the emissive map, tint and brighten the molten rock.
 * The noise is value noise with a quintic-free smooth step and a hash that
 * does not rely on sin(), so it stays well conditioned on mobile GPUs.
 */

const fmt = (n) => {
  const value = Number(n);
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
};
const vec3Literal = (triple) => `vec3(${triple.map(fmt).join(', ')})`;

/** The per-settings `#define`s the fragment shader reads. */
export function lavaAnimationDefines(settings) {
  return [
    `#define LAVA_FLOW_SPEED ${fmt(settings.flowSpeed)}`,
    `#define LAVA_SHEAR ${fmt(settings.shear)}`,
    `#define LAVA_FREQ ${fmt(settings.frequency)}`,
    `#define LAVA_CROSS_SCALE ${fmt(settings.crossScale)}`,
    `#define LAVA_SWIRL ${fmt(settings.swirl)}`,
    `#define LAVA_WARP ${fmt(settings.warp)}`,
    `#define LAVA_CHURN ${fmt(settings.churn)}`,
    `#define LAVA_MASK_LOW ${fmt(settings.maskLow)}`,
    `#define LAVA_MASK_HIGH ${fmt(settings.maskHigh)}`,
    `#define LAVA_EMBER ${vec3Literal(settings.ember)}`,
    `#define LAVA_GLOW ${vec3Literal(settings.glow)}`,
    `#define LAVA_CORE ${fmt(settings.core)}`,
    `#define LAVA_CORE_COLOR ${vec3Literal(settings.coreColor)}`,
  ].join('\n');
}

export const LAVA_ANCHORS = Object.freeze({
  vertexPars: '#include <common>',
  vertexMain: '#include <begin_vertex>',
  fragmentPars: '#include <common>',
  fragmentMain: '#include <emissivemap_fragment>',
});

const VERTEX_PARS = `
#ifdef USE_ANIMATED_LAVA
\tattribute vec4 aLavaFlow;
\tvarying vec4 vLavaFlow;
#endif`;

const VERTEX_MAIN = `
#ifdef USE_ANIMATED_LAVA
\tvLavaFlow = aLavaFlow;
#endif`;

const FRAGMENT_PARS = `
#ifdef USE_ANIMATED_LAVA
\tuniform float uLavaTime;
\tvarying vec4 vLavaFlow;

\tfloat lavaHash( vec2 p ) {
\t\tvec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
\t\tp3 += dot( p3, p3.yzx + 33.33 );
\t\treturn fract( ( p3.x + p3.y ) * p3.z );
\t}

\tfloat lavaNoise( vec2 p ) {
\t\tvec2 i = floor( p );
\t\tvec2 f = fract( p );
\t\tvec2 u = f * f * ( 3.0 - 2.0 * f );
\t\treturn mix(
\t\t\tmix( lavaHash( i ), lavaHash( i + vec2( 1.0, 0.0 ) ), u.x ),
\t\t\tmix( lavaHash( i + vec2( 0.0, 1.0 ) ), lavaHash( i + vec2( 1.0, 1.0 ) ), u.x ),
\t\t\tu.y
\t\t);
\t}

\t// Three octaves, normalised to 0..1. Each octave is a new lattice, not a
\t// rotation, so the field never lines up with the sector's own grid.
\tfloat lavaFbm( vec2 p ) {
\t\tfloat sum = 0.0;
\t\tfloat amplitude = 0.5;
\t\tfor ( int i = 0; i < 3; i ++ ) {
\t\t\tsum += amplitude * lavaNoise( p );
\t\t\tp = p * 2.03 + vec2( 1.7, 9.2 );
\t\t\tamplitude *= 0.5;
\t\t}
\t\treturn sum / 0.875;
\t}
#endif`;

const FRAGMENT_MAIN = `
#ifdef USE_ANIMATED_LAVA
\t{
\t\t// Only molten rock moves. The static vertex heat says where it is molten:
\t\t// cold crust, rafts and the chilled margin keep their colour exactly.
\t\tfloat lavaMask = smoothstep( LAVA_MASK_LOW, LAVA_MASK_HIGH, vColor.g );
\t\tfloat lavaT = uLavaTime;

\t\t// A channel: noise in the channel's own frame, advected downstream
\t\t// (+s) and faster on the centre line than at the banks.
\t\tfloat edge = abs( vLavaFlow.w );
\t\tfloat channelSpeed = LAVA_FLOW_SPEED * LAVA_FREQ * ( 1.0 - LAVA_SHEAR * edge * edge );
\t\tvec2 channelQ = vec2(
\t\t\tvLavaFlow.x * LAVA_FREQ - lavaT * channelSpeed,
\t\t\tvLavaFlow.y * LAVA_FREQ * LAVA_CROSS_SCALE
\t\t);

\t\t// The pool: noise about its own vent, turning slowly and more slowly
\t\t// towards the rim.
\t\tvec2 poolP = vLavaFlow.xy;
\t\tfloat radius = length( poolP );
\t\tfloat angle = lavaT * LAVA_SWIRL / ( 1.0 + 0.08 * radius );
\t\tfloat ca = cos( angle );
\t\tfloat sa = sin( angle );
\t\tvec2 poolQ = mat2( ca, sa, -sa, ca ) * poolP * LAVA_FREQ;

\t\tvec2 q = mix( poolQ, channelQ, vLavaFlow.z );

\t\t// Domain warp: the field folds and breathes on its own clock, so the
\t\t// heat never reads as one texture sliding past.
\t\tvec2 warp = vec2(
\t\t\tlavaFbm( q * 0.9 + vec2( 0.0, lavaT * LAVA_CHURN ) ),
\t\t\tlavaFbm( q * 0.9 + vec2( 5.2, 1.3 ) + vec2( lavaT * LAVA_CHURN * 0.78, 0.0 ) )
\t\t);
\t\tfloat field = lavaFbm( q + ( warp - 0.5 ) * LAVA_WARP );
\t\t// A finer simmer, drifting on its own, so the bright spots flicker softly.
\t\tfloat simmer = lavaNoise( q * 2.6 + vec2( lavaT * 0.09, -lavaT * 0.06 ) );
\t\t// A slow pulse in place: each cell swells and dims on its own phase. It never
		// moves, so it breaks up the sliding of the heat without fighting the flow.
		float breath = 0.5 + 0.5 * sin( lavaT * 0.6 + 6.2831 * lavaNoise( q * 0.7 + 3.1 ) );
		float heat = clamp( smoothstep( 0.34, 0.66, field ) * 0.78 + simmer * 0.12 + breath * 0.1, 0.0, 1.0 );

\t\tvec3 tint = mix( LAVA_EMBER, LAVA_GLOW, heat );
\t\tvec3 blend = mix( vec3( 1.0 ), tint, lavaMask );
\t\tdiffuseColor.rgb *= blend;
\t\ttotalEmissiveRadiance *= blend;
\t\ttotalEmissiveRadiance += LAVA_CORE_COLOR * lavaMask * pow( heat, 4.0 ) * LAVA_CORE;
\t}
#endif`;

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

/**
 * Patch a lava material's shaders for the animation, in place. The clock is
 * shared by reference, so the shader reads whatever the current time is.
 * A shader object without a vertex stage (the tests hand in a fragment-only
 * one) is patched in the stages it does have. Returns the patch report.
 */
export function patchLavaAnimation(shader, settings, report = { landed: 0, missing: [] }) {
  shader.uniforms = shader.uniforms ?? {};
  shader.uniforms.uLavaTime = LAVA_CLOCK.uTime;
  const defines = lavaAnimationDefines(settings);
  if (typeof shader.vertexShader === 'string') {
    let vertex = inject(shader.vertexShader, LAVA_ANCHORS.vertexPars, VERTEX_PARS, report, 'vertexPars');
    vertex = inject(vertex, LAVA_ANCHORS.vertexMain, VERTEX_MAIN, report, 'vertexMain');
    shader.vertexShader = `#define USE_ANIMATED_LAVA\n${vertex}`;
  }
  let fragment = inject(shader.fragmentShader, LAVA_ANCHORS.fragmentPars, FRAGMENT_PARS, report, 'fragmentPars');
  fragment = inject(fragment, LAVA_ANCHORS.fragmentMain, FRAGMENT_MAIN, report, 'fragmentMain');
  shader.fragmentShader = `#define USE_ANIMATED_LAVA\n${defines}\n${fragment}`;
  return report;
}

/** The shader-program cache key of an animated lava material: one program per animation look. */
export function animatedLavaMaterialKey(settings) {
  return `animated-lava:${lavaAnimationKey(settings)}`;
}
