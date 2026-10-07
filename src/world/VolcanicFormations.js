import * as THREE from 'three';
import { BASALT_TONES, createVolcanicPropMaterial } from './VolcanicMaterials.js';
import { makeRandom } from './random.js';

/**
 * The major volcanic outcrops in HEX_SE. These are a small set of deliberate,
 * large silhouettes, not a scatter: every entry is one landmark formation and
 * its few fused-looking masses are combined into one static mesh. The layout is
 * sector-local and kept clear of the four portal aprons, the crater, and the
 * existing lava surfaces.
 */
const freezeFormation = (formation) => Object.freeze({
  ...formation,
  chunks: Object.freeze(formation.chunks.map((chunk) => Object.freeze(chunk))),
});

export const DEFAULT_VOLCANIC_FORMATIONS = Object.freeze([
  freezeFormation({
    id: 'north-rift-outcrop',
    name: 'North Rift Outcrop',
    type: 'fractured-outcrop',
    x: -70,
    z: -134,
    yaw: -0.34,
    seed: 0x10f1,
    footprintRadius: 17,
    chunks: [
      { shape: 'boulder', x: -4.4, z: 2, width: 18, depth: 14, height: 16, yaw: -0.1 },
      { shape: 'shard', x: 4.5, z: -1.8, width: 11, depth: 10, height: 22, leanX: 1.6, leanZ: -0.6, yaw: 0.16 },
    ],
  }),
  freezeFormation({
    id: 'northwatch-basalt-spires',
    name: 'Northwatch Basalt Spires',
    type: 'tall-basalt-formation',
    x: 72,
    z: -105,
    yaw: 0.2,
    seed: 0x2b57,
    footprintRadius: 16,
    chunks: [
      { shape: 'column', x: -5.2, z: 1.7, width: 10, depth: 9, height: 36, sides: 6, leanX: -0.8, leanZ: 0.5 },
      { shape: 'column', x: 4.8, z: -2.4, width: 9, depth: 8.5, height: 29, sides: 6, leanX: 1.4, leanZ: -0.5 },
      { shape: 'column', x: 2.5, z: 5.9, width: 8, depth: 8.5, height: 23, sides: 7, leanX: 0.5, leanZ: 1.0 },
    ],
  }),
  freezeFormation({
    id: 'eastern-shear-cliff',
    name: 'Eastern Shear Cliff',
    type: 'jagged-cliff',
    x: 155,
    z: 20,
    yaw: 0.58,
    seed: 0x39c1,
    footprintRadius: 28,
    chunks: [
      { shape: 'shard', x: -14, z: 1, width: 18, depth: 14, height: 22, sides: 6, leanX: -1.5, leanZ: -0.2, yaw: -0.08 },
      { shape: 'shard', x: 0.3, z: -0.8, width: 20, depth: 16, height: 29, sides: 7, leanX: 1.4, leanZ: 0.8, yaw: 0.04 },
      { shape: 'shard', x: 14, z: 1.5, width: 16, depth: 13, height: 24, sides: 6, leanX: 1.0, leanZ: -0.8, yaw: 0.12 },
    ],
  }),
  freezeFormation({
    id: 'southeastern-fracture',
    name: 'Southeastern Fracture',
    type: 'fractured-volcanic-outcrop',
    x: 130,
    z: 80,
    yaw: 1.06,
    seed: 0x4d2b,
    footprintRadius: 18,
    chunks: [
      { shape: 'shard', x: -4.8, z: -0.5, width: 14, depth: 12, height: 23, sides: 6, leanX: 1.5, leanZ: -0.8, yaw: -0.1 },
      { shape: 'boulder', x: 5.8, z: 3, width: 16, depth: 14, height: 17, yaw: 0.2 },
    ],
  }),
  freezeFormation({
    id: 'southern-basalt-sentinel',
    name: 'Southern Basalt Sentinel',
    type: 'leaning-basalt-formation',
    x: -85,
    z: 145,
    yaw: -0.48,
    seed: 0x5e11,
    footprintRadius: 18,
    chunks: [
      { shape: 'column', x: -3.4, z: 0.6, width: 12, depth: 10, height: 28, sides: 6, leanX: -2.0, leanZ: 0.5 },
      { shape: 'shard', x: 5.5, z: -2.4, width: 13, depth: 10, height: 22, sides: 6, leanX: 1.0, leanZ: -1.1, yaw: 0.14 },
    ],
  }),
  freezeFormation({
    id: 'southern-fallen-monolith',
    name: 'Southern Fallen Monolith',
    type: 'large-angular-boulder',
    x: -25,
    z: 150,
    yaw: 0.26,
    seed: 0x6a09,
    footprintRadius: 16,
    chunks: [
      { shape: 'boulder', x: 0, z: 0, width: 24, depth: 20, height: 16, yaw: -0.18 }
    ],
  }),
]);

// The sector's basalt, straight from the shared volcanic palette
// (src/world/VolcanicMaterials.js): five facet tones of the same dark rock, so
// a landmark spire is visibly cut from the ground it stands on.
const ROCK_TONES = BASALT_TONES;

const MASS_PROFILES = Object.freeze({
  // Columnar basalt: tall, faceted sides, a slight foot flare and a broken tip.
  column: Object.freeze([
    Object.freeze({ y: 0.00, radius: 0.82 }),
    Object.freeze({ y: 0.10, radius: 1.00 }),
    Object.freeze({ y: 0.30, radius: 0.94 }),
    Object.freeze({ y: 0.56, radius: 0.86 }),
    Object.freeze({ y: 0.80, radius: 0.80 }),
    Object.freeze({ y: 0.94, radius: 0.68 }),
    Object.freeze({ y: 1.00, radius: 0.48 }),
  ]),
  // Fractured blades narrow as they climb, with a leaning, angular crest.
  shard: Object.freeze([
    Object.freeze({ y: 0.00, radius: 0.76 }),
    Object.freeze({ y: 0.12, radius: 1.00 }),
    Object.freeze({ y: 0.38, radius: 0.84 }),
    Object.freeze({ y: 0.72, radius: 0.72 }),
    Object.freeze({ y: 0.92, radius: 0.57 }),
    Object.freeze({ y: 1.00, radius: 0.34 }),
  ]),
  // Broad, low, angular shoulders make a single mass read as a large boulder.
  boulder: Object.freeze([
    Object.freeze({ y: 0.00, radius: 0.62 }),
    Object.freeze({ y: 0.14, radius: 0.91 }),
    Object.freeze({ y: 0.39, radius: 1.00 }),
    Object.freeze({ y: 0.66, radius: 0.90 }),
    Object.freeze({ y: 0.86, radius: 0.67 }),
    Object.freeze({ y: 0.97, radius: 0.38 }),
  ]),
});

const TAU = Math.PI * 2;

function rotateXZ(x, z, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - z * sin, z: x * sin + z * cos };
}

function randomTone(random, top = false) {
  const index = top
    ? Math.min(ROCK_TONES.length - 1, 2 + Math.floor(random() * 3))
    : Math.floor(random() * ROCK_TONES.length);
  return ROCK_TONES[index];
}

class RockGeometryBuilder {
  constructor() {
    this.positions = [];
    this.colors = [];
  }

  triangle(a, b, c, color) {
    for (const point of [a, b, c]) {
      this.positions.push(point.x, point.y, point.z);
      this.colors.push(color.r, color.g, color.b);
    }
  }

  build(name, formation) {
    const geometry = new THREE.BufferGeometry();
    geometry.name = name;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData = {
      sectorId: 'HEX_SE',
      formationId: formation.id,
      surface: 'fractured-volcanic-basalt',
      static: true,
    };
    return geometry;
  }
}

function appendMass(builder, terrain, formation, formationBaseHeight, chunk, random) {
  const profile = MASS_PROFILES[chunk.shape];
  if (!profile) throw new RangeError(`Unknown volcanic mass shape: ${chunk.shape}`);

  const sides = Math.max(5, Math.min(10, Math.round(chunk.sides ?? 7)));
  const formationYaw = formation.yaw ?? 0;
  const chunkOffset = rotateXZ(chunk.x ?? 0, chunk.z ?? 0, formationYaw);
  const chunkYaw = formationYaw + (chunk.yaw ?? 0);
  const lean = rotateXZ(chunk.leanX ?? 0, chunk.leanZ ?? 0, formationYaw);
  const phase = random() * TAU;
  const width = Math.max(1, chunk.width);
  const depth = Math.max(1, chunk.depth);
  const height = Math.max(1, chunk.height);
  const angleJitter = Array.from({ length: sides }, () => (random() - 0.5) * 0.12);
  const facetScale = Array.from({ length: sides }, () => 0.88 + random() * 0.24);

  const rings = profile.map((level, ringIndex) => {
    const vertices = [];
    for (let side = 0; side < sides; side += 1) {
      const angle = phase + (side / sides) * TAU + angleJitter[side];
      const ringNoise = ringIndex === 0 ? 0 : (random() - 0.5) * 0.1;
      const scale = level.radius * facetScale[side] * (1 + ringNoise);
      const halfWidth = width * 0.5 * scale;
      const halfDepth = depth * 0.5 * scale;
      const local = rotateXZ(Math.cos(angle) * halfWidth, Math.sin(angle) * halfDepth, chunkYaw);
      const x = chunkOffset.x + local.x + lean.x * level.y;
      const z = chunkOffset.z + local.z + lean.z * level.y;
      const ground = terrain.heightAt(formation.x + x, formation.z + z) - formationBaseHeight;
      const topBreak = ringIndex === profile.length - 1 ? (random() - 0.5) * 0.11 : 0;
      const rise = Math.max(0, level.y + topBreak) * height;
      vertices.push({ x, y: ground + rise, z });
    }
    return vertices;
  });

  // Angular side facets: each face is deliberately flat and differently toned,
  // rather than a smooth primitive or a texture painted onto a round rock.
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const next = (side + 1) % sides;
      const lowerA = rings[ring][side];
      const lowerB = rings[ring][next];
      const upperA = rings[ring + 1][side];
      const upperB = rings[ring + 1][next];
      const tone = randomTone(random, ring >= profile.length - 3);
      builder.triangle(lowerA, upperA, upperB, tone);
      builder.triangle(lowerA, upperB, lowerB, tone);
    }
  }

  // A fractured cap and a buried bottom close the mass without adding any
  // debris around it. The cap is offset and uneven, not a flat cut cylinder.
  const topRing = rings.at(-1);
  const topOffset = rotateXZ(lean.x, lean.z, 0);
  const topGround = terrain.heightAt(
    formation.x + chunkOffset.x + topOffset.x,
    formation.z + chunkOffset.z + topOffset.z,
  ) - formationBaseHeight;
  const topCenter = {
    x: chunkOffset.x + lean.x,
    y: topGround + height * (0.93 + random() * 0.045),
    z: chunkOffset.z + lean.z,
  };
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    builder.triangle(topCenter, topRing[next], topRing[side], randomTone(random, true));
  }

  const bottomCenter = {
    x: chunkOffset.x,
    y: terrain.heightAt(formation.x + chunkOffset.x, formation.z + chunkOffset.z) - formationBaseHeight,
    z: chunkOffset.z,
  };
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    builder.triangle(bottomCenter, rings[0][side], rings[0][next], ROCK_TONES[0]);
  }
}

/**
 * Build the six static landmark formations on the final HEX_SE ground. This
 * only samples heightAt to seat their bases; it does not carve terrain, add
 * colliders, inspect or alter lava, create debris, or add anything elsewhere.
 */
export function buildVolcanicFormations(terrain, config = {}) {
  if (!terrain || terrain.sectorId !== 'HEX_SE'
    || config.volcanicFormationsEnabled === false
    || config.volcanicFormations === false
    || config.volcanicFormations === null) return null;

  const layout = Array.isArray(config.volcanicFormations)
    ? config.volcanicFormations
    : DEFAULT_VOLCANIC_FORMATIONS;
  if (layout.length === 0) return null;

  const group = new THREE.Group();
  group.name = 'VolcanicFormations_HEX_SE';
  group.userData = {
    sectorId: 'HEX_SE',
    featureType: 'major-volcanic-rock-formations',
    formationCount: layout.length,
    static: true,
    collidable: false,
  };

  const material = createVolcanicPropMaterial('MajorVolcanicBasalt_HEX_SE', {
    roughness: 0.97,
    metalness: 0.015,
  });
  const seedBase = config.volcanicFormationSeed ?? 0x7a11f0;

  for (const formation of layout) {
    if (!formation || !Number.isFinite(formation.x) || !Number.isFinite(formation.z)
      || !Array.isArray(formation.chunks) || formation.chunks.length === 0) continue;

    const random = makeRandom((seedBase ^ (formation.seed ?? 0)) >>> 0);
    const baseHeight = terrain.heightAt(formation.x, formation.z);
    const formationGroup = new THREE.Group();
    formationGroup.name = `VolcanicFormation_${formation.id}_HEX_SE`;
    formationGroup.position.set(formation.x, baseHeight, formation.z);
    formationGroup.userData = {
      sectorId: 'HEX_SE',
      formationId: formation.id,
      formationName: formation.name,
      formationType: formation.type,
      role: 'major-landmark',
      major: true,
      footprintRadius: formation.footprintRadius,
      height: Math.max(...formation.chunks.map((chunk) => chunk.height)),
      static: true,
    };

    const builder = new RockGeometryBuilder();
    for (const chunk of formation.chunks) {
      appendMass(builder, terrain, formation, baseHeight, chunk, random);
    }
    if (builder.positions.length === 0) continue;

    const geometry = builder.build(`VolcanicFormationGeometry_${formation.id}`, formation);
    const position = geometry.getAttribute('position');
    let generatedFootprintRadius = 0;
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      generatedFootprintRadius = Math.max(
        generatedFootprintRadius,
        Math.hypot(position.getX(vertex), position.getZ(vertex)),
      );
    }
    // Record a conservative circle around the actual mesh, not just its authored
    // centre, so gate and route clearances include every leaning shard.
    formationGroup.userData.footprintRadius = Math.max(
      formation.footprintRadius ?? 0,
      generatedFootprintRadius + 0.5,
    );

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `VolcanicFormationMesh_${formation.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      sectorId: 'HEX_SE',
      formationId: formation.id,
      major: true,
      componentCount: formation.chunks.length,
      static: true,
    };
    formationGroup.add(mesh);
    group.add(formationGroup);
  }

  group.userData.formationCount = group.children.length;
  return group;
}
