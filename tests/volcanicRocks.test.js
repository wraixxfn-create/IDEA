import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import {
  MEDIUM_ROCK_GEOMETRY_COUNT,
  MEDIUM_ROCK_VARIANTS,
  MEDIUM_ROCK_ZONES,
  VOLCANIC_ROCK_DEFAULTS,
  buildVolcanicRocks,
  createMediumRockGeometries,
  createMediumRockGeometry,
  lavaEdgeDistance,
  planVolcanicRockPlacements,
} from '../src/world/VolcanicRocks.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const world = new HexMap(new THREE.Scene(), MAP_CONFIG);
const terrain = world.volcanicTerrain;
const rocks = world.volcanicRocks;
const placements = rocks.userData.placements;
const RADIUS = MAP_CONFIG.hexRadius;
const routes = [];
for (const gate of terrain.gateAprons) {
  routes.push({ a: gate, b: { x: terrain.layout.crater.x, z: terrain.layout.crater.z } });
  routes.push({ a: gate, b: { x: 0, z: 0 } });
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0
    ? THREE.MathUtils.clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq, 0, 1)
    : 0;
  return Math.hypot(point.x - (start.x + dx * t), point.z - (start.z + dz * t));
}

/** The crater's rim radius on the bearing of a placement, as the plan reads it. */
function rimRadiusAt(point) {
  const crater = terrain.layout.crater;
  return terrain.craterRimRadiusAt(point.x - crater.x, point.z - crater.z, crater);
}

test('HEX_SE gains a limited medium rock layer drawn from shared geometry', () => {
  assert.ok(rocks, 'the volcanic sector has its medium rock layer');
  assert.equal(rocks.name, 'VolcanicMediumRocks_HEX_SE');
  assert.equal(rocks.userData.sectorId, 'HEX_SE');
  assert.equal(rocks.userData.featureType, 'medium-volcanic-rock-layer');
  assert.equal(rocks.userData.static, true);
  assert.equal(rocks.userData.collidable, false);
  assert.equal(rocks.userData.instanced, true);
  assert.equal(rocks.parent, world.group);
  // Sector-local placement, exactly like the terrain, the lava and the
  // formations: the group sits at the sector's own centre.
  const sector = world.getSector('HEX_SE');
  assert.equal(rocks.position.x, sector.center.x);
  assert.equal(rocks.position.z, sector.center.z);
  assert.equal(rocks.position.y, MAP_CONFIG.floorHeight);

  // Limited: a few hundred rocks, not a carpet, and never more shapes than the
  // collection was authored with.
  const count = rocks.userData.rockCount;
  assert.ok(count >= 120 && count <= 420, `unexpected rock count: ${count}`);
  assert.equal(count, placements.length);
  assert.equal(rocks.userData.variantCount, MEDIUM_ROCK_VARIANTS.length);
  assert.equal(rocks.userData.geometryCount, MEDIUM_ROCK_GEOMETRY_COUNT);

  // Instanced: every rock is drawn from one of twelve shared geometries, so the
  // layer costs one draw call per geometry and nothing more.
  assert.equal(rocks.children.length, MEDIUM_ROCK_GEOMETRY_COUNT);
  const geometries = new Set();
  let instances = 0;
  for (const mesh of rocks.children) {
    assert.equal(mesh.isInstancedMesh, true, 'every layer mesh is instanced');
    assert.equal(mesh.userData.featureType, 'medium-volcanic-rock-instances');
    assert.equal(mesh.userData.static, true);
    assert.equal(mesh.userData.collidable, false);
    assert.ok(mesh.count >= 10, `${mesh.name} holds a handful of rocks`);
    assert.equal(mesh.geometry.userData.surface, 'fractured-volcanic-basalt');
    assert.equal(mesh.geometry.userData.featureType, 'medium-volcanic-rock');
    assert.ok(mesh.geometry.getAttribute('position').count >= 45, 'a rock resolves its facets');
    assert.equal(
      mesh.geometry.getAttribute('color').count,
      mesh.geometry.getAttribute('position').count,
      'every facet carries its own basalt tone',
    );
    geometries.add(mesh.geometry);
    instances += mesh.count;
  }
  assert.equal(geometries.size, MEDIUM_ROCK_GEOMETRY_COUNT, 'the layer shares twelve geometries');
  assert.equal(instances, count, 'every rock is an instance of a shared geometry');

  // Static: no clock, no particles, no lights, no colliders anywhere in it.
  rocks.traverse((object) => {
    assert.equal(object.isPoints ?? false, false, `${object.name} draws no particles`);
    assert.equal(object.isSprite ?? false, false, `${object.name} draws no billboards`);
    assert.equal(object.isLight ?? false, false, `${object.name} lights nothing`);
    if (object.isMesh) assert.equal(object.isInstancedMesh, true, `${object.name} is instanced`);
  });
  assert.equal(typeof rocks.update, 'undefined');
  assert.equal(rocks.userData.animated ?? false, false);

  // Medium: every rock is smaller than the smallest landmark formation by a
  // wide margin, and none of them is smaller than a step.
  assert.ok(rocks.userData.stats.sizes.maxSpan < 4, 'no medium rock becomes a landmark');
  assert.ok(rocks.userData.stats.sizes.minSpan > 0.5, 'no medium rock is a grain of ash');
  assert.ok(rocks.userData.stats.sizes.maxHeight < 3.5, 'the tallest rock is chest high at most');
  for (const formation of world.volcanicFormations.children) {
    assert.ok(formation.userData.height > rocks.userData.stats.sizes.maxHeight * 3);
  }

  // A fringe, not a covering: about a percent of the sector's ground.
  assert.ok(rocks.userData.stats.coverageShare < 0.03, 'the rocks do not pave the sector');
  assert.ok(rocks.userData.stats.coverageShare > 0.001, 'the rocks are actually there');
});

test('the scatter gathers at the crater, the formations, the slopes and the lava', () => {
  const zones = rocks.userData.zoneCounts;
  assert.deepEqual(Object.keys(zones).sort(), [...MEDIUM_ROCK_ZONES].sort());
  assert.equal(
    Object.values(zones).reduce((total, value) => total + value, 0),
    placements.length,
    'every rock belongs to one of the four zones',
  );
  assert.ok(zones['crater-rim'] > 0 && zones['formation-skirts'] > 0 && zones.slopes > 0 && zones['lava-banks'] > 0);

  const { settings, model } = planVolcanicRockPlacements(terrain, MAP_CONFIG);
  const crater = model.crater;
  const formations = world.volcanicFormations.children.map((formation) => ({
    id: formation.userData.formationId,
    x: formation.position.x,
    z: formation.position.z,
    radius: formation.userData.footprintRadius,
  }));

  for (const placement of placements) {
    // Inside the sector, with a margin, always.
    assert.ok(distanceToHexEdge(placement.x, placement.z, RADIUS) > settings.hexMargin - 1e-6);

    // Each zone keeps to the band it was authored with.
    if (placement.zone === 'crater-rim') {
      const u = Math.hypot(placement.x - crater.x, placement.z - crater.z) / rimRadiusAt(placement);
      assert.ok(
        u > settings.craterBand.inner - 0.1 && u < settings.craterBand.outer + 0.1,
        `crater-rim rock sits at u=${u.toFixed(2)}`,
      );
    } else if (placement.zone === 'formation-skirts') {
      const nearest = Math.min(...formations.map((formation) => (
        Math.hypot(placement.x - formation.x, placement.z - formation.z) - formation.radius
      )));
      assert.ok(
        nearest > -0.5 && nearest < settings.formationBand.outer + 1,
        'a formation rock sits at a skirt, not inside the landmark',
      );
    } else if (placement.zone === 'lava-banks') {
      assert.ok(
        placement.lavaDistance < settings.lavaBand.far + 1.5,
        'a lava-bank rock really is beside the lava',
      );
    } else {
      assert.ok(
        placement.slopeDeg > settings.slope.minDeg - 0.5,
        'a slope rock stands on ground the plains do not have',
      );
    }

    // And the shared rules hold for every rock of the layer.
    assert.ok(placement.lavaDistance > settings.lavaBand.near - 1e-6, 'no rock stands on the lava');
    assert.ok(placement.slopeDeg < settings.slope.maxDeg + 0.5, 'no rock sits on a cliff face');
    for (const formation of formations) {
      assert.ok(
        Math.hypot(placement.x - formation.x, placement.z - formation.z) > formation.radius * settings.formationBand.inner,
        'no rock grows out of a landmark formation',
      );
    }
  }

  // Most of the layer is anchored; the open ash field is not carpeted with it.
  const stats = rocks.userData.stats;
  assert.ok(stats.anchorShare > 0.6, `anchor share ${stats.anchorShare}`);
  assert.ok(stats.flatShare < 0.35, `flat-ground share ${stats.flatShare}`);
  let occupied = new Set();
  for (const placement of placements) {
    occupied.add(`${Math.floor(placement.x / 20)},${Math.floor(placement.z / 20)}`);
  }
  occupied = occupied.size;
  assert.ok(occupied < 130, `the layer touches ${occupied} of the sector's 20-unit cells`);
});

test('the medium rocks keep the walking areas and the crossings clear', () => {
  const { settings } = planVolcanicRockPlacements(terrain, MAP_CONFIG);

  for (const placement of placements) {
    for (const gate of terrain.gateAprons) {
      assert.ok(
        Math.hypot(placement.x - gate.x, placement.z - gate.z) > gate.outer + settings.gateClearance - 1e-6,
        'no rock stands in a portal apron',
      );
    }
    for (const route of routes) {
      assert.ok(
        distanceToSegment(placement, route.a, route.b) > settings.routeClearance - 1e-6,
        'no rock narrows a direct gate route',
      );
    }
    // The crater floor is a floor: only the band that hugs the pool may enter it.
    const rim = rimRadiusAt(placement);
    const u = Math.hypot(
      placement.x - terrain.layout.crater.x,
      placement.z - terrain.layout.crater.z,
    ) / rim;
    if (u < settings.craterFloorClear) {
      assert.ok(placement.lavaDistance < settings.lavaBand.far + 1.5, 'the crater floor stays open');
    }
  }

  // Minimum spacing: the rocks are a scatter, never a pile.
  for (let a = 0; a < placements.length; a += 1) {
    for (let b = a + 1; b < placements.length; b += 1) {
      const distance = Math.hypot(
        placements[a].x - placements[b].x,
        placements[a].z - placements[b].z,
      );
      assert.ok(distance > settings.minSpacing - 1e-6, `two rocks are ${distance.toFixed(2)} apart`);
    }
  }

  // Nothing is planted on the molten rock itself — the pool, the main channel
  // or the branch — and the plan measured every rock against the same lava the
  // sector actually carries.
  const { model } = planVolcanicRockPlacements(terrain, MAP_CONFIG);
  for (const placement of placements) {
    const lavaDistance = lavaEdgeDistance(model, placement.x, placement.z);
    assert.ok(lavaDistance > 0, 'a rock stands on the lava');
    assert.ok(Math.abs(lavaDistance - placement.lavaDistance) <= 0.75, 'the plan reads the lava as built');
  }
});

test('rock instances vary in size, yaw, tilt and shape', () => {
  const sizes = rocks.userData.stats.sizes;
  assert.ok(sizes.maxSpan > sizes.minSpan * 2.5, 'the collection carries a range of sizes');
  assert.ok(sizes.maxHeight > sizes.minHeight * 2, 'the collection carries a range of heights');

  const yawBins = new Array(12).fill(0);
  const variantCounts = new Map();
  let tilted = 0;
  let stretchedInstances = 0;
  for (const placement of placements) {
    assert.ok(placement.yaw >= 0 && placement.yaw < Math.PI * 2, 'every rock has its own yaw');
    yawBins[Math.floor((placement.yaw / (Math.PI * 2)) * 12) % 12] += 1;
    assert.ok(Math.abs(placement.tiltX) <= 0.09 + 1e-9 && Math.abs(placement.tiltZ) <= 0.09 + 1e-9);
    if (Math.abs(placement.tiltX) > 1e-3 || Math.abs(placement.tiltZ) > 1e-3) tilted += 1;
    const { x, y, z } = placement.scale;
    if (Math.max(x, y, z) / Math.min(x, y, z) > 1.06) stretchedInstances += 1;
    variantCounts.set(placement.variantId, (variantCounts.get(placement.variantId) ?? 0) + 1);
  }

  assert.equal(variantCounts.size, MEDIUM_ROCK_VARIANTS.length, 'every reusable shape is used');
  for (const [id, count] of variantCounts) assert.ok(count >= 10, `${id} is used ${count} times`);
  assert.ok(tilted > placements.length * 0.8, 'most rocks are tilted, not all level');
  assert.ok(stretchedInstances > placements.length * 0.5, 'instances are scaled unevenly');
  for (const bin of yawBins) assert.ok(bin >= 5, 'the yaws cover every direction');

  // The placements are seated on the relief they were planned against.
  for (const placement of placements) {
    assert.equal(placement.y, terrain.heightAt(placement.x, placement.z));
    assert.ok(placement.sink > 0, 'a rock is bedded into the ground, not perched on it');
  }
});

test('the layer rebuilds deterministically and changes nothing else', () => {
  const heights = terrain.heights.slice();
  const geometryPositions = terrain.geometry.getAttribute('position').array.slice();
  const geometryColors = terrain.geometry.getAttribute('color').array.slice();
  const lavaPool = terrain.lavaPool;
  const lavaFlow = terrain.lavaFlow;
  const lavaBranch = terrain.lavaSecondaryFlow;
  const vents = terrain.vents;
  const crust = terrain.cooledCrust;
  const formations = world.volcanicFormations.children.map((formation) => (
    formation.children[0].geometry.getAttribute('position').array.slice()
  ));

  const repeat = buildVolcanicRocks(terrain, MAP_CONFIG, { formations: world.volcanicFormations });
  assert.equal(repeat.children.length, rocks.children.length);
  for (let mesh = 0; mesh < repeat.children.length; mesh += 1) {
    assert.equal(repeat.children[mesh].count, rocks.children[mesh].count, 'the same count per shared shape');
    assert.deepEqual(
      repeat.children[mesh].instanceMatrix.array,
      rocks.children[mesh].instanceMatrix.array,
      `shared shape ${mesh} rebuilds to the same instances`,
    );
  }

  // The six shapes are genuinely different cuts, and cutting one twice gives
  // the same rock.
  const geometries = createMediumRockGeometries();
  assert.equal(geometries.length, MEDIUM_ROCK_GEOMETRY_COUNT);
  for (const record of geometries) {
    const again = createMediumRockGeometry(
      MEDIUM_ROCK_VARIANTS[record.variantIndex],
      record.cut,
    );
    assert.deepEqual(
      again.getAttribute('position').array,
      record.geometry.getAttribute('position').array,
      'a cut rebuilds exactly',
    );
  }
  const positions = geometries.map((record) => record.geometry.getAttribute('position').array);
  for (let a = 0; a < positions.length; a += 1) {
    for (let b = a + 1; b < positions.length; b += 1) {
      assert.notDeepEqual(positions[a], positions[b], 'two shared shapes are never the same rock');
    }
  }

  // The bake, the collision surface, the lava, the crust and the landmark
  // formations are all exactly what they were before the layer was built.
  assert.deepEqual(terrain.heights, heights, 'the rock layer never carves the terrain');
  assert.deepEqual(terrain.geometry.getAttribute('position').array, geometryPositions);
  assert.deepEqual(terrain.geometry.getAttribute('color').array, geometryColors);
  assert.equal(terrain.lavaPool, lavaPool);
  assert.equal(terrain.lavaFlow, lavaFlow);
  assert.equal(terrain.lavaSecondaryFlow, lavaBranch);
  assert.equal(terrain.vents, vents);
  assert.equal(terrain.cooledCrust, crust);
  world.volcanicFormations.children.forEach((formation, index) => {
    assert.deepEqual(formation.children[0].geometry.getAttribute('position').array, formations[index]);
  });

  // The switchboard removes the whole layer and nothing else.
  assert.equal(buildVolcanicRocks(terrain, { ...MAP_CONFIG, volcanicRocksEnabled: false }), null);
  assert.equal(buildVolcanicRocks(terrain, { ...MAP_CONFIG, volcanicRocks: false }), null);
  assert.equal(buildVolcanicRocks(terrain, { ...MAP_CONFIG, volcanicRocks: null }), null);
  assert.equal(planVolcanicRockPlacements(null, MAP_CONFIG), null);
  assert.equal(
    planVolcanicRockPlacements({ sectorId: 'HEX_S' }, MAP_CONFIG),
    null,
    'the layer belongs to the volcanic sector alone',
  );
});

test('the medium rock collection is limited and every zone can be retuned', () => {
  assert.equal(MEDIUM_ROCK_VARIANTS.length, 6);
  assert.equal(MEDIUM_ROCK_GEOMETRY_COUNT, 12);
  for (const variant of MEDIUM_ROCK_VARIANTS) {
    assert.equal(variant.seeds.length, 2, `${variant.id} is cut twice`);
    assert.ok(variant.masses.length >= 1 && variant.masses.length <= 2);
    for (const mass of variant.masses) {
      // Medium by construction: a shape is authored in a unit box.
      assert.ok(Math.max(mass.width, mass.depth) <= 1.3);
      assert.ok(mass.height <= 1.2);
    }
  }
  assert.equal(VOLCANIC_ROCK_DEFAULTS.size.max, 2.45);

  // The budget is plain data: halving it halves the layer.
  const half = planVolcanicRockPlacements(terrain, {
    ...MAP_CONFIG,
    volcanicRocks: { targetCount: VOLCANIC_ROCK_DEFAULTS.targetCount / 2 },
  });
  assert.ok(half.placements.length < placements.length);
  assert.ok(half.placements.length > placements.length * 0.3);

  // A single nested band can be retuned without dropping the others.
  const banded = planVolcanicRockPlacements(terrain, {
    ...MAP_CONFIG,
    volcanicRocks: { lavaBand: { near: 2, far: 3 } },
  });
  assert.equal(banded.settings.lavaBand.near, 2);
  assert.equal(banded.settings.lavaBand.far, 3);
  assert.equal(banded.settings.craterBand.inner, VOLCANIC_ROCK_DEFAULTS.craterBand.inner);
  assert.equal(banded.settings.channelBand.far, VOLCANIC_ROCK_DEFAULTS.channelBand.far);
  assert.deepEqual(banded.settings.zones, VOLCANIC_ROCK_DEFAULTS.zones);
  for (const placement of banded.placements) {
    assert.ok(placement.lavaDistance > 2, 'every rock clears the retuned lava band');
  }

  // A different seed is a different scatter over the same rules.
  const reseeded = planVolcanicRockPlacements(terrain, {
    ...MAP_CONFIG,
    volcanicRocks: { seed: 0x1234abcd },
  });
  assert.ok(
    Math.abs(reseeded.placements.length - placements.length) < 20,
    'a reseeded layer spends the same budget on the same four zones',
  );
  assert.notDeepEqual(
    reseeded.placements.map((placement) => [placement.x, placement.z]),
    placements.map((placement) => [placement.x, placement.z]),
  );
  for (const placement of reseeded.placements) {
    assert.ok(placement.lavaDistance > VOLCANIC_ROCK_DEFAULTS.lavaBand.near);
  }
});
