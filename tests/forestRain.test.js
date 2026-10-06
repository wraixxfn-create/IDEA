import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { isPointInsideHex } from '../src/world/hexGrid.js';
import { buildForestRain } from '../src/world/Rain.js';
import { installCanvasStub } from './domStub.js';

installCanvasStub();

const RADIUS = MAP_CONFIG.hexRadius;

function makeMap() {
  return new HexMap(new THREE.Scene(), MAP_CONFIG);
}

/**
 * The rain field is a whole-sector scatter, so the tests read a spread of
 * instances rather than all thirty-odd thousand of them.
 */
const SAMPLE_STRIDE = 97;

test('the forest is the only sector with rain, and it covers the whole hex', () => {
  const map = makeMap();
  const rain = map.forestRain;

  assert.ok(rain, 'HEX_S carries a rain field');
  assert.equal(map.rain, rain, 'the field is reachable under both names');
  assert.equal(rain.group.name, 'ForestRain_HEX_S');
  assert.equal(rain.group.userData.sectorId, 'HEX_S');
  assert.equal(rain.group.userData.weather, 'rain');

  assert.equal(rain.streakCount, MAP_CONFIG.forestRainStreakCount);
  assert.equal(rain.rippleCount, MAP_CONFIG.forestRainRippleCount);
  assert.equal(rain.streaks.count, MAP_CONFIG.forestRainStreakCount);
  assert.equal(rain.ripples.count, MAP_CONFIG.forestRainRippleCount);
  assert.equal(rain.group.parent, map.group, 'the rain is part of the world');

  // Exactly one rain field: the other seven sectors keep their painted skies.
  const rainGroups = map.group.children.filter((child) => child.name === 'ForestRain_HEX_S');
  assert.equal(rainGroups.length, 1);

  // One mesh each, and both are animated, never culled as a whole: the shader
  // moves the drops, so their bounding spheres would be a lie.
  for (const mesh of [rain.streaks, rain.ripples]) {
    assert.equal(mesh.frustumCulled, false);
    assert.equal(mesh.material.transparent, true);
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.material.uniforms.uTime, rain.uniforms.uTime,
      'both fields are driven by the same clock');
  }
  // The ripples sit under the mist and the streaks in front of it.
  assert.ok(rain.ripples.renderOrder < 30);
  assert.ok(rain.streaks.renderOrder > 30);
  assert.ok(rain.uniforms.uCameraRadius.value > 0);
  assert.ok(rain.rippleUniforms.uCameraRadius.value > 0);
});

test('drops land on the baked relief and ripples lie on the slope they hit', () => {
  const map = makeMap();
  const rain = map.forestRain;
  const sector = map.getSector('HEX_S');
  const fieldRadius = RADIUS - 5;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const groundNormal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let sampled = 0;

  for (let index = 0; index < rain.streakCount; index += SAMPLE_STRIDE) {
    rain.streaks.getMatrixAt(index, matrix);
    position.setFromMatrixPosition(matrix);
    const localX = position.x - sector.center.x;
    const localZ = position.z - sector.center.z;
    assert.ok(isPointInsideHex(localX, localZ, 0, 0, fieldRadius),
      `drop ${index} falls inside HEX_S, clear of the rim`);
    // The instance translation *is* the landing height: the shader starts the
    // drop a full fall above this point and melts it into the ground here. The
    // instance matrix stores float32, so the column is compared to the millimetre
    // rather than to the last bit — the terrain read is byte-identical at build
    // time, only the stored coordinate is rounded.
    const landingHeight = map.getFloorHeightAt(position.x, position.z);
    assert.ok(Math.abs(position.y - landingHeight) < 5e-3,
      `drop ${index} carries the height it lands on `
      + `(${position.y.toFixed(4)} vs ${landingHeight.toFixed(4)})`);
    sampled += 1;
  }
  assert.ok(sampled > 100, `the sample covered the field (${sampled} drops)`);

  for (let index = 0; index < rain.rippleCount; index += SAMPLE_STRIDE) {
    rain.ripples.getMatrixAt(index, matrix);
    position.setFromMatrixPosition(matrix);
    const localX = position.x - sector.center.x;
    const localZ = position.z - sector.center.z;
    assert.ok(isPointInsideHex(localX, localZ, 0, 0, fieldRadius));
    const ground = map.getFloorHeightAt(position.x, position.z);
    assert.ok(Math.abs(position.y - (ground + 0.16)) < 1e-3,
      `ripple ${index} sits just above the terrain and clear of the leaf litter`);

    // The ring is tilted into the slope: the instance's local +Y is the
    // terrain normal at that point.
    normal.set(matrix.elements[4], matrix.elements[5], matrix.elements[6]).normalize();
    map.getTerrainNormalAt(position.x, position.z, groundNormal);
    assert.ok(normal.dot(groundNormal) > 0.9999,
      `ripple ${index} lies flat on the slope it landed on`);
    assert.ok(up.dot(normal) > 0.5, 'the relief never turns a ripple over');
  }
});

test('one clock drives the fall, the ripples and the world tick', () => {
  const map = makeMap();
  const rain = map.forestRain;
  assert.equal(rain.time, 0);
  assert.equal(rain.uniforms.uTime.value, 0);

  rain.update(0.5);
  assert.equal(rain.time, 0.5);
  assert.equal(rain.uniforms.uTime.value, 0.5);
  assert.equal(rain.rippleUniforms.uTime.value, 0.5, 'the ripples read the same clock');

  // The world tick advances the weather along with the mist and the wind.
  map.update(1 / 60, new THREE.Vector3());
  assert.ok(Math.abs(rain.uniforms.uTime.value - (0.5 + 1 / 60)) < 1e-9);

  // Negative deltas cannot wind the weather backwards.
  rain.update(-1);
  assert.ok(Math.abs(rain.uniforms.uTime.value - (0.5 + 1 / 60)) < 1e-9);
});

test('the overview hides the rain and the weather switch clears it', () => {
  const map = makeMap();
  const rain = map.forestRain;
  assert.equal(rain.isEnabled, true);
  assert.equal(rain.group.visible, true);

  // F3 overview: the annotated map must stay readable through the downpour.
  map.setDebugVisible(true);
  assert.equal(rain.group.visible, false);
  map.setDebugVisible(false);
  assert.equal(rain.group.visible, true);

  // `false` clears the sky over the wood and stops the clock.
  assert.equal(map.setRainEnabled(false), false);
  assert.equal(rain.group.visible, false);
  const time = rain.uniforms.uTime.value;
  assert.equal(rain.update(1), false);
  assert.equal(rain.uniforms.uTime.value, time);

  assert.equal(map.setRainEnabled(true), true);
  assert.equal(rain.group.visible, true);
  assert.equal(rain.update(1), true);
  assert.ok(rain.uniforms.uTime.value > time);

  // The overview still wins while it is up.
  map.setDebugVisible(true);
  map.setRainEnabled(true);
  assert.equal(rain.group.visible, false);
});

test('rain wetting darkens and sheens the forest soil', () => {
  const map = makeMap();
  // The soil is built once and then rain-wetted by `buildForestWeather`.
  assert.equal(map.forestSoilMaterial.roughness, MAP_CONFIG.forestRainWetRoughness);
  assert.ok(map.forestSoilMaterial.roughness < 0.98, 'the wet floor is a glossier surface');
});

test('the field can be built on its own for any sector-shaped hex', () => {
  const sector = { id: 'HEX_S', order: 5, center: { x: 120, z: -40 } };
  const terrain = () => 3.5;
  const rain = buildForestRain(sector, {
    hexRadius: 60,
    forestRainStreakCount: 240,
    forestRainRippleCount: 120,
  }, {
    heightAt: terrain,
    normalAt: (x, z, target) => target.set(0, 1, 0),
  });

  assert.equal(rain.streaks.count, 240);
  assert.equal(rain.ripples.count, 120);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  for (let index = 0; index < 240; index += 7) {
    rain.streaks.getMatrixAt(index, matrix);
    position.setFromMatrixPosition(matrix);
    assert.ok(isPointInsideHex(
      position.x - sector.center.x,
      position.z - sector.center.z,
      0, 0, 55,
    ));
    assert.equal(position.y, 3.5, 'the supplied height becomes the landing height');
  }
  // An empty field is legal too: no meshes, no crash.
  const empty = buildForestRain(sector, {
    hexRadius: 60,
    forestRainStreakCount: 0,
    forestRainRippleCount: 0,
  });
  assert.equal(empty.streaks, null);
  assert.equal(empty.ripples, null);
  assert.equal(empty.group.children.length, 0);
});
