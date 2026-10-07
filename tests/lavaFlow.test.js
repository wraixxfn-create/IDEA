import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { VolcanicTerrain } from '../src/world/VolcanicTerrain.js';
import { HexMap } from '../src/world/HexMap.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
import { buildLavaPool } from '../src/world/LavaPool.js';
import { buildLavaFlow, carveLavaFlow, lavaFlowSampleAt, lavaFlowShadeAt, planLavaFlow } from '../src/world/LavaFlow.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const RADIUS = MAP_CONFIG.hexRadius;
const data = buildHexMapData(RADIUS);
const sector = data.byId.get('HEX_SE');
const gateAprons = data.sharedEdges
  .filter((gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE')
  .map((gate) => ({ x: gate.center.x - sector.center.x, z: gate.center.z - sector.center.z }));
const makeTerrain = (config = MAP_CONFIG) => new VolcanicTerrain({ radius: RADIUS, config, gateAprons });
const BEFORE = makeTerrain({ ...MAP_CONFIG, lavaFlowEnabled: false });
const TERRAIN = makeTerrain();
const FLOW = TERRAIN.lavaFlow;
const BUILT = buildLavaFlow(TERRAIN, FLOW, MAP_CONFIG);
let sharedWorld;
const world = () => (sharedWorld ??= new HexMap(new THREE.Scene(), MAP_CONFIG));

test('one major lava flow starts inside the existing pool and reaches the lower basin', () => {
  assert.ok(FLOW);
  assert.equal(FLOW.id, 'lava-flow-hex-se');
  assert.equal(TERRAIN.geometry.userData.lavaFlow, FLOW.id);
  assert.ok(!Array.isArray(FLOW), 'one flow, not a river scatter');
  assert.equal(FLOW.pool, TERRAIN.lavaPool, 'the source is the existing pool');
  const first = FLOW.samples[0];
  const last = FLOW.samples.at(-1);
  assert.ok(Math.hypot(first.x - FLOW.pool.x, first.z - FLOW.pool.z) < FLOW.sourceShoreline.min - 3);
  assert.ok(FLOW.length > 80 && FLOW.length < 140, 'a major channel, not a tiny puddle or a sector-wide river');
  assert.ok(last.y < first.y - 8, 'the destination is meaningfully downhill');
  assert.ok(BEFORE.heightAt(last.x, last.z) < FLOW.pool.level - 8, 'the lower terrain existed before the flow');
  const basin = TERRAIN.layout.basin;
  assert.ok(Math.hypot(last.x - basin.x, last.z - basin.z) < basin.radius, 'the toe reaches the near side of the basin');
  for (let i = 1; i < FLOW.samples.length; i += 1) {
    assert.ok(FLOW.samples[i].y <= FLOW.samples[i - 1].y + 1e-8, `uphill at sample ${i}`);
  }
  // The actual centre vertices, not just the planned profile, also descend.
  const positions = BUILT.geometry.getAttribute('position');
  const rowSize = FLOW.crossSegments + 1;
  let previous = Infinity;
  for (let v = FLOW.crossSegments / 2; v < positions.count - 1; v += rowSize) {
    assert.ok(positions.getY(v) <= previous + 1e-6, `uphill mesh at vertex ${v}`);
    previous = positions.getY(v);
  }
  assert.ok(positions.getY(positions.count - 1) <= previous);
});

test('the channel winds, pinches and widens, with independent irregular banks', () => {
  const first = FLOW.samples[0];
  const last = FLOW.samples.at(-1);
  const dx = last.x - first.x;
  const dz = last.z - first.z;
  const chord = Math.hypot(dx, dz);
  const offsets = FLOW.samples.map((p) => ((p.x - first.x) * dz - (p.z - first.z) * dx) / chord);
  assert.ok(FLOW.length / chord > 1.08, 'the course is not a straight line');
  assert.ok(Math.max(...offsets) - Math.min(...offsets) > 8, 'the course bends across its chord');
  // Ignore the submerged head and terminal taper; the middle itself varies.
  const middle = FLOW.samples.filter((p) => p.s > FLOW.outletDistance + 2 && p.s < FLOW.length - 10);
  const widths = middle.map((p) => p.left + p.right);
  assert.ok(Math.max(...widths) / Math.min(...widths) > 1.6, 'the main channel has distinct narrows and broader reaches');
  assert.ok(Math.max(...widths) < 14, 'the expansions remain a channel, not additional pools');
  assert.ok(middle.some((p) => Math.abs(p.left - p.right) > 0.45), 'the banks are not mirrored');
  let contractions = 0;
  let expansions = 0;
  for (let i = 1; i < widths.length; i += 1) {
    if (widths[i] < widths[i - 1] - 0.025) contractions += 1;
    if (widths[i] > widths[i - 1] + 0.025) expansions += 1;
  }
  assert.ok(contractions > 15 && expansions > 15, 'width changes along the run, not only at its ends');
  assert.equal(last.left + last.right, 0, 'one rounded toe closes the flow');
});

test('the single lava surface is connected, upward-facing and seated in its bed', () => {
  const positions = BUILT.geometry.getAttribute('position');
  const indices = BUILT.geometry.index;
  const adjacency = Array.from({ length: positions.count }, () => []);
  let deepest = 0;
  for (let v = 0; v < positions.count; v += 1) {
    const x = positions.getX(v);
    const z = positions.getZ(v);
    const depth = positions.getY(v) - TERRAIN.heightAt(x, z);
    assert.ok(Number.isFinite(depth));
    assert.ok(depth > 0.025 && depth < 1.5, `vertex ${v}: ${depth} above the bed`);
    deepest = Math.max(deepest, depth);
    if (v % (FLOW.crossSegments + 1) === 0 || v % (FLOW.crossSegments + 1) === FLOW.crossSegments) {
      assert.ok(Math.abs(depth - FLOW.lift) < 2e-5, 'the cooled bank meets the ground, not the air');
    }
  }
  assert.ok(deepest > 0.35, 'molten material has depth, not a decal on top of the ground');

  for (let t = 0; t < indices.count; t += 3) {
    const vertices = [indices.getX(t), indices.getX(t + 1), indices.getX(t + 2)];
    const [a, b, c] = vertices.map((v) => new THREE.Vector3().fromBufferAttribute(positions, v));
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    assert.ok(normal.y > 1e-8, `inverted or degenerate triangle ${t / 3}`);
    // Inspect interiors and edge midpoints too: neither a coarse ground face
    // nor a bend in the strip can puncture the finer molten sheet.
    for (const weights of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
      const x = a.x * weights[0] + b.x * weights[1] + c.x * weights[2];
      const z = a.z * weights[0] + b.z * weights[1] + c.z * weights[2];
      const y = a.y * weights[0] + b.y * weights[1] + c.y * weights[2];
      assert.ok(y - TERRAIN.heightAt(x, z) > 0.005, `ground through triangle ${t / 3}`);
    }
    for (let e = 0; e < 3; e += 1) {
      adjacency[vertices[e]].push(vertices[(e + 1) % 3], vertices[(e + 2) % 3]);
    }
  }
  const visited = new Set([0]);
  const queue = [0];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const v of adjacency[queue[cursor]]) {
      if (visited.has(v)) continue;
      visited.add(v);
      queue.push(v);
    }
  }
  assert.equal(visited.size, positions.count, 'no disconnected lava patches');
  assert.ok(BUILT.triangleCount < 5000, 'one lightweight static mesh');
});

test('the old pool keeps its footprint and level, with an overlapping molten outlet', () => {
  const oldPool = buildLavaPool(BEFORE, BEFORE.lavaPool, MAP_CONFIG);
  const pool = buildLavaPool(TERRAIN, TERRAIN.lavaPool, MAP_CONFIG);
  assert.equal(pool.level, oldPool.level);
  assert.equal(pool.area, oldPool.area, 'the pool does not flood the new descending channel');
  assert.deepEqual(pool.geometry.attributes.position.array, oldPool.geometry.attributes.position.array);
  assert.deepEqual(pool.shoreline.radii, oldPool.shoreline.radii);
  assert.equal(pool.material, BUILT.material, 'one shared material and crust texture');
  // The entire submerged overlap lies below the plane: two interpenetrating
  // near-coplanar skins would z-fight where the river meets the lake.
  const positions = BUILT.geometry.getAttribute('position');
  for (let v = 0; v < positions.count; v += 1) {
    assert.ok(positions.getY(v) <= pool.level + FLOW.pool.lift - 0.03);
  }
  // A vertical ray sees lava continuously from the lake through its mouth.
  pool.group.updateMatrixWorld(true);
  BUILT.group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  for (let i = 0; i < FLOW.samples.length - 1; i += 1) {
    const p = FLOW.samples[i];
    ray.set(new THREE.Vector3(p.x, 30, p.z), down);
    const hits = ray.intersectObjects([pool.mesh, BUILT.mesh]);
    assert.ok(hits.length, `gap in the molten connection at sample ${i}`);
    assert.ok(hits[0].point.y > TERRAIN.heightAt(p.x, p.z), 'the connected surface is above the ground');
  }
});

test('lava leaves almost all of HEX_SE exposed, and nothing reaches a portal', () => {
  const pool = buildLavaPool(TERRAIN, TERRAIN.lavaPool, MAP_CONFIG);
  const sectorArea = 3 * Math.sqrt(3) / 2 * RADIUS * RADIUS;
  assert.ok(BUILT.area > 500 && BUILT.area < 1200, 'one substantial but narrow flow');
  assert.ok((BUILT.area + pool.area) / sectorArea < 0.015, 'over 98.5% of the sector stays normal terrain');
  const positions = BUILT.geometry.getAttribute('position');
  for (let v = 0; v < positions.count; v += 1) {
    const x = positions.getX(v);
    const z = positions.getZ(v);
    assert.ok(distanceToHexEdge(x, z, RADIUS) > 60, 'lava stays well within HEX_SE');
    for (const gate of gateAprons) {
      assert.ok(Math.hypot(x - gate.x, z - gate.z) > MAP_CONFIG.volcanicGateApronOuter + 20);
    }
  }
});

test('only the spillway and its walkable banks are cut; the vents and boundaries stay unchanged', () => {
  let changed = 0;
  let largest = 0;
  for (let v = 0; v < TERRAIN.vertexCount; v += 1) {
    const cut = BEFORE.heights[v] - TERRAIN.heights[v];
    if (cut === 0) continue;
    const x = TERRAIN.positions[v * 3];
    const z = TERRAIN.positions[v * 3 + 2];
    changed += 1;
    largest = Math.max(largest, cut);
    assert.ok(cut > 0, 'no new rocks or raised terrain');
    assert.equal(TERRAIN.isRim[v], 0, 'the shared hex rim is untouched');
    const nearby = lavaFlowSampleAt(x, z, FLOW);
    assert.ok(nearby && nearby.distance < 46, `cut outside the spillway at (${x}, ${z})`);
    for (const gate of gateAprons) assert.ok(Math.hypot(x - gate.x, z - gate.z) > MAP_CONFIG.volcanicGateApronOuter);
    for (const vent of TERRAIN.vents) assert.ok(Math.hypot(x - vent.x, z - vent.z) > vent.support, `${vent.id} moved`);
  }
  assert.ok(changed > 100 && changed / TERRAIN.vertexCount < 0.035, 'over 96.5% of the ground is bit-for-bit unchanged');
  assert.equal(TERRAIN.lavaFlowReport.vertices, changed);
  assert.equal(TERRAIN.lavaFlowReport.deepestCut, largest);
  assert.deepEqual(TERRAIN.geometry.userData.heightRange, BEFORE.geometry.userData.heightRange);
  assert.deepEqual(TERRAIN.vents, BEFORE.vents);

  // Check every actual triangle, not the smoothed vertex normals.
  const positions = TERRAIN.geometry.getAttribute('position');
  const indices = TERRAIN.geometry.index;
  const limit = Math.tan(THREE.MathUtils.degToRad(MAP_CONFIG.volcanicTerrainMaxSlopeDeg));
  for (let t = 0; t < indices.count; t += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(t));
    const b = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(t + 1));
    const c = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(t + 2));
    const normal = b.sub(a).cross(c.sub(a));
    assert.ok(Math.hypot(normal.x, normal.z) / normal.y <= limit + 2e-6, `unwalkable bank at face ${t / 3}`);
  }
  const far = lavaFlowShadeAt(140, -110, TERRAIN.heightAt(140, -110), FLOW);
  assert.deepEqual(far, { crust: 0, ember: 0 }, 'bank shading cannot stain the rest of the sector');
});

test('the world adds only one static HEX_SE mesh, without smoke, rocks, damage or lava updates', () => {
  const map = world();
  const off = new HexMap(new THREE.Scene(), { ...MAP_CONFIG, lavaFlowEnabled: false });
  assert.equal(map.group.children.length, off.group.children.length + 1);
  assert.equal(map.lavaFlow.group.parent, map.group);
  assert.equal(map.lavaFlow.group.children.length, 1);
  assert.equal(map.lavaFlow.mesh.userData.sectorId, 'HEX_SE');
  assert.equal(map.lavaPool.material, map.lavaFlow.material);
  assert.deepEqual(map.lavaFlow.group.position.toArray(), [sector.center.x, MAP_CONFIG.floorHeight, sector.center.z]);
  const lavaMeshes = [];
  map.group.traverse((object) => {
    if (object.isMesh && object.userData.surface === 'molten-lava') lavaMeshes.push(object);
  });
  assert.deepEqual(new Set(lavaMeshes), new Set([map.lavaPool.mesh, map.lavaFlow.mesh]), 'only the old pool and the single flow');
  assert.equal(map.lavaFlow.update, undefined);
  assert.equal(map.lavaFlow.group.userData.animates, false);
  assert.equal(map.lavaFlow.group.userData.particles, 0);
  assert.equal(map.lavaFlow.group.userData.lights, 0);
  assert.equal(map.lavaFlow.material.userData.lava.animates, false);
  for (const object of [map.lavaFlow, map.lavaFlow.flow, map.lavaFlow.mesh.userData]) {
    for (const key of ['damage', 'trigger', 'collision', 'update']) assert.equal(object[key], undefined);
  }
  const boxes = (world) => world.collisionBoxes.map(({ door, ...box }) => box);
  assert.deepEqual(boxes(map), boxes(off), 'no new obstacles or hazard zones');
  for (const [id, floor] of map.sectorMeshes) {
    if (id === 'HEX_SE') continue;
    assert.deepEqual(floor.geometry.attributes.position.array, off.sectorMeshes.get(id).geometry.attributes.position.array, `${id} geometry changed`);
    assert.equal(floor.material.color.getHex(), off.sectorMeshes.get(id).material.color.getHex(), `${id} material changed`);
  }
  const position = map.lavaFlow.geometry.attributes.position.array.slice();
  const color = map.lavaFlow.geometry.attributes.color.array.slice();
  map.update(1, new THREE.Vector3(sector.center.x, 0, sector.center.z));
  assert.deepEqual(map.lavaFlow.geometry.attributes.position.array, position);
  assert.deepEqual(map.lavaFlow.geometry.attributes.color.array, color);
  map.setDebugVisible(true);
  assert.equal(map.lavaFlow.group.visible, true, 'the flow is visible in the overview');
  map.setDebugVisible(false);
});

test('the explorer stands on the same carved ground the lava follows', () => {
  const map = world();
  const ray = new THREE.Raycaster();
  map.volcanicTerrainMesh.updateMatrixWorld(true);
  for (const p of map.volcanicTerrain.lavaFlow.samples.filter((_, i) => i % 5 === 0)) {
    const x = sector.center.x + p.x;
    const z = sector.center.z + p.z;
    ray.set(new THREE.Vector3(x, 40, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(map.volcanicTerrainMesh, false)[0];
    assert.ok(hit);
    assert.ok(Math.abs(hit.point.y - map.getFloorHeightAt(x, z)) < 1e-5, 'collision is the carved mesh');
  }
});

test('the flow is deterministic, independently switchable, and cannot exist without its HEX_SE pool', () => {
  const repeat = makeTerrain();
  assert.deepEqual(repeat.heights, TERRAIN.heights);
  assert.deepEqual(buildLavaFlow(repeat, repeat.lavaFlow, MAP_CONFIG).geometry.attributes.position.array,
    BUILT.geometry.attributes.position.array);
  for (const override of [{ lavaFlowEnabled: false }, { lavaFlow: false }, { lavaFlow: null }]) {
    const off = makeTerrain({ ...MAP_CONFIG, ...override });
    assert.equal(off.lavaFlow, null);
    assert.equal(off.lavaFlowReport, null);
    assert.equal(off.geometry.userData.lavaFlow, null);
    assert.deepEqual(off.heights, BEFORE.heights, 'disabling the outlet restores only the original pool/ground');
    assert.equal(buildLavaFlow(off, off.lavaFlow, MAP_CONFIG), null);
    assert.equal(carveLavaFlow(off, off.lavaFlow), null);
  }
  for (const override of [{ lavaPoolEnabled: false }, { lavaPool: false }, { lavaPool: null }]) {
    const off = makeTerrain({ ...MAP_CONFIG, ...override });
    assert.equal(off.lavaPool, null);
    assert.equal(off.lavaFlow, null);
    assert.equal(off.lavaFlowReport, null);
  }
  assert.equal(planLavaFlow({ ...BEFORE, sectorId: 'HEX_S' }, BEFORE.lavaPool, MAP_CONFIG), null);
  assert.equal(planLavaFlow(BEFORE, null, MAP_CONFIG), null);
});
