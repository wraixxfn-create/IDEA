import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { VolcanicTerrain, DEFAULT_VOLCANIC_LAYOUT } from '../src/world/VolcanicTerrain.js';
import {
  LAVA_MATERIAL_DEFAULTS,
  buildLavaPool,
  carveLavaPool,
  createLavaCrustTexture,
  createLavaMaterial,
  lavaCrustTextureOf,
  lavaPoolBedAt,
  lavaPoolSampleAt,
  lavaPoolShadeAt,
  planLavaPool,
} from '../src/world/LavaPool.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const RADIUS = MAP_CONFIG.hexRadius;
const AMPLITUDE = MAP_CONFIG.volcanicTerrainAmplitude ?? 18;
const CRATER = DEFAULT_VOLCANIC_LAYOUT.crater;
const GATE_APRON_KEEP_CLEAR = MAP_CONFIG.volcanicGateApronOuter ?? 58;

/** The four portal centres of HEX_SE, in sector-local coordinates. */
function hexSeGateAprons() {
  const data = buildHexMapData(RADIUS);
  const sector = data.byId.get('HEX_SE');
  return data.sharedEdges
    .filter((gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE')
    .map((gate) => ({ x: gate.center.x - sector.center.x, z: gate.center.z - sector.center.z }));
}

/** A baked volcanic terrain with no lava, for the before/after comparisons. */
function makePlainTerrain(config = MAP_CONFIG) {
  return new VolcanicTerrain({
    radius: RADIUS,
    config: { ...config, lavaPoolEnabled: false },
    sectorId: 'HEX_SE',
    gateAprons: hexSeGateAprons(),
  });
}

function makeTerrain(config = MAP_CONFIG) {
  return new VolcanicTerrain({
    radius: RADIUS,
    config,
    sectorId: 'HEX_SE',
    gateAprons: hexSeGateAprons(),
  });
}

// The pool's own terrain is expensive enough that one shared map is worth it.
let sharedMap = null;
function map(config = MAP_CONFIG) {
  if (!sharedMap) sharedMap = new HexMap(new THREE.Scene(), config);
  return sharedMap;
}

const PLAIN = makePlainTerrain();

test('HEX_SE carries exactly one lava pool, and it is inside the main crater', () => {
  const terrain = makeTerrain();
  const pool = terrain.lavaPool;
  assert.ok(pool, 'the volcanic sector carries the pool');
  assert.equal(pool.id, 'lava-pool-hex-se');
  assert.equal(terrain.geometry.userData.lavaPool, pool.id);
  assert.ok(!Array.isArray(pool), 'the layout is one pool, not a list of them');

  // It sits in the crater the sector already had: well inside the crown and
  // well outside the vent, over the deep ground of the bowl.
  const distance = Math.hypot(pool.x - CRATER.x, pool.z - CRATER.z);
  assert.ok(distance < CRATER.rimRadius * 0.5, `the pool is ${distance.toFixed(1)} from the vent`);
  assert.ok(
    distanceToHexEdge(pool.x, pool.z, RADIUS) > pool.support + 40,
    'the pool is nowhere near a shared edge',
  );
  assert.ok(
    pool.level < terrain.heightAt(CRATER.x, CRATER.z) + 1,
    'the pool sits in the crater floor, not on its rim',
  );

  // And it never crowds a doorway.
  for (const apron of terrain.gateAprons) {
    const toGate = Math.hypot(apron.x - pool.x, apron.z - pool.z);
    assert.ok(toGate > GATE_APRON_KEEP_CLEAR + pool.support, `the pool is ${toGate.toFixed(1)} from a gate`);
  }
});

test('the pool is one level sheet of lava with an irregular outline', () => {
  const terrain = makeTerrain();
  const built = buildLavaPool(terrain, terrain.lavaPool, MAP_CONFIG);
  assert.ok(built, 'the sheet is built');
  const positions = built.geometry.getAttribute('position');

  // Level: every vertex of the molten sheet sits on one plane, because that is
  // what the surface of a liquid does.
  const level = terrain.lavaPool.level;
  for (let v = 0; v < positions.count; v += 1) {
    assert.ok(Math.abs(positions.getY(v) - (level + terrain.lavaPool.lift)) < 1e-6, 'the sheet is flat');
  }

  // Irregular: the shoreline is a real, lobed contour, not a circle.
  const { radii, min, max, mean, deviation } = built.shoreline;
  assert.ok(min > 5, `the pool is only ${(min * 2).toFixed(1)} units across at its narrowest`);
  assert.ok(max / min > 1.15, `the outline only varies by ${(max / min).toFixed(2)}x: that is a circle`);
  assert.ok(deviation / mean > 0.05, `the shoreline deviation is only ${(deviation / mean).toFixed(3)}`);
  assert.ok(built.area > 350 && built.area < 1400, `${built.area.toFixed(0)} square units of lava`);

  // The outline follows the terrain: every bearing's edge is where the ground
  // comes up through the lava, to within the ring spacing.
  for (let i = 0; i < radii.length; i += 17) {
    const angle = (i / radii.length) * Math.PI * 2;
    const x = terrain.lavaPool.x + Math.cos(angle) * radii[i];
    const z = terrain.lavaPool.z + Math.sin(angle) * radii[i];
    assert.ok(
      Math.abs(terrain.heightAt(x, z) - (level + terrain.lavaPool.lift)) < 0.02,
      `bearing ${i}: the shore misses the waterline by ${terrain.heightAt(x, z) - level}`,
    );
  }

  // Nothing is drawn outside the pool's own footprint, so nothing was raised
  // anywhere else to hold it up.
  for (let v = 0; v < positions.count; v += 1) {
    const x = positions.getX(v);
    const z = positions.getZ(v);
    assert.ok(lavaPoolSampleAt(x, z, terrain.lavaPool), `lava at (${x}, ${z}) has no bed`);
  }
});

test('the lava is never floating, and it has a floor at a believable depth', () => {
  const terrain = makeTerrain();
  const pool = terrain.lavaPool;
  const plane = pool.level + pool.lift;
  const built = buildLavaPool(terrain, pool, MAP_CONFIG);
  const segments = built.shoreline.meshRadii.length;

  // Sample the ground all over the sheet. It is never above the lava, it is
  // deepest where the lava ponds and flush with the shore at the rim, and it
  // always has a bed (so the sheet is never hanging over ground the pool did
  // not lift — there is no gap to see under).
  let deepest = 0;
  let shallowest = Infinity;
  let samples = 0;
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    for (let fraction = 0; fraction <= 1.0001; fraction += 0.05) {
      const radius = built.shoreline.meshRadii[i] * fraction;
      const x = pool.x + Math.cos(angle) * radius;
      const z = pool.z + Math.sin(angle) * radius;
      assert.ok(lavaPoolBedAt(x, z, pool) !== null, `the sheet at (${x}, ${z}) has no bed under it`);
      const ground = terrain.heightAt(x, z);
      samples += 1;
      // Strictly below the sheet everywhere inside it, and flush with it on the
      // shore, which is where the outline was solved: a few centimetres of
      // tolerance there is the bisection's own resolution.
      const slack = fraction >= 0.999 ? 0.03 : 0;
      assert.ok(
        ground < plane + slack,
        `the ground pokes ${(ground - plane).toFixed(3)} through the lava at (${x}, ${z})`,
      );
      const lake = plane - ground;
      deepest = Math.max(deepest, lake);
      shallowest = Math.min(shallowest, lake);
    }
  }
  assert.ok(samples > 500, 'the sheet was sampled properly');

  // Believable depth: a real pond over the middle of the pool, a shore that
  // comes up to meet the lava, and a floor that is not one flat plate — the
  // depths in between are all the crater's own bowl.
  assert.ok(deepest > 0.4, `the pool is only ${deepest.toFixed(2)} deep`);
  assert.ok(deepest < 1.4, `the pool is ${deepest.toFixed(2)} deep: that is a bathtub, not a lava lake`);
  assert.ok(deepest - shallowest > 0.25, `the depth only varies by ${(deepest - shallowest).toFixed(2)}`);
  assert.ok(shallowest < 0.12, `the pool never comes up to its own shore (${shallowest.toFixed(3)})`);
});

test('the pool changed the pool and nothing else — the crater is untouched', () => {
  const terrain = makeTerrain();
  const plain = PLAIN;
  const pool = terrain.lavaPool;

  let moved = 0;
  let movedAbove = 0;
  let movedOutside = 0;
  let movedNearGate = 0;
  let largest = 0;
  for (let v = 0; v < terrain.vertexCount; v += 1) {
    const change = terrain.heights[v] - plain.heights[v];
    if (change === 0) continue;
    assert.ok(change > 0, 'the pool only ever raises ground');
    moved += 1;
    largest = Math.max(largest, change);
    const x = terrain.positions[v * 3];
    const z = terrain.positions[v * 3 + 2];
    if (terrain.heights[v] >= pool.level + pool.lift) {
      movedAbove += 1;
      const sample = lavaPoolSampleAt(x, z, pool);
      assert.ok(
        sample && sample.ridge > 0.5,
        `ground was raised above the lava off the bank, at (${x}, ${z})`,
      );
    }
    if (!lavaPoolSampleAt(x, z, pool)) movedOutside += 1;
    for (const apron of terrain.gateAprons) {
      if (Math.hypot(apron.x - x, apron.z - z) < GATE_APRON_KEEP_CLEAR) movedNearGate += 1;
    }
  }

  assert.ok(moved > 40, 'the pool really did raise a bed');
  assert.ok(largest > 1.5, `the deepest raise is only ${largest.toFixed(2)}`);
  assert.equal(movedOutside, 0, 'the pool raised ground outside its own footprint');
  // Ground that now stands above the lava it is next to is the bank: the ridge
  // of cooled crust the pool throws up around its own edge. Without it the
  // surface would have no shore to stop at.
  assert.ok(movedAbove > 0, 'the pool has no bank at all');
  assert.equal(movedNearGate, 0, 'the pool raised ground in a gate apron');
  assert.ok(moved / terrain.vertexCount < 0.03, `${moved} of ${terrain.vertexCount} vertices moved`);

  // The sector's bulk statistics are untouched: same relief range, same
  // steepest face, still every bit as walkable, rim still flat.
  assert.deepEqual(
    [...terrain.geometry.userData.heightRange],
    [...plain.geometry.userData.heightRange],
    'the sector relief range moved',
  );
  assert.ok(
    terrain.geometry.userData.maxSlopeDegrees <= MAP_CONFIG.volcanicTerrainMaxSlopeDeg + 1e-3,
    `steepest face is ${terrain.geometry.userData.maxSlopeDegrees} degrees`,
  );
  assert.equal(terrain.geometry.userData.vents, plain.geometry.userData.vents, 'the vents are unchanged');
  for (let v = 0; v < terrain.vertexCount; v += 1) {
    if (!terrain.isRim[v]) continue;
    assert.equal(terrain.heights[v], 0, 'the sector rim is still flat');
  }

  // The crate's report says what happened, and it agrees with the lattice.
  const report = terrain.lavaPoolReport;
  assert.equal(report.id, pool.id);
  assert.equal(report.vertices, moved);
  assert.ok(Math.abs(report.deepestRaise - largest) < 1e-6, 'the report matches the lattice');
  assert.ok(report.levelFrom === 'measured', 'the lava level was measured off the crater floor');
  assert.ok(report.basinDepth > 1.5, `the basin is only ${report.basinDepth.toFixed(2)} deep`);
  assert.ok(report.depth > 0.3 && report.depth < 1.5, `the lava is ${report.depth.toFixed(2)} deep`);
});

test('the pool is a basin the explorer can walk into and out of', () => {
  const terrain = makeTerrain();
  const pool = terrain.lavaPool;
  const limit = Math.tan(THREE.MathUtils.degToRad(MAP_CONFIG.volcanicTerrainMaxSlopeDeg));

  // Walk in from outside: the ground may never jump by more than the sector's
  // own walkable slope allows, and the way in dips below the lava and comes
  // back out the other side.
  const step = 0.25;
  for (const bearing of [0, 1.1, 2.4, 3.9, 5.2]) {
    const dirX = Math.cos(bearing);
    const dirZ = Math.sin(bearing);
    let previous = null;
    let lowest = Infinity;
    for (let r = 0; r <= pool.support; r += step) {
      const height = terrain.heightAt(pool.x + dirX * r, pool.z + dirZ * r);
      lowest = Math.min(lowest, height);
      if (previous !== null) {
        assert.ok(
          Math.abs(height - previous) <= limit * step + 1e-6,
          `a cliff on bearing ${bearing} at ${r.toFixed(1)}: ${previous} -> ${height}`,
        );
      }
      previous = height;
    }
    assert.ok(lowest < pool.level, `bearing ${bearing} never dips below the lava`);
  }

  // And the bank really stands above the lava: the pool is enclosed by its own
  // cooled shore on every bearing, which is what keeps the surface in.
  const built = buildLavaPool(terrain, pool, MAP_CONFIG);
  let lowestCrest = Infinity;
  for (let i = 0; i < built.shoreline.radii.length; i += 1) {
    const angle = (i / built.shoreline.radii.length) * Math.PI * 2;
    let crest = -Infinity;
    for (let r = built.shoreline.radii[i]; r <= built.shoreline.radii[i] + 14; r += 0.5) {
      crest = Math.max(crest, terrain.heightAt(pool.x + Math.cos(angle) * r, pool.z + Math.sin(angle) * r));
    }
    lowestCrest = Math.min(lowestCrest, crest - pool.level);
  }
  assert.ok(lowestCrest > 0.1, `the lowest bank crest is only ${lowestCrest.toFixed(2)} above the lava`);
});

test('the terrain paints the pool its cooled margin', () => {
  const terrain = makeTerrain();
  const pool = terrain.lavaPool;
  const colors = terrain.geometry.getAttribute('color');

  // Every vertex close to the shore — and under the sheet — is shaded as the
  // pool's own crust: distinctly darker than the basalt a few units away.
  let shoreSum = 0;
  let shoreCount = 0;
  let rockSum = 0;
  let rockCount = 0;
  for (let v = 0; v < terrain.vertexCount; v += 1) {
    const x = terrain.positions[v * 3];
    const z = terrain.positions[v * 3 + 2];
    const height = terrain.heights[v];
    const shade = lavaPoolShadeAt(x, z, height, pool);
    const luma = (colors.getX(v) + colors.getY(v) + colors.getZ(v)) / 3;
    const distance = Math.hypot(x - pool.x, z - pool.z);
    if (shade.crust > 0.6) {
      shoreSum += luma;
      shoreCount += 1;
    } else if (distance > pool.support && distance < pool.support + 34) {
      // The same crater floor, a few strides beyond the pool's own margin.
      rockSum += luma;
      rockCount += 1;
    }
    // Far from the pool the shading is exactly zero, so nothing else moved.
    if (distance > pool.support) {
      assert.equal(shade.crust, 0, `crust shading leaked to (${x}, ${z})`);
      assert.equal(shade.ember, 0, `ember shading leaked to (${x}, ${z})`);
    }
  }
  assert.ok(shoreCount > 20, `only ${shoreCount} vertices carry the pool's crust`);
  assert.ok(rockCount > 20, `only ${rockCount} vertices above the pool were sampled`);
  assert.ok(shoreSum / shoreCount < rockSum / rockCount, 'the shore is not darker than the rock above it');
});

test('one reusable lava material, built from configuration alone', () => {
  const a = createLavaMaterial(MAP_CONFIG);
  const b = createLavaMaterial(MAP_CONFIG);
  assert.equal(a, b, 'the same configuration hands back the same material');

  const other = createLavaMaterial({ ...MAP_CONFIG, lavaCrustTile: MAP_CONFIG.lavaCrustTile * 2 });
  assert.notEqual(other, a, 'a different palette is a different material');

  // The whole look: an emissive, vertex-coloured standard surface skinned with
  // the crust tile — no time, no noise shader, nothing to animate.
  assert.equal(a.vertexColors, true);
  assert.equal(a.emissiveIntensity, MAP_CONFIG.lavaEmissiveIntensity ?? LAVA_MATERIAL_DEFAULTS.emissiveIntensity);
  assert.ok(a.emissiveMap && a.map, 'the crust skin drives both the albedo and the emission');
  assert.equal(a.map, a.emissiveMap);
  assert.equal(a.userData.lava.animates, false);
  assert.equal(a.map.wrapS, THREE.RepeatWrapping);
  assert.equal(a.map.wrapT, THREE.RepeatWrapping);
  assert.equal(a.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(lavaCrustTextureOf(a), a.map);

  // The emissive follows the sheet's own heat: the vertex colours drive the
  // glow as well as the albedo, or the cooled crust would still burn. The patch
  // is anchored on the shader chunk three actually compiles the standard
  // material from, so this is also the guard that a future three.js rename
  // cannot quietly drop it — the whole point of the pool's look.
  const shader = { fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  a.onBeforeCompile(shader, null);
  assert.match(
    shader.fragmentShader,
    /#include <color_fragment>\s*totalEmissiveRadiance \*= vColor\.rgb;/,
    'the emissive patch no longer finds its anchor in the standard shader',
  );
  assert.equal(a.onBeforeCompile, b.onBeforeCompile, 'the cached material keeps its patch');
  assert.equal(
    THREE.ShaderLib.physical.fragmentShader.includes('#include <color_fragment>'),
    true,
    'three no longer compiles the standard material from the physical shader',
  );
});

test('the crust tile is a seamless square of cooled plates and glowing cracks', () => {
  const size = 64;
  const texture = createLavaCrustTexture({ crustTextureSize: size, crustCells: 5, crustSeed: 0x1234 });
  assert.ok(texture.isDataTexture);
  assert.equal(texture.image.width, size);
  assert.equal(texture.image.height, size);

  const data = texture.image.data;
  const at = (x, y) => {
    const o = (((y % size) + size) % size * size + ((x % size) + size) % size) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };
  // The tile is a bright modulation — it multiplies the lava's own glow as well
  // as its albedo, so nothing in it may be dark — over a pattern that really is
  // a pattern: plates, warm plates and the glowing seams between them.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < size * size; i += 1) {
    const luma = data[i * 4] * 0.4 + data[i * 4 + 1] * 0.5 + data[i * 4 + 2] * 0.1;
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    assert.ok(data[i * 4] >= data[i * 4 + 1] && data[i * 4 + 1] >= data[i * 4 + 2], 'the crust is not warm');
  }
  assert.ok(min > 150, `the darkest crust texel is ${min.toFixed(0)}: that would halve the lava's glow`);
  assert.ok(max > 230, `the brightest seam is only ${max.toFixed(0)}: the cracks never glow`);
  assert.ok(max - min > 20, `the tile only spans ${(max - min).toFixed(0)}: that is a flat colour`);

  // Seamless: the tile has to repeat across a pool without a line to see, so
  // the column past the right edge is the column at the left, and likewise
  // downwards.
  assert.deepEqual(at(0, 7), at(size, 7), 'the tile does not wrap horizontally');
  assert.deepEqual(at(13, 0), at(13, size), 'the tile does not wrap vertically');
});

test('the world carries the pool: one mesh, static, and only one of it', () => {
  const world = map();
  const lava = world.volcanicLava;
  assert.ok(lava, 'the map carries the lava pool');
  assert.ok(world.lavaPool === lava);
  assert.equal(lava.group.parent, world.group);
  assert.equal(lava.group.children.length, 1, 'the pool is one mesh, no props');
  assert.equal(lava.mesh.userData.surface, 'molten-lava');
  assert.equal(lava.mesh.userData.sectorId, 'HEX_SE');

  // It stands in the sector's own group, at the sector's own centre, on the
  // terrain that carries it.
  const sector = world.getSector('HEX_SE');
  assert.deepEqual(
    lava.group.position.toArray(),
    [sector.center.x, MAP_CONFIG.floorHeight, sector.center.z],
  );

  // Inert on purpose: no clock, no particles, no light, no second pool, and
  // nothing anywhere in the world with a lava-shaped update loop.
  assert.equal(lava.update, undefined);
  assert.equal(lava.group.userData.animates, false);
  assert.equal(lava.group.userData.particles, 0);
  assert.equal(lava.group.userData.lights, 0);
  assert.equal(lava.group.userData.meshes, 1);
  assert.equal(world.volcanicTerrain.geometry.userData.lavaPool, lava.group.userData.poolId);
  for (const child of world.group.children) {
    assert.ok(!/LavaPool/.test(child.name) || child === lava.group, `a second lava group: ${child.name}`);
  }

  // The mesh the eye sees sits on the terrain the feet use: a raycast down
  // through the lava hits the sheet, and the collision surface under it agrees
  // with the bed, not with the old crater floor.
  const terrain = world.volcanicTerrain;
  const pool = terrain.lavaPool;
  lava.group.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3(
    sector.center.x + pool.x,
    MAP_CONFIG.floorHeight + pool.level + 40,
    sector.center.z + pool.z,
  );
  raycaster.set(origin, new THREE.Vector3(0, -1, 0));
  const hit = raycaster.intersectObject(lava.mesh, false)[0];
  assert.ok(hit, 'the lava sheet is where the pool says it is');
  assert.ok(Math.abs(hit.point.y - (pool.level + pool.lift)) < 0.02, `the sheet is at ${hit.point.y}`);
  const floor = world.getFloorHeightAt(origin.x, origin.z);
  assert.ok(floor < pool.level, 'the ground under the sheet is under the lava');
  assert.ok(pool.level - floor > 0.3, `the lava is only ${(pool.level - floor).toFixed(2)} deep here`);
});

test('the pool is seeded and switchable like the rest of the volcanic field', () => {
  const a = makeTerrain();
  const b = makeTerrain();
  assert.equal(a.lavaPool.level, b.lavaPool.level);
  for (let v = 0; v < a.vertexCount; v += 1) {
    assert.equal(a.heights[v], b.heights[v], `height mismatch at vertex ${v}`);
  }

  // A different seed builds a different pool in a different crater floor.
  const other = makeTerrain({ ...MAP_CONFIG, volcanicTerrainSeed: MAP_CONFIG.volcanicTerrainSeed + 7 });
  assert.notEqual(other.lavaPool.level, a.lavaPool.level, 'a new seed must move the floor the pool fills');

  // The switchboard: `lavaPoolEnabled: false` removes the pool and leaves no
  // trace of it in the terrain.
  const off = makeTerrain({ ...MAP_CONFIG, lavaPoolEnabled: false });
  assert.equal(off.lavaPool, null);
  assert.equal(off.lavaPoolReport, null);
  assert.equal(off.geometry.userData.lavaPool, null);
  assert.equal(off.geometry.userData.lavaLevel, null);
  assert.equal(buildLavaPool(off, off.lavaPool, MAP_CONFIG), null);
  assert.equal(carveLavaPool(off, off.lavaPool), null);
  for (let v = 0; v < off.vertexCount; v += 1) {
    assert.equal(off.heights[v], PLAIN.heights[v], 'no lava, no bed');
  }

  // `lavaPool: false` does the same, and a config without the block at all
  // still gets the default pool.
  assert.equal(makeTerrain({ ...MAP_CONFIG, lavaPool: false }).lavaPool, null);
  const defaults = planLavaPool({}, { amplitude: AMPLITUDE, floorLevel: -3 });
  assert.equal(defaults.id, 'lava-pool-hex-se');
  assert.ok(Math.abs(defaults.level - (-3 + (MAP_CONFIG.lavaPool.basin ?? 0.155) * AMPLITUDE)) < 1e-9);
  assert.equal(planLavaPool({ lavaPool: null }), null);
});
