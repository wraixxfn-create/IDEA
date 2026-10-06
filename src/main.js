import * as THREE from 'three';
import './style.css';
import { MAP_CONFIG, PLAYER_CONFIG, getSectorInfo } from './config/mapConfig.js';
import { HexMap } from './world/HexMap.js';
import { PlayerController } from './player/PlayerController.js';
import { resolveSunDirection } from './world/SkyDome.js';
import { getHexVertices } from './world/hexGrid.js';

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

  if (debugMode) {
    enterLabel.textContent = 'Debug overview active';
    promptNote.textContent = 'Sector IDs, boundaries and open-gate locations are visible · F3 returns';
    enterButton.disabled = true;
    return;
  }

  if (minimapOpen) {
    enterLabel.textContent = 'Mappa aperta';
    promptNote.textContent = 'Premi M per chiudere la mappa';
    enterButton.disabled = true;
    return;
  }

  enterButton.disabled = false;
  enterLabel.textContent = hasStarted ? 'Riprendi esplorazione' : 'Click to explore';
  promptNote.textContent = 'Mouse orbits · M mappa · Shift dashes · Esc apre il menù';
}

player.onLockChange = (locked) => {
  if (locked) hasStarted = true;
  updatePrompt();
  if (!locked && !debugMode && hasStarted) enterButton.focus({ preventScroll: true });
};
player.onFlightChange = () => updatePrompt();

enterButton.addEventListener('click', () => {
  if (!debugMode) player.requestPointerLock();
});

function setDebugMode(enabled) {
  debugMode = enabled;
  world.setDebugVisible(debugMode);
  if (debugMode) player.releasePointerLock();
  updatePrompt();
}

overviewButton.addEventListener('click', () => setDebugMode(true));

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') {
    // Browsers may handle Esc themselves; pointerlockchange also opens the
    // menu. Explicit handling covers debug view and already-unlocked states.
    if (minimapOpen) toggleMinimap(false);
    if (debugMode) setDebugMode(false);
    updatePrompt();
    if (hasStarted) enterButton.focus({ preventScroll: true });
    return;
  }
  if (event.code === 'KeyM' && !event.repeat) {
    event.preventDefault();
    toggleMinimap(!minimapOpen);
    return;
  }
  if (event.code !== 'F3' || event.repeat) return;
  event.preventDefault();
  setDebugMode(!debugMode);
});

function toggleMinimap(open) {
  minimapOpen = open;
  minimapOverlay.classList.toggle('is-hidden', !open);
  if (open) {
    renderMinimap();
    // Release pointer lock so the player can see the cursor.
    player.releasePointerLock();
  }
  updatePrompt();
}

function renderMinimap() {
  const canvas = minimapCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Compute the world-space bounding box of all hex sectors.
  const bounds = world.bounds;
  const worldW = bounds.maxX - bounds.minX;
  const worldD = bounds.maxZ - bounds.minZ;
  const margin = 30;
  const scaleX = (w - margin * 2) / worldW;
  const scaleZ = (h - margin * 2) / worldD;
  const scale = Math.min(scaleX, scaleZ);
  const offsetX = (w - worldW * scale) / 2;
  const offsetZ = (h - worldD * scale) / 2;

  const toScreen = (wx, wz) => ({
    x: offsetX + (wx - bounds.minX) * scale,
    y: offsetZ + (wz - bounds.minZ) * scale,
  });

  const currentSector = world.getSectorAt(player.position.x, player.position.z);
  const playerScreen = toScreen(player.position.x, player.position.z);

  // Draw each sector.
  for (const sector of world.sectors) {
    const info = getSectorInfo(sector.id, sector.order);
    const vertices = getHexVertices(sector.center.x, sector.center.z, MAP_CONFIG.hexRadius);
    const screenVerts = vertices.map((v) => toScreen(v.x, v.z));

    // Fill the sector polygon.
    ctx.beginPath();
    ctx.moveTo(screenVerts[0].x, screenVerts[0].y);
    for (let i = 1; i < screenVerts.length; i += 1) {
      ctx.lineTo(screenVerts[i].x, screenVerts[i].y);
    }
    ctx.closePath();

    const isCurrent = currentSector?.id === sector.id;
    const baseColor = `#${info.accent.toString(16).padStart(6, '0')}`;
    ctx.fillStyle = isCurrent
      ? `${baseColor}38`
      : 'rgba(22, 28, 30, 0.55)';
    ctx.fill();

    // Sector border.
    ctx.strokeStyle = isCurrent ? baseColor : 'rgba(200, 215, 210, 0.28)';
    ctx.lineWidth = isCurrent ? 2.2 : 1;
    ctx.stroke();

    // Sector label.
    const center = toScreen(sector.center.x, sector.center.z);
    ctx.fillStyle = isCurrent ? '#ffffff' : 'rgba(220, 230, 226, 0.6)';
    ctx.font = isCurrent ? '700 11px ui-monospace, monospace' : '500 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sector.id, center.x, center.y - 6);
    ctx.fillStyle = isCurrent ? 'rgba(255,255,255,0.72)' : 'rgba(200, 210, 206, 0.42)';
    ctx.font = '500 8px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(info.name, center.x, center.y + 8);
  }

  // Draw gate connections between sectors.
  ctx.strokeStyle = 'rgba(235, 186, 105, 0.45)';
  ctx.lineWidth = 1.5;
  for (const gate of world.gates) {
    const a = toScreen(gate.center.x, gate.center.z);
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Draw player position.
  ctx.fillStyle = '#ef6456';
  ctx.shadowColor = '#ef6456';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(playerScreen.x, playerScreen.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Player direction indicator.
  const dirLen = 12;
  const dirX = playerScreen.x - Math.sin(player.facingYaw) * dirLen;
  const dirY = playerScreen.y - Math.cos(player.facingYaw) * dirLen;
  ctx.strokeStyle = '#ef6456';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playerScreen.x, playerScreen.y);
  ctx.lineTo(dirX, dirY);
  ctx.stroke();

  // Update legend.
  if (minimapLegend) {
    minimapLegend.innerHTML = currentSector
      ? `<span><span class="legend-dot" style="background:#ef6456"></span>Tu sei in <strong style="color:#${getSectorInfo(currentSector.id, currentSector.order).accent.toString(16).padStart(6, '0')}">${getSectorInfo(currentSector.id, currentSector.order).name}</strong></span>`
      : '<span><span class="legend-dot" style="background:#ef6456"></span>Posizione sconosciuta</span>';
  }
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

  // Keep the minimap player position current while it is open.
  if (minimapOpen) renderMinimap();
}

animate();
