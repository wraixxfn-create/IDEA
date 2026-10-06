export const SECTOR_DEFINITIONS = Object.freeze({
  HEX_CENTER: Object.freeze({
    id: 'HEX_CENTER',
    name: 'Amber Core',
    color: 0xd99b26, // Radiant Solar Amber / Gold
    accent: 0xfde047,
  }),
  HEX_N: Object.freeze({
    id: 'HEX_N',
    name: 'Cobalt North',
    color: 0x1d63b8, // Royal Cobalt Blue
    accent: 0x60a5fa,
  }),
  HEX_NE: Object.freeze({
    id: 'HEX_NE',
    name: 'Emerald Northeast',
    color: 0x16803d, // Rich Emerald / Viridian Green
    accent: 0x4ade80,
  }),
  HEX_SE: Object.freeze({
    id: 'HEX_SE',
    name: 'Crimson Southeast',
    color: 0xb91c1c, // Crimson / Venetian Red
    accent: 0xf87171,
  }),
  HEX_E: Object.freeze({
    id: 'HEX_E',
    name: 'Glacier East',
    color: 0x0284c7,
    accent: 0x38bdf8,
  }),
  HEX_S: Object.freeze({
    id: 'HEX_S',
    name: 'Amethyst South',
    // HEX_S is now the forest biome: the sector colour is kept as a violet
    // accent for portals, while its floor is replaced by soil and leaf litter.
    color: 0x574034,
    accent: 0xc084fc,
  }),
  HEX_SW: Object.freeze({
    id: 'HEX_SW',
    name: 'Turquoise Southwest',
    color: 0x0d9488, // Radiant Turquoise / Cyan
    accent: 0x2dd4bf,
  }),
  HEX_NW: Object.freeze({
    id: 'HEX_NW',
    name: 'Terracotta Northwest',
    color: 0xc2410c, // Warm Terracotta / Spiced Rust
    accent: 0xfb923c,
  }),
});

export const SECTOR_COLORS = Object.freeze(
  Object.fromEntries(Object.values(SECTOR_DEFINITIONS).map((s) => [s.id, s.color]))
);

export const EXPANDED_PALETTE = Object.freeze([
  0xd99b26, // Amber Gold
  0x1d63b8, // Cobalt Azure
  0x16803d, // Emerald Green
  0xb91c1c, // Crimson Red
  0x7e22ce, // Amethyst Purple
  0x0d9488, // Turquoise Cyan
  0xc2410c, // Terracotta Orange
  0x0284c7, // Sky Blue
  0xca8a04, // Yellow Ochre
  0x4f46e5, // Indigo
  0x059669, // Jade
  0xdb2777, // Rose Pink
]);

export function getSectorColor(sectorId, order = 0) {
  if (SECTOR_DEFINITIONS[sectorId]) {
    return SECTOR_DEFINITIONS[sectorId].color;
  }
  return EXPANDED_PALETTE[order % EXPANDED_PALETTE.length];
}

export function getSectorInfo(sectorId, order = 0) {
  if (SECTOR_DEFINITIONS[sectorId]) {
    return SECTOR_DEFINITIONS[sectorId];
  }
  const color = EXPANDED_PALETTE[order % EXPANDED_PALETTE.length];
  return {
    id: sectorId,
    name: `Sector ${sectorId}`,
    color,
    accent: color,
  };
}

export const MAP_CONFIG = Object.freeze({
  // Radius is measured from the center of a sector to one of its six vertices.
  // At 220 units, each empty sector covers about 0.13 square kilometres.
  hexRadius: 220,
  floorHeight: 0,
  wallHeight: 45,
  wallThickness: 5,
  gateWidth: 26,
  gateFrameWidth: 2.1,
  gateOpeningHeight: 32,
  doorOpenRadius: 48,
  doorCloseDelay: 1.05,
  doorMotionSpeed: 3.2,
  cornerOverlap: 3,
  floorColor: 0xd99b26,
  // Forest-biome materials for HEX_S. The soil remains visible between the
  // thousands of low-poly leaves scattered over the uneven ground. Darker
  // tones sell the enclosed, canopy-shaded feel of a real woodland floor.
  forestSoilColor: 0x3e2d1e,
  forestSoilDarkColor: 0x2a1e14,
  forestLeafColors: Object.freeze([
    0x8a5730, 0xa06b34, 0xc08a45, 0x5d7a37, 0xb08d4a,
  ]),
  // The canopy is deliberately heavy: four times the leaf litter, three times
  // the trunks and a dense mid-storey of young pines between the eighteen
  // mature spruces that were already standing here.
  forestLeafCount: 16000,
  forestTreeCount: 170,
  // Of the 170 trunks, the eighteen authored spruces stay as they were and the
  // next `forestYoungTreeCount` are full young pines; everything that is left
  // fills the gaps as saplings. A young pine costs about a fifth of a mature
  // tree, so the wood can be this thick without the needle budget exploding.
  forestYoungTreeCount: 54,
  // Trunk-to-trunk spacing of the filler scatter. 15 units packs a real wood
  // while still leaving lanes the explorer can read a path through.
  forestTreeSpacing: 15,
  wallColor: 0x545d61,
  gateFrameColor: 0x22272a,
  backgroundColor: 0x8fb6c6,
  // Every cell is capped by a curved hexagonal cupola whose spring line sits on
  // the top of its 45-unit wall. The shell is opaque and painted with a real
  // sky; the cupolas are visual only, never colliders.
  domeBaseHeight: 45,
  domeHeight: 150,
  domeRadialSegments: 16,
  domeVerticalSegments: 12,
  domeColor: 0x8cc9c0,
  domeRibColor: 0xe6f6ee,
  domeRibOpacity: 0.32,

  // --- Sun and sky -------------------------------------------------------
  // One sun lights the whole world, so the painted sky, the cloud deck and the
  // directional key light always agree on where the light comes from.
  sunDirection: Object.freeze({ x: -0.42, y: 0.56, z: -0.72 }),
  sunColor: 0xfff2d2,
  sunIntensity: 1.18,
  sunAmbientColor: 0xd7eee4,
  groundBounceColor: 0x2c3a33,
  sunGlowStrength: 0.95,
  skyZenithColor: 0x2a6fc0,
  skyHorizonColor: 0xa9cfe4,
  skyHazeColor: 0xe6eff3,
  // How far each cupola's sky drifts towards its own sector accent.
  skyTintStrength: 0.24,
  cloudLightColor: 0xfffaf1,
  cloudShadowColor: 0xa9bfd0,
  cloudCoverage: 0.28,
  cloudSoftness: 0.08,
  cloudStrength: 0.85,
  cloudScale: 1.25,
  cloudDriftSpeed: 0.012,
  cloudDeckDriftSpeed: 0.0075,
  cloudCount: 10,
  // The deck rides low and wide: from the floor of a sector the sky is a band
  // between the wall tops and about forty degrees of elevation, and that band
  // is where the clouds have to be.
  cloudAltitudeMin: 58,
  cloudAltitudeMax: 104,
  cloudRadiusFactor: 0.74,
  cloudMinRadiusFactor: 0.28,

  // HEX_S is the showcase biome: a denser cloud deck, a stronger halo and a
  // mist layer drifting between the trunks. The canopy coverage is higher and
  // the sky is heavily filtered, so the dome reads as foliage from below.
  forestCloudCount: 18,
  forestCloudCoverage: 0.62,
  forestCloudSoftness: 0.055,
  forestCloudStrength: 0.72,
  forestSunGlowStrength: 0.55,
  forestMistColor: 0xb8d4c2,
  // Eight stacked, drifting layers of ground fog: thick enough to pool in the
  // hollows, to hang between the trunks and to swallow the undergrowth in the
  // distance, while the crowns still break through it. Each layer carries its
  // own noise phase, so the stack reads as one rolling volume of mist rather
  // than as eight sheets of glass.
  forestMistOpacity: 0.46,
  forestMistLayers: 8,
  // The relief rolls between about -11 and +7, so the stack starts just above
  // the soil, pools in the hollows and climbs into the lower canopy.
  forestMistHeight: 1.9,
  forestMistSpacing: 2.05,
  forestMistDriftSpeed: 0.026,
  // Undergrowth scattered across the seeded soil of the forest floor.
  forestGrassCount: 7200,
  forestShrubCount: 540,
  forestRockCount: 150,
  forestLogCount: 56,
  // Fallen branches and broken boughs lying among the logs. The wood is thick
  // enough now that the floor has to be as busy as the canopy above it.
  forestBranchCount: 760,
  forestMushroomCount: 260,
  windStrength: 1,
  forestLightColors: Object.freeze([0xd4c98a, 0xf5d6a0, 0xa8c490]),
  forestLightIntensity: 0.52,

  // --- HEX_S ground model -----------------------------------------------
  // The forest floor is a baked triangular lattice (src/world/ForestTerrain.js).
  // The mesh the player sees and the surface the player stands on are read
  // from the same baked heights, so the ground can never be walked through.
  // `divisions` is the number of cells along one hex side: 96 gives ~2.3-unit
  // cells, about 28k vertices and 55k faces for the whole sector.
  forestTerrainDivisions: 96,
  forestTerrainAmplitude: 15,
  forestTerrainBaseScale: 155,
  forestTerrainOctaves: 5,
  forestTerrainGain: 0.36,
  forestTerrainLacunarity: 2.03,
  forestTerrainWarp: 34,
  forestTerrainRelax: 3,
  // No rendered face may tilt more than this, so every hollow and crown of
  // the relief stays walkable instead of trapping or launching the explorer.
  forestTerrainMaxSlopeDeg: 30,
  forestTerrainEdgeBlend: 46,
  forestTerrainSeed: 0x5eed1eaf,
  sectorColors: SECTOR_COLORS,
});

export const PLAYER_CONFIG = Object.freeze({
  radius: 0.62,
  height: 1.8,
  // The explorer avatar is a fully articulated character rig; this block is
  // the palette it is built from (see src/player/CharacterRig.js). The sigil,
  // thruster glow and cloth trim are retinted per sector at runtime.
  character: Object.freeze({
    plateColor: 0xc9d3d0,
    plateDarkColor: 0x71828a,
    plateShadowColor: 0x3b4a4f,
    clothColor: 0x243136,
    clothLightColor: 0x384b51,
    gloveColor: 0x1a2326,
    accentColor: 0x7ef0d8,
    capeColor: 0x3d525b,
    skyLiftColor: 0x27383c,
    skyLiftIntensity: 0.62,
    clothLiftColor: 0x1b2a2e,
    clothLiftIntensity: 0.6,
  }),
  walkSpeed: 10,
  dashSpeed: 42,
  dashDuration: 0.22,
  dashCooldown: 0.65,
  gravity: 28,
  flightSpeed: 24,
  flightTakeoffSpeed: 14,
  flightAcceleration: 8,
  doubleTapWindowMs: 340,
  mouseSensitivity: 0.0021,
  initialCameraPitch: 0.28,
  // In flight the follow camera can still approach either pole. On the ground,
  // PlayerController dynamically raises the lower pitch limit to keep the
  // camera above the map floor and out of the hex undersides.
  minPitch: -Math.PI / 2 + 0.025,
  maxPitch: Math.PI / 2 - 0.025,
  cameraDistance: 10,
  cameraTargetHeight: 1.05,
  // The follow camera is lifted this far above the terrain, and the whole
  // boom is tested against the relief, so banks behind the explorer push the
  // lens up instead of burying it in the dirt.
  cameraFloorClearance: 1.15,
  cameraClearanceSamples: 5,
  cameraPitchFloorClearance: 0.35,
  // --- First person -------------------------------------------------------
  // 'third' orbits the explorer, 'first' mounts the camera behind the visor.
  // V switches between them at any time (see src/main.js).
  initialViewMode: 'third',
  firstPersonEyeHeight: 1.63,
  // How far in front of the chest the first-person lens sits.
  firstPersonEyeForward: 0.34,
  firstPersonBob: 0.042,
  // --- Terrain contact ----------------------------------------------------
  // How far the explorer may be pulled back down onto a slope that rolls away
  // underfoot before the drop counts as a real fall. The stride multiplier
  // keeps dashes glued to the ground as well.
  groundSnapDistance: 0.5,
  groundSnapSlope: 1.6,
});
