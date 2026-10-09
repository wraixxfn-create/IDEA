import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { VolcanicTerrain } from '../src/world/VolcanicTerrain.js';
import { buildLavaBasins } from '../src/world/LavaBasins.js';
import { createLavaMaterial } from '../src/world/LavaPool.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
const data = buildHexMapData(MAP_CONFIG.hexRadius);
const sector = data.byId.get('HEX_SE');
const gateAprons = data.sharedEdges.filter(g => g.aSectorId === 'HEX_SE' || g.bSectorId === 'HEX_SE')
  .map(g => ({ x: g.center.x - sector.center.x, z: g.center.z - sector.center.z }));
const terrain = new VolcanicTerrain({ config: MAP_CONFIG, gateAprons });
const off = new VolcanicTerrain({ config: { ...MAP_CONFIG, lavaBasinsEnabled: false }, gateAprons });
test('additional lava preserves relief, collisions and established lava', () => {
  assert.ok(terrain.lavaBasins.length > 0);
  assert.deepEqual(terrain.heights, off.heights);
  assert.deepEqual(terrain.positions, off.positions);
  assert.deepEqual(terrain.indices, off.indices);
  assert.deepEqual(terrain.lavaPool, off.lavaPool);
  assert.deepEqual(terrain.lavaFlow, off.lavaFlow);
  assert.deepEqual(terrain.lavaSecondaryFlow, off.lavaSecondaryFlow);
  assert.deepEqual(off.lavaBasins, []);
});
test('generous enclosed lava retains the shared crust and animation', () => {
  const built = buildLavaBasins(terrain, MAP_CONFIG);
  assert.ok(built.reduce((sum, basin) => sum + basin.area, 0) > 3000);
  for (const basin of built) {
    assert.equal(basin.material, createLavaMaterial(MAP_CONFIG));
    assert.ok(terrain.cooledCrust.sources.includes(basin.pool.id));
    assert.equal(basin.shoreline.radii, terrain.lavaBasins.find(b => b.pool === basin.pool).shoreline.radii);
    const positions = basin.geometry.getAttribute('position');
    for (let v = 0; v < positions.count; v++) {
      assert.ok(Math.abs(positions.getY(v) - basin.pool.level - basin.pool.lift) < 1e-5);
    }
  }
});
