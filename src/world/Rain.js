import * as THREE from 'three';
import { isPointInsideHex } from './hexGrid.js';
import { between, makeRandom } from './random.js';

/**
 * HEX_S weather: a seeded field of falling rain streaks and the impact ripples
 * that answer them on the ground.
 *
 * Two decisions shape this module.
 *
 * 1. **The drops live where the terrain lives.** Both meshes are planted once,
 *    at build time, on the same baked lattice the explorer walks on
 *    (`ForestTerrain.heightAt`, through HexMap): a streak's column carries its
 *    own landing height and a ripple is tilted into the slope it lands on. Fog,
 *    ground and rain therefore agree about where the floor is — a drop melts
 *    into the relief it is actually above, not into some global plane.
 *
 * 2. **The animation is on the GPU.** A whole-sector downpour is tens of
 *    thousands of drops; composing that many matrices per frame would cost more
 *    than the forest itself. Everything time-driven — the fall, the recycle,
 *    the ripple growth — happens in the vertex shader from one shared clock, so
 *    a hundred thousand triangles cost one draw call each and a single float
 *    update per frame. The CPU only ever builds the field.
 *
 * The field covers the sector, so the player can walk (or fly) anywhere in
 * HEX_S and always be inside the rain; each drop and each ripple fades out with
 * the distance to the camera, so the density near the lens is what the eye
 * reads and the rest quietly steps out of the shader.
 */

const TAU = Math.PI * 2;

/** A unit rain streak: `position.y` runs 0 (head) to 1 (tail). */
function createStreakGeometry() {
  const positions = [
    -0.5, 0, 0,
    0.5, 0, 0,
    0.5, 1, 0,
    -0.5, 0, 0,
    0.5, 1, 0,
    -0.5, 1, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'RainStreakGeometry';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // Smallest ring of quads to describe a streak; two triangles.
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A thin annulus in the XZ plane: inner 0.72, outer 1.0 of the unit ring.
 * Twelve segments is the sweet spot for a splash: the ring is never more than
 * half a metre across before it fades, and every vertex of every ripple is
 * shaded whether or not the ripple survives the camera fade.
 */
function createRippleGeometry(segments = 12) {
  const positions = [];
  const inner = 0.72;
  for (let segment = 0; segment < segments; segment += 1) {
    const start = (segment / segments) * TAU;
    const end = ((segment + 1) / segments) * TAU;
    const cosStart = Math.cos(start);
    const sinStart = Math.sin(start);
    const cosEnd = Math.cos(end);
    const sinEnd = Math.sin(end);
    positions.push(
      cosStart * inner, 0, sinStart * inner,
      cosStart, 0, sinStart,
      cosEnd, 0, sinEnd,
      cosStart * inner, 0, sinStart * inner,
      cosEnd, 0, sinEnd,
      cosEnd * inner, 0, sinEnd * inner,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'RainRippleGeometry';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

const STREAK_VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uRange;
  uniform float uSpeed;
  uniform vec2 uDrift;
  uniform float uCameraRadius;

  attribute float aPhase;
  attribute float aSpeed;
  attribute vec2 aSize;

  varying vec2 vStreak;
  varying float vFade;
  varying float vShade;

  void main() {
    // The instance matrix carries the drop's column, translation only:
    // x/z is where it falls and y is the height it will land on.
    vec3 column = instanceMatrix[3].xyz;
    float fall = mod(uTime * uSpeed * aSpeed + aPhase * uRange, uRange);
    vec3 center = vec3(column.x, column.y + uRange - fall, column.z);
    // Rain travels sideways as well as down: the horizontal drift is shared
    // with the wind, and it is the same vector that leans the streak.
    center.xz += uDrift * (fall / uRange);

    vec3 worldCenter = (modelMatrix * vec4(center, 1.0)).xyz;
    float cameraDistance = distance(worldCenter, cameraPosition);
    // Three fades keep the cost where the eye is: a bubble around the lens,
    // a soft landing in the last few metres above the ground, and no drop
    // popping into existence at the top of its fall.
    float fade = 1.0 - smoothstep(uCameraRadius * 0.62, uCameraRadius, cameraDistance);
    fade *= smoothstep(0.0, 5.0, center.y - column.y);
    fade *= 1.0 - smoothstep(uRange - 18.0, uRange, fall);
    if (fade <= 0.002) {
      // Off screen and out of the rasteriser: a cheap way to cull a bubble
      // inside a mesh that is never frustum culled as a whole.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vStreak = vec2(0.0);
      vFade = 0.0;
      vShade = 0.0;
      return;
    }

    // A streak points along its own velocity, projected into screen space and
    // built as a billboard in view space, so it stays thin from any angle.
    vec3 velocity = normalize(vec3(uDrift.x, -uRange, uDrift.y));
    vec2 axis = (viewMatrix * vec4(velocity, 0.0)).xy;
    axis = length(axis) < 1e-4 ? vec2(0.0, -1.0) : normalize(axis);
    vec2 across = vec2(-axis.y, axis.x);

    vec4 viewCenter = modelViewMatrix * vec4(center, 1.0);
    viewCenter.xy += axis * (-position.y * aSize.y) + across * (position.x * aSize.x);
    gl_Position = projectionMatrix * viewCenter;

    vStreak = vec2(position.x, position.y);
    vFade = fade;
    vShade = 0.72 + 0.28 * fract(aPhase * 13.37);
  }
`;

const STREAK_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;

  varying vec2 vStreak;
  varying float vFade;
  varying float vShade;

  void main() {
    float body = smoothstep(1.0, 0.3, abs(vStreak.x) * 2.0);
    float tail = smoothstep(0.0, 0.18, vStreak.y) * (1.0 - smoothstep(0.68, 1.0, vStreak.y));
    float alpha = uOpacity * vFade * vShade * body * tail;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(uColor, clamp(alpha, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

const RIPPLE_VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uRate;
  uniform float uMaxRadius;
  uniform float uCameraRadius;

  attribute float aPhase;
  attribute float aSize;

  varying float vRing;
  varying float vFade;

  void main() {
    // Every ripple runs its own loop: it grows out of the point it lands on,
    // fades, and starts again, so a static scatter reads as a downpour.
    float life = fract(uTime * uRate + aPhase);
    float radius = mix(0.14, 1.0, life) * uMaxRadius * aSize;
    vec3 local = vec3(position.x * radius, 0.0, position.z * radius);
    vec4 world = modelMatrix * instanceMatrix * vec4(local, 1.0);

    float cameraDistance = distance(world.xyz, cameraPosition);
    float fade = 1.0 - smoothstep(uCameraRadius * 0.55, uCameraRadius, cameraDistance);
    fade *= (1.0 - life) * (1.0 - life);
    if (fade <= 0.004) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vRing = 0.0;
      vFade = 0.0;
      return;
    }

    gl_Position = projectionMatrix * viewMatrix * world;
    float radial = length(position.xz);
    vRing = smoothstep(0.70, 0.82, radial) * (1.0 - smoothstep(0.90, 1.0, radial));
    vFade = fade;
  }
`;

const RIPPLE_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vRing;
  varying float vFade;

  void main() {
    float alpha = uOpacity * vFade * vRing;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(uColor, clamp(alpha, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

/**
 * Builds the HEX_S rain field.
 *
 * `options.heightAt(x, z)` and `options.normalAt(x, z, target)` are the world's
 * own terrain reads (HexMap passes `getTerrainHeightAt` / `getTerrainNormalAt`),
 * so every drop and every ripple sits on the surface the player can see.
 */
export function buildForestRain(sector, config = {}, options = {}) {
  const heightAt = typeof options.heightAt === 'function' ? options.heightAt : () => 0;
  const normalAt = typeof options.normalAt === 'function'
    ? options.normalAt
    : (x, z, target) => target.set(0, 1, 0);

  let enabled = config.forestRainEnabled !== false;
  const group = new THREE.Group();
  group.name = 'ForestRain_HEX_S';
  group.userData.sectorId = sector.id;
  group.userData.weather = 'rain';

  const uniforms = {
    uTime: { value: 0 },
    uRange: { value: Math.max(20, config.forestRainFallRange ?? 120) },
    uSpeed: { value: config.forestRainSpeed ?? 46 },
    uDrift: {
      value: new THREE.Vector2(
        config.forestRainDrift?.x ?? 9,
        config.forestRainDrift?.z ?? 4,
      ),
    },
    uCameraRadius: { value: config.forestRainCameraRadius ?? 68 },
    uColor: { value: new THREE.Color(config.forestRainColor ?? 0xdff1ff) },
    uOpacity: { value: config.forestRainOpacity ?? 0.34 },
  };

  const rippleUniforms = {
    uTime: uniforms.uTime,
    uRate: { value: config.forestRainRippleRate ?? 1.05 },
    uMaxRadius: { value: config.forestRainRippleRadius ?? 0.62 },
    uCameraRadius: { value: config.forestRainRippleCameraRadius ?? 34 },
    uColor: { value: new THREE.Color(config.forestRainRippleColor ?? 0xcfe9f4) },
    uOpacity: { value: config.forestRainRippleOpacity ?? 0.5 },
  };

  const hexRadius = Math.max(10, config.hexRadius ?? 220);
  // Stays clear of the rim, so no drop falls over the wall into a neighbour.
  const fieldRadius = Math.max(8, hexRadius - 5);
  const random = makeRandom(0x9a17 + (sector.order ?? 0) * 977);

  const streakCount = Math.max(0, Math.floor(config.forestRainStreakCount ?? 30000));
  let streaks = null;
  if (streakCount > 0) {
    const geometry = createStreakGeometry();
    const phases = new Float32Array(streakCount);
    const speeds = new Float32Array(streakCount);
    const sizes = new Float32Array(streakCount * 2);
    const width = config.forestRainWidth ?? 0.05;
    const length = config.forestRainLength ?? 1.6;
    const transform = new THREE.Object3D();

    streaks = new THREE.InstancedMesh(
      geometry,
      new THREE.ShaderMaterial({
        name: 'ForestRainStreakMaterial',
        uniforms,
        vertexShader: STREAK_VERTEX_SHADER,
        fragmentShader: STREAK_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
      streakCount,
    );
    streaks.name = 'ForestRainStreaks_HEX_S';
    streaks.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // One mesh covers the whole sector and the shader moves the drops, so the
    // bounding sphere would be a lie; the per-drop fade does the culling.
    streaks.frustumCulled = false;
    // In front of the mist (renderOrder 30+): falling rain stays crisp while
    // the ground haze still pools behind it.
    streaks.renderOrder = 40;
    streaks.userData.sectorId = sector.id;
    streaks.userData.streakCount = streakCount;

    for (let index = 0; index < streakCount; index += 1) {
      let localX = 0;
      let localZ = 0;
      do {
        localX = (random() * 2 - 1) * fieldRadius;
        localZ = (random() * 2 - 1) * fieldRadius;
      } while (!isPointInsideHex(localX, localZ, 0, 0, fieldRadius));

      const worldX = sector.center.x + localX;
      const worldZ = sector.center.z + localZ;
      // The instance translation is the column this drop falls down: x/z is
      // where it lands and y is the height it lands on. The shader starts the
      // drop a full fall above this point and melts it into the ground here.
      transform.position.set(worldX, heightAt(worldX, worldZ) ?? 0, worldZ);
      transform.updateMatrix();
      streaks.setMatrixAt(index, transform.matrix);
      phases[index] = random();
      speeds[index] = between(random, 0.8, 1.3);
      sizes[index * 2] = width * between(random, 0.7, 1.35);
      sizes[index * 2 + 1] = length * between(random, 0.72, 1.35);
    }

    geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    geometry.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speeds, 1));
    geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
    streaks.instanceMatrix.needsUpdate = true;
    group.add(streaks);
  }

  const rippleCount = Math.max(0, Math.floor(config.forestRainRippleCount ?? 5200));
  let ripples = null;
  if (rippleCount > 0) {
    const geometry = createRippleGeometry();
    const phases = new Float32Array(rippleCount);
    const sizes = new Float32Array(rippleCount);
    const transform = new THREE.Object3D();
    const normal = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const tilt = new THREE.Quaternion();

    ripples = new THREE.InstancedMesh(
      geometry,
      new THREE.ShaderMaterial({
        name: 'ForestRainRippleMaterial',
        uniforms: rippleUniforms,
        vertexShader: RIPPLE_VERTEX_SHADER,
        fragmentShader: RIPPLE_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
      rippleCount,
    );
    ripples.name = 'ForestRainRipples_HEX_S';
    ripples.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // One mesh covers the whole sector and the shader grows the rings, so the
    // bounding sphere would be a lie; the per-ripple fade does the culling.
    ripples.frustumCulled = false;
    // Ripples sit under the mist (renderOrder 30+), so the fog veils the
    // splashes in the distance exactly like it veils the ground.
    ripples.renderOrder = 12;
    ripples.userData.sectorId = sector.id;
    ripples.userData.rippleCount = rippleCount;

    for (let index = 0; index < rippleCount; index += 1) {
      let localX = 0;
      let localZ = 0;
      do {
        localX = (random() * 2 - 1) * fieldRadius;
        localZ = (random() * 2 - 1) * fieldRadius;
      } while (!isPointInsideHex(localX, localZ, 0, 0, fieldRadius));

      const worldX = sector.center.x + localX;
      const worldZ = sector.center.z + localZ;
      normalAt(worldX, worldZ, normal);
      tilt.setFromUnitVectors(up, normal);
      // Lifted clear of the leaf litter (which settles 5-10 cm over the soil)
      // so a splash is never read through a leaf lying on top of it.
      transform.position.set(worldX, (heightAt(worldX, worldZ) ?? 0) + 0.16, worldZ);
      transform.quaternion.copy(tilt);
      transform.updateMatrix();
      phases[index] = random();
      sizes[index] = between(random, 0.7, 1.45);
      ripples.setMatrixAt(index, transform.matrix);
    }

    geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 1));
    ripples.instanceMatrix.needsUpdate = true;
    group.add(ripples);
  }

  group.userData.streakCount = streakCount;
  group.userData.rippleCount = rippleCount;
  group.userData.fallRange = uniforms.uRange.value;
  group.userData.cameraRadius = uniforms.uCameraRadius.value;

  let time = 0;
  return {
    group,
    streaks,
    ripples,
    streakCount,
    rippleCount,
    uniforms,
    rippleUniforms,
    get isEnabled() {
      return enabled;
    },
    get time() {
      return time;
    },
    /** One clock drives the fall, the recycle and the ripples. */
    update(delta) {
      if (!enabled) return false;
      time += Math.max(0, delta);
      uniforms.uTime.value = time;
      return true;
    },
    /** Weather switch, kept off the keyboard: rain is a world setting. */
    setEnabled(next) {
      enabled = Boolean(next);
      group.visible = enabled;
      return enabled;
    },
    setVisible(visible) {
      group.visible = Boolean(visible) && enabled;
    },
  };
}
