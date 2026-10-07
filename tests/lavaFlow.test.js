import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { VolcanicTerrain } from '../src/world/VolcanicTerrain.js';
import { HexMap } from '../src/world/HexMap.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
import { buildLavaPool } from '../src/world/LavaPool.js';
import {
  buildLavaFlow,
  buildLavaSecondaryFlow,
  carveLavaFlow,
  lavaFlowSampleAt,
  lavaFlowShadeAt,
  planLavaFlow,
  planLavaSecondaryFlow,
} from '../src/world/LavaFlow.js';
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
const MAIN_ONLY = makeTerrain({ ...MAP_CONFIG, lavaSecondaryFlowEnabled: false });
const TERRAIN = makeTerrain();
const FLOW = TERRAIN.lavaFlow;
const BUILT = buildLavaFlow(TERRAIN, FLOW, MAP_CONFIG);
const SECONDARY = TERRAIN.lavaSecondaryFlow;
const BUILT_SECONDARY = buildLavaSecondaryFlow(TERRAIN, SECONDARY, MAP_CONFIG);
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

test('one narrow secondary channel branches from the main flow into the southern low pocket', () => {
  assert.ok(SECONDARY, 'HEX_SE has one secondary channel');
  assert.equal(SECONDARY.id, 'lava-secondary-flow-hex-se');
  assert.equal(SECONDARY.parentFlowId, FLOW.id, 'the branch comes from the existing channel');
  assert.equal(SECONDARY.parentFlow, FLOW);
  assert.equal(SECONDARY.pool, FLOW.pool, 'it reuses the original pool as its upstream source');
  assert.equal(TERRAIN.geometry.userData.lavaSecondaryFlow, SECONDARY.id);
  assert.ok(!Array.isArray(SECONDARY), 'there is one branch, not a network');
  assert.ok(SECONDARY.width < FLOW.width * 0.5, 'the branch is clearly narrower than the main flow');
  assert.ok(SECONDARY.length > 120 && SECONDARY.length < 160);
  assert.ok(BUILT_SECONDARY.area < BUILT.area * 0.5, 'the smaller branch covers less than half the main channel area');

  const attachment = lavaFlowSampleAt(SECONDARY.attachment.x, SECONDARY.attachment.z, FLOW);
  assert.ok(attachment && attachment.distance < attachment.halfWidth, 'the branch begins within the main channel edge');
  const first = SECONDARY.samples[0];
  const last = SECONDARY.samples.at(-1);
  assert.ok(Math.abs(first.x - SECONDARY.attachment.x) < 1e-8);
  assert.ok(Math.abs(first.z - SECONDARY.attachment.z) < 1e-8);
  assert.ok(last.y < first.y - 7, 'the side-channel follows a natural downhill grade');
  for (let i = 1; i < SECONDARY.samples.length; i += 1) {
    assert.ok(SECONDARY.samples[i].y <= SECONDARY.samples[i - 1].y + 1e-8, `branch climbs at sample ${i}`);
  }

  const southernPit = TERRAIN.layout.pits.find((pit) => pit.x === -20 && pit.z === -90);
  assert.ok(southernPit, 'the branch targets the existing southern depression');
  assert.ok(Math.hypot(last.x - southernPit.x, last.z - southernPit.z) < southernPit.radius);
  assert.ok(Math.hypot(last.x - TERRAIN.layout.basin.x, last.z - TERRAIN.layout.basin.z) > TERRAIN.layout.basin.radius);
  assert.ok(MAIN_ONLY.heightAt(last.x, last.z) < first.y - 5, 'the branch reaches a different pre-existing low area');

  const widths = SECONDARY.samples
    .filter((point) => point.s > SECONDARY.sourceTaper + 2 && point.s < SECONDARY.length - SECONDARY.toeLength)
    .map((point) => point.left + point.right);
  assert.ok(Math.max(...widths) / Math.min(...widths) > 1.6, 'the side-channel pinches and widens');
  assert.ok(Math.max(...widths) < 4, 'its irregular banks remain smaller than the main channel');
  assert.ok(BUILT_SECONDARY.group.name === 'LavaSecondaryFlow_HEX_SE');
  assert.equal(BUILT_SECONDARY.group.children.length, 1, 'one static lava sheet, no added props');
  assert.equal(BUILT_SECONDARY.material, BUILT.material, 'both flows share the existing lava material');
});

test('the secondary sheet has cooled edges and stays seated in its own carved bed', () => {
  const positions = BUILT_SECONDARY.geometry.getAttribute('position');
  const colors = BUILT_SECONDARY.geometry.getAttribute('color');
  const indices = BUILT_SECONDARY.geometry.index;
  const rowSize = SECONDARY.crossSegments + 1;
  let edgeLuminance = 0;
  let centreLuminance = 0;
  let edgeSamples = 0;
  for (let r = 12; r < Math.min(40, SECONDARY.samples.length - 1); r += 1) {
    const edge = r * rowSize;
    const centre = edge + Math.floor(SECONDARY.crossSegments / 2);
    edgeLuminance += colors.getX(edge) + colors.getY(edge) + colors.getZ(edge);
    centreLuminance += colors.getX(centre) + colors.getY(centre) + colors.getZ(centre);
    edgeSamples += 1;
  }
  assert.ok(edgeLuminance / edgeSamples < centreLuminance / edgeSamples * 0.45,
    'the branch has dark, cooled margins around its molten centre');

  for (let v = 0; v < positions.count; v += 1) {
    const x = positions.getX(v);
    const z = positions.getZ(v);
    const depth = positions.getY(v) - TERRAIN.heightAt(x, z);
    assert.ok(depth > 0.025 && depth < 1.5, `secondary vertex ${v} is not seated in its bed`);
    if (v % rowSize === 0 || v % rowSize === rowSize - 1) {
      assert.ok(Math.abs(depth - SECONDARY.lift) < 2e-5, 'the cooled edge meets the terrain');
    }
  }
  for (let t = 0; t < indices.count; t += 3) {
    const vertices = [indices.getX(t), indices.getX(t + 1), indices.getX(t + 2)];
    const [a, b, c] = vertices.map((v) => new THREE.Vector3().fromBufferAttribute(positions, v));
    assert.ok(b.clone().sub(a).cross(c.clone().sub(a)).y > 1e-8, `secondary triangle ${t / 3} faces down`);
  }
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

test('both channels leave almost all of HEX_SE exposed, and neither reaches a portal', () => {
  const pool = buildLavaPool(TERRAIN, TERRAIN.lavaPool, MAP_CONFIG);
  const sectorArea = 3 * Math.sqrt(3) / 2 * RADIUS * RADIUS;
  assert.ok(BUILT.area > 500 && BUILT.area < 1200, 'the main channel remains the larger flow');
  assert.ok(BUILT_SECONDARY.area < BUILT.area * 0.5, 'the secondary remains visibly smaller');
  assert.ok((BUILT.area + BUILT_SECONDARY.area + pool.area) / sectorArea < 0.015,
    'over 98.5% of the sector stays normal terrain');
  for (const built of [BUILT, BUILT_SECONDARY]) {
    const positions = built.geometry.getAttribute('position');
    for (let v = 0; v < positions.count; v += 1) {
      const x = positions.getX(v);
      const z = positions.getZ(v);
      assert.ok(distanceToHexEdge(x, z, RADIUS) > 60, 'lava stays well within HEX_SE');
      for (const gate of gateAprons) {
        assert.ok(Math.hypot(x - gate.x, z - gate.z) > MAP_CONFIG.volcanicGateApronOuter + 20);
      }
    }
  }
});

test('the main spillway cuts only its own walkable banks; the vents and boundaries stay unchanged', () => {
  let changed = 0;
  let largest = 0;
  for (let v = 0; v < MAIN_ONLY.vertexCount; v += 1) {
    const cut = BEFORE.heights[v] - MAIN_ONLY.heights[v];
    if (cut === 0) continue;
    const x = MAIN_ONLY.positions[v * 3];
    const z = MAIN_ONLY.positions[v * 3 + 2];
    changed += 1;
    largest = Math.max(largest, cut);
    assert.ok(cut > 0, 'no new rocks or raised terrain');
    assert.equal(MAIN_ONLY.isRim[v], 0, 'the shared hex rim is untouched');
    const nearby = lavaFlowSampleAt(x, z, FLOW);
    assert.ok(nearby && nearby.distance < 46, `cut outside the main spillway at (${x}, ${z})`);
    for (const gate of gateAprons) assert.ok(Math.hypot(x - gate.x, z - gate.z) > MAP_CONFIG.volcanicGateApronOuter);
    for (const vent of MAIN_ONLY.vents) assert.ok(Math.hypot(x - vent.x, z - vent.z) > vent.support, `${vent.id} moved`);
  }
  assert.ok(changed > 100 && changed / MAIN_ONLY.vertexCount < 0.035, 'over 96.5% of the ground is bit-for-bit unchanged');
  assert.equal(MAIN_ONLY.lavaFlowReport.vertices, changed);
  assert.equal(MAIN_ONLY.lavaFlowReport.deepestCut, largest);
  assert.deepEqual(MAIN_ONLY.geometry.userData.heightRange, BEFORE.geometry.userData.heightRange);
  assert.deepEqual(MAIN_ONLY.vents, BEFORE.vents);

  // Check every actual triangle, not the smoothed vertex normals.
  const positions = MAIN_ONLY.geometry.getAttribute('position');
  const indices = MAIN_ONLY.geometry.index;
  const limit = Math.tan(THREE.MathUtils.degToRad(MAP_CONFIG.volcanicTerrainMaxSlopeDeg));
  for (let t = 0; t < indices.count; t += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(t));
    const b = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(t + 1));
    const c = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(t + 2));
    const normal = b.sub(a).cross(c.sub(a));
    assert.ok(Math.hypot(normal.x, normal.z) / normal.y <= limit + 2e-6, `unwalkable main bank at face ${t / 3}`);
  }
  const far = lavaFlowShadeAt(140, -110, MAIN_ONLY.heightAt(140, -110), FLOW);
  assert.deepEqual(far, { crust: 0, ember: 0 }, 'main-flow shading cannot stain the rest of the sector');
});

test('the one secondary cut stays narrow, downhill, and clear of vents, gates and the rim', () => {
  let changed = 0;
  let largest = 0;
  let farthestFromSpine = 0;
  for (let v = 0; v < TERRAIN.vertexCount; v += 1) {
    const cut = MAIN_ONLY.heights[v] - TERRAIN.heights[v];
    if (cut === 0) continue;
    const x = TERRAIN.positions[v * 3];
    const z = TERRAIN.positions[v * 3 + 2];
    changed += 1;
    largest = Math.max(largest, cut);
    assert.ok(cut > 0, 'the secondary channel only cuts down into basalt');
    assert.equal(TERRAIN.isRim[v], 0, 'the shared hex rim is untouched');
    const nearby = lavaFlowSampleAt(x, z, SECONDARY);
    assert.ok(nearby && nearby.distance < 42, `cut escaped the branch at (${x}, ${z})`);
    farthestFromSpine = Math.max(farthestFromSpine, nearby.distance);
    for (const gate of gateAprons) {
      assert.ok(Math.hypot(x - gate.x, z - gate.z) > MAP_CONFIG.volcanicGateApronOuter);
    }
    for (const vent of TERRAIN.vents) {
      assert.ok(Math.hypot(x - vent.x, z - vent.z) > vent.support, `${vent.id} moved`);
    }
  }
  assert.ok(changed > 250 && changed / TERRAIN.vertexCount < 0.04, 'the branch affects under four percent of the lattice');
  assert.ok(largest > 2 && largest < 7, 'only the small channel bed is lowered');
  assert.equal(TERRAIN.lavaSecondaryFlowReport.vertices, changed);
  assert.equal(TERRAIN.lavaSecondaryFlowReport.deepestCut, largest);
  assert.ok(farthestFromSpine < 42, 'the walkability corrections stay close to the branch');
  assert.deepEqual(TERRAIN.vents, MAIN_ONLY.vents);
  assert.deepEqual(TERRAIN.geometry.userData.heightRange, MAIN_ONLY.geometry.userData.heightRange);

  const far = lavaFlowShadeAt(140, -110, TERRAIN.heightAt(140, -110), SECONDARY);
  assert.deepEqual(far, { crust: 0, ember: 0 }, 'branch shading cannot stain the rest of the sector');
});

test('the world adds exactly one static side branch, without smoke, rocks, damage or lava updates', () => {
  const map = world();
  const off = new HexMap(new THREE.Scene(), { ...MAP_CONFIG, lavaFlowEnabled: false });
  assert.equal(map.group.children.length, off.group.children.length + 2, 'one main mesh and one secondary mesh');
  assert.equal(map.lavaFlow.group.parent, map.group);
  assert.equal(map.lavaSecondaryFlow.group.parent, map.group);
  assert.equal(map.lavaFlow.group.children.length, 1);
  assert.equal(map.lavaSecondaryFlow.group.children.length, 1);
  assert.equal(map.lavaFlow.mesh.userData.sectorId, 'HEX_SE');
  assert.equal(map.lavaSecondaryFlow.mesh.userData.sectorId, 'HEX_SE');
  assert.equal(map.lavaSecondaryFlow.mesh.userData.parentFlowId, map.lavaFlow.flow.id);
  assert.equal(map.lavaPool.material, map.lavaFlow.material);
  assert.equal(map.lavaFlow.material, map.lavaSecondaryFlow.material);
  const placement = [sector.center.x, MAP_CONFIG.floorHeight, sector.center.z];
  assert.deepEqual(map.lavaFlow.group.position.toArray(), placement);
  assert.deepEqual(map.lavaSecondaryFlow.group.position.toArray(), placement);
  const lavaMeshes = [];
  map.group.traverse((object) => {
    if (object.isMesh && object.userData.surface === 'molten-lava') lavaMeshes.push(object);
  });
  assert.deepEqual(new Set(lavaMeshes), new Set([
    map.lavaPool.mesh, map.lavaFlow.mesh, map.lavaSecondaryFlow.mesh,
  ]), 'one old pool, the original flow, and exactly one smaller branch');
  for (const feature of [map.lavaFlow, map.lavaSecondaryFlow]) {
    assert.equal(feature.update, undefined);
    assert.equal(feature.group.userData.animates, false);
    assert.equal(feature.group.userData.particles, 0);
    assert.equal(feature.group.userData.lights, 0);
    assert.equal(feature.material.userData.lava.animates, false);
    for (const object of [feature, feature.flow, feature.mesh.userData]) {
      for (const key of ['damage', 'trigger', 'collision', 'update']) assert.equal(object[key], undefined);
    }
  }
  const boxes = (world) => world.collisionBoxes.map(({ door, ...box }) => box);
  assert.deepEqual(boxes(map), boxes(off), 'no new obstacles or hazard zones');
  for (const [id, floor] of map.sectorMeshes) {
    if (id === 'HEX_SE') continue;
    assert.deepEqual(floor.geometry.attributes.position.array, off.sectorMeshes.get(id).geometry.attributes.position.array, `${id} geometry changed`);
    assert.equal(floor.material.color.getHex(), off.sectorMeshes.get(id).material.color.getHex(), `${id} material changed`);
  }
  const meshes = [map.lavaFlow, map.lavaSecondaryFlow];
  const before = meshes.map(({ geometry }) => [
    geometry.attributes.position.array.slice(), geometry.attributes.color.array.slice(),
  ]);
  map.update(1, new THREE.Vector3(sector.center.x, 0, sector.center.z));
  meshes.forEach(({ geometry }, i) => {
    assert.deepEqual(geometry.attributes.position.array, before[i][0]);
    assert.deepEqual(geometry.attributes.color.array, before[i][1]);
  });
  map.setDebugVisible(true);
  assert.equal(map.lavaFlow.group.visible, true, 'the main flow is visible in the overview');
  assert.equal(map.lavaSecondaryFlow.group.visible, true, 'the branch is visible in the overview');
  map.setDebugVisible(false);
});

test('the explorer stands on the same carved ground the lava follows', () => {
  const map = world();
  const ray = new THREE.Raycaster();
  map.volcanicTerrainMesh.updateMatrixWorld(true);
  for (const flow of [map.volcanicTerrain.lavaFlow, map.volcanicTerrain.lavaSecondaryFlow]) {
    for (const p of flow.samples.filter((_, i) => i % 5 === 0)) {
      const x = sector.center.x + p.x;
      const z = sector.center.z + p.z;
      ray.set(new THREE.Vector3(x, 40, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(map.volcanicTerrainMesh, false)[0];
      assert.ok(hit);
      assert.ok(Math.abs(hit.point.y - map.getFloorHeightAt(x, z)) < 1e-5, 'collision is the carved mesh');
    }
  }
});

test('both flows are deterministic; the branch switches independently and needs its parent pool', () => {
  const repeat = makeTerrain();
  assert.deepEqual(repeat.heights, TERRAIN.heights);
  assert.deepEqual(buildLavaFlow(repeat, repeat.lavaFlow, MAP_CONFIG).geometry.attributes.position.array,
    BUILT.geometry.attributes.position.array);
  assert.deepEqual(buildLavaSecondaryFlow(repeat, repeat.lavaSecondaryFlow, MAP_CONFIG).geometry.attributes.position.array,
    BUILT_SECONDARY.geometry.attributes.position.array);

  for (const override of [{ lavaFlowEnabled: false }, { lavaFlow: false }, { lavaFlow: null }]) {
    const off = makeTerrain({ ...MAP_CONFIG, ...override });
    assert.equal(off.lavaFlow, null);
    assert.equal(off.lavaFlowReport, null);
    assert.equal(off.lavaSecondaryFlow, null);
    assert.equal(off.lavaSecondaryFlowReport, null);
    assert.equal(off.geometry.userData.lavaFlow, null);
    assert.equal(off.geometry.userData.lavaSecondaryFlow, null);
    assert.deepEqual(off.heights, BEFORE.heights, 'disabling the parent restores the original pool/ground');
    assert.equal(buildLavaFlow(off, off.lavaFlow, MAP_CONFIG), null);
    assert.equal(buildLavaSecondaryFlow(off, off.lavaSecondaryFlow, MAP_CONFIG), null);
    assert.equal(carveLavaFlow(off, off.lavaFlow), null);
    assert.equal(planLavaSecondaryFlow(off, off.lavaFlow, MAP_CONFIG), null);
  }
  for (const override of [
    { lavaSecondaryFlowEnabled: false },
    { lavaSecondaryFlow: false },
    { lavaSecondaryFlow: null },
  ]) {
    const mainOnly = makeTerrain({ ...MAP_CONFIG, ...override });
    assert.ok(mainOnly.lavaFlow, 'the original outlet remains');
    assert.equal(mainOnly.lavaSecondaryFlow, null);
    assert.equal(mainOnly.lavaSecondaryFlowReport, null);
    assert.equal(mainOnly.geometry.userData.lavaSecondaryFlow, null);
    assert.deepEqual(mainOnly.heights, MAIN_ONLY.heights, 'the original terrain and main flow stay unchanged');
    assert.equal(buildLavaSecondaryFlow(mainOnly, mainOnly.lavaSecondaryFlow, MAP_CONFIG), null);
  }
  for (const override of [{ lavaPoolEnabled: false }, { lavaPool: false }, { lavaPool: null }]) {
    const off = makeTerrain({ ...MAP_CONFIG, ...override });
    assert.equal(off.lavaPool, null);
    assert.equal(off.lavaFlow, null);
    assert.equal(off.lavaFlowReport, null);
    assert.equal(off.lavaSecondaryFlow, null);
    assert.equal(off.lavaSecondaryFlowReport, null);
  }
  assert.equal(planLavaFlow({ ...BEFORE, sectorId: 'HEX_S' }, BEFORE.lavaPool, MAP_CONFIG), null);
  assert.equal(planLavaFlow(BEFORE, null, MAP_CONFIG), null);
  assert.equal(planLavaSecondaryFlow({ ...MAIN_ONLY, sectorId: 'HEX_S' }, FLOW, MAP_CONFIG), null);
  assert.equal(planLavaSecondaryFlow(MAIN_ONLY, null, MAP_CONFIG), null);
});
