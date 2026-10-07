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
  // --- HEX_S wildlife -----------------------------------------------------
  // A busy mixed flock: chaffinches and great tits moving through the
  // understorey, with several jays ranging across the sector. They are never
  // colliders — they get out of the explorer's way long before a collision.
  forestBirdsEnabled: true,
  forestBirdCount: 32,
  forestBirdSpecies: Object.freeze(['chaffinch', 'tit', 'jay']),
  // Birds stay under the canopy: the mist, the trunks and the explorer all live
  // below this, and a bird above it would be flying through the dome.
  forestBirdCeiling: 28,
  windStrength: 1,
  forestLightColors: Object.freeze([0xd4c98a, 0xf5d6a0, 0xa8c490]),
  forestLightIntensity: 0.52,

  // --- HEX_S rain ---------------------------------------------------------
  // The forest is the only sector with weather. The field is a seeded scatter
  // of falling streaks (src/world/Rain.js) planted on the baked terrain — each
  // drop knows the height it lands on — plus the impact ripples that answer it
  // on the floor. Both are animated entirely in the vertex shader from one
  // clock, so a whole-sector downpour costs two draw calls and one uniform
  // update per frame. Set `forestRainEnabled: false` (or call
  // `world.setRainEnabled(false)`) to clear the sky over the wood.
  forestRainEnabled: true,
  // ~34 k columns over the 0.13 km² sector: heavy, steady rain near the lens
  // without turning the whole hex into a wall of white.
  forestRainStreakCount: 34000,
  forestRainRippleCount: 5200,
  // A drop falls this far, from `ground + fallRange` down to the ground itself.
  forestRainFallRange: 120,
  // World units per second at speed 1 — around 46 u/s is a real downpour.
  forestRainSpeed: 46,
  // How far a drop drifts sideways over a full fall, and the lean it gives the
  // streak. Kept in step with the wind so the rain reads as the same weather.
  forestRainDrift: Object.freeze({ x: 9, z: 4 }),
  forestRainLength: 1.6,
  forestRainWidth: 0.05,
  forestRainOpacity: 0.34,
  forestRainColor: 0xdff1ff,
  // Drops and ripples fade out past these distances, so the cost (and the
  // white) stays where the eye is instead of over the whole sector.
  forestRainCameraRadius: 68,
  forestRainRippleRadius: 0.62,
  forestRainRippleRate: 1.05,
  forestRainRippleCameraRadius: 34,
  forestRainRippleOpacity: 0.5,
  forestRainRippleColor: 0xcfe9f4,
  // Wet soil: rain darkens the floor and takes the matte off it.
  forestRainWetRoughness: 0.72,
  forestRainWetDarkening: 0.82,

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

  // --- HEX_SE volcanic ground --------------------------------------------
  // The southeast sector carries a large volcanic landscape baked from the
  // same hexagonal lattice engine as the forest floor (a ForestTerrain
  // subclass, src/world/VolcanicTerrain.js): one major elevated massif
  // carrying the sector's single main crater, one lower basin, fissure ridges,
  // rocky patches and shallow depressions over broad, walkable ash plains.
  // The rim — and a radial apron around every gate — fades back to the exact
  // shared floor height, so the sector stays seamless with its neighbours and
  // every entrance stays level.
  //
  // What that ground is *made of* is the volcanic material palette
  // (src/world/VolcanicMaterials.js): six materials and no more — dark
  // volcanic soil on the open plains, black basalt wherever the ground tips
  // or a vent has blown it open, dark ash on the high flats, cooled lava over
  // the crater floor and everywhere the lava has run, a narrow margin of
  // slightly reddish heated rock against the molten rock, and the molten lava
  // itself, which stays the one bright element of the sector. They are mixed
  // per vertex from the relief that is already baked, so the palette adds no
  // geometry, no props, no particles and no gameplay effect.
  //
  // `volcanicRockColor` is the tint multiplied over that whole mix (white
  // leaves the palette exactly as authored) and `volcanicRockDarkColor` is the
  // basalt band around the sector's rim. `volcanicHeatColor` /
  // `volcanicHeatIntensity` are the faint emission the heated rock carries —
  // deliberately a fraction of the lava's, so nothing competes with it.
  volcanicRockColor: 0xffffff,
  volcanicRockDarkColor: 0x191b1f,
  volcanicHeatColor: 0xff3c0a,
  volcanicHeatIntensity: 0.22,
  // 64 divisions keeps the lattice light (~15.7k vertices, ~24.6k faces —
  // under half the forest's density) while resolving features that are tens
  // of units across.
  volcanicTerrainDivisions: 64,
  volcanicTerrainAmplitude: 18,
  volcanicTerrainEdgeBlend: 44,
  // Same walkability guarantee as the forest: no baked face may tilt more
  // than this, so the whole landscape is crossed on foot.
  volcanicTerrainMaxSlopeDeg: 25,
  volcanicTerrainRelax: 3,
  volcanicTerrainBaseScale: 168,
  volcanicTerrainOctaves: 4,
  volcanicTerrainGain: 0.5,
  volcanicTerrainLacunarity: 2.05,
  volcanicTerrainWarp: 24,
  volcanicTerrainSeed: 0xba5a1700,
  // Six static, large-scale basalt formations act as isolated landmarks in
  // HEX_SE. They are visual props seated on the baked relief; this switch only
  // adds or removes those formations and never changes the terrain or lava.
  volcanicFormationsEnabled: true,
  // The medium rock layer (src/world/VolcanicRocks.js): a limited, seeded
  // collection of knee- to chest-high rocks built from twelve shared
  // geometries and drawn as instanced meshes. It gathers around the crater
  // rim, the six formations, the slopes and the lava banks, and it keeps the
  // portal aprons, the direct routes, the crater floor and the open plains
  // clear. This switch only adds or removes those rocks: nothing is carved, no
  // collider is added, and the terrain, vents, lava and cooled crust are
  // untouched. The scatter's own numbers (count, sizes, zone weights, bands,
  // clearances, seed) are plain data in `VOLCANIC_ROCK_DEFAULTS` and can be
  // overridden through `volcanicRocks`.
  volcanicRocksEnabled: true,
  // The small debris layer of HEX_SE (src/world/VolcanicDebris.js): the chips,
  // broken basalt fragments, little stones and volcanic rubble that gather
  // along the crater's edges, at the feet of the six large formations, on the
  // banks of the lava channels and on ground steep enough to hold scree. It is
  // a low-density scatter with a hard per-cell cap, built from twelve shared
  // geometries drawn as instances, so it never turns the ground into rubble.
  // Like the medium rocks it only adds static, non-colliding props: no carve,
  // no gameplay system, and the terrain, vents, lava and cooled crust are
  // untouched. Its own numbers (count, sizes, zone weights, bands, clearances,
  // seed) are plain data in `VOLCANIC_DEBRIS_DEFAULTS` and can be overridden
  // through `volcanicDebris`; `volcanicDebrisEnabled: false` (or
  // `volcanicDebris: false` / `null`) removes the layer without a trace.
  volcanicDebrisEnabled: true,
  // Flat approach kept clear around each portal centre: fully flat inside
  // `inner`, relief back in full by `outer` (sector-local units).
  volcanicGateApronInner: 19,
  volcanicGateApronOuter: 58,
  // The feature layout itself (cone, crater, basin, ridges, rocks, pits) is
  // plain data in VolcanicTerrain.js (`DEFAULT_VOLCANIC_LAYOUT`) and can be
  // overridden per sector through `volcanicFeatures` — the main crater's vent,
  // rim radius, crest and depth ride in there with everything else.
  // --- HEX_SE lava ---------------------------------------------------------
  // The sector's single lava pool (src/world/LavaPool.js): one level sheet of
  // molten rock in the floor of the main crater, its outline where the baked
  // crater bowl crosses it, ringed by the cooled bank of crust it threw up
  // around its own edge. One main flow leaves the pool for the lower basin;
  // one much narrower branch leaves that channel for a southern low hollow.
  // Both flows are inert: no animation, particles, smoke, light or damage.
  // `lavaPool` is plain data (placement, depth, bank, mesh resolution) and
  // `false` removes the pool outright; `lavaPoolEnabled: false` does the same
  // from the switchboard. The material below is reusable on purpose: any later
  // lava feature drawn with `createLavaMaterial(config)` shares this look.
  lavaPoolEnabled: true,
  lavaPool: Object.freeze({
    // Sector-local placement: a few units south-west of the crater's vent
    // (38, 84), over the deepest ground of the bowl, so the lake pools against
    // one side of the crater instead of sitting dead centre in it.
    x: 34,
    z: 79,
    radius: 26,
    // The basin the pool fills, the depth of the molten rock itself, and the
    // cooled bank it has raised around its own edge — all fractions of
    // `volcanicTerrainAmplitude`, so the pool grows with the landscape like the
    // crater and the vents do.
    basin: 0.155,
    depth: 0.035,
    bank: 0.075,
    segments: 160,
    rings: 28,
  }),
  // The main outlet begins in the existing pool and runs through the
  // northwest saddle toward the lower basin.
  lavaFlowEnabled: true,
  lavaFlow: Object.freeze({ width: 9, depth: 0.38 }),
  // A single slimmer branch leaves the main channel toward the southern low
  // hollow. Disable this switch to keep the pool and main flow unchanged.
  lavaSecondaryFlowEnabled: true,
  lavaSecondaryFlow: Object.freeze({ width: 2.8, depth: 0.28 }),
  // The lava material itself: a static, emissive, vertex-coloured surface. The
  // sheet's own vertex colours carry the heat (dark crust at the margin, molten
  // rock in the middle, rafts of cooled skin between) and `lavaCrustTile` is
  // the seamless crust pattern laid over it — bright plates with glowing seams
  // — repeated every `lavaCrustTile` units. The tile multiplies both the albedo
  // and the emission, so it stays bright: `lavaEmissiveIntensity` is what keeps
  // the pool bright without turning it into a lamp — it is tuned to read as
  // molten rock under the sector's own sun and sky, not to light them.
  lavaColor: 0xffffff,
  lavaEmissiveColor: 0xffe3c2,
  lavaEmissiveIntensity: 1,
  lavaRoughness: 0.86,
  lavaMetalness: 0.03,
  lavaCrustTile: 19,
  lavaCrustCells: 7,
  lavaCrustTextureSize: 256,
  lavaCrustSeed: 0x1a7a5eed,
  // The cooled crust on the *ground* around that lava (src/world/CooledCrust.js):
  // dark black plates, cracked sections between them and a dull red heat that
  // survives next to the molten rock. It is measured from the lava that already
  // exists — the pool's own shoreline and both channel spines — and it is drawn
  // by the sector's own rock material on the sector's own mesh, so it adds no
  // geometry, no draw call, no rock props, no light, no animation and no
  // gameplay effect. `cooledCrustEnabled: false` (or `cooledCrust: false`)
  // leaves the ground exactly as the bake before it made it; disabling the lava
  // it belongs to removes it too. The band widths, the plate break-up and the
  // heat are plain data in `COOLED_CRUST_DEFAULTS`, overridable per sector
  // through `cooledCrust`.
  cooledCrustEnabled: true,
  cooledCrust: Object.freeze({
    // How far the crust crawls out of the lava, and how much of that run it
    // spends breaking into plates instead of lying as one sheet (sector units).
    pool: Object.freeze({ reach: 13, heatReach: 6.5 }),
    channel: Object.freeze({ reach: 3.2, reachPerWidth: 0.75, heatReach: 3.6 }),
    branch: Object.freeze({ reach: 1.6, reachPerWidth: 0.95, heatReach: 2.5 }),
  }),
  // The crust's own look: one seamless tile pair (dark plates for the albedo,
  // warm cracks for the emission), repeated every `cooledCrustTile` units.
  // `cooledCrustWarmth` is multiplied into the crust where it is still hot, and
  // `cooledCrustRoughness` is the glassier finish a chilled skin has over ash.
  cooledCrustColor: 0xffffff,
  cooledCrustWarmth: 0xffa070,
  cooledCrustEmissive: 0xff4d10,
  cooledCrustEmissiveIntensity: 0.5,
  cooledCrustRoughness: 0.74,
  cooledCrustTile: 12,
  cooledCrustCells: 5,
  cooledCrustTextureSize: 256,
  cooledCrustSeed: 0xc001ed5,
  // The small vents that are cut into that landscape afterwards are plain data
  // too (`DEFAULT_VOLCANIC_VENTS` in src/world/VolcanicVents.js): seven seeded
  // openings — round throats, a shallow silted dish and two narrow cracks —
  // each one confined to its own footprint and authored under the walkable
  // slope limit, so they reshape their own patch of ground and nothing else.
  // `volcanicVents` replaces that list (`[]` leaves the field vent-free).
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
  // One press of Space jumps: `jumpSpeed` 10.5 against `gravity` 28 clears a
  // little under two units and lands in about three quarters of a second.
  jumpSpeed: 10.5,
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
