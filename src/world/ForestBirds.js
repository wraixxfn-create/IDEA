import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { isPointInsideHex } from './hexGrid.js';
import { between, makeRandom } from './random.js';

/**
 * ForestBirds — the wildlife of HEX_S.
 *
 * The forest biome used to be scenery: trees, grass, mist and rain, all of it
 * moving, none of it alive. This module adds the birds that belong in a
 * temperate spruce wood — a flock of chaffinches, a few great tits working the
 * trunks and a pair of jays — and, more importantly, the *behaviour* that makes
 * them read as animals rather than as props: perch selection, take-off and
 * landing, flap–glide flight that banks into its turns and weaves between the
 * trunks, ground foraging, preening, upside-down hanging, and the alarm flush
 * that a walking explorer triggers simply by getting close.
 *
 * Three decisions shape the module.
 *
 * 1. **The rig is a small puppet, not a formula.** Every bird is built from
 *    procedural geometry (no external assets) into a hand-rolled bone
 *    hierarchy: `root → body → (neck → head → beak, tail → two tail halves,
 *    wing → forearm → hand, legs → feet)` — the same shape as the explorer in
 *    `src/player/CharacterRig.js`, but skinned. Geometry is merged into one
 *    mesh per material and bound rigidly to the bones, so a bird with ~90
 *    modelled feather blades and ~22 joints costs two draw calls, which is
 *    what makes a flock of fifteen affordable.
 *
 * 2. **The animation is the point.** The wings carry a three-segment fold:
 *    the humerus, the forearm and the hand each add their own lag to the flap
 *    cycle, so the wing whips like a wing instead of hinging like a door. Every
 *    state is a blend — folded wings cream into the flap, a glide pulls the
 *    hands back and stops the flap, a landing flares both wings, sweeps the
 *    legs forward and fans the tail — and the nervous details are in there
 *    too: the head holds still while the body bobs, glances arrive in quick
 *    saccades with a tilt, the tail flicks, the crest lifts in alarm, the beak
 *    opens mid-song.
 *
 * 3. **The flock shares one brainstem.** A tiny scheduler hands out every
 *    decision — who forages, who preens, who flushes and who chases whom — from
 *    a seeded PRNG, so the wood behaves the same on every reload, no two birds
 *    ever act in lockstep, and a flush spreads through a flock a moment after
 *    the explorer steps into it.
 *
 * Nothing here is a collider: the explorer walks through birds, and they get
 * out of the way long before that happens.
 */

const TAU = Math.PI * 2;
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const IDENTITY_MATRIX = new THREE.Matrix4();

const SMOOTH = (current, target, rate, dt) => (
  current + (target - current) * (1 - Math.exp(-rate * dt))
);

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = THREE.MathUtils.lerp;

/* -------------------------------------------------------------------------
 * Species
 *
 * A species is a palette, a set of proportions and a temperament. Everything
 * else — the rig, the geometry builders, the flight model — is shared, which
 * is why adding a fourth forest bird is a data change rather than a coding
 * one.
 * ---------------------------------------------------------------------- */

const SPECIES_LIST = [
  {
    id: 'chaffinch',
    name: 'Chaffinch',
    // World size: the canonical rig is ~1.0 long, so this is a bird of about
    // 0.45 units nose-to-tail and 0.9 across the wings. Deliberately larger
    // than life (a real chaffinch is a third of that) because a bird the size
    // of the explorer's thumb would be invisible in a 440-unit hex.
    size: 0.46,
    count: 7,
    flockSize: 4,
    palette: {
      crown: 0x8ba0b8,
      nape: 0x7d8fa6,
      back: 0x8a6242,
      backDark: 0x6d4c33,
      rump: 0x8fa050,
      breast: 0xc07a58,
      breastWarm: 0xb2654a,
      belly: 0xdcc7ab,
      flank: 0xc9ae8d,
      wingCovert: 0x584434,
      wingCovertTip: 0xf1efe6,
      wingEdge: 0xd9c46a,
      primary: 0x4b4138,
      primaryEdge: 0xcabfa5,
      tail: 0x53453b,
      tailEdge: 0xefede3,
      shaft: 0xd8cdb6,
      beak: 0x9aa4a8,
      beakDark: 0x6d767a,
      leg: 0xc09080,
      eye: 0x120f0e,
      eyeRing: 0x2a2622,
    },
    morph: {
      bodyLength: 0.35,
      bodyWidth: 0.21,
      bodyHeight: 0.24,
      neck: 0.085,
      head: 0.17,
      beak: 0.1,
      beakDepth: 0.085,
      crest: 0.018,
      humerus: 0.155,
      forearm: 0.2,
      hand: 0.22,
      primaries: 9,
      secondaries: 7,
      covertRows: 3,
      tail: 0.26,
      tailWidth: 0.115,
      tailCount: 12,
      leg: 0.1,
      toe: 0.048,
      wingCamber: 0.1,
    },
    flight: {
      flapHz: 4.4,
      flapAmplitude: 1.28,
      cruiseSpeed: 6.4,
      maxSpeed: 12.5,
      glideBias: 0.5,
      turnRate: 4.4,
      climbRate: 6.2,
      weave: 0.5,
      burst: 1.5,
      glideDuty: 0.34,
    },
    behaviour: {
      flushRadius: 6.5,
      perchBand: [0.2, 0.62],
      groundShare: 0.3,
      curiosity: 0.25,
      chases: 0.5,
      hangShare: 0,
      social: 1,
    },
  },
  {
    id: 'tit',
    name: 'Great tit',
    size: 0.42,
    count: 5,
    flockSize: 3,
    palette: {
      crown: 0x15171c,
      nape: 0x1b1e24,
      back: 0x7d8a4c,
      backDark: 0x5f6b3b,
      rump: 0x8d9a58,
      breast: 0xe6c93c,
      breastWarm: 0xd9b933,
      belly: 0xefdb6a,
      flank: 0xd9c452,
      wingCovert: 0x54634b,
      wingCovertTip: 0xe2e5d2,
      wingEdge: 0xa9b48c,
      primary: 0x39423c,
      primaryEdge: 0xb9bfa4,
      tail: 0x333a42,
      tailEdge: 0xdadfd4,
      shaft: 0xcfd4c0,
      beak: 0x2f3437,
      beakDark: 0x1d2124,
      leg: 0x99a1a0,
      eye: 0x110f0e,
      eyeRing: 0x24211f,
      cheek: 0xf3f1e6,
    },
    morph: {
      bodyLength: 0.32,
      bodyWidth: 0.205,
      bodyHeight: 0.23,
      neck: 0.075,
      head: 0.165,
      beak: 0.1,
      beakDepth: 0.08,
      // A great tit has a black cap, not a crest: the fan is left off and the
      // head plumage carries the cap instead.
      crest: 0,
      humerus: 0.145,
      forearm: 0.185,
      hand: 0.2,
      primaries: 9,
      secondaries: 7,
      covertRows: 3,
      tail: 0.21,
      tailWidth: 0.11,
      tailCount: 12,
      leg: 0.092,
      toe: 0.044,
      wingCamber: 0.09,
    },
    flight: {
      flapHz: 5.4,
      flapAmplitude: 1.38,
      cruiseSpeed: 5.8,
      maxSpeed: 13.5,
      glideBias: 0.35,
      turnRate: 5.4,
      climbRate: 6.8,
      weave: 0.75,
      burst: 1.75,
      glideDuty: 0.2,
    },
    behaviour: {
      flushRadius: 5,
      perchBand: [0.16, 0.66],
      groundShare: 0.22,
      curiosity: 0.45,
      chases: 0.35,
      hangShare: 0.5,
      social: 0.6,
    },
  },
  {
    id: 'jay',
    name: 'Jay',
    size: 0.86,
    count: 2,
    flockSize: 1,
    palette: {
      crown: 0xeee9de,
      nape: 0xd9c6ad,
      back: 0xa8765c,
      backDark: 0x8a6050,
      rump: 0xf1efe6,
      breast: 0xc99a7e,
      breastWarm: 0xb9856a,
      belly: 0xdcC6ab,
      flank: 0xc3a78c,
      wingCovert: 0x3b4f96,
      wingCovertTip: 0x8fa5e8,
      wingEdge: 0x1d2330,
      primary: 0x23272e,
      primaryEdge: 0x8f97a4,
      tail: 0x24272d,
      tailEdge: 0xd9dcd6,
      shaft: 0xa9b0b8,
      beak: 0x2b2f33,
      beakDark: 0x15181b,
      leg: 0xa88170,
      eye: 0x131211,
      eyeRing: 0x2b2622,
      moustache: 0x1a1c20,
      blue: 0x4f70c8,
      blueBar: 0x1b2130,
    },
    morph: {
      bodyLength: 0.5,
      bodyWidth: 0.26,
      bodyHeight: 0.29,
      neck: 0.1,
      head: 0.2,
      beak: 0.15,
      beakDepth: 0.1,
      crest: 0.085,
      humerus: 0.2,
      forearm: 0.26,
      hand: 0.28,
      primaries: 10,
      secondaries: 8,
      covertRows: 3,
      tail: 0.4,
      tailWidth: 0.185,
      tailCount: 12,
      leg: 0.15,
      toe: 0.06,
      wingCamber: 0.11,
    },
    flight: {
      flapHz: 3.1,
      flapAmplitude: 1.12,
      cruiseSpeed: 8.6,
      maxSpeed: 15,
      glideBias: 0.75,
      turnRate: 2.8,
      climbRate: 5.2,
      weave: 0.3,
      burst: 1.25,
      glideDuty: 0.52,
    },
    behaviour: {
      flushRadius: 13,
      perchBand: [0.28, 0.78],
      groundShare: 0.34,
      curiosity: 0.7,
      chases: 0.5,
      hangShare: 0,
      social: 0.2,
    },
  },
];

export const BIRD_SPECIES = Object.freeze(
  Object.fromEntries(SPECIES_LIST.map((species) => [
    species.id,
    Object.freeze({ ...species, palette: Object.freeze(species.palette), morph: Object.freeze(species.morph) }),
  ])),
);

/* -------------------------------------------------------------------------
 * Geometry helpers
 * ---------------------------------------------------------------------- */

function ensureIndexed(geometry) {
  if (!geometry.index) {
    const count = geometry.attributes.position.count;
    geometry.setIndex(Array.from({ length: count }, (_, index) => index));
  }
  return geometry;
}

/** Merging requires every part to carry exactly the same attribute set. */
function normalized(geometry) {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color') {
      geometry.deleteAttribute(name);
    }
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  return ensureIndexed(geometry);
}

/** Mirror a part across the bird's own centre plane, keeping the winding. */
function mirrorX(geometry) {
  geometry.scale(-1, 1, 1);
  const index = geometry.index;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    index.setX(i, b);
    index.setX(i + 1, a);
  }
  index.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function paint(geometry, color, { tipColor = null, tipAxis = 'x', from = 0, to = 1, edgeColor = null, edgeMask = null } = {}) {
  const base = color instanceof THREE.Color ? color : new THREE.Color(color);
  const tip = tipColor === null ? null : (tipColor instanceof THREE.Color ? tipColor : new THREE.Color(tipColor));
  const edge = edgeColor === null ? null : (edgeColor instanceof THREE.Color ? edgeColor : new THREE.Color(edgeColor));
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const scratch = new THREE.Color();
  const readAxis = tipAxis === 'y' ? 'getY' : tipAxis === 'z' ? 'getZ' : 'getX';
  for (let index = 0; index < position.count; index += 1) {
    scratch.copy(base);
    // `from` and `to` may run either way down the axis: a body is painted
    // from its back down to its belly, which means `to < from`. A guard here
    // used to silently drop the whole gradient.
    if (tip && to !== from) {
      const raw = (position[readAxis](index) - from) / (to - from);
      scratch.lerp(tip, clamp01(raw));
    }
    if (edge && edgeMask) {
      const amount = edgeMask(position, index);
      if (amount > 0) scratch.lerp(edge, Math.min(1, amount));
    }
    colors[index * 3] = scratch.r;
    colors[index * 3 + 1] = scratch.g;
    colors[index * 3 + 2] = scratch.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** A vertical ambient-occlusion gradient: joints and bellies sit in shadow. */
function occlude(geometry, { from, to, strength = 0.35, invert = false }) {
  const position = geometry.attributes.position;
  const color = geometry.attributes.color;
  const span = Math.max(1e-4, to - from);
  for (let index = 0; index < position.count; index += 1) {
    const raw = clamp01((position.getY(index) - from) / span);
    const t = invert ? 1 - raw : raw;
    const smooth = t * t * (3 - 2 * t);
    const factor = 1 - strength * (1 - smooth);
    color.setXYZ(
      index,
      color.getX(index) * factor,
      color.getY(index) * factor,
      color.getZ(index) * factor,
    );
  }
  color.needsUpdate = true;
  return geometry;
}

/**
 * Aim a feather.
 *
 * Feathers are authored running along +X with the upper surface towards +Y, so
 * aiming one is three rotations in a fixed order: `twist` rolls the blade about
 * its own quill, `pitch` raises the tip out of the wing plane, and `sweep`
 * swings it backwards (positive = back, which is how a wing folds and how a
 * tail fan splays).
 */
function orient(geometry, { twist = 0, pitch = 0, sweep = 0 } = {}) {
  if (twist) geometry.rotateX(twist);
  if (pitch) geometry.rotateZ(pitch);
  if (sweep) geometry.rotateY(-sweep);
  return geometry;
}

const MIRROR_SCRATCH = { i: 0, j: 0 };
const MIRROR_SIGNS = [-1, 1, 1];
const MIRRORED = [];

/**
 * Mirror a rotation across the bird's centre plane: `S · M · S`.
 *
 * Negating a couple of quaternion components is not mirroring — it is a
 * different rotation entirely — so the basis is reflected properly here:
 * `(S M S)ᵢⱼ = sᵢ sⱼ Mᵢⱼ` with `s = (-1, 1, 1)`, which is a proper rotation
 * (determinant +1) and exactly the pose the other wing of a real bird holds.
 */
function mirrorMatrix(matrix, target = matrix) {
  const source = matrix.elements;
  for (MIRROR_SCRATCH.i = 0; MIRROR_SCRATCH.i < 3; MIRROR_SCRATCH.i += 1) {
    for (MIRROR_SCRATCH.j = 0; MIRROR_SCRATCH.j < 3; MIRROR_SCRATCH.j += 1) {
      const sign = MIRROR_SIGNS[MIRROR_SCRATCH.i] * MIRROR_SIGNS[MIRROR_SCRATCH.j];
      MIRRORED[MIRROR_SCRATCH.i * 3 + MIRROR_SCRATCH.j] =
        sign * source[MIRROR_SCRATCH.j * 4 + MIRROR_SCRATCH.i];
    }
  }
  for (MIRROR_SCRATCH.i = 0; MIRROR_SCRATCH.i < 3; MIRROR_SCRATCH.i += 1) {
    for (MIRROR_SCRATCH.j = 0; MIRROR_SCRATCH.j < 3; MIRROR_SCRATCH.j += 1) {
      // three.js stores columns first, so element (row i, column j) lives at
      // `elements[j * 4 + i]`.
      target.elements[MIRROR_SCRATCH.j * 4 + MIRROR_SCRATCH.i] =
        MIRRORED[MIRROR_SCRATCH.i * 3 + MIRROR_SCRATCH.j];
    }
  }
  return target;
}

/**
 * Lay a feather scale on a curved surface.
 *
 * `up` is the direction the scale's tip should point (down the breast, back
 * along the nape), `normal` is the surface it lies on. The scale's own visible
 * face is its +Z, so the basis is built with +Z outward, +Y up the surface and
 * +X across it — which is why a row of breast feathers follows the ribs
 * instead of tiling a flat plane in front of them.
 */
function layOnSurface(geometry, { at, normal, up = [0, 1, 0], roll = 0, tilt = 0 }) {
  const outward = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const upward = new THREE.Vector3(up[0], up[1], up[2]);
  upward.addScaledVector(outward, -upward.dot(outward));
  if (upward.lengthSq() < 1e-8) upward.set(0, 1, 0).addScaledVector(outward, -outward.y);
  upward.normalize();
  const across = new THREE.Vector3().crossVectors(upward, outward).normalize();
  const basis = new THREE.Matrix4().makeBasis(across, upward, outward);
  geometry.applyMatrix4(basis);
  if (tilt) geometry.rotateX(tilt);
  if (roll) geometry.rotateZ(roll);
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

/**
 * A point and an outward normal on an ellipsoid, parameterised the way plumage
 * is: `u` runs left to right around the front, `v` runs from the crown down the
 * breast. The normal is the true surface normal, so scales laid along a row all
 * face slightly different ways, exactly as they would on a bird.
 */
function ellipsoidSurface({ center = [0, 0, 0], radii, u = 0, v = 0, wrap = 0.86, vRange = [0.4, -0.95] }) {
  const [rx, ry, rz] = radii;
  const vertical = lerp(vRange[0], vRange[1], v);
  const y = center[1] + ry * vertical;
  const shrink = Math.sqrt(Math.max(0.0001, 1 - vertical * vertical));
  const angle = u * Math.PI * 0.5 * wrap;
  const x = center[0] + rx * shrink * Math.sin(angle);
  const z = center[2] - rz * shrink * Math.cos(angle);
  const normal = new THREE.Vector3(
    (x - center[0]) / (rx * rx),
    (y - center[1]) / (ry * ry),
    (z - center[2]) / (rz * rz),
  ).normalize();
  return { position: [x, y, z], normal };
}

function place(geometry, { at = [0, 0, 0], rot = [0, 0, 0], scale = null } = {}) {
  if (scale) geometry.scale(scale[0], scale[1], scale[2]);
  if (rot[0]) geometry.rotateX(rot[0]);
  if (rot[1]) geometry.rotateY(rot[1]);
  if (rot[2]) geometry.rotateZ(rot[2]);
  if (at[0] || at[1] || at[2]) geometry.translate(at[0], at[1], at[2]);
  return normalized(geometry);
}

/* ---- Feathers --------------------------------------------------------- */

/**
 * One feather, modelled along +X (outboard), with the leading edge at -Z.
 *
 * The blade is a three-point cross-section — leading edge, raised shaft,
 * trailing edge — swept along a profile that starts narrow at the quill, swells
 * around the middle and closes in a rounded tip, with a camber along the length
 * and a droop at the end. That is enough shape for the light to catch a feather
 * as a feather; a flat quad would read as a paper cut-out in the flare of a
 * landing.
 */
function featherGeometry({
  length,
  width,
  profile = null,
  camber = 0.12,
  droop = 0.1,
  sweep = 0.0,
  twist = 0.0,
  baseColor,
  tipColor = null,
  edgeColor = null,
  shaftColor = null,
  barColor = null,
  barAt = 0.62,
  barWidth = 0.16,
  tipStart = 0.55,
  segments = 5,
}) {
  const shape = profile ?? [
    [0.0, 0.32], [0.16, 0.66], [0.42, 1.0], [0.68, 0.98], [0.86, 0.74], [1.0, 0.16],
  ];
  const halfWidthAt = (t) => {
    for (let i = 0; i < shape.length - 1; i += 1) {
      const [startT, startW] = shape[i];
      const [endT, endW] = shape[i + 1];
      if (t <= endT) {
        const blend = (t - startT) / Math.max(1e-4, endT - startT);
        return width * 0.5 * lerp(startW, endW, blend);
      }
    }
    return width * 0.5 * shape[shape.length - 1][1];
  };

  const positions = [];
  const colors = [];
  const indices = [];
  const scratch = new THREE.Color();
  const base = new THREE.Color(baseColor);
  const tip = tipColor === null ? base.clone() : new THREE.Color(tipColor);
  const edge = edgeColor === null ? base : new THREE.Color(edgeColor);
  const shaft = shaftColor === null ? base.clone().lerp(new THREE.Color(0xffffff), 0.3) : new THREE.Color(shaftColor);
  const bar = barColor === null ? null : new THREE.Color(barColor);

  for (let step = 0; step <= segments; step += 1) {
    const t = step / segments;
    const x = length * t;
    const half = halfWidthAt(t);
    const arc = Math.sin(Math.min(1, t * 0.94 + 0.06) * Math.PI);
    const y = camber * width * arc - droop * length * t * t;
    const z = sweep * length * t * t;
    // A little twist along the length rotates the blade about its quill, which
    // is what makes a fan of primaries read as a surface rather than as a rake.
    const roll = twist * t;
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const station = [
      { z: -half, lift: -0.16 * half },
      { z: 0, lift: 0.14 * half },
      { z: half, lift: -0.3 * half },
    ];
    for (const point of station) {
      const localZ = point.z * cos - point.lift * sin;
      const localY = point.z * sin + point.lift * cos;
      positions.push(x, y + localY, z + localZ);
      // The tip colour only arrives at the tip: a feather is mostly the colour
      // of the bird, with its marking on the last third.
      const tipAmount = tipStart >= 1 ? 0 : clamp01((t - tipStart) / (1 - tipStart));
      if (bar && Math.abs(t - barAt) < barWidth) {
        scratch.copy(bar);
      } else if (point.z > half * 0.4) {
        scratch.copy(edge).lerp(tip, tipAmount * 0.85);
      } else if (point.z < -half * 0.4) {
        scratch.copy(base).lerp(tip, tipAmount * 0.5);
      } else {
        scratch.copy(shaft).lerp(tip, tipAmount * 0.7);
      }
      // The quill end of every feather is dimmer: the base of a wing is the
      // part the sun never reaches.
      const shade = 0.82 + 0.18 * clamp01(t * 1.8);
      colors.push(scratch.r * shade, scratch.g * shade, scratch.b * shade);
    }
  }

  for (let step = 0; step < segments; step += 1) {
    const row = step * 3;
    const next = row + 3;
    // Wound so the blade's normal is its upper surface (+Y): a wing that is lit
    // from above has to *have* an above.
    indices.push(row, row + 1, next,
      row + 1, next + 1, next,
      row + 1, row + 2, next + 1,
      row + 2, next + 2, next + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A wing as one continuous surface.
 *
 * Feathers-as-separate-blades look like a pile of blades; a wing is really a
 * *ribbon* — a curved leading edge, a trailing edge that steps out in feather
 * tips, and a chord that swells from the shoulder and tapers to a point. This
 * builds exactly that: station by station, three rows across (leading edge,
 * camber, trailing edge) so the surface has thickness, and every station free
 * to carry its own colour — which is where the wing bars and the pale tips of
 * the primaries come from.
 *
 * Because the stations are just points and directions, the same wing can be
 * built twice: once held out for flight and once folded back along the flank.
 * Two shapes with the same vertex count are a morph target, which is how this
 * rig folds a wing — the surface wraps around the body instead of rotating
 * rigidly, exactly as the real thing does.
 */
/**
 * The cross-section of a wing, as fractions of its thickness.
 *
 * Five rows span the chord from the leading edge to the trailing edge. The
 * leading edge is rounded and sits high, the camber is the highest point, and
 * the trailing edge thins away below the rest: that is what stops a wing from
 * being a flat sheet seen edge-on, and it is what the light catches when the
 * wing beats.
 */
const WING_SECTION = [
  { u: 0, lift: 0.42 },
  { u: 0.26, lift: 0.14 },
  { u: 0.5, lift: 0 },
  { u: 0.78, lift: -0.34 },
  { u: 1, lift: -0.72 },
];

/**
 * A wing as one continuous surface.
 *
 * The wing is a ribbon along the bone polyline: every station carries a chord
 * (leading edge to trailing edge), a direction for that chord to run in, and a
 * thickness. `notchAt(index, t)` may pull a station's trailing rows inwards, so
 * alternating depths around the outer wing become the separated tips of the
 * primaries — the one thing that makes a wing read as feathers rather than as a
 * shape. The leading edge is never notched: the outline of the wing stays
 * clean and only the back of it frays.
 */
function wingRibbonGeometry({ stations, colorAt, notchAt = null, section = WING_SECTION }) {
  const positions = [];
  const colors = [];
  const indices = [];
  const scratch = new THREE.Color();
  const path = new THREE.Vector3();
  const thicknessDirection = new THREE.Vector3();

  stations.forEach((station, index) => {
    const { point, chordDirection, chord, thickness } = station;
    const next = stations[Math.min(stations.length - 1, index + 1)];
    const before = stations[Math.max(0, index - 1)];
    path.subVectors(next.point, before.point);
    if (path.lengthSq() < 1e-10) path.set(1, 0, 0);
    path.normalize();
    // The dorsal face of the wing is the outside of `chord x path`, which is
    // why the leading edge is lifted along it and the trailing edge dropped.
    thicknessDirection.crossVectors(chordDirection, path).normalize();
    const t = index / (stations.length - 1);
    const notch = clamp01(notchAt ? notchAt(index, t) : 0);
    for (let row = 0; row < section.length; row += 1) {
      const { u, lift } = section[row];
      // A notch only reaches the trailing rows, and reaches them smoothly.
      const back = u * chord * (1 - notch * u * u);
      const rise = lift * thickness;
      positions.push(
        point.x + chordDirection.x * back + thicknessDirection.x * rise,
        point.y + chordDirection.y * back + thicknessDirection.y * rise,
        point.z + chordDirection.z * back + thicknessDirection.z * rise,
      );
      colorAt(scratch, { t, u, row, index });
      colors.push(scratch.r, scratch.g, scratch.b);
    }
  });

  for (let index = 0; index < stations.length - 1; index += 1) {
    for (let row = 0; row < section.length - 1; row += 1) {
      const a = index * section.length + row;
      const b = a + section.length;
      // Wound so the upper surface of the wing is its +Y face.
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A rounded, overlapping feather scale — the breast and covert plumage. */
function featherScaleGeometry(width, height, { bend = 0.25, segments = 3 } = {}) {
  const positions = [];
  const colors = [];
  const indices = [];
  for (let step = 0; step <= segments; step += 1) {
    const t = step / segments;
    const arc = Math.sin(t * Math.PI * 0.86 + 0.08);
    const half = width * 0.5 * arc;
    const y = -height * t + bend * height * (1 - Math.cos(t * Math.PI)) * 0.5;
    positions.push(-half, y, 0, 0, y + 0.012 * height, 0, half, y, 0);
    const shade = 0.78 + 0.22 * (1 - t);
    for (let column = 0; column < 3; column += 1) colors.push(shade, shade, shade);
  }
  for (let step = 0; step < segments; step += 1) {
    const row = step * 3;
    const next = row + 3;
    indices.push(row, next, row + 1, row + 1, next, next + 1,
      row + 1, next + 1, row + 2, row + 2, next + 1, next + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** An ellipsoid with a soft, slightly clumped surface. */
function bodyGeometry(radius, { width, height, length, seed = 1, clump = 0.035, segments = 18, rings = 12 }) {
  const geometry = new THREE.SphereGeometry(radius, segments, rings);
  const position = geometry.attributes.position;
  const random = makeRandom(seed);
  const phases = [random() * TAU, random() * TAU, random() * TAU];
  const point = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index);
    const clumps = 1
      + clump * Math.sin(point.x * 11 + phases[0])
      + clump * 0.7 * Math.sin(point.y * 13 + phases[1])
      + clump * 0.8 * Math.sin(point.z * 9 + phases[2]);
    position.setXYZ(index, point.x * width * clumps, point.y * height * clumps, point.z * length * clumps);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/* -------------------------------------------------------------------------
 * The rig
 * ---------------------------------------------------------------------- */

function bone(name, parent, position) {
  const node = new THREE.Bone();
  node.name = name;
  if (position) node.position.set(position[0], position[1], position[2]);
  if (parent) parent.add(node);
  return node;
}

/**
 * A bird: bones, one skinned mesh per material, and `applyPose`.
 *
 * The pose object is plain numbers — attitude, wing state, head and feet — so
 * the behaviour code never touches a matrix and the rig can be rendered,
 * measured or asserted against in a test without a renderer.
 */
export class BirdRig {
  constructor(species, { seed = 1, windUniforms = null, config = null } = {}) {
    this.species = species;
    this.config = config ?? {};
    this.morph = species.morph;
    this.palette = species.palette;
    this.size = species.size;
    this.seed = seed;

    this.root = new THREE.Group();
    this.root.name = `Bird_${species.id}`;
    this.root.userData.kind = 'bird-rig';
    this.root.userData.speciesId = species.id;

    const morph = this.morph;
    const bodyLength = morph.bodyLength;
    const bodyRadius = 0.5;

    /* ---- bones ---- */
    this.body = bone('Body', this.root, [0, 0, 0]);
    this.chest = bone('Chest', this.body, [0, 0.02, -bodyLength * 0.16]);
    // The neck has to actually reach the skull: a bird's head sits a neck's
    // length in front of the shoulders, not half a body length out in the air.
    this.neck = bone('Neck', this.chest, [0, morph.bodyHeight * 0.5, -bodyLength * 0.42]);
    this.head = bone('Head', this.neck, [0, morph.neck * 0.5, -morph.neck * 0.86]);
    this.beakLower = bone('BeakLower', this.head, [0, -morph.head * 0.12, -morph.head * 0.66]);

    this.tailBase = bone('TailBase', this.body, [0, morph.bodyHeight * 0.1, bodyLength * 0.78]);
    this.tail = bone('Tail', this.tailBase, [0, 0, 0.02]);
    this.tailLeft = bone('TailLeft', this.tail, [0, 0, 0.02]);
    this.tailRight = bone('TailRight', this.tail, [0, 0, 0.02]);

    this.crest = bone('Crest', this.head, [0, morph.head * 0.72, -morph.head * 0.2]);

    this.wing = {};
    this.forearm = {};
    this.hand = {};
    this.leg = {};
    this.shank = {};
    this.foot = {};
    this.toesFront = {};
    this.toesBack = {};

    // Wing frames: both wings run along their own +X, so mirroring a pose is a
    // mirror image of the other (see `poseWing`).
    this.wingSign = { L: -1, R: 1 };
    const shoulderX = morph.bodyWidth * 0.86;
    const shoulderY = morph.bodyHeight * 0.42;
    const shoulderZ = -bodyLength * 0.3;

    for (const side of ['L', 'R']) {
      const sign = this.wingSign[side];
      const shoulder = bone(`Wing.${side}`, this.chest, [sign * shoulderX, shoulderY, shoulderZ]);
      const fore = bone(`Forearm.${side}`, shoulder, [sign * morph.humerus, 0, 0]);
      const hand = bone(`Hand.${side}`, fore, [sign * morph.forearm, 0, 0]);
      this.wing[side] = shoulder;
      this.forearm[side] = fore;
      this.hand[side] = hand;

      const legX = sign * morph.bodyWidth * 0.42;
      const leg = bone(`Leg.${side}`, this.body, [legX, -morph.bodyHeight * 0.52, bodyLength * 0.16]);
      const shank = bone(`Shank.${side}`, leg, [0, -morph.leg * 0.42, 0.01]);
      const foot = bone(`Foot.${side}`, shank, [0, -morph.leg * 0.58, -0.004]);
      const toesFront = bone(`ToesFront.${side}`, foot, [0, 0, 0.012]);
      const toesBack = bone(`ToesBack.${side}`, foot, [0, 0, 0.008]);
      this.leg[side] = leg;
      this.shank[side] = shank;
      this.foot[side] = foot;
      this.toesFront[side] = toesFront;
      this.toesBack[side] = toesBack;
    }

    this.bones = [
      this.body, this.chest, this.neck, this.head, this.beakLower, this.crest,
      this.tailBase, this.tail, this.tailLeft, this.tailRight,
      this.wing.L, this.forearm.L, this.hand.L,
      this.wing.R, this.forearm.R, this.hand.R,
      this.leg.L, this.shank.L, this.foot.L, this.toesFront.L, this.toesBack.L,
      this.leg.R, this.shank.R, this.foot.R, this.toesFront.R, this.toesBack.R,
    ];
    this.boneIndex = new Map(this.bones.map((node, index) => [node.name, index]));

    // Rest pose first: the bind matrices are read from the unposed hierarchy.
    this.resetPose();
    this.root.updateMatrixWorld(true);

    /* ---- geometry ---- */
    const parts = this.buildParts(bodyRadius);
    this.meshes = [];
    for (const [key, bucket] of Object.entries(parts)) {
      if (!bucket.length) continue;
      const geometry = this.mergeParts(bucket, `${species.id}_${key}`);
      const material = key === 'feather' ? this.createFeatherMaterial() : this.createKeratinMaterial();
      const mesh = new THREE.SkinnedMesh(geometry, material);
      mesh.name = `Bird_${species.id}_${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.sectorId = 'HEX_S';
      mesh.userData.speciesId = species.id;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      // The geometry is authored in the bird's own space, so the bind matrix is
      // the identity: the shader then skins in root-local space, the root's own
      // transform stays out of it, and `AttachedBindMode` keeps the mesh's
      // bind inverse in step with the root as the bird moves through the wood.
      mesh.bind(new THREE.Skeleton(this.bones, this.buildBoneInverses()), IDENTITY_MATRIX);
      this.meshes.push(mesh);
    }

    this.resetPose();
    // Where the beak tip sits in the bird's own space, for the shadow and for
    // tests that care whether the bird is looking where it is going.
    const beakRest = new THREE.Vector3().setFromMatrixPosition(this.beakLower.matrixWorld);
    this.beakTipLocal = beakRest.clone().add(new THREE.Vector3(
      0,
      -this.morph.beak * 0.14,
      -this.morph.beak * 0.88,
    ));

    // Rest-pose inverses: with these, a point modelled in the bird's own space
    // can be carried through a bone's *current* pose (the same transform the
    // skinning shader applies to a weighted vertex).
    this.restInverse = new Map(this.bones.map((node) => [
      node.name,
      new THREE.Matrix4().copy(node.matrixWorld).invert(),
    ]));
    this.scratchQuaternion = new THREE.Quaternion();
    this.scratchQuaternionB = new THREE.Quaternion();
    this.scratchQuaternionC = new THREE.Quaternion();
    this.scratchQuaternionD = new THREE.Quaternion();
    this.scratchMatrix = new THREE.Matrix4();
    this.scratchMatrixB = new THREE.Matrix4();
    this.scratchVectorA = new THREE.Vector3();
    this.scratchVectorB = new THREE.Vector3();
    this.scratchVectorC = new THREE.Vector3();
    this.targetQuaternions = {
      shoulder: new THREE.Quaternion(),
      forearm: new THREE.Quaternion(),
      hand: new THREE.Quaternion(),
    };
  }

  buildBoneInverses() {
    return this.bones.map((node) => new THREE.Matrix4().copy(node.matrixWorld).invert());
  }

  /**
   * Merge the parts of one material into a single skinned geometry.
   *
   * The parts are modelled in the frame of the bone that carries them (a wing's
   * feathers are laid out along the humerus, not around the bird's origin), so
   * each one is baked into the bird's own space through its bone's rest matrix
   * before it is merged. That bake is what the skinning bind expects: from then
   * on `bone_now · bone_rest⁻¹` moves every vertex exactly as its bone moves.
   */
  mergeParts(bucket, name) {
    // Every part is modelled in the frame of the bone that carries it — a
    // wing's feathers are laid out along the humerus, not around the bird's
    // origin — so each vertex is baked into the bird's own space through its
    // bone's rest matrix. That bake is what the skinning bind expects: from
    // then on `bone_now · bone_rest⁻¹` moves a vertex exactly as its bone moves.
    const vertexBones = [];
    for (const entry of bucket) {
      const count = entry.geometry.attributes.position.count;
      const boneOf = typeof entry.bone === 'function' ? entry.bone : () => entry.bone;
      // A part modelled in the bird's own space (a wing surface that spans
      // three bones at once) is already where it belongs and must not be moved
      // by any single bone's rest matrix.
      const birdSpace = entry.birdSpace === true;
      const position = entry.geometry.attributes.position;
      const point = new THREE.Vector3();
      for (let index = 0; index < count; index += 1) {
        const boneName = boneOf(index);
        const bone = this.bones[this.boneIndex.get(boneName)];
        if (!bone) throw new Error(`Unknown bone ${boneName} in ${name}`);
        vertexBones.push(boneName);
        if (birdSpace) continue;
        point.fromBufferAttribute(position, index).applyMatrix4(bone.matrixWorld);
        position.setXYZ(index, point.x, point.y, point.z);
      }
      position.needsUpdate = true;
      entry.geometry.computeVertexNormals();
    }

    const geometries = bucket.map((entry) => entry.geometry);
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!geometry) throw new Error(`Unable to merge ${name}`);

    // A part that brought a second shape with it contributes a morph target:
    // the difference between the two. This is how the wings fold — the shape
    // changes, and `wingSpread` is the slider.
    let vertex = 0;
    let hasMorph = false;
    const morph = new Float32Array(geometry.attributes.position.count * 3);
    for (const entry of bucket) {
      const count = entry.geometry.attributes.position.count;
      if (entry.morph) {
        hasMorph = true;
        const source = entry.geometry.attributes.position;
        const target = entry.morph.attributes.position;
        for (let index = 0; index < count; index += 1) {
          morph[(vertex + index) * 3] = target.getX(index) - source.getX(index);
          morph[(vertex + index) * 3 + 1] = target.getY(index) - source.getY(index);
          morph[(vertex + index) * 3 + 2] = target.getZ(index) - source.getZ(index);
        }
      }
      vertex += count;
    }
    if (hasMorph) {
      geometry.morphAttributes.position = [new THREE.BufferAttribute(morph, 3)];
      geometry.morphTargetsRelative = true;
    }

    const skinIndex = new Uint16Array(geometry.attributes.position.count * 4);
    const skinWeight = new Float32Array(geometry.attributes.position.count * 4);
    vertexBones.forEach((boneName, index) => {
      skinIndex[index * 4] = this.boneIndex.get(boneName);
      skinWeight[index * 4] = 1;
    });
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    geometry.name = name;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    // Wings and tails travel well outside the rest-pose sphere.
    geometry.boundingSphere.radius *= 1.5;
    return geometry;
  }

  createFeatherMaterial() {
    return new THREE.MeshStandardMaterial({
      name: `BirdFeathers_${this.species.id}`,
      vertexColors: true,
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
    });
  }

  createKeratinMaterial() {
    return new THREE.MeshStandardMaterial({
      name: `BirdKeratin_${this.species.id}`,
      vertexColors: true,
      roughness: 0.34,
      metalness: 0.08,
      side: THREE.DoubleSide,
    });
  }

  /* ---- modelling ------------------------------------------------------ */
  /**
   * Model the whole bird.
   *
   * The body, head and tail centre are authored in the bird's own frame; the
   * wings, legs and eyes are authored **once on the right-hand side** and
   * mirrored across the centre plane, so the two halves of a bird can never
   * disagree with each other. Every part is registered against the bone that
   * carries it and merged into one mesh per material (feathers, keratin).
   */
  buildParts(bodyRadius) {
    const parts = { feather: [], keratin: [] };
    const add = (key, boneName, geometry, { morph = null, birdSpace = false } = {}) => {
      parts[key].push({
        bone: boneName,
        geometry: normalized(geometry),
        // A part may carry a second shape (a wing held out and a wing folded).
        // It travels in the part record, never in `geometry.userData`: three.js
        // shares `userData` between a geometry and its clones, so a stash there
        // would leak from one wing into the other.
        morph: morph ? normalized(morph) : null,
        birdSpace,
      });
    };
    const { palette: P, morph: M } = this;
    const bodyLength = M.bodyLength;
    const isTit = this.species.id === 'tit';
    const isJay = this.species.id === 'jay';

    /* ---- body ---------------------------------------------------------- */
    // The body is an ellipsoid whose semi-axes are half the bird's width, half
    // its height and half its length: `bodyGeometry` scales a unit sphere, so
    // the numbers passed in are full extents.
    const body = bodyGeometry(bodyRadius, {
      width: M.bodyWidth,
      height: M.bodyHeight,
      length: bodyLength * 1.02,
      seed: 0x1b0d1 + this.seed,
      clump: 0.03,
    });
    paint(body, P.back, {
      tipColor: P.belly,
      tipAxis: 'y',
      from: M.bodyHeight * 0.15,
      to: -M.bodyHeight * 0.8,
    });
    // Mottled flanks: the underparts of a woodland bird are never one flat
    // colour, and the variation is what the eye reads as soft plumage.
    const bodyPosition = body.attributes.position;
    const bodyColor = body.attributes.color;
    const flankColor = new THREE.Color(P.flank);
    const rumpColor = new THREE.Color(P.rump ?? P.backDark);
    for (let index = 0; index < bodyPosition.count; index += 1) {
      const x = bodyPosition.getX(index);
      const y = bodyPosition.getY(index);
      const z = bodyPosition.getZ(index);
      const band = 0.5 + 0.5 * Math.sin(z * 30 + y * 17);
      if (y < 0.02 && Math.abs(x) > M.bodyWidth * 0.4) {
        const amount = band * 0.3 * (1 - Math.abs(y) / M.bodyHeight);
        bodyColor.setXYZ(
          index,
          lerp(bodyColor.getX(index), flankColor.r, amount),
          lerp(bodyColor.getY(index), flankColor.g, amount),
          lerp(bodyColor.getZ(index), flankColor.b, amount),
        );
      }
      if (z > bodyLength * 0.3) {
        const amount = clamp01((z - bodyLength * 0.3) / (bodyLength * 0.24)) * 0.55;
        bodyColor.setXYZ(
          index,
          lerp(bodyColor.getX(index), rumpColor.r, amount),
          lerp(bodyColor.getY(index), rumpColor.g, amount),
          lerp(bodyColor.getZ(index), rumpColor.b, amount),
        );
      }
    }
    bodyColor.needsUpdate = true;
    occlude(body, { from: -M.bodyHeight, to: M.bodyHeight, strength: 0.3 });
    body.translate(0, 0.01, -bodyLength * 0.04);
    add('feather', 'Body', body);

    /* Breast scales: rows of small, overlapping feather tips that follow the
     * curve of the breast, because they are placed on its actual surface. */
    const bodyCenter = [0, 0.01, -bodyLength * 0.04];
    // The plumage is placed on the *same* ellipsoid the body was built from,
    // or the feathers float beside the bird instead of lying on it.
    const bodyRadii = [M.bodyWidth * 0.5, M.bodyHeight * 0.5, bodyLength * 0.51];
    const scaleRows = 5;
    for (let row = 0; row < scaleRows; row += 1) {
      const v = 0.08 + row * 0.2;
      const columns = 9 - row;
      for (let column = 0; column < columns; column += 1) {
        const u = columns === 1 ? 0 : (column / (columns - 1) - 0.5) * 2;
        const surface = ellipsoidSurface({
          center: bodyCenter,
          radii: bodyRadii,
          u,
          v,
          wrap: 0.95 + row * 0.06,
          vRange: [0.5, -0.85],
        });
        const scale = featherScaleGeometry(M.bodyWidth * 0.34, M.bodyHeight * 0.34, { bend: 0.4 });
        paint(scale, row === 0 ? P.breast : P.belly, { tipColor: row === 0 ? P.breastWarm : P.belly });
        layOnSurface(scale, {
          at: surface.position,
          normal: surface.normal,
          up: [0, 1, 0],
          roll: u * 0.18,
        });
        add('feather', 'Body', scale);
      }
    }
    /* Mantle and back coverts: the shingle over the shoulders and down the
     * spine, which is what the eye sees from above and behind. */
    for (let row = 0; row < 4; row += 1) {
      const v = 0.34 + row * 0.16;
      const columns = 9 - row;
      for (let column = 0; column < columns; column += 1) {
        const u = (column / (columns - 1) - 0.5) * 2.0;
        // The back is the *far* side of the body: wrap past a quarter turn so
        // the row runs over the top of the bird.
        const surface = ellipsoidSurface({
          center: bodyCenter,
          radii: bodyRadii,
          u,
          v,
          wrap: 2.35 + row * 0.08,
          vRange: [0.75, -0.6],
        });
        const scale = featherScaleGeometry(M.bodyWidth * 0.38, M.bodyHeight * 0.42, { bend: 0.3 });
        paint(scale, row < 2 ? P.back : P.backDark, { tipColor: row < 2 ? P.backDark : P.rump ?? P.back });
        layOnSurface(scale, {
          at: surface.position,
          normal: surface.normal,
          up: [0, 0, 1],
          roll: u * 0.15,
        });
        add('feather', 'Body', scale);
      }
    }

    // Flank feathers: the same shingle along the sides, where the wing folds.
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const side = column === 0 ? -1 : 1;
        const u = side * (0.82 + column * 0.08);
        const v = 0.32 + row * 0.24;
        const surface = ellipsoidSurface({ center: bodyCenter, radii: bodyRadii, u, v, wrap: 1.02, vRange: [0.5, -0.85] });
        const scale = featherScaleGeometry(M.bodyWidth * 0.36, M.bodyHeight * 0.36, { bend: 0.3 });
        paint(scale, P.flank ?? P.belly, { tipColor: P.belly });
        layOnSurface(scale, { at: surface.position, normal: surface.normal, roll: side * 0.1 });
        add('feather', 'Body', scale);
      }
    }
    // A dark bib where the head colour runs into the breast: the chaffinch's
    // grey-blue wraps down the sides of the neck, the tit's black cap runs into
    // the black throat patch that gives the species its name.
    for (let row = 0; row < 2; row += 1) {
      const v = -0.02 + row * 0.16;
      const columns = 5 - row;
      for (let column = 0; column < columns; column += 1) {
        const u = (column / (columns - 1) - 0.5) * 1.1;
        const surface = ellipsoidSurface({ center: bodyCenter, radii: bodyRadii, u, v, wrap: 1.0, vRange: [0.5, -0.85] });
        const scale = featherScaleGeometry(M.bodyWidth * 0.4, M.bodyHeight * 0.4, { bend: 0.35 });
        paint(scale, P.crown, { tipColor: isTit ? P.crown : P.nape });
        layOnSurface(scale, { at: surface.position, normal: surface.normal, roll: u * 0.2 });
        add('feather', 'Body', scale);
      }
    }

    /* ---- neck ---------------------------------------------------------- */
    const neckStart = new THREE.Vector3(0, M.bodyHeight * 0.22, -M.bodyLength * 0.2);
    const neckEnd = new THREE.Vector3(0, M.bodyHeight * 0.5 + M.neck * 0.42, -M.bodyLength * 0.42 - M.neck * 0.6);
    const neckDirection = new THREE.Vector3().subVectors(neckEnd, neckStart);
    const neck = new THREE.CylinderGeometry(M.head * 0.36, M.head * 0.52, neckDirection.length() * 0.95, 12, 1);
    paint(neck, P.nape, { tipColor: P.breast, tipAxis: 'y', from: M.head * 0.5, to: -M.head * 0.9 });
    // Aim the tube down the line from the shoulders to the skull: rotating +Y
    // onto a direction in the YZ plane is one rotation about X.
    neck.rotateX(Math.atan2(neckDirection.z, neckDirection.y));
    neck.translate(0, (neckStart.y + neckEnd.y) * 0.5, (neckStart.z + neckEnd.z) * 0.5);
    add('feather', 'Chest', neck);

    /* ---- head ---------------------------------------------------------- */
    const head = bodyGeometry(0.5, {
      width: M.head * 0.94,
      height: M.head,
      length: M.head * 1.14,
      seed: 0x2c11 + this.seed,
      clump: 0.022,
    });
    paint(head, P.crown, { tipColor: P.belly, tipAxis: 'y', from: M.head * 0.42, to: -M.head * 0.5 });
    const headPosition = head.attributes.position;
    const headColor = head.attributes.color;
    const patch = new THREE.Color();
    const cheekColor = new THREE.Color(P.cheek ?? P.belly);
    const moustacheColor = P.moustache ? new THREE.Color(P.moustache) : null;
    for (let index = 0; index < headPosition.count; index += 1) {
      const x = headPosition.getX(index);
      const y = headPosition.getY(index);
      const z = headPosition.getZ(index);
      let target = null;
      if (isTit && Math.abs(x) > M.head * 0.17 && z < M.head * 0.3 && y < M.head * 0.24) {
        target = cheekColor; // white cheek patches
      } else if (isJay && Math.abs(x) > M.head * 0.2 && z < M.head * 0.14 && y < M.head * 0.2) {
        target = cheekColor; // pale face with the dark moustache stripe beneath
      } else if (z > M.head * 0.3) {
        target = new THREE.Color(P.nape); // the nape rolls into the shoulders
      }
      if (!target) continue;
      headColor.setXYZ(index, target.r, target.g, target.b);
    }
    if (moustacheColor) {
      for (let index = 0; index < headPosition.count; index += 1) {
        const x = headPosition.getX(index);
        const y = headPosition.getY(index);
        const z = headPosition.getZ(index);
        if (Math.abs(x) < M.head * 0.3 || y > -M.head * 0.02 || z > -M.head * 0.1) continue;
        headColor.setXYZ(index, moustacheColor.r, moustacheColor.g, moustacheColor.b);
      }
    }
    headColor.needsUpdate = true;
    occlude(head, { from: -M.head, to: M.head, strength: 0.24 });
    place(head, { at: [0, 0, -M.head * 0.08] });
    add('feather', 'Head', head);

    /* Crown coverts: the shingled cap, laid on the skull's own surface. */
    const headCenter = [0, 0, -M.head * 0.08];
    const headRadii = [M.head * 0.47, M.head * 0.5, M.head * 0.57];
    for (let row = 0; row < 4; row += 1) {
      const v = -0.55 + row * 0.34;
      const columns = 7 - row;
      for (let column = 0; column < columns; column += 1) {
        const u = (column / (columns - 1) - 0.5) * 1.5;
        const surface = ellipsoidSurface({
          center: headCenter,
          radii: headRadii,
          u,
          v,
          wrap: 1.05,
          vRange: [0.95, -0.6],
        });
        const scale = featherScaleGeometry(M.head * 0.3, M.head * 0.28, { bend: 0.4 });
        paint(scale, P.crown, { tipColor: isTit || isJay ? P.crown : P.nape });
        layOnSurface(scale, { at: surface.position, normal: surface.normal, roll: u * 0.2 });
        add('feather', 'Head', scale);
      }
    }

    /* Crest: a fan of raised crown feathers, lifted in alarm. */
    if (M.crest > 0) {
      for (let i = 0; i < 5; i += 1) {
        const offset = (i / 4 - 0.5) * 2;
        const crest = featherGeometry({
          length: M.crest * (1 - Math.abs(offset) * 0.22),
          width: M.head * 0.34,
          camber: 0.22,
          droop: 0.06,
          baseColor: P.crown,
          tipColor: P.belly,
        });
        orient(crest, { pitch: 1.05 - Math.abs(offset) * 0.12, sweep: 0.1 });
        // The fan's base has to sit *inside* the skull: the crown of the head
        // is about `head * 0.9` above the head bone, and a crest rooted any
        // higher than that floats over the bird like a hat.
        crest.translate(offset * M.head * 0.22, M.head * 0.12, M.head * 0.06 + Math.abs(offset) * 0.02);
        add('feather', 'Crest', crest);
      }
    }

    /* ---- beak ---------------------------------------------------------- */
    const beakUpper = new THREE.ConeGeometry(M.beakDepth * 0.62, M.beak, 9, 2, false);
    paint(beakUpper, P.beak, { tipColor: P.beakDark, tipAxis: 'y', from: M.beak * 0.1, to: -M.beak * 0.5 });
    beakUpper.rotateX(-Math.PI * 0.5);
    beakUpper.scale(1.06, 0.72, 1);
    beakUpper.translate(0, M.head * 0.02, -M.beak * 0.5 - M.head * 0.34);
    add('keratin', 'Head', beakUpper);
    // The gape line: a thin dark wedge where the mandibles meet, which is what
    // makes a closed beak read as closed.
    const gape = featherScaleGeometry(M.head * 0.36, M.beak * 0.9, { bend: 0.05 });
    paint(gape, P.beakDark);
    gape.rotateX(Math.PI * 0.5);
    gape.rotateZ(Math.PI * 0.5);
    gape.translate(0, -M.head * 0.03, -M.head * 0.34 - M.beak * 0.5);
    add('keratin', 'Head', gape);

    const beakLower = new THREE.ConeGeometry(M.beakDepth * 0.5, M.beak * 0.84, 9, 1, false);
    paint(beakLower, P.beakDark, { tipColor: P.beak, tipAxis: 'y', from: -M.beak * 0.1, to: -M.beak * 0.42 });
    beakLower.rotateX(-Math.PI * 0.5);
    beakLower.scale(1, 0.6, 1);
    beakLower.translate(0, -M.head * 0.08, -M.beak * 0.44 - M.head * 0.34);
    add('keratin', 'BeakLower', beakLower);

    /* ---- tail ---------------------------------------------------------- */
    // Authored on the right, mirrored to the left: one half of the fan.
    const tailParts = [];
    const addTail = (boneName, geometry) => tailParts.push({ bone: boneName, geometry });
    const half = Math.ceil(M.tailCount / 2);
    for (let i = 0; i < half; i += 1) {
      const t = half === 1 ? 0 : i / (half - 1);
      const length = M.tail * (1.02 - 0.14 * t);
      const feather = featherGeometry({
        length,
        width: M.tailWidth * 0.36,
        profile: [
          [0.0, 0.42], [0.18, 0.76], [0.5, 1.0], [0.8, 0.96], [0.93, 0.78], [1.0, 0.44],
        ],
        camber: 0.05,
        droop: 0.05,
        baseColor: P.tail,
        tipColor: P.tailEdge,
        edgeColor: P.tail,
        shaftColor: P.shaft,
        tipStart: 0.68,
      });
      // A tail fan is a horizontal wedge: sweep it back, then splay it by
      // *un*sweeping the outer feathers and tipping them up slightly.
      orient(feather, {
        twist: -t * 0.12,
        pitch: 0.06 + t * 0.16,
        sweep: Math.PI * 0.5 - (0.1 + t * 0.52),
      });
      feather.translate(
        0.012 + t * M.tailWidth * 0.3,
        -0.006 * i - t * 0.008,
        M.tailWidth * 0.2 * (0.6 + t),
      );
      addTail('TailRight', feather);
    }
    // Upper tail coverts hide the roots of the fan.
    const tailCovert = featherScaleGeometry(M.tailWidth * 1.1, M.tail * 0.24, { bend: 0.15 });
    paint(tailCovert, P.rump ?? P.tail, { tipColor: P.tail });
    tailCovert.rotateX(Math.PI * 0.5 + 0.12);
    tailCovert.translate(0, M.tailWidth * 0.07, M.tail * 0.02);
    addTail('Tail', tailCovert);
    const tailUnder = featherScaleGeometry(M.tailWidth * 0.9, M.tail * 0.2, { bend: 0.1 });
    paint(tailUnder, P.belly ?? P.flank, { tipColor: P.tail });
    tailUnder.rotateX(Math.PI * 0.5 + 0.1);
    tailUnder.translate(0, -M.tailWidth * 0.06, M.tail * 0.012);
    addTail('Tail', tailUnder);
    for (const entry of tailParts) {
      add('feather', entry.bone, entry.geometry);
      add('feather', entry.bone === 'Tail' ? 'Tail' : 'TailLeft', mirrorX(entry.geometry.clone()));
    }

    /* ---- the two sides ------------------------------------------------- */
    const sideParts = [];
    const addSide = (key, boneName, geometry, { morph = null, birdSpace = false } = {}) => sideParts.push({
      key,
      bone: boneName,
      geometry,
      morph,
      birdSpace,
    });
    this.buildWingSide(addSide, { isJay, isTit });
    this.buildLegSide(addSide);
    this.buildEyeSide(addSide, { isJay });

    for (const entry of sideParts) {
      // Mirror the geometry *and* the bone it is bound to: a part authored for
      // the right wing becomes the left one when it is flipped, morph included.
      const boneName = entry.bone;
      const mirroredBone = typeof boneName === 'function'
        ? (index) => boneName(index).replace('.R', '.L')
        : boneName.replace('.R', '.L');
      const mirrored = mirrorX(entry.geometry.clone());
      const options = { birdSpace: entry.birdSpace };
      options.morph = entry.morph ? mirrorX(entry.morph.clone()) : null;
      add(entry.key, mirroredBone, mirrored, options);
      add(entry.key, boneName, entry.geometry, { morph: entry.morph, birdSpace: entry.birdSpace });
    }

    return parts;
  }

  /**
   * The right wing.
   *
   * One continuous feathered surface — a curved leading edge, a notched
   * trailing edge and a chord that swells from the shoulder and tapers to a
   * point — built along the wing bones from the rig's own rest pose. Its
   * colours run the length of the wing: coverts near the leading edge, barred
   * secondaries in the middle of the inner wing, the jay's blue panel, and pale
   * tips on the primaries.
   *
   * A single surface folds and beats better than a bundle of blades: the
   * stations at the shoulder ride the humerus, those past the elbow the
   * forearm, and those past the wrist the hand, so the wing bends exactly where
   * a wing bends.
   */
  buildWingSide(addSide) {
    const { palette: P, morph: M } = this;
    const shoulder = new THREE.Vector3().setFromMatrixPosition(this.wing.R.matrixWorld);
    const elbow = new THREE.Vector3().setFromMatrixPosition(this.forearm.R.matrixWorld);
    const wrist = new THREE.Vector3().setFromMatrixPosition(this.hand.R.matrixWorld);
    const tip = wrist.clone().add(new THREE.Vector3(M.hand, 0, 0));
    const isJay = this.species.id === 'jay';
    const span = M.humerus + M.forearm + M.hand;
    // The chord at its widest: a songbird's wing is about a quarter as wide as
    // it is long.
    const chords = span * (isJay ? 0.3 : 0.27);

    /* Where each bone runs out along the wing, as a fraction of the whole
     * surface. Everything downstream — the station path, the chord profile,
     * which bone carries which vertex — is expressed in this same parameter, so
     * the wing can never bend at a joint that is not where the bones are.
     *
     * The surface starts *inside* the body, not at the shoulder: a wing that
     * begins at the joint shows a seam against the ribs, and the feathers of a
     * real bird's shoulder slide under the plumage of its back. */
    const rootInset = M.bodyWidth * 0.5;
    const root = shoulder.clone().sub(new THREE.Vector3(rootInset, 0, 0));
    const boneLengths = [rootInset + M.humerus, M.forearm, M.hand];
    const spanTotal = boneLengths[0] + boneLengths[1] + boneLengths[2];
    const wristAt = boneLengths[0] / spanTotal;
    const handAt = (boneLengths[0] + boneLengths[1]) / spanTotal;

    /* The planform: how wide the wing is at each point along it. A finch's wing
     * is broad and rounded — it swells out of the shoulder, is widest around
     * the wrist, and is still nearly half as wide at the tip, where the
     * primaries fan out. */
    const planform = [
      [0, 0.5], [0.1, 0.78], [0.22, 0.94], [0.38, 1], [0.55, 0.98],
      [0.7, 0.9], [0.85, 0.76], [0.94, 0.62], [1, 0.5],
    ];
    const chordAt = (t) => {
      for (let index = 1; index < planform.length; index += 1) {
        const [stop, value] = planform[index];
        if (t > stop) continue;
        const [from, previous] = planform[index - 1];
        const amount = (t - from) / Math.max(1e-6, stop - from);
        return chords * (previous + (value - previous) * amount);
      }
      return chords * planform[planform.length - 1][1];
    };

    const covertColor = new THREE.Color(P.wingCovert);
    const covertTip = new THREE.Color(P.wingCovertTip);
    const edgeColor = new THREE.Color(P.wingEdge);
    const barColor = new THREE.Color(isJay ? P.blue : P.wingCovertTip);
    const blueBar = new THREE.Color(isJay ? P.blueBar : P.wingCovertTip);
    const innerColor = new THREE.Color(P.secondary ?? P.primary);
    const primaryColor = new THREE.Color(P.primary);
    const primaryTip = new THREE.Color(P.primaryEdge);
    const mantle = new THREE.Color(P.back);

    /* The two shapes of the same wing. Extended, the wing runs out along the
     * bones with its leading edge forward. Folded, it runs back along the
     * flank: the elbow swings down and back, the forearm follows the ribs, and
     * the hand lays the primaries over the rump — the way the wing sits when
     * the bird is not using it. */
    const stationCount = 21;
    const extendedPath = (t) => {
      if (t <= wristAt) return root.clone().lerp(elbow, t / wristAt);
      if (t <= handAt) return elbow.clone().lerp(wrist, (t - wristAt) / (handAt - wristAt));
      return wrist.clone().lerp(tip, (t - handAt) / (1 - handAt));
    };

    const foldedRoot = shoulder.clone().sub(new THREE.Vector3(M.bodyWidth * 0.34, 0, 0));
    const foldedElbow = shoulder.clone().add(new THREE.Vector3(
      M.humerus * 0.1, -M.humerus * 0.3, M.humerus * 0.95,
    ));
    const foldedWrist = foldedElbow.clone().add(new THREE.Vector3(
      -M.forearm * 0.07, M.forearm * 0.02, M.forearm * 0.99,
    ));
    const foldedTip = foldedWrist.clone().add(new THREE.Vector3(
      -M.hand * 0.05, M.hand * 0.04, M.hand * 0.99,
    ));
    const foldedPath = (t) => {
      if (t <= wristAt) return foldedRoot.clone().lerp(foldedElbow, t / wristAt);
      if (t <= handAt) return foldedElbow.clone().lerp(foldedWrist, (t - wristAt) / (handAt - wristAt));
      return foldedWrist.clone().lerp(foldedTip, (t - handAt) / (1 - handAt));
    };

    const extendedChord = new THREE.Vector3(0, 0, 1);
    // Folded, the feathers hang down the flank rather than out sideways, and
    // the blade twists so its outer face looks outwards.
    const foldedChord = new THREE.Vector3(-0.24, -0.96, 0.12).normalize();
    // The fingers of the outer wing: every other station steps back, deepest
    // at the tip, which is where the primaries separate on a real bird.
    const fingers = (index, t) => {
      if (t < 0.6) return 0;
      const depth = 0.42 * clamp01((t - 0.6) / 0.4);
      return index % 2 === 1 ? depth : depth * 0.12;
    };

    const extendedStations = [];
    const foldedStations = [];
    for (let index = 0; index < stationCount; index += 1) {
      const t = index / (stationCount - 1);
      const chord = chordAt(t);
      // A wing droops slightly towards the tip and sweeps back a little: the
      // leading edge is the straightest line on a bird, but it is not straight.
      const droop = -Math.pow(t, 2.2) * span * 0.05;
      const sweep = Math.pow(t, 2.6) * span * 0.05;
      const extended = extendedPath(t);
      extendedStations.push({
        point: new THREE.Vector3(
          extended.x,
          extended.y + droop,
          extended.z + sweep - M.bodyWidth * 0.16,
        ),
        chordDirection: extendedChord,
        chord,
        thickness: M.bodyWidth * 0.2,
      });
      const folded = foldedPath(t);
      foldedStations.push({
        point: new THREE.Vector3(
          folded.x,
          folded.y + Math.pow(t, 1.6) * span * 0.012,
          folded.z - M.bodyWidth * (0.16 - t * 0.1),
        ),
        chordDirection: foldedChord,
        chord: chord * 0.6,
        thickness: M.bodyWidth * 0.2,
      });
    }

    // The two places the wing tip can be, in the bird's own space: the rig
    // lerps between them the same way the geometry does, so anything that needs
    // to know where the tip is (the contact shadow, a test) gets the truth.
    this.wingTipLocal = {
      extended: extendedStations[stationCount - 1].point.clone(),
      folded: foldedStations[stationCount - 1].point.clone(),
    };

    const colorAt = (target, { t, u }) => {
      if (u < 0.06) {
        // Leading edge: closed coverts at the shoulder, shading into the dark
        // leading edge of the outer wing.
        target.copy(mantle).lerp(covertColor, Math.min(1, t * 2.2));
        target.lerp(edgeColor, Math.max(0, t - 0.55) * 1.6);
        return;
      }
      if (u < 0.42) {
        // The coverts: the lightest part of a songbird's wing. The barred row
        // crossing them is the wing bar the eye reads from the ground.
        target.copy(covertColor).lerp(covertTip, 0.28).lerp(innerColor, Math.min(1, t * 1.2));
        const bar = Math.exp(-Math.pow((t - 0.34) / 0.075, 2))
          + (isJay ? Math.exp(-Math.pow((t - 0.56) / 0.08, 2)) : 0);
        target.lerp(barColor, Math.min(0.9, bar));
        if (isJay && t > 0.24 && t < 0.46) target.lerp(blueBar, 0.3);
        return;
      }
      if (u < 0.62) {
        // The camber of the wing: secondaries and the roots of the primaries.
        target.copy(covertTip).lerp(innerColor, Math.min(1, t * 1.5));
        return;
      }
      // The flight feathers themselves, the pale tips of the primaries last.
      target.copy(innerColor).lerp(primaryColor, Math.min(1, t * 1.5));
      target.lerp(primaryTip, Math.max(0, t - 0.6) * 1.8);
      target.lerp(edgeColor, Math.max(0, 0.35 - t) * 0.6);
    };

    const geometry = wingRibbonGeometry({ stations: extendedStations, colorAt, notchAt: fingers });
    const foldedGeometry = wingRibbonGeometry({ stations: foldedStations, colorAt });

    // The surface spans three bones, so each vertex names its own: the
    // shoulder's stations ride the humerus, the next the forearm, the last the
    // hand. That is what makes the wing fold at its joints and nowhere else.
    const boneForVertex = (index) => {
      const t = Math.floor(index / WING_SECTION.length) / (stationCount - 1);
      if (t <= wristAt) return 'Wing.R';
      if (t <= handAt) return 'Forearm.R';
      return 'Hand.R';
    };
    addSide('feather', boneForVertex, geometry, { morph: foldedGeometry, birdSpace: true });
  }

  /** The right leg: feathered thigh, scaled tarsus, three toes and a hallux. */
  buildLegSide(addSide) {
    const { palette: P, morph: M } = this;
    const thigh = bodyGeometry(0.5, {
      width: M.bodyWidth * 0.34,
      height: M.leg * 0.34,
      length: M.leg * 0.4,
      seed: 0x51de + this.seed,
      clump: 0.02,
    });
    paint(thigh, P.belly ?? P.flank, { tipColor: P.flank });
    thigh.translate(0, -M.leg * 0.2, -M.leg * 0.03);
    addSide('feather', 'Leg.R', thigh);
    const thighFeather = featherScaleGeometry(M.bodyWidth * 0.34, M.leg * 0.34, { bend: 0.3 });
    paint(thighFeather, P.flank ?? P.belly, { tipColor: P.belly ?? P.flank });
    thighFeather.rotateX(0.25);
    thighFeather.translate(M.bodyWidth * 0.05, -M.leg * 0.1, -M.bodyWidth * 0.16);
    addSide('feather', 'Leg.R', thighFeather);

    const tarsus = new THREE.CylinderGeometry(M.leg * 0.056, M.leg * 0.066, M.leg * 0.62, 8, 1);
    paint(tarsus, P.leg);
    tarsus.translate(0, -M.leg * 0.3, 0);
    addSide('keratin', 'Shank.R', tarsus);
    const hock = new THREE.SphereGeometry(M.leg * 0.072, 8, 6);
    paint(hock, P.leg);
    addSide('keratin', 'Leg.R', hock);
    const ankle = new THREE.SphereGeometry(M.leg * 0.06, 8, 6);
    paint(ankle, P.leg);
    ankle.translate(0, -M.leg * 0.58, 0);
    addSide('keratin', 'Shank.R', ankle);

    // Three forward toes, splayed, each with a claw: the grip that lets a bird
    // hold a pine trunk or a twig.
    for (let toe = 0; toe < 3; toe += 1) {
      const spread = (toe - 1) * 0.5;
      const length = M.toe * (toe === 1 ? 1.2 : 0.92);
      const digit = new THREE.CylinderGeometry(M.leg * 0.032, M.leg * 0.024, length, 6, 1);
      paint(digit, P.leg, { tipColor: P.beakDark, tipAxis: 'y', from: -length * 0.5, to: length * 0.5 });
      digit.rotateX(Math.PI * 0.5);
      digit.rotateY(spread);
      digit.translate(0, -M.leg * 0.008, length * 0.5 * Math.cos(spread) + 0.004);
      addSide('keratin', 'ToesFront.R', digit);

      const claw = new THREE.ConeGeometry(M.leg * 0.028, M.leg * 0.1, 6, 1);
      paint(claw, P.beakDark);
      claw.rotateX(Math.PI * 0.5);
      claw.rotateY(spread);
      claw.translate(
        Math.sin(spread) * -length * 0.5,
        -M.leg * 0.012,
        length * Math.cos(spread) + M.leg * 0.03,
      );
      addSide('keratin', 'ToesFront.R', claw);
    }
    // The hallux grips from behind.
    const hallux = new THREE.CylinderGeometry(M.leg * 0.03, M.leg * 0.022, M.toe * 0.86, 6, 1);
    paint(hallux, P.leg, { tipColor: P.beakDark, tipAxis: 'y', from: -M.toe * 0.43, to: M.toe * 0.1 });
    hallux.rotateX(-Math.PI * 0.5);
    hallux.rotateY(-0.12);
    hallux.translate(0, -M.leg * 0.008, -M.toe * 0.43);
    addSide('keratin', 'ToesBack.R', hallux);
    const halluxClaw = new THREE.ConeGeometry(M.leg * 0.026, M.leg * 0.09, 6, 1);
    paint(halluxClaw, P.beakDark);
    halluxClaw.rotateX(-Math.PI * 0.5);
    halluxClaw.translate(0, -M.leg * 0.012, -M.toe * 0.9);
    addSide('keratin', 'ToesBack.R', halluxClaw);
  }

  /** The right eye: a glossy globe, a catch-light and a ring of dark feathers. */
  buildEyeSide(addSide, { isJay = false } = {}) {
    const { palette: P, morph: M } = this;
    const eyeX = M.head * 0.36;
    const eyeY = M.head * 0.14;
    const eyeZ = -M.head * 0.3;
    const eye = new THREE.SphereGeometry(M.head * 0.13, 12, 9);
    paint(eye, P.eye);
    eye.translate(eyeX, eyeY, eyeZ);
    addSide('keratin', 'Head', eye);

    const highlight = new THREE.SphereGeometry(M.head * 0.04, 8, 6);
    paint(highlight, 0xffffff);
    highlight.translate(eyeX + M.head * 0.04, eyeY + M.head * 0.07, eyeZ - M.head * 0.06);
    addSide('keratin', 'Head', highlight);

    const ring = new THREE.TorusGeometry(M.head * 0.17, M.head * 0.028, 6, 14);
    paint(ring, P.eyeRing);
    ring.rotateY(Math.PI * 0.5);
    ring.rotateZ(-0.25);
    ring.translate(eyeX - M.head * 0.02, eyeY, eyeZ);
    addSide('feather', 'Head', ring);

    // A pale brow over the eye and a dark eye-stripe: the two markings that
    // give a small bird its expression.
    const brow = featherScaleGeometry(M.head * 0.3, M.head * 0.5, { bend: 0.1 });
    paint(brow, P.belly ?? P.cheek, { tipColor: P.crown });
    place(brow, {
      at: [eyeX - M.head * 0.06, eyeY + M.head * 0.24, eyeZ - M.head * 0.06],
      rot: [-1.5, -0.5, 0.4],
    });
    addSide('feather', 'Head', brow);

    if (isJay || P.moustache) {
      const stripe = featherScaleGeometry(M.head * 0.18, M.head * 0.72, { bend: 0.08 });
      paint(stripe, P.moustache ?? P.crown);
      place(stripe, {
        at: [eyeX + M.head * 0.08, eyeY - M.head * 0.16, eyeZ - M.head * 0.04],
        rot: [-1.35, -0.55, 0.15],
      });
      addSide('feather', 'Head', stripe);
    }

    // Ear patch: a small dark tuft behind the eye where the skull meets the
    // neck, which is what stops a bird's head looking like a ball.
    const ear = featherScaleGeometry(M.head * 0.22, M.head * 0.34, { bend: 0.2 });
    paint(ear, P.nape ?? P.crown, { tipColor: P.crown });
    place(ear, {
      at: [eyeX * 0.94, eyeY - M.head * 0.08, eyeZ + M.head * 0.42],
      rot: [-1.1, -1.5, 0.1],
    });
    addSide('feather', 'Head', ear);
  }
  /* ---- posing --------------------------------------------------------- */

  /**
   * Solve one wing.
   *
   * A wing is not aimed by stacking Euler angles — it is aimed by *pointing*
   * its three segments somewhere. Each segment is given a direction to run in
   * (`aim`) and the way its blade should face (`up`), both in the bird's own
   * frame; the method turns each into a target orientation and then solves the
   * local bone rotations down the chain, shoulder to hand. The left wing is the
   * mirror image of the right, so it is described by the same vectors with `x`
   * negated.
   *
   * This is what makes the flap tunable by eye: `aim` for the humerus leads the
   * cycle, the forearm follows a moment later and the hand last, and the wing
   * whips because it is a chain of three directions rather than one hinge.
   */
  poseWing(side, chain) {
    const mirror = side === 'L';
    const target = this.targetQuaternions;
    const matrix = this.scratchMatrix;
    const aim = this.scratchVectorA;
    const up = this.scratchVectorB;
    const across = this.scratchVectorC;

    for (const segment of ['shoulder', 'forearm', 'hand']) {
      const source = chain[segment];
      aim.set(source.aim[0], source.aim[1], source.aim[2]).normalize();
      up.set(source.up[0], source.up[1], source.up[2]);
      // Square the blade's facing up against the direction it runs in.
      up.addScaledVector(aim, -up.dot(aim));
      if (up.lengthSq() < 1e-6) up.set(0, 1, 0).addScaledVector(aim, -aim.y);
      up.normalize();
      across.crossVectors(aim, up);
      matrix.makeBasis(aim, up, across);
      // The left wing is the mirror image of the right: `S·M·S`, applied to
      // the matrix that is actually read — mirroring into a scratch matrix and
      // then reading the original is exactly the bug this line used to have.
      if (mirror) {
        target[segment].setFromRotationMatrix(mirrorMatrix(matrix, this.scratchMatrixB));
      } else {
        target[segment].setFromRotationMatrix(matrix);
      }
    }

    // Local rotations: each bone only carries the difference between its own
    // target orientation and its parent's. `S·M·S` commutes with that product,
    // so the left wing ends up as the exact mirror of the right.
    const parent = this.scratchQuaternion
      .copy(this.body.quaternion)
      .multiply(this.chest.quaternion);
    const shoulder = this.scratchQuaternionB.copy(parent).invert().multiply(target.shoulder);
    const forearm = this.scratchQuaternionC.copy(target.shoulder).invert().multiply(target.forearm);
    const hand = this.scratchQuaternionD.copy(target.forearm).invert().multiply(target.hand);
    this.wing[side].quaternion.copy(shoulder);
    this.forearm[side].quaternion.copy(forearm);
    this.hand[side].quaternion.copy(hand);
  }

  /**
   * How folded the wings are: 1 is a wing closed against the flank, 0 is a
   * wing held out. It drives the geometry's morph target, which is the shape
   * change a real wing makes — the surface wraps around the body — while the
   * bones carry the flap on top of it.
   */
  setWingFold(amount) {
    this.wingFold = clamp01(amount);
    for (const mesh of this.meshes) {
      if (!mesh.morphTargetInfluences?.length) continue;
      mesh.morphTargetInfluences[0] = this.wingFold;
    }
    return this.wingFold;
  }

  resetPose() {
    for (const node of this.bones) {
      node.quaternion.identity();
      node.rotation.set(0, 0, 0);
    }
  }

  /**
   * The contact point of the folded wing — the wing tip — measured in the
   * bird's own space. Tests use it to prove that a wing folds along the flank
   * instead of sticking out sideways, and that a real flap beats an arc.
   */
  /**
   * Carry a point modelled in the bird's own (rest) space through the current
   * pose of the bone that owns it, the way the skinning shader would.
   */
  sampleBonePoint(boneName, point, target) {
    const bone = this.boneIndex.has(boneName) ? this.bones[this.boneIndex.get(boneName)] : null;
    if (!bone) return target.copy(point);
    target
      .copy(point)
      .applyMatrix4(this.scratchMatrixB.multiplyMatrices(bone.matrixWorld, this.restInverse.get(boneName)));
    return this.root.worldToLocal(target);
  }

  sampleWingTip(side, target) {
    const sign = this.wingSign[side];
    const fold = this.wingFold ?? 1;
    // The tip of a folded wing is drawn back over the rump, and the wing tip is
    // where the *feathers* end: the last station of the surface, with the
    // fold's own shape change taken into account.
    const extended = this.wingTipLocal?.extended ?? new THREE.Vector3(this.morph.hand, 0, 0);
    const folded = this.wingTipLocal?.folded ?? extended;
    const point = this.scratchVectorC.copy(extended).lerp(folded, fold);
    point.x *= sign > 0 ? 1 : -1;
    return this.sampleBonePoint(`Hand.${side}`, point, target);
  }

  /**
   * Apply a pose. Every field is optional: an empty pose stands the bird with
   * its wings folded, which is the pose a perched bird should have by default.
   *
   * Attitude   bodyPitch, bodyRoll, bodyYaw, bodyBob, bodySquash
   * Head       neckPitch/Yaw/Roll, headPitch/Yaw/Roll, beakOpen, crestRaise
   * Tail       tailPitch/Yaw/Roll, tailFan (or tailSpread), tailLeft, tailRight
   * Wings      wingSpread (0 folded … 1 extended), flapPhase, flapAmplitude,
   *            glideBlend, plus additive trims: wingSweep, wingLift,
   *            wingTwist, wingPitchShoulder/Forearm/Hand,
   *            wingTwistForearm/Hand, wingLeft/wingRight (asymmetry)
   * Legs       legTuck, legReach, legKick (+legKickSide), footGrip, toeCurl,
   *            footPitch, legSplay
   */
  applyPose(pose = {}) {
    const p = pose;
    const spread = clamp01(p.wingSpread ?? 0);
    const glide = clamp01(p.glideBlend ?? 0);
    const amplitude = p.flapAmplitude ?? 1;
    const flap = p.flapPhase ?? 0;

    /* --- attitude --- */
    this.body.rotation.set(p.bodyPitch ?? 0, p.bodyYaw ?? 0, p.bodyRoll ?? 0);
    this.body.position.set(0, p.bodyBob ?? 0, 0);
    const squash = p.bodySquash ?? 0;
    this.body.scale.set(1 + squash * 0.5, 1 - squash * 0.5, 1 - squash * 0.4);

    this.chest.rotation.set(p.chestPitch ?? 0, p.chestYaw ?? 0, 0);
    this.neck.rotation.set(p.neckPitch ?? 0, p.neckYaw ?? 0, p.neckRoll ?? 0);
    this.head.rotation.set(p.headPitch ?? 0, p.headYaw ?? 0, p.headRoll ?? 0);
    this.beakLower.rotation.set((p.beakOpen ?? 0) * 0.6, 0, 0);
    const crest = p.crestRaise ?? 0;
    this.crest.rotation.set(-crest * 0.9, (p.crestSway ?? 0) * 0.5, (p.crestSway ?? 0) * 0.2);

    /* --- tail --- */
    const fan = clamp01(p.tailSpread ?? p.tailFan ?? 0);
    this.tail.rotation.set(p.tailPitch ?? 0, p.tailYaw ?? 0, p.tailRoll ?? 0);
    this.tailLeft.rotation.set(
      (p.tailLeft ?? 0) * 0.5,
      -fan * 0.42 + (p.tailLeft ?? 0) * 0.3,
      -fan * 0.12,
    );
    this.tailRight.rotation.set(
      (p.tailRight ?? 0) * 0.5,
      fan * 0.42 + (p.tailRight ?? 0) * 0.3,
      fan * 0.12,
    );

    /* --- wings ---
     * Two configurations, blended: a wing held out for flight and a wing
     * folded along the flank. The blend is what makes a fold look like the
     * wing being drawn in, rather than swapped for a different one. */
    const pronation = -Math.max(0, Math.sin(flap + 0.4)) * 0.55
      + Math.max(0, -Math.sin(flap + 0.4)) * 0.7;
    // The whip: the humerus leads the cycle, the forearm follows three tenths
    // of a beat later and the hand trails a further half beat. Without the lag
    // a wing is a hinge with a plank on it.
    const lead = Math.sin(flap) * amplitude;
    const middle = Math.sin(flap - 0.5) * amplitude;
    const trailing = Math.sin(flap - 1.0) * amplitude;
    const tipLag = Math.max(0, -Math.sin(flap - 1.0)) * amplitude;

    // The elevation of each segment *is* the flap: the shoulder lifts to about
    // seventy degrees and drops to forty below the horizontal at full effort,
    // with the two outer segments trailing it around the cycle.
    const shoulderElevation = lead * 0.95 - 0.06;
    const forearmElevation = middle * 0.86 - 0.02;
    const handElevation = trailing * 0.76 - 0.02;
    // In flight each segment points somewhere in particular; folded, the whole
    // wing is at rest and the *shape* does the folding (the morph target built
    // with the geometry). So the bones blend from rest to this pose as the wing
    // opens, and the shape blends the other way at the same time.
    const flight = {
      shoulder: {
        aim: [0.94, Math.sin(shoulderElevation), 0.3 - Math.abs(lead) * 0.08 + glide * 0.02],
        up: [0.08, 1 - Math.abs(pronation) * 0.2, -Math.tan(pronation * 0.45)],
      },
      forearm: {
        aim: [0.94, Math.sin(forearmElevation), 0.34 + glide * 0.06],
        up: [0.12, 1 - Math.abs(pronation) * 0.2, -Math.tan(pronation * 0.36 + 0.16)],
      },
      hand: {
        aim: [0.9, Math.sin(handElevation), 0.4 + glide * 0.16 - tipLag * 0.1],
        up: [0.16 + glide * 0.08, 1 - Math.abs(pronation) * 0.2, -Math.tan(pronation * 0.26 + 0.34 + glide * 0.2)],
      },
    };
    const chain = {};
    for (const segment of ['shoulder', 'forearm', 'hand']) {
      const source = flight[segment];
      // Where a wing sits when nothing has been asked of it: straight out.
      const rest = { aim: [1, 0, 0], up: [0, 1, 0] };
      chain[segment] = {
        aim: [
          lerp(rest.aim[0], source.aim[0], spread),
          lerp(rest.aim[1], source.aim[1], spread),
          lerp(rest.aim[2], source.aim[2], spread),
        ],
        up: [
          lerp(rest.up[0], source.up[0], spread),
          lerp(rest.up[1], source.up[1], spread),
          lerp(rest.up[2], source.up[2], spread),
        ],
      };
    }
    if (p.wingPitch) {
      for (const segment of ['shoulder', 'forearm', 'hand']) chain[segment].aim[1] += p.wingPitch;
    }
    if (p.wingSweep) {
      for (const segment of ['shoulder', 'forearm', 'hand']) chain[segment].aim[2] += p.wingSweep;
    }
    if (p.wingTwist) {
      for (const segment of ['shoulder', 'forearm', 'hand']) chain[segment].up[2] += p.wingTwist * 0.4;
    }
    if (p.wingLeft || p.wingRight) {
      // One wing out and one wing in: preening, stretching, and the little
      // one-sided flick a perched bird does when it is settling.
      const held = p.wingLeft ? 'L' : 'R';
      for (const side of ['L', 'R']) {
        if (side === held) continue;
        chain.shoulder.aim[1] += 0.2;
        chain.forearm.aim[1] += 0.12;
      }
    }
    this.poseWing('R', chain);
    this.poseWing('L', chain);
    // The fold: a wing that is not held out is a different shape, not a
    // rotated one. `wingLift` opens it a little further for display.
    this.setWingFold(1 - clamp01(spread + (p.wingLift ?? 0) * 0.7));

    /* --- legs ---
     * Tucked under the tail in flight, reaching forward to land, folded to
     * grip a perch, and kicking when a bird hops. */
    const tuck = clamp01(p.legTuck ?? 0);
    const reach = clamp01(p.legReach ?? 0);
    const grip = clamp01(p.footGrip ?? 0);
    const kick = p.legKick ?? 0;
    for (const side of ['L', 'R']) {
      const sideSign = side === 'L' ? -1 : 1;
      this.leg[side].rotation.set(
        1.05 * tuck - 0.72 * reach + kick * 0.55 * (p.legKickSide === side ? 1 : -0.35),
        0,
        (p.legSplay ?? 0.1) * sideSign,
      );
      this.shank[side].rotation.set(-1.9 * tuck + 0.95 * reach - kick * 0.5 + grip * 0.25, 0, 0);
      this.foot[side].rotation.set(
        -0.2 * tuck + 0.3 * reach + grip * 0.24 + (p.footPitch ?? 0),
        0,
        0,
      );
      this.toesFront[side].rotation.set(-grip * 1.25 - 0.08 - (p.toeCurl ?? 0), 0, 0);
      this.toesBack[side].rotation.set(grip * 0.95 + 0.05, 0, 0);
    }

    this.root.updateMatrixWorld(true);
    return this;
  }

  /**
   * Where the beak and both wing tips are, in the bird's own space. Used by the
   * contact shadow and by the tests that hold the animation honest.
   */
  samplePoints({ beak = null, wingL = null, wingR = null } = {}) {
    const beakPoint = beak ?? new THREE.Vector3();
    this.sampleBonePoint('BeakLower', this.beakTipLocal, beakPoint);
    return {
      beak: beakPoint,
      wingL: this.sampleWingTip('L', wingL ?? new THREE.Vector3()),
      wingR: this.sampleWingTip('R', wingR ?? new THREE.Vector3()),
    };
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}

/* -------------------------------------------------------------------------
 * The flock
 *
 * Fifteen birds could be fifteen independent scripts, but then they would all
 * take off at the same moment and the wood would look like it was running on a
 * metronome. Everything a bird decides — where to sit, when to drop to the
 * floor, when to sing, who chases whom — is handed out by this scheduler from
 * one seeded PRNG, so the flock is varied, reproducible, and never in lockstep.
 * ---------------------------------------------------------------------- */

const SPECIES_ORDER = SPECIES_LIST.map((species) => species.id);

/** How many birds of each species a forest should hold, given a total. */
export function birdSpeciesCounts(config = {}) {
  const total = Math.max(1, Math.floor(config.forestBirdCount ?? 15));
  const configured = config.forestBirdSpecies ?? SPECIES_ORDER;
  const species = configured.filter((id) => BIRD_SPECIES[id]);
  const list = species.length ? species : SPECIES_ORDER;
  const weights = list.map((id) => BIRD_SPECIES[id].count);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const counts = {};
  let assigned = 0;
  list.forEach((id, index) => {
    const share = index === list.length - 1
      ? total - assigned
      : Math.max(1, Math.round((weights[index] / weightTotal) * total));
    counts[id] = share;
    assigned += share;
  });
  return counts;
}

/**
 * The perch a bird wants: a point part-way along a branch, on the outward side
 * of a trunk, at a height the species prefers. `trees` are the grove's own
 * placements, so every perch is guaranteed to be inside a real tree.
 */
function choosePerch(species, trees, random, heightAt) {
  const [low, high] = species.behaviour.perchBand;
  const tree = trees[Math.floor(random() * trees.length)];
  if (!tree) return null;
  const height = 34 * (tree.scale ?? 1) * between(random, low, high);
  const angle = random() * TAU;
  // The trunk thins with height; the bird stands clear of it, on a branch.
  const fraction = THREE.MathUtils.clamp(height / (34 * (tree.scale ?? 1)), 0.05, 0.95);
  const trunkRadius = 0.58 * Math.pow(1 - fraction, 0.85) * (tree.scale ?? 1);
  const branchReach = Math.max(1.2, 34 * (tree.scale ?? 1) * 0.205 * (1 - fraction * 0.88));
  const distance = trunkRadius + between(random, 0.25, 0.8) * branchReach;
  const x = tree.x + Math.cos(angle) * distance;
  const z = tree.z + Math.sin(angle) * distance;
  const ground = heightAt ? heightAt(x, z) : 0;
  return {
    point: new THREE.Vector3(x, ground + height, z),
    // A bird on a branch faces outwards, away from the trunk, with a little
    // scatter: that is the pose the explorer sees from the forest floor.
    facing: Math.atan2(-Math.cos(angle), -Math.sin(angle)) + between(random, -0.5, 0.5),
    tree,
  };
}

/** A walkable-looking point on the forest floor, seeded like everything else. */
function chooseGroundSpot(sector, random, heightAt, radius) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const angle = random() * TAU;
    const distance = Math.sqrt(random()) * radius;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    if (!isPointInsideHex(x, z, 0, 0, radius - 8)) continue;
    const world = new THREE.Vector3(x, 0, z);
    world.y = heightAt ? heightAt(sector.center.x + x, sector.center.z + z) : sector.center.y;
    return world;
  }
  return new THREE.Vector3(0, heightAt ? heightAt(sector.center.x, sector.center.z) : 0, 0);
}

/**
 * Build the birds of HEX_S.
 *
 * `trees` is the pine grove's placement list, `heightAt`/`normalAt` come from
 * the baked terrain, and the returned object is what HexMap ticks each frame.
 */
export function buildForestBirds(sector, config = {}, {
  heightAt = null,
  trees = [],
  windUniforms = null,
} = {}) {
  if (!sector) return null;
  const group = new THREE.Group();
  group.name = 'ForestBirds_HEX_S';
  group.position.set(sector.center.x, config.floorHeight ?? 0, sector.center.z);
  group.userData.sectorId = sector.id;
  group.userData.biome = 'forest-birds';
  group.userData.windDriven = Boolean(windUniforms);

  const random = makeRandom(0x9317a5 + sector.order * 977);
  const radius = config.hexRadius;
  const counts = birdSpeciesCounts(config);
  const birds = [];
  const perchTrees = trees.filter((tree) => (
    isPointInsideHex(tree.x, tree.z, 0, 0, radius - 26)
  ));
  const treesForPerches = perchTrees.length ? perchTrees : trees;

  let index = 0;
  for (const [speciesId, count] of Object.entries(counts)) {
    const species = BIRD_SPECIES[speciesId];
    if (!species) continue;
    for (let member = 0; member < count; member += 1) {
      const seed = 0x5f3a + index * 7919;
      const rig = new BirdRig(species, { seed, windUniforms, config });
      group.add(rig.root);

      const birdRandom = makeRandom(seed);
      const perch = choosePerch(species, treesForPerches, birdRandom, heightAt);
      const ground = chooseGroundSpot(sector, birdRandom, heightAt, radius);
      const bird = {
        id: `${speciesId}-${member}`,
        species,
        rig,
        random: birdRandom,
        seed,
        // Behaviour
        state: 'perched',
        stateTime: 0,
        stateDuration: between(birdRandom, 1.2, 6),
        perched: true,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        yaw: 0,
        speed: 0,
        target: null,
        perch,
        home: ground.clone(),
        wingPhase: birdRandom() * TAU,
        glide: 0,
        glideTimer: 0,
        flapRate: 1,
        wingSpread: 0,
        airborne: false,
        alert: 0,
        // The head is a small state machine of its own: it holds still while the
        // body bobs, then snaps to a new angle and holds again.
        head: {
          yaw: 0, pitch: 0, roll: 0,
          targetYaw: 0, targetPitch: 0, targetRoll: 0,
          timer: between(birdRandom, 0.4, 2.2),
        },
        crest: 0,
        beakOpen: 0,
        hop: 0,
        hopImpulse: 0,
        curiosity: species.behaviour.curiosity * between(birdRandom, 0.6, 1.4),
        social: species.behaviour.social,
        neighbour: null,
        timer: between(birdRandom, 0, 4),
      };

      if (perch) {
        bird.position.copy(perch.point);
        bird.yaw = perch.facing;
        bird.supportY = perch.point.y;
      } else {
        bird.position.copy(ground).setY(ground.y + species.morph.leg * 0.9);
        bird.supportY = ground.y;
      }
      rig.root.position.copy(bird.position);
      // The bird's own forward is -Z, so a heading is a plain yaw about Y with
      // pitch and roll applied around it.
      rig.root.rotation.order = 'YXZ';
      birds.push(bird);
      index += 1;
    }
  }

  const state = {
    group,
    birds,
    time: 0,
    counts,
    windUniforms,
    radius,
    // Birds stay under the canopy: the crown of a mature pine is 34 units up,
    // and the wood's own mist and trunks live below about 30.
    ceiling: config.forestBirdCeiling ?? 28,
    /** Pick a new perch for a bird that has just landed or been flushed. */
    nextPerch(bird) {
      const perch = choosePerch(bird.species, treesForPerches, bird.random, heightAt);
      if (perch) bird.perch = perch;
      return bird.perch;
    },
    nextGround(bird) {
      bird.home = chooseGroundSpot(sector, bird.random, heightAt, radius);
      return bird.home;
    },
    setState(bird, next, duration) {
      bird.state = next;
      bird.stateTime = 0;
      bird.stateDuration = duration ?? between(bird.random, 1.5, 5);
    },
    update(delta, playerPosition) {
      updateFlock(state, delta, playerPosition);
    },
    setVisible(visible) {
      group.visible = visible;
    },
  };

  group.userData.heightAt = heightAt;
  group.userData.birdCount = birds.length;
  group.userData.speciesCounts = counts;
  group.userData.birdSpecies = Object.keys(counts);
  group.userData.states = () => birds.map((bird) => bird.state);
  group.userData.flock = state;
  return state;
}

/**
 * One frame of woodcraft.
 *
 * The order matters: what the explorer is doing decides whether the flock is
 * alarmed, the alarm decides what each bird wants to do, and the movement is
 * resolved last, so a bird that decided to flush this frame is already moving
 * by the end of it.
 */
function updateFlock(flock, delta, playerPosition) {
  const dt = Math.min(Math.max(delta, 0), 0.05);
  flock.time += dt;
  for (const bird of flock.birds) {
    updateBird(flock, bird, dt, playerPosition);
  }
  // The social pass: whichever bird happens to be nearest takes the lead in a
  // chase, so the flock comes alive in ones and twos.
  if (flock.time % 2 < dt) {
    for (const bird of flock.birds) {
      let nearest = null;
      let best = 40;
      for (const other of flock.birds) {
        if (other === bird) continue;
        const distance = bird.position.distanceTo(other.position);
        if (distance < best) {
          best = distance;
          nearest = other;
        }
      }
      bird.neighbour = nearest;
    }
  }
}

function updateBird(flock, bird, dt, playerPosition) {
  const species = bird.species;
  const behaviour = species.behaviour;
  const flight = species.flight;
  const morph = species.morph;
  const rig = bird.rig;
  bird.stateTime += dt;
  bird.timer -= dt;
  bird.flushCooldown = Math.max(0, (bird.flushCooldown ?? 0) - dt);

  /* --- is the explorer too close? ------------------------------------- */
  let threat = 0;
  let distanceToPlayer = Infinity;
  if (playerPosition) {
    distanceToPlayer = Math.hypot(
      bird.position.x - playerPosition.x,
      bird.position.z - playerPosition.z,
    );
    const heightGap = Math.abs(bird.position.y - playerPosition.y);
    const radius = behaviour.flushRadius * (1 + bird.curiosity * 0.2);
    if (distanceToPlayer < radius && heightGap < 14) {
      threat = 1 - distanceToPlayer / radius;
    }
  }
  // Alarm rises quickly while the explorer is close and falls away slowly when
  // they have gone — but a bird that has just flushed gets a moment of calm
  // before anything can set it off again.
  if (threat > 0.05) {
    bird.alert = Math.min(1.4, bird.alert + threat * dt * 1.6);
  } else {
    bird.alert = Math.max(0, bird.alert - dt * 0.55);
  }
  // A neighbour taking off takes the flock with it: an alarm spreads.
  if (bird.neighbour && bird.neighbour.state === 'flush' && bird.alert < 0.5 && bird.social > 0.4) {
    bird.alert = Math.min(1.4, bird.alert + dt * 1.4 * bird.social);
  }
  // A confident bird — a jay — takes a closer approach before it goes; a tit
  // is off at the first footstep.
  const flushThreshold = 0.4 + bird.curiosity * 0.3;
  if (bird.alert > flushThreshold && bird.state !== 'flush' && bird.flushCooldown <= 0) {
    bird.flushCooldown = between(bird.random, 5, 11);
    bird.alert = Math.min(1.2, bird.alert);
    flock.setState(bird, 'flush', between(bird.random, 2.6, 5.5));
  }

  /* --- decide ---------------------------------------------------------- */
  if (bird.stateTime > bird.stateDuration) {
    switch (bird.state) {
      case 'flush':
        flock.setState(bird, 'fly', between(bird.random, 2.5, 6));
        break;
      case 'fly': {
        // Most of the time a flying bird is going somewhere in particular.
        const choice = bird.random();
        if (choice < 0.34) {
          flock.nextPerch(bird);
          flock.setState(bird, 'travel', between(bird.random, 2, 5));
        } else if (choice < 0.55) {
          flock.nextGround(bird);
          flock.setState(bird, 'descend', between(bird.random, 2, 5));
        } else if (choice < 0.68 && bird.neighbour && bird.random() < species.behaviour.chases * 0.6) {
          bird.chaseTarget = bird.neighbour;
          flock.setState(bird, 'chase', between(bird.random, 2, 4.5));
        } else if (choice < 0.78) {
          // Follow a mate about for a bit.
          bird.followTarget = pickFollow(flock, bird);
          flock.setState(bird, 'follow', between(bird.random, 2.5, 5.5));
        } else {
          // A wander around the wood, weaving between the trunks.
          bird.wanderAngle = bird.random() * TAU;
          flock.setState(bird, 'wander', between(bird.random, 1.5, 3.5));
        }
        break;
      }
      case 'travel':
      case 'descend':
        // A bird that ran out of time on its way to a perch is still in the
        // air; it keeps flying rather than dropping onto the floor.
        if (bird.position.y - groundHeightAt(flock, bird) > 1.4) {
          flock.setState(bird, 'fly', between(bird.random, 1.5, 4));
        } else {
          flock.setState(bird, 'perched', between(bird.random, 1.2, 5));
        }
        break;
      case 'perched': {
        const choice = bird.random();
        if (choice < 0.26 + behaviour.groundShare * 0.4) {
          flock.nextGround(bird);
          flock.setState(bird, 'hopDown', between(bird.random, 1.4, 3.2));
        } else if (choice < 0.5) {
          bird.perch = bird.perch ?? {};
          fieldAlign(bird);
          flock.setState(bird, 'travel', between(bird.random, 2, 4));
        } else if (choice < 0.66) {
          flock.setState(bird, 'forage', between(bird.random, 2.2, 5));
        } else if (choice < 0.8) {
          flock.setState(bird, 'preen', between(bird.random, 2.5, 6));
        } else if (choice < 0.88 + behaviour.social * 0.04) {
          flock.setState(bird, 'sing', between(bird.random, 1.6, 3.4));
        } else {
          flock.setState(bird, 'look', between(bird.random, 1.4, 3));
        }
        break;
      }
      case 'forage':
      case 'preen':
      case 'sing':
      case 'look':
        if (bird.random() < 0.3) {
          const perch = flock.nextPerch(bird);
          if (perch) bird.perch = perch;
          flock.setState(bird, 'travel', between(bird.random, 1.6, 3.4));
        } else {
          flock.setState(bird, 'perched', between(bird.random, 1.5, 4));
        }
        break;
      case 'hop':
      case 'hopDown':
        flock.setState(bird, 'ground', between(bird.random, 1.2, 3.6));
        break;
      case 'ground': {
        const choice = bird.random();
        if (choice < 0.34) {
          flock.setState(bird, 'hop', between(bird.random, 0.6, 1.6));
        } else if (choice < 0.62) {
          flock.setState(bird, 'forage', between(bird.random, 2, 4.5));
        } else if (choice < 0.78) {
          flock.nextPerch(bird);
          flock.setState(bird, 'takeoff', between(bird.random, 1.6, 3));
        } else {
          flock.setState(bird, 'look', between(bird.random, 1.2, 2.6));
        }
        break;
      }
      default:
        flock.setState(bird, 'perched', between(bird.random, 1.5, 4));
        break;
    }
    if (bird.state !== 'preen') bird.preen = 0;
  }

  /* --- act ------------------------------------------------------------- */
  const state = bird.state;
  const stand = state === 'perched' || state === 'ground' || state === 'forage'
    || state === 'preen' || state === 'sing' || state === 'look' || state === 'hop'
    || state === 'hopDown';
  // A perched bird is high above the *floor*, so height alone cannot tell air
  // from perch: what matters is the gap to whatever the bird is standing on.
  // A bird that ends up well clear of its support is flying, whatever it has
  // decided to call itself.
  const support = bird.supportY ?? groundHeightAt(flock, bird);
  const flying = !stand || bird.position.y - support > 1.2;
  const grounded = !flying;
  bird.airborne = flying;

  // Wing spread and flap rate ease towards what the state asks for, so a
  // take-off opens the wings instead of switching them on.
  const targetSpread = flying ? 1 : (state === 'hop' || state === 'hopDown' ? 0.22 : 0);
  bird.wingSpread += (targetSpread - bird.wingSpread) * Math.min(1, dt * (flying ? 7 : 4.5));
  const flapTarget = flying ? 1 : (state === 'hop' ? 0.5 : 0);
  bird.flapRate += (flapTarget - bird.flapRate) * Math.min(1, dt * 5);
  bird.wingPhase += dt * TAU * flight.flapHz * (0.62 + bird.flapRate * 0.6) * (0.5 + bird.wingSpread * 0.7);

  // The glide: every small bird mixes short glides into its flight — the tits
  // less, the jay far more, which is most of what makes the two species read
  // differently in the air.
  if (flying && state !== 'takeoff' && state !== 'descend') {
    bird.glideTimer -= dt;
    if (bird.glideTimer <= 0) {
      const glide = bird.random() < flight.glideDuty;
      bird.glideTimer = glide ? between(bird.random, 0.8, 2.4) : between(bird.random, 0.6, 2.2);
      bird.glideTarget = glide ? 1 : 0;
    }
  } else {
    bird.glideTarget = 0;
  }
  bird.glide += ((bird.glideTarget ?? 0) - bird.glide) * Math.min(1, dt * 2.6);

  // Movement, per state.
  const speedTarget = {
    flush: flight.maxSpeed * 0.85,
    travel: flight.cruiseSpeed,
    descend: flight.cruiseSpeed * 0.8,
    wander: flight.cruiseSpeed * 0.85,
    chase: flight.maxSpeed * 0.95,
    follow: flight.cruiseSpeed * 1.05,
    takeoff: flight.cruiseSpeed * 0.7,
    hopDown: flight.cruiseSpeed * 0.75,
  }[state] ?? 0;

  if (flying) {
    steerBird(flock, bird, dt, { speedTarget, species, flight });
  } else {
    bird.velocity.multiplyScalar(Math.max(0, 1 - dt * 5));
    bird.speed = 0;
    if ((state === 'hop' || state === 'hopDown') && bird.stateTime > bird.stateDuration * 0.35 && bird.hopImpulse <= 0) {
      // A hop is a little parabola, not a walk: birds this size do not stride.
      bird.hopImpulse = between(bird.random, 0.45, 0.7);
      bird.hopDirection = bird.random() * TAU;
      bird.yaw = bird.hopDirection;
    }
    if (bird.hopImpulse > 0) {
      bird.hopImpulse -= dt;
      const ground = groundHeightAt(flock, bird);
      const lift = Math.sin(Math.max(0, bird.hopImpulse) / 0.7 * Math.PI) * 0.14;
      const travel = 0.55 * dt * (state === 'hopDown' ? 0.4 : 1);
      bird.position.x += Math.cos(bird.hopDirection) * travel;
      bird.position.z += Math.sin(bird.hopDirection) * travel;
      bird.position.y = ground + lift + morph.leg * 0.5;
      if (state === 'hopDown') {
        const reach = bird.home;
        const dx = reach.x - bird.position.x;
        const dz = reach.z - bird.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 1.2) {
          flock.setState(bird, 'ground', between(bird.random, 1.4, 3.5));
          bird.position.copy(reach);
        } else {
          bird.hopDirection = Math.atan2(dz, dx);
          bird.position.y = ground + lift + morph.leg * 0.5;
        }
      }
    } else if (Math.abs((bird.supportY ?? 0) - groundHeightAt(flock, bird)) < 1.5) {
      // Standing on the floor.
      const ground = groundHeightAt(flock, bird);
      bird.supportY = ground;
      bird.position.y += (ground + morph.leg * 0.62 - bird.position.y) * Math.min(1, dt * 8);
    } else {
      // Standing on a branch: the bird holds the height of its perch.
      bird.position.y += (bird.supportY + morph.leg * 0.5 - bird.position.y) * Math.min(1, dt * 10);
    }
  }

  /* --- pose ------------------------------------------------------------ */
  const ground = groundHeightAt(flock, bird);
  const altitude = Math.max(0, bird.position.y - ground);
  const climb = bird.velocity.y;
  // Legs tuck in the air and grip on a perch; the toes curl around a twig.
  const tuck = flying ? 1 : 0;
  bird.legTuck = (bird.legTuck ?? 0) + (tuck - (bird.legTuck ?? 0)) * Math.min(1, dt * 6);
  const grip = grounded ? 1 : 0;
  bird.footGrip = (bird.footGrip ?? 1) + (grip - (bird.footGrip ?? 1)) * Math.min(1, dt * 8);

  // Head saccades: small, fast, and holding still in between — the single most
  // bird-like thing a bird does.
  const head = bird.head;
  head.timer -= dt;
  if (head.timer <= 0) {
    const nervous = 0.4 + bird.alert * 1.6;
    head.targetYaw = between(bird.random, -1.5, 1.5) * (0.5 + bird.alert);
    head.targetPitch = between(bird.random, -0.6, 0.5);
    head.targetRoll = bird.random() < 0.35 ? between(bird.random, -0.5, 0.5) : 0;
    head.timer = between(bird.random, 0.25, 1.6) / nervous;
    if (state === 'sing') {
      head.targetPitch = -0.45;
      head.targetYaw = between(bird.random, -0.2, 0.2);
    }
    if (state === 'preen') {
      head.targetYaw = (bird.random() < 0.5 ? -1 : 1) * between(bird.random, 1.6, 2.7);
      head.targetPitch = between(bird.random, 0.2, 0.5);
      bird.preen = between(bird.random, 0.6, 1.4);
    }
    if (grounded && (state === 'forage' || state === 'ground')) {
      head.targetPitch = 0.55;
      head.targetYaw = between(bird.random, -0.25, 0.25);
      head.timer = between(bird.random, 0.6, 1.8);
    }
  }
  const saccade = Math.min(1, dt * 13);
  head.yaw += (head.targetYaw - head.yaw) * saccade;
  head.pitch += (head.targetPitch - head.pitch) * saccade;
  head.roll += (head.targetRoll - head.roll) * saccade;

  // The song: the beak opens on a quick rhythm and the crest rises with it.
  const singing = state === 'sing';
  const songClock = bird.stateTime * 9;
  bird.beakOpen = singing
    ? Math.max(0, Math.sin(songClock)) * 0.75
    : (state === 'flush' ? 0.28 : 0);
  const crestTarget = bird.alert > 0.5 ? 1 : (singing ? 0.4 : 0);
  bird.crest += (crestTarget - bird.crest) * Math.min(1, dt * 3);

  // The tail counterweights the flight: it drops on the downstroke and lifts
  // when the bird is climbing, and fans when it flares to land.
  const flare = state === 'descend' || state === 'travel' || state === 'takeoff' ? 0.55 : 0;
  const tailPitch = 0.12 * Math.sin(bird.wingPhase - 1.2) - climb * 0.045 + (grounded ? 0.1 : 0);
  const bodyPitch = (flying ? (bird.speed / Math.max(1, flight.cruiseSpeed)) * 0.25 : -0.1)
    + (state === 'descend' ? 0.22 : 0)
    - (state === 'takeoff' ? 0.35 : 0)
    + Math.sin(bird.wingPhase * 2) * 0.03 * bird.flapRate;

  rig.applyPose({
    wingSpread: bird.wingSpread,
    flapPhase: bird.wingPhase,
    flapAmplitude: 0.85 + bird.glide * -0.7 + (flying ? 0.25 : 0),
    glideBlend: bird.glide,
    bodyPitch,
    bodyRoll: bird.bank ?? 0,
    bodyBob: grounded ? Math.sin(flock.time * 3 + bird.seed) * 0.006 : 0,
    legTuck: bird.legTuck,
    legReach: state === 'descend' ? 0.7 : (state === 'takeoff' ? 0.3 : 0),
    footGrip: bird.footGrip,
    toeCurl: state === 'hop' ? 0.4 : 0,
    neckPitch: state === 'forage' || state === 'ground' ? 0.5 : 0,
    headYaw: head.yaw,
    headPitch: head.pitch,
    headRoll: head.roll,
    beakOpen: bird.beakOpen,
    crestRaise: bird.crest,
    tailPitch,
    tailSpread: 0.1 + flare + (state === 'flush' ? 0.4 : 0),
    tailLeft: Math.sin(flock.time * 2.1 + bird.seed) * (grounded ? 0.12 : 0.04),
    tailRight: Math.sin(flock.time * 2.1 + bird.seed + 0.4) * (grounded ? 0.12 : 0.04),
    wingLift: state === 'flush' ? 0.12 : 0,
  });

  rig.root.position.copy(bird.position);
  const pitch = THREE.MathUtils.clamp(bodyPitch * 0.8 + (flying ? 0 : -0.05), -0.9, 0.9);
  rig.root.rotation.set(pitch, bird.yaw, 0);
}

/** The terrain height under a bird, from the same lattice the explorer walks. */
function groundHeightAt(flock, bird) {
  const heightAt = flock.group.userData.heightAt;
  if (typeof heightAt !== 'function') return flock.group.position.y;
  return heightAt(
    flock.group.position.x + bird.position.x,
    flock.group.position.z + bird.position.z,
  );
}

function pickFollow(flock, bird) {
  let best = null;
  let bestScore = -Infinity;
  for (const other of flock.birds) {
    if (other === bird) continue;
    const score = bird.random() - other.position.distanceTo(bird.position) * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function fieldAlign(bird) {
  if (bird.perch) bird.yaw = bird.perch.facing ?? bird.yaw;
}

/**
 * Fly: pick where this bird wants to be, turn towards it, and move.
 *
 * The steering is a simple seek with a banking turn and a weave that keeps the
 * birds off the straight line — a wood full of birds flying dead-straight
 * vectors looks like a screensaver, and one with a little roll in every turn
 * looks alive.
 */
function steerBird(flock, bird, dt, { speedTarget, species, flight }) {
  const state = bird.state;
  const target = steeringTarget(flock, bird, state);
  const dx = target.x - bird.position.x;
  const dz = target.z - bird.position.z;
  const distance = Math.hypot(dx, dz);
  const desiredYaw = distance > 0.05 ? Math.atan2(-dx, -dz) : bird.yaw;

  let turn = ((desiredYaw - bird.yaw + Math.PI * 3) % TAU) - Math.PI;
  // `yaw` follows the same convention as the explorer's: facing -Z is 0.
  turn = Math.max(-flight.turnRate * dt, Math.min(flight.turnRate * dt, turn));
  const previousYaw = bird.yaw;
  bird.yaw += turn;
  bird.yaw = ((bird.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;

  // The bird turns by banking; the roll is the turn rate, dressed up with the
  // weave it flies even when it is going straight.
  const yawRate = (bird.yaw - previousYaw) / Math.max(dt, 1e-4);
  const weave = Math.sin(flock.time * 1.7 + bird.seed * 0.7) * flight.weave * 0.12;
  bird.bank = THREE.MathUtils.lerp(
    bird.bank ?? 0,
    THREE.MathUtils.clamp(-yawRate * 0.22, -0.85, 0.85) + weave,
    Math.min(1, dt * 5),
  );

  const speed = (bird.speed ?? 0) + (speedTarget * (1 - bird.glide * 0.15) - (bird.speed ?? 0)) * Math.min(1, dt * 2.2);
  bird.speed = speed;

  // Vertical: climb towards a perch above, descend towards one below, and
  // otherwise hold a height band inside the canopy.
  const desiredY = target.y;
  const vertical = THREE.MathUtils.clamp((desiredY - bird.position.y) * 1.4, -flight.climbRate, flight.climbRate);
  bird.velocity.set(
    Math.sin(bird.yaw) * -speed,
    vertical * (state === 'descend' ? 1.2 : 1) * (bird.glide > 0.4 ? 0.8 : 1),
    Math.cos(bird.yaw) * -speed,
  );
  bird.position.addScaledVector(bird.velocity, dt);

  // Stay inside the hex and under the canopy. The wall is the last resort: a
  // bird that wanders close to it is turned back towards the wood before it
  // ever reaches one, so a flushed flock never ends up in the next sector.
  const limit = (flock.radius ?? 220) - 30;
  const radial = Math.hypot(bird.position.x, bird.position.z);
  if (radial > limit * 0.82) {
    const inward = Math.atan2(-bird.position.x, -bird.position.z);
    bird.yaw += ((inward - bird.yaw + Math.PI * 3) % TAU - Math.PI) * Math.min(1, dt * 3);
    if (bird.target) bird.target.set(0, bird.position.y, 0);
  }
  if (radial > limit) {
    const shrink = limit / radial;
    bird.position.x *= shrink;
    bird.position.z *= shrink;
  }
  const ground = groundHeightAt(flock, bird);
  const ceiling = (flock.ceiling ?? 30) - 6;
  if (bird.position.y < ground + 0.4) bird.position.y = ground + 0.4;
  if (bird.position.y > ceiling) bird.position.y = ceiling;

  // Arriving: settle onto the perch, or drop to the floor and hop.
  const arriveY = Math.abs(target.y - bird.position.y);
  if ((state === 'travel' || state === 'takeoff') && distance < 1.4 && arriveY < 1.4) {
    bird.position.copy(target);
    bird.supportY = target.y;
    bird.speed = 0;
    flock.setState(bird, 'perched', between(bird.random, 1.4, 5.5));
    fieldAlign(bird);
  }
  if (state === 'descend' && distance < 1.6 && bird.position.y < ground + 2.2) {
    bird.home.set(target.x, ground, target.z);
    bird.position.y = ground + morph.leg * 0.5;
    bird.supportY = ground;
    flock.setState(bird, 'ground', between(bird.random, 1.6, 4));
  }
}

function steeringTarget(flock, bird, state) {
  switch (state) {
    case 'travel':
    case 'takeoff':
      return bird.perch?.point ?? bird.position;
    case 'descend':
    case 'hopDown':
      return bird.home;
    case 'chase': {
      const target = bird.chaseTarget;
      if (!target) return bird.position;
      return target.position;
    }
    case 'follow': {
      const target = bird.followTarget;
      if (!target) return bird.position;
      // Follow behind and above, not on top of.
      return new THREE.Vector3(
        target.position.x + Math.sin(target.yaw) * 2.4,
        target.position.y + 0.8,
        target.position.z + Math.cos(target.yaw) * 2.4,
      );
    }
    case 'flush': {
      // Away from the ground and away from whatever startled them.
      const away = bird.position.clone().sub(bird.home);
      away.y = 0;
      if (away.lengthSq() < 0.01) away.set(1, 0, 0);
      away.normalize();
      const lift = Math.max(0, (flock.ceiling ?? 30) * 0.55 - bird.position.y);
      return bird.position.clone()
        .addScaledVector(away, 6)
        .add(new THREE.Vector3(0, lift * 0.5 + 1.5, 0));
    }
    default: {
      // Wander: a slowly wandering heading inside the sector.
      const dt = 1 / 60;
      bird.wanderAngle = (bird.wanderAngle ?? 0) + dt * 0.55;
      const heading = bird.wanderAngle;
      const ahead = bird.position.clone().add(new THREE.Vector3(
        Math.cos(heading) * 12,
        0,
        Math.sin(heading) * 12,
      ));
      const radial = Math.hypot(ahead.x, ahead.z);
      if (radial > flock.radius - 30) {
        ahead.x *= 0.6;
        ahead.z *= 0.6;
        bird.wanderAngle += Math.PI * 0.7;
      }
      ahead.y = groundHeightAt(flock, bird) + 8 + Math.sin(flock.time * 0.5 + bird.seed) * 2.5;
      return ahead;
    }
  }
}
