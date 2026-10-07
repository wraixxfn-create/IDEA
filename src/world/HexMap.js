import * as THREE from 'three';
import { buildHexMapData, getHexVertices, isPointInsideHex } from './hexGrid.js';
import { getSectorColor, getSectorInfo } from '../config/mapConfig.js';
import { buildPineGrove } from './PineGrove.js';
import { createHexDomeGeometry, createHexDomeRibGeometry, hexBoundaryDistanceAtAngle } from './hexGeometry.js';
import { SkyDome, resolveSunDirection } from './SkyDome.js';
import { buildForestFloorDetail, buildForestMist } from './ForestDetail.js';
import { buildForestRain } from './Rain.js';
import { buildForestBirds } from './ForestBirds.js';
import { createForestTerrain } from './ForestTerrain.js';
import { createVolcanicTerrain } from './VolcanicTerrain.js';
import { buildLavaPool } from './LavaPool.js';
import { buildLavaFlow, buildLavaSecondaryFlow } from './LavaFlow.js';
import { installCooledCrust } from './CooledCrust.js';
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

const LEAF_UP = new THREE.Vector3(0, 1, 0);

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

/**
 * The thin border band that marks a sector's rim. `heightAt` lets the forest
 * copy lay itself on the baked relief instead of slicing through it, so the
 * band stays visible over every crown and hollow.
 */
function createHexRingGeometry(innerRadius, outerRadius, heightAt = null, segmentsPerSide = 1) {
  const steps = Math.max(1, Math.round(segmentsPerSide));
  const innerVerts = getHexVertices(0, 0, innerRadius);
  const outerVerts = getHexVertices(0, 0, outerRadius);
  const positions = [];
  const indices = [];
  const sample = (x, z) => (typeof heightAt === 'function' ? heightAt(x, z) : 0);

  for (let side = 0; side < 6; side += 1) {
    const nextSide = (side + 1) % 6;
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      const ix = innerVerts[side].x + (innerVerts[nextSide].x - innerVerts[side].x) * t;
      const iz = innerVerts[side].z + (innerVerts[nextSide].z - innerVerts[side].z) * t;
      const ox = outerVerts[side].x + (outerVerts[nextSide].x - outerVerts[side].x) * t;
      const oz = outerVerts[side].z + (outerVerts[nextSide].z - outerVerts[side].z) * t;
      positions.push(ix, sample(ix, iz), iz);
      positions.push(ox, sample(ox, oz), oz);
    }
  }

  const ringVertices = steps * 6;
  for (let i = 0; i < ringVertices; i += 1) {
    const next = (i + 1) % ringVertices;
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
    // HEX_S is modelled once and read by everything: the mesh the player sees,
    // the height the player stands on and the scatter that plants the forest
    // all come out of the same baked lattice (see ForestTerrain.js).
    this.forestTerrain = createForestTerrain(config.hexRadius, config, 'HEX_S');
    this.forestTerrainGeometry = this.forestTerrain.geometry;
    // HEX_SE is the volcanic sector: the flat crimson plate is replaced by a
    // large baked relief (see VolcanicTerrain.js) built on the same lattice
    // engine, with a flat apron around each of the sector's four portals so
    // every entrance stays level. Its rim is pinned to the shared floor
    // height, so the walls, the gates and the neighbouring sectors are
    // untouched by it.
    this.volcanicTerrain = createVolcanicTerrain(
      config.hexRadius,
      config,
      'HEX_SE',
      this.sectorGateAprons('HEX_SE'),
    );
    this.volcanicTerrainGeometry = this.volcanicTerrain.geometry;
    // Every sector whose floor is a baked relief, by id: the walkable-surface
    // queries below read the terrain the player is actually standing on.
    this.sectorTerrains = new Map([
      ['HEX_S', this.forestTerrain],
      ['HEX_SE', this.volcanicTerrain],
    ]);
    this.floorRingGeometry = createHexRingGeometry(config.hexRadius * 0.88, config.hexRadius * 0.905);
    this.forestRingGeometry = createHexRingGeometry(
      config.hexRadius * 0.88,
      config.hexRadius * 0.905,
      (x, z) => this.forestTerrain.heightAt(x, z) + 0.05,
      18,
    );
    this.volcanicRingGeometry = createHexRingGeometry(
      config.hexRadius * 0.88,
      config.hexRadius * 0.905,
      (x, z) => this.volcanicTerrain.heightAt(x, z) + 0.05,
      18,
    );
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
    });
    this.forestSoilBorderMaterial = new THREE.MeshStandardMaterial({
      color: config.forestSoilDarkColor ?? 0x35251d,
      roughness: 1,
      metalness: 0,
    });
    // A simple gray/dark volcanic rock for HEX_SE: the relief is shaded per
    // vertex (ash plains, darker hollows, pale heights), the material itself
    // stays a plain desaturated basalt — except where the sector's own lava has
    // chilled against it. The cooled crust below is the one texture this
    // material carries, and it is blended in by the terrain's own lattice.
    this.volcanicRockMaterial = new THREE.MeshStandardMaterial({
      name: 'VolcanicRockMaterial_HEX_SE',
      color: config.volcanicRockColor ?? 0x4f5157,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.04,
    });
    // The crust the existing lava left on the ground around it: dark plates,
    // cracked sections and a dull red heat, measured from the pool's shoreline
    // and both channels, and drawn by this same material on this same mesh. No
    // new geometry, no new draw call, no animation and no gameplay effect.
    this.cooledCrust = this.volcanicTerrain.cooledCrust ?? null;
    installCooledCrust(this.volcanicRockMaterial, this.cooledCrust, config);
    this.volcanicBorderMaterial = new THREE.MeshStandardMaterial({
      color: config.volcanicRockDarkColor ?? 0x26282c,
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
    // HEX_S is the only sector with weather of its own (see Rain.js).
    this.forestRain = null;
    this.rain = null;
    // HEX_SE carries the world's only lava: one crater pool, its main outlet
    // and one narrower branch (see LavaPool.js / LavaFlow.js).
    this.volcanicLava = null;
    this.lavaPool = null;
    this.lavaFlow = null;
    this.lavaSecondaryFlow = null;
    // ...and the only one with wildlife (see ForestBirds.js).
    this.forestBirds = null;
    this.birds = null;
    // One wind clock drives the pine crowns, the grass and the ferns, so the
    // whole biome breathes together instead of in separate rhythms.
    this.windUniforms = createWindUniforms();
    this.sunDirection = resolveSunDirection(config);

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'HexMapDebug';
    this.debugGroup.visible = false;
    this.group.add(this.debugGroup);

    this.buildFloors();
    this.buildLava();
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
    this.buildForestWeather();
    this.buildBirds();
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
      normalAt: (x, z, target) => this.getTerrainNormalAt(x, z, target),
      treePlacements: this.pineGrove?.userData.treePlacements ?? [],
      windUniforms: this.windUniforms,
    });
    this.underGrowth = this.forestUnderGrowth;
    this.group.add(this.forestUnderGrowth);

    this.forestMist = buildForestMist(sector, this.config);
    this.mistLayers = this.forestMist.group;
    this.group.add(this.forestMist.group);
  }

  /**
   * HEX_SE only: the existing pool, its main outlet and one smaller side
   * branch. Three static meshes share one lava material. No rocks, smoke,
   * particles, lights, damage, colliders or per-frame lava updates.
   */
  buildLava() {
    const terrain = this.volcanicTerrain;
    if (!terrain?.lavaPool) return;
    this.volcanicLava = buildLavaPool(terrain, terrain.lavaPool, this.config);
    this.lavaPool = this.volcanicLava;
    if (!this.volcanicLava) return;
    const sector = this.sectorById.get('HEX_SE');
    this.volcanicLava.group.position.set(sector.center.x, this.config.floorHeight, sector.center.z);
    this.group.add(this.volcanicLava.group);
    this.lavaFlow = buildLavaFlow(terrain, terrain.lavaFlow, this.config);
    if (this.lavaFlow) {
      this.lavaFlow.group.position.copy(this.volcanicLava.group.position);
      this.group.add(this.lavaFlow.group);
    }
    this.lavaSecondaryFlow = buildLavaSecondaryFlow(terrain, terrain.lavaSecondaryFlow, this.config);
    if (this.lavaSecondaryFlow) {
      this.lavaSecondaryFlow.group.position.copy(this.volcanicLava.group.position);
      this.group.add(this.lavaSecondaryFlow.group);
    }
  }

  /**
   * The birds of the wood: a mixed flock of chaffinches, great tits and jays
   * that perch in the pines, drop to the floor to feed and flush when the
   * explorer walks into them. They stand on the same terrain and land in the
   * same trees as everything else here, and they come and go with `HEX_S`.
   */
  buildBirds() {
    const sector = this.sectorById.get('HEX_S');
    if (!sector || this.config.forestBirdsEnabled === false) return;

    this.forestBirds = buildForestBirds(sector, this.config, {
      heightAt: (x, z) => this.getFloorHeightAt(x, z),
      trees: this.pineGrove?.userData.treePlacements ?? [],
      windUniforms: this.windUniforms,
    });
    this.birds = this.forestBirds;
    if (this.forestBirds) this.group.add(this.forestBirds.group);
  }

  /**
   * The weather over the forest: falling rain and the ripples it raises on the
   * floor. Rain only exists in HEX_S — the other seven sectors keep their
   * painted skies — and it is planted on the same terrain the explorer walks
   * on, so drops land on the relief and not on a plane.
   */
  buildForestWeather() {
    const sector = this.sectorById.get('HEX_S');
    if (!sector) return;

    this.forestRain = buildForestRain(sector, this.config, {
      heightAt: (x, z) => this.getFloorHeightAt(x, z),
      normalAt: (x, z, target) => this.getTerrainNormalAt(x, z, target),
    });
    this.rain = this.forestRain;
    this.group.add(this.forestRain.group);

    // Wet ground: rain sheens the soil and the leaf litter, so the floor the
    // explorer splashes through is a little darker and far less matte than the
    // dry forest. Both materials are multiplied, never rebuilt: the baked
    // vertex colours stay exactly as they were.
    if (this.forestRain.isEnabled) {
      const darkening = this.config.forestRainWetDarkening ?? 0.82;
      if (this.forestSoilMaterial) {
        this.forestSoilMaterial.roughness = this.config.forestRainWetRoughness ?? 0.72;
        this.forestSoilMaterial.color.multiplyScalar(darkening);
      }
      if (this.forestLeafMaterial) {
        this.forestLeafMaterial.roughness = this.config.forestRainWetRoughness ?? 0.72;
        this.forestLeafMaterial.color.multiplyScalar(0.5 + darkening * 0.5);
      }
      this.forestRain.wetnessApplied = true;
    }
  }

  buildFloors() {
    for (const sector of this.sectors) {
      const isForest = sector.id === 'HEX_S';
      const isVolcanic = sector.id === 'HEX_SE';
      const hasRelief = isForest || isVolcanic;
      const terrain = isForest ? this.forestTerrain : isVolcanic ? this.volcanicTerrain : null;
      const color = isForest
        ? (this.config.forestSoilColor ?? 0x4f3829)
        : isVolcanic
          ? (this.config.volcanicRockColor ?? 0x4f5157)
          : (this.config.sectorColors?.[sector.id]
            ?? getSectorColor(sector.id, sector.order));
      const sectorFloorMaterial = isForest
        ? this.forestSoilMaterial
        : isVolcanic
          ? this.volcanicRockMaterial
          : new THREE.MeshStandardMaterial({
            color,
            roughness: 0.80,
            metalness: 0.06,
          });
      this.floorMaterials.set(sector.id, sectorFloorMaterial);

      const floor = new THREE.Mesh(
        hasRelief ? terrain.geometry : this.floorGeometry,
        sectorFloorMaterial,
      );
      floor.name = `Floor_${sector.id}`;
      floor.position.set(sector.center.x, this.config.floorHeight, sector.center.z);
      floor.receiveShadow = true;
      floor.userData.sectorId = sector.id;
      floor.userData.biome = isForest
        ? 'forest-soil-and-leaves'
        : isVolcanic
          ? 'volcanic-rock'
          : 'sector-floor';
      floor.userData.terrain = hasRelief ? 'baked-hex-lattice-edge-flat' : 'flat';
      if (hasRelief) {
        floor.userData.terrainAmplitude = terrain.amplitude;
        floor.userData.edgeBlend = terrain.edgeBlend;
        floor.userData.divisions = terrain.divisions;
        floor.userData.cellSize = terrain.cellSize;
        floor.userData.collision = 'baked-lattice-barycentric';
        floor.userData.maxSlopeDegrees = terrain.geometry.userData.maxSlopeDegrees;
      }
      this.group.add(floor);
      this.sectorMeshes.set(sector.id, floor);
      if (isForest) this.forestTerrainMesh = floor;
      if (isVolcanic) this.volcanicTerrainMesh = floor;

      // The thin border is deliberately kept at the base level for the flat
      // sectors. The forest and volcanic reliefs fade back to that exact
      // height before every shared edge; their border bands ride the relief.
      const ring = new THREE.Mesh(
        isForest
          ? this.forestRingGeometry
          : isVolcanic
            ? this.volcanicRingGeometry
            : this.floorRingGeometry,
        isForest
          ? this.forestSoilBorderMaterial
          : isVolcanic
            ? this.volcanicBorderMaterial
            : this.floorRingMaterial,
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
    const litterNormal = new THREE.Vector3();
    const litterTilt = new THREE.Quaternion();
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
      // Leaves are read from eye height now that the first-person view
      // exists, so they are hand sized and settle on the slope they fell on
      // instead of hovering as flat slabs over the relief.
      const size = 0.22 + random() * 0.3;
      transform.position.set(worldX, floorY + 0.05 + random() * 0.05, worldZ);
      transform.rotation.set(
        (random() - 0.5) * 0.28,
        random() * Math.PI * 2,
        (random() - 0.5) * 0.28,
      );
      transform.scale.set(size * (0.72 + random() * 0.52), size, size * (0.74 + random() * 0.45));
      this.getTerrainNormalAt(worldX, worldZ, litterNormal);
      litterTilt.setFromUnitVectors(LEAF_UP, litterNormal);
      transform.quaternion.premultiply(litterTilt);
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

    // A much dimmer, green-shifted hemisphere wash simulates light filtered
    // through a dense conifer canopy. The ground bounce is kept very dark so
    // the forest floor reads as shadowed earth rather than as a lit plane.
    const hemisphere = new THREE.HemisphereLight(0x5a8a6a, 0x1a1410, 0.52);
    hemisphere.name = 'HEX_S_ForestHemisphere';
    hemisphere.position.set(sector.center.x, this.config.floorHeight + 65, sector.center.z);
    hemisphere.userData.sectorId = sector.id;
    group.add(hemisphere);

    // Warm, low-intensity point lights scattered through the canopy read as
    // sunlight breaking through gaps in the foliage. Each is deliberately
    // small and soft, so the forest feels dim with occasional warm pools.
    const lightColors = this.config.forestLightColors ?? [0xd4c98a, 0xf5d6a0, 0xa8c490];
    const placements = [
      { x: -82, y: 42, z: 48, color: lightColors[0], intensity: 0.55 },
      { x: 76, y: 48, z: 68, color: lightColors[1], intensity: 0.48 },
      { x: 8, y: 35, z: -68, color: lightColors[2], intensity: 0.42 },
    ];
    this.forestPointLights = [];
    for (const placement of placements) {
      const light = new THREE.PointLight(
        placement.color,
        (this.config.forestLightIntensity ?? 0.52) * placement.intensity,
        190,
        2.2,
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

    // A subtle ambient light that adds a tiny bit of fill to the darkest
    // corners, preventing the forest from going fully black while keeping
    // the overall dim, enclosed feel intact.
    const fillLight = new THREE.AmbientLight(0x2a3d2e, 0.18);
    fillLight.name = 'HEX_S_ForestFill';
    group.add(fillLight);

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
    this.forestRain?.update(dt);
    // The flock gets the explorer's own position, so a bird can decide that the
    // thing walking towards it is worth leaving for.
    this.forestBirds?.update(dt, playerPosition);
    this.windUniforms.time.value += dt * (this.config.windStrength ?? 1);

    // The forest lights breathe very subtly, like sunlight moving through a
    // canopy as the wind stirs the branches. The modulation is kept extremely
    // gentle so the forest feels alive without any visible flashing.
    this.forestLightTime += dt;
    for (const light of this.forestPointLights ?? []) {
      const baseIntensity = light.userData.baseIntensity ?? light.intensity;
      const phase = light.userData.phase ?? 0;
      light.intensity = baseIntensity * (0.94 + Math.sin(this.forestLightTime * 0.5 + phase) * 0.04);
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
    // the mist, the rain and the birds would veil it, so they all step aside
    // while the map is annotated.
    if (this.domeGroup) this.domeGroup.visible = !visible;
    if (this.mistLayers) this.mistLayers.visible = !visible;
    this.forestRain?.setVisible(!visible);
    this.forestBirds?.setVisible(!visible);
    // The lava stays: from above it is the clearest landmark the volcanic
    // sector has, so the overview keeps it rather than hiding it.
  }

  /** Weather switch for HEX_S: `false` clears the rain field entirely. */
  setRainEnabled(enabled) {
    if (!this.forestRain) return false;
    const result = this.forestRain.setEnabled(enabled);
    // The rain overlay must not undo the overview's own hiding of the field.
    if (this.debugGroup?.visible) this.forestRain.setVisible(false);
    return result;
  }

  updateDebugPlayer(position) {
    if (!this.playerMarker) return;
    this.playerMarker.position.set(position.x, position.y + 2.5, position.z);
  }

  getSector(id) {
    return this.sectorById.get(id) ?? null;
  }

  /**
   * The centres of a sector's portals in sector-local coordinates. The
   * volcanic field uses them to keep a flat, walkable apron in front of every
   * gate, so the terrain never crowds an entrance.
   */
  sectorGateAprons(sectorId) {
    const sector = this.sectorById.get(sectorId);
    if (!sector) return [];
    return this.gates
      .filter((gate) => gate.aSectorId === sectorId || gate.bSectorId === sectorId)
      .map((gate) => ({
        x: gate.center.x - sector.center.x,
        z: gate.center.z - sector.center.z,
      }));
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

  /**
   * The baked terrain of a sector (HEX_S forest, HEX_SE volcanic field), or
   * null for the sectors that keep the flat plate.
   */
  getSectorTerrain(sectorId) {
    return this.sectorTerrains?.get(sectorId) ?? null;
  }

  /**
   * Height of the walkable surface under a world point, or null outside the
   * map. For the sectors with a baked relief this reads the *same* lattice
   * the terrain mesh is built from, so the collision surface and the rendered
   * ground are the same model down to floating-point noise.
   */
  getTerrainHeightAt(x, z) {
    const sector = this.getSectorAt(x, z);
    if (!sector) return null;
    const terrain = this.getSectorTerrain(sector.id);
    if (!terrain) return this.config.floorHeight;
    return this.config.floorHeight + terrain.heightAt(
      x - sector.center.x,
      z - sector.center.z,
    );
  }

  getFloorHeightAt(x, z) {
    return this.getTerrainHeightAt(x, z);
  }

  /** Surface normal of the ground under a world point (always unit length). */
  getTerrainNormalAt(x, z, target = new THREE.Vector3()) {
    const sector = this.getSectorAt(x, z);
    const terrain = sector && this.getSectorTerrain(sector.id);
    if (!terrain) return target.set(0, 1, 0);
    return terrain.normalAt(x - sector.center.x, z - sector.center.z, target);
  }

  /** Steepness (rise over run) of the ground under a world point. */
  getTerrainSlopeAt(x, z) {
    const sector = this.getSectorAt(x, z);
    const terrain = sector && this.getSectorTerrain(sector.id);
    if (!terrain) return 0;
    return terrain.slopeAt(x - sector.center.x, z - sector.center.z);
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
