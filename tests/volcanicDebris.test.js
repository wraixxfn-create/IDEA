import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import {
  DEBRIS_GEOMETRY_COUNT,
  DEBRIS_VARIANTS,
  DEBRIS_ZONES,
  VOLCANIC_DEBRIS_DEFAULTS,
  buildVolcanicDebris,
  createDebrisGeometries,
  createDebrisGeometry,
  planVolcanicDebrisPlacements,
} from '../src/world/VolcanicDebris.js';
import { MEDIUM_ROCK_VARIANTS } from '../src/world/VolcanicRocks.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const world = new HexMap(new THREE.Scene(), MAP_CONFIG);
const terrain = world.volcanicTerrain;
const debris = world.volcanicDebris;
const placements = debris.userData.placements;
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

/** The medium rocks that exist, as the debris layer had to dodge them. */
const mediumRocks = world.volcanicRocks.userData.placements;

test('HEX_SE gains a small debris layer drawn from shared geometry', () => {
  assert.ok(debris, 'the volcanic sector has its small debris layer');
  assert.equal(debris.name, 'VolcanicDebris_HEX_SE');
  assert.equal(debris.userData.sectorId, 'HEX_SE');
  assert.equal(debris.userData.featureType, 'small-volcanic-debris-layer');
  assert.equal(debris.userData.static, true);
  assert.equal(debris.userData.collidable, false);
  assert.equal(debris.userData.animates, false);
  assert.equal(debris.userData.instanced, true);
  assert.equal(debris.parent, world.group);
  assert.equal(world.smallVolcanicDebris, debris, 'the layer is reachable under both names');
  // Sector-local placement, exactly like the terrain, the lava and the rocks.
  const sector = world.getSector('HEX_SE');
  assert.equal(debris.position.x, sector.center.x);
  assert.equal(debris.position.z, sector.center.z);
  assert.equal(debris.position.y, MAP_CONFIG.floorHeight);

  // A low-density scatter: hundreds of chips in a 125,000-unit sector, never a
  // carpet of rubble.
  const count = debris.userData.debrisCount;
  assert.ok(count >= 300 && count <= 1500, `unexpected debris count: ${count}`);
  assert.equal(count, placements.length);
  assert.equal(debris.userData.variantCount, DEBRIS_VARIANTS.length);
  assert.equal(debris.userData.geometryCount, DEBRIS_GEOMETRY_COUNT);

  // Instanced: every chip is drawn from one of twelve shared geometries, so the
  // layer costs one draw call per geometry and nothing more.
  assert.equal(debris.children.length, DEBRIS_GEOMETRY_COUNT);
  const geometries = new Set();
  let instances = 0;
  for (const mesh of debris.children) {
    assert.equal(mesh.isInstancedMesh, true, 'every debris mesh is instanced');
    assert.equal(mesh.userData.featureType, 'small-volcanic-debris-instances');
    assert.equal(mesh.userData.static, true);
    assert.equal(mesh.userData.collidable, false);
    assert.ok(mesh.count >= 10, `${mesh.name} holds a handful of pieces`);
    assert.equal(mesh.geometry.userData.surface, 'broken-volcanic-basalt');
    assert.equal(mesh.geometry.userData.featureType, 'small-volcanic-debris');
    assert.ok(mesh.geometry.getAttribute('position').count >= 36, 'a chip resolves its facets');
    assert.equal(
      mesh.geometry.getAttribute('color').count,
      mesh.geometry.getAttribute('position').count,
      'every facet carries its own basalt tone',
    );
    geometries.add(mesh.geometry);
    instances += mesh.count;
  }
  assert.equal(geometries.size, DEBRIS_GEOMETRY_COUNT, 'the layer shares twelve geometries');
  assert.equal(instances, count, 'every piece is an instance of a shared geometry');

  // Static: no clock, no particles, no lights, no colliders anywhere in it.
  debris.traverse((object) => {
    assert.equal(object.isPoints ?? false, false, `${object.name} draws no particles`);
    assert.equal(object.isSprite ?? false, false, `${object.name} draws no billboards`);
    assert.equal(object.isLight ?? false, false, `${object.name} lights nothing`);
    if (object.isMesh) assert.equal(object.isInstancedMesh, true, `${object.name} is instanced`);
  });
  assert.equal(typeof debris.update, 'undefined');

  // Small by construction: the biggest chip in the sector is smaller than the
  // smallest medium rock standing beside it, and smaller still than a landmark.
  const sizes = debris.userData.stats.sizes;
  assert.ok(sizes.maxSpan < world.volcanicRocks.userData.stats.sizes.minSpan,
    `the largest chip (${sizes.maxSpan}) is smaller than the smallest rock`);
  assert.ok(sizes.maxSpan < 0.8, 'no chip becomes a rock of its own');
  assert.ok(sizes.maxHeight < 0.6, 'no chip becomes a boulder');
  assert.ok(sizes.minSpan > 0.05, 'no chip is a speck of dust');
  assert.ok(sizes.maxSpan > sizes.minSpan * 2, 'the scatter carries a range of sizes');
  for (const formation of world.volcanicFormations.children) {
    assert.ok(formation.userData.height > sizes.maxHeight * 10, 'the landmarks stay landmarks');
  }

  // A scatter, not a covering: a fraction of a percent of the sector's ground.
  assert.ok(debris.userData.stats.coverageShare < 0.01, 'the debris does not pave the sector');
  assert.ok(debris.userData.stats.coverageShare > 0.0002, 'the debris is actually there');
  assert.ok(debris.userData.stats.cellShare < 0.2, 'most of the sector carries no debris at all');
});

test('the debris gathers at the crater, the formations, the lava and the steep ground', () => {
  const zones = debris.userData.zoneCounts;
  assert.deepEqual(Object.keys(zones).sort(), [...DEBRIS_ZONES].sort());
  assert.deepEqual(Object.keys(zones).sort(), [
    'crater-edges', 'lava-channels', 'rock-formations', 'steep-slopes',
  ]);
  assert.equal(
    Object.values(zones).reduce((total, value) => total + value, 0),
    placements.length,
    'every chip belongs to one of the four zones',
  );
  for (const zone of DEBRIS_ZONES) assert.ok(zones[zone] > 0, `${zone} carries debris`);

  const { settings, model } = planVolcanicDebrisPlacements(terrain, MAP_CONFIG, {
    formations: world.volcanicFormations,
    rocks: world.volcanicRocks,
  });
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
    if (placement.zone === 'crater-edges') {
      const u = Math.hypot(placement.x - crater.x, placement.z - crater.z) / rimRadiusAt(placement);
      assert.ok(
        u > settings.craterBand.inner - 0.1 && u < settings.craterBand.outer + 0.1,
        `crater-edge chip sits at u=${u.toFixed(2)}`,
      );
    } else if (placement.zone === 'rock-formations') {
      const nearest = Math.min(...formations.map((formation) => (
        Math.hypot(placement.x - formation.x, placement.z - formation.z) - formation.radius
      )));
      assert.ok(
        nearest > -0.5 && nearest < settings.formationBand.outer + 1,
        'a formation chip sits at a skirt, not inside the landmark',
      );
    } else if (placement.zone === 'lava-channels') {
      assert.ok(
        placement.lavaDistance < settings.lavaBand.far + 1.5,
        'a channel chip really is beside the molten rock',
      );
    } else {
      assert.ok(
        placement.slopeDeg > settings.slope.minDeg - 0.5,
        'a slope chip lies on ground the plains do not have',
      );
    }
  }

  // Most of the layer is anchored to the crater, the formations and the lava;
  // the open ash field is not stippled with rubble.
  const stats = debris.userData.stats;
  assert.ok(stats.anchorShare > 0.55, `anchor share ${stats.anchorShare}`);
  assert.ok(stats.flatShare < 0.4, `flat-ground share ${stats.flatShare}`);

  // Every piece whose zone is the crater's edge really does lie in that band,
  // measured from the rim the sector actually has.
  let rimPieces = 0;
  for (const placement of placements) {
    const u = Math.hypot(placement.x - crater.x, placement.z - crater.z) / rimRadiusAt(placement);
    if (u > settings.craterBand.inner && u < settings.craterBand.outer) rimPieces += 1;
  }
  assert.ok(rimPieces >= zones['crater-edges'], 'the crater band is where it says it is');
  assert.ok(rimPieces > 200, `the crater wears ${rimPieces} pieces of debris`);
});

test('the debris keeps the walking areas clear and stays low density', () => {
  const { settings } = planVolcanicDebrisPlacements(terrain, MAP_CONFIG, {
    formations: world.volcanicFormations,
    rocks: world.volcanicRocks,
  });

  for (const placement of placements) {
    for (const gate of terrain.gateAprons) {
      assert.ok(
        Math.hypot(placement.x - gate.x, placement.z - gate.z) > gate.outer + settings.gateClearance - 1e-6,
        'no chip lies in a portal apron',
      );
    }
    for (const route of routes) {
      assert.ok(
        distanceToSegment(placement, route.a, route.b) > settings.routeClearance - 1e-6,
        'no chip narrows a direct gate route',
      );
    }
    // Never on the molten rock, and never buried inside a medium rock.
    assert.ok(placement.lavaDistance > settings.lavaBand.near - 1e-6, 'a chip lies on the lava');
    for (const rock of mediumRocks) {
      const radius = rock.span * 0.5 + settings.rockClearance;
      assert.ok(
        Math.hypot(placement.x - rock.x, placement.z - rock.z) > radius - 1e-6,
        'a chip sits inside a medium rock',
      );
    }
    // The crater floor is a floor: only the band that hugs the pool enters it.
    const rim = rimRadiusAt(placement);
    const u = Math.hypot(
      placement.x - terrain.layout.crater.x,
      placement.z - terrain.layout.crater.z,
    ) / rim;
    if (u < settings.craterFloorClear) {
      assert.ok(placement.lavaDistance < settings.lavaBand.far + 1.5, 'the crater floor stays open');
    }
    assert.ok(placement.slopeDeg < settings.slope.maxDeg + 0.5, 'no chip sits on a cliff face');
  }

  // Minimum spacing: the chips are a scatter, never a pile.
  for (let a = 0; a < placements.length; a += 1) {
    for (let b = a + 1; b < placements.length; b += 1) {
      const distance = Math.hypot(
        placements[a].x - placements[b].x,
        placements[a].z - placements[b].z,
      );
      assert.ok(distance > settings.minSpacing - 1e-6, `two chips are ${distance.toFixed(2)} apart`);
    }
  }

  // The per-cell cap holds however the sampler drew: no pocket of the sector
  // can read as a field of rubble.
  const cells = new Map();
  for (const placement of placements) {
    const key = `${Math.floor(placement.x / settings.cluster.cell)},${Math.floor(placement.z / settings.cluster.cell)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  for (const [cell, count] of cells) {
    assert.ok(count <= settings.cluster.max, `${cell} collected ${count} pieces`);
  }
  assert.equal(cells.size, debris.userData.stats.cellsUsed);
});

test('debris instances vary in size, yaw, tilt and shape', () => {
  const sizes = debris.userData.stats.sizes;
  assert.ok(sizes.maxHeight > sizes.minHeight * 2.5, 'the collection carries a range of heights');

  const yawBins = new Array(12).fill(0);
  const variantCounts = new Map();
  let tilted = 0;
  let stretchedInstances = 0;
  for (const placement of placements) {
    assert.ok(placement.yaw >= 0 && placement.yaw < Math.PI * 2, 'every chip has its own yaw');
    yawBins[Math.floor((placement.yaw / (Math.PI * 2)) * 12) % 12] += 1;
    assert.ok(Math.abs(placement.tiltX) <= 0.16 + 1e-9 && Math.abs(placement.tiltZ) <= 0.16 + 1e-9);
    if (Math.abs(placement.tiltX) > 1e-3 || Math.abs(placement.tiltZ) > 1e-3) tilted += 1;
    const { x, y, z } = placement.scale;
    if (Math.max(x, y, z) / Math.min(x, y, z) > 1.06) stretchedInstances += 1;
    variantCounts.set(placement.variantId, (variantCounts.get(placement.variantId) ?? 0) + 1);
  }

  assert.equal(variantCounts.size, DEBRIS_VARIANTS.length, 'every reusable shape is used');
  for (const [id, count] of variantCounts) assert.ok(count >= 10, `${id} is used ${count} times`);
  assert.ok(tilted > placements.length * 0.9, 'most chips are tilted, not all level');
  assert.ok(stretchedInstances > placements.length * 0.5, 'instances are scaled unevenly');
  for (const bin of yawBins) assert.ok(bin >= 5, 'the yaws cover every direction');

  // The placements are seated on the relief they were planned against.
  for (const placement of placements) {
    assert.equal(placement.y, terrain.heightAt(placement.x, placement.z));
    assert.ok(placement.sink > 0, 'a chip is bedded into the ground, not perched on it');
    assert.ok(placement.span < sizes.maxSpan + 1e-9);
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
  const rocks = world.volcanicRocks;
  const rockMatrices = rocks.children.map((mesh) => mesh.instanceMatrix.array.slice());
  const formations = world.volcanicFormations.children.map((formation) => (
    formation.children[0].geometry.getAttribute('position').array.slice()
  ));
  const debrisMatrices = debris.children.map((mesh) => mesh.instanceMatrix.array.slice());
  const collisionBoxes = world.collisionBoxes.length;

  const repeat = buildVolcanicDebris(terrain, MAP_CONFIG, {
    formations: world.volcanicFormations,
    rocks,
  });
  assert.equal(repeat.children.length, debris.children.length);
  for (let mesh = 0; mesh < repeat.children.length; mesh += 1) {
    assert.equal(repeat.children[mesh].count, debris.children[mesh].count, 'the same count per shared shape');
    assert.deepEqual(
      repeat.children[mesh].instanceMatrix.array,
      debris.children[mesh].instanceMatrix.array,
      `shared shape ${mesh} rebuilds to the same instances`,
    );
  }

  // The twelve shapes are genuinely different cuts, and cutting one twice gives
  // the same piece of rubble.
  const geometries = createDebrisGeometries();
  assert.equal(geometries.length, DEBRIS_GEOMETRY_COUNT);
  for (const record of geometries) {
    const again = createDebrisGeometry(DEBRIS_VARIANTS[record.variantIndex], record.cut);
    assert.deepEqual(
      again.getAttribute('position').array,
      record.geometry.getAttribute('position').array,
      'a cut rebuilds exactly',
    );
    // Authored in a unit box: the broken cap may add a tenth of the height,
    // and nothing more.
    assert.ok(again.boundingBox.max.y <= 1, 'a shape grows past the unit box it was authored in');
    assert.ok(again.boundingBox.min.y >= 0, 'a shape hangs below its own base');
  }
  const positions = geometries.map((record) => record.geometry.getAttribute('position').array);
  for (let a = 0; a < positions.length; a += 1) {
    for (let b = a + 1; b < positions.length; b += 1) {
      assert.notDeepEqual(positions[a], positions[b], 'two shared shapes are never the same piece');
    }
  }

  // The bake, the collision surface, the lava, the crust, the medium rocks and
  // the landmark formations are all exactly what they were.
  assert.deepEqual(terrain.heights, heights, 'the debris layer never carves the terrain');
  assert.deepEqual(terrain.geometry.getAttribute('position').array, geometryPositions);
  assert.deepEqual(terrain.geometry.getAttribute('color').array, geometryColors);
  assert.equal(terrain.lavaPool, lavaPool);
  assert.equal(terrain.lavaFlow, lavaFlow);
  assert.equal(terrain.lavaSecondaryFlow, lavaBranch);
  assert.equal(terrain.vents, vents);
  assert.equal(terrain.cooledCrust, crust);
  assert.equal(world.volcanicRocks, rocks, 'the medium rock layer was replaced');
  rocks.children.forEach((mesh, index) => {
    assert.deepEqual(mesh.instanceMatrix.array, rockMatrices[index], 'the medium rocks moved');
  });
  world.volcanicFormations.children.forEach((formation, index) => {
    assert.deepEqual(formation.children[0].geometry.getAttribute('position').array, formations[index]);
  });
  assert.equal(world.collisionBoxes.length, collisionBoxes, 'the debris added a collider');

  // Nothing in the debris is animated: a tick moves nothing in it.
  world.update(1, new THREE.Vector3(sectorCenterX(), 0, sectorCenterZ()));
  debris.children.forEach((mesh, index) => {
    assert.deepEqual(mesh.instanceMatrix.array, debrisMatrices[index], 'the debris moved with the world clock');
  });

  // The switchboard removes the whole layer and nothing else.
  assert.equal(buildVolcanicDebris(terrain, { ...MAP_CONFIG, volcanicDebrisEnabled: false }), null);
  assert.equal(buildVolcanicDebris(terrain, { ...MAP_CONFIG, volcanicDebris: false }), null);
  assert.equal(buildVolcanicDebris(terrain, { ...MAP_CONFIG, volcanicDebris: null }), null);
  assert.equal(planVolcanicDebrisPlacements(null, MAP_CONFIG), null);
  assert.equal(
    planVolcanicDebrisPlacements({ sectorId: 'HEX_S' }, MAP_CONFIG),
    null,
    'the layer belongs to the volcanic sector alone',
  );
});

function sectorCenterX() {
  return world.getSector('HEX_SE').center.x;
}

function sectorCenterZ() {
  return world.getSector('HEX_SE').center.z;
}

test('the world without the debris layer is the world with it, minus the debris', () => {
  const off = new HexMap(new THREE.Scene(), { ...MAP_CONFIG, volcanicDebrisEnabled: false });
  assert.equal(off.volcanicDebris, null, 'the layer is switched off');
  assert.equal(off.smallVolcanicDebris, null);
  assert.equal(off.group.children.length, world.group.children.length - 1,
    'the layer is exactly one object in the world');
  assert.ok(off.volcanicRocks, 'the medium rocks are still there');
  assert.equal(off.volcanicRocks.userData.rockCount, world.volcanicRocks.userData.rockCount,
    'the medium rock layer changed with the debris switched off');
  for (const mesh of off.volcanicRocks.children) {
    assert.equal(mesh.isInstancedMesh, true);
  }
  assert.deepEqual(
    off.collisionBoxes.map(({ door, ...box }) => box),
    world.collisionBoxes.map(({ door, ...box }) => box),
    'the debris added collision',
  );
});

test('the debris collection is limited and every zone can be retuned', () => {
  assert.equal(DEBRIS_VARIANTS.length, 6);
  assert.equal(DEBRIS_GEOMETRY_COUNT, 12);
  for (const variant of DEBRIS_VARIANTS) {
    assert.equal(variant.seeds.length, 2, `${variant.id} is cut twice`);
    assert.ok(variant.masses.length >= 1 && variant.masses.length <= 3);
    for (const mass of variant.masses) {
      // Small by construction: a shape is authored in a unit box.
      assert.ok(Math.max(mass.width, mass.depth) <= 1.1, `${variant.id} is authored too wide`);
      assert.ok(mass.height <= 0.9, `${variant.id} is authored too tall`);
    }
  }
  // A chip is a fraction of a medium rock, whatever the seeds do: the whole
  // collection is authored inside a box no bigger than a medium rock's, and
  // the instances are drawn at a fifth of that again.
  const authoredExtent = Math.max(...DEBRIS_VARIANTS.flatMap((variant) => (
    variant.masses.map((mass) => Math.max(mass.width, mass.depth, mass.height))
  )));
  const mediumAuthoring = Math.max(...MEDIUM_ROCK_VARIANTS.flatMap((variant) => (
    variant.masses.map((mass) => Math.max(mass.width, mass.depth))
  )));
  assert.ok(authoredExtent < mediumAuthoring, 'a debris shape is authored as large as a rock');
  assert.equal(VOLCANIC_DEBRIS_DEFAULTS.size.max, 0.52);
  assert.ok(VOLCANIC_DEBRIS_DEFAULTS.size.max < 0.7);
  assert.ok(
    VOLCANIC_DEBRIS_DEFAULTS.size.max * authoredExtent < world.volcanicRocks.userData.stats.sizes.minSpan,
    'no debris instance can reach the size of the smallest medium rock',
  );

  // The budget is plain data: halving it thins the layer.
  const half = planVolcanicDebrisPlacements(terrain, {
    ...MAP_CONFIG,
    volcanicDebris: { targetCount: VOLCANIC_DEBRIS_DEFAULTS.targetCount / 2 },
  });
  assert.ok(half.placements.length < placements.length);
  assert.ok(half.placements.length > placements.length * 0.3);

  // A single nested band can be retuned without dropping the others.
  const banded = planVolcanicDebrisPlacements(terrain, {
    ...MAP_CONFIG,
    volcanicDebris: { lavaBand: { near: 1.2, far: 2 } },
  });
  assert.equal(banded.settings.lavaBand.near, 1.2);
  assert.equal(banded.settings.lavaBand.far, 2);
  assert.equal(banded.settings.craterBand.inner, VOLCANIC_DEBRIS_DEFAULTS.craterBand.inner);
  assert.equal(banded.settings.cluster.max, VOLCANIC_DEBRIS_DEFAULTS.cluster.max);
  assert.deepEqual(banded.settings.zones, VOLCANIC_DEBRIS_DEFAULTS.zones);
  for (const placement of banded.placements) {
    assert.ok(placement.lavaDistance > 1.2, 'every chip clears the retuned lava band');
  }

  // A different seed is a different scatter over the same rules.
  const reseeded = planVolcanicDebrisPlacements(terrain, {
    ...MAP_CONFIG,
    volcanicDebris: { seed: 0x1234abcd },
  });
  assert.ok(
    Math.abs(reseeded.placements.length - placements.length) < 40,
    'a reseeded layer spends the same budget on the same four zones',
  );
  assert.notDeepEqual(
    reseeded.placements.map((placement) => [placement.x, placement.z]),
    placements.map((placement) => [placement.x, placement.z]),
  );
  for (const placement of reseeded.placements) {
    assert.ok(placement.lavaDistance > VOLCANIC_DEBRIS_DEFAULTS.lavaBand.near);
  }

  // The per-cell cap can be tightened to near-nothing, which is the switch a
  // clutter-averse world would turn.
  const sparse = planVolcanicDebrisPlacements(terrain, {
    ...MAP_CONFIG,
    volcanicDebris: { cluster: { cell: 8, max: 1 } },
  });
  const cells = new Set();
  for (const placement of sparse.placements) {
    const key = `${Math.floor(placement.x / 8)},${Math.floor(placement.z / 8)}`;
    assert.ok(!cells.has(key), 'an 8-unit cell collected more than one chip');
    cells.add(key);
  }
});
