import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import {
  VOLCANIC_SMOKE_DEFAULTS,
  buildVolcanicSmoke,
  createPlumeNoiseTexture,
  planVolcanicSmoke,
  resolveVolcanicSmokeSettings,
} from '../src/world/VolcanicSmoke.js';
import { measureLavaPoolShoreline } from '../src/world/LavaPool.js';
import { lavaFlowSampleAt } from '../src/world/LavaFlow.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const world = new HexMap(new THREE.Scene(), MAP_CONFIG);
const terrain = world.volcanicTerrain;
const smoke = world.volcanicSmoke;
const plan = planVolcanicSmoke(terrain, MAP_CONFIG);
const crater = terrain.layout.crater;
const pool = terrain.lavaPool;
const shoreline = measureLavaPoolShoreline(terrain, pool);
const RADIUS = MAP_CONFIG.hexRadius;

const byId = new Map(plan.sources.map((source) => [source.id, source]));
const smokeSources = plan.sources.filter((source) => source.kind === 'smoke');
const steamSources = plan.sources.filter((source) => source.kind === 'steam');

/** The puffs one resolved source was planted with, as sector-local points. */
function originsOf(source) {
  const { origin } = plan.buffers[source.kind];
  const points = [];
  for (let i = source.offset; i < source.offset + source.puffs; i += 1) {
    points.push({ x: origin[i * 3], y: origin[i * 3 + 1], z: origin[i * 3 + 2] });
  }
  return points;
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** The anchor a default source names, read from the defaults themselves. */
function anchorOf(id) {
  return VOLCANIC_SMOKE_DEFAULTS.sources.find((source) => source.id === id).anchor;
}

/** The measured shoreline's radius on a bearing, interpolated the same way. */
function shoreRadiusAt(bearing) {
  const count = shoreline.radii.length;
  const at = ((bearing % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * count;
  const index = Math.floor(at) % count;
  const t = at - Math.floor(at);
  return shoreline.radii[index] * (1 - t) + shoreline.radii[(index + 1) % count] * t;
}

/** Distance from a point to a polyline (points: {x, z}). */
function distanceToPolyline(point, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0
      ? THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq, 0, 1)
      : 0;
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t)));
  }
  return best;
}

/** The rim of the crater on a bearing, measured the same way the plan does. */
function rimPointAt(bearing) {
  const dx = Math.cos(bearing);
  const dz = Math.sin(bearing);
  let radius = crater.rimRadius;
  for (let pass = 0; pass < 3; pass += 1) {
    radius = terrain.craterRimRadiusAt(dx * radius, dz * radius, crater);
  }
  return { x: crater.x + dx * radius, z: crater.z + dz * radius };
}

function luminance(color) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

test('HEX_SE gains one smoke-and-steam group of two instanced billboard meshes', () => {
  assert.ok(smoke, 'the volcanic sector has its smoke and steam');
  assert.equal(world.volcanicSmoke, smoke);
  assert.equal(smoke.group.name, 'VolcanicSmoke_HEX_SE');
  assert.equal(smoke.group.parent, world.group);
  assert.equal(smoke.group.userData.sectorId, 'HEX_SE');
  assert.equal(smoke.group.userData.featureType, 'volcanic-smoke-and-steam');
  assert.equal(smoke.group.userData.animates, true);
  assert.equal(smoke.group.userData.collidable, false);
  assert.equal(smoke.group.userData.lights, 0);
  assert.equal(smoke.group.userData.particles, plan.puffCount);

  const sector = world.getSector('HEX_SE');
  assert.equal(smoke.group.position.x, sector.center.x);
  assert.equal(smoke.group.position.z, sector.center.z);
  assert.equal(smoke.group.position.y, MAP_CONFIG.floorHeight);

  const meshes = smoke.group.children;
  assert.equal(meshes.length, 2, 'one draw call for the smoke, one for the steam');
  assert.deepEqual(meshes.map((mesh) => mesh.name), ['VolcanicSmokePlumes_HEX_SE', 'VolcanicSteamWisps_HEX_SE']);
  for (const mesh of meshes) {
    assert.equal(mesh.isMesh, true);
    assert.equal(mesh.geometry.isInstancedBufferGeometry, true, 'each puff is an instance of one quad');
    assert.equal(mesh.material.isShaderMaterial, true);
    assert.equal(mesh.material.transparent, true);
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.frustumCulled, false, 'the shader places the puffs, so the bounds would lie');
    assert.equal(mesh.userData.collidable, false);
  }
  assert.equal(smoke.geometries.smoke.instanceCount, plan.smokePuffs);
  assert.equal(smoke.geometries.steam.instanceCount, plan.steamPuffs);
});

test('the plumes share one quad, one noise tile and one clock, with no per-puff objects', () => {
  const { smoke: smokeMaterial, steam: steamMaterial } = smoke.materials;
  assert.notEqual(smokeMaterial, steamMaterial, 'the two kinds look different');
  assert.equal(smokeMaterial.uniforms.uTime, smoke.uniforms.uTime, 'one clock drives every plume');
  assert.equal(steamMaterial.uniforms.uTime, smoke.uniforms.uTime);
  assert.equal(smokeMaterial.uniforms.uNoise.value, steamMaterial.uniforms.uNoise.value,
    'both kinds sample one noise tile');
  assert.equal(smokeMaterial.uniforms.uNoise.value, createPlumeNoiseTexture(),
    'the tile is built once and reused');

  const smokeQuad = smoke.geometries.smoke.getAttribute('position');
  assert.equal(smokeQuad, smoke.geometries.steam.getAttribute('position'), 'one quad for both kinds');
  assert.equal(smoke.geometries.smoke.index, smoke.geometries.steam.index);
  assert.equal(smokeQuad.count, 4, 'a puff is a quad, not a mesh');

  for (const key of ['aOrigin', 'aSeed', 'aShape', 'aMotion', 'aTwist']) {
    assert.ok(smoke.geometries.smoke.getAttribute(key).isInstancedBufferAttribute, `${key} is per instance`);
  }
  assert.equal(smoke.uniforms.uNoise.value.wrapS, THREE.RepeatWrapping);
  assert.equal(smoke.uniforms.uNoise.value.wrapT, THREE.RepeatWrapping);
  assert.equal(smoke.uniforms.uNoise.value.image.width, VOLCANIC_SMOKE_DEFAULTS.noiseSize);
});

test('the noise tile is a varied, seamless field rather than a flat fill', () => {
  const { data, width, height } = createPlumeNoiseTexture().image;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < width * height; i += 1) {
    lo = Math.min(lo, data[i * 4]);
    hi = Math.max(hi, data[i * 4]);
  }
  assert.ok(hi - lo > 150, 'the billows cover most of the tone range');
  // A seamless tile wraps its last column back onto its first, and that wrap
  // pair is no harder a step than any other pair of neighbouring texels.
  let wrapStep = 0;
  let innerStep = 0;
  for (let y = 0; y < height; y += 1) {
    wrapStep += Math.abs(data[(y * width) * 4] - data[(y * width + width - 1) * 4]);
    for (let x = 0; x < width - 1; x += 1) {
      innerStep += Math.abs(data[(y * width + x) * 4] - data[(y * width + x + 1) * 4]);
    }
  }
  const wrapMean = wrapStep / height;
  const innerMean = innerStep / (height * (width - 1));
  assert.ok(wrapMean < 2 * innerMean + 4, 'the tile wraps without a visible seam');
});

test('the sources are few, and each one is cut from a feature the terrain carries', () => {
  assert.ok(smokeSources.length >= 4 && smokeSources.length <= 6, 'a handful of smoke sources');
  assert.ok(steamSources.length >= 3 && steamSources.length <= 5, 'a handful of steam sources');
  assert.ok(plan.puffCount <= 320, 'the whole layer stays inside its puff budget, two draw calls in all');
  assert.equal(plan.skipped.length, 0, 'every default source resolves on the baked terrain');
  assert.equal(plan.smokePuffs + plan.steamPuffs, plan.puffCount);
  assert.equal(smoke.group.userData.sources.length, plan.sources.length);

  // The main crater, its breach and three small vents carry the smoke.
  assert.equal(smokeSources.filter((s) => s.anchor === 'crater').length, 1);
  assert.equal(smokeSources.filter((s) => s.anchor === 'crater-breach').length, 1);
  const smokeVents = smokeSources.filter((s) => s.anchor === 'vent').map((s) => s.id);
  assert.equal(smokeVents.length, 3, 'three small vents smoke');
  assert.equal(new Set(smokeVents).size, 3, 'each small vent is its own source');
  assert.ok(!smokeVents.includes('vent-ash-dish'), 'the silted dish is left silent');
  assert.ok(!smokeVents.includes('vent-dyke-fissure'), 'the fissure wisps, it does not smoke');

  // The cracks and the hot margins carry the steam.
  const steamCracks = steamSources.filter((s) => s.anchor === 'crack').map((s) => s.id).sort();
  assert.deepEqual(steamCracks, ['steam-dyke-fissure', 'steam-south-fissure']);
  assert.equal(steamSources.filter((s) => s.anchor === 'flow').length, 1, 'the branch channel steams');
  assert.equal(steamSources.filter((s) => s.anchor === 'pool').length, 1, 'the pool margin steams');
});

test('every puff rises from the feature its source names', () => {
  const crater0 = byId.get('smoke-crater-vent');
  for (const point of originsOf(crater0)) {
    assert.ok(distance2d(point, crater) <= crater0.jitter + 1e-6, 'the crater plume rises from the crater');
    assert.ok(Math.abs(point.y - (pool.level + pool.lift)) < 0.01,
      'the crater plume rises from the lake surface, where it is seated');
  }

  const breach = byId.get('smoke-crater-breach');
  const breachPoint = rimPointAt(crater.notchBearing);
  for (const point of originsOf(breach)) {
    assert.ok(distance2d(point, breachPoint) <= breach.jitter + 1e-6, 'the breach plume rises from the breach');
  }

  for (const id of ['smoke-basin-throat', 'smoke-plain-opening', 'smoke-dyke-opening']) {
    const source = byId.get(id);
    const vent = terrain.vents.find((v) => v.id === anchorOf(id).id);
    assert.ok(vent, `${id} names a vent that exists`);
    for (const point of originsOf(source)) {
      assert.ok(distance2d(point, vent) <= source.jitter + 1e-6, `${id} rises from its own vent`);
    }
  }

  for (const id of ['steam-dyke-fissure', 'steam-south-fissure']) {
    const vent = terrain.vents.find((v) => v.id === anchorOf(id).id);
    assert.ok(vent?.spine?.points, `${id} follows a real crack`);
    for (const point of originsOf(byId.get(id))) {
      assert.ok(distanceToPolyline(point, vent.spine.points) <= byId.get(id).jitter + 1.5,
        `${id} steams along its crack`);
    }
  }

  const branch = terrain.lavaSecondaryFlow;
  for (const point of originsOf(byId.get('steam-branch'))) {
    const sample = lavaFlowSampleAt(point.x, point.z, branch);
    assert.ok(sample, 'the branch steam sits on the branch channel');
    assert.ok(sample.distance <= sample.halfWidth + 0.8, 'the branch steam stays within the channel');
  }

  const margin = anchorOf('steam-pool-margin');
  const marginPoint = {
    x: pool.x + Math.cos(margin.bearing) * shoreRadiusAt(margin.bearing) * margin.reach,
    z: pool.z + Math.sin(margin.bearing) * shoreRadiusAt(margin.bearing) * margin.reach,
  };
  const marginSource = byId.get('steam-pool-margin');
  for (const point of originsOf(marginSource)) {
    assert.ok(distance2d(point, marginPoint) <= marginSource.jitter + 1e-6, 'the pool steam hangs on the lava margin');
  }
});

test('no plume stands over the gate routes or at the portals', () => {
  const outer = MAP_CONFIG.volcanicGateApronOuter;
  for (const source of plan.sources) {
    for (const point of originsOf(source)) {
      for (const gate of terrain.gateAprons) {
        assert.ok(distance2d(point, gate) > outer, `${source.id} stays clear of the gate ${gate.x},${gate.z}`);
      }
    }
  }
});

test('the plumes cover only a sliver of the sector, so the ground stays readable', () => {
  let covered = 0;
  for (const source of plan.sources) {
    covered += Math.PI * source.reach * source.reach + 2 * source.reach * source.length;
  }
  const sectorArea = (3 * Math.sqrt(3) / 2) * RADIUS * RADIUS;
  const share = covered / sectorArea;
  assert.ok(share > 0, 'the effect covers some ground');
  assert.ok(share < 0.05, `the plumes take up ${(share * 100).toFixed(1)}% of the sector at most`);
});

test('the plumes vary in height, opacity, size and movement', () => {
  const heights = new Set(smokeSources.map((s) => s.height));
  assert.ok(heights.size >= 4, 'the smoke columns are not all the same height');
  const crater0 = byId.get('smoke-crater-vent');
  assert.ok(smokeSources.every((s) => s.height <= crater0.height), 'the crater column is the tallest');
  assert.equal(new Set(smokeSources.map((s) => s.size)).size, smokeSources.length, 'each source has its own size');

  const smokeOpacity = plan.buffers.smoke.motion.filter((_, i) => i % 4 === 3);
  assert.ok(Math.min(...smokeOpacity) < 0.6 * Math.max(...smokeOpacity), 'opacity varies from puff to puff');

  const smokeWobble = plan.buffers.smoke.motion.filter((_, i) => i % 4 === 2);
  assert.ok(Math.max(...smokeWobble) > 1.2 * Math.min(...smokeWobble), 'the meander varies');

  const rises = plan.buffers.smoke.shape.filter((_, i) => i % 4 === 1);
  assert.ok(rises.every((rise) => rise > 0), 'every smoke puff rises');
});

test('steam is paler, thinner, smaller and shorter-lived than smoke', () => {
  const smokeLook = VOLCANIC_SMOKE_DEFAULTS.smoke;
  const steamLook = VOLCANIC_SMOKE_DEFAULTS.steam;
  const smokeLight = new THREE.Color(smokeLook.light);
  const steamLight = new THREE.Color(steamLook.light);
  const smokeShadow = new THREE.Color(smokeLook.shadow);
  const steamShadow = new THREE.Color(steamLook.shadow);
  assert.ok(luminance(steamLight) > luminance(smokeLight), 'steam is the paler of the two');
  assert.ok(luminance(steamShadow) > luminance(smokeShadow), 'steam is paler in shadow too');
  assert.ok(steamLook.opacity < smokeLook.opacity, 'each steam puff is thinner than each smoke puff');

  const smokeOpacity = mean(plan.buffers.smoke.motion.filter((_, i) => i % 4 === 3));
  const steamOpacity = mean(plan.buffers.steam.motion.filter((_, i) => i % 4 === 3));
  assert.ok(steamOpacity < smokeOpacity, 'steam is the thinner of the two on average');

  const smokeRise = mean(plan.buffers.smoke.shape.filter((_, i) => i % 4 === 1));
  const steamRise = mean(plan.buffers.steam.shape.filter((_, i) => i % 4 === 1));
  assert.ok(steamRise < smokeRise / 2, 'steam rises a short way');

  const smokeLife = mean(plan.buffers.smoke.shape.filter((_, i) => i % 4 === 0));
  const steamLife = mean(plan.buffers.steam.shape.filter((_, i) => i % 4 === 0));
  assert.ok(steamLife < smokeLife / 2, 'steam is gone within seconds');

  const smokeSize = mean(plan.buffers.smoke.shape.filter((_, i) => i % 4 === 3));
  const steamSize = mean(plan.buffers.steam.shape.filter((_, i) => i % 4 === 3));
  assert.ok(steamSize < smokeSize / 2, 'steam wisps are small');
});

test('the same terrain plans the same plumes, down to every puff', () => {
  const repeat = planVolcanicSmoke(terrain, MAP_CONFIG);
  assert.equal(repeat.puffCount, plan.puffCount);
  for (const kind of ['smoke', 'steam']) {
    for (const key of ['origin', 'seeds', 'shape', 'motion', 'twist']) {
      assert.deepEqual(repeat.buffers[kind][key], plan.buffers[kind][key], `${kind} ${key} repeats`);
    }
  }
  const again = buildVolcanicSmoke(terrain, MAP_CONFIG, { sunDirection: world.sunDirection });
  assert.deepEqual(again.geometries.smoke.getAttribute('aOrigin').array,
    smoke.geometries.smoke.getAttribute('aOrigin').array);
  assert.deepEqual(again.geometries.steam.getAttribute('aSeed').array,
    smoke.geometries.steam.getAttribute('aSeed').array);
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

test('with the smoke on, the terrain, rocks, debris and lava are exactly what they were', () => {
  const off = new HexMap(new THREE.Scene(), { ...MAP_CONFIG, volcanicSmokeEnabled: false });
  assert.equal(off.volcanicSmoke, null, 'the smoke is switched off');
  assert.equal(world.group.children.length, off.group.children.length + 1, 'the smoke is one object in the world');

  const withSmoke = volcanicSnapshot(world);
  const without = volcanicSnapshot(off);
  assert.deepEqual(withSmoke.terrain, without.terrain, 'the terrain is untouched');
  assert.deepEqual(withSmoke.rocks, without.rocks, 'the medium rocks are untouched');
  assert.deepEqual(withSmoke.debris, without.debris, 'the debris is untouched');
  assert.deepEqual(withSmoke.lava, without.lava, 'the lava is untouched');
  assert.deepEqual(withSmoke.flows, without.flows, 'the flows are untouched');
  assert.deepEqual(withSmoke.floor, without.floor, 'the ground heights are untouched');
});

test('the smoke adds no collider, light, sprite, point cloud or damage to the world', () => {
  smoke.group.traverse((node) => {
    if (node === smoke.group) return;
    assert.equal(node.isLight, undefined, `${node.name} is not a light`);
    assert.equal(node.isSprite, undefined, `${node.name} is not a sprite`);
    assert.equal(node.isPoints, undefined, `${node.name} is not a point cloud`);
    assert.notEqual(node.userData.collidable, true, `${node.name} is not a collider`);
    assert.equal(node.userData.damage, undefined, `${node.name} does nothing to the player`);
  });
});

test('the clock is the only thing the plumes do each frame', () => {
  const originsBefore = smoke.geometries.smoke.getAttribute('aOrigin').array.slice();
  const shapesBefore = smoke.geometries.steam.getAttribute('aShape').array.slice();
  const groupMatrix = smoke.group.matrix.elements.slice();
  const t0 = smoke.uniforms.uTime.value;

  world.update(0.25, new THREE.Vector3(0, 0, 0));
  assert.ok(Math.abs(smoke.uniforms.uTime.value - (t0 + 0.25)) < 1e-9, 'the clock advances with the frame');

  smoke.update(-3);
  assert.ok(Math.abs(smoke.uniforms.uTime.value - (t0 + 0.25)) < 1e-9, 'a negative step never runs the clock backwards');

  assert.deepEqual(smoke.geometries.smoke.getAttribute('aOrigin').array, originsBefore,
    'no puff is re-written per frame');
  assert.deepEqual(smoke.geometries.steam.getAttribute('aShape').array, shapesBefore);
  assert.deepEqual(smoke.group.matrix.elements, groupMatrix, 'the group does not move');
});

test('the overview steps the plumes aside, like the mist and the rain', () => {
  world.setDebugVisible(true);
  assert.equal(smoke.group.visible, false, 'the overview hides the smoke and steam');
  world.setDebugVisible(false);
  assert.equal(smoke.group.visible, true, 'the explorer view shows them again');
});

test('the switches remove the effect without a trace, and nothing else', () => {
  assert.equal(resolveVolcanicSmokeSettings({ volcanicSmokeEnabled: false }), null);
  assert.equal(resolveVolcanicSmokeSettings({ volcanicSmoke: false }), null);
  assert.equal(resolveVolcanicSmokeSettings({ volcanicSmoke: null }), null);
  assert.equal(buildVolcanicSmoke(terrain, { ...MAP_CONFIG, volcanicSmoke: false }), null);

  const empty = buildVolcanicSmoke(terrain, { ...MAP_CONFIG, volcanicSmoke: { sources: [] } });
  assert.equal(empty, null, 'a list with no sources builds nothing');

  const merged = resolveVolcanicSmokeSettings({ volcanicSmoke: { steam: { opacity: 0.2 } } });
  assert.equal(merged.steam.opacity, 0.2, 'an override is merged into the look');
  assert.equal(merged.steam.life[0], VOLCANIC_SMOKE_DEFAULTS.steam.life[0], 'untouched keys keep their defaults');
  assert.equal(merged.sources.length, VOLCANIC_SMOKE_DEFAULTS.sources.length);
});

test('a source that names a feature the world does not have is skipped, not guessed', () => {
  const ghost = {
    id: 'ghost-vent',
    kind: 'smoke',
    anchor: { on: 'vent', id: 'vent-that-is-not-here' },
    puffs: 8,
    height: 10,
    size: 3,
    spread: 1,
    wobble: 0.4,
    jitter: 1,
    opacity: 1,
    warm: 0,
  };
  const skipping = planVolcanicSmoke(terrain, {
    ...MAP_CONFIG,
    volcanicSmoke: { sources: [ghost, ...VOLCANIC_SMOKE_DEFAULTS.sources] },
  });
  assert.deepEqual(skipping.skipped, ['ghost-vent']);
  assert.equal(skipping.puffCount, plan.puffCount, 'the rest of the effect is unchanged');
});

test('only HEX_SE is given smoke', () => {
  assert.equal(planVolcanicSmoke(null, MAP_CONFIG), null);
  assert.equal(planVolcanicSmoke({ sectorId: 'HEX_S' }, MAP_CONFIG), null);
});
