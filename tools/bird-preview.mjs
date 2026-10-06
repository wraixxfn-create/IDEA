/**
 * Bird preview sheets.
 *
 *   node tools/bird-preview.mjs                     # all species, neutral pose
 *   node tools/bird-preview.mjs jay                 # one species
 *   node tools/bird-preview.mjs finch flap          # a named pose, contact sheet
 *
 * Development tool only: it renders the rig through `tools/preview.mjs` into
 * `previews/` so the model and its animation can be reviewed without a browser.
 */

import * as THREE from 'three';
import { mkdirSync } from 'node:fs';
import { renderToBuffer, renderContactSheet, savePng } from './preview.mjs';
import { BIRD_SPECIES, BirdRig } from '../src/world/ForestBirds.js';

const POSES = {
  neutral: {},
  'folded-neck': {
    bodyPitch: -0.1,
    footGrip: 1,
    tailPitch: 0.1,
    headYaw: 0.6,
    headPitch: -0.1,
    headRoll: 0.15,
    wingSpread: 0,
  },
  perched: {
    bodyPitch: -0.16,
    footGrip: 1,
    tailPitch: 0.14,
    headYaw: 0.5,
    headPitch: -0.14,
    headRoll: 0.2,
  },
  glide: {
    wingSpread: 1,
    glideBlend: 1,
    flapAmplitude: 0,
    bodyPitch: 0.04,
    legTuck: 1,
    tailSpread: 0.4,
    tailPitch: -0.04,
  },
  downstroke: {
    wingSpread: 1,
    flapPhase: Math.PI * 0.55,
    bodyPitch: -0.12,
    bodyBob: -0.02,
    legTuck: 1,
  },
  upstroke: {
    wingSpread: 1,
    flapPhase: -Math.PI * 0.55,
    bodyPitch: 0.12,
    bodyBob: 0.025,
    legTuck: 1,
  },
  land: {
    wingSpread: 1,
    flapPhase: 0.6,
    flapAmplitude: 0.75,
    bodyPitch: -0.5,
    legReach: 0.85,
    footGrip: 0.4,
    tailSpread: 0.8,
    tailPitch: 0.3,
  },
  hop: {
    wingSpread: 0.2,
    bodyPitch: -0.36,
    legKick: 0.5,
    legKickSide: 'R',
    legTuck: 0.3,
    tailPitch: -0.3,
    headPitch: 0.24,
    footGrip: 0.4,
  },
  preen: {
    wingSpread: 0.34,
    wingLift: 0.5,
    bodyPitch: -0.24,
    headYaw: 2.4,
    headPitch: 0.35,
    neckYaw: 0.8,
    footGrip: 1,
    tailPitch: 0.1,
  },
  sing: {
    bodyPitch: -0.4,
    neckPitch: -0.45,
    headPitch: -0.3,
    beakOpen: 0.7,
    tailPitch: 0.2,
    footGrip: 1,
  },
  hang: {
    wingSpread: 0.3,
    bodyPitch: -Math.PI + 0.4,
    footGrip: 1,
    headPitch: -0.9,
    tailPitch: -0.5,
  },
};

function frame(root, azimuth, elevation, { pad = 1.35, distance = null } = {}) {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.2);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 200);
  const dir = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );
  camera.position.copy(center).addScaledVector(dir, distance ?? radius * 3.1 * pad);
  // A camera looking straight down cannot use +Y as its up vector.
  camera.up.set(0, elevation > 1.2 ? 0 : 1, elevation > 1.2 ? -1 : 0);
  camera.lookAt(center);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

const VIEWS = [
  { name: 'side', azimuth: -Math.PI * 0.5, elevation: 0.08 },
  { name: 'three-quarter', azimuth: Math.PI * 0.75, elevation: 0.35 },
  { name: 'front', azimuth: 0.02, elevation: 0.12 },
  { name: 'top', azimuth: Math.PI * 0.5 + 0.02, elevation: 1.4 },
];

const outDir = 'previews';
mkdirSync(outDir, { recursive: true });

const [requestedSpecies, requestedPose, requestedView] = process.argv.slice(2);
const speciesIds = requestedSpecies ? [requestedSpecies] : Object.keys(BIRD_SPECIES);

/**
 * One large sheet per species: the four review views of the rest pose, then the
 * same four views of every pose named on the command line.
 */
for (const id of speciesIds) {
  const species = BIRD_SPECIES[id];
  if (!species) {
    console.error(`Unknown species ${id}`);
    continue;
  }
  const rig = new BirdRig(species, { seed: 7 });

  if (requestedView) {
    // One view, large: the fastest way to judge the model.
    const pose = POSES[requestedPose] ?? {};
    rig.applyPose(pose);
    const view = VIEWS.find((entry) => entry.name === requestedView) ?? VIEWS[1];
    const camera = frame(rig.root, view.azimuth, view.elevation, { pad: 1.25, distance: null });
    const image = renderToBuffer(rig.root, camera, { width: 760, height: 640, background: 0xe4ecef });
    savePng(`${outDir}/${id}-${requestedPose}-${view.name}.png`, image);
    console.log(`wrote ${outDir}/${id}-${requestedPose}-${view.name}.png`);
    continue;
  }
  const poseNames = requestedPose ? [requestedPose] : ['perched', 'folded-neck'];
  const sheets = [];
  for (const poseName of poseNames) {
    const pose = POSES[poseName] ?? {};
    rig.applyPose(pose);
    const frames = VIEWS.map((view) => () => {
      rig.applyPose(pose);
      void view;
    });
    const camera = frame(rig.root, VIEWS[0].azimuth, VIEWS[0].elevation, { pad: 1.28 });
    const cameras = [];
    const cells = VIEWS.map((view) => () => {
      rig.applyPose(pose);
      const posed = frame(rig.root, view.azimuth, view.elevation, { pad: 1.28 });
      camera.position.copy(posed.position);
      camera.quaternion.copy(posed.quaternion);
      camera.updateMatrixWorld(true);
      cameras.push(view.name);
    });
    sheets.push(renderContactSheet(rig.root, camera, cells, {
      columns: 4, cellWidth: 460, cellHeight: 400, label: `${id} ${poseName}`,
    }));
    void frames;
  }
  const width = sheets[0].width;
  const height = sheets.reduce((total, sheet) => total + sheet.height, 0);
  const stacked = new Uint8Array(width * height * 4);
  let offsetY = 0;
  for (const sheet of sheets) {
    for (let y = 0; y < sheet.height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const from = (y * width + x) * 4;
        const to = ((offsetY + y) * width + x) * 4;
        stacked[to] = sheet.data[from];
        stacked[to + 1] = sheet.data[from + 1];
        stacked[to + 2] = sheet.data[from + 2];
        stacked[to + 3] = 255;
      }
    }
    offsetY += sheet.height;
  }
  savePng(`${outDir}/${id}.png`, { width, height, data: stacked });
  console.log(`wrote ${outDir}/${id}.png`);
}
