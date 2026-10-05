export const MAP_CONFIG = Object.freeze({
  // Radius is measured from the center of a sector to one of its six vertices.
  // At 220 units, each empty sector covers about 0.13 square kilometres.
  hexRadius: 220,
  floorHeight: 0,
  wallHeight: 30,
  wallThickness: 5,
  gateWidth: 68,
  gateFrameWidth: 3.6,
  cornerOverlap: 3,
  floorColor: 0x92999a,
  wallColor: 0x747d80,
  gateFrameColor: 0xb4babc,
  backgroundColor: 0x899497,
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
