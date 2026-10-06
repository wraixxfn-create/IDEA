/**
 * Flight preview: the flock's own animation, rendered frame by frame.
 *
 *   node tools/bird-flight.mjs [species]
 *
 * Development tool only. Instead of posing a rig by hand, this runs the real
 * flock simulation — the same `buildForestBirds` the world uses, on a stand-in
 * grove — and snapshots birds at the moment they reach each state the wood
 * cares about: perched, taking off, on the upstroke, on the downstroke, gliding,
 * flaring to land, flushed, and hopping on the floor. Each snapshot is rendered
 * through `tools/preview.mjs` into `previews/flight-*.png`.
 *
 * If the birds look wrong here, they look wrong in the game: nothing in this
 * file poses anything.
 */

import * as THREE from 'three';
import { mkdirSync } from 'node:fs';
import { renderToBuffer, renderContactSheet, savePng } from './preview.mjs';
import { BIRD_SPECIES, buildForestBirds } from '../src/world/ForestBirds.js';

const speciesId = process.argv[2] ?? 'chaffinch';
const species = BIRD_SPECIES[speciesId];
if (!species) {
  console.error(`Unknown species ${speciesId}`);
  process.exit(1);
}

/* A stand-in grove and floor, sized like the real sector. */
const trees = [];
for (let index = 0; index < 170; index += 1) {
  const angle = index * 2.4;
  const radius = 14 + (index % 11) * 18;
  trees.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, scale: 0.62 + (index % 5) * 0.12 });
}
const heightAt = (x, z) => Math.sin(x * 0.02) * 2 + Math.cos(z * 0.03) * 3;
const sector = { id: 'HEX_S', order: 5, center: { x: 0, z: 0 } };
const flock = buildForestBirds(
  sector,
  { hexRadius: 220, floorHeight: 0, forestBirdCount: 9, forestBirdSpecies: [speciesId] },
  { heightAt, trees },
);

/* What we want a picture of, in the order of a bird's day. */
const WANTED = [
  { name: 'perched', label: 'perched', match: (bird) => bird.state === 'perched' && bird.stateTime > 1 },
  { name: 'alert', label: 'flushed', match: (bird) => bird.alert > 0.3 },
  { name: 'takeoff', label: 'take-off', match: (bird) => bird.state === 'takeoff' || bird.state === 'flush' },
  { name: 'downstroke', label: 'downstroke', match: (bird) => bird.airborne && bird.wingSpread > 0.9 && Math.sin(bird.wingPhase) > 0.55 },
  { name: 'upstroke', label: 'upstroke', match: (bird) => bird.airborne && bird.wingSpread > 0.9 && Math.sin(bird.wingPhase) < -0.55 },
  { name: 'glide', label: 'glide', match: (bird) => bird.airborne && bird.glide > 0.75 },
  { name: 'landing', label: 'flaring to land', match: (bird) => bird.state === 'descend' || bird.state === 'hopDown' },
  { name: 'hop', label: 'hopping', match: (bird) => bird.state === 'hop' || bird.state === 'ground' || bird.state === 'forage' },
];

const shots = new Map();
const dt = 1 / 60;
// Walk the explorer through the middle of the wood: the flock does the rest.
for (let frame = 0; frame < 5400 && shots.size < WANTED.length; frame += 1) {
  const time = frame * dt;
  const player = new THREE.Vector3(
    Math.sin(time * 0.11) * 55,
    heightAt(0, 0),
    Math.cos(time * 0.07) * 55,
  );
  flock.update(dt, player);
  for (const wanted of WANTED) {
    if (shots.has(wanted.name)) continue;
    const bird = flock.birds.find((candidate) => wanted.match(candidate));
    if (!bird) continue;
    // Render the bird on its own, at the origin, so nothing else is in shot.
    // Take the bird out of the flock and stand it on the little stage. A
    // captured bird is never simulated again, so the pose in the picture is
    // exactly the pose the wood had that frame.
    const rig = bird.rig;
    const holder = new THREE.Group();
    flock.group.remove(rig.root);
    flock.birds.splice(flock.birds.indexOf(bird), 1);
    rig.root.position.set(0, 0, 0);
    holder.add(rig.root);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig.root);
    rig.root.position.set(0, -box.min.y + 0.02, 0);
    // Face the camera.
    rig.root.rotation.set(0, 0, 0);
    rig.root.updateMatrixWorld(true);
    shots.set(wanted.name, { holder, label: wanted.label, state: bird.state, phase: bird.wingPhase, bird });
  }
}

console.log('captured:', [...shots.keys()].join(', '));

/** Frame the lone bird from a given angle. */
function frame(root, azimuth, elevation, { pad = 1.3 } = {}) {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.2);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 200);
  const direction = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );
  camera.position.copy(center).addScaledVector(direction, radius * 3.1 * pad);
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

const VIEWS = [
  { name: 'front', azimuth: 0.02, elevation: 0.12, columns: 4 },
  { name: 'three-quarter', azimuth: Math.PI * 0.78, elevation: 0.34, columns: 4 },
];

const outDir = 'previews';
mkdirSync(outDir, { recursive: true });

// Every captured bird lives on one little stage; a cell shows exactly one.
const stage = new THREE.Group();
for (const shot of shots.values()) {
  shot.holder.visible = false;
  stage.add(shot.holder);
}

for (const view of VIEWS) {
  const entries = WANTED.filter((wanted) => shots.has(wanted.name));
  const camera = frame(shots.get(entries[0].name).holder, view.azimuth, view.elevation);
  const cells = entries.map((wanted) => () => {
    for (const [name, shot] of shots) shot.holder.visible = name === wanted.name;
    const cameraForCell = frame(shots.get(wanted.name).holder, view.azimuth, view.elevation);
    camera.position.copy(cameraForCell.position);
    camera.quaternion.copy(cameraForCell.quaternion);
    camera.updateMatrixWorld(true);
  });
  const sheet = renderContactSheet(stage, camera, cells, {
    columns: view.columns,
    cellWidth: 420,
    cellHeight: 380,
    label: `${speciesId} flight - ${view.name}`,
  });
  savePng(`${outDir}/flight-${speciesId}-${view.name}.png`, sheet);
  console.log(`wrote ${outDir}/flight-${speciesId}-${view.name}.png`);

  for (const wanted of entries) {
    const shot = shots.get(wanted.name);
    for (const [name, other] of shots) other.holder.visible = name === wanted.name;
    const cellCamera = frame(shot.holder, view.azimuth, view.elevation, { pad: 1.2 });
    const image = renderToBuffer(stage, cellCamera, { width: 640, height: 560, background: 0xe4ecef });
    savePng(`${outDir}/flight-${speciesId}-${wanted.name}-${view.name}.png`, image);
  }
}
