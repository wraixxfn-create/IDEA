import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHexMapData, getHexVertices, HEX_VERTEX_UNITS, INITIAL_SECTORS } from '../src/world/hexGrid.js';

const RADIUS = 220;
const EPSILON = 1e-8;

function closeTo(actual, expected, epsilon = EPSILON) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

test('initial map is exactly one center plus six axial neighbors', () => {
  const map = buildHexMapData(RADIUS);
  assert.equal(map.sectors.length, 7);
  assert.equal(map.byId.size, 7);
  assert.deepEqual(map.sectors.map(({ id }) => id), [
    'HEX_CENTER', 'HEX_N', 'HEX_NE', 'HEX_SE', 'HEX_S', 'HEX_SW', 'HEX_NW',
  ]);
  assert.deepEqual(map.byId.get('HEX_CENTER').neighbors, [
    'HEX_N', 'HEX_NE', 'HEX_SE', 'HEX_S', 'HEX_SW', 'HEX_NW',
  ]);
  for (const sector of map.sectors.slice(1)) assert.equal(sector.neighbors.length, 3);
});

test('all generated sectors use congruent flat-top regular hexagons', () => {
  assert.equal(HEX_VERTEX_UNITS.length, 6);
  for (const vertex of HEX_VERTEX_UNITS) closeTo(Math.hypot(vertex.x, vertex.z), 1);
  for (let i = 0; i < HEX_VERTEX_UNITS.length; i += 1) {
    const a = HEX_VERTEX_UNITS[i];
    const b = HEX_VERTEX_UNITS[(i + 1) % HEX_VERTEX_UNITS.length];
    closeTo(Math.hypot(a.x - b.x, a.z - b.z), 1);
  }
  const map = buildHexMapData(RADIUS);
  for (const sector of map.sectors) {
    closeTo(Math.hypot(sector.center.x, sector.center.z), sector.id === 'HEX_CENTER' ? 0 : Math.sqrt(3) * RADIUS);
  }
});

test('every shared side is one gate; every unshared side is an outer wall', () => {
  const map = buildHexMapData(RADIUS);
  assert.equal(map.sharedEdges.length, 12);
  assert.equal(map.boundaryEdges.length, 18);
  for (const edge of [...map.sharedEdges, ...map.boundaryEdges]) {
    closeTo(edge.length, RADIUS);
  }
  const connectionCounts = new Map();
  for (const edge of map.sharedEdges) {
    const key = [edge.aSectorId, edge.bSectorId].sort().join('|');
    connectionCounts.set(key, (connectionCounts.get(key) ?? 0) + 1);
  }
  assert.equal(connectionCounts.size, 12);
  for (const count of connectionCounts.values()) assert.equal(count, 1);
});

test('the seven-sector footprint has matching edge-to-edge coordinates and no duplicate cells', () => {
  const map = buildHexMapData(RADIUS);
  const axial = new Set(map.sectors.map(({ q, r }) => `${q},${r}`));
  assert.equal(axial.size, 7);
  closeTo(map.bounds.minX, -2.5 * RADIUS);
  closeTo(map.bounds.maxX, 2.5 * RADIUS);
  closeTo(map.bounds.minZ, -Math.sqrt(3) * RADIUS - Math.sqrt(3) / 2 * RADIUS);
  closeTo(map.bounds.maxZ, Math.sqrt(3) * RADIUS + Math.sqrt(3) / 2 * RADIUS);
});

test('custom data rejects duplicate coordinates and allows reusable expansion', () => {
  assert.throws(() => buildHexMapData(RADIUS, [
    { id: 'A', q: 0, r: 0 },
    { id: 'B', q: 0, r: 0 },
  ]), /Duplicate axial coordinate/);

  const expanded = buildHexMapData(RADIUS, [
    ...INITIAL_SECTORS,
    { id: 'HEX_FAR_N', q: 0, r: -2 },
  ]);
  assert.equal(expanded.sectors.length, 8);
  assert.ok(expanded.byId.get('HEX_N').neighbors.includes('HEX_FAR_N'));
});
