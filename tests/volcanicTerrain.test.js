import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG, PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { VolcanicTerrain, DEFAULT_VOLCANIC_LAYOUT } from '../src/world/VolcanicTerrain.js';
import { buildHexMapData, isPointInsideHex } from '../src/world/hexGrid.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
import { installCanvasStub, installInputStub } from './domStub.js';
import { PlayerController } from '../src/player/PlayerController.js';

installCanvasStub();
installInputStub();

const RADIUS = MAP_CONFIG.hexRadius;
const APOTHEM = RADIUS * Math.sqrt(3) / 2;

/** The four portal centres of HEX_SE, in sector-local coordinates. */
function hexSeGateAprons() {
  const data = buildHexMapData(RADIUS);
  const sector = data.byId.get('HEX_SE');
  return data.sharedEdges
    .filter((gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE')
    .map((gate) => ({
      x: gate.center.x - sector.center.x,
      z: gate.center.z - sector.center.z,
    }));
}

function makeTerrain() {
  return new VolcanicTerrain({
    radius: RADIUS,
    config: MAP_CONFIG,
    sectorId: 'HEX_SE',
    gateAprons: hexSeGateAprons(),
  });
}

// One shared map for the whole file: a full HexMap also carries the forest,
// the rain and the birds, and rebuilding it per assertion is needlessly slow.
let sharedMap = null;
function map() {
  if (!sharedMap) sharedMap = new HexMap(new THREE.Scene(), MAP_CONFIG);
  return sharedMap;
}

/** Deterministic sample points well inside a sector-local hexagon. */
function* interiorPoints(count, margin = 2, seed = 0xabc123) {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  let produced = 0;
  while (produced < count) {
    const x = (random() * 2 - 1) * RADIUS;
    const z = (random() * 2 - 1) * RADIUS;
    if (distanceToHexEdge(x, z, RADIUS) < margin) continue;
    produced += 1;
    yield { x, z };
  }
}

test('the volcanic lattice stays inside HEX_SE, pins its rim flat and stays light', () => {
  const terrain = makeTerrain();
  const divisions = MAP_CONFIG.volcanicTerrainDivisions;
  assert.equal(terrain.vertexCount, 3 * divisions * divisions + 3 * divisions + 1);
  assert.equal(terrain.triangleCount, 6 * divisions * divisions);
  assert.equal(terrain.sectorId, 'HEX_SE');
  assert.equal(terrain.geometry.name, 'VolcanicTerrainGeometry_HEX_SE');
  assert.equal(terrain.geometry.userData.terrain, 'baked-hex-lattice-volcanic');
  assert.equal(terrain.geometry.userData.gateAprons, 4, 'one apron per HEX_SE portal');

  // Efficiency: the relief is tens of units across, so a coarse lattice is
  // plenty — keep it far below the forest's density budget.
  assert.ok(terrain.vertexCount < 20000, `${terrain.vertexCount} vertices is too dense`);
  assert.ok(terrain.triangleCount < 30000, `${terrain.triangleCount} faces is too dense`);

  // The rim is the exact hexagon, pinned to the shared floor height, and no
  // vertex ever leaves the sector.
  const epsilon = 1e-3;
  const positions = terrain.geometry.getAttribute('position');
  let rimVertices = 0;
  for (let v = 0; v < positions.count; v += 1) {
    const edge = distanceToHexEdge(positions.getX(v), positions.getZ(v), RADIUS);
    if (edge < epsilon) {
      rimVertices += 1;
      assert.ok(Math.abs(positions.getY(v)) < 1e-9, 'the rim stays at the shared floor height');
    }
    assert.ok(edge > -epsilon, 'no vertex leaves the hexagon');
  }
  assert.equal(rimVertices, 6 * divisions, 'the rim is a closed ring of lattice vertices');

  // The relief itself stays inside the configured amplitude.
  const [minHeight, maxHeight] = terrain.geometry.userData.heightRange;
  assert.ok(minHeight >= -MAP_CONFIG.volcanicTerrainAmplitude - 1e-3);
  assert.ok(maxHeight <= MAP_CONFIG.volcanicTerrainAmplitude + 1e-3);
});

test('the volcanic field is seeded: one number rebuilds the same landscape', () => {
  const a = makeTerrain();
  const b = makeTerrain();
  assert.equal(a.vertexCount, b.vertexCount);
  for (let v = 0; v < a.vertexCount; v += 1) {
    assert.equal(a.heights[v], b.heights[v], `height mismatch at vertex ${v}`);
  }
  // And a different seed really is a different landscape.
  const c = new VolcanicTerrain({
    radius: RADIUS,
    config: { ...MAP_CONFIG, volcanicTerrainSeed: MAP_CONFIG.volcanicTerrainSeed + 7 },
    gateAprons: hexSeGateAprons(),
  });
  let differs = 0;
  for (let v = 0; v < a.vertexCount; v += 1) {
    if (a.heights[v] !== c.heights[v]) differs += 1;
  }
  assert.ok(differs > a.vertexCount * 0.5, 'a new seed must reshape the ground');
});

test('the HEX_SE hitbox IS the HEX_SE mesh', () => {
  const world = map();
  const sector = world.getSector('HEX_SE');
  const mesh = world.volcanicTerrainMesh;
  assert.ok(mesh, 'HEX_SE carries its volcanic floor mesh');
  mesh.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  let worst = 0;
  let samples = 0;

  for (const point of interiorPoints(260)) {
    const x = sector.center.x + point.x;
    const z = sector.center.z + point.z;
    origin.set(x, MAP_CONFIG.floorHeight + 400, z);
    raycaster.set(origin, down);
    const hit = raycaster.intersectObject(mesh, false)[0];
    assert.ok(hit, 'the terrain mesh covers the whole sector');
    const collision = world.getFloorHeightAt(x, z);
    worst = Math.max(worst, Math.abs(hit.point.y - collision));
    samples += 1;
  }

  assert.ok(samples > 200);
  assert.ok(worst < 1e-3, `rendered ground and collision ground differ by ${worst}`);
});

test('every volcanic face stays walkable and the surface is continuous', () => {
  const terrain = map().volcanicTerrain;
  const limit = Math.tan(THREE.MathUtils.degToRad(MAP_CONFIG.volcanicTerrainMaxSlopeDeg));

  assert.ok(
    terrain.geometry.userData.maxSlopeDegrees
      <= MAP_CONFIG.volcanicTerrainMaxSlopeDeg + 1e-3,
    `steepest face is ${terrain.geometry.userData.maxSlopeDegrees} degrees`,
  );

  // Walk a straight line across the sector: consecutive samples may never
  // jump by more than the slope limit allows — no cliffs, no holes.
  const step = 0.25;
  const travelled = step * Math.hypot(1, 0.21);
  let previous = null;
  let checked = 0;
  for (let t = -RADIUS; t <= RADIUS; t += step) {
    const z = -RADIUS * 0.2 + t * 0.21;
    if (distanceToHexEdge(t, z, RADIUS) < 0) {
      previous = null;
      continue;
    }
    const height = terrain.heightAt(t, z);
    if (previous !== null) {
      assert.ok(
        Math.abs(height - previous) <= limit * travelled + 1e-6,
        `discontinuity at ${t}: ${previous} -> ${height}`,
      );
      checked += 1;
    }
    previous = height;
  }
  assert.ok(checked > 1000, 'the whole crossing was sampled');

  // Queries outside the hexagon clamp onto the flat rim instead of junk.
  assert.ok(Number.isFinite(terrain.heightAt(0, 0)));
  assert.ok(Math.abs(terrain.heightAt(RADIUS * 4, 0)) < 1e-6, 'outside reads as the flat rim');
});

test('the relief reads as a volcanic landscape, not as random hills', () => {
  const terrain = map().volcanicTerrain;
  const layout = DEFAULT_VOLCANIC_LAYOUT;
  const h = (x, z) => terrain.heightAt(x, z);
  const [minHeight, maxHeight] = terrain.geometry.userData.heightRange;

  // One major elevated region: the cone summit towers over the plains and
  // carries a shallow crater — its centre sits below its own rim.
  const summit = h(layout.cone.x, layout.cone.z);
  const craterRim = h(layout.cone.x + 24, layout.cone.z);
  assert.ok(summit > 6, `the massif only reaches ${summit}`);
  assert.ok(craterRim > summit, 'the summit is a saucer, not a spike');
  assert.ok(maxHeight >= 10, 'the elevated region dominates the sector');

  // One lower basin-like region: a bowl well below the surrounding plains,
  // with a floor that climbs back out on every side.
  const basinFloor = h(layout.basin.x, layout.basin.z);
  assert.ok(basinFloor < -6, `the basin only sinks to ${basinFloor}`);
  assert.ok(minHeight <= basinFloor + 0.5, 'the basin is the low point of the sector');
  let basinRing = 0;
  for (let k = 0; k < 12; k += 1) {
    const a = (k / 12) * Math.PI * 2;
    basinRing += h(
      layout.basin.x + Math.cos(a) * (layout.basin.radius + 30),
      layout.basin.z + Math.sin(a) * (layout.basin.radius + 30),
    );
  }
  basinRing /= 12;
  assert.ok(basinRing > basinFloor + 4, 'the plains ring the basin above its floor');

  // Elevated ridges: each fissure zone rises clear of the plains even away
  // from the massif (deterministic grid sampling over the ellipse).
  for (const [index, zone] of layout.ridges.entries()) {
    let ridgeMax = -Infinity;
    for (let i = -10; i <= 10; i += 1) {
      for (let j = -10; j <= 10; j += 1) {
        const u = (i / 10) * zone.radiusX;
        const v = (j / 10) * zone.radiusZ;
        const x = zone.x + u * Math.cos(zone.angle) - v * Math.sin(zone.angle);
        const z = zone.z + u * Math.sin(zone.angle) + v * Math.cos(zone.angle);
        if (distanceToHexEdge(x, z, RADIUS) < 30) continue;
        if (Math.hypot(x - layout.cone.x, z - layout.cone.z) < layout.cone.radius + 20) continue;
        ridgeMax = Math.max(ridgeMax, h(x, z));
      }
    }
    assert.ok(ridgeMax > 3.5, `ridge zone ${index} only reaches ${ridgeMax}`);
  }

  // Shallow depressions on the plains.
  for (const pit of layout.pits) {
    let ring = 0;
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2;
      ring += h(pit.x + Math.cos(a) * (pit.radius + 25), pit.z + Math.sin(a) * (pit.radius + 25));
    }
    ring /= 8;
    assert.ok(ring - h(pit.x, pit.z) > 0.9, `the pit at (${pit.x}, ${pit.z}) is not a depression`);
  }

  // Irregular rocky areas: each patch is visibly rougher than a plane.
  for (const [index, patch] of layout.rocks.entries()) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = -6; i <= 6; i += 1) {
      for (let j = -6; j <= 6; j += 1) {
        const a = (i / 6) * Math.PI;
        const r = ((j + 6) / 12) * patch.radius * 0.7;
        const value = h(patch.x + Math.cos(a) * r, patch.z + Math.sin(a) * r);
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    }
    assert.ok(hi - lo > 1.4, `rocky patch ${index} is flat (${hi - lo})`);
  }

  // Not uniformly mountainous: most of the sector stays comfortable ground.
  let gentle = 0;
  let nearLevel = 0;
  let total = 0;
  for (const point of interiorPoints(3000, 20, 0x77a11)) {
    total += 1;
    if (terrain.slopeAt(point.x, point.z) < Math.tan(THREE.MathUtils.degToRad(12))) gentle += 1;
    if (Math.abs(h(point.x, point.z)) < 3) nearLevel += 1;
  }
  assert.ok(gentle / total >= 0.6, `only ${((gentle / total) * 100).toFixed(1)}% walks at under 12°`);
  assert.ok(
    nearLevel / total >= 0.42,
    `only ${((nearLevel / total) * 100).toFixed(1)}% of the sector stays near the plain level`,
  );
});

test('the terrain keeps every gate approach level', () => {
  const terrain = map().volcanicTerrain;
  const limit = Math.tan(THREE.MathUtils.degToRad(12));
  assert.equal(terrain.gateAprons.length, 4);

  for (const apron of terrain.gateAprons) {
    // The apron disc and the corridor running inwards from the doorway must
    // be flat enough to stroll through, whatever the relief does beyond it.
    for (let k = 0; k < 24; k += 1) {
      const a = (k / 24) * Math.PI * 2;
      for (const r of [0, 8, 16, MAP_CONFIG.volcanicGateApronInner]) {
        const x = apron.x + Math.cos(a) * r;
        const z = apron.z + Math.sin(a) * r;
        if (distanceToHexEdge(x, z, RADIUS) < 0) continue;
        assert.ok(
          Math.abs(terrain.heightAt(x, z)) < 0.35,
          `the approach at (${x.toFixed(1)}, ${z.toFixed(1)}) is not level`,
        );
      }
    }
    const inwardX = -apron.x;
    const inwardZ = -apron.z;
    const inwardLength = Math.hypot(inwardX, inwardZ);
    for (let d = 0; d <= 24; d += 2) {
      const x = apron.x + (inwardX / inwardLength) * d;
      const z = apron.z + (inwardZ / inwardLength) * d;
      assert.ok(Math.abs(terrain.heightAt(x, z)) < 0.35, 'the entry corridor stays level');
      assert.ok(terrain.slopeAt(x, z) < limit, 'the entry corridor stays gentle');
    }
  }

  // In world space the doorways sit exactly on the shared floor height, so a
  // step from any neighbouring sector onto the volcanic ground is seamless.
  const world = map();
  const sector = world.getSector('HEX_SE');
  for (const gate of world.gates) {
    if (gate.aSectorId !== 'HEX_SE' && gate.bSectorId !== 'HEX_SE') continue;
    const height = world.getFloorHeightAt(gate.center.x, gate.center.z);
    assert.ok(
      Math.abs(height - MAP_CONFIG.floorHeight) < 0.35,
      `${gate.id} threshold sits at ${height}`,
    );
    // And the ground just inside the sector stays level for a few strides.
    const dx = sector.center.x - gate.center.x;
    const dz = sector.center.z - gate.center.z;
    const length = Math.hypot(dx, dz);
    for (const d of [2, 6, 12, 20]) {
      const inside = world.getFloorHeightAt(
        gate.center.x + (dx / length) * d,
        gate.center.z + (dz / length) * d,
      );
      assert.ok(Math.abs(inside - MAP_CONFIG.floorHeight) < 0.35, `${gate.id} +${d}u`);
    }
  }
});

test('the volcanic floor never crosses the HEX_SE boundary', () => {
  const world = map();
  const sector = world.getSector('HEX_SE');
  const mesh = world.volcanicTerrainMesh;
  const positions = mesh.geometry.getAttribute('position');

  for (let index = 0; index < positions.count; index += 1) {
    const worldX = sector.center.x + positions.getX(index);
    const worldZ = sector.center.z + positions.getZ(index);
    assert.ok(
      isPointInsideHex(worldX, worldZ, sector.center.x, sector.center.z, RADIUS, 1e-3),
      `vertex ${index} crossed the HEX_SE boundary`,
    );
    assert.ok(
      Math.abs(positions.getY(index) - MAP_CONFIG.floorHeight)
        <= MAP_CONFIG.volcanicTerrainAmplitude + 1e-3,
      `vertex ${index} left the modelled relief`,
    );
  }

  // The rim band that borders every shared edge is at floor height, so the
  // walls and the portal jambs still meet the ground exactly as before.
  assert.ok(Math.abs(mesh.position.y - MAP_CONFIG.floorHeight) < 1e-9);
  assert.ok(Math.abs(sector.center.x - 1.5 * RADIUS) < 1e-9, 'HEX_SE did not move');
  assert.ok(Math.abs(sector.center.z - Math.sqrt(3) * RADIUS * 0.5) < 1e-9, 'HEX_SE did not move');
});

test('only HEX_SE changed: the other flat sectors and the forest are intact', () => {
  const world = map();

  // Structure untouched: same eight sectors, fourteen gates, twenty walls.
  assert.equal(world.sectors.length, 8);
  assert.equal(world.gates.length, 14);
  assert.equal(world.boundaryEdges.length, 20);
  assert.equal(world.doors.length, 14);

  for (const sector of world.sectors) {
    const mesh = world.sectorMeshes.get(sector.id);
    if (sector.id === 'HEX_SE') {
      assert.equal(mesh.geometry, world.volcanicTerrainGeometry, 'HEX_SE rides the volcanic lattice');
      assert.notEqual(mesh.geometry, world.floorGeometry);
      continue;
    }
    if (sector.id === 'HEX_S') {
      assert.equal(mesh.geometry, world.forestTerrain.geometry, 'the forest floor is untouched');
      continue;
    }
    assert.equal(mesh.geometry, world.floorGeometry, `${sector.id} keeps the flat plate`);
    assert.notEqual(mesh.material, world.volcanicRockMaterial);
    assert.equal(
      world.getFloorHeightAt(sector.center.x, sector.center.z),
      MAP_CONFIG.floorHeight,
      `${sector.id} floor height moved`,
    );
  }

  // The global hexagonal structure is unchanged: every sector still sits at
  // its axial coordinate and the shared-edge topology still lists HEX_SE
  // against exactly four neighbours.
  const data = buildHexMapData(RADIUS);
  for (const reference of data.sectors) {
    const live = world.getSector(reference.id);
    assert.equal(live.q, reference.q);
    assert.equal(live.r, reference.r);
    assert.deepEqual(live.center, reference.center);
    assert.deepEqual([...live.neighbors].sort(), [...reference.neighbors].sort());
  }
  assert.equal(world.getSector('HEX_SE').neighbors.length, 4);
});

test('the explorer walks through the HEX_CENTER gate and across the new terrain', () => {
  const world = map();
  const gate = world.gates.find(
    (candidate) => (candidate.aSectorId === 'HEX_CENTER' && candidate.bSectorId === 'HEX_SE')
      || (candidate.bSectorId === 'HEX_CENTER' && candidate.aSectorId === 'HEX_SE'),
  );
  assert.ok(gate, 'the HEX_CENTER <-> HEX_SE portal exists');
  const door = world.doors.find((candidate) => candidate.edge.id === gate.id);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const player = new PlayerController(camera, {}, world, PLAYER_CONFIG);
  player.isLocked = true;

  // Start inside HEX_CENTER, thirty units short of the doorway, facing it.
  const se = world.getSector('HEX_SE');
  const dirX = (se.center.x - gate.center.x) / Math.hypot(
    se.center.x - gate.center.x, se.center.z - gate.center.z,
  );
  const dirZ = (se.center.z - gate.center.z) / Math.hypot(
    se.center.x - gate.center.x, se.center.z - gate.center.z,
  );
  player.position.set(gate.center.x - dirX * 30, 0, gate.center.z - dirZ * 30);
  player.position.y = world.getFloorHeightAt(player.position.x, player.position.z);
  player.yaw = Math.atan2(-dirX, -dirZ);
  player.handleKeyDown({ code: 'KeyW', repeat: false, preventDefault: () => {} });

  let worstPenetration = 0;
  let airborneFrames = 0;
  let enteredHexSE = false;
  let maxDoorOpen = 0;
  let maxRelief = 0;
  const frames = 900; // fifteen seconds of walking at ten units per second

  for (let frame = 0; frame < frames; frame += 1) {
    world.update(1 / 60, player.position);
    player.update(1 / 60);
    maxDoorOpen = Math.max(maxDoorOpen, door.openAmount);
    const ground = world.getFloorHeightAt(player.position.x, player.position.z);
    assert.ok(ground !== null, 'the explorer never leaves the map');
    assert.ok(
      world.getSectorAt(player.position.x, player.position.z) !== null,
      'the explorer stays inside the sector structure',
    );
    worstPenetration = Math.max(worstPenetration, ground - player.position.y);
    if (player.position.y > ground + 1e-6) airborneFrames += 1;
    if (world.getSectorAt(player.position.x, player.position.z)?.id === 'HEX_SE') {
      enteredHexSE = true;
      maxRelief = Math.max(maxRelief, Math.abs(ground - MAP_CONFIG.floorHeight));
    }
  }

  assert.ok(maxDoorOpen > 0.95, 'the gate opens for the approaching explorer');
  assert.ok(enteredHexSE, 'the explorer walks into HEX_SE through the gate');
  assert.ok(maxRelief > 2, 'the explorer really walks over the volcanic relief');
  assert.ok(worstPenetration <= 1e-6, `explorer sank ${worstPenetration} units into the ground`);
  assert.ok(
    airborneFrames / frames < 0.02,
    `explorer left the ground on ${airborneFrames} of ${frames} frames instead of following the slope`,
  );
  player.dispose();
});

test('every HEX_SE gate still opens, seals and stays passable over the new terrain', () => {
  const world = map();
  const gates = world.gates.filter(
    (gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE',
  );
  assert.equal(gates.length, 4);

  for (const gate of gates) {
    const door = world.doors.find((candidate) => candidate.edge.id === gate.id);
    assert.ok(door, `${gate.id} has its sliding leaves`);

    // Approach: the leaves retract and the doorway becomes passable.
    for (let frame = 0; frame < 5; frame += 1) world.update(0.1, gate.center);
    assert.ok(door.openAmount > 0.95, `${gate.id} opens on approach`);
    const open = world.resolveHorizontalPosition(
      gate.center.x, gate.center.z, PLAYER_CONFIG.radius,
    );
    assert.ok(
      Math.hypot(open.x - gate.center.x, open.z - gate.center.z) < 1e-6,
      `${gate.id} is passable while open`,
    );

    // Leave: after the delay the leaves seal and the doorway blocks again.
    const farAway = { x: gate.center.x + MAP_CONFIG.doorOpenRadius + 120, z: gate.center.z };
    world.update(MAP_CONFIG.doorCloseDelay + 0.5, farAway);
    assert.equal(door.openAmount, 0, `${gate.id} closes after the explorer leaves`);
    const sealed = world.resolveHorizontalPosition(
      gate.center.x, gate.center.z, PLAYER_CONFIG.radius,
    );
    assert.ok(
      Math.hypot(sealed.x - gate.center.x, sealed.z - gate.center.z) > 0.5,
      `${gate.id} seals with its collision`,
    );

    // The wall panels beside the opening still block, on both sides.
    const dx = gate.end.x - gate.start.x;
    const dz = gate.end.z - gate.start.z;
    const length = Math.hypot(dx, dz);
    for (const side of [-1, 1]) {
      const wallPoint = {
        x: gate.center.x + (dx / length) * side * (MAP_CONFIG.gateWidth / 2 + 6),
        z: gate.center.z + (dz / length) * side * (MAP_CONFIG.gateWidth / 2 + 6),
      };
      const blocked = world.resolveHorizontalPosition(
        wallPoint.x, wallPoint.z, PLAYER_CONFIG.radius,
      );
      assert.ok(
        Math.hypot(blocked.x - wallPoint.x, blocked.z - wallPoint.z) > 1,
        `${gate.id} wall panel still blocks`,
      );
    }
  }
});
