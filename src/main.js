import * as THREE from 'three';
import './style.css';
import { MAP_CONFIG, PLAYER_CONFIG, getSectorInfo } from './config/mapConfig.js';
import { HexMap } from './world/HexMap.js';
import { PlayerController } from './player/PlayerController.js';

const viewport = document.querySelector('#viewport');
const enterButton = document.querySelector('#enter-world');
const enterLabel = document.querySelector('#enter-label');
const promptNote = document.querySelector('#prompt-note');
const experiencePrompt = document.querySelector('#experience-prompt');
const debugState = document.querySelector('#debug-state');

const scene = new THREE.Scene();
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

scene.add(new THREE.HemisphereLight(0xf1f3f1, 0x626b6e, 1.75));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
keyLight.position.set(-260, 420, -180);
scene.add(keyLight);

const world = new HexMap(scene, MAP_CONFIG);
const camera = new THREE.PerspectiveCamera(
  76,
  window.innerWidth / window.innerHeight,
  0.1,
  3200,
);
const player = new PlayerController(camera, renderer.domElement, world, PLAYER_CONFIG);

const overviewCamera = new THREE.OrthographicCamera(-700, 700, 700, -700, 0.1, 5000);
overviewCamera.up.set(0, 0, -1);
overviewCamera.position.set(0, 1600, 0);
overviewCamera.lookAt(0, 0, 0);

let debugMode = false;
let hasStarted = false;

function updatePrompt() {
  const locked = player.isLocked;
  const shouldShow = !debugMode && !locked;
  experiencePrompt.classList.toggle('is-hidden', !shouldShow);
  debugState.classList.toggle('is-visible', debugMode);

  if (debugMode) {
    enterLabel.textContent = 'Debug overview active';
    promptNote.textContent = 'Sector IDs, boundaries and open-gate locations are visible · F3 returns';
    enterButton.disabled = true;
    return;
  }

  enterButton.disabled = false;
  enterLabel.textContent = hasStarted ? 'Click to resume' : 'Click to explore';
  promptNote.textContent = hasStarted
    ? 'Mouse look captures the pointer · Press Esc to release'
    : 'Mouse look captures the pointer · Press Esc to release';
}

player.onLockChange = (locked) => {
  if (locked) hasStarted = true;
  updatePrompt();
};

enterButton.addEventListener('click', () => {
  if (!debugMode) player.requestPointerLock();
});

window.addEventListener('keydown', (event) => {
  if (event.code !== 'F3' || event.repeat) return;
  event.preventDefault();
  debugMode = !debugMode;
  world.setDebugVisible(debugMode);
  if (debugMode && document.pointerLockElement) document.exitPointerLock();
  updatePrompt();
});

function updateOverviewFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  const bounds = world.bounds;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const halfHeight = Math.max(depth / 2, width / (2 * Math.max(aspect, 0.1))) * 1.12;
  const halfWidth = halfHeight * aspect;
  overviewCamera.left = -halfWidth;
  overviewCamera.right = halfWidth;
  overviewCamera.top = halfHeight;
  overviewCamera.bottom = -halfHeight;
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
let currentSectorId = null;

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
    } else {
      footerCoordinate.textContent = '—';
      footerCoordinate.style.color = '';
    }
  }
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

  if (!debugMode) {
    player.update(delta);
    updateSectorDisplay();
  }
  world.updateDebugPlayer(player.position);
  renderer.render(scene, debugMode ? overviewCamera : camera);
}

animate();
