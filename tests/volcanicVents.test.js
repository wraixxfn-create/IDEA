import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG, PLAYER_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { VolcanicTerrain, DEFAULT_VOLCANIC_LAYOUT } from '../src/world/VolcanicTerrain.js';
import {
  DEFAULT_VOLCANIC_VENTS,
  planVolcanicVentLayout,
  ventReliefAt,
} from '../src/world/VolcanicVents.js';
import { buildHexMapData } from '../src/world/hexGrid.js';
import { distanceToHexEdge } from '../src/world/ForestTerrain.js';
import { installCanvasStub, installInputStub } from './domStub.js';
import { PlayerController } from '../src/player/PlayerController.js';

installCanvasStub();
installInputStub();

const RADIUS = MAP_CONFIG.hexRadius;
const AMPLITUDE = MAP_CONFIG.volcanicTerrainAmplitude ?? 18;
const CRATER = DEFAULT_VOLCANIC_LAYOUT.crater;
const CRATER_FOOTPRINT = CRATER.rimRadius * CRATER.capOuter;

/** The four portal centres of HEX_SE, in sector-local coordinates. */
function hexSeGateAprons() {
  const data = buildHexMapData(RADIUS);
  const sector = data.byId.get('HEX_SE');
  return data.sharedEdges
    .filter((gate) => gate.aSectorId === 'HEX_SE' || gate.bSectorId === 'HEX_SE')
    .map((gate) => ({
      x: gate.center.x - sector.center.x,
      z: gate.center.z - sector.center.z,
    }));
}

function makeTerrain(config = MAP_CONFIG) {
  return new VolcanicTerrain({
    radius: RADIUS,
    config,
    sectorId: 'HEX_SE',
    gateAprons: hexSeGateAprons(),
  });
}

const VENTS = planVolcanicVentLayout(MAP_CONFIG);
const NO_VENTS = { ...MAP_CONFIG, volcanicVents: [] };
const PLAIN = makeTerrain(NO_VENTS);

/** The point of a vent's spine (or its centre) nearest to a sample. */
function ventCorePoints(vent, samples = 24) {
  if (!vent.spine) return [{ x: vent.x, z: vent.z }];
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const along = t * (vent.spine.segments.length);
    const segment = vent.spine.segments[Math.min(vent.spine.segments.length - 1, Math.floor(along))];
    const local = along - Math.floor(along);
    points.push({
      x: segment.ax + segment.dx * local,
      z: segment.az + segment.dz * local,
    });
  }
  return points;
}

/** How deep the ground of a baked terrain sits below the vent-free ground. */
function ventDepth(terrain, vent) {
  let deepest = 0;
  for (const point of ventCorePoints(vent)) {
    const drop = PLAIN.heightAt(point.x, point.z) - terrain.heightAt(point.x, point.z);
    deepest = Math.max(deepest, drop);
  }
  return deepest;
}

/** How high the ground is lifted above the vent-free ground on a ring. */
function ventRim(terrain, vent, radius = vent.radius) {
  let highest = -Infinity;
  let lowest = Infinity;
  let sum = 0;
  const samples = 96;
  for (let k = 0; k < samples; k += 1) {
    const a = (k / samples) * Math.PI * 2;
    const x = vent.x + Math.cos(a) * radius;
    const z = vent.z + Math.sin(a) * radius;
    const lift = terrain.heightAt(x, z) - PLAIN.heightAt(x, z);
    highest = Math.max(highest, lift);
    lowest = Math.min(lowest, lift);
    sum += lift;
  }
  return { highest, lowest, mean: sum / samples };
}

let sharedMap = null;
function map(config = MAP_CONFIG) {
  if (!sharedMap) sharedMap = new HexMap(new THREE.Scene(), config);
  return sharedMap;
}

test('HEX_SE carries a handful of small vents, every one of them inside the sector', () => {
  const terrain = makeTerrain();
  const vents = terrain.vents;

  // "A small number": five to eight openings, not a field of them.
  assert.ok(vents.length >= 5 && vents.length <= 8, `${vents.length} vents`);
  assert.equal(vents.length, DEFAULT_VOLCANIC_VENTS.length);
  assert.equal(terrain.geometry.userData.vents, vents.length);
  assert.equal(terrain.ventReport.length, vents.length);
  assert.equal(new Set(vents.map((v) => v.id)).size, vents.length, 'vent ids are unique');

  for (const vent of vents) {
    // Entirely inside the sector, with room to spare: the footprint — the
    // radius past which the vent is exactly zero — clears every shared edge.
    assert.ok(
      distanceToHexEdge(vent.x, vent.z, RADIUS) - vent.support > 12,
      `${vent.id} reaches the sector boundary`,
    );
    // Small next to the main crater: no vent is a landmark. The widest of them
    // is well under a third of the crown's diameter, and its own depression is
    // a fraction of the crater's depth.
    // "Relatively small" is judged on the ground the vent actually covers: a
    // pit's footprint radius, and for a fissure its width (a crack is long by
    // nature, but it is a slot, not a crater).
    assert.ok(
      vent.support < CRATER.rimRadius * 0.6,
      `${vent.id} spreads ${(vent.support * 2).toFixed(1)} units across`,
    );
    assert.ok(
      vent.radius < CRATER.rimRadius * 0.5,
      `${vent.id} is ${(vent.radius * 2).toFixed(1)} units wide`,
    );
    assert.ok(
      (vent.depth + vent.lip) * AMPLITUDE < CRATER.depth * AMPLITUDE * 0.2,
      `${vent.id} is as deep as the crater`,
    );
    assert.ok(vent.radius <= 12, `${vent.id} is too wide for a vent`);
  }

  // The vents are spread over the sector rather than piled into one corner.
  // Distance is judged between the openings themselves — the ground where each
  // vent's own relief really reaches — not between the bounding discs the
  // carve uses to reject empty space, which are generous around a fissure.
  const prints = vents.map((vent) => {
    const points = [];
    for (let ox = -vent.support; ox <= vent.support; ox += 1) {
      for (let oz = -vent.support; oz <= vent.support; oz += 1) {
        if (Math.abs(ventReliefAt(vent.x + ox, vent.z + oz, vent, AMPLITUDE)) < 0.1) continue;
        points.push([vent.x + ox, vent.z + oz]);
      }
    }
    return points;
  });
  let closest = Infinity;
  for (let a = 0; a < vents.length; a += 1) {
    for (let b = a + 1; b < vents.length; b += 1) {
      for (const [ax, az] of prints[a]) {
        for (const [bx, bz] of prints[b]) {
          closest = Math.min(closest, Math.hypot(ax - bx, az - bz));
        }
      }
    }
  }
  assert.ok(closest > 3, `two vents run into each other (gap ${closest.toFixed(1)})`);
  // And none of them is parked right on top of another either.
  for (const vent of vents) {
    assert.ok(vent.support < 30, `${vent.id} claims a ${vent.support.toFixed(0)} unit footprint`);
  }
});

test('the vents are all different: two openings, two cracks, a dish and two throats', () => {
  const kinds = new Set(VENTS.map((vent) => vent.kind));
  assert.deepEqual([...kinds].sort(), ['crack', 'pit'], 'both round openings and cracks');

  const pits = VENTS.filter((vent) => vent.kind === 'pit');
  const cracks = VENTS.filter((vent) => vent.kind === 'crack');
  assert.ok(pits.length >= 3 && cracks.length >= 2);

  // Wide spread of sizes and depths: a vent is not a repeated stamp.
  const radii = VENTS.map((vent) => vent.radius);
  const depths = VENTS.map((vent) => vent.depth * AMPLITUDE);
  const lips = VENTS.map((vent) => vent.lip * AMPLITUDE);
  const spread = (list) => Math.max(...list) / Math.min(...list);
  assert.ok(spread(radii) > 1.5, `radii only span ${spread(radii).toFixed(2)}x`);
  assert.ok(spread(depths) > 2, `depths only span ${spread(depths).toFixed(2)}x`);
  assert.ok(spread(lips) > 2, `rings only span ${spread(lips).toFixed(2)}x`);

  // Every pair differs in more than one number: shape, size, depth or ring.
  for (let a = 0; a < VENTS.length; a += 1) {
    for (let b = a + 1; b < VENTS.length; b += 1) {
      const one = VENTS[a];
      const other = VENTS[b];
      const differences = [
        Math.abs(one.radius - other.radius),
        Math.abs(one.depth - other.depth) * AMPLITUDE,
        Math.abs(one.lip - other.lip) * AMPLITUDE,
        Math.abs(one.irregularity - other.irregularity),
        Math.abs(one.floorEdge - other.floorEdge),
      ].filter((value) => value > 0.004).length;
      assert.ok(differences >= 3, `${one.id} and ${other.id} are near copies`);
    }
  }
});

test('every vent is a real depression in the baked ground with its own ring', () => {
  const terrain = makeTerrain();
  for (const vent of VENTS) {
    const depth = ventDepth(terrain, vent);
    const rim = ventRim(terrain, vent);
    const report = terrain.ventReport.find((entry) => entry.id === vent.id);

    // Deep enough to read in the surface the explorer walks on...
    assert.ok(depth > 0.25, `${vent.id} is only ${depth.toFixed(2)} units deep`);
    // ...but not so deep that it stops being a small vent.
    assert.ok(depth < 2.5, `${vent.id} is ${depth.toFixed(2)} units deep`);
    // ...and the ring really stands around it, on at least one bearing.
    assert.ok(
      rim.highest > 0.05,
      `${vent.id} threw up no ejecta at all (best bearing ${rim.highest.toFixed(3)})`,
    );
    assert.ok(rim.highest < 1.2, `${vent.id} has a mountain of a ring`);
    // The report the carve measured agrees with the surface.
    assert.ok(Math.abs(report.depth - depth) < 1.0, `${vent.id} report disagrees`);

    // A ring that is not uniform: some bearing stands higher than another.
    assert.ok(
      rim.highest - rim.lowest > 0.02,
      `${vent.id} has a perfectly even ring (${(rim.highest - rim.lowest).toFixed(4)})`,
    );
  }

  // The shallow ones really are shallower than the deep ones: the spread the
  // layout asked for survives the bake.
  const carved = VENTS.map((vent) => ventDepth(terrain, vent));
  assert.ok(
    Math.max(...carved) > Math.min(...carved) * 2,
    `depths flattened to ${carved.map((d) => d.toFixed(2)).join(', ')}`,
  );
});

test('the vents are geological shapes, not stamped circles or plates', () => {
  for (const vent of VENTS) {
    // 1. The outline wanders: the radius at which the ground passes from the
    //    throat into the ring differs from bearing to bearing.
    const radii = [];
    const samples = 96;
    const step = vent.radius / 12;
    for (let k = 0; k < samples; k += 1) {
      const a = (k / samples) * Math.PI * 2;
      const dirX = Math.cos(a);
      const dirZ = Math.sin(a);
      let lip = null;
      let previous = null;
      for (let r = vent.radius * 0.25; r <= vent.support; r += step) {
        const value = ventReliefAt(vent.x + dirX * r, vent.z + dirZ * r, vent, AMPLITUDE);
        if (previous !== null && previous < 0 && value >= 0) {
          lip = r;
          break;
        }
        previous = value;
      }
      if (lip !== null) radii.push(lip);
    }
    assert.ok(radii.length > samples * 0.8, `${vent.id} has no readable lip line`);
    const spread = (Math.max(...radii) - Math.min(...radii)) / vent.radius;
    // A fissure is a line, so its outline varies enormously; a pit has to
    // wander by the better part of a tenth of its own radius to read as lobed
    // rather than as a stamped circle.
    assert.ok(spread > 0.05, `${vent.id} is a circle (lip radius spread ${spread.toFixed(2)})`);

    // The whole opening is lobed too: the outline where the vent's relief
    // fades out sweeps in and out on every bearing.
    let near = Infinity;
    let far = 0;
    for (let k = 0; k < samples; k += 1) {
      const a = (k / samples) * Math.PI * 2;
      const dirX = Math.cos(a);
      const dirZ = Math.sin(a);
      let last = 0;
      for (let r = 0; r <= vent.support; r += vent.radius / 12) {
        if (Math.abs(ventReliefAt(vent.x + dirX * r, vent.z + dirZ * r, vent, AMPLITUDE)) > 0.1) last = r;
      }
      near = Math.min(near, last);
      far = Math.max(far, last);
    }
    assert.ok(far - near > vent.radius * 0.2, `${vent.id} has a moulded outline`);

    // 2. The floor is not a plate: it carries its own small relief.
    const floorRadius = Math.max(0.4, vent.radius * vent.floorEdge * 0.8);
    let floorLow = Infinity;
    let floorHigh = -Infinity;
    for (let k = 0; k < 48; k += 1) {
      const a = (k / 48) * Math.PI * 2;
      for (const r of [0, floorRadius * 0.5]) {
        const value = ventReliefAt(
          vent.x + Math.cos(a) * r,
          vent.z + Math.sin(a) * r,
          vent,
          AMPLITUDE,
        );
        floorLow = Math.min(floorLow, value);
        floorHigh = Math.max(floorHigh, value);
      }
    }
    assert.ok(
      floorHigh - floorLow > 0.02,
      `${vent.id} has a flat plate for a floor (${(floorHigh - floorLow).toFixed(4)})`,
    );
  }
});

test('the vents changed the vents and nothing else — the main crater is untouched', () => {
  const terrain = makeTerrain();
  const plainHeights = PLAIN.heights;

  let moved = 0;
  let movedOutside = 0;
  let movedInCrater = 0;
  let largest = 0;
  for (let v = 0; v < terrain.vertexCount; v += 1) {
    const x = terrain.positions[v * 3];
    const z = terrain.positions[v * 3 + 2];
    const change = Math.abs(terrain.heights[v] - plainHeights[v]);
    if (change <= 0) continue;
    moved += 1;
    largest = Math.max(largest, change);
    const inside = VENTS.some((vent) => Math.hypot(x - vent.x, z - vent.z) <= vent.support);
    if (!inside) movedOutside += 1;
    if (Math.hypot(x - CRATER.x, z - CRATER.z) < CRATER_FOOTPRINT) movedInCrater += 1;
  }

  assert.ok(moved > 100, 'the vents really did carve something');
  assert.ok(largest > 0.5, `the deepest change is only ${largest.toFixed(3)}`);
  assert.equal(movedOutside, 0, 'the vents moved ground outside their own footprints');
  assert.equal(movedInCrater, 0, 'the main crater moved');
  // They are small openings in a big sector, not a rewrite of it.
  assert.ok(moved / terrain.vertexCount < 0.05, `${moved} of ${terrain.vertexCount} vertices moved`);

  // The bulk shape of the sector is exactly what it was: same height range,
  // same steepest face, same rim.
  assert.deepEqual(
    [...terrain.geometry.userData.heightRange],
    [...PLAIN.geometry.userData.heightRange],
    'the sector relief range moved',
  );
  assert.ok(Math.abs(
    terrain.geometry.userData.maxSlopeDegrees - PLAIN.geometry.userData.maxSlopeDegrees,
  ) < 1e-6);
  for (let v = 0; v < terrain.vertexCount; v += 1) {
    if (!terrain.isRim[v]) continue;
    assert.equal(terrain.heights[v], 0, 'the sector rim is still flat');
  }
});

test('the vents never crowd a gate, a shared edge or the main crater', () => {
  const terrain = makeTerrain();
  assert.equal(terrain.gateAprons.length, 4);

  // The vents sit well away from the crater: nowhere near its crown, its
  // flanks or the ground it levels into the massif.
  for (const vent of terrain.vents) {
    const distance = Math.hypot(vent.x - CRATER.x, vent.z - CRATER.z);
    assert.ok(
      distance > CRATER_FOOTPRINT + vent.support + 5,
      `${vent.id} is ${distance.toFixed(1)} units from the crater vent`,
    );
  }

  // Gate approaches stay level, whatever a vent would like to do there.
  for (const apron of terrain.gateAprons) {
    for (const vent of terrain.vents) {
      const distance = Math.hypot(vent.x - apron.x, vent.z - apron.z);
      assert.ok(
        distance > terrain.apronOuter + vent.support,
        `${vent.id} reaches the apron of the gate at (${apron.x}, ${apron.z})`,
      );
    }
    for (let k = 0; k < 24; k += 1) {
      const a = (k / 24) * Math.PI * 2;
      for (const r of [0, 8, 16, MAP_CONFIG.volcanicGateApronInner]) {
        const x = apron.x + Math.cos(a) * r;
        const z = apron.z + Math.sin(a) * r;
        assert.ok(Math.abs(terrain.heightAt(x, z)) < 0.35, 'a gate approach is no longer level');
      }
    }
  }
});

test('the vents stay walkable: gentle floors, gentle walls, no cliffs', () => {
  const terrain = makeTerrain();
  const limit = Math.tan(THREE.MathUtils.degToRad(MAP_CONFIG.volcanicTerrainMaxSlopeDeg));

  // No face anywhere in the sector — the vents included — exceeds the sector's
  // own walkable slope limit.
  assert.ok(
    terrain.geometry.userData.maxSlopeDegrees <= MAP_CONFIG.volcanicTerrainMaxSlopeDeg + 1e-3,
    `steepest face is ${terrain.geometry.userData.maxSlopeDegrees} degrees`,
  );

  // Walk a line through the middle of every vent: the ground may never jump by
  // more than the slope limit allows, so a vent is something to walk into.
  const step = 0.25;
  for (const vent of terrain.vents) {
    for (const bearing of [0.3, 1.1, 2.4, 4.2]) {
      const dirX = Math.cos(bearing);
      const dirZ = Math.sin(bearing);
      let previous = null;
      for (let d = -vent.support - 6; d <= vent.support + 6; d += step) {
        const x = vent.x + dirX * d;
        const z = vent.z + dirZ * d;
        const height = terrain.heightAt(x, z);
        if (previous !== null) {
          assert.ok(
            Math.abs(height - previous) <= limit * step + 1e-6,
            `a cliff inside ${vent.id} at d=${d.toFixed(1)}`,
          );
        }
        previous = height;
      }
    }
    // The wall of a vent is a slope, not a wall: even the steepest sample in
    // its footprint is under the sector limit.
    let steepest = 0;
    for (let ox = -vent.support; ox <= vent.support; ox += 1) {
      for (let oz = -vent.support; oz <= vent.support; oz += 1) {
        if (ox * ox + oz * oz > vent.supportSq) continue;
        steepest = Math.max(steepest, Math.atan(terrain.slopeAt(vent.x + ox, vent.z + oz)));
      }
    }
    assert.ok(
      steepest <= limit + 1e-3,
      `${vent.id} has a ${(steepest * 180 / Math.PI).toFixed(1)} degree face`,
    );
  }
});

test('the vents are ground, not props: no meshes, no zones, no new systems', () => {
  const world = map();
  assert.equal(world.volcanicTerrain.vents.length, 7);
  assert.equal(world.volcanicTerrainGeometry.userData.vents, 7);

  // Nothing new was added to the world: the vents are the terrain itself.
  const withVents = new HexMap(new THREE.Scene(), MAP_CONFIG);
  const withoutVents = new HexMap(new THREE.Scene(), NO_VENTS);
  assert.equal(withVents.group.children.length, withoutVents.group.children.length);
  assert.equal(withVents.doors.length, withoutVents.doors.length);
  assert.equal(withVents.gates.length, withoutVents.gates.length);
  withVents.group.traverse((object) => {
    assert.ok(!/vent/i.test(object.name ?? ''), `${object.name} looks like a vent prop`);
  });

  // A vent blocks nothing: the explorer walks straight through it.
  for (const vent of world.volcanicTerrain.vents) {
    const resolved = world.resolveHorizontalPosition(vent.x, vent.z, PLAYER_CONFIG.radius);
    assert.ok(
      Math.hypot(resolved.x - vent.x, resolved.z - vent.z) < 1e-6,
      `${vent.id} blocks the explorer`,
    );
  }

  // The vents are data: plain numbers, no behaviour, no gameplay payload.
  for (const vent of world.volcanicTerrain.vents) {
    const keys = Object.keys(vent);
    for (const key of keys) {
      assert.notEqual(typeof vent[key], 'function', `${vent.id}.${key} is behaviour`);
    }
    assert.equal(vent.damage, undefined);
    assert.equal(vent.trigger, undefined);
    assert.equal(vent.collision, undefined);
  }
  withVents.dispose?.();
  withoutVents.dispose?.();
});

test('the explorer walks down into a vent and back out of it', () => {
  const world = map();
  const vent = world.volcanicTerrain.vents.find((candidate) => candidate.id === 'vent-basin-throat');
  assert.ok(vent, 'the deepest vent is in the world');

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const player = new PlayerController(camera, {}, world, PLAYER_CONFIG);
  player.isLocked = true;

  // Start 30 units west of the vent, on the basin floor, facing it. Vent
  // coordinates are sector-local, so the explorer starts in world space.
  const sector = world.getSector('HEX_SE');
  const ventX = sector.center.x + vent.x;
  const ventZ = sector.center.z + vent.z;
  const startX = ventX - 30;
  const startZ = ventZ;
  player.position.set(startX, 0, startZ);
  player.position.y = world.getFloorHeightAt(startX, startZ);
  player.yaw = Math.atan2(-1, 0);
  const startGround = player.position.y;
  player.handleKeyDown({ code: 'KeyW', repeat: false, preventDefault: () => {} });

  let lowest = Infinity;
  let airborne = 0;
  let reachedFarSide = false;
  const frames = 600; // ten seconds at ten units per second
  for (let frame = 0; frame < frames; frame += 1) {
    world.update(1 / 60, player.position);
    player.update(1 / 60);
    const ground = world.getFloorHeightAt(player.position.x, player.position.z);
    assert.ok(ground !== null, 'the explorer never leaves the map');
    assert.ok(
      ground - player.position.y <= 1e-6,
      `explorer sank ${(ground - player.position.y).toFixed(4)} units into ${vent.id}`,
    );
    if (player.position.y > ground + 1e-6) airborne += 1;
    lowest = Math.min(lowest, player.position.y);
    if (player.position.x > ventX + vent.radius) reachedFarSide = true;
  }

  assert.ok(
    startGround - lowest > 0.5,
    `the explorer only descended ${(startGround - lowest).toFixed(2)} units into the vent`,
  );
  assert.ok(reachedFarSide, 'the explorer never crossed the vent');
  assert.ok(
    airborne / frames < 0.02,
    `the explorer left the ground on ${airborne} of ${frames} frames instead of following the vent`,
  );
  player.dispose();
});

test('the vents are seeded and can be replaced or removed through the config', () => {
  // Two bakes of the same seed are the same ground, vents and all.
  const a = makeTerrain();
  const b = makeTerrain();
  for (let v = 0; v < a.vertexCount; v += 1) {
    assert.equal(a.heights[v], b.heights[v], `height mismatch at vertex ${v}`);
  }

  // A different seed moves the vents with the landscape.
  const reseeded = makeTerrain({ ...MAP_CONFIG, volcanicTerrainSeed: MAP_CONFIG.volcanicTerrainSeed + 11 });
  assert.equal(reseeded.vents.length, a.vents.length);

  // `volcanicVents: []` leaves the sector exactly as it was before this step.
  const plain = makeTerrain(NO_VENTS);
  assert.equal(plain.vents.length, 0);
  assert.equal(plain.geometry.userData.vents, 0);
  assert.equal(plain.ventReport.length, 0);
  for (let v = 0; v < plain.vertexCount; v += 1) {
    assert.equal(plain.heights[v], PLAIN.heights[v], 'a vent-free bake differs from the sector');
  }

  // A custom layout replaces the default one, one vent at a time.
  // ...and a layout of one vent is bored where it is put: on the flat basin
  // floor, which is calm enough for the slope limiter to leave it alone.
  const site = { x: -38, z: -6 };
  const custom = makeTerrain({
    ...MAP_CONFIG,
    volcanicVents: [{
      id: 'test-vent',
      kind: 'pit',
      ...site,
      radius: 7,
      depth: 0.06,
      lip: 0.02,
      seedOffset: 1,
    }],
  });
  assert.equal(custom.vents.length, 1);
  assert.equal(custom.vents[0].id, 'test-vent');
  assert.equal(custom.geometry.userData.vents, 1);
  assert.ok(
    custom.heightAt(site.x, site.z) < PLAIN.heightAt(site.x, site.z) - 0.4,
    'the custom vent was not carved',
  );
  // ...and it is still only that one vent that moved.
  let moved = 0;
  for (let v = 0; v < custom.vertexCount; v += 1) {
    const x = custom.positions[v * 3];
    const z = custom.positions[v * 3 + 2];
    if (custom.heights[v] === PLAIN.heights[v]) continue;
    moved += 1;
    assert.ok(
      Math.hypot(x - site.x, z - site.z) <= custom.vents[0].support + 1e-6,
      'a custom vent reached too far',
    );
  }
  assert.ok(moved > 10 && moved < custom.vertexCount * 0.05);
});
