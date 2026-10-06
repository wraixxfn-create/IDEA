/**
 * Colour a rig's skin by the bone that drives each vertex and render it.
 *
 * `node tools/bird-bones.mjs [species] [pose] [view]`
 *
 * When a wing ends up somewhere unexpected, this answers "which piece is that?"
 * in one look.
 */

import * as THREE from 'three';
import { mkdirSync } from 'node:fs';
import { renderToBuffer, savePng } from './preview.mjs';
import { BIRD_SPECIES, BirdRig } from '../src/world/ForestBirds.js';

const BONE_COLORS = {
  Body: 0x4c72b0,
  Chest: 0xdd8452,
  Neck: 0x55a868,
  Head: 0xc44e52,
  BeakLower: 0x8172b3,
  Crest: 0x937860,
  Tail: 0xda8bc3,
  TailLeft: 0x8c8c8c,
  TailRight: 0x7f7f7f,
  'Wing.R': 0x1f9e89,
  'Forearm.R': 0xb07aa1,
  'Hand.R': 0xf0c04a,
  'Wing.L': 0x3b6ea5,
  'Forearm.L': 0x6f4e7c,
  'Hand.L': 0xbfa03a,
  'Leg.R': 0xccb974,
  'Shank.R': 0x64b5cd,
  'Foot.R': 0x9c755f,
  'ToesFront.R': 0xe07a5f,
  'ToesBack.R': 0xb2533a,
  'Leg.L': 0x8a7b3a,
  'Shank.L': 0x2f6f80,
  'Foot.L': 0x5c463a,
  'ToesFront.L': 0x91412a,
  'ToesBack.L': 0x6a3120,
};

const speciesId = process.argv[2] ?? 'chaffinch';
const poseName = process.argv[3] ?? 'folded';
const viewName = process.argv[4] ?? 'top';
const POSES = {
  folded: {},
  spread: { wingSpread: 1, legTuck: 1 },
  glide: { wingSpread: 1, glideBlend: 1, flapAmplitude: 0, legTuck: 1 },
};

const species = BIRD_SPECIES[speciesId];
const rig = new BirdRig(species, { seed: 7 });
rig.applyPose(POSES[poseName] ?? {});

// Recolour every mesh by bone group.
for (const mesh of rig.meshes) {
  const geometry = mesh.geometry;
  const skinIndex = geometry.attributes.skinIndex;
  const colors = new Float32Array(geometry.attributes.position.count * 4);
  for (let index = 0; index < geometry.attributes.position.count; index += 1) {
    const bone = rig.bones[skinIndex.getX(index)]?.name ?? 'Body';
    const color = new THREE.Color(BONE_COLORS[bone] ?? 0xff00ff);
    colors[index * 4] = color.r;
    colors[index * 4 + 1] = color.g;
    colors[index * 4 + 2] = color.b;
    colors[index * 4 + 3] = 1;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  mesh.material.vertexColors = true;
  mesh.material.needsUpdate = true;
}

const box = new THREE.Box3().setFromObject(rig.root);
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const radius = Math.max(size.length() * 0.5, 0.2);
const view = viewName === 'top'
  ? { azimuth: Math.PI * 0.5, elevation: 1.4 }
  : viewName === 'front'
    ? { azimuth: 0.02, elevation: 0.12 }
    : { azimuth: -Math.PI * 0.5, elevation: 0.08 };
const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 200);
const dir = new THREE.Vector3(
  Math.cos(view.elevation) * Math.sin(view.azimuth),
  Math.sin(view.elevation),
  Math.cos(view.elevation) * Math.cos(view.azimuth),
);
camera.position.copy(center).addScaledVector(dir, radius * 3.4);
camera.up.set(0, view.elevation > 1.2 ? 0 : 1, view.elevation > 1.2 ? -1 : 0);
camera.lookAt(center);
camera.updateMatrixWorld(true);

mkdirSync('previews', { recursive: true });
const image = renderToBuffer(rig.root, camera, { width: 720, height: 600, background: 0xeef2f4 });
savePng(`previews/bones-${speciesId}-${poseName}-${viewName}.png`, image);
console.log(`wrote previews/bones-${speciesId}-${poseName}-${viewName}.png`);
