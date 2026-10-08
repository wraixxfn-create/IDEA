import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import {
  VOLCANIC_ATMOSPHERE_DEFAULTS,
  buildVolcanicAtmosphere,
  planVolcanicAtmosphere,
  resolveVolcanicAtmosphereSettings,
} from '../src/world/VolcanicAtmosphere.js';
import { isPointInsideHex } from '../src/world/hexGrid.js';
import { lavaFlowSampleAt } from '../src/world/LavaFlow.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const world = new HexMap(new THREE.Scene(), MAP_CONFIG);
const terrain = world.volcanicTerrain;
const atmosphere = world.volcanicAtmosphere;
const plan = planVolcanicAtmosphere(terrain, MAP_CONFIG);
const pool = terrain.lavaPool;
const RADIUS = MAP_CONFIG.hexRadius;

test('HEX_SE gains one atmosphere group: haze, ash, heat and two small lights', () => {
  assert.ok(atmosphere, 'the volcanic sector has its atmosphere');
  assert.equal(world.volcanicAtmosphere, atmosphere);
  assert.equal(atmosphere.group.name, 'VolcanicAtmosphere_HEX_SE');
  assert.equal(atmosphere.group.parent, world.group);
  assert.equal(atmosphere.group.userData.sectorId, 'HEX_SE');
  assert.equal(atmosphere.group.userData.featureType, 'volcanic-atmosphere');
  assert.equal(atmosphere.group.userData.animates, true);
  assert.equal(atmosphere.group.userData.collidable, false);

  const sector = world.getSector('HEX_SE');
  assert.equal(atmosphere.group.position.x, sector.center.x);
  assert.equal(atmosphere.group.position.z, sector.center.z);
  assert.equal(atmosphere.group.position.y, MAP_CONFIG.floorHeight);

  const meshes = atmosphere.group.children.filter((child) => child.isMesh);
  const lights = atmosphere.group.children.filter((child) => child.isLight);
  assert.equal(meshes.length, 4, 'two haze discs, one ash fall, one heat shimmer');
  assert.equal(lights.length, 2, 'one glow over the pool, one over the channel');
  assert.deepEqual(
    meshes.map((mesh) => mesh.name),
    [
      'VolcanicHazeLayer_0_HEX_SE',
      'VolcanicHazeLayer_1_HEX_SE',
      'VolcanicAshFall_HEX_SE',
      'VolcanicHeatShimmer_HEX_SE',
    ],
  );
  for (const mesh of meshes) {
    assert.equal(mesh.material.transparent, true);
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.userData.collidable, false);
  }
  assert.equal(atmosphere.group.userData.particles, plan.particleCount);
  assert.equal(atmosphere.group.userData.lights, 2);
});

test('the pass is subtle: thin haze, grit-sized ash, faint heat, small glow', () => {
  const thickness = atmosphere.hazeMeshes.reduce((sum, mesh) => sum + mesh.userData.opacity, 0);
  assert.ok(thickness < 0.15, `the haze is thin (${thickness.toFixed(3)} over two discs)`);
  for (const mesh of atmosphere.hazeMeshes) {
    assert.ok(mesh.userData.opacity < 0.07, 'no haze disc hides the ground');
  }

  assert.ok(plan.ash.count <= 600, 'a few hundred grains, never a snowfall');
  const ashSizes = Array.from({ length: plan.ash.count }, (_, i) => plan.ash.params[i * 4 + 2]);
  assert.ok(Math.max(...ashSizes) <= 0.3, 'ash is grit-sized');
  assert.ok(atmosphere.materials.ash.uniforms.uOpacity.value <= 0.35);

  assert.ok(plan.heat.count <= 130, 'the shimmer budget stays small');
  const heatSizes = Array.from({ length: plan.heat.count }, (_, i) => plan.heat.params[i * 4 + 3]);
  assert.ok(Math.max(...heatSizes) <= 3, 'heat wisps stay small');
  const heatOpacity = Array.from({ length: plan.heat.count }, (_, i) => plan.heat.misc[i * 4 + 1]);
  assert.ok(Math.max(...heatOpacity) < 0.07, 'heat stays thinner than the steam');

  for (const light of atmosphere.lights) {
    assert.equal(light.isPointLight, true);
    assert.equal(light.castShadow, false);
    assert.ok(light.intensity < 1, 'the glow warms, it does not lamp');
    assert.ok(light.distance < 100, 'the glow dies out long before any shared edge');
  }
});

test('ash hangs inside the sector on its own ground, heat only on the lava', () => {
  for (let i = 0; i < plan.ash.count; i += 1) {
    const x = plan.ash.origin[i * 3];
    const z = plan.ash.origin[i * 3 + 2];
    assert.ok(isPointInsideHex(x, z, 0, 0, RADIUS - 10 + 1e-3), 'ash stays inside HEX_SE');
  }
  // Stored in float32, so the ground agrees to the last thousandth, not the
  // last bit — a micrometre over a whole sector.
  for (let i = 0; i < plan.ash.count; i += 1) {
    const x = plan.ash.origin[i * 3];
    const ground = plan.ash.origin[i * 3 + 1];
    const z = plan.ash.origin[i * 3 + 2];
    assert.ok(Math.abs(terrain.heightAt(x, z) - ground) < 1e-3, 'ash falls onto its own ground');
  }

  for (let i = 0; i < plan.heat.count; i += 1) {
    const x = plan.heat.origin[i * 3];
    const z = plan.heat.origin[i * 3 + 2];
    const onPool = Math.hypot(x - pool.x, z - pool.z) < 14;
    const main = lavaFlowSampleAt(x, z, terrain.lavaFlow);
    const onMain = main && main.distance <= main.halfWidth * 0.6 + 0.5;
    const branch = lavaFlowSampleAt(x, z, terrain.lavaSecondaryFlow);
    const onBranch = branch && branch.distance <= branch.halfWidth * 0.6 + 0.5;
    assert.ok(onPool || onMain || onBranch, `heat wisp ${i} rises off the lava`);
  }

  for (const glow of plan.glow) {
    assert.ok(isPointInsideHex(glow.x, glow.z, 0, 0, RADIUS - 8), 'the glow sits inside HEX_SE');
    for (const gate of terrain.gateAprons) {
      const distance = Math.hypot(glow.x - gate.x, glow.z - gate.z);
      assert.ok(distance > glow.distance, 'the glow never reaches a portal');
    }
  }
});

test('the volcanic sky dims slightly and stays blue like every other cupola', () => {
  const signatures = new Set();
  for (const sky of world.skies) {
    const { zenith, horizon } = sky.palette;
    assert.ok(zenith.b > zenith.r, `${sky.sector.id} zenith stays blue`);
    assert.ok(horizon.b > horizon.r, `${sky.sector.id} horizon stays blue`);
    signatures.add(zenith.getHexString());
  }
  assert.equal(signatures.size, world.sectors.length, 'every sector keeps its own sky');

  const volcanic = world.skies.find((sky) => sky.sector.id === 'HEX_SE');
  const open = world.skies.find((sky) => sky.sector.id === 'HEX_N');
  const forest = world.skies.find((sky) => sky.sector.id === 'HEX_S');
  assert.equal(volcanic.palette.isVolcanic, true);
  assert.ok(volcanic.palette.sunGlow < open.palette.sunGlow, 'the volcanic sun is dimmed a touch');
  assert.ok(volcanic.palette.sunGlow > forest.palette.sunGlow, 'but the wood stays the darkest sky');
});

/** Everything the volcanic ground and its lava hold, as plain numbers. */
function volcanicSnapshot(map) {
  const attributes = (geometry) => Object.fromEntries(
    Object.entries(geometry.attributes).map(([name, attribute]) => [name, Array.from(attribute.array)]),
  );
  const instanced = (group) => group.children.map((mesh) => ({
    name: mesh.name,
    matrices: mesh.instanceMatrix ? Array.from(mesh.instanceMatrix.array) : null,
    position: Array.from(mesh.position.toArray()),
  }));
  const lavaMeshes = [];
  if (map.volcanicLava?.group) {
    map.volcanicLava.group.traverse((node) => {
      if (node.geometry) lavaMeshes.push({ name: node.name, attributes: attributes(node.geometry) });
    });
  }
  const samples = [];
  for (let x = -200; x <= 200; x += 25) {
    for (let z = -200; z <= 200; z += 25) {
      samples.push(map.getFloorHeightAt(x, z));
    }
  }
  return {
    terrain: attributes(map.volcanicTerrain.geometry),
    rocks: instanced(map.volcanicRocks),
    debris: instanced(map.volcanicDebris),
    lava: lavaMeshes,
    flows: [map.lavaFlow, map.lavaSecondaryFlow].map((flow) => (flow?.mesh
      ? attributes(flow.mesh.geometry)
      : null)),
    floor: samples,
  };
}

test('with the atmosphere on, the terrain, rocks, debris and lava are exactly what they were', () => {
  const off = new HexMap(new THREE.Scene(), { ...MAP_CONFIG, volcanicAtmosphereEnabled: false });
  assert.equal(off.volcanicAtmosphere, null, 'the atmosphere is switched off');
  assert.equal(world.group.children.length, off.group.children.length + 1, 'the atmosphere is one object in the world');

  const withAtmosphere = volcanicSnapshot(world);
  const without = volcanicSnapshot(off);
  assert.deepEqual(withAtmosphere.terrain, without.terrain, 'the terrain is untouched');
  assert.deepEqual(withAtmosphere.rocks, without.rocks, 'the medium rocks are untouched');
  assert.deepEqual(withAtmosphere.debris, without.debris, 'the debris is untouched');
  assert.deepEqual(withAtmosphere.lava, without.lava, 'the lava is untouched');
  assert.deepEqual(withAtmosphere.flows, without.flows, 'the flows are untouched');
  assert.deepEqual(withAtmosphere.floor, without.floor, 'the ground heights are untouched');

  for (const [id, floor] of world.sectorMeshes) {
    if (id === 'HEX_SE') continue;
    assert.deepEqual(
      Array.from(floor.geometry.attributes.position.array),
      Array.from(off.sectorMeshes.get(id).geometry.attributes.position.array),
      `${id} geometry changed`,
    );
  }
});

test('the atmosphere adds no collider, sprite, point cloud or damage to the world', () => {
  atmosphere.group.traverse((node) => {
    if (node === atmosphere.group) return;
    assert.equal(node.isSprite, undefined, `${node.name} is not a sprite`);
    assert.equal(node.isPoints, undefined, `${node.name} is not a point cloud`);
    assert.notEqual(node.userData.collidable, true, `${node.name} is not a collider`);
    assert.equal(node.userData.damage, undefined, `${node.name} does nothing to the player`);
    if (node.isMesh) assert.equal(node.userData.surface, undefined, `${node.name} is not a lava surface`);
  });
});

test('the clock, two discs and two breathing lights are all the pass does each frame', () => {
  const ashBefore = atmosphere.geometries.ash.getAttribute('aOrigin').array.slice();
  const heatBefore = atmosphere.geometries.heat.getAttribute('aOrigin').array.slice();
  const hazeBefore = atmosphere.hazeMeshes[0].rotation.y;
  const baseIntensities = atmosphere.lights.map((light) => light.userData.baseIntensity);
  const t0 = atmosphere.uniforms.uTime.value;

  world.update(0.5, new THREE.Vector3(0, 0, 0));
  assert.ok(Math.abs(atmosphere.uniforms.uTime.value - (t0 + 0.5)) < 1e-9, 'the clock advances with the frame');
  assert.notEqual(atmosphere.hazeMeshes[0].rotation.y, hazeBefore, 'the haze drifts');
  atmosphere.lights.forEach((light, index) => {
    const drift = Math.abs(light.intensity - baseIntensities[index]) / baseIntensities[index];
    assert.ok(drift < 0.08, 'the glow breathes, it does not flicker');
  });

  atmosphere.update(-3);
  assert.ok(Math.abs(atmosphere.uniforms.uTime.value - (t0 + 0.5)) < 1e-9, 'a negative step never runs the clock backwards');

  assert.deepEqual(atmosphere.geometries.ash.getAttribute('aOrigin').array, ashBefore,
    'no ash grain is re-written per frame');
  assert.deepEqual(atmosphere.geometries.heat.getAttribute('aOrigin').array, heatBefore,
    'no heat wisp is re-written per frame');
});

test('the same terrain plans the same atmosphere, down to every grain', () => {
  const repeat = planVolcanicAtmosphere(terrain, MAP_CONFIG);
  assert.equal(repeat.particleCount, plan.particleCount);
  assert.deepEqual(repeat.ash.origin, plan.ash.origin);
  assert.deepEqual(repeat.ash.params, plan.ash.params);
  assert.deepEqual(repeat.heat.origin, plan.heat.origin);
  assert.deepEqual(repeat.heat.misc, plan.heat.misc);
  const again = buildVolcanicAtmosphere(terrain, MAP_CONFIG, { sunDirection: world.sunDirection });
  assert.deepEqual(again.geometries.ash.getAttribute('aParams').array,
    atmosphere.geometries.ash.getAttribute('aParams').array);
});

test('the overview steps the atmosphere aside, like the smoke and the mist', () => {
  world.setDebugVisible(true);
  assert.equal(atmosphere.group.visible, false, 'the overview hides the atmosphere');
  world.setDebugVisible(false);
  assert.equal(atmosphere.group.visible, true, 'the explorer view shows it again');
});

test('the switches remove the pass without a trace, and nothing else', () => {
  assert.equal(resolveVolcanicAtmosphereSettings({ volcanicAtmosphereEnabled: false }), null);
  assert.equal(resolveVolcanicAtmosphereSettings({ volcanicAtmosphere: false }), null);
  assert.equal(resolveVolcanicAtmosphereSettings({ volcanicAtmosphere: null }), null);
  assert.equal(buildVolcanicAtmosphere(terrain, { ...MAP_CONFIG, volcanicAtmosphere: false }), null);

  const merged = resolveVolcanicAtmosphereSettings({ volcanicAtmosphere: { ash: { opacity: 0.1 } } });
  assert.equal(merged.ash.opacity, 0.1, 'an override is merged into the look');
  assert.equal(merged.ash.count, VOLCANIC_ATMOSPHERE_DEFAULTS.ash.count, 'untouched keys keep their defaults');
});

test('only HEX_SE is given an atmosphere', () => {
  assert.equal(planVolcanicAtmosphere(null, MAP_CONFIG), null);
  assert.equal(planVolcanicAtmosphere({ sectorId: 'HEX_S' }, MAP_CONFIG), null);
  assert.equal(buildVolcanicAtmosphere(null, MAP_CONFIG), null);
});
