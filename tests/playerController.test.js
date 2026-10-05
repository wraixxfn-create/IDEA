import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { PlayerController } from '../src/player/PlayerController.js';

const noop = () => {};
const windowListeners = new Map();
globalThis.window = {
  addEventListener: (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(listener);
  },
  removeEventListener: (type, listener) => {
    windowListeners.get(type)?.delete(listener);
  },
};
globalThis.document = {
  pointerLockElement: null,
  addEventListener: noop,
  removeEventListener: noop,
};

function makePlayer() {
  const world = {
    config: { floorHeight: 0 },
    group: new THREE.Group(),
    resolveHorizontalPosition: (x, z) => ({ x, z }),
    getFloorHeightAt: () => 0,
  };
  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1000);
  const player = new PlayerController(camera, {}, world, PLAYER_CONFIG);
  player.isLocked = true;
  return player;
}

function press(player, code, repeat = false) {
  player.handleKeyDown({ code, repeat, preventDefault: noop });
}

function release(player, code) {
  player.handleKeyUp({ code });
}

function tapSpace(player) {
  press(player, 'Space');
  release(player, 'Space');
}

test('third-person follow camera tracks an articulated explorer from behind', () => {
  const player = makePlayer();

  assert.equal(player.avatar.name, 'PlayerAvatar');
  // The avatar is a real character rig now, not a single primitive.
  assert.equal(player.avatar.userData.kind, 'character-rig');
  let meshCount = 0;
  const partNames = [];
  player.avatar.traverse((object) => {
    if (!object.isMesh) return;
    meshCount += 1;
    partNames.push(object.name);
  });
  assert.ok(meshCount > 12, `the explorer is built from real parts (found ${meshCount})`);
  for (const expected of ['HeadMesh_plate', 'TorsoMesh_plate', 'ThighMesh_L_plate']) {
    assert.ok(partNames.includes(expected), `the rig includes ${expected}`);
  }

  // It stands on the ground with its head at the configured height.
  const bounds = new THREE.Box3().setFromObject(player.avatar);
  assert.ok(bounds.min.y > -0.05 && bounds.min.y < 0.05, 'the feet rest on the floor');
  assert.ok(bounds.max.y > PLAYER_CONFIG.height * 0.92, 'the figure reaches its full height');

  assert.ok(player.camera.position.z > player.position.z);
  assert.ok(player.camera.position.y > 1.2);

  const lookDirection = new THREE.Vector3();
  player.camera.getWorldDirection(lookDirection);
  assert.ok(lookDirection.z < 0, 'the camera looks from behind toward the character');
  player.dispose();
});

test('the rig animates through walk, flight and dash states', () => {
  const player = makePlayer();
  const rig = player.characterRig;
  const legSamples = new Set();

  // Walking: the legs swing and the gait phase advances.
  press(player, 'KeyW');
  for (let step = 0; step < 40; step += 1) {
    player.update(1 / 60);
    legSamples.add(rig.leg.L.rotation.x.toFixed(4));
  }
  assert.ok(legSamples.size > 10, 'the legs keep swinging while walking');
  assert.ok(player.horizontalSpeed >= 0);

  // Hovering: the flight blend rises and the legs tuck up under the body.
  release(player, 'KeyW');
  player.setFlying(true);
  for (let step = 0; step < 90; step += 1) player.update(1 / 60);
  assert.ok(rig.blends.fly > 0.9, 'the flight pose takes over while flying');
  assert.ok(rig.leg.L.rotation.x > 0.1, 'the legs tuck forward in flight');

  // Dashing: the blend spikes and the afterimages come alive.
  player.setFlying(false);
  player.update(1 / 60);
  press(player, 'KeyW');
  press(player, 'ShiftLeft');
  player.update(1 / 60);
  assert.ok(rig.blends.dash > 0.2, 'the dash pose engages');
  player.dispose();
});

test('entering a sector retints the character accents', () => {
  const player = makePlayer();
  const before = player.characterRig.materials.accent.emissive.getHex();
  player.setAccent(0xf87171);
  assert.equal(player.characterRig.materials.accent.emissive.getHex(), 0xf87171);
  assert.notEqual(before, 0xf87171);
  player.dispose();
});

test('a double Space press toggles flight and gives an immediate takeoff lift', () => {
  const player = makePlayer();
  const flightChanges = [];
  player.onFlightChange = (flying) => flightChanges.push(flying);

  tapSpace(player);
  assert.equal(player.isFlying, false, 'a single tap does not toggle flight');

  tapSpace(player);
  assert.equal(player.isFlying, true);
  player.update(1 / 60);
  assert.ok(player.position.y > 0, 'takeoff should rise even when the second tap is released');
  assert.deepEqual(flightChanges, [true]);

  tapSpace(player);
  tapSpace(player);
  assert.equal(player.isFlying, false, 'a second double-tap returns to gravity and landing');
  assert.deepEqual(flightChanges, [true, false]);
  player.dispose();
});

test('mouse orbit stays above the map floor and the wheel no longer zooms', () => {
  const player = makePlayer();
  player.handleMouseMove({ movementX: 100, movementY: -50 });
  assert.ok(player.yaw < 0, 'moving the mouse right turns the orbit in the corrected direction');
  assert.ok(player.pitch < PLAYER_CONFIG.initialCameraPitch, 'moving the mouse up lowers orbit pitch');

  player.yaw = 0;
  player.handleMouseMove({ movementX: -100, movementY: 0 });
  assert.ok(player.yaw > 0, 'moving the mouse left produces the opposite yaw');

  player.handleMouseMove({ movementX: 0, movementY: -2000 });
  assert.ok(player.pitch < 0 && player.pitch > -0.1,
    'upward orbit is limited before the camera can pass below the map');
  player.syncCamera();
  assert.ok(player.camera.position.y >= PLAYER_CONFIG.cameraFloorClearance - 1e-6,
    'the camera keeps its configured clearance above the sector floor');

  const startingDistance = player.cameraDistance;
  assert.equal(windowListeners.get('wheel')?.size ?? 0, 0,
    'the controller does not register a scroll-to-zoom handler');
  assert.equal(player.cameraDistance, startingDistance, 'the follow-camera distance stays fixed');
  player.dispose();
});

test('Shift triggers a short directional dash instead of a held sprint', () => {
  const player = makePlayer();
  const dashChanges = [];
  player.onDashChange = (dashing) => dashChanges.push(dashing);
  press(player, 'KeyW');
  press(player, 'ShiftLeft');
  assert.equal(player.isDashing, true);

  const startZ = player.position.z;
  player.update(0.05);
  const burstDistance = Math.abs(player.position.z - startZ);
  assert.ok(burstDistance > PLAYER_CONFIG.walkSpeed * 0.05 * 2);
  assert.ok(player.position.z < startZ, 'W plus Shift dashes forward relative to the camera');

  press(player, 'ShiftLeft', true);
  while (player.dashRemaining > 0) player.update(0.05);
  assert.equal(player.isDashing, false);
  const afterDashZ = player.position.z;
  player.update(0.05);
  const regularWalkDistance = Math.abs(player.position.z - afterDashZ);
  assert.ok(regularWalkDistance <= PLAYER_CONFIG.walkSpeed * 0.05 + 1e-6,
    'holding Shift after the burst does not increase walking speed');
  assert.deepEqual(dashChanges, [true, false]);

  release(player, 'ShiftLeft');
  press(player, 'ShiftLeft');
  assert.equal(player.isDashing, false, 'the dash cannot be retriggered during its cooldown');
  player.dispose();
});

test('Esc releases capture, opens the menu callback and clears held movement', () => {
  const player = makePlayer();
  let exits = 0;
  const changes = [];
  document.pointerLockElement = player.domElement;
  document.exitPointerLock = () => { exits += 1; document.pointerLockElement = null; };
  player.onLockChange = (locked) => changes.push(locked);
  press(player, 'KeyW');
  tapSpace(player);
  press(player, 'Escape');
  assert.equal(exits, 1);
  assert.equal(player.isLocked, false);
  assert.equal(player.keys.size, 0);
  assert.equal(player.lastSpaceTapAt, Number.NEGATIVE_INFINITY);
  assert.deepEqual(changes, [false]);
  const position = player.position.clone();
  press(player, 'KeyW');
  player.handleMouseMove({ movementX: 100, movementY: 100 });
  player.update(1 / 60);
  assert.deepEqual(player.position, position);
  assert.equal(player.yaw, 0);
  assert.equal(player.keys.size, 0, 'menu keystrokes do not carry into resumed movement');
  document.pointerLockElement = player.domElement;
  player.handlePointerLockChange();
  press(player, 'KeyW');
  player.update(1 / 60);
  assert.ok(player.position.z < position.z, 'movement resumes after capture is restored');
  document.pointerLockElement = null;
  player.dispose();
});

test('browser-driven pointer unlock also notifies the pause UI', () => {
  const player = makePlayer();
  let menuOpened = false;
  player.onLockChange = (locked) => { menuOpened = !locked; };
  press(player, 'KeyD');
  document.pointerLockElement = null;
  player.handlePointerLockChange();
  assert.equal(menuOpened, true);
  assert.equal(player.keys.size, 0);
  player.dispose();
});
