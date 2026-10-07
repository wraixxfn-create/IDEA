import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { DEFAULT_VOLCANIC_FORMATIONS, buildVolcanicFormations } from '../src/world/VolcanicFormations.js';
import { lavaFlowSampleAt } from '../src/world/LavaFlow.js';
import { isPointInsideHex } from '../src/world/hexGrid.js';
import { installCanvasStub, installInputStub } from './domStub.js';

installCanvasStub();
installInputStub();

const world = new HexMap(new THREE.Scene(), MAP_CONFIG);
const formations = world.volcanicFormations;
const RADIUS = MAP_CONFIG.hexRadius;

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0
    ? THREE.MathUtils.clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq, 0, 1)
    : 0;
  return Math.hypot(point.x - (start.x + dx * t), point.z - (start.z + dz * t));
}

test('HEX_SE gets six deliberately placed major volcanic formations only', () => {
  assert.equal(DEFAULT_VOLCANIC_FORMATIONS.length, 6);
  assert.ok(formations, 'the volcanic sector has its landmark formations');
  assert.equal(formations.name, 'VolcanicFormations_HEX_SE');
  assert.equal(formations.userData.sectorId, 'HEX_SE');
  assert.equal(formations.userData.featureType, 'major-volcanic-rock-formations');
  assert.equal(formations.userData.formationCount, 6);
  assert.equal(formations.userData.static, true);
  assert.equal(formations.userData.collidable, false);
  assert.equal(formations.parent, world.group);
  assert.equal(formations.children.length, 6, 'one authored formation per landmark');

  const names = formations.children.map((formation) => formation.userData.formationName);
  assert.deepEqual(names, DEFAULT_VOLCANIC_FORMATIONS.map((formation) => formation.name));
  for (const formation of formations.children) {
    assert.equal(formation.userData.sectorId, 'HEX_SE');
    assert.equal(formation.userData.role, 'major-landmark');
    assert.equal(formation.userData.major, true);
    assert.equal(formation.children.length, 1, 'each complete formation is one fused mesh');

    const mesh = formation.children[0];
    assert.equal(mesh.userData.sectorId, 'HEX_SE');
    assert.equal(mesh.userData.major, true);
    assert.equal(mesh.userData.componentCount > 0, true);
    assert.equal(mesh.geometry.userData.surface, 'fractured-volcanic-basalt');
    assert.ok(mesh.geometry.getAttribute('position').count > 180, 'the mesh resolves broad angular facets');
    assert.equal(
      mesh.geometry.getAttribute('color').count,
      mesh.geometry.getAttribute('position').count,
      'flat rock facets have their own basalt tones',
    );

    const size = new THREE.Vector3();
    mesh.geometry.boundingBox.getSize(size);
    assert.ok(size.y > 10, `${formation.userData.formationName} is not a major silhouette`);
    assert.ok(Math.max(size.x, size.z) > 9, `${formation.userData.formationName} is too small`);
  }
});

test('the formations sit inside HEX_SE and leave gate aprons and inward routes open', () => {
  const sector = world.getSector('HEX_SE');
  const gates = world.sectorGateAprons('HEX_SE');
  assert.equal(gates.length, 4);

  const terrain = world.volcanicTerrain;
  for (const formation of formations.children) {
    const radius = formation.userData.footprintRadius;
    const pool = terrain.lavaPool;
    const poolClearance = Math.hypot(
      formation.position.x - pool.x,
      formation.position.z - pool.z,
    ) - radius - pool.support;
    assert.ok(poolClearance > 8, `${formation.name} crowds the existing lava pool`);
    for (const flow of [terrain.lavaFlow, terrain.lavaSecondaryFlow]) {
      const flowPoint = lavaFlowSampleAt(formation.position.x, formation.position.z, flow);
      if (!flowPoint) continue;
      assert.ok(
        flowPoint.distance - radius > flowPoint.halfWidth + 8,
        `${formation.name} crowds an existing lava channel`,
      );
    }

    for (const gate of gates) {
      const gateDistance = Math.hypot(formation.position.x - gate.x, formation.position.z - gate.z);
      assert.ok(
        gateDistance - radius > MAP_CONFIG.volcanicGateApronOuter,
        `${formation.name} crowds a gate apron`,
      );

      const routeDistance = distanceToSegment(
        { x: formation.position.x, z: formation.position.z },
        gate,
        { x: 0, z: 0 },
      );
      assert.ok(
        routeDistance - radius > 18,
        `${formation.name} narrows the direct inward route from a gate`,
      );

      const crater = world.volcanicTerrain.layout.crater;
      const craterApproachDistance = distanceToSegment(
        { x: formation.position.x, z: formation.position.z },
        gate,
        { x: crater.x, z: crater.z },
      );
      assert.ok(
        craterApproachDistance - radius > 24,
        `${formation.name} narrows a gate-to-crater exploration route`,
      );
    }

    const positions = formation.children[0].geometry.getAttribute('position');
    for (let vertex = 0; vertex < positions.count; vertex += 1) {
      const x = formation.position.x + positions.getX(vertex);
      const z = formation.position.z + positions.getZ(vertex);
      assert.ok(
        isPointInsideHex(x, z, 0, 0, RADIUS, 1e-3),
        `${formation.name} crosses the HEX_SE boundary`,
      );
    }

    assert.equal(sector.id, 'HEX_SE');
  }
});

test('formation generation is deterministic and does not modify terrain or lava', () => {
  const terrain = world.volcanicTerrain;
  const heights = terrain.heights.slice();
  const lavaPool = terrain.lavaPool;
  const lavaFlow = terrain.lavaFlow;
  const lavaBranch = terrain.lavaSecondaryFlow;
  const repeat = buildVolcanicFormations(terrain, MAP_CONFIG);

  assert.equal(repeat.children.length, formations.children.length);
  for (let formation = 0; formation < repeat.children.length; formation += 1) {
    const actual = repeat.children[formation].children[0].geometry.getAttribute('position').array;
    const expected = formations.children[formation].children[0].geometry.getAttribute('position').array;
    assert.deepEqual(actual, expected, `formation ${formation} rebuilds deterministically`);
  }
  assert.deepEqual(terrain.heights, heights, 'placing the meshes never carves or raises the terrain');
  assert.equal(terrain.lavaPool, lavaPool);
  assert.equal(terrain.lavaFlow, lavaFlow);
  assert.equal(terrain.lavaSecondaryFlow, lavaBranch);
  assert.equal(buildVolcanicFormations(terrain, { ...MAP_CONFIG, volcanicFormationsEnabled: false }), null);
});
