import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { PlayerController } from '../src/player/PlayerController.js';

const noop = () => {};
globalThis.window = {
  addEventListener: noop,
  removeEventListener: noop,
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

test('third-person follow camera tracks a simple oval avatar from behind', () => {
  const player = makePlayer();

  assert.equal(player.avatar.name, 'PlayerAvatar');
  assert.ok(player.avatar.geometry instanceof THREE.SphereGeometry);
  assert.equal(player.avatar.position.y, PLAYER_CONFIG.height / 2);
  assert.ok(player.camera.position.z > player.position.z);
  assert.ok(player.camera.position.y > player.avatar.position.y);

  const lookDirection = new THREE.Vector3();
  player.camera.getWorldDirection(lookDirection);
  assert.ok(lookDirection.z < 0, 'the camera looks from behind toward the character');
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

test('mouse movement orbits and wheel input zooms the third-person camera', () => {
  const player = makePlayer();
  player.handleMouseMove({ movementX: 100, movementY: -50 });
  assert.notEqual(player.yaw, 0);
  assert.ok(player.pitch > PLAYER_CONFIG.initialCameraPitch);

  const startingDistance = player.cameraDistance;
  let prevented = false;
  player.handleWheel({ deltaY: 1, preventDefault: () => { prevented = true; } });
  assert.ok(player.cameraDistance > startingDistance);
  assert.equal(prevented, true);
  player.dispose();
});
