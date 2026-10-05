/**
 * A shared wind animation injected into the standard vertex shader.
 *
 * Everything that should move in the breeze — pine needles, grass tufts, fern
 * fronds — shares a single time uniform, so the whole forest sways on the same
 * gust. The displacement grows with height (a quadratic falloff), which keeps
 * trunks and root plates planted while the crowns and tips travel visibly.
 */

const WIND_VERTEX_CHUNK = /* glsl */`
  vec3 transformed = vec3( position );

  #ifdef USE_INSTANCING
    vec3 windOrigin = instanceMatrix[3].xyz;
  #else
    vec3 windOrigin = vec3( 0.0 );
  #endif

  float windHeight = clamp( transformed.y / uWindHeight, 0.0, 1.0 );
  float gust = 0.70 + 0.30 * sin( uWindTime * 0.23 + ( windOrigin.x + transformed.x ) * 0.012 );
  float windPhase = uWindTime * uWindFrequency
    + ( windOrigin.x + transformed.x ) * 0.075
    + ( windOrigin.z + transformed.z ) * 0.095;
  float windAmplitude = pow( windHeight, uWindBend ) * uWindStrength * gust;

  transformed.x += sin( windPhase ) * windAmplitude;
  transformed.z += cos( windPhase * 0.83 + 1.7 ) * windAmplitude * 0.68;
`;

export function createWindUniforms() {
  return { time: { value: 0 } };
}

export function applyWindSway(material, uniforms, options = {}) {
  const {
    strength = 0.4,
    frequency = 1.25,
    heightScale = 26,
    bend = 2,
  } = options;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = uniforms.time;
    shader.uniforms.uWindStrength = { value: strength };
    shader.uniforms.uWindFrequency = { value: frequency };
    shader.uniforms.uWindHeight = { value: Math.max(0.001, heightScale) };
    shader.uniforms.uWindBend = { value: bend };
    shader.vertexShader = [
      'uniform float uWindTime;',
      'uniform float uWindStrength;',
      'uniform float uWindFrequency;',
      'uniform float uWindHeight;',
      'uniform float uWindBend;',
      shader.vertexShader.replace('#include <begin_vertex>', WIND_VERTEX_CHUNK),
    ].join('\n');
  };
  material.customProgramCacheKey = () => (
    `wind-sway-${strength}-${frequency}-${heightScale}-${bend}`
  );
  return material;
}
