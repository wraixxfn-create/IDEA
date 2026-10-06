import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG, PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import {
  ForestTerrain,
  distanceToHexEdge,
  latticeVertexCount,
  latticeVertexIndex,
} from '../src/world/ForestTerrain.js';
import { installCanvasStub, installInputStub } from './domStub.js';
import { PlayerController } from '../src/player/PlayerController.js';

installCanvasStub();
installInputStub();

const RADIUS = MAP_CONFIG.hexRadius;

function makeMap() {
  return new HexMap(new THREE.Scene(), MAP_CONFIG);
}

/** Deterministic sample points well inside HEX_S. */
function* interiorPoints(count, margin = 2) {
  let state = 0x1234abcd;
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

test('the baked lattice welds its wedges and pins every shared edge flat', () => {
  const divisions = 24;
  const terrain = new ForestTerrain({
    radius: RADIUS,
    config: { ...MAP_CONFIG, forestTerrainDivisions: divisions },
  });

  assert.equal(terrain.vertexCount, latticeVertexCount(divisions));
  assert.equal(terrain.vertexCount, 3 * divisions * divisions + 3 * divisions + 1);
  assert.equal(terrain.triangleCount, 6 * divisions * divisions);

  // Every lattice address resolves to a vertex, and the shared spokes of two
  // neighbouring wedges resolve to the *same* vertex (no cracks, no seams).
  const seen = new Set();
  for (let k = 0; k < 6; k += 1) {
    for (let i = 0; i <= divisions; i += 1) {
      for (let j = 0; j <= divisions - i; j += 1) {
        const index = latticeVertexIndex(k, i, j, divisions);
        assert.ok(index >= 0 && index < terrain.vertexCount, 'index in range');
        seen.add(index);
      }
    }
  }
  assert.equal(seen.size, terrain.vertexCount, 'every vertex is addressed exactly once');
  for (let k = 0; k < 6; k += 1) {
    for (let d = 1; d <= divisions; d += 1) {
      assert.equal(
        latticeVertexIndex(k, d, 0, divisions),
        latticeVertexIndex((k + 5) % 6, 0, d, divisions),
        'wedges share their spoke vertices',
      );
    }
  }

  // Positions are stored as float32, so the rim is compared with a tolerance
  // of a thousandth of a unit rather than exactly.
  const epsilon = 1e-3;
  const positions = terrain.geometry.getAttribute('position');
  let rimVertices = 0;
  for (let v = 0; v < positions.count; v += 1) {
    const edge = distanceToHexEdge(positions.getX(v), positions.getZ(v), RADIUS);
    if (edge < epsilon) {
      rimVertices += 1;
      assert.ok(Math.abs(positions.getY(v)) < 1e-9, 'the rim stays flat');
    }
    assert.ok(edge > -epsilon, 'no vertex leaves the hexagon');
  }
  assert.equal(rimVertices, 6 * divisions, 'the rim is a closed ring of lattice vertices');
});

test('the HEX_S hitbox IS the HEX_S mesh', () => {
  const map = makeMap();
  const sector = map.getSector('HEX_S');
  const mesh = map.forestTerrainMesh;
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
    const collision = map.getFloorHeightAt(x, z);
    worst = Math.max(worst, Math.abs(hit.point.y - collision));
    samples += 1;
  }

  assert.ok(samples > 200);
  // The old polar mesh and its trigonometric collision formula disagreed by
  // up to ~3.8 units — more than twice the explorer's height.
  assert.ok(worst < 1e-3, `rendered ground and collision ground differ by ${worst}`);
});

test('every rendered forest face stays walkable, and the surface is continuous', () => {
  const map = makeMap();
  const terrain = map.forestTerrain;
  const limit = Math.tan(THREE.MathUtils.degToRad(MAP_CONFIG.forestTerrainMaxSlopeDeg));

  assert.ok(
    terrain.geometry.userData.maxSlopeDegrees <= MAP_CONFIG.forestTerrainMaxSlopeDeg + 1e-3,
    `steepest face is ${terrain.geometry.userData.maxSlopeDegrees} degrees`,
  );

  // Walk a straight line across the sector: consecutive samples may never
  // jump by more than the slope limit allows, i.e. there are no cliffs or
  // holes for the explorer to fall through.
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

  // Queries outside the hexagon clamp onto the rim instead of returning junk.
  for (const [x, z] of [[0, 0], [RADIUS * 4, 0], [-RADIUS * 3, RADIUS * 3]]) {
    assert.ok(Number.isFinite(terrain.heightAt(x, z)));
  }
  assert.ok(Math.abs(terrain.heightAt(RADIUS * 4, 0)) < 1e-6, 'outside the hex reads as the flat rim');
});

test('the explorer walks the forest relief without ever sinking into it', () => {
  const map = makeMap();
  const sector = map.getSector('HEX_S');
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const player = new PlayerController(camera, {}, map, PLAYER_CONFIG);
  player.isLocked = true;
  player.position.set(sector.center.x - 90, 0, sector.center.z - 40);
  player.position.y = map.getFloorHeightAt(player.position.x, player.position.z);
  player.handleKeyDown({ code: 'KeyW', repeat: false, preventDefault: () => {} });

  let worstPenetration = 0;
  let airborneFrames = 0;
  const frames = 900;
  for (let frame = 0; frame < frames; frame += 1) {
    // Sweep the heading so the walk crosses ridges and hollows in every
    // direction instead of following one lucky line.
    player.yaw = Math.sin(frame / 110) * Math.PI;
    player.update(1 / 60);
    const ground = map.getFloorHeightAt(player.position.x, player.position.z);
    if (ground === null) continue;
    worstPenetration = Math.max(worstPenetration, ground - player.position.y);
    if (player.position.y > ground + 1e-6) airborneFrames += 1;
  }

  assert.ok(worstPenetration <= 1e-6, `explorer sank ${worstPenetration} units into the ground`);
  assert.ok(
    airborneFrames / frames < 0.02,
    `explorer left the ground on ${airborneFrames} of ${frames} frames instead of following the slope`,
  );
  player.dispose();
});


