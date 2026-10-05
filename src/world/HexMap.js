import * as THREE from 'three';
import { buildHexMapData, getHexVertices, isPointInsideHex } from './hexGrid.js';
import { getSectorColor, getSectorInfo } from '../config/mapConfig.js';
import { buildPineGrove } from './PineGrove.js';
import { createHexDomeGeometry, createHexDomeRibGeometry, hexBoundaryDistanceAtAngle } from './hexGeometry.js';
import { SkyDome, resolveSunDirection } from './SkyDome.js';
import { buildForestFloorDetail, buildForestMist } from './ForestDetail.js';
import { createWindUniforms } from './wind.js';

function createFloorGeometry(radius) {
  const vertices = getHexVertices(0, 0, radius);
  const positions = [0, 0, 0];
  for (const vertex of vertices) positions.push(vertex.x, 0, vertex.z);

  const indices = [];
  for (let i = 0; i < vertices.length; i += 1) {
    // Reverse the x/z winding so the single flat face points upward (+Y).
    indices.push(0, 1 + ((i + 1) % vertices.length), 1 + i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function smoothStep(value, start, end) {
  if (end <= start) return value >= end ? 1 : 0;
  const t = THREE.MathUtils.clamp((value - start) / (end - start), 0, 1);
  return t * t * (3 - 2 * t);
}

function distanceToHexEdge(x, z, radius) {
  const apothem = radius * Math.sqrt(3) / 2;
  let nearest = apothem;
  for (let side = 0; side < 6; side += 1) {
    const normalAngle = Math.PI / 6 + side * Math.PI / 3;
    const projection = x * Math.cos(normalAngle) + z * Math.sin(normalAngle);
    nearest = Math.min(nearest, apothem - projection);
  }
  return nearest;
}

function forestTerrainOffset(x, z, radius, config) {
  // Keep the exact centre and all six sides at the original floor height. The
  // first condition is also useful for the initial spawn and for old callers
  // that use the sector centre as a canonical floor sample.
  if (Math.hypot(x, z) < 1e-7) return 0;
  const edgeDistance = Math.max(0, distanceToHexEdge(x, z, radius));
  const edgeMask = smoothStep(
    edgeDistance,
    0,
    config.forestTerrainEdgeBlend ?? 34,
  );
  const centerMask = smoothStep(
    Math.hypot(x, z),
    0,
    config.forestTerrainCenterBlend ?? 20,
  );
  const wave = (
    Math.sin(x * 0.031 + z * 0.014 + 0.7) * 0.46
    + Math.sin(x * 0.067 - z * 0.024 - 1.3) * 0.30
    + Math.cos((x + z) * 0.043) * 0.24
  );
  return (config.forestTerrainAmplitude ?? 8.5) * edgeMask * centerMask * wave;
}

const SOIL_BASE_TINT = new THREE.Color(1, 1, 1);
const SOIL_MOSS_TINT = new THREE.Color(0.62, 1.04, 0.58);
const SOIL_DRY_TINT = new THREE.Color(1.24, 1.06, 0.76);
const SOIL_HUMUS_TINT = new THREE.Color(0.68, 0.66, 0.66);
const soilScratch = new THREE.Color();

/**
 * Per-vertex soil shading for the forest floor: mossy hollows, sun-bleached
 * leaf drifts and damp humus. The result is multiplied into the shared soil
 * colour, so the biome keeps its identity while the ground stops reading as a
 * single flat brown plane.
 */
function forestSoilTintAt(x, z, height) {
  const patch = (
    Math.sin(x * 0.052 + 1.7) * Math.cos(z * 0.041 - 0.9)
    + 0.55 * Math.sin((x + z) * 0.026 + 2.4)
    + 0.35 * Math.cos((x - z) * 0.083)
  ) / 1.9;
  const dryness = (
    Math.sin(x * 0.031 - 0.4) * Math.sin(z * 0.037 + 1.1)
    + 0.5 * Math.cos((x * 0.7 + z) * 0.045)
  ) / 1.5;
  const mossAmount = THREE.MathUtils.smoothstep(patch, 0.12, 0.72);
  const dryAmount = THREE.MathUtils.smoothstep(dryness, 0.08, 0.78);
  const hollowAmount = THREE.MathUtils.smoothstep(-height, 0.6, 5.5);

  soilScratch.copy(SOIL_BASE_TINT);
  soilScratch.lerp(SOIL_MOSS_TINT, mossAmount * 0.85);
  soilScratch.lerp(SOIL_DRY_TINT, dryAmount * 0.5);
  soilScratch.lerp(SOIL_HUMUS_TINT, hollowAmount * 0.4);
  return soilScratch;
}

function createForestTerrainGeometry(radius, config) {
  const radialSegments = 24;
  const ringCount = 15;
  const sampleCount = radialSegments * 6;
  const positions = [0, forestTerrainOffset(0, 0, radius, config), 0];
  const colors = [];
  const indices = [];
  const pushColor = (x, y, z) => {
    const tint = forestSoilTintAt(x, z, y);
    colors.push(tint.r, tint.g, tint.b);
  };
  pushColor(0, positions[1], 0);

  for (let ring = 1; ring <= ringCount; ring += 1) {
    const radialScale = ring / ringCount;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const angle = sample / sampleCount * Math.PI * 2;
      const boundary = hexBoundaryDistanceAtAngle(radius, angle);
      const x = Math.cos(angle) * boundary * radialScale;
      const z = Math.sin(angle) * boundary * radialScale;
      const y = forestTerrainOffset(x, z, radius, config);
      positions.push(x, y, z);
      pushColor(x, y, z);
    }
  }

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const next = (sample + 1) % sampleCount;
    // Reverse the x/z winding so the face normal points upward (+Y).
    indices.push(0, 1 + next, 1 + sample);
  }

  for (let ring = 2; ring <= ringCount; ring += 1) {
    const innerStart = 1 + (ring - 2) * sampleCount;
    const outerStart = 1 + (ring - 1) * sampleCount;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const next = (sample + 1) % sampleCount;
      const inner = innerStart + sample;
      const innerNext = innerStart + next;
      const outer = outerStart + sample;
      const outerNext = outerStart + next;
      indices.push(inner, outerNext, outer);
      indices.push(inner, innerNext, outerNext);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = 'ForestTerrainGeometry_HEX_S';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createLeafGeometry() {
  // A small four-sided leaf with a raised central ridge. It is intentionally
  // double-sided so every leaf remains readable from the third-person camera.
  const positions = [
    0, 0.035, 0,
    -0.52, 0, 0.16,
    0, 0.01, 0.72,
    0.52, 0, 0.16,
    0, 0.035, 0,
    0, 0.01, 0.72,
    -0.52, 0, 0.16,
    0, 0.035, 0,
    0.52, 0, 0.16,
    0, 0.01, 0.72,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'LeafLitterLeafGeometry';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function createHexRingGeometry(innerRadius, outerRadius) {
  const innerVerts = getHexVertices(0, 0, innerRadius);
  const outerVerts = getHexVertices(0, 0, outerRadius);
  const positions = [];
  const indices = [];
  for (let i = 0; i < 6; i += 1) {
    positions.push(innerVerts[i].x, 0, innerVerts[i].z);
    positions.push(outerVerts[i].x, 0, outerVerts[i].z);
  }
  for (let i = 0; i < 6; i += 1) {
    const next = (i + 1) % 6;
    const i0 = i * 2;
    const o0 = i * 2 + 1;
    const i1 = next * 2;
    const o1 = next * 2 + 1;
    indices.push(i0, o0, i1);
    indices.push(i1, o0, o1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeCanvasLabel(text, colorHex = '#e9f2ee', subtitle = '') {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 210;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(18, 24, 26, 0.94)';
  context.beginPath();
  context.roundRect(6, 6, canvas.width - 12, canvas.height - 12, 18);
  context.fill();

  context.strokeStyle = colorHex;
  context.lineWidth = 6;
  context.stroke();

  if (typeof context.fillRect === 'function') {
    context.fillStyle = colorHex;
    context.fillRect(24, 18, canvas.width - 48, 4);
  }

  context.fillStyle = '#ffffff';
  context.font = '700 62px ui-monospace, SFMono-Regular, Consolas, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2 - (subtitle ? 16 : 0));

  if (subtitle) {
    context.fillStyle = colorHex;
    context.font = '600 36px ui-sans-serif, system-ui, sans-serif';
    context.fillText(subtitle.toUpperCase(), canvas.width / 2, canvas.height / 2 + 52);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(108, 29.5, 1);
  sprite.renderOrder = 1001;
  return sprite;
}

function axisForEdge(edge) {
  const dx = edge.end.x - edge.start.x;
  const dz = edge.end.z - edge.start.z;
  const length = Math.hypot(dx, dz);
  const axisX = dx / length;
  const axisZ = dz / length;
  return {
    axisX,
    axisZ,
    yaw: -Math.atan2(dz, dx),
    length,
  };
}

export class HexMap {
  constructor(scene, config) {
    this.config = config;
    this.data = buildHexMapData(config.hexRadius);
    this.sectors = this.data.sectors;
    this.sectorById = this.data.byId;
    this.gates = this.data.sharedEdges;
    this.boundaryEdges = this.data.boundaryEdges;
    this.bounds = this.data.bounds;
    this.group = new THREE.Group();
    this.group.name = 'HexMap';
    scene.add(this.group);

    this.floorGeometry = createFloorGeometry(config.hexRadius);
    this.forestTerrainGeometry = createForestTerrainGeometry(config.hexRadius, config);
    this.floorRingGeometry = createHexRingGeometry(config.hexRadius * 0.88, config.hexRadius * 0.905);
    this.leafGeometry = createLeafGeometry();

    this.floorMaterial = new THREE.MeshStandardMaterial({
      color: config.floorColor ?? 0xd99b26,
      roughness: 0.82,
      metalness: 0.06,
    });
    this.floorRingMaterial = new THREE.MeshStandardMaterial({
      color: 0x182024,
      roughness: 0.5,
      metalness: 0.45,
    });
    this.forestSoilMaterial = new THREE.MeshStandardMaterial({
      name: 'ForestSoilMaterial_HEX_S',
      color: config.forestSoilColor ?? 0x4f3829,
      vertexColors: true,
      roughness: 0.98,
      metalness: 0,
      flatShading: true,
    });
    this.forestSoilBorderMaterial = new THREE.MeshStandardMaterial({
      color: config.forestSoilDarkColor ?? 0x35251d,
      roughness: 1,
      metalness: 0,
    });
    this.forestLeafMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.wallMaterial = new THREE.MeshStandardMaterial({
      color: config.wallColor ?? 0x545d61,
      roughness: 0.90,
      metalness: 0.05,
    });
    this.gateFrameMaterial = new THREE.MeshStandardMaterial({
      color: config.gateFrameColor ?? 0x22272a,
      roughness: 0.28,
      metalness: 0.82,
    });
    this.portalTrimMaterial = new THREE.MeshStandardMaterial({
      color: 0x708186,
      roughness: 0.28,
      metalness: 0.86,
    });
    this.doorBodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x101a1e,
      roughness: 0.24,
      metalness: 0.88,
    });
    this.doorPlateMaterial = new THREE.MeshStandardMaterial({
      color: 0x27363b,
      roughness: 0.31,
      metalness: 0.82,
    });
    this.doorInsetMaterial = new THREE.MeshStandardMaterial({
      color: 0x111d21,
      roughness: 0.42,
      metalness: 0.72,
    });
    this.doorGrooveMaterial = new THREE.MeshStandardMaterial({
      color: 0x080f12,
      roughness: 0.48,
      metalness: 0.62,
    });
    this.portalLightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });
    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.doorGlyphGeometry = new THREE.RingGeometry(0.42, 0.58, 6);
    this.doorPartMeshes = new Map();
    this.doorPartRecords = new Map();
    this.doorTransform = new THREE.Object3D();
    this.portalYawQuaternion = new THREE.Quaternion();
    this.doorLocalYQuaternion = new THREE.Quaternion();
    this.doorLocalZQuaternion = new THREE.Quaternion();
    this.doorYAxis = new THREE.Vector3(0, 1, 0);
    this.doorZAxis = new THREE.Vector3(0, 0, 1);
    this.collisionBoxes = [];
    this.doors = [];
    this.sectorMeshes = new Map();
    this.floorMaterials = new Map();
    this.domeMeshes = new Map();
    this.domes = this.domeMeshes;
    this.domeRibMeshes = new Map();
    this.sectorLights = new Map();
    this.skies = [];
    this.cloudMeshes = [];
    this.forestLeafLitter = null;
    this.leafLitter = null;
    this.forestGround = null;
    this.forestLighting = null;
    this.forestLightTime = 0;
    this.forestUnderGrowth = null;
    this.underGrowth = null;
    this.forestMist = null;
    this.mistLayers = null;
    // One wind clock drives the pine crowns, the grass and the ferns, so the
    // whole biome breathes together instead of in separate rhythms.
    this.windUniforms = createWindUniforms();
    this.sunDirection = resolveSunDirection(config);

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'HexMapDebug';
    this.debugGroup.visible = false;
    this.group.add(this.debugGroup);

    this.buildFloors();
    this.buildDomeRoofs();
    this.buildSectorLighting();
    this.pineGrove = buildPineGrove(
      this.sectorById.get('HEX_S'),
      config,
      (x, z) => this.getFloorHeightAt(x, z),
      this.windUniforms,
    );
    if (this.pineGrove) this.group.add(this.pineGrove);
    this.buildForestUnderGrowth();
    this.buildWallsAndGates();
    this.buildDebugView();
  }

  /**
   * Grass, shrubs, rocks, fallen logs, mushrooms and the drifting mist that
   * turn HEX_S from a flat soil plate into a lived-in forest floor.
   */
  buildForestUnderGrowth() {
    const sector = this.sectorById.get('HEX_S');
    if (!sector) return;

    const keepClear = this.gates
      .filter((gate) => gate.aSectorId === sector.id || gate.bSectorId === sector.id)
      .map((gate) => ({
        x: gate.center.x - sector.center.x,
        z: gate.center.z - sector.center.z,
        radius: this.config.gateWidth / 2 + 8,
      }));

    this.forestUnderGrowth = buildForestFloorDetail({
      sector,
      config: { ...this.config, forestKeepClear: keepClear },
      floorHeightAt: (x, z) => this.getFloorHeightAt(x, z),
      treePlacements: this.pineGrove?.userData.treePlacements ?? [],
      windUniforms: this.windUniforms,
    });
    this.underGrowth = this.forestUnderGrowth;
    this.group.add(this.forestUnderGrowth);

    this.forestMist = buildForestMist(sector, this.config);
    this.mistLayers = this.forestMist.group;
    this.group.add(this.forestMist.group);
  }

  buildFloors() {
    for (const sector of this.sectors) {
      const isForest = sector.id === 'HEX_S';
      const color = isForest
        ? (this.config.forestSoilColor ?? 0x4f3829)
        : (this.config.sectorColors?.[sector.id]
          ?? getSectorColor(sector.id, sector.order));
      const sectorFloorMaterial = isForest
        ? this.forestSoilMaterial
        : new THREE.MeshStandardMaterial({
          color,
          roughness: 0.80,
          metalness: 0.06,
        });
      this.floorMaterials.set(sector.id, sectorFloorMaterial);

      const floor = new THREE.Mesh(
        isForest ? this.forestTerrainGeometry : this.floorGeometry,
        sectorFloorMaterial,
      );
      floor.name = `Floor_${sector.id}`;
      floor.position.set(sector.center.x, this.config.floorHeight, sector.center.z);
      floor.receiveShadow = true;
      floor.userData.sectorId = sector.id;
      floor.userData.biome = isForest ? 'forest-soil-and-leaves' : 'sector-floor';
      floor.userData.terrain = isForest ? 'interior-undulation-edge-flat' : 'flat';
      if (isForest) {
        floor.userData.terrainAmplitude = this.config.forestTerrainAmplitude ?? 8.5;
        floor.userData.edgeBlend = this.config.forestTerrainEdgeBlend ?? 34;
      }
      this.group.add(floor);
      this.sectorMeshes.set(sector.id, floor);
      if (isForest) this.forestTerrainMesh = floor;

      // The thin border is deliberately kept at the base level. HEX_S terrain
      // fades back to that exact height before every shared edge.
      const ring = new THREE.Mesh(
        this.floorRingGeometry,
        isForest ? this.forestSoilBorderMaterial : this.floorRingMaterial,
      );
      ring.name = `FloorRing_${sector.id}`;
      ring.position.set(sector.center.x, this.config.floorHeight + 0.02, sector.center.z);
      this.group.add(ring);

      if (isForest) {
        this.forestLeafLitter = this.buildForestLeafLitter(sector);
        this.leafLitter = this.forestLeafLitter;
        this.forestGround = this.forestLeafLitter;
      }
    }
  }

  buildForestLeafLitter(sector) {
    const count = Math.max(0, Math.floor(this.config.forestLeafCount ?? 1350));
    const group = new THREE.Group();
    group.name = 'ForestFloor_HEX_S';
    group.userData.sectorId = sector.id;
    group.userData.coverType = 'soil-and-leaf-litter';
    group.userData.leafCount = count;
    group.position.set(0, 0, 0);

    if (count === 0) {
      this.group.add(group);
      return group;
    }

    const leafMesh = new THREE.InstancedMesh(this.leafGeometry, this.forestLeafMaterial, count);
    leafMesh.name = 'LeafLitter_HEX_S';
    leafMesh.userData.sectorId = sector.id;
    leafMesh.userData.coverType = 'fallen-leaves';
    leafMesh.userData.leafCount = count;
    leafMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    leafMesh.castShadow = false;
    leafMesh.receiveShadow = true;

    let state = 0x1ee7c0de;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const transform = new THREE.Object3D();
    const colors = this.config.forestLeafColors?.length
      ? this.config.forestLeafColors
      : [0x8b5a2b, 0x6f4528, 0x4d652d];
    const safeRadius = Math.max(10, this.config.hexRadius - 10);

    for (let index = 0; index < count; index += 1) {
      let localX = 0;
      let localZ = 0;
      do {
        localX = (random() * 2 - 1) * safeRadius;
        localZ = (random() * 2 - 1) * safeRadius;
      } while (!isPointInsideHex(localX, localZ, 0, 0, safeRadius));

      const worldX = sector.center.x + localX;
      const worldZ = sector.center.z + localZ;
      const floorY = this.getFloorHeightAt(worldX, worldZ) ?? this.config.floorHeight;
      const size = 1.25 + random() * 2.15;
      transform.position.set(worldX, floorY + 0.22 + random() * 0.06, worldZ);
      transform.rotation.set(
        (random() - 0.5) * 0.28,
        random() * Math.PI * 2,
        (random() - 0.5) * 0.28,
      );
      transform.scale.set(size * (0.72 + random() * 0.52), size, size * (0.74 + random() * 0.45));
      transform.updateMatrix();
      leafMesh.setMatrixAt(index, transform.matrix);
      leafMesh.setColorAt(index, new THREE.Color(colors[index % colors.length]));
    }

    leafMesh.instanceMatrix.needsUpdate = true;
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
    leafMesh.computeBoundingSphere();
    group.add(leafMesh);
    this.group.add(group);
    return group;
  }

  /**
   * Every sector is roofed by an opaque cupola painted with its own sky: a
   * vertical gradient, a sun disc with halo and a drifting cloud deck. The
   * shells are never colliders and are hidden in the top-down overview so the
   * geometry underneath stays readable.
   */
  buildDomeRoofs() {
    this.domeGroup = new THREE.Group();
    this.domeGroup.name = 'HexDomeRoofs';
    this.domeGroup.userData.cellCount = this.sectors.length;
    this.domeGroup.userData.domeCount = this.sectors.length;
    this.domeGroup.userData.roofType = 'painted-hexagonal-sky-cupola';
    this.domeRoofs = this.domeGroup;
    this.group.add(this.domeGroup);

    for (const sector of this.sectors) {
      const sky = new SkyDome({
        sector,
        config: this.config,
        sunDirection: this.sunDirection,
      });
      this.domeGroup.add(sky.group);
      this.skies.push(sky);
      this.domeMeshes.set(sector.id, sky.shell);
      this.domeRibMeshes.set(sector.id, sky.ribs);
      this.cloudMeshes.push(...sky.cloudMeshes);
      if (sector.id === 'HEX_S') this.forestSky = sky;
    }

    this.domeMaterial = this.skies[0]?.shellMaterial ?? null;
    this.domeRibMaterial = this.skies[0]?.ribMaterial ?? null;
    this.cloudTotal = this.cloudMeshes.reduce(
      (total, mesh) => total + mesh.count,
      0,
    );
  }

  buildSectorLighting() {
    const sector = this.sectorById.get('HEX_S');
    if (!sector) return;

    const group = new THREE.Group();
    group.name = 'SectorLighting_HEX_S';
    group.userData.sectorId = sector.id;
    group.userData.biome = 'forest-canopy-light';
    this.group.add(group);

    // A brighter canopy wash keeps the dense grove from going muddy: the
    // green-tinted sky colour reads as light filtered through the needles.
    const hemisphere = new THREE.HemisphereLight(0xd6f7e2, 0x3a2c1e, 0.78);
    hemisphere.name = 'HEX_S_ForestHemisphere';
    hemisphere.position.set(sector.center.x, this.config.floorHeight + 65, sector.center.z);
    hemisphere.userData.sectorId = sector.id;
    group.add(hemisphere);

    const lightColors = this.config.forestLightColors ?? [0x9bf2bf, 0xffc477, 0x70d8c9];
    const placements = [
      { x: -92, y: 28, z: 58, color: lightColors[0], intensity: 1.05 },
      { x: 86, y: 34, z: 76, color: lightColors[1], intensity: 0.92 },
      { x: 14, y: 23, z: -74, color: lightColors[2], intensity: 0.82 },
    ];
    this.forestPointLights = [];
    for (const placement of placements) {
      const light = new THREE.PointLight(
        placement.color,
        (this.config.forestLightIntensity ?? 1.9) * placement.intensity,
        270,
        1.55,
      );
      light.name = `HEX_S_ForestLight_${this.forestPointLights.length}`;
      light.position.set(
        sector.center.x + placement.x,
        this.config.floorHeight + placement.y,
        sector.center.z + placement.z,
      );
      light.userData.sectorId = sector.id;
      light.userData.baseIntensity = light.intensity;
      light.userData.phase = this.forestPointLights.length * 1.7;
      group.add(light);
      this.forestPointLights.push(light);
    }

    this.forestLighting = group;
    this.hexSLights = group;
    this.sectorLights.set(sector.id, group);
  }

  addBoxRecord(target, edge, offsetAlong, length, height, thickness, y, extra = {}) {
    const { axisX, axisZ, yaw } = axisForEdge(edge);
    const offsetNormal = extra.offsetNormal ?? 0;
    const centerX = edge.center.x + axisX * offsetAlong - axisZ * offsetNormal;
    const centerZ = edge.center.z + axisZ * offsetAlong + axisX * offsetNormal;
    const record = {
      x: centerX,
      y,
      z: centerZ,
      yaw,
      length,
      height,
      thickness,
      ...extra,
    };
    target.push(record);

    if (extra.collidable !== false) {
      this.collisionBoxes.push({
        x: centerX,
        z: centerZ,
        axisX,
        axisZ,
        halfLength: length / 2,
        halfThickness: thickness / 2,
        minY: y - height / 2,
        maxY: y + height / 2,
      });
    }

    return record;
  }

  buildWallsAndGates() {
    const wallRecords = [];
    const frameRecords = [];
    const trimRecords = [];
    const lightRecords = [];
    const { wallHeight, wallThickness, floorHeight, gateWidth, gateFrameWidth, cornerOverlap } = this.config;
    const openingHeight = Math.min(
      this.config.gateOpeningHeight ?? wallHeight * 0.7,
      wallHeight - gateFrameWidth - 0.5,
    );
    const edgeLength = this.config.hexRadius;
    const postWidth = Math.max(4.2, gateFrameWidth * 2);
    const frameDepth = wallThickness + 1.4;
    const frameHeight = openingHeight + gateFrameWidth;
    const postOffset = gateWidth / 2 + postWidth / 2;

    if (gateWidth + 2 * gateFrameWidth >= edgeLength) {
      throw new RangeError('Gate opening and frame must fit within a hex side.');
    }

    const wallY = floorHeight + wallHeight / 2;
    for (const edge of this.boundaryEdges) {
      this.addBoxRecord(wallRecords, edge, 0, edgeLength + cornerOverlap,
        wallHeight, wallThickness, wallY);
    }

    for (const edge of this.gates) {
      const { axisX, axisZ, yaw } = axisForEdge(edge);
      const shoulder = gateWidth / 2 + gateFrameWidth;
      const panelSpan = edgeLength / 2 - shoulder;
      const extension = Math.min(cornerOverlap, panelSpan / 4);
      const panelLength = panelSpan + extension;
      const panelOffset = shoulder + panelSpan / 2 + extension / 2;

      for (const side of [-1, 1]) {
        this.addBoxRecord(wallRecords, edge, side * panelOffset, panelLength,
          wallHeight, wallThickness, wallY);
        // Deep, armored jambs anchor each sliding leaf to the wall.
        this.addBoxRecord(frameRecords, edge, side * postOffset, postWidth,
          frameHeight, frameDepth, floorHeight + frameHeight / 2);
      }

      // A solid lintel above the portal remains a real flight collision.
      const headerHeight = wallHeight - frameHeight;
      if (headerHeight > 0) {
        this.addBoxRecord(wallRecords, edge, 0, gateWidth + 2 * gateFrameWidth,
          headerHeight, wallThickness, floorHeight + frameHeight + headerHeight / 2);
      }

      // A machined cross-beam and crown turn the simple opening into a massive
      // portal housing while preserving the original walkable clear width.
      this.addBoxRecord(frameRecords, edge, 0, gateWidth + 2 * postWidth,
        gateFrameWidth, frameDepth, floorHeight + openingHeight + gateFrameWidth / 2);
      this.addBoxRecord(frameRecords, edge, 0, gateWidth + 2 * postWidth + 2.4,
        1.5, frameDepth + 1.2, floorHeight + wallHeight - 0.9,
        { collidable: false });

      const normalX = -axisZ;
      const normalZ = axisX;
      for (const sectorId of [edge.aSectorId, edge.bSectorId]) {
        const sector = this.sectorById.get(sectorId);
        const faceSign = Math.sign(
          (sector.center.x - edge.center.x) * normalX
          + (sector.center.z - edge.center.z) * normalZ,
        ) || 1;
        const faceOffset = faceSign * (frameDepth / 2 + 0.08);
        const accent = getSectorInfo(sector.id, sector.order).accent;

        // Fine metal reveals, repeated armor bands and sector-coded light rails
        // are mounted on both faces of every portal.
        for (const postSide of [-1, 1]) {
          const jambX = postSide * (gateWidth / 2 + 0.38);
          this.addBoxRecord(trimRecords, edge, jambX, 0.24,
            openingHeight - 1.2, 0.16,
            floorHeight + openingHeight / 2,
            { offsetNormal: faceOffset, collidable: false });
          this.addBoxRecord(trimRecords, edge,
            postSide * (postOffset + postWidth * 0.34), 0.28,
            frameHeight - 2.2, 0.14,
            floorHeight + frameHeight / 2,
            { offsetNormal: faceOffset, collidable: false });

          for (const bandY of [floorHeight + 2.4, floorHeight + openingHeight * 0.52]) {
            this.addBoxRecord(trimRecords, edge, postSide * postOffset, postWidth - 0.9,
              0.28, 0.14, bandY,
              { offsetNormal: faceOffset, collidable: false });
          }

          lightRecords.push({
            x: 0,
            y: floorHeight + openingHeight / 2,
            z: 0,
            yaw,
            color: accent,
            length: 0.18,
            height: openingHeight - 1.6,
            thickness: 0.12,
            offsetAlong: jambX,
            offsetNormal: faceOffset,
            edge,
          });
        }

        this.addBoxRecord(trimRecords, edge, 0, gateWidth - 1.2,
          0.24, 0.12, floorHeight + openingHeight - 0.62,
          { offsetNormal: faceOffset, collidable: false });
        lightRecords.push({
          x: 0,
          y: floorHeight + openingHeight - 0.7,
          z: 0,
          yaw,
          color: accent,
          length: gateWidth - 1.6,
          height: 0.18,
          thickness: 0.12,
          offsetNormal: faceOffset,
          edge,
        });
      }
    }

    this.wallInstancedMesh = this.createInstancedBoxes(wallRecords, this.wallMaterial, 'StructuralWalls');
    this.frameInstancedMesh = this.createInstancedBoxes(frameRecords, this.gateFrameMaterial, 'PortalExoskeletons');
    this.portalTrim = this.createInstancedBoxes(trimRecords, this.portalTrimMaterial, 'PortalArmourDetails');
    this.portalLights = this.createPortalLightInstances(lightRecords);
    this.wallRecordCount = wallRecords.length;
    this.frameRecordCount = frameRecords.length;
    this.trimRecordCount = trimRecords.length;

    this.buildPortalCrests(frameDepth);
    this.buildSlidingDoors(openingHeight, frameDepth);
  }

  createPortalLightInstances(records) {
    const positionedRecords = records.map((record) => {
      if (!record.edge) return record;
      const { axisX, axisZ, yaw } = axisForEdge(record.edge);
      const along = record.offsetAlong ?? 0;
      const normal = record.offsetNormal ?? 0;
      return {
        ...record,
        x: record.edge.center.x + axisX * along - axisZ * normal,
        z: record.edge.center.z + axisZ * along + axisX * normal,
        yaw,
      };
    });
    return this.createInstancedBoxes(positionedRecords, this.portalLightMaterial, 'PortalLightStrips');
  }

  buildPortalCrests(frameDepth) {
    this.portalCrestsGroup = new THREE.Group();
    this.portalCrestsGroup.name = 'PortalHexCrests';
    this.group.add(this.portalCrestsGroup);

    const faceCount = this.gates.length * 2;
    const baseMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(2.7, 2.7, 0.72, 6),
      this.gateFrameMaterial,
      faceCount,
    );
    const ringMesh = new THREE.InstancedMesh(
      new THREE.RingGeometry(2.12, 2.4, 6),
      this.portalLightMaterial,
      faceCount,
    );
    const coreMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.9, 6),
      this.portalLightMaterial,
      faceCount,
    );
    const chevronMesh = new THREE.InstancedMesh(
      this.boxGeometry,
      this.portalLightMaterial,
      faceCount * 2,
    );
    baseMesh.name = 'PortalCrest_HexBases';
    ringMesh.name = 'PortalCrest_AccentRings';
    coreMesh.name = 'PortalCrest_Cores';
    chevronMesh.name = 'PortalCrest_Chevrons';

    const transform = new THREE.Object3D();
    const parentRotation = new THREE.Quaternion();
    const detailRotation = new THREE.Quaternion();
    const rotateX = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2,
    );
    const rotateY = new THREE.Quaternion().setFromAxisAngle(this.doorYAxis, Math.PI);
    let faceIndex = 0;
    let chevronIndex = 0;

    for (const edge of this.gates) {
      const { yaw } = axisForEdge(edge);
      const normalX = Math.sin(yaw);
      const normalZ = Math.cos(yaw);
      parentRotation.setFromAxisAngle(this.doorYAxis, yaw);

      for (const faceSign of [-1, 1]) {
        const sector = [edge.aSectorId, edge.bSectorId]
          .map((id) => this.sectorById.get(id))
          .find((candidate) => (
            (candidate.center.x - edge.center.x) * normalX * faceSign
            + (candidate.center.z - edge.center.z) * normalZ * faceSign
          ) > 0);
        const accent = getSectorInfo(sector.id, sector.order).accent;
        const baseZ = faceSign * (frameDepth / 2 + 0.16);
        const crestY = this.config.floorHeight + this.config.wallHeight - 4.4;
        const crestX = edge.center.x + normalX * baseZ;
        const crestZ = edge.center.z + normalZ * baseZ;

        transform.position.set(crestX, crestY, crestZ);
        transform.quaternion.copy(parentRotation).multiply(rotateX);
        transform.scale.set(1, 1, 1);
        transform.updateMatrix();
        baseMesh.setMatrixAt(faceIndex, transform.matrix);

        for (const [mesh, depthOffset] of [[ringMesh, 0.39], [coreMesh, 0.4]]) {
          const outward = faceSign * depthOffset;
          transform.position.set(
            crestX + normalX * outward,
            crestY,
            crestZ + normalZ * outward,
          );
          transform.quaternion.copy(parentRotation);
          if (faceSign < 0) transform.quaternion.multiply(rotateY);
          transform.updateMatrix();
          mesh.setMatrixAt(faceIndex, transform.matrix);
          mesh.setColorAt(faceIndex, new THREE.Color(accent));
        }

        // A restrained double-chevron is kept as two tiny instanced bars per
        // crest so the art detail costs no additional draw calls per portal.
        for (const direction of [-1, 1]) {
          const localX = direction * 0.18;
          const localZ = faceSign * 0.46;
          transform.position.set(
            edge.center.x + normalX * baseZ + normalX * localZ + Math.cos(yaw) * localX,
            crestY,
            edge.center.z + normalZ * baseZ + normalZ * localZ - Math.sin(yaw) * localX,
          );
          detailRotation.setFromAxisAngle(this.doorZAxis, direction * 0.46);
          transform.quaternion.copy(parentRotation);
          if (faceSign < 0) transform.quaternion.multiply(rotateY);
          transform.quaternion.multiply(detailRotation);
          transform.scale.set(0.12, 0.66, 0.06);
          transform.updateMatrix();
          chevronMesh.setMatrixAt(chevronIndex, transform.matrix);
          chevronMesh.setColorAt(chevronIndex, new THREE.Color(0xdafcf4));
          chevronIndex += 1;
        }
        faceIndex += 1;
      }
    }

    for (const mesh of [baseMesh, ringMesh, coreMesh, chevronMesh]) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      this.portalCrestsGroup.add(mesh);
    }
    this.portalCrestBases = baseMesh;
    this.portalCrestRings = ringMesh;
    this.portalCrestCores = coreMesh;
    this.portalCrestChevrons = chevronMesh;
  }

  addDoorPart(door, type, leafSide, faceSign, localX, localY, localZ,
    scaleX, scaleY, scaleZ, options = {}) {
    const part = {
      type,
      leafSide,
      faceSign,
      localX,
      localY,
      localZ,
      scaleX,
      scaleY,
      scaleZ,
      color: options.color,
      rotationY: options.rotationY ?? 0,
      rotationZ: options.rotationZ ?? 0,
    };
    door.parts.push(part);
    this.doorPartRecords.get(type).push(part);
  }

  addDoorLeafParts(door, width, height, depth, openingHeight,
    faceSign, leafSide, accentColor) {
    const centerY = openingHeight / 2;
    const faceZ = faceSign * (depth / 2 + 0.045);
    const innerX = -leafSide * width * 0.27;

    this.addDoorPart(door, 'body', leafSide, faceSign,
      0, centerY, 0, width, height, depth);
    this.addDoorPart(door, 'armour', leafSide, faceSign,
      0, centerY, faceZ, width - 0.34, height - 0.42, 0.12);
    this.addDoorPart(door, 'inset', leafSide, faceSign,
      0, centerY, faceSign * (depth / 2 + 0.13), width * 0.68, height * 0.72, 0.08);

    const railZ = faceSign * (depth / 2 + 0.19);
    for (const railSide of [-1, 1]) {
      this.addDoorPart(door, 'trim', leafSide, faceSign,
        railSide * (width / 2 - 0.23), centerY, railZ, 0.17, height * 0.91, 0.1);
    }

    this.addDoorPart(door, 'energy', leafSide, faceSign,
      innerX, centerY, faceSign * (depth / 2 + 0.205), 0.18, height * 0.62, 0.085,
      { color: accentColor });

    for (const seamY of [-0.31, 0.31]) {
      this.addDoorPart(door, 'groove', leafSide, faceSign,
        0, centerY + seamY * height, faceSign * (depth / 2 + 0.19),
        width * 0.63, 0.105, 0.07);
    }

    // The paired, colored hex lock marks align as the two leaves meet.
    this.addDoorPart(door, 'glyph', leafSide, faceSign,
      innerX, centerY + height * 0.18, faceSign * (depth / 2 + 0.22),
      1, 1, 1, { color: accentColor, rotationY: faceSign < 0 ? Math.PI : 0 });
  }

  createDoorPartInstances() {
    const definitions = {
      body: { geometry: this.boxGeometry, material: this.doorBodyMaterial, name: 'DoorLeaves_TitaniumCores' },
      armour: { geometry: this.boxGeometry, material: this.doorPlateMaterial, name: 'DoorLeaves_ArmourPlates' },
      inset: { geometry: this.boxGeometry, material: this.doorInsetMaterial, name: 'DoorLeaves_RecessedPanels' },
      trim: { geometry: this.boxGeometry, material: this.portalTrimMaterial, name: 'DoorLeaves_EdgeRails' },
      energy: { geometry: this.boxGeometry, material: this.portalLightMaterial, name: 'DoorLeaves_EnergySpines' },
      groove: { geometry: this.boxGeometry, material: this.doorGrooveMaterial, name: 'DoorLeaves_ArmourSeams' },
      glyph: { geometry: this.doorGlyphGeometry, material: this.portalLightMaterial, name: 'DoorLeaves_HexLockGlyphs' },
    };

    for (const [type, definition] of Object.entries(definitions)) {
      const records = this.doorPartRecords.get(type);
      const mesh = new THREE.InstancedMesh(definition.geometry, definition.material, records.length);
      mesh.name = definition.name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      records.forEach((record, index) => {
        record.instanceIndex = index;
        if (record.color !== undefined) mesh.setColorAt(index, new THREE.Color(record.color));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.doorPartMeshes.set(type, mesh);
      this.group.add(mesh);
    }
  }

  buildSlidingDoors(openingHeight, frameDepth) {
    const gateWidth = this.config.gateWidth;
    const leafWidth = gateWidth / 2 + 0.36;
    const leafHeight = openingHeight - 0.38;
    const leafDepth = 1.05;
    const slideDistance = gateWidth * 0.96;
    const faceOffset = frameDepth / 2 - leafDepth / 2 + 0.12;
    this.doorPartRecords = new Map(
      ['body', 'armour', 'inset', 'trim', 'energy', 'groove', 'glyph']
        .map((type) => [type, []]),
    );

    for (const edge of this.gates) {
      const { axisX, axisZ, yaw } = axisForEdge(edge);
      const normalX = -axisZ;
      const normalZ = axisX;
      const sectors = [edge.aSectorId, edge.bSectorId].map((id) => this.sectorById.get(id));
      const positiveSector = sectors.find((sector) => (
        (sector.center.x - edge.center.x) * normalX
        + (sector.center.z - edge.center.z) * normalZ
      ) > 0);
      const negativeSector = sectors.find((sector) => sector !== positiveSector);
      const portal = new THREE.Group();
      portal.name = `SlidingPortal_${edge.id}`;
      portal.position.set(edge.center.x, this.config.floorHeight, edge.center.z);
      portal.rotation.y = yaw;
      this.group.add(portal);

      const door = {
        edge,
        portal,
        axisX,
        axisZ,
        openAmount: 0,
        closeTimer: 0,
        slideDistance,
        faceOffset,
        parts: [],
        collisionBoxes: [],
      };

      for (const faceSign of [-1, 1]) {
        const sector = faceSign > 0 ? positiveSector : negativeSector;
        const accentColor = getSectorInfo(sector.id, sector.order).accent;
        for (const leafSide of [-1, 1]) {
          this.addDoorLeafParts(
            door,
            leafWidth,
            leafHeight,
            leafDepth,
            openingHeight,
            faceSign,
            leafSide,
            accentColor,
          );
        }
      }

      for (const leafSide of [-1, 1]) {
        const collisionBox = {
          x: edge.center.x + axisX * leafSide * gateWidth / 4,
          z: edge.center.z + axisZ * leafSide * gateWidth / 4,
          axisX,
          axisZ,
          halfLength: leafWidth / 2,
          halfThickness: (this.config.wallThickness + 0.28) / 2,
          minY: this.config.floorHeight,
          maxY: this.config.floorHeight + openingHeight,
          door,
          leafSide,
        };
        door.collisionBoxes.push(collisionBox);
        this.collisionBoxes.push(collisionBox);
      }

      this.doors.push(door);
    }

    this.createDoorPartInstances();
    // Shared instance matrices stay current even before the first animation tick.
    for (const door of this.doors) this.syncSlidingDoor(door);
    this.flushDoorPartMatrices();
  }

  syncSlidingDoor(door) {
    const centerOffset = this.config.gateWidth / 4 + door.openAmount * door.slideDistance;
    for (const box of door.collisionBoxes) {
      const offset = box.leafSide * centerOffset;
      box.x = door.edge.center.x + door.axisX * offset;
      box.z = door.edge.center.z + door.axisZ * offset;
    }

    this.portalYawQuaternion.setFromAxisAngle(this.doorYAxis, door.portal.rotation.y);
    for (const part of door.parts) {
      const mesh = this.doorPartMeshes.get(part.type);
      if (!mesh) continue;
      const localX = part.leafSide * centerOffset + part.localX;
      const localZ = part.faceSign * door.faceOffset + part.localZ;
      const transform = this.doorTransform;
      transform.position.set(
        door.edge.center.x + door.axisX * localX - door.axisZ * localZ,
        this.config.floorHeight + part.localY,
        door.edge.center.z + door.axisZ * localX + door.axisX * localZ,
      );
      transform.quaternion.copy(this.portalYawQuaternion);
      if (part.rotationY) {
        this.doorLocalYQuaternion.setFromAxisAngle(this.doorYAxis, part.rotationY);
        transform.quaternion.multiply(this.doorLocalYQuaternion);
      }
      if (part.rotationZ) {
        this.doorLocalZQuaternion.setFromAxisAngle(this.doorZAxis, part.rotationZ);
        transform.quaternion.multiply(this.doorLocalZQuaternion);
      }
      transform.scale.set(part.scaleX, part.scaleY, part.scaleZ);
      transform.updateMatrix();
      mesh.setMatrixAt(part.instanceIndex, transform.matrix);
    }
  }

  flushDoorPartMatrices() {
    for (const mesh of this.doorPartMeshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }

  update(deltaSeconds, playerPosition) {
    if (!playerPosition) return;
    const dt = Math.max(0, deltaSeconds);
    const openRadius = this.config.doorOpenRadius ?? 48;
    const closeDelay = this.config.doorCloseDelay ?? 1.05;
    const motionSpeed = this.config.doorMotionSpeed ?? 3.2;
    let matricesDirty = false;

    for (const door of this.doors) {
      const distance = Math.hypot(
        playerPosition.x - door.edge.center.x,
        playerPosition.z - door.edge.center.z,
      );
      if (distance <= openRadius) {
        door.closeTimer = closeDelay;
      } else {
        door.closeTimer = Math.max(0, door.closeTimer - dt);
      }

      const target = door.closeTimer > 0 ? 1 : 0;
      const change = Math.min(Math.abs(target - door.openAmount), motionSpeed * dt);
      if (change === 0) continue;
      door.openAmount += Math.sign(target - door.openAmount) * change;
      this.syncSlidingDoor(door);
      matricesDirty = true;
    }
    if (matricesDirty) this.flushDoorPartMatrices();

    // Sky first: the painted cupolas drift their clouds, and the shared wind
    // clock advances so the pines and the undergrowth sway on the same gust.
    for (const sky of this.skies) sky.update(dt);
    this.forestMist?.update(dt);
    this.windUniforms.time.value += dt * (this.config.windStrength ?? 1);

    // The forest lights breathe very subtly, like sunlight moving through a
    // canopy. This is deliberately restrained so the changed HEX_S lighting
    // feels atmospheric rather than like a flashing effect.
    this.forestLightTime += dt;
    for (const light of this.forestPointLights ?? []) {
      const baseIntensity = light.userData.baseIntensity ?? light.intensity;
      const phase = light.userData.phase ?? 0;
      light.intensity = baseIntensity * (0.91 + Math.sin(this.forestLightTime * 0.8 + phase) * 0.06);
    }
  }

  createInstancedBoxes(records, material, name) {
    const mesh = new THREE.InstancedMesh(this.boxGeometry, material, records.length);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const transform = new THREE.Object3D();

    records.forEach((record, index) => {
      transform.position.set(record.x, record.y, record.z);
      transform.rotation.set(0, record.yaw, 0);
      transform.scale.set(record.length, record.height, record.thickness);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      if (record.color !== undefined) mesh.setColorAt(index, new THREE.Color(record.color));
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  buildDebugView() {
    const boundaryPositions = [];
    for (const sector of this.sectors) {
      const vertices = getHexVertices(sector.center.x, sector.center.z, this.config.hexRadius);
      for (let i = 0; i < vertices.length; i += 1) {
        const start = vertices[i];
        const end = vertices[(i + 1) % vertices.length];
        boundaryPositions.push(
          start.x, this.config.floorHeight + 0.35, start.z,
          end.x, this.config.floorHeight + 0.35, end.z,
        );
      }

      const info = getSectorInfo(sector.id, sector.order);
      const colorHex = `#${info.color.toString(16).padStart(6, '0')}`;
      const label = makeCanvasLabel(sector.id, colorHex, info.name);
      label.position.set(
        sector.center.x,
        this.config.floorHeight + this.config.wallHeight + 14,
        sector.center.z,
      );
      this.debugGroup.add(label);
    }

    const boundaryGeometry = new THREE.BufferGeometry();
    boundaryGeometry.setAttribute('position', new THREE.Float32BufferAttribute(boundaryPositions, 3));
    const boundaryLines = new THREE.LineSegments(
      boundaryGeometry,
      new THREE.LineBasicMaterial({ color: 0x3bd2c5, transparent: true, opacity: 0.86, depthTest: false }),
    );
    boundaryLines.renderOrder = 1000;
    this.debugGroup.add(boundaryLines);

    const gatePositions = [];
    for (const edge of this.gates) {
      const dx = edge.end.x - edge.start.x;
      const dz = edge.end.z - edge.start.z;
      const length = Math.hypot(dx, dz);
      const normalX = -dz / length;
      const normalZ = dx / length;
      const markerLength = 14;
      gatePositions.push(
        edge.center.x - normalX * markerLength / 2, this.config.floorHeight + 0.7, edge.center.z - normalZ * markerLength / 2,
        edge.center.x + normalX * markerLength / 2, this.config.floorHeight + 0.7, edge.center.z + normalZ * markerLength / 2,
      );
    }
    const gateGeometry = new THREE.BufferGeometry();
    gateGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gatePositions, 3));
    const gateLines = new THREE.LineSegments(
      gateGeometry,
      new THREE.LineBasicMaterial({ color: 0xf0bc69, depthTest: false }),
    );
    gateLines.renderOrder = 1002;
    this.debugGroup.add(gateLines);

    const originPoints = [
      new THREE.Vector3(-18, this.config.floorHeight + 1, 0),
      new THREE.Vector3(18, this.config.floorHeight + 1, 0),
      new THREE.Vector3(0, this.config.floorHeight + 1, -18),
      new THREE.Vector3(0, this.config.floorHeight + 1, 18),
    ];
    const originGeometry = new THREE.BufferGeometry().setFromPoints(originPoints);
    const originAxes = new THREE.LineSegments(
      originGeometry,
      new THREE.LineBasicMaterial({ color: 0xe5e9e7, depthTest: false }),
    );
    originAxes.renderOrder = 1003;
    this.debugGroup.add(originAxes);

    const originMarker = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xf0bc69, depthTest: false }),
    );
    originMarker.position.set(0, this.config.floorHeight + 2.5, 0);
    originMarker.renderOrder = 1004;
    this.debugGroup.add(originMarker);

    this.playerMarker = new THREE.Mesh(
      new THREE.SphereGeometry(3, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xed8068, depthTest: false }),
    );
    this.playerMarker.position.set(0, this.config.floorHeight + 3, 0);
    this.playerMarker.renderOrder = 1005;
    this.debugGroup.add(this.playerMarker);
  }

  setDebugVisible(visible) {
    this.debugGroup.visible = visible;
    // The sky cupolas would hide the whole map from the overview camera, and
    // the mist would veil it, so both step aside while the map is annotated.
    if (this.domeGroup) this.domeGroup.visible = !visible;
    if (this.mistLayers) this.mistLayers.visible = !visible;
  }

  updateDebugPlayer(position) {
    if (!this.playerMarker) return;
    this.playerMarker.position.set(position.x, position.y + 2.5, position.z);
  }

  getSector(id) {
    return this.sectorById.get(id) ?? null;
  }

  getSectorAt(x, z) {
    for (const sector of this.sectors) {
      if (isPointInsideHex(
        x,
        z,
        sector.center.x,
        sector.center.z,
        this.config.hexRadius,
      )) return sector;
    }
    return null;
  }

  getTerrainHeightAt(x, z) {
    const sector = this.getSectorAt(x, z);
    if (!sector) return null;
    if (sector.id !== 'HEX_S') return this.config.floorHeight;
    return this.config.floorHeight + forestTerrainOffset(
      x - sector.center.x,
      z - sector.center.z,
      this.config.hexRadius,
      this.config,
    );
  }

  getFloorHeightAt(x, z) {
    return this.getTerrainHeightAt(x, z);
  }

  resolveHorizontalPosition(
    x,
    z,
    radius,
    playerBottomY = this.config.floorHeight,
    playerHeight = 1.8,
  ) {
    let resolvedX = x;
    let resolvedZ = z;

    // A few inexpensive passes resolve corners where two perpendicular-ish
    // wall segments meet while preserving smooth wall sliding.
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = false;

      for (const box of this.collisionBoxes) {
        const overlapsVertically = playerBottomY < box.maxY
          && playerBottomY + playerHeight > box.minY;
        if (!overlapsVertically) continue;

        const deltaX = resolvedX - box.x;
        const deltaZ = resolvedZ - box.z;
        const along = deltaX * box.axisX + deltaZ * box.axisZ;
        const across = deltaX * -box.axisZ + deltaZ * box.axisX;
        const nearestAlong = THREE.MathUtils.clamp(along, -box.halfLength, box.halfLength);
        const nearestAcross = THREE.MathUtils.clamp(across, -box.halfThickness, box.halfThickness);
        let pushAlong = along - nearestAlong;
        let pushAcross = across - nearestAcross;
        let distanceSquared = pushAlong * pushAlong + pushAcross * pushAcross;

        if (distanceSquared >= radius * radius) continue;

        if (distanceSquared < 1e-12) {
          const alongPenetration = box.halfLength + radius - Math.abs(along);
          const acrossPenetration = box.halfThickness + radius - Math.abs(across);
          if (alongPenetration < acrossPenetration) {
            pushAlong = (along < 0 ? -1 : 1) * alongPenetration;
            pushAcross = 0;
          } else {
            pushAlong = 0;
            pushAcross = (across < 0 ? -1 : 1) * acrossPenetration;
          }

          // The center is inside the wall rectangle. Push it straight out by
          // the full penetration depth instead of treating it as a near point.
          resolvedX += pushAlong * box.axisX + pushAcross * -box.axisZ;
          resolvedZ += pushAlong * box.axisZ + pushAcross * box.axisX;
          changed = true;
          continue;
        }

        const distance = Math.sqrt(distanceSquared);
        if (distance < 1e-8) continue;
        const correction = (radius - distance) / distance;
        const correctionAlong = pushAlong * correction;
        const correctionAcross = pushAcross * correction;
        resolvedX += correctionAlong * box.axisX + correctionAcross * -box.axisZ;
        resolvedZ += correctionAlong * box.axisZ + correctionAcross * box.axisX;
        changed = true;
      }

      if (!changed) break;
    }

    return { x: resolvedX, z: resolvedZ };
  }
}
