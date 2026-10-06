import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { PlayerController } from '../src/player/PlayerController.js';
import { MapOverlay } from '../src/ui/MapOverlay.js';

installInputStub();

/**
 * PlayerController listens on `window` and `document`; the minimap overlay is
 * plain DOM. Both are stubbed so the whole open/close sequence can be replayed
 * in Node.
 */
function installInputStub() {
  const noop = () => {};
  const listeners = new Map();
  const addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  if (!globalThis.window) globalThis.window = {};
  globalThis.window.addEventListener ??= addEventListener;
  globalThis.window.removeEventListener ??= (type, listener) => {
    listeners.get(type)?.delete(listener);
  };
  if (!globalThis.document) globalThis.document = {};
  globalThis.document.pointerLockElement = null;
  globalThis.document.addEventListener ??= noop;
  globalThis.document.removeEventListener ??= noop;
}

/** The subset of the panel the overlay touches. */
function makePanelStub() {
  const classes = new Set(['is-hidden']);
  const attributes = new Map([['aria-hidden', 'true']]);
  return {
    classes,
    attributes,
    classList: {
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
  };
}

/** A controller stand-in that counts every lock request and release. */
function makePlayerStub({ isLocked = true } = {}) {
  return {
    isLocked,
    keys: new Set(['KeyW']),
    lockRequests: 0,
    lockReleases: 0,
    requestPointerLock() { this.lockRequests += 1; },
    releasePointerLock() {
      // The real controller clears the pressed keys on release: that is the
      // reason a held W used to be forgotten when the map opened.
      this.lockReleases += 1;
      this.isLocked = false;
      this.keys.clear();
    },
  };
}

function makePlayer(worldOverrides = {}) {
  const world = {
    config: { floorHeight: 0 },
    group: new THREE.Group(),
    resolveHorizontalPosition: (x, z) => ({ x, z }),
    getFloorHeightAt: () => 0,
    ...worldOverrides,
  };
  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1000);
  const player = new PlayerController(camera, {}, world, PLAYER_CONFIG);
  player.isLocked = true;
  return player;
}

test('opening the map leaves the pointer lock and the pressed keys alone', () => {
  const panel = makePanelStub();
  const player = makePlayerStub();
  const overlay = new MapOverlay({ overlay: panel, player });

  assert.equal(overlay.open(), true);
  assert.equal(overlay.isOpen, true);
  assert.equal(player.lockReleases, 0, 'the map never gives the pointer lock back');
  assert.equal(player.isLocked, true, 'so the explorer keeps the keyboard');
  assert.deepEqual([...player.keys], ['KeyW'], 'a key held across the map survives');
  assert.equal(panel.classes.has('is-hidden'), false, 'the panel is visible');
  assert.equal(panel.attributes.get('aria-hidden'), 'false');
});

test('closing the map never needs the controls to be re-armed', () => {
  const panel = makePanelStub();
  const player = makePlayerStub();
  const overlay = new MapOverlay({ overlay: panel, player });

  overlay.open();
  assert.equal(overlay.close(), true);
  assert.equal(overlay.isOpen, false);
  // The regression: closing used to request a pointer lock that the browser
  // granted a frame later, eating the keys pressed in between and leaving the
  // explorer stuck until W was pressed again.
  assert.equal(player.lockRequests, 0, 'there is nothing to re-lock');
  assert.equal(player.lockReleases, 0);
  assert.equal(player.isLocked, true);
  assert.deepEqual([...player.keys], ['KeyW'], 'the keys are still there');
  assert.equal(panel.classes.has('is-hidden'), true, 'the panel is hidden again');
  assert.equal(panel.attributes.get('aria-hidden'), 'true');
});

test('the map only takes the lock back when the browser dropped it while open', () => {
  const player = makePlayerStub();
  const overlay = new MapOverlay({ overlay: makePanelStub(), player });

  overlay.open();
  // Esc, a tab switch or a fullscreen change can drop the lock behind the map.
  player.isLocked = false;
  player.keys.clear();
  overlay.close();
  assert.equal(player.lockRequests, 1, 'the fallback re-locks the pointer');
  assert.equal(overlay.resumes, 1);
});

test('a map opened from the pause menu never starts the game by itself', () => {
  const player = makePlayerStub({ isLocked: false });
  player.keys.clear();
  const overlay = new MapOverlay({ overlay: makePanelStub(), player });

  overlay.open();
  overlay.close();
  assert.equal(player.lockRequests, 0, 'the pause menu is where the explorer stays');

  // Esc closes the map without ever asking for the pointer: the browser has
  // already dropped it, and the pause menu is the right place to land.
  overlay.open();
  player.isLocked = true;
  overlay.close({ resume: false });
  assert.equal(player.lockRequests, 0);
  assert.equal(overlay.opens, 2);
  assert.equal(overlay.closes, 2);
});

test('toggle() drives the overlay both ways and reports the first paint', () => {
  const panel = makePanelStub();
  const player = makePlayerStub();
  const painted = [];
  const overlay = new MapOverlay({
    overlay: panel,
    player,
    onOpen: () => painted.push('open'),
    onChange: (map) => painted.push(map.isOpen ? 'visible' : 'hidden'),
  });

  overlay.toggle();
  overlay.toggle();
  assert.equal(overlay.isOpen, false);
  assert.deepEqual(painted, ['open', 'visible', 'hidden']);
  assert.equal(overlay.toggle(), true, 'a third press opens it again');
});

test('the explorer keeps walking while the map is open and after it closes', () => {
  // The full sequence the player complained about: walk with W held, press M,
  // look at the map, press M again — and keep moving without touching W.
  const player = makePlayer();
  const panel = makePanelStub();
  const overlay = new MapOverlay({ overlay: panel, player });
  let releases = 0;
  const releasePointerLock = player.releasePointerLock.bind(player);
  player.releasePointerLock = () => { releases += 1; return releasePointerLock(); };

  player.handleKeyDown({ code: 'KeyW', repeat: false, preventDefault: () => {} });
  player.update(1 / 60);
  player.update(1 / 60);
  const walkedTo = player.position.z;
  assert.ok(walkedTo < 0, 'the explorer walks forward while W is held');

  // M: the map is drawn over a running world, not a paused one.
  overlay.toggle();
  assert.equal(player.isLocked, true, 'no pointer lock round trip');
  assert.equal(releases, 0);
  assert.equal(player.keys.has('KeyW'), true, 'W is still down');
  for (let frame = 0; frame < 30; frame += 1) player.update(1 / 60);
  assert.ok(player.position.z < walkedTo, 'the explorer keeps walking under the map');

  // M again: the very next frame already moves, with no second keypress.
  const beforeClose = player.position.z;
  overlay.toggle();
  assert.equal(overlay.isOpen, false);
  player.update(1 / 60);
  assert.ok(player.position.z < beforeClose, 'closing the map does not freeze the explorer');
  assert.equal(player.isLocked, true);
  assert.equal(player.keys.has('KeyW'), true);

  player.dispose();
});
