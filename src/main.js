import * as THREE from 'three';
import './style.css';
import { MAP_CONFIG, PLAYER_CONFIG, getSectorInfo } from './config/mapConfig.js';
import { HexMap } from './world/HexMap.js';
import { PlayerController } from './player/PlayerController.js';
import { resolveSunDirection } from './world/SkyDome.js';
import { Minimap } from './ui/Minimap.js';
import { MapOverlay } from './ui/MapOverlay.js';
import { Compass } from './ui/Compass.js';

const viewport = document.querySelector('#viewport');
const enterButton = document.querySelector('#enter-world');
const enterLabel = document.querySelector('#enter-label');
const promptNote = document.querySelector('#prompt-note');
const experiencePrompt = document.querySelector('#experience-prompt');
const overviewButton = document.querySelector('#menu-overview');
const debugState = document.querySelector('#debug-state');
const flightState = document.querySelector('#flight-state');
const minimapOverlay = document.querySelector('#minimap-overlay');
const minimapCanvas = document.querySelector('#minimap-canvas');
const minimapLegend = document.querySelector('#minimap-legend');
const minimapClose = document.querySelector('#minimap-close');
const viewState = document.querySelector('#view-state');
const viewStateLabel = document.querySelector('#view-state-label');
const viewToggleButton = document.querySelector('#menu-view');
const compassRoot = document.querySelector('#compass');
const compassCard = document.querySelector('#compass-card');
const compassLetters = document.querySelector('#compass-letters');
const compassHeading = document.querySelector('#compass-heading');
const compassCardinal = document.querySelector('#compass-cardinal');

const scene = new THREE.Scene();
// The same sun paints every cupola, lights the world and casts the key light,
// so the sky the player sees and the light they walk in always agree.
const sunDirection = resolveSunDirection(MAP_CONFIG);
scene.background = new THREE.Color(MAP_CONFIG.backgroundColor);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.domElement.setAttribute('aria-label', 'Three-dimensional hexagonal exploration world');
viewport.prepend(renderer.domElement);

// A cooler, lower global wash leaves room for the warmer biomes and the new
// green/amber canopy lights inside HEX_S to read as a distinct environment.
scene.add(new THREE.HemisphereLight(
  MAP_CONFIG.sunAmbientColor ?? 0xd7eee4,
  MAP_CONFIG.groundBounceColor ?? 0x26352e,
  1.06,
));
const keyLight = new THREE.DirectionalLight(
  MAP_CONFIG.sunColor ?? 0xffe6bd,
  MAP_CONFIG.sunIntensity ?? 0.92,
);
// Aim the key light straight out of the painted sun: 900 units is far enough
// that the whole eight-sector map is lit from exactly the sky's direction.
keyLight.position.copy(sunDirection).multiplyScalar(900);
keyLight.target.position.set(0, MAP_CONFIG.floorHeight, 0);
scene.add(keyLight);
scene.add(keyLight.target);

const world = new HexMap(scene, MAP_CONFIG);
const camera = new THREE.PerspectiveCamera(
  76,
  window.innerWidth / window.innerHeight,
  0.1,
  3200,
);
const player = new PlayerController(camera, renderer.domElement, world, PLAYER_CONFIG);
// The character shares the world's wind clock (so the cloth moves with the
// forest) and wears the palette of whichever sector it is standing in.
player.setWind(world.windUniforms);
player.setRendererEnvironment(renderer, MAP_CONFIG);

// The heading compass in the top-left corner: the explorer's look direction as
// a bearing, over the same axes the minimap uses (north is -Z, east is +X).
const compass = new Compass({
  root: compassRoot,
  card: compassCard,
  letters: compassLetters,
  heading: compassHeading,
  cardinal: compassCardinal,
  player,
});

const overviewCamera = new THREE.OrthographicCamera(-700, 700, 700, -700, 0.1, 5000);
overviewCamera.up.set(0, 0, -1);
overviewCamera.position.set(0, 1600, 0);
overviewCamera.lookAt(0, 0, 0);

let debugMode = false;
let hasStarted = false;

// The world map is an overlay, not a pause screen: it keeps the pointer lock
// and the key state, so the explorer answers the keyboard while the map is up
// and closing it never leaves the controls dead (see src/ui/MapOverlay.js).
const mapOverlay = new MapOverlay({
  overlay: minimapOverlay,
  player,
  onOpen: () => renderMinimap(),
  onChange: () => updatePrompt(),
});

const VIEW_STORAGE_KEY = 'hexfield:view-mode';
try {
  const storedView = window.localStorage?.getItem(VIEW_STORAGE_KEY);
  if (storedView === 'first' || storedView === 'third') player.setViewMode(storedView);
} catch {
  // Private browsing modes can deny storage; the default view still applies.
}

function viewLabel() {
  return player.isFirstPerson ? 'PRIMA PERSONA' : 'TERZA PERSONA';
}

// The view chip is a flash, not a permanent HUD element: it confirms the
// switch and then gets out of the way.
let viewStateTimeout = null;

function hideViewState() {
  if (!viewState) return;
  clearTimeout(viewStateTimeout);
  viewStateTimeout = null;
  viewState.classList.remove('is-visible');
  viewState.setAttribute('aria-hidden', 'true');
}

function flashViewState() {
  if (!viewState) return;
  if (viewStateLabel) viewStateLabel.textContent = viewLabel();
  viewState.classList.add('is-visible');
  viewState.setAttribute('aria-hidden', 'false');
  clearTimeout(viewStateTimeout);
  viewStateTimeout = setTimeout(hideViewState, 2400);
}

function updatePrompt() {
  const locked = player.isLocked;
  const shouldShow = !debugMode && !locked && !mapOverlay.isOpen;
  const paused = hasStarted && shouldShow;
  experiencePrompt.classList.toggle('is-hidden', !shouldShow);
  experiencePrompt.classList.toggle('is-paused', paused);
  experiencePrompt.setAttribute('aria-hidden', String(!shouldShow));
  experiencePrompt.setAttribute('role', paused ? 'dialog' : 'status');
  if (paused) {
    experiencePrompt.setAttribute('aria-modal', 'true');
    experiencePrompt.setAttribute('aria-labelledby', 'pause-title');
  } else {
    experiencePrompt.removeAttribute('aria-modal');
    experiencePrompt.removeAttribute('aria-labelledby');
  }
  debugState.classList.toggle('is-visible', debugMode);
  const showFlightState = player.isFlying && player.isLocked && !debugMode && !mapOverlay.isOpen;
  flightState.classList.toggle('is-visible', showFlightState);
  flightState.setAttribute('aria-hidden', String(!showFlightState));

  if (viewState && (!player.isLocked || debugMode || mapOverlay.isOpen)) hideViewState();
  if (viewToggleButton) {
    viewToggleButton.textContent = player.isFirstPerson
      ? 'Vista: prima persona'
      : 'Vista: terza persona';
    viewToggleButton.setAttribute('aria-pressed', String(player.isFirstPerson));
  }

  if (debugMode) {
    enterLabel.textContent = 'Debug overview active';
    promptNote.textContent = 'Sector IDs, boundaries and open-gate locations are visible · F3 returns';
    enterButton.disabled = true;
    return;
  }

  if (mapOverlay.isOpen) {
    enterLabel.textContent = 'Mappa aperta';
    promptNote.textContent = 'Premi M o Esc per chiudere la mappa';
    enterButton.disabled = true;
    return;
  }

  enterButton.disabled = false;
  enterLabel.textContent = hasStarted ? 'Riprendi esplorazione' : 'Click to explore';
  promptNote.textContent = 'Mouse orbita · V cambia vista · M mappa · Shift scatto · Esc menù';
}

player.onLockChange = (locked) => {
  if (locked) hasStarted = true;
  updatePrompt();
  if (!locked && !debugMode && !mapOverlay.isOpen && hasStarted) {
    enterButton.focus({ preventScroll: true });
  }
};
player.onFlightChange = () => updatePrompt();
player.onViewModeChange = (mode) => {
  try {
    window.localStorage?.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    // Storage is optional; the toggle still works for this session.
  }
  if (player.isLocked) flashViewState();
  updatePrompt();
};

enterButton.addEventListener('click', () => {
  if (!debugMode) player.requestPointerLock();
});

viewToggleButton?.addEventListener('click', () => {
  player.toggleViewMode();
  updatePrompt();
});

function setDebugMode(enabled) {
  debugMode = enabled;
  world.setDebugVisible(debugMode);
  if (debugMode) {
    mapOverlay.close({ resume: false });
    player.releasePointerLock();
  }
  updatePrompt();
}

overviewButton.addEventListener('click', () => setDebugMode(true));

// Keys are read from `event.code` first (layout independent) and from
// `event.key` as a fallback, so the map still closes on keyboard layouts that
// do not report a KeyM code.
function matchesKey(event, code, key) {
  if (event.code === code) return true;
  return typeof event.key === 'string' && event.key.toLowerCase() === key;
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' || event.key === 'Escape') {
    // Browsers may handle Esc themselves; pointerlockchange also opens the
    // menu. Explicit handling covers debug view and already-unlocked states.
    if (mapOverlay.isOpen) mapOverlay.close({ resume: false });
    if (debugMode) setDebugMode(false);
    updatePrompt();
    if (hasStarted) enterButton.focus({ preventScroll: true });
    return;
  }
  if (event.repeat) return;
  if (matchesKey(event, 'KeyM', 'm')) {
    event.preventDefault();
    mapOverlay.toggle();
    return;
  }
  if (matchesKey(event, 'KeyV', 'v')) {
    event.preventDefault();
    player.toggleViewMode();
    updatePrompt();
    return;
  }
  if (event.code !== 'F3') return;
  event.preventDefault();
  setDebugMode(!debugMode);
});

minimapClose?.addEventListener('click', () => mapOverlay.close());

const minimap = new Minimap({
  canvas: minimapCanvas,
  legend: minimapLegend,
  world,
  player,
  hexRadius: MAP_CONFIG.hexRadius,
});

function renderMinimap() {
  minimap.render(Math.min(window.devicePixelRatio || 1, 2));
}

function updateOverviewFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  const bounds = world.bounds;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const halfHeight = Math.max(depth / 2, width / (2 * Math.max(aspect, 0.1))) * 1.12;
  const halfWidth = halfHeight * aspect;
  overviewCamera.left = -halfWidth;
  overviewCamera.right = halfWidth;
  overviewCamera.top = halfHeight;
  overviewCamera.bottom = -halfHeight;
  overviewCamera.position.set(centerX, 1600, centerZ);
  overviewCamera.lookAt(centerX, 0, centerZ);
  overviewCamera.updateProjectionMatrix();
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  updateOverviewFrustum();
}

window.addEventListener('resize', resize);
resize();
updatePrompt();

const footerCoordinate = document.querySelector('.footer-coordinate');
let currentSectorId = undefined;

function updateSectorDisplay() {
  if (!footerCoordinate) return;
  const sector = world.getSectorAt(player.position.x, player.position.z);
  const sectorId = sector?.id ?? null;
  if (sectorId !== currentSectorId) {
    currentSectorId = sectorId;
    if (sectorId) {
      const info = getSectorInfo(sector.id, sector.order);
      footerCoordinate.textContent = `· ${info.name.toUpperCase()}`;
      footerCoordinate.style.color = `#${info.accent.toString(16).padStart(6, '0')}`;
      // The explorer's sigils, thruster glow and cloth trim take on the
      // accent of the sector they are standing in, and so does the compass
      // needle, so the HUD belongs to the biome.
      player.setAccent(info.accent);
      compass.setAccent(info.accent);
    } else {
      footerCoordinate.textContent = '—';
      footerCoordinate.style.color = '';
      compass.setAccent(0xc7ddd7);
    }
  }
}

// A small handle on the running world, handy while developing and for the
// automated visual checks. It is stripped from production builds.
if (import.meta.env?.DEV) {
  window.__hexfield = {
    THREE,
    scene,
    camera,
    renderer,
    world,
    player,
    overviewCamera,
    sunDirection,
    compass,
    setDebugMode,
  };
}

const clock = new THREE.Clock();
let minimapTimer = 0;
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

  // The map is drawn over a world that keeps running: the explorer keeps
  // walking and the wind keeps blowing while the overlay is up, so closing it
  // drops the player exactly where they are instead of into a frozen scene.
  if (!debugMode) {
    world.update(delta, player.position);
    player.update(delta);
    updateSectorDisplay();
  }
  world.updateDebugPlayer(player.position);
  // The compass follows the look direction in every mode, including the
  // annotated overview, so the top-left corner is never out of date.
  compass.update();
  renderer.render(scene, debugMode ? overviewCamera : camera);

  // Keep the minimap marker current while the map is open, at a calm 12 Hz:
  // it is a position readout, not an animation, so there is nothing to redraw
  // faster for.
  if (mapOverlay.isOpen) {
    minimapTimer += delta;
    if (minimapTimer >= 1 / 12) {
      minimapTimer = 0;
      renderMinimap();
    }
  }
}

animate();
