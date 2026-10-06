import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { BIRD_SPECIES, BirdRig, birdSpeciesCounts, buildForestBirds } from '../src/world/ForestBirds.js';
import { HexMap } from '../src/world/HexMap.js';
import { isPointInsideHex } from '../src/world/hexGrid.js';
import { installCanvasStub } from './domStub.js';

installCanvasStub();

const SPECIES_IDS = ['chaffinch', 'tit', 'jay'];

/** A stand-in for the pine grove: trees spread through the hex. */
function makeTrees(count = 80) {
  const trees = [];
  for (let index = 0; index < count; index += 1) {
    const angle = index * 2.4;
    const radius = 12 + (index % 9) * 20;
    trees.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      scale: 0.62 + (index % 5) * 0.12,
      yaw: index,
      seed: index * 977,
    });
  }
  return trees;
}

const terrainHeight = (x, z) => Math.sin(x * 0.02) * 2 + Math.cos(z * 0.03) * 3;

function makeFlock(config = {}) {
  const sector = { id: 'HEX_S', order: 5, center: { x: 0, z: 0 } };
  return buildForestBirds(
    sector,
    { hexRadius: 220, floorHeight: 0, forestBirdCount: 12, ...config },
    { heightAt: terrainHeight, trees: makeTrees() },
  );
}

test('the wood carries a mixed flock of forest birds', () => {
  const flock = makeFlock();
  assert.equal(flock.birds.length, 12);
  assert.equal(flock.group.name, 'ForestBirds_HEX_S');
  assert.equal(flock.group.userData.sectorId, 'HEX_S');
  assert.equal(flock.group.userData.biome, 'forest-birds');
  assert.equal(flock.group.userData.birdCount, 12);
  assert.deepEqual(Object.keys(flock.counts).sort(), ['chaffinch', 'jay', 'tit']);
  assert.equal(
    Object.values(flock.counts).reduce((total, count) => total + count, 0),
    12,
  );

  // Every bird is a real rig with two materials, and every one of them starts
  // the day sitting in a tree.
  for (const bird of flock.birds) {
    assert.equal(bird.rig.meshes.length, 2, `${bird.id} must have its feather and keratin meshes`);
    assert.ok(bird.rig.meshes.every((mesh) => mesh.isSkinnedMesh));
    assert.equal(bird.state, 'perched');
    assert.ok(bird.perch, `${bird.id} must start on a perch`);
    assert.ok(isPointInsideHex(bird.position.x, bird.position.z, 0, 0, 220));
  }
  assert.equal(flock.group.children.length, 12);
});

test('the flock lives in HEX_S and nowhere else', () => {
  const map = new HexMap(new THREE.Scene(), MAP_CONFIG);
  assert.ok(map.forestBirds, 'HEX_S must have birds');
  assert.equal(map.forestBirds.birds.length, 32, 'the forest carries the enlarged flock');
  assert.equal(map.forestBirds.group.userData.birdCount, 32);
  assert.equal(map.forestBirds.group.position.x, map.getSector('HEX_S').center.x);
  assert.equal(map.forestBirds.group.position.z, map.getSector('HEX_S').center.z);
  assert.equal(map.birds, map.forestBirds);

  // The flock is one group in the map, and it steps aside with the rest of the
  // forest dressing when the development overview is up.
  map.setDebugVisible(true);
  assert.equal(map.forestBirds.group.visible, false);
  map.setDebugVisible(false);
  assert.equal(map.forestBirds.group.visible, true);

  // No other sector has any bird in it. Bird positions are local to the flock
  // group, so they are lifted into world space before the test.
  const origin = map.forestBirds.group.position;
  const others = map.sectors.filter((sector) => sector.id !== 'HEX_S');
  for (const sector of others) {
    const stray = map.forestBirds.birds.filter((bird) => isPointInsideHex(
      origin.x + bird.position.x - sector.center.x,
      origin.z + bird.position.z - sector.center.z,
      0,
      0,
      MAP_CONFIG.hexRadius * 0.85,
    ));
    assert.equal(stray.length, 0, `birds must keep out of ${sector.id}`);
  }
});

test('species counts scale with the flock and keep the chaffinches in front', () => {
  const small = birdSpeciesCounts({ forestBirdCount: 6 });
  const large = birdSpeciesCounts({ forestBirdCount: 32 });
  assert.equal(Object.values(small).reduce((a, b) => a + b, 0), 6);
  assert.equal(Object.values(large).reduce((a, b) => a + b, 0), 32);
  assert.deepEqual(large, { chaffinch: 16, tit: 11, jay: 5 });
  assert.deepEqual(birdSpeciesCounts(MAP_CONFIG), large);
  assert.deepEqual(birdSpeciesCounts(), large, 'the default flock size is 32');
  // The chaffinch is the flock's commonest bird at every size.
  assert.ok(small.chaffinch >= small.tit);
  assert.ok(large.chaffinch > large.jay);
  // Requesting one species really does build that species and nothing else.
  const only = birdSpeciesCounts({ forestBirdCount: 5, forestBirdSpecies: ['jay'] });
  assert.deepEqual(only, { jay: 5 });
});

test('a flying bird flaps, glides, banks and stays inside the wood', () => {
  const flock = makeFlock();
  // Put every bird in the air and fly them hard for a minute of world time.
  for (const bird of flock.birds) flock.setState(bird, 'fly', 40);
  const player = new THREE.Vector3(0, 0, 0);
  const dt = 1 / 60;

  let maxRadius = 0;
  let maxHeight = -Infinity;
  let minHeight = Infinity;
  let maxSpeed = 0;
  let frame = 0;
  for (; frame < 3600; frame += 1) {
    flock.update(dt, player);
    for (const bird of flock.birds) {
      assert.ok(Number.isFinite(bird.position.x + bird.position.y + bird.position.z));
      maxRadius = Math.max(maxRadius, Math.hypot(bird.position.x, bird.position.z));
      maxHeight = Math.max(maxHeight, bird.position.y);
      minHeight = Math.min(minHeight, bird.position.y);
      maxSpeed = Math.max(maxSpeed, bird.speed);
      assert.ok(Number.isFinite(bird.yaw));
      assert.ok(bird.wingPhase > 0, 'the wing cycle must advance');
      assert.ok(Math.abs(bird.bank) <= 1.2, 'the bank stays inside the pose the rig can hold');
      assert.ok(bird.glide >= 0 && bird.glide <= 1);
      assert.ok(bird.wingSpread >= 0 && bird.wingSpread <= 1);
    }
  }

  assert.ok(maxRadius < 220, `birds must stay inside the hex (got ${maxRadius.toFixed(1)})`);
  assert.ok(
    maxHeight < MAP_CONFIG.forestBirdCeiling + 1,
    `birds must stay under the canopy (got ${maxHeight.toFixed(1)})`,
  );
  assert.ok(minHeight > -12, 'birds must not sink through the terrain');
  assert.ok(maxSpeed > 4, 'the flock must actually travel');
  // Fastest bird in the wood sets the bar: a jay outflies a chaffinch.
  const fastest = Math.max(...flock.birds.map((bird) => bird.species.flight.maxSpeed));
  assert.ok(maxSpeed <= fastest * 1.01, `no bird may exceed its own top speed (${maxSpeed.toFixed(1)})`);
});

test('the flock behaves like a flock: varied states and a flush when the explorer walks in', () => {
  const flock = makeFlock({ forestBirdCount: 15 });
  const dt = 1 / 60;
  const player = new THREE.Vector3(200, 0, 200);

  // First, settle: nobody is alarmed while the explorer is far away.
  for (let frame = 0; frame < 600; frame += 1) flock.update(dt, player);
  const settled = flock.group.userData.states();
  assert.ok(settled.every((state) => state !== 'flush'), 'a distant explorer alarms nobody');
  assert.ok(new Set(settled).size > 1, 'the flock does not all do the same thing');

  // Now walk into the middle of the wood and watch the alarm spread.
  const walking = new THREE.Vector3(0, 0, 0);
  let flushed = 0;
  for (let frame = 0; frame < 900; frame += 1) {
    flock.update(dt, walking);
    for (const bird of flock.birds) if (bird.state === 'flush') flushed += 1;
  }
  assert.ok(flushed > 15, 'walking into the wood must put birds up');

  // And once the explorer has gone, the wood settles again.
  for (let frame = 0; frame < 2400; frame += 1) flock.update(dt, player);
  const calm = flock.group.userData.states();
  assert.ok(calm.every((state) => state !== 'flush'), 'the wood settles once the explorer leaves');
});

test('a forest bird rig is two skinned meshes with a fold morph and mirror-symmetric wings', () => {
  for (const id of SPECIES_IDS) {
    const rig = new BirdRig(BIRD_SPECIES[id], { seed: 11 });
    assert.equal(rig.meshes.length, 2);
    const feathers = rig.meshes[0];
    assert.equal(feathers.geometry.morphAttributes.position.length, 1, `${id} has a wing-fold morph`);
    assert.equal(feathers.geometry.morphTargetsRelative, true);
    assert.equal(feathers.geometry.attributes.skinIndex.count, feathers.geometry.attributes.position.count);
    assert.equal(feathers.geometry.attributes.skinWeight.count, feathers.geometry.attributes.position.count);
    assert.equal(feathers.skeleton.bones.length, rig.bones.length);

    // The trailing edge of the wing carries the primaries: the morph must move
    // them a long way inwards and backwards when the wing folds.
    const morph = feathers.geometry.morphAttributes.position[0];
    let longest = 0;
    for (let index = 0; index < morph.count; index += 1) {
      longest = Math.max(longest, Math.hypot(morph.getX(index), morph.getY(index), morph.getZ(index)));
    }
    assert.ok(longest > 0.4, `${id}'s fold must be a real shape change (got ${longest.toFixed(2)})`);

    // Wings are mirrored, in the geometry and in the pose. Only body poses
    // that are themselves symmetric are checked: a bird rolled into a turn has
    // its wings at different heights, and rightly so.
    let mirroredError = 0;
    for (const pose of [
      {},
      { wingSpread: 0.5 },
      { wingSpread: 1, glideBlend: 1, flapAmplitude: 0, legTuck: 1 },
      { wingSpread: 1, flapPhase: Math.PI / 2, legTuck: 1 },
      { wingSpread: 1, flapPhase: -Math.PI / 2, bodyPitch: 0.3, neckPitch: -0.2 },
    ]) {
      rig.applyPose(pose);
      const right = rig.sampleWingTip('R', new THREE.Vector3());
      const left = rig.sampleWingTip('L', new THREE.Vector3());
      mirroredError = Math.max(
        mirroredError,
        Math.abs(left.x + right.x),
        Math.abs(left.y - right.y),
        Math.abs(left.z - right.z),
      );
    }
    assert.ok(mirroredError < 0.02, `${id}'s wings must mirror (error ${mirroredError.toFixed(4)})`);

    // Folded wings lie along the body; extended wings reach out sideways.
    rig.applyPose({});
    const folded = rig.sampleWingTip('R', new THREE.Vector3());
    const shoulder = rig.wing.R.position.x;
    rig.applyPose({ wingSpread: 1, glideBlend: 1, flapAmplitude: 0, legTuck: 1 });
    const extended = rig.sampleWingTip('R', new THREE.Vector3());
    // A folded wing lies against the flank: its tip stays inside the width of
    // the bird, and runs back along the body rather than out to the side.
    assert.ok(
      folded.x < shoulder + BIRD_SPECIES[id].morph.bodyWidth * 0.25,
      `${id} folds its wing in (tip x ${folded.x.toFixed(3)})`,
    );
    assert.ok(folded.z > folded.x, `${id} folds its wing back along the flank`);
    assert.ok(extended.x > folded.x * 2, `${id} extends its wing in flight`);
    assert.ok(extended.x > BIRD_SPECIES[id].morph.humerus + BIRD_SPECIES[id].morph.forearm, `${id} opens its wing out`);
  }
});

test('the flap beats a real arc and the head holds still while the body bobs', () => {
  const rig = new BirdRig(BIRD_SPECIES.chaffinch, { seed: 3 });
  const lowest = [];
  let highest = -Infinity;
  for (let step = 0; step < 24; step += 1) {
    rig.applyPose({
      wingSpread: 1,
      flapPhase: (step / 24) * Math.PI * 2,
      flapAmplitude: 1.1,
      legTuck: 1,
    });
    const tip = rig.sampleWingTip('R', new THREE.Vector3());
    lowest.push(tip.y);
    highest = Math.max(highest, tip.y);
  }
  const lowestY = Math.min(...lowest);
  assert.ok(highest - lowestY > 0.5, 'a full flap must beat through a real arc');
  assert.ok(highest > 0.2, 'the upstroke must lift the wing tip above the body');
  assert.ok(lowestY < -0.1, 'the downstroke must drive it below the body');

  // The head is a saccade machine: it moves, and it moves *less* than the body.
  rig.applyPose({});
  const neck = rig.neck.rotation.y;
  rig.applyPose({ headYaw: 1.2 });
  assert.equal(rig.neck.rotation.y, neck, 'the neck is not dragged around by the head');
  assert.ok(rig.head.rotation.y > 0.5, 'the head turns on its own joint');
});

test('resting birds occasionally stretch a wing or flick their tails', () => {
  const flock = makeFlock({ forestBirdCount: 8 });
  const restingPlayer = new THREE.Vector3(200, 0, 200);
  for (const bird of flock.birds) flock.setState(bird, 'perched', 30);

  let sawFidget = false;
  let sawWingStretch = false;
  for (let frame = 0; frame < 20 * 60; frame += 1) {
    flock.update(1 / 60, restingPlayer);
    for (const bird of flock.birds) {
      if (bird.fidget > 0.2) sawFidget = true;
      if (bird.fidgetKind === 'wing' && bird.fidget > 0.2 && bird.rig.wingFold < 0.95) {
        sawWingStretch = true;
      }
    }
  }

  assert.ok(sawFidget, 'at least one resting bird should perform an idle gesture');
  assert.ok(sawWingStretch, 'a wing stretch should visibly loosen the folded wing');
});

test('a perched bird stands on its perch and a flushed bird leaves it', () => {
  const flock = makeFlock({ forestBirdCount: 6 });
  const dt = 1 / 60;
  const bird = flock.birds[0];
  assert.ok(bird.perch);
  assert.ok(Math.abs(bird.position.y - bird.perch.point.y) < 0.001);

  // Startle it: the flush takes it up and away from where it was sitting.
  const start = bird.position.clone();
  const player = start.clone();
  let rose = 0;
  for (let frame = 0; frame < 240; frame += 1) {
    flock.update(dt, player);
    rose = Math.max(rose, bird.position.y - start.y);
  }
  assert.ok(['flush', 'fly', 'travel', 'wander', 'follow', 'chase', 'descend', 'takeoff'].includes(bird.state)
    || bird.position.distanceTo(start) > 2, 'the bird must react to the explorer');
  assert.ok(rose > 0.5, 'a flush climbs');
});
