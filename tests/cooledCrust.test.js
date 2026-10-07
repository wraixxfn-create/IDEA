import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { VolcanicTerrain } from '../src/world/VolcanicTerrain.js';
import { lavaFlowSampleAt } from '../src/world/LavaFlow.js';
import {
  COOLED_CRUST_DEFAULTS,
  cooledCrustFieldAt,
  cooledCrustTextures,
  createCooledCrustTextures,
  installCooledCrust,
  patchCooledCrustFragmentShader,
  patchCooledCrustVertexShader,
  planCooledCrust,
  writeCooledCrustAttribute,
} from '../src/world/CooledCrust.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
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

// The crust's own terrain is measured off the finished lava bake, so the tests
// share one of each rather than rebuilding the sector per assertion.
const TERRAIN = makeTerrain();
const CRUST = TERRAIN.cooledCrust;
const WITHOUT = makeTerrain({ ...MAP_CONFIG, cooledCrustEnabled: false });

let sharedWorld;
const world = () => (sharedWorld ??= new HexMap(new THREE.Scene(), MAP_CONFIG));
let sharedOffWorld;
const worldWithout = () => (sharedOffWorld ??= new HexMap(
  new THREE.Scene(),
  { ...MAP_CONFIG, cooledCrustEnabled: false },
));

/** How far a point is from the nearest molten surface, in sector units. */
function distanceToLava(x, z) {
  const pool = TERRAIN.lavaPool;
  const bearing = (Math.atan2(z - pool.z, x - pool.x) + Math.PI * 2) % (Math.PI * 2);
  let nearest = Math.hypot(x - pool.x, z - pool.z) - distanceToShore(bearing);
  for (const flow of [TERRAIN.lavaFlow, TERRAIN.lavaSecondaryFlow]) {
    const sample = lavaFlowSampleAt(x, z, flow);
    if (sample) nearest = Math.min(nearest, sample.distance - sample.halfWidth);
  }
  return nearest;
}

function distanceToShore(bearing) {
  const radii = CRUST.shoreline.radii;
  const at = ((bearing % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * radii.length;
  const i = Math.floor(at);
  return radii[i] + (radii[(i + 1) % radii.length] - radii[i]) * (at - i);
}

/** Deterministic sample points well inside the sector. */
function* interiorPoints(count, seed = 0x5ca1ed) {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  let produced = 0;
  while (produced < count) {
    const x = (random() * 2 - 1) * RADIUS;
    const z = (random() * 2 - 1) * RADIUS;
    if (distanceToHexEdge(x, z, RADIUS) < 2) continue;
    produced += 1;
    yield { x, z };
  }
}

test('the crust is planned from the lava the sector already carries, and adds none', () => {
  assert.ok(CRUST, 'the volcanic sector carries a cooled crust');
  assert.equal(CRUST.id, 'cooled-crust-hex-se');
  assert.equal(CRUST.id, COOLED_CRUST_DEFAULTS.id);
  // It is measured from exactly the three molten surfaces the sector has: the
  // pool, its main outlet and the one branch. Nothing else is a source.
  assert.deepEqual([...CRUST.sources], [
    TERRAIN.lavaPool.id, TERRAIN.lavaFlow.id, TERRAIN.lavaSecondaryFlow.id,
  ]);
  assert.equal(CRUST.pool.id, TERRAIN.lavaPool.id);
  assert.equal(CRUST.pool.level, TERRAIN.lavaPool.level, 'the crust sits on the pool that exists');
  assert.equal(CRUST.shoreline, TERRAIN.lavaFlow.sourceShoreline,
    'the crust reads the shoreline the closed pool was measured with');
  assert.equal(CRUST.channels.length, 2, 'one channel crust per existing flow');
  assert.deepEqual(CRUST.channels.map((channel) => channel.kind), ['main', 'branch']);
  assert.equal(CRUST.channels[0].flow, TERRAIN.lavaFlow);
  assert.equal(CRUST.channels[1].flow, TERRAIN.lavaSecondaryFlow);
  // The branch stays the smaller crust, exactly as its channel is the smaller flow.
  assert.ok(CRUST.channels[1].reach < CRUST.channels[0].reach);
  assert.ok(CRUST.channels[1].heatReach < CRUST.channels[0].heatReach);

  // Planning is pure: a second terrain plans the identical crust.
  const again = makeTerrain();
  assert.deepEqual(again.cooledCrust.sources, CRUST.sources);
  for (const point of [{ x: 40, z: 82 }, { x: 20, z: 70 }, { x: -30, z: 50 }, { x: -10, z: -40 }, { x: 100, z: 100 }]) {
    const h = TERRAIN.heightAt(point.x, point.z);
    assert.deepEqual(cooledCrustFieldAt(point.x, point.z, h, again.cooledCrust),
      cooledCrustFieldAt(point.x, point.z, h, CRUST), `the field drifted at ${point.x}, ${point.z}`);
  }

  // The switchboard, and the rule that the crust cannot outlive its lava.
  assert.equal(planCooledCrust(TERRAIN, { ...MAP_CONFIG, cooledCrustEnabled: false }), null);
  assert.equal(planCooledCrust(TERRAIN, { ...MAP_CONFIG, cooledCrust: false }), null);
  assert.equal(planCooledCrust(TERRAIN, { ...MAP_CONFIG, cooledCrust: null }), null);
  const noPool = makeTerrain({ ...MAP_CONFIG, lavaPoolEnabled: false });
  assert.equal(noPool.cooledCrust, null, 'no lava, no crust');
  assert.equal(noPool.cooledCrustReport, null);
  assert.equal(noPool.geometry.userData.cooledCrust, null);
  assert.equal(noPool.geometry.getAttribute('aCooledCrust'), undefined);
  const wrongSector = { ...TERRAIN, sectorId: 'HEX_S' };
  assert.equal(planCooledCrust(wrongSector, MAP_CONFIG), null, 'the crust belongs to HEX_SE');
  assert.equal(planCooledCrust(null, MAP_CONFIG), null);

  // Without the branch the crust keeps the pool and the main flow; without the
  // flows it keeps the pool's own shore.
  const mainOnly = makeTerrain({ ...MAP_CONFIG, lavaSecondaryFlowEnabled: false });
  assert.deepEqual([...mainOnly.cooledCrust.sources], [TERRAIN.lavaPool.id, TERRAIN.lavaFlow.id]);
  const poolOnly = makeTerrain({ ...MAP_CONFIG, lavaFlowEnabled: false });
  assert.deepEqual([...poolOnly.cooledCrust.sources], [TERRAIN.lavaPool.id]);
  assert.equal(poolOnly.cooledCrust.channels.length, 0);
});

test('the crust keeps to the lava: a fringe around it, never a covering', () => {
  const report = TERRAIN.cooledCrustReport;
  assert.ok(report, 'the bake reports what the crust reached');
  // The crust is a few percent of the sector: concentrated on the lava.
  assert.ok(report.share > 0.005, `only ${(report.share * 100).toFixed(2)}% of the sector wears crust`);
  assert.ok(report.share < 0.06, `${(report.share * 100).toFixed(2)}% of the sector is crust — that is a covering`);
  assert.equal(report.vertices, TERRAIN.geometry.userData.cooledCrustVertices);
  assert.ok(report.meanCoverage > 0.4, 'the crust it does lay down is barely there');
  assert.ok(report.hottest > 0.5, 'the crust never holds any heat');

  // Far from the lava the field is exactly zero: the rest of HEX_SE is the rock
  // it was baked with.
  let far = 0;
  for (const point of interiorPoints(500)) {
    const distance = distanceToLava(point.x, point.z);
    if (distance < 26) continue;
    far += 1;
    const field = cooledCrustFieldAt(point.x, point.z, TERRAIN.heightAt(point.x, point.z), CRUST);
    assert.deepEqual(field, { coverage: 0, heat: 0 }, `crust leaked to (${point.x}, ${point.z})`);
  }
  assert.ok(far > 300, 'the sample never left the crust band');
  // Outside the plan's own bound nothing is even measured.
  const outside = cooledCrustFieldAt(
    CRUST.bounds.max.x + 1, CRUST.bounds.max.y + 1, 0, CRUST,
  );
  assert.deepEqual(outside, { coverage: 0, heat: 0 });

  // Every one of the three molten surfaces wears its own crust.
  const pool = TERRAIN.lavaPool;
  for (let i = 0; i < 24; i += 1) {
    const bearing = (i / 24) * Math.PI * 2;
    const shore = distanceToShore(bearing);
    const x = pool.x + Math.cos(bearing) * (shore + 1.5);
    const z = pool.z + Math.sin(bearing) * (shore + 1.5);
    const field = cooledCrustFieldAt(x, z, TERRAIN.heightAt(x, z), CRUST);
    assert.ok(field.coverage > 0.5, `the pool's shore at bearing ${bearing.toFixed(2)} has no crust`);
  }
  for (const flow of [TERRAIN.lavaFlow, TERRAIN.lavaSecondaryFlow]) {
    let covered = 0;
    for (const sample of flow.samples.filter((_, k) => k % 6 === 2)) {
      const x = sample.x + sample.nx * (sample.left + 0.8);
      const z = sample.z + sample.nz * (sample.left + 0.8);
      const field = cooledCrustFieldAt(x, z, TERRAIN.heightAt(x, z), CRUST);
      if (field.coverage > 0.5) covered += 1;
    }
    assert.ok(covered > flow.samples.length / 6 * 0.6, `${flow.id} runs without its crust`);
  }

  // And it never reaches a doorway or a shared edge.
  for (const gate of gateAprons) {
    const field = cooledCrustFieldAt(gate.x, gate.z, TERRAIN.heightAt(gate.x, gate.z), CRUST);
    assert.deepEqual(field, { coverage: 0, heat: 0 }, 'the crust reached a gate apron');
  }
  for (let v = 0; v < TERRAIN.vertexCount; v += 1) {
    if (!TERRAIN.isRim[v]) continue;
    const attribute = TERRAIN.geometry.getAttribute('aCooledCrust');
    assert.equal(attribute.getX(v), 0, 'the shared rim carries crust');
    assert.equal(attribute.getY(v), 0);
  }
});

test('the crust breaks into irregular plates, and its heat stays with the lava', () => {
  const pool = TERRAIN.lavaPool;
  const radii = CRUST.shoreline.radii;
  const shoreAt = (bearing) => {
    const at = (bearing / (Math.PI * 2)) * radii.length;
    const i = Math.floor(at);
    return radii[i] + (radii[(i + 1) % radii.length] - radii[i]) * (at - i);
  };
  const fieldAt = (x, z) => cooledCrustFieldAt(x, z, TERRAIN.heightAt(x, z), CRUST);

  // Walk out on many bearings and record where the crust finally stops: the
  // margin's reach has to wander, and some stretches have to stay bare — a
  // crust that rings the pool evenly is a contour someone drew.
  const reaches = [];
  for (let i = 0; i < 48; i += 1) {
    const bearing = (i / 48) * Math.PI * 2;
    const shore = shoreAt(bearing);
    let reach = 0;
    for (let r = 1; r <= 30; r += 0.5) {
      const x = pool.x + Math.cos(bearing) * (shore + r);
      const z = pool.z + Math.sin(bearing) * (shore + r);
      if (fieldAt(x, z).coverage > 0.05) reach = r;
    }
    reaches.push(reach);
  }
  const shortest = Math.min(...reaches);
  const longest = Math.max(...reaches);
  assert.ok(longest > 6, `the crust never reaches out (${longest})`);
  assert.ok(longest / Math.max(1, shortest) > 1.4, `the margin is a ring: ${shortest}..${longest}`);
  assert.ok(shortest < longest * 0.6, 'no bearing is left bare: the crust is a collar, not a crust');

  // The plates: coverage along a line out of the lava must rise and fall again
  // — crust, bare rock, crust — not one smooth fade to nothing.
  let bearingsWithPlates = 0;
  let dipsTotal = 0;
  for (let i = 0; i < 12; i += 1) {
    const bearing = 0.2 + i * 0.52;
    const shore = shoreAt(bearing);
    let previous = 1;
    let dips = 0;
    for (let r = 2; r <= 13; r += 0.3) {
      const x = pool.x + Math.cos(bearing) * (shore + r);
      const z = pool.z + Math.sin(bearing) * (shore + r);
      const field = fieldAt(x, z);
      if (previous > 0.35 && field.coverage < 0.18) dips += 1;
      previous = field.coverage;
    }
    dipsTotal += dips;
    if (dips >= 1) bearingsWithPlates += 1;
  }
  assert.ok(bearingsWithPlates >= 3, `the crust never breaks into plates (dips: ${dipsTotal})`);

  // Heat: strong against the lava, gone a few units further out, and never on
  // ground the crust itself does not cover.
  const shore = shoreAt(0.45);
  const at = (extra) => fieldAt(pool.x + Math.cos(0.45) * (shore + extra), pool.z + Math.sin(0.45) * (shore + extra));
  assert.ok(at(1).heat > 0.3, `the waterline holds no heat (${at(1).heat.toFixed(2)})`);
  assert.ok(at(1).heat <= 1);
  assert.equal(at(CRUST.pool.heatReach + 8).heat, 0, 'the heat outlives its crust');
  let hot = 0;
  for (let i = 0; i < 48; i += 1) {
    const bearing = (i / 48) * Math.PI * 2;
    const near = fieldAt(pool.x + Math.cos(bearing) * (shoreAt(bearing) + 1),
      pool.z + Math.sin(bearing) * (shoreAt(bearing) + 1));
    if (near.heat > 0) {
      hot += 1;
      assert.ok(near.coverage > 0, 'heat on bare rock at the waterline');
    }
  }
  assert.ok(hot > 12, `the crust shows heat on only ${hot} of 48 bearings`);
  // Beyond every heat reach in the plan, nothing glows — the red stays with the
  // lava it came from.
  const farthestHeat = Math.max(CRUST.pool.heatReach, ...CRUST.channels.map((c) => c.heatReach)) * 1.5;
  let checked = 0;
  for (const point of interiorPoints(600)) {
    const distance = distanceToLava(point.x, point.z);
    if (distance < farthestHeat || distance > 90) continue;
    checked += 1;
    const field = fieldAt(point.x, point.z);
    assert.equal(field.heat, 0, `heat ${(distance).toFixed(1)} units from the lava`);
    assert.ok(field.heat === 0 || field.coverage > 0, `heat on bare rock at (${point.x}, ${point.z})`);
  }
  assert.ok(checked > 150, 'the far field was never checked for heat');
});

test('the crust tile is a seamless pair: black plates, cracked sections, a dull red heat', () => {
  const textures = createCooledCrustTextures(MAP_CONFIG);
  for (const texture of [textures.map, textures.heat]) {
    assert.ok(texture.isDataTexture);
    assert.equal(texture.image.width, MAP_CONFIG.cooledCrustTextureSize);
    assert.equal(texture.wrapS, THREE.RepeatWrapping);
    assert.equal(texture.wrapT, THREE.RepeatWrapping);
  }
  const size = textures.map.image.width;
  const albedo = textures.map.image.data;
  const heat = textures.heat.image.data;
  const at = (buffer, x, y) => {
    const px = ((x % size) + size) % size;
    const py = ((y % size) + size) % size;
    return [buffer[(py * size + px) * 4], buffer[(py * size + px) * 4 + 1], buffer[(py * size + px) * 4 + 2]];
  };
  const step = (buffer, x1, y1, x2, y2) => {
    const a = at(buffer, x1, y1);
    const b = at(buffer, x2, y2);
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  };
  // Seamless in both directions: a step across the seam must be no rougher than
  // a step between two neighbouring texels inside the tile, or the repeat would
  // draw a line across the ground.
  for (const buffer of [albedo, heat]) {
    for (let k = 0; k < size; k += 3) {
      // The seam may be no rougher than the roughest step the tile's own cracks
      // make inside it: a repeat that jumps more than a crack edge is a seam.
      const stepsX = Array.from({ length: size }, (_, x) => step(buffer, x, k, x + 1, k));
      const seamX = step(buffer, size - 1, k, 0, k);
      assert.ok(seamX <= Math.max(...stepsX), `a visible seam horizontally at row ${k}`);
      const stepsY = Array.from({ length: size }, (_, y) => step(buffer, k, y, k, y + 1));
      const seamY = step(buffer, k, size - 1, k, 0);
      assert.ok(seamY <= Math.max(...stepsY), `a visible seam vertically at column ${k}`);
    }
  }

  // Dark black crust: the albedo's mean is far below the basalt it sits on.
  let sum = 0;
  let lowest = 255;
  let highest = 0;
  for (let i = 0; i < size * size; i += 1) {
    const luma = (albedo[i * 4] + albedo[i * 4 + 1] + albedo[i * 4 + 2]) / 3;
    sum += luma;
    lowest = Math.min(lowest, luma);
    highest = Math.max(highest, luma);
  }
  const mean = sum / (size * size);
  assert.ok(mean < 60, `the crust's mean albedo is ${mean.toFixed(1)}: that is not black`);
  assert.ok(highest < 150, 'a cooled plate should not be brighter than ash');
  // Cracked sections: the fissures are a good deal darker than the plates.
  assert.ok(lowest < mean * 0.6, `the cracks do not read (${lowest} against a mean of ${mean.toFixed(1)})`);
  assert.ok(highest > mean * 1.15, 'every plate is the same tone');

  // The heat map is almost all black rock, and what glows is red, not white.
  let glowing = 0;
  let reddish = 0;
  for (let i = 0; i < size * size; i += 1) {
    const [r, g, b] = [heat[i * 4], heat[i * 4 + 1], heat[i * 4 + 2]];
    if (r + g + b > 24) {
      glowing += 1;
      // Red heat: the red channel carries it, at every brightness.
      if (r > g * 1.9 + 4 && r > b * 1.9 + 4) reddish += 1;
    }
  }
  assert.ok(glowing / (size * size) < 0.4, 'the whole tile glows: the heat is not subtle');
  assert.ok(glowing > size * 4, 'the tile carries no heat at all');
  assert.equal(reddish, glowing, 'what glows is not red');

  // One cached pair per look, so the pool, the flows and the world agree.
  const a = cooledCrustTextures(MAP_CONFIG);
  const b = cooledCrustTextures(MAP_CONFIG);
  assert.equal(a, b, 'the same configuration hands back the same tiles');
  assert.equal(a.map, b.map);
});

test('the crust writes one attribute onto the lattice and moves nothing else', () => {
  const attribute = TERRAIN.geometry.getAttribute('aCooledCrust');
  assert.ok(attribute, 'the crust rides the terrain lattice');
  assert.equal(attribute.itemSize, 4);
  assert.equal(attribute.count, TERRAIN.vertexCount);
  assert.equal(attribute.name, 'aCooledCrust');

  // Nothing about the ground moved: the crust is a colour, not a formation.
  assert.deepEqual(TERRAIN.heights, WITHOUT.heights, 'the crust moved the ground');
  assert.deepEqual([...TERRAIN.geometry.userData.heightRange], [...WITHOUT.geometry.userData.heightRange]);
  assert.equal(TERRAIN.geometry.userData.maxSlopeDegrees, WITHOUT.geometry.userData.maxSlopeDegrees);
  assert.deepEqual(TERRAIN.vents, WITHOUT.vents);
  assert.deepEqual(TERRAIN.lavaPoolReport, WITHOUT.lavaPoolReport);
  assert.deepEqual(TERRAIN.lavaFlowReport, WITHOUT.lavaFlowReport);
  assert.deepEqual(TERRAIN.lavaSecondaryFlowReport, WITHOUT.lavaSecondaryFlowReport);
  assert.deepEqual(
    TERRAIN.geometry.getAttribute('color').array,
    WITHOUT.geometry.getAttribute('color').array,
    'the crust repainted the rock it did not reach',
  );
  assert.deepEqual(
    TERRAIN.geometry.getAttribute('position').array,
    WITHOUT.geometry.getAttribute('position').array,
  );

  // The attribute agrees with the field, vertex by vertex.
  for (let v = 0; v < TERRAIN.vertexCount; v += 7) {
    const x = TERRAIN.positions[v * 3];
    const z = TERRAIN.positions[v * 3 + 2];
    const field = cooledCrustFieldAt(x, z, TERRAIN.heights[v], CRUST);
    assert.ok(Math.abs(attribute.getX(v) - field.coverage) < 1e-6);
    assert.ok(Math.abs(attribute.getY(v) - field.heat) < 1e-6);
    assert.ok(attribute.getX(v) >= 0 && attribute.getX(v) <= 1);
    assert.ok(attribute.getY(v) >= 0 && attribute.getY(v) <= 1);
    assert.ok(Math.abs(attribute.getZ(v)) < 40, 'the tile UV stays near the origin');
  }
  // The crust carries nothing where the lava is far: every vertex more than a
  // crust's reach from any molten surface is exactly zero...
  let checked = 0;
  for (let v = 0; v < TERRAIN.vertexCount; v += 1) {
    const x = TERRAIN.positions[v * 3];
    const z = TERRAIN.positions[v * 3 + 2];
    if (distanceToLava(x, z) < 28) continue;
    checked += 1;
    assert.equal(attribute.getX(v), 0, `crust far from lava at (${x}, ${z})`);
    assert.equal(attribute.getY(v), 0);
  }
  assert.ok(checked > TERRAIN.vertexCount * 0.7, 'the far field was never checked');
  // ...and every vertex the crust does reach lies inside the plan's own bound.
  for (let v = 0; v < TERRAIN.vertexCount; v += 1) {
    if (attribute.getX(v) <= 0) continue;
    const x = TERRAIN.positions[v * 3];
    const z = TERRAIN.positions[v * 3 + 2];
    assert.ok(x >= CRUST.bounds.min.x && x <= CRUST.bounds.max.x
      && z >= CRUST.bounds.min.y && z <= CRUST.bounds.max.y, `crust outside its bound at (${x}, ${z})`);
  }

  // Writing it by hand gives exactly what the bake wrote.
  const manual = writeCooledCrustAttribute(TERRAIN, CRUST);
  assert.deepEqual(manual.array, attribute.array);
  assert.equal(writeCooledCrustAttribute(TERRAIN, null), null);
});

test('the crust is drawn by the sector\'s own material, statically and switchably', () => {
  const material = new THREE.MeshStandardMaterial({ color: 0x4f5157, vertexColors: true });
  const installed = installCooledCrust(material, CRUST, MAP_CONFIG);
  assert.equal(installed, material, 'the crust installs into the material it is given');

  // The patch lands on the renderer's own standard shader: every anchor found,
  // in the order the shader needs them.
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader);
  const report = material.userData.cooledCrust.patches;
  assert.deepEqual(report.missing, [], `anchors missing: ${report.missing.join(', ')}`);
  assert.equal(report.landed, 5, 'one vertex pars, one vertex main, three fragment insertions');
  assert.ok(shader.fragmentShader.indexOf('vec3 totalEmissiveRadiance = emissive;')
    < shader.fragmentShader.indexOf('cooledCrustCoverage'),
  'the heat is added after the emissive exists');
  assert.ok(shader.fragmentShader.includes('diffuseColor.rgb = mix( diffuseColor.rgb, cooledCrustAlbedo, cooledCrustCoverage );'));
  assert.ok(shader.fragmentShader.includes('roughnessFactor = mix( roughnessFactor, cooledCrustRoughness'));
  assert.ok(shader.vertexShader.includes('attribute vec4 aCooledCrust;'));
  assert.ok(shader.vertexShader.startsWith('#define USE_COOLED_CRUST'));
  assert.ok(shader.fragmentShader.startsWith('#define USE_COOLED_CRUST'));
  for (const name of ['cooledCrustMap', 'cooledCrustHeatMap', 'cooledCrustColor', 'cooledCrustWarmth',
    'cooledCrustEmissive', 'cooledCrustEmissiveIntensity', 'cooledCrustRoughness']) {
    assert.ok(shader.uniforms[name], `the shader lost the ${name} uniform`);
  }
  assert.ok(shader.uniforms.cooledCrustMap.value.isDataTexture);
  assert.ok(shader.uniforms.cooledCrustHeatMap.value.isDataTexture);
  assert.equal(shader.uniforms.cooledCrustEmissiveIntensity.value, MAP_CONFIG.cooledCrustEmissiveIntensity);
  assert.equal(typeof material.customProgramCacheKey(), 'string');
  assert.notEqual(material.customProgramCacheKey(), new THREE.MeshStandardMaterial().customProgramCacheKey?.());

  // The patch functions are pure and count their own anchors.
  const vertexReport = { landed: 0, missing: [] };
  patchCooledCrustVertexShader('nothing here', vertexReport);
  assert.equal(vertexReport.landed, 0);
  assert.equal(vertexReport.missing.length, 2);
  const fragmentReport = { landed: 0, missing: [] };
  patchCooledCrustFragmentShader(THREE.ShaderLib.standard.fragmentShader, fragmentReport);
  assert.equal(fragmentReport.landed, 3);
  assert.deepEqual(fragmentReport.missing, []);

  // Static by construction: no clock, no tick, and a material with no crust is
  // left exactly as it was.
  assert.equal(material.userData.cooledCrust.animates, false);
  assert.deepEqual(material.userData.cooledCrust.sources, [...CRUST.sources]);
  const plain = new THREE.MeshStandardMaterial({ color: 0x4f5157 });
  const untouched = installCooledCrust(plain, null, MAP_CONFIG);
  assert.equal(untouched, plain);
  assert.equal(plain.userData.cooledCrust, undefined, 'an uncrusted material must stay plain');
  const plainShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  plain.onBeforeCompile(plainShader);
  assert.equal(plainShader.uniforms.cooledCrustMap, undefined, 'a plain material patched itself');
  assert.equal(installCooledCrust(null, CRUST, MAP_CONFIG), null);
});

test('the world carries the crust on HEX_SE\'s own floor, and nothing else', () => {
  const map = world();
  const off = worldWithout();
  assert.equal(map.cooledCrust, map.volcanicTerrain.cooledCrust);
  assert.equal(map.cooledCrust.id, 'cooled-crust-hex-se');
  assert.equal(map.volcanicRockMaterial.userData.cooledCrust.id, 'cooled-crust-hex-se');
  assert.equal(map.volcanicRockMaterial.userData.cooledCrust.animates, false);

  // The crust adds no object at all: the sector floor is still one mesh with
  // one material, and the molten surfaces are still exactly the three of them.
  assert.equal(map.group.children.length, off.group.children.length, 'the crust added an object to the world');
  const floor = map.sectorMeshes.get('HEX_SE');
  assert.equal(floor.material, map.volcanicRockMaterial);
  assert.equal(floor.geometry, map.volcanicTerrain.geometry);
  assert.ok(floor.geometry.getAttribute('aCooledCrust'), 'the HEX_SE floor lost the crust attribute');
  const molten = [];
  const crusted = [];
  map.group.traverse((object) => {
    if (!object.isMesh) return;
    if (object.userData.surface === 'molten-lava') molten.push(object);
    if (object.userData.surface === 'cooled-crust') crusted.push(object);
  });
  assert.equal(molten.length, 3, 'the lava set changed');
  assert.equal(crusted.length, 0, 'the crust must not be a mesh of its own');

  // Every other sector keeps the material it had: the crust is HEX_SE's.
  for (const [id, other] of map.sectorMeshes) {
    if (id === 'HEX_SE') continue;
    assert.equal(other.material.userData.cooledCrust, undefined, `${id} grew a crust`);
    assert.equal(other.geometry.getAttribute('aCooledCrust'), undefined, `${id} geometry grew an attribute`);
    assert.deepEqual(other.geometry.attributes.position.array,
      off.sectorMeshes.get(id).geometry.attributes.position.array, `${id} geometry changed`);
  }
  assert.equal(off.volcanicRockMaterial.userData.cooledCrust, undefined);
  assert.equal(off.volcanicTerrain.geometry.getAttribute('aCooledCrust'), undefined);

  // No new collision, no new obstacles, nothing in the update loop.
  const boxes = (world) => world.collisionBoxes.map(({ door, ...box }) => box);
  assert.deepEqual(boxes(map), boxes(off), 'the crust added a collider or a hazard');
  const attribute = map.volcanicTerrain.geometry.getAttribute('aCooledCrust');
  const before = attribute.array.slice();
  map.update(1, new THREE.Vector3(sector.center.x, 0, sector.center.z));
  map.update(1, new THREE.Vector3(sector.center.x + map.volcanicTerrain.lavaPool.x, 0,
    sector.center.z + map.volcanicTerrain.lavaPool.z));
  assert.deepEqual(attribute.array, before, 'the crust changed over time');
  assert.equal(map.cooledCrust.update, undefined);

  // The overview keeps the crust, exactly as it keeps the lava.
  map.setDebugVisible(true);
  assert.equal(map.volcanicTerrainMesh.visible, true);
  map.setDebugVisible(false);
});

test('the crust switches off without a trace and follows its lava', () => {
  const off = worldWithout();
  // Same world, same lava, no crust: every height and colour identical.
  const on = world();
  assert.deepEqual(off.volcanicTerrain.heights, on.volcanicTerrain.heights);
  assert.deepEqual(off.volcanicTerrain.geometry.getAttribute('color').array,
    on.volcanicTerrain.geometry.getAttribute('color').array);
  assert.deepEqual(off.volcanicTerrain.geometry.userData.heightRange,
    on.volcanicTerrain.geometry.userData.heightRange);
  assert.equal(off.volcanicTerrain.geometry.userData.cooledCrust, null);
  assert.equal(on.volcanicTerrain.geometry.userData.cooledCrust, 'cooled-crust-hex-se');

  // Disabling the lava the crust is measured from takes the crust with it.
  for (const override of [{ lavaPoolEnabled: false }, { lavaPool: false }, { lavaPool: null }]) {
    const terrain = makeTerrain({ ...MAP_CONFIG, ...override });
    assert.equal(terrain.cooledCrust, null, `crust survived ${JSON.stringify(override)}`);
    assert.equal(terrain.geometry.getAttribute('aCooledCrust'), undefined);
  }
  // A different seed rebuilds the same crust on a different landscape.
  const other = makeTerrain({ ...MAP_CONFIG, volcanicTerrainSeed: MAP_CONFIG.volcanicTerrainSeed + 7 });
  assert.ok(other.cooledCrust, 'a reseeded sector still carries its crust');
  assert.notEqual(other.cooledCrust.pool.level, CRUST.pool.level);
  const otherShore = other.cooledCrust.shoreline.radii[0];
  const x = other.cooledCrust.pool.x + otherShore + 2;
  const z = other.cooledCrust.pool.z;
  const field = cooledCrustFieldAt(x, z, other.heightAt(x, z), other.cooledCrust);
  assert.ok(field.coverage > 0.3, 'the reseeded crust does not sit on its own shore');
});
