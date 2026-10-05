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
    color: 0x7e22ce, // Imperial Amethyst / Royal Purple
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
  wallColor: 0x545d61,
  gateFrameColor: 0x22272a,
  backgroundColor: 0x7b888c,
  sectorColors: SECTOR_COLORS,
});

export const PLAYER_CONFIG = Object.freeze({
  radius: 0.62,
  height: 1.8,
  avatarWidth: 0.56,
  avatarDepth: 0.42,
  avatarColor: 0xf1e7d4,
  avatarEmissive: 0x172320,
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
  // The small pole buffer prevents the follow camera from flipping at 90°,
  // while still allowing a full look from nearly straight up to nearly straight down.
  minPitch: -Math.PI / 2 + 0.025,
  maxPitch: Math.PI / 2 - 0.025,
  cameraDistance: 10,
  minCameraDistance: 5,
  maxCameraDistance: 17,
  cameraTargetHeight: 1.05,
  zoomStep: 0.9,
});
