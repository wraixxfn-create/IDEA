import * as THREE from 'three';
import './style.css';
import { MAP_CONFIG, PLAYER_CONFIG, getSectorInfo } from './config/mapConfig.js';
import { HexMap } from './world/HexMap.js';
import { PlayerController } from './player/PlayerController.js';
import { resolveSunDirection } from './world/SkyDome.js';
import { Minimap } from './ui/Minimap.js';

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

const overviewCamera = new THREE.OrthographicCamera(-700, 700, 700, -700, 0.1, 5000);
overviewCamera.up.set(0, 0, -1);
overviewCamera.position.set(0, 1600, 0);
overviewCamera.lookAt(0, 0, 0);

let debugMode = false;
let hasStarted = false;
let minimapOpen = false;
// Set while the map is open if the explorer was playing, so closing the map
// drops straight back into the world instead of into the pause menu.
let resumeAfterMinimap = false;

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
  const shouldShow = !debugMode && !locked && !minimapOpen;
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
  const showFlightState = player.isFlying && player.isLocked && !debugMode && !minimapOpen;
  flightState.classList.toggle('is-visible', showFlightState);
  flightState.setAttribute('aria-hidden', String(!showFlightState));

  if (viewState && (!player.isLocked || debugMode || minimapOpen)) hideViewState();
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

  if (minimapOpen) {
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
  if (!locked && !debugMode && !minimapOpen && hasStarted) {
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
  if (debugMode) player.releasePointerLock();
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
    if (minimapOpen) toggleMinimap(false, { resume: false });
    if (debugMode) setDebugMode(false);
    updatePrompt();
    if (hasStarted) enterButton.focus({ preventScroll: true });
    return;
  }
  if (event.repeat) return;
  if (matchesKey(event, 'KeyM', 'm')) {
    event.preventDefault();
    toggleMinimap(!minimapOpen);
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

function toggleMinimap(open, { resume = true } = {}) {
  if (open === minimapOpen) return;
  minimapOpen = open;
  minimapOverlay.classList.toggle('is-hidden', !open);
  minimapOverlay.setAttribute('aria-hidden', String(!open));
  if (open) {
    resumeAfterMinimap = player.isLocked;
    renderMinimap();
    // Release pointer lock so the player can see the cursor.
    player.releasePointerLock();
  } else if (resume && resumeAfterMinimap && !debugMode) {
    // Closing with M goes straight back to exploring: the keypress is a user
    // gesture, so the browser lets the pointer re-lock immediately.
    resumeAfterMinimap = false;
    player.requestPointerLock();
  }
  updatePrompt();
}

minimapClose?.addEventListener('click', () => toggleMinimap(false));

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
      // accent of the sector they are standing in.
      player.setAccent(info.accent);
    } else {
      footerCoordinate.textContent = '—';
      footerCoordinate.style.color = '';
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
    setDebugMode,
  };
}

const clock = new THREE.Clock();
let minimapTimer = 0;
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

  if (!debugMode) {
    world.update(delta, player.position);
    player.update(delta);
    updateSectorDisplay();
  }
  world.updateDebugPlayer(player.position);
  renderer.render(scene, debugMode ? overviewCamera : camera);

  // Keep the minimap marker current while the map is open, at a calm 12 Hz:
  // the world behind it is paused, so there is nothing to redraw faster for.
  if (minimapOpen) {
    minimapTimer += delta;
    if (minimapTimer >= 1 / 12) {
      minimapTimer = 0;
      renderMinimap();
    }
  }
}

animate();
