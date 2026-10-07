/**
 * A software previewer for the small debris of HEX_SE (development only).
 *
 * The debris layer is drawn as instanced meshes, which the software rasteriser
 * in `preview.mjs` cannot read — so this tool bakes every instance into one
 * merged geometry first, exactly the way the GPU would place it, and then
 * renders the result: a top-down plan of the sector (where the layer must read
 * as bands, not as a carpet) and a few eye-height close-ups against the
 * terrain, the landmark formations and the medium rocks beside it.
 *
 *   node tools/debris-preview.mjs [outDir]
 *
 * Default outDir is `previews/`, which is gitignored. Nothing here is imported
 * by `src/`, and `vite build` never sees it.
 *
 * The ground is drawn as plain basalt: the cooled crust and the molten sheets
 * are shader work on the sector's own material, and neither is simulated here.
 */

import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { VolcanicTerrain } from '../src/world/VolcanicTerrain.js';
import { buildVolcanicFormations } from '../src/world/VolcanicFormations.js';
import { buildVolcanicRocks } from '../src/world/VolcanicRocks.js';
import { buildVolcanicDebris } from '../src/world/VolcanicDebris.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { renderToBuffer, savePng } from './preview.mjs';

const RADIUS = MAP_CONFIG.hexRadius;
const data = buildHexMapData(RADIUS);
const sector = data.byId.get('HEX_SE');
const gateAprons = data.sharedEdges
  .filter((gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE')
  .map((gate) => ({ x: gate.center.x - sector.center.x, z: gate.center.z - sector.center.z }));

const terrain = new VolcanicTerrain({ radius: RADIUS, config: MAP_CONFIG, sectorId: 'HEX_SE', gateAprons });
const formations = buildVolcanicFormations(terrain, MAP_CONFIG);
const rocks = buildVolcanicRocks(terrain, MAP_CONFIG, { formations });
const debris = buildVolcanicDebris(terrain, MAP_CONFIG, { formations, rocks });
if (!debris) throw new Error('this configuration carries no debris to preview');
console.log('debris:', debris.userData.debrisCount, 'pieces,', debris.userData.meshCount, 'instanced meshes');

/**
 * Bake the instance matrices of a group of InstancedMeshes into merged,
 * world-space vertex colours — the software rasteriser reads plain meshes.
 */
function bakeInstances(group, material) {
  const baked = new THREE.Group();
  baked.name = `${group.name}_baked`;
  group.updateWorldMatrix(true, true);
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const tint = new THREE.Color();
  for (const mesh of group.children) {
    const position = mesh.geometry.getAttribute('position');
    const color = mesh.geometry.getAttribute('color');
    const positions = [];
    const colors = [];
    for (let instance = 0; instance < mesh.count; instance += 1) {
      mesh.getMatrixAt(instance, matrix);
      if (mesh.instanceColor) mesh.getColorAt(instance, tint);
      else tint.setRGB(1, 1, 1);
      for (let vertex = 0; vertex < position.count; vertex += 1) {
        point.fromBufferAttribute(position, vertex).applyMatrix4(matrix);
        positions.push(point.x, point.y, point.z);
        colors.push(
          color.getX(vertex) * tint.r,
          color.getY(vertex) * tint.g,
          color.getZ(vertex) * tint.b,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    baked.add(new THREE.Mesh(geometry, material));
  }
  return baked;
}

const debrisMesh = bakeInstances(debris, new THREE.MeshBasicMaterial({
  color: 0xff4d3a, vertexColors: false, side: THREE.DoubleSide,
}));
const rocksMesh = bakeInstances(rocks, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));

// The sector's own ground, drawn as the baked mesh the explorer walks on.
const ground = new THREE.Mesh(terrain.geometry, new THREE.MeshBasicMaterial({
  color: MAP_CONFIG.volcanicRockColor ?? 0x4f5157,
  vertexColors: true,
  side: THREE.DoubleSide,
}));
// The six landmarks are separate meshes; merge them into one for the preview.
const landmarks = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
  vertexColors: true, side: THREE.DoubleSide,
}));
{
  const positions = [];
  const colors = [];
  for (const formation of formations.children) {
    const mesh = formation.children[0];
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    const matrix = new THREE.Matrix4().copy(mesh.matrixWorld);
    const position = geometry.getAttribute('position');
    const color = geometry.getAttribute('color');
    const point = new THREE.Vector3();
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      point.fromBufferAttribute(position, vertex).applyMatrix4(matrix);
      positions.push(point.x, point.y, point.z);
      colors.push(color.getX(vertex), color.getY(vertex), color.getZ(vertex));
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  landmarks.geometry = merged;
}

const outDir = (process.argv[2] ?? 'previews').replace(/\/$/, '');

/* ---- The plan: where the debris is allowed to collect -------------------- */

const SIZE = 900;
const SPAN = RADIUS * 2.08;
const planCamera = new THREE.OrthographicCamera(-SPAN / 2, SPAN / 2, SPAN / 2, -SPAN / 2, 1, 2000);
planCamera.position.set(0, 900, 0);
planCamera.lookAt(0, 0, 0);
planCamera.updateMatrixWorld(true);
planCamera.updateProjectionMatrix();

const plan = renderToBuffer(ground, planCamera, { width: SIZE, height: SIZE, background: 0x14171c });
{
  // The debris itself is sub-pixel at this scale, so each piece is marked with
  // a three-pixel dot: the picture answers "is it in bands or everywhere".
  const matrix = new THREE.Matrix4()
    .multiply(planCamera.projectionMatrix)
    .multiply(planCamera.matrixWorldInverse);
  const corner = new THREE.Vector4();
  for (const placement of debris.userData.placements) {
    corner.set(placement.x, placement.y, placement.z, 1).applyMatrix4(matrix);
    const px = Math.round((corner.x / corner.w * 0.5 + 0.5) * SIZE);
    const py = Math.round((0.5 - corner.y / corner.w * 0.5) * SIZE);
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const x = px + ox;
        const y = py + oy;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const offset = (y * SIZE + x) * 4;
        plan.data[offset] = 255;
        plan.data[offset + 1] = 214;
        plan.data[offset + 2] = 92;
        plan.data[offset + 3] = 255;
      }
    }
  }
  savePng(`${outDir}/debris-plan.png`, plan);
  console.log('wrote', `${outDir}/debris-plan.png`);
}

/* ---- Close-ups: how a chip reads beside the rock it fell off ------------- */

const scene = new THREE.Group();
scene.add(ground, landmarks, rocksMesh, debrisMesh);

// The rasteriser's default rig is a cool, low sun; these close-ups are about
// reading silhouettes, so they are lit flat and bright on purpose.
const LIGHTS = [
  { direction: new THREE.Vector3(0.35, 0.85, 0.4).normalize(), color: new THREE.Color(0xfff4e0), intensity: 0.55, ambient: 0.75 },
  { direction: new THREE.Vector3(-0.5, 0.3, -0.6).normalize(), color: new THREE.Color(0x9fc4d8), intensity: 0.2, ambient: 0.35 },
];

function view(name, { eye, target, fov = 42 }) {
  const camera = new THREE.PerspectiveCamera(fov, 4 / 3, 0.1, 4000);
  camera.position.set(eye.x, eye.y, eye.z);
  camera.lookAt(target.x, target.y, target.z);
  const image = renderToBuffer(scene, camera, { width: 840, height: 630, background: 0x272c34, lights: LIGHTS });
  savePng(`${outDir}/${name}.png`, image);
  console.log('wrote', `${outDir}/${name}.png`);
}

const crater = terrain.layout.crater;
// On the crater's rim: the band where the largest share of the debris sits.
{
  const bearing = 0.6;
  const rim = terrain.craterRimRadiusAt(
    Math.cos(bearing) * crater.rimRadius, Math.sin(bearing) * crater.rimRadius, crater,
  );
  const x = crater.x + Math.cos(bearing) * rim;
  const z = crater.z + Math.sin(bearing) * rim;
  const y = terrain.heightAt(x, z);
  view('debris-rim', {
    eye: { x: x + 5.5, y: y + 2.2, z: z + 5.5 },
    target: { x, y: y + 0.3, z },
  });
}
// A wide pass along the rim: how much rubble the crater's edge actually wears.
{
  const bearing = 0.6;
  const rim = terrain.craterRimRadiusAt(
    Math.cos(bearing) * crater.rimRadius, Math.sin(bearing) * crater.rimRadius, crater,
  );
  const x = crater.x + Math.cos(bearing) * rim;
  const z = crater.z + Math.sin(bearing) * rim;
  const y = terrain.heightAt(x, z);
  const along = { x: -Math.sin(bearing), z: Math.cos(bearing) };
  view('debris-rim-wide', {
    eye: { x: x - along.x * 26 + 9, y: y + 7, z: z - along.z * 26 + 9 },
    target: {
      x: x + along.x * 12,
      y: terrain.heightAt(x + along.x * 12, z + along.z * 12) + 1,
      z: z + along.z * 12,
    },
    fov: 55,
  });
}
// At the foot of the shear cliff: debris against a landmark the size of a hill.
{
  const formation = formations.children.find((child) => child.userData.formationId === 'eastern-shear-cliff');
  const x = formation.position.x + 30;
  const z = formation.position.z + 12;
  const y = terrain.heightAt(x, z);
  view('debris-formation', {
    eye: { x: x + 12, y: y + 4, z: z + 12 },
    target: { x: formation.position.x, y: terrain.heightAt(formation.position.x, formation.position.z) + 6, z: formation.position.z },
    fov: 50,
  });
}
// Close enough to the ground to judge a single chip beside a single rock: the
// densest pocket of the layer, found rather than guessed.
{
  let best = null;
  let bestScore = -1;
  for (const placement of debris.userData.placements) {
    let score = 0;
    for (const other of debris.userData.placements) {
      if (other === placement) continue;
      if (Math.hypot(other.x - placement.x, other.z - placement.z) < 5) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = placement; }
  }
  const y = best.y;
  view('debris-closeup', {
    eye: { x: best.x + 1.9, y: y + 1.15, z: best.z + 1.9 },
    target: { x: best.x, y: y + 0.1, z: best.z },
    fov: 40,
  });
}
// On the main channel's bank: debris at the edge of the molten rock.
{
  const sample = terrain.lavaFlow.samples[Math.floor(terrain.lavaFlow.samples.length * 0.55)];
  const x = sample.x + sample.nx * (sample.left + 2.4);
  const z = sample.z + sample.nz * (sample.left + 2.4);
  const y = terrain.heightAt(x, z);
  view('debris-channel', {
    eye: { x: x + 4, y: y + 1.8, z: z + 4 },
    target: { x: sample.x, y: sample.y, z: sample.z },
    fov: 46,
  });
}
