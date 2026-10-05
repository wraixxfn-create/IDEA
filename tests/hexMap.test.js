import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG, PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';

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

test('one reusable map generates seven floors, twelve gates and a closed outside boundary', () => {
  const map = makeMap();
  assert.equal(map.sectors.length, 7);
  assert.equal(map.sectorMeshes.size, 7);
  assert.equal(map.gates.length, 12);
  assert.equal(map.boundaryEdges.length, 18);
  assert.equal(map.wallInstancedMesh.count, 54);
  assert.equal(map.frameInstancedMesh.count, 36);
  assert.equal(map.portalLights.count, 72, 'three slim light strips on each face of twelve gates');
  assert.equal(map.group.getObjectByName('PortalHexCrests'), undefined);
  assert.equal(map.group.getObjectByName('PortalBevelledBezels'), undefined);
  assert.equal(map.debugGroup.visible, false);
  for (const sector of map.sectors) {
    assert.equal(map.getFloorHeightAt(sector.center.x, sector.center.z), MAP_CONFIG.floorHeight);
  }
});

test('each shared full side is physically open at its center and blocked beside the opening', () => {
  const map = makeMap();
  const playerRadius = PLAYER_CONFIG.radius;

  for (const gate of map.gates) {
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


test('floors have no dark central mini hexagons and walls are three times taller', () => {
  const map = makeMap();
  assert.equal(MAP_CONFIG.wallHeight, 90);
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

test('floors and structural walls participate in shadow mapping', () => {
  const map = makeMap();
  for (const sector of map.sectors) {
    assert.equal(map.sectorMeshes.get(sector.id).receiveShadow, true);
  }
  assert.equal(map.wallInstancedMesh.castShadow, true);
  assert.equal(map.wallInstancedMesh.receiveShadow, true);
  assert.equal(map.portalLights.castShadow, false);
});

test('door headers block flight while the full visible opening stays passable', () => {
  const map = makeMap();
  for (const gate of map.gates) {
    const point = pointOnEdge(gate, 0);
    const below = map.resolveHorizontalPosition(point.x, point.z, PLAYER_CONFIG.radius,
      MAP_CONFIG.gateOpeningHeight - PLAYER_CONFIG.height - 0.1, PLAYER_CONFIG.height);
    assert.ok(Math.hypot(below.x - point.x, below.z - point.z) < 1e-6, gate.id);
    const above = map.resolveHorizontalPosition(point.x, point.z, PLAYER_CONFIG.radius,
      MAP_CONFIG.gateOpeningHeight + 0.1, PLAYER_CONFIG.height);
    assert.ok(Math.hypot(above.x - point.x, above.z - point.z) > 1, gate.id);
  }
});
