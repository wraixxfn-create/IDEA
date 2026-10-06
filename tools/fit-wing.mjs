/**
 * Wing pose fitter (development tool).
 *
 * The three-segment fold of a bird wing is a nine-parameter problem — twist,
 * pitch and sweep for the humerus, the forearm and the hand — and eyeballing
 * nine angles that land the wing tip in the right place is a waste of a good
 * afternoon. This searches for them: it poses a rig, measures where the elbow,
 * the wrist and the wing tip end up, and reports the set of angles that puts
 * them where a real wing puts them.
 *
 *   node tools/fit-wing.mjs fold
 *   node tools/fit-wing.mjs glide
 */

import * as THREE from 'three';
import { BIRD_SPECIES, BirdRig } from '../src/world/ForestBirds.js';

const MODE = process.argv[2] ?? 'fold';
const species = BIRD_SPECIES[process.argv[3] ?? 'chaffinch'];
const rig = new BirdRig(species, { seed: 7 });
const M = species.morph;

const shoulderRest = new THREE.Vector3().setFromMatrixPosition(rig.wing.R.matrixWorld);

/** The targets: where a folded (or extended) right wing should land. */
const TARGETS = MODE === 'fold'
  ? {
      // A folded wing lies along the flank: the elbow swings back from the
      // shoulder, the forearm follows the ribs, and the hand runs back over
      // the rump towards the tail, converging on the centre line.
      elbow: new THREE.Vector3(0.19, 0.115, -0.055),
      wrist: new THREE.Vector3(0.155, 0.14, 0.075),
      tip: new THREE.Vector3(0.095, 0.155, 0.29),
    }
  : {
      // An extended wing: straight out, a shade above the shoulder, the hand
      // trailing slightly so the tip feathers rake backwards in the glide.
      elbow: new THREE.Vector3(0.34, 0.125, -0.16),
      wrist: new THREE.Vector3(0.55, 0.135, -0.07),
      tip: new THREE.Vector3(0.78, 0.15, 0.06),
    };

const WEIGHTS = { elbow: 1, wrist: 1.35, tip: 1.9 };

function evaluate(params) {
  const [st, sp, ss, ft, fp, fs, ht, hp, hs] = params;
  rig.poseWingBone(rig.wing.R, 'R', { twist: st, pitch: sp, sweep: ss });
  rig.poseWingBone(rig.forearm.R, 'R', { twist: ft, pitch: fp, sweep: fs });
  rig.poseWingBone(rig.hand.R, 'R', { twist: ht, pitch: hp, sweep: hs });
  rig.root.updateMatrixWorld(true);
  const elbow = new THREE.Vector3().setFromMatrixPosition(rig.forearm.R.matrixWorld);
  const wrist = new THREE.Vector3().setFromMatrixPosition(rig.hand.R.matrixWorld);
  const tip = rig.sampleWingTip('R', new THREE.Vector3());
  return (
    WEIGHTS.elbow * elbow.distanceTo(TARGETS.elbow)
    + WEIGHTS.wrist * wrist.distanceTo(TARGETS.wrist)
    + WEIGHTS.tip * tip.distanceTo(TARGETS.tip)
  );
}

const RANGE = {
  fold: [
    [-3.2, 0.6], [-0.9, 0.9], [0.2, 2.2],
    [-1.2, 1.2], [-3.1, 0.4], [-1.2, 1.2],
    [-1.2, 1.2], [-3.1, 0.4], [-1.3, 1.3],
  ],
  glide: [
    [-1.2, 1.2], [-0.5, 0.5], [-0.6, 0.6],
    [-1.2, 1.2], [-0.5, 0.5], [-0.6, 0.6],
    [-1.4, 1.4], [-0.5, 0.5], [-0.6, 0.6],
  ],
}[MODE];

const randomBetween = (random, low, high) => low + random() * (high - low);
let seed = 0x9e3779b9;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};

let best = null;
for (let restart = 0; restart < 60; restart += 1) {
  let current = RANGE.map(([low, high]) => randomBetween(random, low, high));
  let score = evaluate(current);
  let step = 0.5;
  for (let iteration = 0; iteration < 900; iteration += 1) {
    if (iteration % 120 === 0) step *= 0.55;
    const candidate = current.map((value, index) => {
      const [low, high] = RANGE[index];
      const next = value + (random() * 2 - 1) * step;
      return Math.min(high, Math.max(low, next));
    });
    const candidateScore = evaluate(candidate);
    if (candidateScore < score) {
      current = candidate;
      score = candidateScore;
    }
  }
  if (!best || score < best.score) best = { params: current, score };
}

rig.poseWingBone(rig.wing.R, 'R', { twist: best.params[0], pitch: best.params[1], sweep: best.params[2] });
rig.poseWingBone(rig.forearm.R, 'R', { twist: best.params[3], pitch: best.params[4], sweep: best.params[5] });
rig.poseWingBone(rig.hand.R, 'R', { twist: best.params[6], pitch: best.params[7], sweep: best.params[8] });
rig.root.updateMatrixWorld(true);

const elbow = new THREE.Vector3().setFromMatrixPosition(rig.forearm.R.matrixWorld);
const wrist = new THREE.Vector3().setFromMatrixPosition(rig.hand.R.matrixWorld);
const tip = rig.sampleWingTip('R', new THREE.Vector3());

console.log(`mode ${MODE} species ${species.id} shoulder ${shoulderRest.toArray().map((v) => v.toFixed(3))}`);
console.log('best score', best.score.toFixed(4));
console.log('params', best.params.map((v) => v.toFixed(3)).join(', '));
console.log('elbow  ', elbow.toArray().map((v) => v.toFixed(3)).join(', '), 'target', TARGETS.elbow.toArray().join(', '));
console.log('wrist  ', wrist.toArray().map((v) => v.toFixed(3)).join(', '), 'target', TARGETS.wrist.toArray().join(', '));
console.log('tip    ', tip.toArray().map((v) => v.toFixed(3)).join(', '), 'target', TARGETS.tip.toArray().join(', '));
console.log('span hint: hand length', M.hand, 'forearm', M.forearm, 'humerus', M.humerus);
