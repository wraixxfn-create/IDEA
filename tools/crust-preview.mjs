/**
 * A top-down previewer for the cooled crust of HEX_SE (development only).
 *
 * The crust is a shading pass on the baked ground, so the fastest way to see
 * it is to do exactly what its shader does, on the CPU, from straight above:
 * the basalt's own colour and vertex tint, blended with the crust tile by the
 * per-vertex coverage, plus the heat map's dull red, plus the molten sheets
 * drawn flat where they cover the ground. Nothing here is imported by `src/`,
 * and `vite build` never sees it.
 *
 *   node tools/crust-preview.mjs [outDir]
 *
 * Writes `crust-sector.png` (the whole hexagon, to check the crust stays a
 * fringe on the lava), one close-up per molten surface, and `crust-tile.png`
 * (the tile pair itself, albedo plus heat). Default outDir is `previews/`,
 * which is gitignored.
 */

import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { VolcanicTerrain } from '../src/world/VolcanicTerrain.js';
import {
  cooledCrustFieldAt,
  cooledCrustTextures,
  resolveCooledCrustMaterial,
} from '../src/world/CooledCrust.js';
import { lavaFlowSampleAt } from '../src/world/LavaFlow.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { savePng } from './preview.mjs';

const RADIUS = MAP_CONFIG.hexRadius;
const data = buildHexMapData(RADIUS);
const sector = data.byId.get('HEX_SE');
const gateAprons = data.sharedEdges
  .filter((gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE')
  .map((gate) => ({ x: gate.center.x - sector.center.x, z: gate.center.z - sector.center.z }));

const terrain = new VolcanicTerrain({ radius: RADIUS, config: MAP_CONFIG, sectorId: 'HEX_SE', gateAprons });
const crust = terrain.cooledCrust;
if (!crust) throw new Error('this configuration carries no cooled crust to preview');
const settings = resolveCooledCrustMaterial(MAP_CONFIG);
const textures = cooledCrustTextures(settings);
const albedoData = textures.map.image.data;
const heatData = textures.heat.image.data;
const size = textures.map.image.width;

const rockColor = new THREE.Color(MAP_CONFIG.volcanicRockColor ?? 0x4f5157);
const crustColor = new THREE.Color(settings.color);
const warmth = new THREE.Color(settings.warmth);
const emissive = new THREE.Color(settings.emissive);
const emissiveIntensity = settings.emissiveIntensity;
const tile = settings.crustTile;
const UV_COS = Math.cos(0.37);
const UV_SIN = Math.sin(0.37);

const colors = terrain.geometry.getAttribute('color');
const scratchNormal = new THREE.Vector3();
const LIGHT = new THREE.Vector3(-0.42, 0.62, -0.66).normalize();
const SUN = new THREE.Color(MAP_CONFIG.sunColor ?? 0xffe6bd);
const SKY = new THREE.Color(MAP_CONFIG.sunAmbientColor ?? 0xd7eee4);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function sampleTile(buffer, u, v) {
  const px = Math.floor((((u % 1) + 1) % 1) * size) % size;
  const py = Math.floor((((v % 1) + 1) % 1) * size) % size;
  const o = (py * size + px) * 4;
  return [srgbToLinear(buffer[o] / 255), srgbToLinear(buffer[o + 1] / 255), srgbToLinear(buffer[o + 2] / 255)];
}

function shoreRadiusAt(dx, dz) {
  const radii = crust.shoreline.radii;
  const bearing = (Math.atan2(dz, dx) + Math.PI * 2) % (Math.PI * 2);
  const at = (bearing / (Math.PI * 2)) * radii.length;
  const i = Math.floor(at);
  return radii[i] + (radii[(i + 1) % radii.length] - radii[i]) * (at - i);
}

/** The molten rock's own colour at a point, or null where there is no lava. */
function lavaAt(x, z) {
  const pool = terrain.lavaPool;
  const dx = x - pool.x;
  const dz = z - pool.z;
  const distance = Math.hypot(dx, dz);
  if (distance < shoreRadiusAt(dx, dz)) {
    const fraction = distance / Math.max(1e-3, shoreRadiusAt(dx, dz));
    const chill = Math.min(1, Math.max(0, (fraction - 0.55) / 0.4));
    return [1.1 - 0.85 * chill, 0.42 - 0.32 * chill, 0.12 - 0.07 * chill];
  }
  for (const flow of [terrain.lavaFlow, terrain.lavaSecondaryFlow]) {
    if (!flow) continue;
    const sample = lavaFlowSampleAt(x, z, flow);
    if (sample && sample.distance < sample.halfWidth) {
      const edge = sample.distance / Math.max(1e-3, sample.halfWidth);
      const cold = Math.min(1, Math.max(0, (edge - 0.55) / 0.45));
      return [1.05 - 0.85 * cold, 0.4 - 0.3 * cold, 0.11 - 0.06 * cold];
    }
  }
  return null;
}

/** One pixel of ground, shaded the way the crust's shader patch shades it. */
function pixel(x, z) {
  const lava = lavaAt(x, z);
  if (lava) return lava;
  terrain.normalAt(x, z, scratchNormal);
  const lambert = Math.max(0, scratchNormal.dot(LIGHT));
  const { indices, weights } = terrain.locate(x, z);
  let tr = 0;
  let tg = 0;
  let tb = 0;
  for (let k = 0; k < 3; k += 1) {
    tr += colors.getX(indices[k]) * weights[k];
    tg += colors.getY(indices[k]) * weights[k];
    tb += colors.getZ(indices[k]) * weights[k];
  }
  let r = rockColor.r * tr;
  let g = rockColor.g * tg;
  let b = rockColor.b * tb;

  const field = cooledCrustFieldAt(x, z, terrain.heightAt(x, z), crust);
  if (field.coverage > 0.001) {
    const u = (x * UV_COS - z * UV_SIN) / tile;
    const v = (x * UV_SIN + z * UV_COS) / tile;
    const albedo = sampleTile(albedoData, u, v);
    const heatTexel = sampleTile(heatData, u, v);
    const heat = field.heat * field.coverage;
    const cr = albedo[0] * crustColor.r * (1 + (warmth.r - 1) * heat);
    const cg = albedo[1] * crustColor.g * (1 + (warmth.g - 1) * heat);
    const cb = albedo[2] * crustColor.b * (1 + (warmth.b - 1) * heat);
    const c = field.coverage;
    r += (cr - r) * c;
    g += (cg - g) * c;
    b += (cb - b) * c;
    r += heatTexel[0] * emissive.r * emissiveIntensity * heat;
    g += heatTexel[1] * emissive.g * emissiveIntensity * heat;
    b += heatTexel[2] * emissive.b * emissiveIntensity * heat;
  }
  const shade = (colour, sun, sky) => colour * (sun * (0.34 + 0.72 * lambert) + sky * 0.3);
  return [shade(r, SUN.r, SKY.r), shade(g, SUN.g, SKY.g), shade(b, SUN.b, SKY.b)];
}

function render(path, cx, cz, span, pixels) {
  const image = { width: pixels, height: pixels, data: new Uint8Array(pixels * pixels * 4) };
  const step = span / pixels;
  for (let py = 0; py < pixels; py += 1) {
    for (let px = 0; px < pixels; px += 1) {
      const x = cx - span / 2 + (px + 0.5) * step;
      const z = cz - span / 2 + (py + 0.5) * step;
      const [r, g, b] = pixel(x, z);
      const o = (py * pixels + px) * 4;
      image.data[o] = Math.round(Math.min(1, Math.max(0, linearToSrgb(r))) * 255);
      image.data[o + 1] = Math.round(Math.min(1, Math.max(0, linearToSrgb(g))) * 255);
      image.data[o + 2] = Math.round(Math.min(1, Math.max(0, linearToSrgb(b))) * 255);
      image.data[o + 3] = 255;
    }
  }
  savePng(path, image);
  console.log('wrote', path);
}

const outDir = (process.argv[2] ?? 'previews').replace(/\/$/, '');
// The whole hexagon first: the crust must stay a fringe on the lava.
render(`${outDir}/crust-sector.png`, 0, 0, 440, 700);
render(`${outDir}/crust-pool.png`, terrain.lavaPool.x, terrain.lavaPool.z, 96, 768);
render(`${outDir}/crust-flow.png`, -6, 46, 110, 768);
render(`${outDir}/crust-branch.png`, -8, -40, 90, 700);

// The tile pair itself: albedo plus its heat, one tile at high magnification.
{
  const pixels = 512;
  const image = { width: pixels, height: pixels, data: new Uint8Array(pixels * pixels * 4) };
  for (let py = 0; py < pixels; py += 1) {
    for (let px = 0; px < pixels; px += 1) {
      const albedo = sampleTile(albedoData, px / pixels, py / pixels);
      const heatTexel = sampleTile(heatData, px / pixels, py / pixels);
      const o = (py * pixels + px) * 4;
      image.data[o] = Math.round(Math.min(1, linearToSrgb(albedo[0] + heatTexel[0] * emissive.r * emissiveIntensity)) * 255);
      image.data[o + 1] = Math.round(Math.min(1, linearToSrgb(albedo[1] + heatTexel[1] * emissive.g * emissiveIntensity)) * 255);
      image.data[o + 2] = Math.round(Math.min(1, linearToSrgb(albedo[2] + heatTexel[2] * emissive.b * emissiveIntensity)) * 255);
      image.data[o + 3] = 255;
    }
  }
  savePng(`${outDir}/crust-tile.png`, image);
  console.log('wrote', `${outDir}/crust-tile.png`);
}
