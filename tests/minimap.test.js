import test from 'node:test';
import assert from 'node:assert/strict';
import { Minimap } from '../src/ui/Minimap.js';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { buildHexMapData, isPointInsideHex } from '../src/world/hexGrid.js';

/** A canvas that records everything the map draws on it. */
function makeCanvasStub() {
  const transforms = [];
  const context = {
    setTransform: (...args) => transforms.push(args),
    clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, fill() {}, stroke() {}, fillText() {},
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '',
    textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0,
  };
  const canvas = {
    width: 420,
    height: 400,
    // The stylesheet lays the canvas out at 420x400 CSS pixels.
    style: {},
    transforms,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 420, height: 400 }),
  };
  return canvas;
}

function makeWorld() {
  const data = buildHexMapData(MAP_CONFIG.hexRadius);
  return {
    bounds: data.bounds,
    sectors: data.sectors,
    gates: data.sharedEdges,
    getSectorAt(x, z) {
      return data.sectors.find((sector) => isPointInsideHex(
        x, z, sector.center.x, sector.center.z, MAP_CONFIG.hexRadius,
      )) ?? null;
    },
  };
}

function makeMinimap() {
  const canvas = makeCanvasStub();
  const legend = { innerHTML: '' };
  const player = { position: { x: 0, y: 0, z: 0 }, facingYaw: 0 };
  const minimap = new Minimap({
    canvas,
    legend,
    world: makeWorld(),
    player,
    hexRadius: MAP_CONFIG.hexRadius,
  });
  return { minimap, canvas, legend, player };
}

test('the map canvas keeps a fixed size no matter how often it is redrawn', () => {
  const { minimap, canvas } = makeMinimap();

  // The regression: the bitmap used to be multiplied by the pixel ratio on
  // every frame, so after a second of animation the tab was allocating
  // gigapixel canvases and the keyboard (including M) stopped responding.
  for (let frame = 0; frame < 240; frame += 1) {
    assert.equal(minimap.render(2), true);
  }

  assert.equal(canvas.width, 840, 'the backing store stays at 420 CSS px * 2 dpr');
  assert.equal(canvas.height, 800);
  assert.deepEqual(canvas.style, {},
    'the layout size belongs to the stylesheet, so nothing is written inline');
  assert.equal(minimap.renders, 240);
  // The transform is set, never accumulated.
  for (const transform of canvas.transforms) {
    assert.deepEqual(transform, [2, 0, 0, 2, 0, 0]);
  }
});

test('the map follows the device pixel ratio without drifting', () => {
  const { minimap, canvas } = makeMinimap();
  minimap.render(1);
  assert.equal(canvas.width, 420);
  minimap.render(2);
  assert.equal(canvas.width, 840);
  minimap.render(2);
  assert.equal(canvas.width, 840);
  minimap.render(1);
  assert.equal(canvas.width, 420);
  // Out-of-range ratios are clamped instead of exploding the bitmap.
  minimap.render(8);
  assert.equal(canvas.width, 840);
});

test('the map reports the sector the explorer is standing in', () => {
  const { minimap, legend, player } = makeMinimap();
  minimap.render(1);
  assert.match(legend.innerHTML, /Amber Core/);

  const south = minimap.world.sectors.find((sector) => sector.id === 'HEX_S');
  player.position.x = south.center.x;
  player.position.z = south.center.z;
  minimap.render(1);
  assert.match(legend.innerHTML, /Amethyst South/);
});
