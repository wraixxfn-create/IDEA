import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { HexCompass, layoutHexCompass } from '../src/ui/HexCompass.js';

const RADIUS = 220;

test('compass layout contains seven hexes with the center in the middle', () => {
  const data = buildHexMapData(RADIUS);
  const size = 200;
  const layout = layoutHexCompass(data.sectors, data.radius, size);
  assert.equal(layout.cells.length, 7);
  const center = layout.cells.find((cell) => cell.id === 'HEX_CENTER');
  const north = layout.cells.find((cell) => cell.id === 'HEX_N');
  assert.ok(center);
  assert.ok(north);
  assert.ok(Math.abs(center.cx - size / 2) < 10, `center x ${center.cx}`);
  assert.ok(Math.abs(center.cy - size / 2) < 10, `center y ${center.cy}`);
  assert.ok(north.cy < center.cy, 'north sector sits toward the top of the compass');
  assert.equal(center.points.length, 6);
});

test('visiting sectors records unique exploration progress', () => {
  const data = buildHexMapData(RADIUS);
  const canvas = {
    width: 196,
    height: 196,
    getContext: () => ({
      clearRect() {},
      beginPath() {},
      arc() {},
      fill() {},
      stroke() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
    }),
  };
  const compass = new HexCompass(canvas, {
    sectors: data.sectors,
    config: { hexRadius: RADIUS },
  });

  assert.equal(compass.exploredCount, 0);
  assert.equal(compass.markVisited('HEX_CENTER'), true);
  assert.equal(compass.markVisited('HEX_CENTER'), false);
  compass.markVisited('HEX_N');
  compass.markVisited('HEX_S');
  assert.equal(compass.exploredCount, 3);
  compass.clearCurrent();
  assert.equal(compass.currentId, null);
  compass.draw(0, 0, 0);
});
