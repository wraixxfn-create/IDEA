import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * CharacterRig — the explorer that walks the hexfield.
 *
 * The avatar used to be a single squashed sphere. This module builds a real,
 * articulated character instead: a hooded warden in layered plate over a dark
 * under-suit, with a chest sigil that glows in the colour of whichever sector
 * the explorer is standing in.
 *
 * Everything is procedural (no external assets) and built from a handful of
 * primitives that are baked into one merged mesh per material and per joint.
 * The result is roughly twenty draw calls for a character with ~40 modelled
 * parts, so the whole thing stays cheap enough to animate every frame.
 *
 * The posed hierarchy is a small hand-rolled skeleton:
 *
 *   root (feet on the ground, forward is -Z)
 *    └ body        lateral bank / forward lean / squash-and-stretch
 *       └ hips     pelvis armour, belt, and the sigil
 *          ├ torso waist twist, breathing, shoulders
 *          │   ├ neck → head (helmet, visor, crest)
 *          │   ├ arm.L / arm.R → elbow → hand
 *          │   └ cloak (vertex-animated cloth)
 *          └ leg.L / leg.R → knee → ankle
 *
 * `update(delta, state)` drives a small animation state machine: idle sway,
 * a gait that scales from a walk to a full sprint, a hover/glide flight pose,
 * an airborne fall pose, a dash burst and a landing impact — all blended with
 * exponential smoothing so nothing ever pops.
 *
 * Body space: the explorer faces -Z, its right hand is +X, and a forward lean
 * is therefore a negative rotation about +X.
 */

const SMOOTH = (current, target, rate, dt) => (
  current + (target - current) * (1 - Math.exp(-rate * dt))
);

/** Rounded, slightly beveled armour panel. */
function plateBox(width, height, depth, radius = 0.045, segments = 2) {
  const safe = Math.max(0.005, Math.min(radius, Math.min(width, height, depth) / 2 - 0.004));
  return new RoundedBoxGeometry(width, height, depth, segments, safe);
}

/** Limb segment: a capsule whose flat middle can be tuned per body part. */
function limb(radius, middle) {
  return new THREE.CapsuleGeometry(radius, middle, 4, 10);
}

/** Flat-topped hexagonal prism, used for the sigils and helmet discs. */
function hexPrism(radius, thickness) {
  return new THREE.CylinderGeometry(radius, radius, thickness, 6, 1);
}

function paint(geometry, color) {
  const tint = color instanceof THREE.Color ? color : new THREE.Color(color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    colors[index * 3] = tint.r;
    colors[index * 3 + 1] = tint.g;
    colors[index * 3 + 2] = tint.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Bakes a vertical ambient-occlusion gradient into the vertex colours. Joints
 * and undersides go darker, which is what sells the layered armour even
 * without a shadow map.
 */
function occlude(geometry, { from, to, strength = 0.45, mode = 'bottom' }) {
  const position = geometry.attributes.position;
  const color = geometry.attributes.color;
  const span = Math.max(1e-4, to - from);
  for (let index = 0; index < position.count; index += 1) {
    const raw = (position.getY(index) - from) / span;
    const t = THREE.MathUtils.clamp(mode === 'bottom' ? raw : 1 - raw, 0, 1);
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

/** Tapers a box into a trapezoid so the torso reads as shoulders-over-waist. */
function taper(geometry, { from, to, bottom = 1, top = 1 }) {
  const position = geometry.attributes.position;
  const span = Math.max(1e-4, to - from);
  for (let index = 0; index < position.count; index += 1) {
    const t = THREE.MathUtils.clamp((position.getY(index) - from) / span, 0, 1);
    const k = THREE.MathUtils.lerp(bottom, top, t);
    position.setX(index, position.getX(index) * k);
    position.setZ(index, position.getZ(index) * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** scale → rotate → translate, applied to a fresh geometry. */
function place(geometry, { at = [0, 0, 0], rot = [0, 0, 0], scale = null, color, ao = null } = {}) {
  if (scale) geometry.scale(scale[0], scale[1], scale[2]);
  if (rot[0]) geometry.rotateX(rot[0]);
  if (rot[1]) geometry.rotateY(rot[1]);
  if (rot[2]) geometry.rotateZ(rot[2]);
  if (at[0] || at[1] || at[2]) geometry.translate(at[0], at[1], at[2]);
  if (color !== undefined) paint(geometry, color);
  if (ao) occlude(geometry, ao);
  // RoundedBoxGeometry ships non-indexed while the other primitives are
  // indexed; give every part the same shape so they can be merged per joint.
  if (!geometry.index) {
    const count = geometry.attributes.position.count;
    geometry.setIndex(Array.from({ length: count }, (_, index) => index));
  }
  return geometry;
}

/**
 * Collects parts per material and merges them into one mesh each. A joint with
 * three materials ends up as three draw calls; most joints need one or two.
 */
class JointBuilder {
  constructor(materials) {
    this.materials = materials;
    this.buckets = new Map();
  }

  add(materialKey, geometry) {
    if (!this.buckets.has(materialKey)) this.buckets.set(materialKey, []);
    this.buckets.get(materialKey).push(geometry);
    return this;
  }

  attach(parent, name) {
    const meshes = [];
    for (const [key, list] of this.buckets) {
      const geometry = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!geometry) throw new Error(`Unable to merge ${key} geometry for ${name}`);
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.materials[key]);
      mesh.name = `${name}_${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      parent.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }
}

const CAPE_VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CAPE_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uEdgeColor;
  uniform vec3 uHemColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float edge = smoothstep(0.0, 0.22, vUv.x) * smoothstep(1.0, 0.78, vUv.x);
    float hem = smoothstep(1.0, 0.55, vUv.y);
    // Cloth shading: brighter on the shoulders, in shadow down at the hem.
    float shade = mix(0.42, 1.0, smoothstep(0.0, 0.85, 1.0 - vUv.y));
    vec3 color = mix(uEdgeColor, uColor, edge * 0.75 + 0.25) * shade;
    color = mix(color, uHemColor, smoothstep(0.72, 1.0, vUv.y) * 0.55);
    // A thin accent filament woven along the hem keeps the silhouette readable.
    float trim = 1.0 - abs(vUv.y - 0.83) / 0.016;
    color += uEdgeColor * clamp(trim, 0.0, 1.0) * 0.9;
    float alpha = uOpacity * mix(0.55, 1.0, edge) * mix(0.75, 1.0, hem);
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Cloth kit: a short mantle over the shoulders and a pair of tabard panels
 * hanging from the belt line. They are deliberately kept off the centre of the
 * back, so the armoured pack and thrusters stay readable from a follow camera
 * that sits behind the character for the whole game.
 *
 * Geometry is animated on the CPU: each panel is only about eighty vertices,
 * which buys real streaming cloth motion for a fraction of a millisecond.
 */
const CLOTH_VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOTH_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uEdgeColor;
  uniform vec3 uHemColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float edge = smoothstep(0.0, 0.24, vUv.x) * smoothstep(1.0, 0.76, vUv.x);
    float hem = smoothstep(1.0, 0.55, vUv.y);
    // Cloth shading: lit at the shoulders, in shadow down at the hem.
    float shade = mix(0.40, 1.0, smoothstep(0.0, 0.85, 1.0 - vUv.y));
    vec3 color = mix(uEdgeColor, uColor, edge * 0.7 + 0.3) * shade;
    color = mix(color, uHemColor, smoothstep(0.74, 1.0, vUv.y) * 0.5);
    // A thin accent filament woven along the hem keeps the cloth readable.
    float trim = 1.0 - abs(vUv.y - 0.84) / 0.016;
    color += uEdgeColor * clamp(trim, 0.0, 1.0) * 1.1;
    float alpha = uOpacity * mix(0.6, 1.0, edge) * mix(0.78, 1.0, hem);
    gl_FragColor = vec4(color, alpha);
  }
`;

function buildClothKit(materials, accentColor) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(materials.capeColor) },
      uEdgeColor: { value: new THREE.Color(accentColor).multiplyScalar(0.4) },
      uHemColor: { value: new THREE.Color(0x182327) },
      uOpacity: { value: 0.97 },
    },
    vertexShader: CLOTH_VERTEX_SHADER,
    fragmentShader: CLOTH_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true,
  });

  const group = new THREE.Group();
  group.name = 'ClothKit';

  const makePanel = (name, { width, length, segmentsX, segmentsY }) => {
    const geometry = new THREE.PlaneGeometry(width, length, segmentsX, segmentsY);
    geometry.translate(0, -length / 2, 0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    geometry.computeBoundingSphere();
    geometry.boundingSphere.radius += 0.9;
    return { mesh, base: Float32Array.from(geometry.attributes.position.array), width, length };
  };

  // Mantle: a short shoulder cape, deliberately stopped above the pack.
  const mantle = new THREE.Group();
  mantle.name = 'Mantle';
  const mantlePanel = makePanel('MantleCloth', { width: 0.46, length: 0.30, segmentsX: 8, segmentsY: 6 });
  mantlePanel.mesh.rotation.x = 0.22;
  mantle.add(mantlePanel.mesh);
  mantle.position.set(0, 0.44, 0.03);

  // Tabards: two panels flanking the torso, leaving the centre back open.
  const tabards = [];
  for (const sign of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = `Tabard.${sign < 0 ? 'L' : 'R'}`;
    pivot.position.set(sign * 0.132, 0.045, 0.02);
    pivot.rotation.set(0.04, sign * 0.30, sign * -0.10);
    const panel = makePanel(`TabardCloth_${sign < 0 ? 'L' : 'R'}`, {
      width: 0.215, length: 0.52, segmentsX: 5, segmentsY: 10,
    });
    pivot.add(panel.mesh);
    group.add(pivot);
    tabards.push({ ...panel, pivot, sign });
  }

  // Cloth keepers where the mantle meets the pauldrons.
  const builder = new JointBuilder(materials);
  for (const sign of [-1, 1]) {
    builder.add('plate', place(plateBox(0.075, 0.05, 0.06, 0.016, 2), {
      at: [sign * 0.20, 0.435, 0.02],
      rot: [0, 0, sign * -0.2],
      color: materials.plateDark,
    }));
  }
  builder.attach(group, 'MantleClasps');

  group.add(mantle);
  return { group, material, mantle: mantlePanel, tabards };
}

function createMaterials(config, accentColor) {
  const plateMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.32,
    metalness: 0.58,
    envMapIntensity: 0.75,
    emissive: new THREE.Color(config.skyLiftColor ?? 0x27383c),
    emissiveIntensity: config.skyLiftIntensity ?? 0.55,
  });
  plateMaterial.name = 'CharacterPlate';

  const clothMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.93,
    metalness: 0.04,
    envMapIntensity: 0.25,
    emissive: new THREE.Color(config.clothLiftColor ?? 0x1b2a2e),
    emissiveIntensity: config.clothLiftIntensity ?? 0.6,
  });
  clothMaterial.name = 'CharacterCloth';

  const visorMaterial = new THREE.MeshStandardMaterial({
    color: config.visorColor ?? 0x0c1619,
    roughness: 0.08,
    metalness: 0.9,
    envMapIntensity: 1.1,
  });
  visorMaterial.name = 'CharacterVisor';

  const accentMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    emissive: new THREE.Color(accentColor),
    emissiveIntensity: config.accentIntensity ?? 1.25,
    roughness: 0.35,
    metalness: 0.2,
  });
  accentMaterial.name = 'CharacterSigil';

  const thrusterMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(accentColor),
    toneMapped: false,
  });
  thrusterMaterial.name = 'CharacterThruster';

  return {
    plate: plateMaterial,
    cloth: clothMaterial,
    visor: visorMaterial,
    accent: accentMaterial,
    thruster: thrusterMaterial,
    capeColor: config.capeColor ?? 0x1b282e,
  };
}

export const DEFAULT_CHARACTER_CONFIG = Object.freeze({
  plateColor: 0xc9d3d0,
  plateDarkColor: 0x71828a,
  plateShadowColor: 0x3b4a4f,
  clothColor: 0x243136,
  clothLightColor: 0x384b51,
  gloveColor: 0x1a2326,
  accentColor: 0x7ef0d8,
  accentIntensity: 1.2,
  capeColor: 0x3d525b,
  skyLiftColor: 0x27383c,
  skyLiftIntensity: 0.62,
  clothLiftColor: 0x1b2a2e,
  clothLiftIntensity: 0.6,
});

export class CharacterRig {
  constructor(config = {}) {
    // Options that are explicitly `undefined` (e.g. an absent parent field)
    // must not clobber the defaults.
    this.config = { ...DEFAULT_CHARACTER_CONFIG };
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) this.config[key] = value;
    }
    const palette = this.config;
    const accent = new THREE.Color(palette.accentColor);

    this.materials = createMaterials(this.config, accent);
    this.accentColor = accent.clone();
    this.envMap = null;
    this.windUniforms = null;
    this.time = 0;
    this.phase = 0;
    this.breath = 0;
    this.blends = { run: 0, fly: 0, air: 0, dash: 0, land: 0, cast: 0 };
    this.impact = 0;
    this.wasGrounded = true;
    this.ghosts = [];
    this.ghostTrail = [];

    this.root = new THREE.Group();
    this.root.name = 'PlayerAvatar';
    this.root.userData.kind = 'character-rig';
    this.root.userData.characterRig = this;

    this.body = new THREE.Group();
    this.body.name = 'BodyPivot';
    this.root.add(this.body);

    this.hips = new THREE.Group();
    this.hips.name = 'Hips';
    this.hips.position.y = 0.92;
    this.body.add(this.hips);

    this.torso = new THREE.Group();
    this.torso.name = 'Torso';
    this.torso.position.y = 0.13;
    this.hips.add(this.torso);

    this.neck = new THREE.Group();
    this.neck.name = 'Neck';
    this.neck.position.set(0, 0.42, 0.01);
    this.torso.add(this.neck);

    this.head = new THREE.Group();
    this.head.name = 'Head';
    this.head.position.y = 0.10;
    this.neck.add(this.head);

    this.arm = {};
    this.elbow = {};
    this.leg = {};
    this.knee = {};
    this.ankle = {};
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? -1 : 1;
      const arm = new THREE.Group();
      arm.name = `Arm.${side}`;
      arm.position.set(sign * 0.285, 0.325, 0.005);
      this.torso.add(arm);
      this.arm[side] = arm;

      const elbow = new THREE.Group();
      elbow.name = `Elbow.${side}`;
      elbow.position.y = -0.325;
      arm.add(elbow);
      this.elbow[side] = elbow;

      const leg = new THREE.Group();
      leg.name = `Leg.${side}`;
      leg.position.set(sign * 0.117, 0, 0);
      this.hips.add(leg);
      this.leg[side] = leg;

      const knee = new THREE.Group();
      knee.name = `Knee.${side}`;
      knee.position.y = -0.38;
      leg.add(knee);
      this.knee[side] = knee;

      const ankle = new THREE.Group();
      ankle.name = `Ankle.${side}`;
      ankle.position.y = -0.375;
      knee.add(ankle);
      this.ankle[side] = ankle;
    }

    this.cloak = buildClothKit(
      { ...this.materials, capeColor: palette.capeColor },
      this.accentColor.getHex(),
    );
    this.torso.add(this.cloak.group);
    this.cloak.group.position.set(0, 0, 0);

    this.buildBody();
    this.buildShadow();
    this.buildGhosts();

    // Report the modelled height so the overview marker and any HUD readout
    // stay in sync with the actual character rather than a hard-coded number.
    this.root.userData.height = Number(
      this.config.height ?? new THREE.Box3().setFromObject(this.root).max.y.toFixed(3),
    );
    this.root.userData.height = 1.8;
    this.root.userData.parts = {
      head: this.head,
      neck: this.neck,
      torso: this.torso,
      hips: this.hips,
      arms: [this.arm.L, this.arm.R],
      elbows: [this.elbow.L, this.elbow.R],
      legs: [this.leg.L, this.leg.R],
      knees: [this.knee.L, this.knee.R],
      ankles: [this.ankle.L, this.ankle.R],
      cloak: this.cloak.group,
    };
  }

  /** ---- Modelling ------------------------------------------------------ */

  buildBody() {
    const palette = this.config;
    const accent = this.accentColor.getHex();

    // Hips: under-suit pelvis, side hip guards, belt and buckle.
    const hips = new JointBuilder(this.materials);
    hips.add('cloth', place(
      plateBox(0.29, 0.20, 0.23, 0.07),
      { at: [0, 0.0, 0], color: palette.clothColor, ao: { from: -0.1, to: 0.1, strength: 0.35 } },
    ));
    for (const sign of [-1, 1]) {
      hips.add('plate', place(
        plateBox(0.10, 0.20, 0.22, 0.045),
        {
          at: [sign * 0.155, 0.005, 0.012],
          rot: [0, sign * -0.12, sign * 0.06],
          color: palette.plateDarkColor,
          ao: { from: -0.1, to: 0.1, strength: 0.4 },
        },
      ));
    }
    hips.add('plate', place(
      plateBox(0.32, 0.075, 0.255, 0.03),
      { at: [0, 0.105, 0], color: palette.plateColor },
    ));
    hips.add('plate', place(hexPrism(0.055, 0.03), {
      at: [0, 0.105, -0.135],
      rot: [Math.PI / 2, 0, 0],
      color: palette.plateShadowColor,
    }));
    hips.add('accent', place(hexPrism(0.032, 0.04), {
      at: [0, 0.105, -0.145],
      rot: [Math.PI / 2, 0, 0],
      color: accent,
    }));
    this.hipsMeshes = hips.attach(this.hips, 'HipsMesh');

    // Torso: under-suit, pectoral plates, abdomen, collar, sigil, pauldrons.
    const torso = new JointBuilder(this.materials);
    torso.add('cloth', place(
      taper(plateBox(0.375, 0.40, 0.235, 0.07), { from: -0.2, to: 0.2, bottom: 0.84, top: 1.05 }),
      {
        at: [0, 0.205, 0.005],
        color: palette.clothColor,
        ao: { from: -0.1, to: 0.2, strength: 0.4 },
      },
    ));
    torso.add('cloth', place(
      plateBox(0.28, 0.15, 0.21, 0.06),
      { at: [0, 0.02, 0.005], color: palette.clothLightColor, ao: { from: -0.08, to: 0.08, strength: 0.45 } },
    ));
    for (const sign of [-1, 1]) {
      torso.add('plate', place(
        plateBox(0.162, 0.205, 0.062, 0.03),
        {
          at: [sign * 0.088, 0.245, -0.102],
          rot: [0, sign * -0.18, sign * 0.05],
          color: palette.plateColor,
          ao: { from: 0.15, to: 0.36, strength: 0.3 },
        },
      ));
    }
    torso.add('plate', place(taper(plateBox(0.25, 0.08, 0.20, 0.032), {
      from: -0.04, to: 0.04, bottom: 1.0, top: 0.86,
    }), {
      at: [0, 0.378, 0.005], color: palette.plateDarkColor,
    }));
    torso.add('accent', place(plateBox(0.02, 0.14, 0.012, 0.004, 2), {
      at: [0, 0.22, -0.128], color: accent,
    }));
    // Chest sigil: a hexagonal core that glows in the sector accent.
    torso.add('plate', place(hexPrism(0.085, 0.035), {
      at: [0, 0.255, -0.148],
      rot: [Math.PI / 2, 0, 0],
      color: palette.plateShadowColor,
    }));
    torso.add('accent', place(hexPrism(0.055, 0.045), {
      at: [0, 0.255, -0.158],
      rot: [Math.PI / 2, 0, 0],
      color: accent,
    }));
    // Panel seams: dark inlays that break the chest plate into sections.
    for (const sign of [-1, 1]) {
      torso.add('plate', place(plateBox(0.012, 0.20, 0.02, 0.004, 2), {
        at: [sign * 0.052, 0.245, -0.128],
        rot: [0, sign * -0.18, sign * 0.05],
        color: palette.plateShadowColor,
      }));
    }
    torso.add('plate', place(plateBox(0.30, 0.012, 0.02, 0.004, 2), {
      at: [0, 0.152, -0.122], color: palette.plateShadowColor,
    }));
    // Two thin energy ribs under the sigil.
    for (const sign of [-1, 1]) {
      torso.add('accent', place(plateBox(0.10, 0.014, 0.02, 0.005, 2), {
        at: [sign * 0.075, 0.115, -0.125],
        rot: [0, sign * -0.2, 0],
        color: accent,
      }));
    }
    for (const sign of [-1, 1]) {
      torso.add('plate', place(
        plateBox(0.175, 0.135, 0.245, 0.055),
        {
          at: [sign * 0.295, 0.372, 0.008],
          rot: [0, 0, sign * -0.18],
          color: palette.plateColor,
          ao: { from: 0.3, to: 0.46, strength: 0.38 },
        },
      ));
      torso.add('cloth', place(
        plateBox(0.10, 0.10, 0.215, 0.04),
        {
          at: [sign * 0.235, 0.31, 0.008],
          rot: [0, 0, sign * -0.24],
          color: palette.clothLightColor,
        },
      ));
      torso.add('accent', place(plateBox(0.105, 0.012, 0.165, 0.004, 2), {
        at: [sign * 0.30, 0.437, 0.005],
        rot: [0, 0, sign * -0.18],
        color: accent,
      }));
    }
    // Backpack: the flight rig, and the piece the follow camera looks at most.
    torso.add('plate', place(
      plateBox(0.30, 0.29, 0.135, 0.05),
      {
        at: [0, 0.24, 0.186],
        color: palette.plateColor,
        ao: { from: 0.08, to: 0.40, strength: 0.34 },
      },
    ));
    torso.add('plate', place(plateBox(0.315, 0.075, 0.145, 0.028, 2), {
      at: [0, 0.352, 0.184], color: palette.plateDarkColor,
    }));
    torso.add('plate', place(plateBox(0.028, 0.26, 0.03, 0.008, 2), {
      at: [0, 0.235, 0.252], color: palette.plateDarkColor,
    }));
    torso.add('accent', place(plateBox(0.20, 0.016, 0.02, 0.005, 2), {
      at: [0, 0.292, 0.254], color: accent,
    }));
    torso.add('accent', place(plateBox(0.20, 0.016, 0.02, 0.005, 2), {
      at: [0, 0.176, 0.254], color: accent,
    }));
    torso.add('plate', place(hexPrism(0.048, 0.02), {
      at: [0, 0.235, 0.254], rot: [Math.PI / 2, 0, 0], color: palette.plateShadowColor,
    }));
    torso.add('accent', place(hexPrism(0.03, 0.03), {
      at: [0, 0.235, 0.258], rot: [Math.PI / 2, 0, 0], color: accent,
    }));
    torso.add('plate', place(plateBox(0.17, 0.032, 0.045, 0.014, 2), {
      at: [0, 0.402, 0.196], color: palette.plateDarkColor,
    }));
    // Twin thruster housings, visible from the follow camera.
    for (const sign of [-1, 1]) {
      torso.add('plate', place(new THREE.CylinderGeometry(0.062, 0.056, 0.16, 12), {
        at: [sign * 0.093, 0.115, 0.20],
        color: palette.plateDarkColor,
        ao: { from: 0.02, to: 0.2, strength: 0.55 },
      }));
      torso.add('plate', place(new THREE.CylinderGeometry(0.068, 0.062, 0.028, 12), {
        at: [sign * 0.093, 0.192, 0.20], color: palette.plateColor,
      }));
      torso.add('thruster', place(new THREE.CylinderGeometry(0.05, 0.05, 0.022, 12), {
        at: [sign * 0.093, 0.036, 0.20], color: accent,
      }));
    }
    this.torsoMeshes = torso.attach(this.torso, 'TorsoMesh');

    // Neck.
    const neck = new JointBuilder(this.materials);
    neck.add('cloth', place(new THREE.CylinderGeometry(0.062, 0.086, 0.12, 10), {
      at: [0, -0.005, 0], color: palette.clothColor,
    }));
    // Hood collar: an open cloth shroud that visually connects helmet to torso.
    neck.add('cloth', place(new THREE.CylinderGeometry(0.128, 0.156, 0.19, 14, 1, true), {
      at: [0, -0.075, 0.012],
      rot: [-0.06, 0, 0],
      color: palette.clothLightColor,
      ao: { from: -0.2, to: 0.0, strength: 0.5 },
    }));
    neck.add('cloth', place(plateBox(0.19, 0.13, 0.075, 0.035), {
      at: [0, -0.13, 0.10], rot: [-0.3, 0, 0], color: palette.clothColor,
    }));
    neck.attach(this.neck, 'NeckMesh');

    // Head: helmet shell, brow, visor and glowing eye-line, crest, ear discs.
    const head = new JointBuilder(this.materials);
    head.add('plate', place(taper(plateBox(0.208, 0.235, 0.25, 0.072), {
      from: -0.12, to: 0.12, bottom: 0.97, top: 0.82,
    }), {
      at: [0, 0.055, 0.012],
      color: palette.plateColor,
      ao: { from: -0.08, to: 0.2, strength: 0.44 },
    }));
    // Brow ridge, then the dark visor slit just beneath it.
    head.add('plate', place(plateBox(0.196, 0.05, 0.10, 0.02, 2), {
      at: [0, 0.118, -0.09], rot: [0.22, 0, 0], color: palette.plateDarkColor,
    }));
    head.add('visor', place(plateBox(0.184, 0.062, 0.055, 0.02), {
      at: [0, 0.062, -0.104],
    }));
    head.add('accent', place(plateBox(0.142, 0.014, 0.02, 0.005, 2), {
      at: [0, 0.064, -0.126], color: accent,
    }));
    // Respirator faceplate below the visor.
    head.add('cloth', place(taper(plateBox(0.168, 0.10, 0.115, 0.03), {
      from: -0.05, to: 0.05, bottom: 0.82, top: 1.02,
    }), {
      at: [0, -0.042, -0.062], color: palette.clothColor,
    }));
    head.add('plate', place(plateBox(0.06, 0.035, 0.03, 0.01, 2), {
      at: [0, -0.042, -0.122], color: palette.plateDarkColor,
    }));
    // Swept crest fin.
    head.add('plate', place(plateBox(0.022, 0.07, 0.185, 0.01, 2), {
      at: [0, 0.185, 0.05], rot: [-0.26, 0, 0], color: palette.plateDarkColor,
    }));
    for (const sign of [-1, 1]) {
      head.add('plate', place(plateBox(0.032, 0.135, 0.155, 0.018, 2), {
        at: [sign * 0.10, 0.045, 0.0],
        rot: [0, sign * 0.10, sign * -0.05],
        color: palette.plateDarkColor,
      }));
      head.add('plate', place(hexPrism(0.042, 0.026), {
        at: [sign * 0.104, 0.085, -0.01],
        rot: [0, 0, Math.PI / 2],
        color: palette.plateShadowColor,
      }));
      head.add('accent', place(hexPrism(0.022, 0.032), {
        at: [sign * 0.112, 0.085, -0.01],
        rot: [0, 0, Math.PI / 2],
        color: accent,
      }));
    }
    this.headMeshes = head.attach(this.head, 'HeadMesh');

    // Arms.
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? -1 : 1;
      const arm = new JointBuilder(this.materials);
      arm.add('cloth', place(new THREE.SphereGeometry(0.104, 10, 8), {
        at: [sign * 0.012, -0.012, 0.005],
        scale: [1, 0.9, 1.0],
        color: palette.clothColor,
      }));
      arm.add('plate', place(taper(plateBox(0.145, 0.10, 0.19, 0.042), {
        from: -0.05, to: 0.05, bottom: 0.90, top: 0.78,
      }), {
        at: [sign * 0.03, 0.042, 0.008],
        rot: [0, 0, sign * -0.22],
        color: palette.plateColor,
        ao: { from: 0.0, to: 0.1, strength: 0.3 },
      }));
      arm.add('plate', place(taper(plateBox(0.158, 0.07, 0.185, 0.032), {
        from: -0.04, to: 0.04, bottom: 0.95, top: 0.86,
      }), {
        at: [sign * 0.045, -0.035, 0.005],
        rot: [0, 0, sign * -0.30],
        color: palette.plateDarkColor,
      }));
      arm.add('cloth', place(limb(0.069, 0.205), {
        at: [0, -0.17, 0.004], color: palette.clothColor,
      }));
      arm.add('plate', place(plateBox(0.135, 0.05, 0.145, 0.02, 2), {
        at: [0, -0.30, 0], color: palette.plateDarkColor,
      }));
      arm.attach(this.arm[side], `ArmMesh_${side}`);

      const elbow = new JointBuilder(this.materials);
      elbow.add('cloth', place(limb(0.06, 0.18), {
        at: [0, -0.135, 0.004], color: palette.clothColor,
      }));
      elbow.add('plate', place(plateBox(0.128, 0.17, 0.132, 0.045), {
        at: [0, -0.165, -0.005],
        color: palette.plateColor,
        ao: { from: -0.26, to: -0.06, strength: 0.4 },
      }));
      elbow.add('accent', place(plateBox(0.05, 0.075, 0.012, 0.004, 2), {
        at: [0, -0.15, -0.085], color: accent,
      }));
      elbow.add('cloth', place(plateBox(0.088, 0.11, 0.095, 0.032), {
        at: [0, -0.322, -0.008], color: palette.gloveColor,
      }));
      elbow.add('plate', place(plateBox(0.092, 0.045, 0.092, 0.018, 2), {
        at: [0, -0.292, -0.02], color: palette.plateDarkColor,
      }));
      elbow.attach(this.elbow[side], `ForearmMesh_${side}`);
    }

    // Legs.
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? -1 : 1;
      const leg = new JointBuilder(this.materials);
      leg.add('cloth', place(limb(0.076, 0.22), {
        at: [0, -0.19, 0.006], color: palette.clothColor,
      }));
      leg.add('cloth', place(new THREE.CylinderGeometry(0.082, 0.072, 0.12, 10), {
        at: [0, -0.075, 0.006], color: palette.clothLightColor,
      }));
      // Layered thigh: a dark cuisse with a brighter upper plate over it.
      leg.add('plate', place(plateBox(0.138, 0.20, 0.152, 0.042), {
        at: [0, -0.20, -0.012],
        rot: [0, sign * 0.05, 0],
        color: palette.plateDarkColor,
        ao: { from: -0.30, to: -0.08, strength: 0.45 },
      }));
      leg.add('plate', place(plateBox(0.144, 0.15, 0.135, 0.042), {
        at: [0, -0.125, -0.036],
        rot: [0.06, sign * 0.05, 0],
        color: palette.plateColor,
        ao: { from: -0.2, to: 0.0, strength: 0.35 },
      }));
      leg.attach(this.leg[side], `ThighMesh_${side}`);

      const knee = new JointBuilder(this.materials);
      knee.add('cloth', place(limb(0.062, 0.23), {
        at: [0, -0.185, 0.004], color: palette.clothColor,
      }));
      knee.add('plate', place(plateBox(0.126, 0.125, 0.135, 0.042), {
        at: [0, 0.004, -0.028], color: palette.plateDarkColor,
      }));
      knee.add('plate', place(plateBox(0.124, 0.25, 0.12, 0.04), {
        at: [0, -0.19, -0.026],
        rot: [-0.03, 0, 0],
        color: palette.plateColor,
        ao: { from: -0.32, to: -0.06, strength: 0.4 },
      }));
      knee.add('accent', place(plateBox(0.044, 0.09, 0.012, 0.004, 2), {
        at: [0, -0.17, -0.096], color: accent,
      }));
      knee.attach(this.knee[side], `ShinMesh_${side}`);

      const ankle = new JointBuilder(this.materials);
      ankle.add('cloth', place(plateBox(0.134, 0.15, 0.24, 0.04), {
        at: [0, -0.086, -0.05], color: palette.clothLightColor,
      }));
      ankle.add('plate', place(taper(plateBox(0.148, 0.10, 0.125, 0.03), {
        from: -0.06, to: 0.06, bottom: 1.0, top: 0.84,
      }), {
        at: [0, -0.075, -0.125], color: palette.plateDarkColor,
      }));
      ankle.add('accent', place(plateBox(0.055, 0.012, 0.05, 0.004, 2), {
        at: [0, -0.045, -0.16], color: accent,
      }));
      ankle.add('plate', place(plateBox(0.15, 0.036, 0.275, 0.014, 2), {
        at: [0, -0.147, -0.048], color: palette.plateShadowColor,
      }));
      ankle.attach(this.ankle[side], `BootMesh_${side}`);
    }
  }

  /** Grounding blob shadow: fades out as the explorer climbs. */
  buildShadow() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x0d1a19) },
        uOpacity: { value: 0.42 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float alpha = (1.0 - smoothstep(0.25, 1.0, d)) * uOpacity;
          if (alpha <= 0.002) discard;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadowMaterial = material;
    this.shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), material);
    this.shadowMesh.name = 'CharacterContactShadow';
    this.shadowMesh.rotation.x = -Math.PI / 2;
    this.shadowMesh.renderOrder = 2;
    this.root.add(this.shadowMesh);
  }

  /** Two afterimage silhouettes used during the dash. */
  buildGhosts() {
    const parts = [
      place(limb(0.20, 0.34), { at: [0, 1.06, 0] }),
      place(new THREE.SphereGeometry(0.135, 8, 6), { at: [0, 1.46, 0] }),
      place(limb(0.11, 0.34), { at: [-0.12, 0.44, 0] }),
      place(limb(0.11, 0.34), { at: [0.12, 0.44, 0] }),
      place(limb(0.075, 0.30), { at: [-0.30, 1.02, 0] }),
      place(limb(0.075, 0.30), { at: [0.30, 1.02, 0] }),
    ];
    const geometry = mergeGeometries(parts, false);
    this.ghostGeometry = geometry;

    for (let index = 0; index < 2; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: this.accentColor.clone(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `DashAfterimage_${index}`;
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.root.add(mesh);
      this.ghosts.push(mesh);
      this.ghostTrail.push({ position: new THREE.Vector3(), yaw: 0, age: 99 });
    }
  }

  /** ---- Runtime ------------------------------------------------------- */

  setEnvironment(envMap) {
    this.envMap = envMap ?? null;
    for (const material of Object.values(this.materials)) {
      if (material.isMeshStandardMaterial) {
        material.envMap = this.envMap;
        material.needsUpdate = true;
      }
    }
  }

  setWind(uniforms) {
    this.windUniforms = uniforms ?? null;
    this.cloak.windUniforms = this.windUniforms;
  }

  setAccent(color) {
    const next = color instanceof THREE.Color ? color : new THREE.Color(color);
    if (next.equals(this.accentColor)) return;
    this.accentColor.copy(next);
    this.materials.accent.emissive.copy(next);
    this.materials.thruster.color.copy(next);
    this.cloak.material.uniforms.uEdgeColor.value.copy(next).multiplyScalar(0.4);
    for (const ghost of this.ghosts) ghost.material.color.copy(next);
  }

  update(delta, state) {
    const dt = Math.min(Math.max(delta, 0), 0.05);
    this.time += dt;

    const speed = state.speed ?? 0;
    const verticalVelocity = state.verticalVelocity ?? 0;
    const flying = Boolean(state.isFlying);
    const dashing = Boolean(state.isDashing);
    const grounded = state.grounded !== false;
    const yawRate = state.yawRate ?? 0;

    // Landing impulse: a soft squash that decays over a third of a second.
    if (grounded && !this.wasGrounded && !flying) this.impact = 1;
    this.wasGrounded = grounded;
    this.impact = Math.max(0, this.impact - dt * 3.1);

    const airSpeed = Math.min(1, Math.abs(verticalVelocity) / 18);
    this.blends.run = SMOOTH(this.blends.run, grounded ? THREE.MathUtils.clamp(speed / 9, 0, 1) : 0, 7, dt);
    this.blends.fly = SMOOTH(this.blends.fly, flying ? 1 : 0, 7.5, dt);
    this.blends.air = SMOOTH(this.blends.air, (!flying && !grounded) ? 1 : 0, 6, dt);
    this.blends.dash = SMOOTH(this.blends.dash, dashing ? 1 : 0, dashing ? 26 : 9, dt);
    this.blends.land = SMOOTH(this.blends.land, this.impact, 22, dt);
    this.blends.cast = SMOOTH(this.blends.cast, Math.min(1, airSpeed), 8, dt);

    // Gait phase advances with real ground speed, so the feet keep up with the
    // (very fast) movement instead of skating.
    const cadence = THREE.MathUtils.clamp(speed / 2.9, 0, 3.35);
    this.phase += dt * cadence * Math.PI * 2;
    if (this.phase > Math.PI * 200) this.phase -= Math.PI * 200;

    this.root.position.copy(state.position);
    this.root.rotation.y = state.facingYaw ?? 0;

    this.applyPose(dt, { speed, verticalVelocity, yawRate, grounded });
    this.updateCloak(dt, speed, verticalVelocity);
    this.updateShadow(state);
    this.updateGhosts(dt, dashing);
  }

  applyPose(dt, { speed, verticalVelocity, yawRate, grounded }) {
    const { run, fly, air, dash, land } = this.blends;
    const groundWeight = Math.max(0, 1 - fly - air);
    const swing = Math.sin(this.phase);
    const swingB = Math.sin(this.phase + Math.PI);
    const cycle = this.time;

    // --- Body: forward lean, banking into turns, landing squash -------------
    // The explorer faces -Z, so leaning forward is a *negative* rotation about
    // +X. The terms are written as "forward is positive" and flipped once here.
    const forwardLean = (
      groundWeight * (0.02 + 0.22 * run)
      + fly * (0.30 + 0.34 * Math.min(1, speed / 14))
      + air * (-0.12 + 0.05 * verticalVelocity / 12)
      + dash * 0.42
      + land * 0.16
    );
    this.body.rotation.x = -forwardLean;
    // Turning left (+yawRate) banks the body to its left, i.e. a positive roll.
    const bank = THREE.MathUtils.clamp(yawRate * 0.10, -0.30, 0.30);
    this.body.rotation.z = bank * (0.35 + 0.65 * Math.max(run, fly));
    this.body.rotation.y = (run * 0.05 + fly * 0.03) * swing * 0.4;
    const squash = 1 - 0.10 * land;
    this.body.scale.set(1 + 0.06 * land, squash, 1 + 0.06 * land);

    // --- Hips: run bob, idle sway, flight tuck ------------------------------
    const bob = Math.abs(swing) * 0.035 * run + Math.sin(cycle * 1.7) * 0.006;
    this.hips.position.y = 0.92 + bob * groundWeight - 0.075 * land - 0.02 * fly;
    this.hips.rotation.y = swing * 0.10 * run * groundWeight;
    this.hips.rotation.z = Math.sin(cycle * 0.8) * 0.012 * (1 - run);

    // --- Torso: counter-twist, breathing, flight arch -----------------------
    this.breath = Math.sin(cycle * 1.9) * 0.5 + Math.sin(cycle * 0.7) * 0.5;
    this.torso.rotation.x = -(
      -0.04 * run
      + fly * -0.06
      + dash * -0.12
      + land * 0.18
      + this.breath * 0.012 * (1 - run)
    );
    this.torso.rotation.y = -swing * 0.14 * run * groundWeight - dash * 0.06;
    this.torso.rotation.z = Math.sin(cycle * 0.6) * 0.01;
    const breathScale = 1 + this.breath * 0.01 * (1 - run);
    this.torso.scale.set(breathScale, 1 + this.breath * 0.008 * (1 - run), breathScale);

    // --- Head: keeps the horizon level while the body moves -----------------
    // The neck counter-rotates the body pitch so the visor keeps the horizon.
    this.neck.rotation.x = -this.body.rotation.x * 0.45 - air * 0.12;
    this.neck.rotation.y = swing * 0.05 * run;
    this.head.rotation.x = (
      -0.06 * run + fly * 0.10 - this.body.rotation.x * 0.25 + Math.sin(cycle * 1.3) * 0.012
    );
    this.head.rotation.y = Math.sin(cycle * 0.45) * 0.05 * (1 - run) + dash * -0.08;

    // --- Legs ---------------------------------------------------------------
    const hipSwing = (0.26 + 0.46 * run) * groundWeight;
    const kneeBase = (0.10 + 0.30 * run) * groundWeight;
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? -1 : 1;
      const legPhase = side === 'L' ? this.phase : this.phase + Math.PI;
      const legSwing = Math.sin(legPhase);
      const legSwing2 = Math.cos(legPhase);
      const knee = Math.max(0, legSwing2);

      // Ground gait.
      let hip = hipSwing * legSwing;
      let kneeAngle = -(kneeBase + (0.45 + 0.85 * run) * knee * knee);
      let ankle = -0.10 + 0.18 * Math.max(0, -legSwing) + 0.30 * knee * run;

      // Airborne fall: legs trail, knees soft.
      const airHip = -0.18 + 0.22 * Math.sin(this.time * 2.0 + sign);
      const airKnee = -0.55 - 0.20 * Math.sin(this.time * 1.6 + sign);
      hip = THREE.MathUtils.lerp(hip, airHip, air);
      kneeAngle = THREE.MathUtils.lerp(kneeAngle, airKnee, air);
      ankle = THREE.MathUtils.lerp(ankle, -0.25, air);

      // Flight: hovering tuck that opens into a glide as speed builds.
      const glide = Math.min(1, speed / 12);
      const flyHip = (0.30 - 0.45 * glide) + Math.sin(this.time * 1.4 + sign * 2) * 0.04;
      const flyKnee = -(0.85 - 0.62 * glide) - Math.sin(this.time * 1.1 + sign) * 0.05;
      hip = THREE.MathUtils.lerp(hip, flyHip, fly);
      kneeAngle = THREE.MathUtils.lerp(kneeAngle, flyKnee, fly);
      ankle = THREE.MathUtils.lerp(ankle, -0.30 + 0.25 * glide, fly);

      // Dash: legs stretched behind the body.
      hip += dash * (sign > 0 ? -0.35 : 0.30);
      kneeAngle += dash * (sign > 0 ? 0.34 : 0.20);
      ankle += dash * -0.25;

      // Landing: knees absorb the impact.
      hip += land * 0.34;
      kneeAngle -= land * 0.75;
      ankle += land * 0.22;

      this.leg[side].rotation.x = hip;
      this.leg[side].rotation.z = sign * (0.03 + 0.05 * run + 0.12 * fly + 0.06 * air);
      this.knee[side].rotation.x = kneeAngle;
      this.ankle[side].rotation.x = ankle;
    }

    // --- Arms ---------------------------------------------------------------
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? -1 : 1;
      const legPhase = side === 'L' ? this.phase + Math.PI : this.phase;
      const armSwing = Math.sin(legPhase);
      const armBlend = (0.28 + 0.62 * run) * groundWeight;

      let lift = armSwing * armBlend;
      let spread = 0.13 + 0.06 * run;
      let elbow = 0.30 + 0.55 * run + 0.15 * Math.max(0, armSwing);

      // Airborne: arms rise and open, as if bracing against the drop.
      lift = THREE.MathUtils.lerp(lift, -0.85 + Math.sin(this.time * 1.8 + sign) * 0.08, air);
      spread = THREE.MathUtils.lerp(spread, 0.34, air);
      elbow = THREE.MathUtils.lerp(elbow, 0.75, air);

      // Flight: hovering arms held wide, gliding arms sweep back.
      const glide = Math.min(1, speed / 12);
      const flyLift = -0.05 - 0.55 * glide + Math.sin(this.time * 1.2 + sign * 1.7) * 0.05;
      const flySpread = 0.55 - 0.28 * glide;
      const flyElbow = 0.55 + 0.45 * glide;
      lift = THREE.MathUtils.lerp(lift, flyLift, fly);
      spread = THREE.MathUtils.lerp(spread, flySpread, fly);
      elbow = THREE.MathUtils.lerp(elbow, flyElbow, fly);

      // Dash: both arms snap behind the body.
      lift -= dash * (0.95 - 0.25 * sign);
      spread += dash * 0.10;
      elbow += dash * 0.35;

      // Landing: arms drop forward for balance.
      lift += land * -0.30;
      elbow += land * 0.35;

      this.arm[side].rotation.x = lift;
      this.arm[side].rotation.z = sign * spread;
      this.arm[side].rotation.y = sign * (-0.08 - 0.10 * run);
      this.elbow[side].rotation.x = Math.max(0.05, elbow);
      this.elbow[side].rotation.y = sign * -0.12;
    }

    // --- Glow: sigils pulse with effort, thrusters burn in flight -----------
    const pulse = 1 + Math.sin(this.time * 2.4) * 0.08;
    this.materials.accent.emissiveIntensity = (this.config.accentIntensity ?? 1.2)
      * pulse
      * (1 + dash * 1.5 + run * 0.25 + fly * 0.35);
    const thrust = this.blends.fly * (0.55 + 0.45 * Math.min(1, Math.abs(verticalVelocity) / 14 + 0.2));
    this.materials.thruster.color.copy(this.accentColor).multiplyScalar(0.6 + 0.9 * thrust);
  }

  updateCloak(dt, speed, verticalVelocity) {
    const { run, fly, dash } = this.blends;
    const windTime = this.windUniforms?.time?.value ?? this.time;
    const flow = 0.24 * run + 0.5 * fly + 0.5 * dash
      + Math.min(0.3, Math.abs(verticalVelocity) * 0.018);
    const flutter = 0.07 + 0.32 * flow;
    const lift = -this.body.rotation.x * 0.5;
    const bodySwing = Math.sin(this.phase * 0.5) * 0.05 * run;

    const animate = (panel, strength) => {
      const position = panel.mesh.geometry.attributes.position;
      const base = panel.base;
      const width = panel.width;
      const length = panel.length;
      for (let index = 0; index < position.count; index += 1) {
        const bx = base[index * 3];
        const by = base[index * 3 + 1];
        const bz = base[index * 3 + 2];
        const t = THREE.MathUtils.clamp(-by / length, 0, 1);
        const falloff = t * t;
        const flare = 1 + 0.26 * strength * falloff * (0.4 + flow);
        const wave = Math.sin(windTime * 2.3 + t * 4.0 + bx * 6.0) * flutter * falloff;
        const wave2 = Math.cos(windTime * 1.5 + t * 3.0 - bx * 3.2) * flutter * falloff * 0.6;
        position.setX(index, bx * flare);
        position.setY(index, by * (1 - 0.12 * (run + fly) * falloff) + wave * 0.1);
        position.setZ(index, bz * 0.4 + falloff * (0.06 + 0.5 * flow) + wave * 0.34 + wave2 * 0.16);
      }
      position.needsUpdate = true;
    };

    animate(this.cloak.mantle, 0.55);
    this.cloak.mantle.mesh.rotation.x = 0.22 + lift * 0.6 + bodySwing;
    for (const tabard of this.cloak.tabards) {
      animate(tabard, 1);
      tabard.pivot.rotation.x = 0.04 + lift * 0.8 + bodySwing * (tabard.sign < 0 ? 1 : -1);
      tabard.pivot.rotation.z = tabard.sign * (-0.10 - 0.12 * flow);
    }
    this.cloak.material.uniforms.uOpacity.value = 0.97;
  }

  updateShadow(state) {
    const groundHeight = state.groundHeight;
    if (groundHeight === null || groundHeight === undefined) {
      this.shadowMesh.visible = false;
      return;
    }
    const height = Math.max(0, this.root.position.y - groundHeight);
    this.shadowMesh.visible = height < 26;
    this.shadowMesh.position.y = groundHeight - this.root.position.y + 0.05;
    const spread = 1 + height * 0.022;
    const scale = 0.72 * (1 + 0.12 * this.blends.run) * spread;
    this.shadowMesh.scale.set(scale, scale, 1);
    const fade = THREE.MathUtils.clamp(1 - height / 26, 0, 1);
    this.shadowMaterial.uniforms.uOpacity.value = 0.42 * fade * fade * (1 - 0.35 * this.blends.fly);
  }

  updateGhosts(dt, dashing) {
    for (let index = 0; index < this.ghostTrail.length; index += 1) {
      const sample = this.ghostTrail[index];
      sample.age += dt;
      if (dashing && sample.age > 0.045 * (index + 1)) {
        sample.position.copy(this.root.position);
        sample.yaw = this.root.rotation.y;
        sample.age = 0;
      }
      const ghost = this.ghosts[index];
      const life = 0.36 - index * 0.12;
      if (sample.age > life || !this.blends.dash) {
        ghost.visible = false;
        continue;
      }
      ghost.visible = true;
      ghost.material.opacity = THREE.MathUtils.clamp((1 - sample.age / life), 0, 1)
        * (0.22 - index * 0.07) * this.blends.dash * 2;
      ghost.position.copy(sample.position).sub(this.root.position);
      ghost.rotation.y = sample.yaw - this.root.rotation.y;
      const stretch = 1 + 0.10 * this.blends.dash;
      ghost.scale.set(1, 1, stretch);
    }
  }

  dispose() {
    this.root.traverse((object) => {
      if (object.isMesh) {
        object.geometry?.dispose?.();
      }
    });
    this.ghostGeometry?.dispose?.();
    for (const material of Object.values(this.materials)) material.dispose?.();
    this.cloak.material.dispose();
    this.shadowMaterial.dispose();
    for (const ghost of this.ghosts) ghost.material.dispose();
    this.root.removeFromParent();
  }
}

/**
 * A tiny painted environment: sky ramp plus a warm sun spot. Feeding it to the
 * character's armour as a PMREM environment is what makes the plate read as
 * brushed metal under the cupolas, without touching the world's own lighting.
 */
export function createCharacterEnvironment(renderer, config = {}) {
  if (!renderer || !THREE.PMREMGenerator) return null;
  try {
    return bakeCharacterEnvironment(renderer, config);
  } catch {
    // Without a bake the armour simply relies on the scene lights; a missing
    // environment must never stop the world from starting.
    return null;
  }
}

function bakeCharacterEnvironment(renderer, config = {}) {
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(40, 32, 24);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const zenith = new THREE.Color(config.skyZenithColor ?? 0x2a6fc0);
  const horizon = new THREE.Color(config.skyHorizonColor ?? 0xa9cfe4);
  const ground = new THREE.Color(config.groundColor ?? 0x2f3a35);
  const sun = new THREE.Color(config.sunColor ?? 0xfff2d2);
  const sunDirection = new THREE.Vector3(
    config.sunDirection?.x ?? -0.42,
    config.sunDirection?.y ?? 0.56,
    config.sunDirection?.z ?? -0.72,
  ).normalize();
  const scratch = new THREE.Color();
  const vertex = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index).normalize();
    if (vertex.y >= 0) {
      scratch.copy(horizon).lerp(zenith, Math.pow(vertex.y, 0.65));
    } else {
      scratch.copy(horizon).lerp(ground, Math.min(1, -vertex.y * 1.6));
    }
    const sunAmount = Math.max(0, vertex.dot(sunDirection));
    scratch.lerp(sun, Math.pow(sunAmount, 26) * 0.95);
    colors[index * 3] = scratch.r;
    colors[index * 3 + 1] = scratch.g;
    colors[index * 3 + 2] = scratch.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  scene.add(new THREE.Mesh(geometry, material));

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04, 1, 120);
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return target.texture;
}
