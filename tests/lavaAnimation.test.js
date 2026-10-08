import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { VolcanicTerrain, DEFAULT_VOLCANIC_LAYOUT } from '../src/world/VolcanicTerrain.js';
import { buildLavaPool, createLavaMaterial } from '../src/world/LavaPool.js';
import { buildLavaFlow, buildLavaSecondaryFlow } from '../src/world/LavaFlow.js';
import {
  LAVA_ANIMATION_DEFAULTS,
  LAVA_CLOCK,
  advanceLavaClock,
  lavaAnimationDefines,
  lavaMoltenMask,
  resolveLavaAnimation,
} from '../src/world/LavaAnimation.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const RADIUS = MAP_CONFIG.hexRadius;
const CRATER = DEFAULT_VOLCANIC_LAYOUT.crater;

/** The portal centres of HEX_SE, in sector-local coordinates. */
function hexSeGateAprons() {
  const data = buildHexMapData(RADIUS);
  const sector = data.byId.get('HEX_SE');
  return data.sharedEdges
    .filter((gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE')
    .map((gate) => ({ x: gate.center.x - sector.center.x, z: gate.center.z - sector.center.z }));
}

// The full HEX_SE terrain, pool and both channels included. Baked once.
let sharedTerrain = null;
function terrain() {
  if (!sharedTerrain) {
    sharedTerrain = new VolcanicTerrain({
      radius: RADIUS,
      config: MAP_CONFIG,
      sectorId: 'HEX_SE',
      gateAprons: hexSeGateAprons(),
    });
  }
  return sharedTerrain;
}

// One animated world and one with the molten surfaces held static.
let sharedMap = null;
function map() {
  if (!sharedMap) sharedMap = new HexMap(new THREE.Scene(), MAP_CONFIG);
  return sharedMap;
}
const STATIC_CONFIG = { ...MAP_CONFIG, lavaAnimationEnabled: false };
let staticMap = null;
function staticWorld() {
  if (!staticMap) staticMap = new HexMap(new THREE.Scene(), STATIC_CONFIG);
  return staticMap;
}

/* ---- The clock --------------------------------------------------------- */

test('the lava clock integrates frame time and ignores impossible steps', () => {
  const t0 = LAVA_CLOCK.uTime.value;
  advanceLavaClock(0.25);
  assert.ok(Math.abs(LAVA_CLOCK.uTime.value - (t0 + 0.25)) < 1e-12, 'the clock advances by the step');
  advanceLavaClock(-1);
  advanceLavaClock(0);
  advanceLavaClock(Number.NaN);
  advanceLavaClock(Number.POSITIVE_INFINITY);
  assert.ok(Math.abs(LAVA_CLOCK.uTime.value - (t0 + 0.25)) < 1e-12, 'a backwards, empty or non-finite step is ignored');
});

test('the molten motion is frame-rate independent: the same time gives the same clock', () => {
  const start = LAVA_CLOCK.uTime.value;
  for (let i = 0; i < 60; i += 1) advanceLavaClock(1 / 30);
  const at30 = LAVA_CLOCK.uTime.value - start;
  LAVA_CLOCK.uTime.value = start;
  for (let i = 0; i < 120; i += 1) advanceLavaClock(1 / 60);
  const at60 = LAVA_CLOCK.uTime.value - start;
  LAVA_CLOCK.uTime.value = start;
  for (let i = 0; i < 288; i += 1) advanceLavaClock(1 / 144);
  const at144 = LAVA_CLOCK.uTime.value - start;
  assert.ok(Math.abs(at30 - 2) < 1e-9, `30 fps covers ${at30} s`);
  assert.ok(Math.abs(at60 - 2) < 1e-9, `60 fps covers ${at60} s`);
  assert.ok(Math.abs(at144 - 2) < 1e-9, `144 fps covers ${at144} s`);
  LAVA_CLOCK.uTime.value = start;
});

/* ---- Settings ---------------------------------------------------------- */

test('the animation is on by default and can be switched off without a trace', () => {
  const on = resolveLavaAnimation(MAP_CONFIG);
  assert.ok(on, 'the molten rock animates by default');
  assert.equal(on.flowSpeed, MAP_CONFIG.lavaAnimation.flowSpeed);
  assert.equal(on.maskLow, LAVA_ANIMATION_DEFAULTS.maskLow, 'the look keeps its defaults');
  assert.equal(resolveLavaAnimation({ ...MAP_CONFIG, lavaAnimationEnabled: false }), null);
  assert.equal(resolveLavaAnimation({ ...MAP_CONFIG, lavaAnimation: false }), null);
  assert.equal(resolveLavaAnimation({ ...MAP_CONFIG, lavaAnimation: null }), null);
});

test('bad animation settings fall back to the defaults instead of breaking the shader', () => {
  const broken = resolveLavaAnimation({
    lavaAnimation: { flowSpeed: Number.NaN, shear: 9, ember: [1, 2], glow: [0, Number.NaN, 1], maskLow: 0.5, maskHigh: 0.2 },
  });
  assert.equal(broken.flowSpeed, LAVA_ANIMATION_DEFAULTS.flowSpeed);
  assert.equal(broken.shear, 1, 'shear is clamped to the bank value');
  assert.deepEqual([...broken.ember], [...LAVA_ANIMATION_DEFAULTS.ember]);
  assert.deepEqual([...broken.glow], [...LAVA_ANIMATION_DEFAULTS.glow]);
  assert.ok(broken.maskHigh > broken.maskLow, 'the mask ramp always has a positive width');
});

/* ---- The mask: crust never moves --------------------------------------- */

test('the molten mask is zero on cold crust and one on molten rock, with a soft edge', () => {
  const settings = LAVA_ANIMATION_DEFAULTS;
  assert.equal(lavaMoltenMask(0.02), 0, 'cold crust is still');
  assert.equal(lavaMoltenMask(settings.maskLow), 0);
  assert.equal(lavaMoltenMask(settings.maskHigh), 1);
  assert.equal(lavaMoltenMask(0.41), 1, 'the molten rock of both channels is fully animated');
  const mid = lavaMoltenMask((settings.maskLow + settings.maskHigh) / 2);
  assert.ok(mid > 0.4 && mid < 0.6, 'the transition is a smooth ramp, not a step');
});

test('every point of the lava carries its heat, and only its molten rock is animated', () => {
  const built = buildLavaPool(terrain(), terrain().lavaPool, MAP_CONFIG);
  const colors = built.geometry.getAttribute('color');
  let crust = 0;
  let molten = 0;
  for (let v = 0; v < colors.count; v += 1) {
    const mask = lavaMoltenMask(colors.getY(v));
    if (colors.getY(v) <= LAVA_ANIMATION_DEFAULTS.maskLow) {
      crust += 1;
      assert.equal(mask, 0, `crust vertex ${v} would move`);
    }
    if (mask > 0.99) molten += 1;
  }
  assert.ok(crust > 0, 'the pool carries cold crust that must stay still');
  assert.ok(molten > colors.count * 0.2, `only ${molten} of ${colors.count} vertices are molten`);
});

/* ---- The shader patch and the shared material -------------------------- */

test('the animated material patches both stages with one shared clock and a unique program key', () => {
  const animated = createLavaMaterial(MAP_CONFIG);
  assert.equal(animated.userData.lava.animates, true);
  assert.equal(animated.userData.lava.clock, LAVA_CLOCK, 'every lava material reads the same clock');
  assert.equal(createLavaMaterial(MAP_CONFIG), animated, 'the same look hands back the same material');

  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  animated.onBeforeCompile(shader, null);
  assert.equal(shader.uniforms.uLavaTime, LAVA_CLOCK.uTime, 'the shader reads the shared uniform by reference');
  assert.match(shader.vertexShader, /attribute vec4 aLavaFlow;/);
  assert.match(shader.fragmentShader, /#define USE_ANIMATED_LAVA/);
  assert.match(shader.fragmentShader, /uniform float uLavaTime;/);
  assert.match(shader.fragmentShader, /#include <emissivemap_fragment>\s*\n#ifdef USE_ANIMATED_LAVA/,
    'the tint is applied after the emissive map, so the crust texture is kept');
  assert.match(shader.fragmentShader, /#define LAVA_FLOW_SPEED 0\.32/);
  assert.equal(animated.userData.lava.patches.missing.length, 0, 'no anchor was missed');
  assert.equal(animated.userData.lava.patches.landed, 4, 'four insertions landed');
  assert.match(animated.customProgramCacheKey(), /^animated-lava:/);

  const static_ = createLavaMaterial(STATIC_CONFIG);
  assert.notEqual(static_, animated, 'the static look is a different material');
  assert.equal(static_.userData.lava.animates, false);
  assert.equal(Object.hasOwn(static_, 'customProgramCacheKey'), false, 'a static material keeps the stock program key');
  const plain = { fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} };
  static_.onBeforeCompile(plain, null);
  assert.equal(plain.uniforms.uLavaTime, undefined, 'a static material never reads the clock');
  assert.doesNotMatch(plain.fragmentShader, /USE_ANIMATED_LAVA/);
});

test('the defines carry every tunable of the look into the compiled shader', () => {
  const defines = lavaAnimationDefines(resolveLavaAnimation(MAP_CONFIG));
  for (const name of ['LAVA_FLOW_SPEED', 'LAVA_SHEAR', 'LAVA_FREQ', 'LAVA_CROSS_SCALE', 'LAVA_SWIRL',
    'LAVA_WARP', 'LAVA_CHURN', 'LAVA_MASK_LOW', 'LAVA_MASK_HIGH', 'LAVA_EMBER', 'LAVA_GLOW', 'LAVA_CORE', 'LAVA_CORE_COLOR']) {
    assert.match(defines, new RegExp(`#define ${name} `), `${name} is missing`);
  }
  // A float literal, never a bare integer, or GLSL rejects the shader.
  assert.match(defines, /#define LAVA_CROSS_SCALE 3\.0/);
  assert.match(defines, /#define LAVA_EMBER vec3\(0\.8, 0\.42, 0\.2\)/);
});

/* ---- The geometry the animation reads ---------------------------------- */

test('every molten surface carries its own flow coordinates, and the pool is kind 0', () => {
  const world = map();
  const pool = world.volcanicLava;
  const flows = [world.lavaFlow, world.lavaSecondaryFlow];
  for (const feature of [pool, ...flows]) {
    const coords = feature.geometry.getAttribute('aLavaFlow');
    const positions = feature.geometry.getAttribute('position');
    assert.equal(coords.count, positions.count, `${feature.mesh.name} has one flow coordinate per vertex`);
    assert.equal(coords.itemSize, 4);
    assert.equal(feature.material, pool.material, `${feature.mesh.name} shares the one animated material`);
  }

  const coords = pool.geometry.getAttribute('aLavaFlow');
  const positions = pool.geometry.getAttribute('position');
  for (let v = 0; v < coords.count; v += 1) {
    assert.equal(coords.getZ(v), 0, 'the pool is kind 0');
    assert.ok(Math.abs(coords.getX(v) - (positions.getX(v) - terrain().lavaPool.x)) < 1e-4,
      'the pool coordinates are offsets from its vent');
    assert.ok(Math.abs(coords.getY(v) - (positions.getZ(v) - terrain().lavaPool.z)) < 1e-4);
  }

  for (const feature of flows) {
    const coords = feature.geometry.getAttribute('aLavaFlow');
    let maxAlong = 0;
    for (let v = 0; v < coords.count; v += 1) {
      assert.equal(coords.getZ(v), 1, 'a channel is kind 1');
      const across = coords.getW(v);
      assert.ok(across >= -1 - 1e-6 && across <= 1 + 1e-6, `cross fraction ${across} is in the bed`);
      assert.ok(coords.getX(v) >= -1e-6, 'the flow is measured downstream from its source');
      maxAlong = Math.max(maxAlong, coords.getX(v));
    }
    assert.ok(maxAlong > 10, `the channel runs ${maxAlong.toFixed(1)} units along its spine`);
  }
});

/* ---- Nothing about the geometry, colour or boundary changes ------------ */

test('the animation never changes a position, colour, UV or index of any lava surface', () => {
  const t = terrain();
  const on = buildLavaPool(t, t.lavaPool, MAP_CONFIG);
  const off = buildLavaPool(t, t.lavaPool, STATIC_CONFIG);
  const sameArrays = (a, b, label) => {
    assert.equal(a.count, b.count, `${label}: vertex count`);
    for (let i = 0; i < a.array.length; i += 1) {
      if (a.array[i] !== b.array[i]) assert.fail(`${label}: component ${i} changed`);
    }
  };
  for (const name of ['position', 'color', 'uv', 'normal']) {
    sameArrays(on.geometry.getAttribute(name), off.geometry.getAttribute(name), `pool ${name}`);
  }
  assert.deepEqual([...on.geometry.index.array], [...off.geometry.index.array], 'pool faces');

  const main = buildLavaFlow(t, t.lavaFlow, MAP_CONFIG);
  const mainOff = buildLavaFlow(t, t.lavaFlow, STATIC_CONFIG);
  for (const name of ['position', 'color', 'uv', 'normal']) {
    sameArrays(main.geometry.getAttribute(name), mainOff.geometry.getAttribute(name), `main flow ${name}`);
  }
  assert.deepEqual([...main.geometry.index.array], [...mainOff.geometry.index.array], 'main flow faces');

  const branch = buildLavaSecondaryFlow(t, t.lavaSecondaryFlow, MAP_CONFIG);
  const branchOff = buildLavaSecondaryFlow(t, t.lavaSecondaryFlow, STATIC_CONFIG);
  for (const name of ['position', 'color', 'uv', 'normal']) {
    sameArrays(branch.geometry.getAttribute(name), branchOff.geometry.getAttribute(name), `branch ${name}`);
  }
  assert.deepEqual([...branch.geometry.index.array], [...branchOff.geometry.index.array], 'branch faces');
});

test('the animated world has the same lava, floor and collision structure as the static one', () => {
  const world = map();
  const off = staticWorld();
  const lavaMeshes = (w) => {
    const found = [];
    w.group.traverse((object) => {
      if (object.isMesh && object.userData.surface === 'molten-lava') found.push(object);
    });
    return found;
  };
  assert.equal(lavaMeshes(world).length, 3, 'one pool, one main flow, one branch');
  assert.equal(lavaMeshes(off).length, 3);
  for (const [mesh, twin] of lavaMeshes(world).map((m, i) => [m, lavaMeshes(off)[i]])) {
    assert.equal(mesh.name, twin.name);
    assert.deepEqual(mesh.geometry.getAttribute('position').array, twin.geometry.getAttribute('position').array,
      `${mesh.name} moved`);
    assert.equal(mesh.userData.surface, 'molten-lava');
  }
  const boxes = (w) => w.collisionBoxes.map(({ door, ...box }) => box);
  assert.deepEqual(boxes(world), boxes(off), 'no new obstacles');
  assert.deepEqual(world.volcanicTerrain.geometry.userData.heightRange,
    off.volcanicTerrain.geometry.userData.heightRange);
  assert.equal(world.volcanicLava.material.userData.lava.animates, true);
  assert.equal(off.volcanicLava.material.userData.lava.animates, false);
});

/* ---- The clock is the only thing the world does each frame ------------ */

test('a world update ticks the lava clock by exactly the frame time, and makes no new materials', () => {
  const world = map();
  const before = new Set(lavaMeshesOf(world).map((m) => m.material));
  const cached = createLavaMaterial(MAP_CONFIG);
  const sector = world.getSector('HEX_SE');
  const player = new THREE.Vector3(sector.center.x, 0, sector.center.z);
  const t0 = LAVA_CLOCK.uTime.value;
  for (let i = 0; i < 90; i += 1) world.update(1 / 90, player);
  assert.ok(Math.abs(LAVA_CLOCK.uTime.value - (t0 + 1)) < 1e-9, 'one second of frames is one second of lava');
  const after = new Set(lavaMeshesOf(world).map((m) => m.material));
  assert.deepEqual([...after], [...before], 'the lava keeps the same materials');
  assert.equal(createLavaMaterial(MAP_CONFIG), cached, 'no material was created while the world ran');
});

function lavaMeshesOf(world) {
  const found = [];
  world.group.traverse((object) => {
    if (object.isMesh && object.userData.surface === 'molten-lava') found.push(object);
  });
  return found;
}
