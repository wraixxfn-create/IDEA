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
  wallHeight: 30,
  wallThickness: 5,
  gateWidth: 22,
  gateFrameWidth: 3.6,
  cornerOverlap: 3,
  floorColor: 0xd99b26,
  wallColor: 0x545d61,
  gateFrameColor: 0x22272a,
  gateTrimColor: 0x161a1c,
  gateGlowColor: 0x38bdf8,
  backgroundColor: 0x7b888c,
  sectorColors: SECTOR_COLORS,
});

export const PLAYER_CONFIG = Object.freeze({
  radius: 0.72,
  height: 1.8,
  eyeHeight: 1.64,
  walkSpeed: 10,
  sprintSpeed: 16,
  gravity: 28,
  mouseSensitivity: 0.0021,
  maxPitch: Math.PI / 2 - 0.045,
});
