import * as THREE from 'three';
import { isPointInsideHex } from './hexGrid.js';
import { between, makeRandom } from './random.js';
import { applyWindSway } from './wind.js';

const TREE_HEIGHT = 34;
const UP = new THREE.Vector3(0, 1, 0);
// Every bough gets a fuller radial spray. The additional upward and
// downward blades keep the canopy readable as individual needles instead of
// leaving transparent gaps between the branch tiers.
const NEEDLE_SPRAY = Object.freeze([
  Object.freeze([0.92, 0.42, 0.00, 1.00]),
  Object.freeze([0.84, 0.40, 0.48, 0.94]),
  Object.freeze([0.84, 0.40, -0.48, 0.94]),
  Object.freeze([0.56, 0.18, 0.82, 0.78]),
  Object.freeze([0.56, 0.18, -0.82, 0.78]),
  Object.freeze([0.48, -0.46, 0.38, 0.88]),
  Object.freeze([0.48, -0.46, -0.38, 0.88]),
  Object.freeze([0.72, 0.62, 0.26, 0.82]),
  Object.freeze([0.72, 0.62, -0.26, 0.82]),
  Object.freeze([0.66, -0.16, 0.66, 0.76]),
  Object.freeze([0.66, -0.16, -0.66, 0.76]),
  Object.freeze([0.34, 0.78, 0.00, 0.70]),
]);

const NEEDLE_ROOT_COLORS = [
  0x0b3029, 0x0d382d, 0x103d30, 0x124332, 0x164735,
].map((color) => new THREE.Color(color));
const NEEDLE_BODY_COLORS = [
  0x104233, 0x154b37, 0x19553c, 0x1e6043, 0x286b49, 0x327651,
].map((color) => new THREE.Color(color));
const NEEDLE_TIP_COLORS = [
  0x205a3d, 0x286746, 0x32744c, 0x3d8055, 0x4b8960, 0x548f64,
].map((color) => new THREE.Color(color));
const BARK_COLORS = [
  0x34251d, 0x493323, 0x5b402b, 0x704e35, 0x806043,
].map((color) => new THREE.Color(color));
const BRANCH_BARK_COLORS = [
  0x30231c, 0x403025, 0x503927, 0x63452f,
].map((color) => new THREE.Color(color));
const CONE_COLORS = [
  0x38261a, 0x53341f, 0x70452a, 0x875936,
].map((color) => new THREE.Color(color));

// The open middle lanes lead back to the three portals. Tree positions stay
// comfortably inside this one hex, while size, branching and orientation vary.
const CORE_TREE_PLACEMENTS = Object.freeze([
  Object.freeze({ x: -135, z: -116, scale: 0.92 }),
  Object.freeze({ x: -70, z: -132, scale: 0.86 }),
  Object.freeze({ x: 70, z: -129, scale: 1.08 }),
  Object.freeze({ x: 135, z: -112, scale: 0.94 }),
  Object.freeze({ x: -158, z: -36, scale: 0.88 }),
  Object.freeze({ x: -105, z: -29, scale: 1.04 }),
  Object.freeze({ x: 105, z: -28, scale: 0.95 }),
  Object.freeze({ x: 158, z: -34, scale: 1.00 }),
  Object.freeze({ x: -145, z: 42, scale: 0.93 }),
  Object.freeze({ x: -88, z: 57, scale: 1.08 }),
  Object.freeze({ x: 88, z: 53, scale: 0.92 }),
  Object.freeze({ x: 145, z: 40, scale: 0.98 }),
  Object.freeze({ x: -119, z: 112, scale: 0.91 }),
  Object.freeze({ x: -55, z: 128, scale: 1.10 }),
  Object.freeze({ x: 55, z: 128, scale: 0.94 }),
  Object.freeze({ x: 119, z: 111, scale: 1.00 }),
  Object.freeze({ x: -73, z: 155, scale: 1.02 }),
  Object.freeze({ x: 73, z: 155, scale: 0.88 }),
]);

function makeTransform(position, scale, yaw, y = 0) {
  return {
    x: position.x,
    y,
    z: position.z,
    scale,
    cos: Math.cos(yaw),
    sin: Math.sin(yaw),
  };
}

/**
 * How many trees of each class the grove carries: the eighteen authored
 * mature spruces, then the young pines that thicken the wood, then the
 * saplings that fill every last gap. Reported so the world HUD and the tests
 * can tell the three classes apart.
 */
export function pineClassCounts(config) {
  const total = Math.max(
    CORE_TREE_PLACEMENTS.length,
    Math.floor(config.forestTreeCount ?? 52),
  );
  const young = THREE.MathUtils.clamp(
    Math.floor(config.forestYoungTreeCount ?? 0),
    0,
    Math.max(0, total - CORE_TREE_PLACEMENTS.length),
  );
  return {
    mature: CORE_TREE_PLACEMENTS.length,
    young,
    sapling: Math.max(0, total - CORE_TREE_PLACEMENTS.length - young),
    total,
  };
}

function makeDenseTreePlacements(config) {
  const counts = pineClassCounts(config);
  const targetCount = counts.total;
  if (targetCount === CORE_TREE_PLACEMENTS.length) return CORE_TREE_PLACEMENTS;

  const random = makeRandom(0xdecafbad);
  const placements = [...CORE_TREE_PLACEMENTS];
  const safeRadius = Math.max(20, config.hexRadius - 24);
  // A dense wood packs the trunks much tighter than the original clearing-wide
  // grove did; the exact spacing is configurable so the density can be dialled
  // without touching the scatter.
  const minSpacing = config.forestTreeSpacing ?? 17;
  let attempts = 0;

  // Fill the interior with a deterministic scatter rather than a rigid grid.
  // A narrow clearing remains between the southern gate and the central grove
  // so the player can still read a path through the denser woodland.
  while (placements.length < targetCount && attempts < targetCount * 400) {
    attempts += 1;
    const x = between(random, -safeRadius * 0.82, safeRadius * 0.82);
    const z = between(random, -safeRadius * 0.78, safeRadius * 0.82);
    if (!isPointInsideHex(x, z, 0, 0, safeRadius)) continue;
    if (Math.abs(x) < 26 && z < 36) continue;

    const tooClose = placements.some((placement) => (
      Math.hypot(placement.x - x, placement.z - z) < minSpacing
    ));
    if (tooClose) continue;

    // The class of the tree that ends up here depends on the index, so the
    // scale of a filler can be chosen to match its class.
    const index = placements.length;
    const isYoung = index >= counts.mature && index < counts.mature + counts.young;
    placements.push({
      x,
      z,
      scale: isYoung ? between(random, 0.62, 0.98) : between(random, 0.56, 0.91),
      foliageClass: isYoung ? 'young-pine' : 'dense-sapling',
    });
  }

  return Object.freeze(placements);
}

class VertexColorGeometryBuilder {
  constructor(name) {
    this.name = name;
    this.positions = [];
    this.colors = [];
    this.transform = null;
  }

  setTransform(transform) {
    this.transform = transform;
  }

  pushVertex(point, color) {
    if (this.transform) {
      const { x, y, z, scale, cos, sin } = this.transform;
      const localX = point.x * scale;
      const localZ = point.z * scale;
      this.positions.push(
        x + localX * cos + localZ * sin,
        y + point.y * scale,
        z - localX * sin + localZ * cos,
      );
    } else {
      this.positions.push(point.x, point.y, point.z);
    }
    this.colors.push(color.r, color.g, color.b);
  }

  addTriangle(a, b, c, colorA, colorB = colorA, colorC = colorA) {
    this.pushVertex(a, colorA);
    this.pushVertex(b, colorB);
    this.pushVertex(c, colorC);
  }

  makeGeometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.name = this.name;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function addTubePath(builder, points, radii, random, options = {}) {
  const radialSegments = options.radialSegments ?? 7;
  const palette = options.palette ?? BRANCH_BARK_COLORS;
  const rings = [];

  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const tangent = next.clone().sub(previous).normalize();
    const reference = Math.abs(tangent.y) > 0.92
      ? new THREE.Vector3(1, 0, 0)
      : UP;
    const side = new THREE.Vector3().crossVectors(tangent, reference).normalize();
    const secondSide = new THREE.Vector3().crossVectors(tangent, side).normalize();
    const ring = [];

    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2;
      ring.push(points[i].clone()
        .addScaledVector(side, Math.cos(angle) * radii[i])
        .addScaledVector(secondSide, Math.sin(angle) * radii[i]));
    }
    rings.push(ring);
  }

  for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
    const startRing = rings[ringIndex];
    const endRing = rings[ringIndex + 1];
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const nextSegment = (segment + 1) % radialSegments;
      const a = startRing[segment];
      const b = endRing[segment];
      const c = endRing[nextSegment];
      const d = startRing[nextSegment];
      const shade = (
        Math.floor(segment / Math.max(1, radialSegments / 4))
        + ringIndex
        + Math.floor(random() * 2)
      ) % palette.length;
      const dark = palette[shade];
      const light = palette[(shade + 1) % palette.length];
      builder.addTriangle(a, b, c, dark, light, light);
      builder.addTriangle(a, c, d, dark, light, dark);
    }
  }
}

function interpolatePath(points, progress) {
  const clamped = THREE.MathUtils.clamp(progress, 0, 1);
  const segmentProgress = clamped * (points.length - 1);
  const segmentIndex = Math.min(points.length - 2, Math.floor(segmentProgress));
  const blend = segmentProgress - segmentIndex;
  return points[segmentIndex].clone().lerp(points[segmentIndex + 1], blend);
}

function addNeedleBlade(builder, start, direction, length, width, rootColor, bodyColor, tipColor) {
  const axis = direction.clone().normalize();
  const reference = Math.abs(axis.dot(UP)) > 0.92
    ? new THREE.Vector3(1, 0, 0)
    : UP;
  const side = new THREE.Vector3().crossVectors(axis, reference).normalize();
  const normal = new THREE.Vector3().crossVectors(axis, side).normalize();
  const middle = start.clone().addScaledVector(axis, length * 0.54);
  const tip = start.clone().addScaledVector(axis, length);
  const left = middle.clone().addScaledVector(side, width * 0.5);
  const right = middle.clone().addScaledVector(side, -width * 0.5);
  const upperRidge = middle.clone().addScaledVector(normal, width * 0.15);
  const lowerRidge = middle.clone().addScaledVector(normal, -width * 0.15);

  // A tiny ridged, double-sided blade reads as a needle spray at a distance,
  // while still catching light along its individual tapered faces.
  builder.addTriangle(start, left, upperRidge, rootColor, bodyColor, bodyColor);
  builder.addTriangle(left, tip, upperRidge, bodyColor, tipColor, bodyColor);
  builder.addTriangle(tip, right, upperRidge, tipColor, bodyColor, bodyColor);
  builder.addTriangle(right, start, upperRidge, bodyColor, rootColor, bodyColor);
  builder.addTriangle(start, lowerRidge, left, rootColor, bodyColor, bodyColor);
  builder.addTriangle(left, lowerRidge, tip, bodyColor, bodyColor, tipColor);
  builder.addTriangle(tip, lowerRidge, right, tipColor, bodyColor, bodyColor);
  builder.addTriangle(right, lowerRidge, start, bodyColor, bodyColor, rootColor);
}

function addNeedleFan(builder, center, radial, tangent, branchLength, random, colorOffset = 0) {
  const needleLength = THREE.MathUtils.clamp(0.68 + branchLength * 0.105, 0.76, 1.52);

  for (let i = 0; i < NEEDLE_SPRAY.length; i += 1) {
    const [radialAmount, upAmount, sideAmount, lengthScale] = NEEDLE_SPRAY[i];
    const direction = radial.clone().multiplyScalar(radialAmount)
      .addScaledVector(UP, upAmount)
      .addScaledVector(tangent, sideAmount)
      .add(new THREE.Vector3(
        between(random, -0.13, 0.13),
        between(random, -0.11, 0.11),
        between(random, -0.13, 0.13),
      ))
      .normalize();
    const start = center.clone()
      .addScaledVector(radial, between(random, -0.12, 0.13))
      .addScaledVector(tangent, between(random, -0.16, 0.16))
      .addScaledVector(UP, between(random, -0.12, 0.12));
    const length = needleLength * lengthScale * between(random, 0.88, 1.12);
    const width = length * between(random, 0.082, 0.112);
    const colorIndex = (Math.floor(random() * NEEDLE_BODY_COLORS.length) + colorOffset) % NEEDLE_BODY_COLORS.length;
    const rootColor = NEEDLE_ROOT_COLORS[(colorIndex + Math.floor(random() * 3)) % NEEDLE_ROOT_COLORS.length];
    const bodyColor = NEEDLE_BODY_COLORS[colorIndex];
    const tipColor = NEEDLE_TIP_COLORS[(colorIndex + Math.floor(random() * 2)) % NEEDLE_TIP_COLORS.length];
    addNeedleBlade(builder, start, direction, length, width, rootColor, bodyColor, tipColor);
  }
}

function trunkCenterAt(height, progress, leanX, leanZ) {
  const wave = Math.sin(progress * Math.PI * 1.7) * progress;
  return new THREE.Vector3(
    leanX * progress + wave * 0.09,
    height * progress,
    leanZ * progress + Math.sin(progress * Math.PI * 1.15) * progress * 0.07,
  );
}

function trunkRadiusAt(progress) {
  const profile = [
    [0, 0.58], [0.08, 0.51], [0.20, 0.42], [0.34, 0.34],
    [0.49, 0.27], [0.64, 0.205], [0.78, 0.145], [0.91, 0.085], [1, 0.025],
  ];
  for (let i = 0; i < profile.length - 1; i += 1) {
    const [startT, startRadius] = profile[i];
    const [endT, endRadius] = profile[i + 1];
    if (progress <= endT) {
      const blend = (progress - startT) / (endT - startT);
      return THREE.MathUtils.lerp(startRadius, endRadius, blend);
    }
  }
  return profile[profile.length - 1][1];
}

function buildTrunk(builder, random, height, leanX, leanZ) {
  const points = [];
  const radii = [];
  const sections = 12;
  for (let i = 0; i <= sections; i += 1) {
    const progress = i / sections;
    points.push(trunkCenterAt(height, progress, leanX, leanZ));
    radii.push(trunkRadiusAt(progress));
  }
  addTubePath(builder, points, radii, random, {
    radialSegments: 11,
    palette: BARK_COLORS,
  });

  // Raised dark grain lines give the tall trunk a fibrous, broken-bark finish.
  for (let groove = 0; groove < 6; groove += 1) {
    const angle = (groove / 6) * Math.PI * 2 + between(random, -0.12, 0.12);
    const grain = [];
    const grainRadii = [];
    for (let sample = 0; sample <= 5; sample += 1) {
      const progress = 0.08 + (sample / 5) * 0.74;
      const center = trunkCenterAt(height, progress, leanX, leanZ);
      const radius = trunkRadiusAt(progress) + 0.012;
      grain.push(center.add(new THREE.Vector3(
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius,
      )));
      grainRadii.push(0.012 * (1 - progress * 0.42));
    }
    addTubePath(builder, grain, grainRadii, random, {
      radialSegments: 4,
      palette: BRANCH_BARK_COLORS,
    });
  }

  // Exposed roots flare out of the bark and anchor each tree to the floor.
  const rootCount = 7;
  for (let root = 0; root < rootCount; root += 1) {
    const angle = (root / rootCount) * Math.PI * 2 + between(random, -0.18, 0.18);
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const rootPath = [
      new THREE.Vector3(0, 0.36, 0),
      direction.clone().multiplyScalar(0.52).add(new THREE.Vector3(0, 0.18, 0)),
      direction.clone().multiplyScalar(between(random, 1.05, 1.48)).add(new THREE.Vector3(0, 0.035, 0)),
    ];
    addTubePath(builder, rootPath, [0.25, 0.15, 0.012], random, {
      radialSegments: 7,
      palette: BARK_COLORS,
    });
  }
}

function addPineCone(builder, origin, direction, length, radius, random) {
  const axis = direction.clone().normalize();
  const reference = Math.abs(axis.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : UP;
  const side = new THREE.Vector3().crossVectors(axis, reference).normalize();
  const secondSide = new THREE.Vector3().crossVectors(axis, side).normalize();
  const profile = [0, 0.12, 0.28, 0.46, 0.64, 0.81, 1];
  const radii = [0.035, 0.11, 0.17, 0.19, 0.17, 0.11, 0.012].map((value) => value * radius / 0.19);
  const centers = profile.map((progress) => origin.clone().addScaledVector(axis, progress * length));
  addTubePath(builder, centers, radii, random, {
    radialSegments: 8,
    palette: CONE_COLORS,
  });

  // Overlapping pointed scales break up the cone's silhouette into a natural
  // scaled surface instead of leaving it as a smooth brown capsule.
  for (let row = 1; row < profile.length - 1; row += 1) {
    const progress = profile[row];
    const nextProgress = profile[row + 1];
    const rowRadius = radii[row];
    const nextRadius = radii[row + 1];
    const count = 7;
    for (let scale = 0; scale < count; scale += 1) {
      const angle = ((scale + (row % 2) * 0.5) / count) * Math.PI * 2;
      const nextAngle = angle + (Math.PI * 2) / count * 0.78;
      const outer = (center, r, a, lift = 0) => center.clone()
        .addScaledVector(side, Math.cos(a) * (r + lift))
        .addScaledVector(secondSide, Math.sin(a) * (r + lift));
      const a = outer(centers[row], rowRadius, angle, 0.006);
      const b = outer(centers[row], rowRadius, nextAngle, 0.006);
      const tipAngle = angle + (Math.PI / count);
      const tip = outer(centers[row + 1], nextRadius, tipAngle, 0.025);
      const color = CONE_COLORS[(row + scale + Math.floor(random() * 2)) % CONE_COLORS.length];
      builder.addTriangle(a, b, tip, color, CONE_COLORS[(row + 1) % CONE_COLORS.length], color);
    }
  }
}

function addLowPolyFoliageCone(builder, center, radius, height, random) {
  const segments = 7;
  const tip = center.clone().add(new THREE.Vector3(0, height, 0));
  const base = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2;
    base.push(center.clone().add(new THREE.Vector3(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius,
    )));
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    const bodyColor = NEEDLE_BODY_COLORS[(segment + Math.floor(random() * 3)) % NEEDLE_BODY_COLORS.length];
    const tipColor = NEEDLE_TIP_COLORS[(segment + Math.floor(random() * 2)) % NEEDLE_TIP_COLORS.length];
    builder.addTriangle(base[segment], base[next], tip, bodyColor, bodyColor, tipColor);
  }
}

function addCompactNeedleFan(builder, center, radial, tangent, length, random, colorOffset = 0) {
  for (const sideSign of [-1, 1]) {
    const direction = radial.clone()
      .addScaledVector(UP, 0.35)
      .addScaledVector(tangent, sideSign * 0.48)
      .normalize();
    const start = center.clone().addScaledVector(radial, between(random, -0.08, 0.08));
    const colorIndex = (colorOffset + Math.floor(random() * NEEDLE_BODY_COLORS.length))
      % NEEDLE_BODY_COLORS.length;
    addNeedleBlade(
      builder,
      start,
      direction,
      length * between(random, 0.78, 1.06),
      length * 0.1,
      NEEDLE_ROOT_COLORS[colorIndex % NEEDLE_ROOT_COLORS.length],
      NEEDLE_BODY_COLORS[colorIndex],
      NEEDLE_TIP_COLORS[colorIndex % NEEDLE_TIP_COLORS.length],
    );
  }
}

function buildPineSapling(woodBuilder, needleBuilder, random) {
  const height = between(random, 15, 24);
  const leanX = between(random, -0.22, 0.22);
  const leanZ = between(random, -0.18, 0.18);
  const trunkPoints = [
    trunkCenterAt(height, 0, leanX, leanZ),
    trunkCenterAt(height, 0.48, leanX, leanZ),
    trunkCenterAt(height, 1, leanX, leanZ),
  ];
  addTubePath(woodBuilder, trunkPoints, [0.32, 0.16, 0.025], random, {
    radialSegments: 6,
    palette: BARK_COLORS,
  });

  for (let tier = 0; tier < 4; tier += 1) {
    const progress = tier / 3;
    const tierHeight = height * (0.22 + progress * 0.61);
    const center = trunkCenterAt(height, tierHeight / height, leanX, leanZ);
    const radius = (height * 0.16) * (1 - progress * 0.7);
    addLowPolyFoliageCone(needleBuilder, center, radius, height * 0.22, random);
    for (let branch = 0; branch < 3; branch += 1) {
      const angle = (branch / 3) * Math.PI * 2 + tier * 1.7;
      const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
      addCompactNeedleFan(
        needleBuilder,
        center.clone().addScaledVector(radial, radius * 0.62),
        radial,
        tangent,
        Math.max(0.55, radius * 0.32),
        random,
        tier + branch,
      );
    }
  }
}

/**
 * A young pine: the same boughs, forks and needle sprays as a mature spruce,
 * with fewer tiers, branches and cones packed into a shorter trunk.
 *
 * It exists so the grove can be *dense* — three times as many trunks standing
 * in HEX_S — without tripling the needle budget: a young pine costs roughly a
 * fifth of a mature one, and the eighteen authored spruces stay exactly as
 * they were as the landmarks of the wood.
 */
function buildPineYoung(woodBuilder, needleBuilder, random, height = TREE_HEIGHT * 0.78, tint = 0) {
  const leanX = between(random, -0.3, 0.3);
  const leanZ = between(random, -0.24, 0.24);
  const trunkPoints = [];
  const trunkRadii = [];
  for (let sample = 0; sample <= 5; sample += 1) {
    const progress = sample / 5;
    trunkPoints.push(trunkCenterAt(height, progress, leanX, leanZ));
    trunkRadii.push(trunkRadiusAt(progress) * 0.92);
  }
  addTubePath(woodBuilder, trunkPoints, trunkRadii, random, {
    radialSegments: 7,
    palette: BARK_COLORS,
  });

  // Four exposed roots are enough to anchor a young tree to the floor.
  for (let root = 0; root < 4; root += 1) {
    const angle = (root / 4) * Math.PI * 2 + between(random, -0.22, 0.22);
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    addTubePath(woodBuilder, [
      new THREE.Vector3(0, 0.3, 0),
      direction.clone().multiplyScalar(between(random, 0.62, 0.94)).add(new THREE.Vector3(0, 0.03, 0)),
    ], [0.19, 0.012], random, { radialSegments: 5, palette: BARK_COLORS });
  }

  const tierCount = 5;
  const crownRadius = height * 0.2;
  let coneBranch = null;

  for (let tier = 0; tier < tierCount; tier += 1) {
    const tierProgress = tier / (tierCount - 1);
    const tierHeight = height * (0.16 + tierProgress * 0.74)
      + between(random, -0.22, 0.22);
    const tierRadius = Math.max(0.6, crownRadius * (1 - tierProgress * 0.86));
    const branchCount = 4;
    const phase = tier * 2.399963229728653;
    const centerline = trunkCenterAt(height, tierHeight / height, leanX, leanZ);

    for (let branchIndex = 0; branchIndex < branchCount; branchIndex += 1) {
      const angle = phase + (branchIndex / branchCount) * Math.PI * 2
        + between(random, -0.14, 0.14);
      const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
      const branchLength = tierRadius * between(random, 0.92, 1.1);
      const droop = branchLength * (0.15 - tierProgress * 0.05);
      const rootRadius = trunkRadiusAt(tierHeight / height);
      const points = [
        centerline.clone().addScaledVector(radial, rootRadius * 0.6),
        centerline.clone().addScaledVector(radial, branchLength * 0.48)
          .add(new THREE.Vector3(0, -droop * 0.5, 0)),
        centerline.clone().addScaledVector(radial, branchLength * 0.82)
          .add(new THREE.Vector3(0, -droop, 0)),
        centerline.clone().addScaledVector(radial, branchLength)
          .add(new THREE.Vector3(0, -droop * 0.45 + branchLength * 0.03, 0)),
      ];
      addTubePath(woodBuilder, points, [0.12, 0.085, 0.05, 0.02], random, {
        radialSegments: 5,
        palette: BRANCH_BARK_COLORS,
      });

      // One spray mid-bough and one at the tip read as a full bough from a
      // metre away, which is all a filler tree has to do.
      addNeedleFan(
        needleBuilder,
        interpolatePath(points, 0.42),
        radial,
        tangent,
        branchLength,
        random,
        (tier % 3) + tint,
      );
      addNeedleFan(
        needleBuilder,
        interpolatePath(points, 0.96),
        radial,
        tangent,
        branchLength,
        random,
        ((tier + 1) % 3) + tint,
      );

      const forkOrigin = interpolatePath(points, 0.58);
      const forkLength = 0.52 + branchLength * 0.09;
      const forkDirection = radial.clone().multiplyScalar(0.5)
        .addScaledVector(tangent, 0.66)
        .addScaledVector(UP, 0.34)
        .normalize();
      const forkTip = forkOrigin.clone().addScaledVector(forkDirection, forkLength);
      addTubePath(woodBuilder, [
        forkOrigin,
        forkOrigin.clone().addScaledVector(forkDirection, forkLength * 0.55),
        forkTip,
      ], [0.045, 0.026, 0.008], random, { radialSegments: 4, palette: BRANCH_BARK_COLORS });
      const forkRadial = new THREE.Vector3(forkDirection.x, 0, forkDirection.z).normalize();
      addNeedleFan(
        needleBuilder,
        forkTip,
        forkRadial,
        new THREE.Vector3(-forkRadial.z, 0, forkRadial.x),
        forkLength,
        random,
        ((tier + 2) % 3) + tint,
      );

      if (tier === 2 && branchIndex === 2) coneBranch = interpolatePath(points, 0.56);
    }
  }

  const leaderTip = trunkCenterAt(height * 1.03, 1, leanX, leanZ);
  addTubePath(woodBuilder, [
    trunkCenterAt(height, 0.8, leanX, leanZ),
    trunkCenterAt(height, 0.92, leanX, leanZ),
    leaderTip,
  ], [0.1, 0.055, 0.01], random, { radialSegments: 5, palette: BRANCH_BARK_COLORS });
  for (let spray = 0; spray < 4; spray += 1) {
    const angle = (spray / 4) * Math.PI * 2 + between(random, -0.18, 0.18);
    const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    addNeedleFan(
      needleBuilder,
      leaderTip,
      radial,
      new THREE.Vector3(-radial.z, 0, radial.x),
      0.72,
      random,
      (spray % 3) + tint,
    );
  }
  if (coneBranch) {
    addPineCone(woodBuilder, coneBranch, new THREE.Vector3(0.1, -1, 0.09), 0.62, 0.155, random);
  }
}

function buildPineTree(woodBuilder, needleBuilder, random, height = TREE_HEIGHT, tint = 0) {
  const leanX = between(random, -0.35, 0.35);
  const leanZ = between(random, -0.28, 0.28);
  buildTrunk(woodBuilder, random, height, leanX, leanZ);

  const tierCount = 8;
  const crownRadius = height * 0.205;
  let firstConeBranch = null;
  let secondConeBranch = null;
  let thirdConeBranch = null;
  let fourthConeBranch = null;

  for (let tier = 0; tier < tierCount; tier += 1) {
    const tierProgress = tier / (tierCount - 1);
    const tierHeight = height * (0.17 + tierProgress * 0.72)
      + between(random, -0.28, 0.28);
    const tierRadius = Math.max(0.7, crownRadius * (1 - tierProgress * 0.88));
    const branchCount = tier < 2 ? 8 : 7;
    const phase = tier * 2.399963229728653;
    const centerline = trunkCenterAt(height, tierHeight / height, leanX, leanZ);

    for (let branchIndex = 0; branchIndex < branchCount; branchIndex += 1) {
      const angle = phase + (branchIndex / branchCount) * Math.PI * 2
        + between(random, -0.12, 0.12);
      const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
      const branchLength = tierRadius * between(random, 0.90, 1.08);
      const branchY = tierHeight;
      const droop = branchLength * (0.145 - tierProgress * 0.055);
      const rootRadius = trunkRadiusAt(branchY / height);
      const points = [
        centerline.clone().addScaledVector(radial, rootRadius * 0.64),
        centerline.clone().addScaledVector(radial, branchLength * 0.29)
          .add(new THREE.Vector3(0, branchLength * 0.025, 0)),
        centerline.clone().addScaledVector(radial, branchLength * 0.60)
          .add(new THREE.Vector3(0, -droop * 0.68, 0)),
        centerline.clone().addScaledVector(radial, branchLength * 0.84)
          .add(new THREE.Vector3(0, -droop, 0)),
        centerline.clone().addScaledVector(radial, branchLength)
          .add(new THREE.Vector3(0, -droop * 0.43 + branchLength * 0.035, 0)),
      ];
      const branchRadii = [0.16, 0.135, 0.098, 0.064, 0.026]
        .map((radius) => radius * between(random, 0.92, 1.08));
      addTubePath(woodBuilder, points, branchRadii, random, {
        radialSegments: 6,
        palette: BRANCH_BARK_COLORS,
      });

      const clusterCount = Math.max(2, Math.ceil(branchLength / 1.42));
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        const progress = clusterCount === 1 ? 0.52 : 0.11 + (cluster / (clusterCount - 1)) * 0.78;
        const clusterCenter = interpolatePath(points, progress);
        addNeedleFan(
          needleBuilder,
          clusterCenter,
          radial,
          tangent,
          branchLength,
          random,
          (tier % 3) + tint,
        );
      }
      addNeedleFan(
        needleBuilder,
        interpolatePath(points, 0.98),
        radial,
        tangent,
        branchLength,
        random,
        ((tier + 1) % 3) + tint,
      );

      // Two fine side shoots at each bough give the canopy a branching,
      // feathery edge rather than the silhouette of stacked geometric cones.
      const forkOrigin = interpolatePath(points, 0.54);
      const forkLength = 0.68 + branchLength * 0.11;
      for (const sideSign of [-1, 1]) {
        const forkDirection = radial.clone().multiplyScalar(0.53)
          .addScaledVector(tangent, sideSign * 0.64)
          .addScaledVector(UP, 0.36)
          .normalize();
        const forkMiddle = forkOrigin.clone().addScaledVector(forkDirection, forkLength * 0.57);
        const forkTip = forkOrigin.clone().addScaledVector(forkDirection, forkLength);
        addTubePath(woodBuilder, [forkOrigin, forkMiddle, forkTip],
          [0.061, 0.036, 0.009], random, {
            radialSegments: 5,
            palette: BRANCH_BARK_COLORS,
          });
        const forkRadial = new THREE.Vector3(forkDirection.x, 0, forkDirection.z).normalize();
        const forkTangent = new THREE.Vector3(-forkRadial.z, 0, forkRadial.x);
        addNeedleFan(
          needleBuilder,
          forkTip,
          forkRadial,
          forkTangent,
          forkLength,
          random,
          ((tier + sideSign + 3) % 3) + tint,
        );
      }

      if (tier === 1 && branchIndex === 3) thirdConeBranch = interpolatePath(points, 0.6);
      if (tier === 2 && branchIndex === 1) firstConeBranch = interpolatePath(points, 0.57);
      if (tier === 4 && branchIndex === 4) secondConeBranch = interpolatePath(points, 0.58);
      if (tier === 6 && branchIndex === 2) fourthConeBranch = interpolatePath(points, 0.55);
    }
  }

  // A fine leader and crown sprays finish each tree with the pointed top of a
  // mature spruce. A couple of hanging cones add a small botanical detail.
  const leaderStart = trunkCenterAt(height, 0.78, leanX, leanZ);
  const leaderMiddle = trunkCenterAt(height, 0.91, leanX, leanZ);
  const leaderTip = trunkCenterAt(height * 1.04, 1, leanX, leanZ);
  addTubePath(woodBuilder, [leaderStart, leaderMiddle, leaderTip],
    [0.13, 0.075, 0.012], random, { radialSegments: 6, palette: BRANCH_BARK_COLORS });
  for (let spray = 0; spray < 5; spray += 1) {
    const angle = (spray / 5) * Math.PI * 2 + between(random, -0.15, 0.15);
    const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    addNeedleFan(needleBuilder, leaderTip, radial, tangent, 0.9, random, (spray % 3) + tint);
  }
  if (firstConeBranch) {
    addPineCone(woodBuilder, firstConeBranch,
      new THREE.Vector3(0.12, -1, 0.08), 0.78, 0.19, random);
  }
  if (secondConeBranch) {
    addPineCone(woodBuilder, secondConeBranch,
      new THREE.Vector3(-0.16, -1, -0.07), 0.62, 0.16, random);
  }
  if (thirdConeBranch) {
    addPineCone(woodBuilder, thirdConeBranch,
      new THREE.Vector3(0.14, -1, -0.12), 0.7, 0.175, random);
  }
  if (fourthConeBranch) {
    addPineCone(woodBuilder, fourthConeBranch,
      new THREE.Vector3(-0.12, -1, 0.11), 0.56, 0.145, random);
  }
}

export function buildPineGrove(sector, config, floorHeightAt = null, windUniforms = null) {
  if (!sector || sector.id !== 'HEX_S') return null;

  const woodBuilder = new VertexColorGeometryBuilder('PineGrove_Wood_HEX_S');
  const needleBuilder = new VertexColorGeometryBuilder('PineGrove_Needles_HEX_S');
  const group = new THREE.Group();
  group.name = 'PineGrove_HEX_S';
  group.position.set(sector.center.x, config.floorHeight, sector.center.z);
  group.userData.sectorId = sector.id;

  const counts = pineClassCounts(config);
  const placements = makeDenseTreePlacements(config).map((placement, index) => {
    const seed = 0x51f15e + index * 977;
    const random = makeRandom(seed);
    const yaw = random() * Math.PI * 2;
    const worldX = sector.center.x + placement.x;
    const worldZ = sector.center.z + placement.z;
    const worldFloor = typeof floorHeightAt === 'function'
      ? floorHeightAt(worldX, worldZ)
      : config.floorHeight;
    const terrainOffset = Number.isFinite(worldFloor)
      ? worldFloor - config.floorHeight
      : 0;
    const transform = makeTransform(placement, placement.scale, yaw, terrainOffset);
    woodBuilder.setTransform(transform);
    needleBuilder.setTransform(transform);
    if (index < counts.mature) {
      // Mature pines vary in height and needle hue so the grove never reads as
      // one tree stamped eighteen times across the hex.
      const height = TREE_HEIGHT * between(random, 0.86, 1.18);
      buildPineTree(woodBuilder, needleBuilder, random, height, Math.floor(random() * 3));
    } else if (index < counts.mature + counts.young) {
      // Young pines carry the density of the wood; they are shorter, thinner
      // and cheaper than the mature spruces while keeping the same silhouette.
      const height = TREE_HEIGHT * between(random, 0.6, 0.84);
      buildPineYoung(woodBuilder, needleBuilder, random, height, Math.floor(random() * 3));
    } else {
      buildPineSapling(woodBuilder, needleBuilder, random);
    }
    return { ...placement, yaw, seed, terrainOffset };
  });

  const woodMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  const needleMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  if (windUniforms) {
    // Trunks barely move; the crowns and the outer sprays travel with the gust.
    applyWindSway(woodMaterial, windUniforms, {
      strength: 0.075,
      frequency: 0.95,
      heightScale: 36,
      bend: 2.6,
    });
    applyWindSway(needleMaterial, windUniforms, {
      strength: 0.34,
      frequency: 1.35,
      heightScale: 30,
      bend: 2,
    });
    group.userData.windDriven = true;
  }

  const wood = new THREE.Mesh(woodBuilder.makeGeometry(), woodMaterial);
  wood.name = 'PineGrove_Wood_HEX_S';
  wood.userData.sectorId = sector.id;
  wood.castShadow = true;
  const needles = new THREE.Mesh(needleBuilder.makeGeometry(), needleMaterial);
  needles.name = 'PineGrove_Needles_HEX_S';
  needles.userData.sectorId = sector.id;
  needles.castShadow = true;
  group.add(wood, needles);

  // `treeCount` remains the mature-pine count used by the original map HUD;
  // totalTreeCount counts every trunk standing in the wood, which is now the
  // eighteen mature spruces plus the young pines and the saplings between them.
  group.userData.treeCount = CORE_TREE_PLACEMENTS.length;
  group.userData.totalTreeCount = placements.length;
  group.userData.visibleTreeCount = placements.length;
  group.userData.matureTreeCount = CORE_TREE_PLACEMENTS.length;
  group.userData.youngTreeCount = Math.max(
    0,
    Math.min(placements.length, counts.mature + counts.young) - counts.mature,
  );
  group.userData.saplingCount = Math.max(
    0,
    placements.length - CORE_TREE_PLACEMENTS.length - group.userData.youngTreeCount,
  );
  group.userData.treeClassCounts = Object.freeze({
    mature: group.userData.matureTreeCount,
    young: group.userData.youngTreeCount,
    sapling: group.userData.saplingCount,
  });
  group.userData.canopyDensity = 'dense';
  group.userData.wind = Boolean(windUniforms);
  group.userData.forestDensity = placements.length;
  group.userData.treePlacements = placements;
  group.userData.foliageType = 'mature-pine';

  // Fail early if a future placement edits a trunk outside its designated hex.
  for (const tree of placements) {
    if (!isPointInsideHex(
      tree.x,
      tree.z,
      0,
      0,
      config.hexRadius,
    )) {
      throw new RangeError(`Pine placement outside HEX_S: ${tree.x}, ${tree.z}`);
    }
  }

  return group;
}
