import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG, PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { isPointInsideHex } from '../src/world/hexGrid.js';

// HexMap only uses a canvas for the optional debug labels. A tiny canvas stub
// keeps this structural/collision test runnable in plain Node without a DOM.
const canvasContext = {
  beginPath() {},
  roundRect() {},
  fill() {},
  stroke() {},
  fillText() {},
};
for (const property of ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline']) {
  Object.defineProperty(canvasContext, property, { set() {}, configurable: true });
}
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext }),
};

function makeMap() {
  return new HexMap(new THREE.Scene(), MAP_CONFIG);
}

function pointOnEdge(edge, distanceAlong, distanceNormal = 0) {
  const dx = edge.end.x - edge.start.x;
  const dz = edge.end.z - edge.start.z;
  const length = Math.hypot(dx, dz);
  const axisX = dx / length;
  const axisZ = dz / length;
  const normalX = -axisZ;
  const normalZ = axisX;
  return {
    x: edge.center.x + axisX * distanceAlong + normalX * distanceNormal,
    z: edge.center.z + axisZ * distanceAlong + normalZ * distanceNormal,
  };
}

test('map builds eight sectors, a closed perimeter and detailed animated portals', () => {
  const map = makeMap();
  assert.equal(map.sectors.length, 8);
  assert.equal(map.sectorMeshes.size, 8);
  assert.equal(map.gates.length, 14);
  assert.equal(map.boundaryEdges.length, 20);
  assert.equal(map.wallInstancedMesh.count, 62);
  assert.equal(map.frameInstancedMesh.count, 56);
  assert.equal(map.portalTrim.count, 252);
  assert.equal(map.portalLights.count, 84, 'three sector-coded light strips on both faces of fourteen portals');
  assert.equal(map.doors.length, 14);
  assert.ok(map.group.getObjectByName('PortalHexCrests'));
  assert.equal(map.portalCrestBases.count, 28, 'one hex crest faces each adjoining sector');
  assert.equal(map.group.getObjectByName('DoorLeaves_TitaniumCores').count, 56);
  assert.equal(map.group.getObjectByName('DoorLeaves_HexLockGlyphs').count, 56);
  assert.equal(map.doors[0].openAmount, 0, 'portals begin sealed until approached');
  assert.equal(map.debugGroup.visible, false);
  for (const sector of map.sectors) {
    const height = map.getFloorHeightAt(sector.center.x, sector.center.z);
    if (sector.id === 'HEX_S') {
      // The forest carries a modelled relief, so its centre is wherever the
      // terrain puts it — but always within the modelled amplitude.
      assert.ok(
        Math.abs(height - MAP_CONFIG.floorHeight) <= MAP_CONFIG.forestTerrainAmplitude,
        'the forest centre stays inside the modelled relief',
      );
    } else if (sector.id === 'HEX_SE') {
      // The volcanic sector carries a modelled relief too: its centre sits in
      // the ash plains, wherever the baked field puts it.
      assert.ok(
        Math.abs(height - MAP_CONFIG.floorHeight) <= MAP_CONFIG.volcanicTerrainAmplitude,
        'the volcanic centre stays inside the modelled relief',
      );
    } else {
      assert.equal(height, MAP_CONFIG.floorHeight);
    }
  }
});

test('detailed pine trees are present only in HEX_S and stay inside its boundary', () => {
  const map = makeMap();
  const grove = map.pineGrove;
  const sector = map.getSector('HEX_S');
  assert.ok(grove, 'HEX_S receives its pine grove');
  assert.equal(grove.name, 'PineGrove_HEX_S');
  assert.equal(grove.userData.sectorId, 'HEX_S');
  assert.equal(grove.userData.foliageType, 'mature-pine');
  assert.equal(grove.userData.treeCount, 18);
  // HEX_S is the showcase biome, so the wood is three times as thick as the
  // eighteen authored spruces: young pines carry the density and saplings fill
  // the last gaps between the trunks.
  assert.ok(grove.userData.totalTreeCount >= 150,
    `expected a dense wood, found ${grove.userData.totalTreeCount} trunks`);
  assert.ok(grove.userData.youngTreeCount >= 40,
    `expected a mid-storey of young pines, found ${grove.userData.youngTreeCount}`);
  assert.ok(grove.userData.saplingCount >= 40);
  assert.equal(
    grove.userData.matureTreeCount + grove.userData.youngTreeCount + grove.userData.saplingCount,
    grove.userData.totalTreeCount,
    'every trunk belongs to exactly one class',
  );
  assert.deepEqual(grove.userData.treeClassCounts, {
    mature: grove.userData.matureTreeCount,
    young: grove.userData.youngTreeCount,
    sapling: grove.userData.saplingCount,
  });
  assert.equal(grove.children.length, 2, 'wood and needle meshes keep the grove to two draw calls');
  assert.ok(grove.getObjectByName('PineGrove_Wood_HEX_S').geometry.getAttribute('position').count > 10000);
  assert.ok(grove.getObjectByName('PineGrove_Needles_HEX_S').geometry.getAttribute('position').count > 100000);
  assert.equal(map.group.children.filter((child) => child.userData.foliageType === 'mature-pine').length, 1);
  assert.equal(map.group.getObjectByName('PineGrove_HEX_N'), undefined);
  assert.equal(map.group.getObjectByName('PineGrove_HEX_CENTER'), undefined);

  for (const tree of grove.userData.treePlacements) {
    const worldX = sector.center.x + tree.x;
    const worldZ = sector.center.z + tree.z;
    assert.equal(map.getSectorAt(worldX, worldZ)?.id, 'HEX_S');
  }

  // Check the complete generated canopy, roots and branches, not just trunk
  // centers, so no part of a pine leaks into a neighboring sector.
  for (const mesh of grove.children) {
    const positions = mesh.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index += 1) {
      assert.ok(isPointInsideHex(
        sector.center.x + positions.getX(index),
        sector.center.z + positions.getZ(index),
        sector.center.x,
        sector.center.z,
        MAP_CONFIG.hexRadius,
      ), `${mesh.name} vertex ${index} crossed the HEX_S boundary`);
    }
  }
});

test('sliding portal leaves open on approach and return to a collidable seal after a delay', () => {
  const map = makeMap();
  const gate = map.gates[0];
  const door = map.doors.find((candidate) => candidate.edge.id === gate.id);
  const closed = map.resolveHorizontalPosition(gate.center.x, gate.center.z, PLAYER_CONFIG.radius);
  assert.ok(Math.hypot(closed.x - gate.center.x, closed.z - gate.center.z) > 0.5);

  for (let frame = 0; frame < 5; frame += 1) map.update(0.1, gate.center);
  assert.ok(door.openAmount > 0.95, 'door leaves finish retracting smoothly');
  const open = map.resolveHorizontalPosition(gate.center.x, gate.center.z, PLAYER_CONFIG.radius);
  assert.ok(Math.hypot(open.x - gate.center.x, open.z - gate.center.z) < 1e-6);

  const farAway = { x: gate.center.x + MAP_CONFIG.doorOpenRadius + 80, z: gate.center.z };
  map.update(MAP_CONFIG.doorCloseDelay + 0.5, farAway);
  assert.equal(door.openAmount, 0);
  const sealed = map.resolveHorizontalPosition(gate.center.x, gate.center.z, PLAYER_CONFIG.radius);
  assert.ok(Math.hypot(sealed.x - gate.center.x, sealed.z - gate.center.z) > 0.5);
});

test('each shared portal is passable when its sliding leaves retract and blocked beside the opening', () => {
  const map = makeMap();
  const playerRadius = PLAYER_CONFIG.radius;

  for (const gate of map.gates) {
    map.update(1, gate.center);
    for (const side of [-10, 0, 10]) {
      const passagePoint = pointOnEdge(gate, 0, side);
      const passageResult = map.resolveHorizontalPosition(passagePoint.x, passagePoint.z, playerRadius);
      assert.ok(Math.hypot(passageResult.x - passagePoint.x, passageResult.z - passagePoint.z) < 1e-6, gate.id);
    }

    const wallPoint = pointOnEdge(
      gate,
      MAP_CONFIG.gateWidth / 2 + MAP_CONFIG.gateFrameWidth + 4,
      0,
    );
    const wallResult = map.resolveHorizontalPosition(wallPoint.x, wallPoint.z, playerRadius);
    assert.ok(Math.hypot(wallResult.x - wallPoint.x, wallResult.z - wallPoint.z) > 1, gate.id);
  }
});

test('every gate supports a wall-collided center-to-center route', () => {
  const map = makeMap();
  const stepLength = 1.5;

  for (const gate of map.gates) {
    const start = map.getSector(gate.aSectorId).center;
    const target = map.getSector(gate.bSectorId).center;
    const dx = target.x - start.x;
    const dz = target.z - start.z;
    const steps = Math.ceil(Math.hypot(dx, dz) / stepLength);
    const stepX = dx / steps;
    const stepZ = dz / steps;
    let x = start.x;
    let z = start.z;

    for (let i = 0; i < steps; i += 1) {
      map.update(1 / 60, { x, z });
      let resolved = map.resolveHorizontalPosition(x + stepX, z, PLAYER_CONFIG.radius);
      x = resolved.x;
      resolved = map.resolveHorizontalPosition(x, z + stepZ, PLAYER_CONFIG.radius);
      z = resolved.z;
    }

    assert.ok(Math.hypot(x - target.x, z - target.z) < 2, gate.id);
  }
});

test('each unshared hex side is collidable perimeter wall geometry', () => {
  const map = makeMap();
  for (const boundary of map.boundaryEdges) {
    const point = { x: boundary.center.x, z: boundary.center.z };
    const resolved = map.resolveHorizontalPosition(point.x, point.z, PLAYER_CONFIG.radius);
    assert.ok(Math.hypot(resolved.x - point.x, resolved.z - point.z) > 1, boundary.id);
  }
});

test('flight clears walls only after the player rises above their top edge', () => {
  const map = makeMap();
  const boundary = map.boundaryEdges[0];
  const point = { x: boundary.center.x, z: boundary.center.z };

  const grounded = map.resolveHorizontalPosition(
    point.x,
    point.z,
    PLAYER_CONFIG.radius,
    MAP_CONFIG.floorHeight,
    PLAYER_CONFIG.height,
  );
  assert.ok(Math.hypot(grounded.x - point.x, grounded.z - point.z) > 1);

  const airborne = map.resolveHorizontalPosition(
    point.x,
    point.z,
    PLAYER_CONFIG.radius,
    MAP_CONFIG.wallHeight + 0.2,
    PLAYER_CONFIG.height,
  );
  assert.ok(Math.hypot(airborne.x - point.x, airborne.z - point.z) < 1e-6);
});

test('every sector has a distinct floor color and gates are narrower', () => {
  const map = makeMap();
  assert.ok(MAP_CONFIG.gateWidth < 40, `Gate width ${MAP_CONFIG.gateWidth} should be narrower`);
  const colors = new Set();
  for (const sector of map.sectors) {
    const mesh = map.sectorMeshes.get(sector.id);
    assert.ok(mesh, `Floor mesh missing for ${sector.id}`);
    const hexColor = mesh.material.color.getHex();
    assert.ok(!colors.has(hexColor), `Color ${hexColor} is duplicated in sector ${sector.id}`);
    colors.add(hexColor);
  }
  assert.equal(colors.size, map.sectors.length);
});


test('floors have no dark central mini hexagons and walls use the requested 45-unit height', () => {
  const map = makeMap();
  assert.equal(MAP_CONFIG.wallHeight, 45);
  for (const sector of map.sectors) {
    assert.equal(map.group.getObjectByName(`FloorCenter_${sector.id}`), undefined);
  }
  const matrix = new THREE.Matrix4();
  map.wallInstancedMesh.getMatrixAt(0, matrix);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  matrix.decompose(position, new THREE.Quaternion(), scale);
  assert.equal(scale.y, MAP_CONFIG.wallHeight);
  assert.equal(position.y + scale.y / 2, MAP_CONFIG.floorHeight + MAP_CONFIG.wallHeight);
});

test('door headers block flight while an opened sliding doorway stays passable', () => {
  const map = makeMap();
  for (const gate of map.gates) {
    const point = pointOnEdge(gate, 0);
    map.update(1, point);
    const below = map.resolveHorizontalPosition(point.x, point.z, PLAYER_CONFIG.radius,
      MAP_CONFIG.gateOpeningHeight - PLAYER_CONFIG.height - 0.1, PLAYER_CONFIG.height);
    assert.ok(Math.hypot(below.x - point.x, below.z - point.z) < 1e-6, gate.id);
    const above = map.resolveHorizontalPosition(point.x, point.z, PLAYER_CONFIG.radius,
      MAP_CONFIG.gateOpeningHeight + 0.1, PLAYER_CONFIG.height);
    assert.ok(Math.hypot(above.x - point.x, above.z - point.z) > 1, gate.id);
  }
});
