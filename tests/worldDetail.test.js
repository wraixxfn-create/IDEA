import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { HexMap } from '../src/world/HexMap.js';
import { cloudThresholdFor, resolveSunDirection } from '../src/world/SkyDome.js';
import { installCanvasStub } from './domStub.js';

installCanvasStub();

function makeMap() {
  return new HexMap(new THREE.Scene(), MAP_CONFIG);
}

function layerSize(mesh) {
  return mesh.geometry.userData.canonicalSize;
}

function cloudInstanceTotal(sky) {
  return sky.cloudMeshes.reduce((total, mesh) => total + mesh.count, 0);
}

test('every sector is capped by an opaque cupola painted with a sky', () => {
  const map = makeMap();
  assert.equal(map.skies.length, map.sectors.length);

  for (const sky of map.skies) {
    const material = sky.shellMaterial;
    assert.equal(material.transparent, false, `${sky.sector.id} sky must not be see-through`);
    assert.equal(material.depthWrite, true);
    assert.ok(material.opacity >= 1);
    assert.equal(sky.shell.userData.collidable, false, 'cupolas are never colliders');
    assert.equal(
      sky.shell.position.y,
      MAP_CONFIG.floorHeight + MAP_CONFIG.domeBaseHeight,
      'the spring line sits on top of the 45-unit wall',
    );
    for (const key of ['uZenithColor', 'uHorizonColor', 'uSunColor', 'uSunDirection', 'uCloudThreshold']) {
      assert.ok(material.uniforms[key], `${sky.sector.id} sky is missing ${key}`);
    }
  }

  // The cupolas step aside for the top-down overview so the map stays readable.
  map.setDebugVisible(true);
  assert.equal(map.domeGroup.visible, false);
  assert.equal(map.mistLayers.visible, false);
  map.setDebugVisible(false);
  assert.equal(map.domeGroup.visible, true);
  assert.equal(map.mistLayers.visible, true);
});

test('one sun lights the whole world and every painted sky agrees on it', () => {
  const map = makeMap();
  const sun = resolveSunDirection(MAP_CONFIG);
  assert.ok(Math.abs(sun.length() - 1) < 1e-9, 'the sun direction is normalized');

  for (const sky of map.skies) {
    const direction = sky.shellMaterial.uniforms.uSunDirection.value;
    assert.ok(Math.abs(direction.length() - 1) < 1e-9);
    assert.ok(direction.distanceTo(sun) < 1e-9, `${sky.sector.id} uses a different sun`);
    assert.ok(direction.y > 0.1, 'the painted sun stays above the horizon');
  }
  assert.ok(map.skies.every((sky) => sky.shellMaterial.uniforms.uSunColor.value));
});

test('each cupola tints the shared sky towards its own sector', () => {
  const map = makeMap();
  const signatures = new Set();
  for (const sky of map.skies) {
    const { zenith, horizon } = sky.palette;
    assert.ok(zenith.b > zenith.r, `${sky.sector.id} zenith stays blue`);
    assert.ok(horizon.b > horizon.r, `${sky.sector.id} horizon stays blue`);
    signatures.add(zenith.getHexString());
  }
  assert.equal(signatures.size, map.sectors.length, 'every sector keeps its own sky');
  assert.equal(map.domeGroup.userData.roofType, 'painted-hexagonal-sky-cupola');
});

test('cloud decks drift inside every cupola, densest over the forest', () => {
  const map = makeMap();
  const forest = map.skies.find((sky) => sky.sector.id === 'HEX_S');
  const other = map.skies.find((sky) => sky.sector.id === 'HEX_N');

  assert.ok(cloudInstanceTotal(forest) > cloudInstanceTotal(other), 'HEX_S carries the fuller deck');
  assert.ok(forest.palette.cloudCoverage > other.palette.cloudCoverage);
  assert.ok(forest.palette.sunGlow > other.palette.sunGlow);
  assert.equal(map.cloudTotal, map.skies.reduce((total, sky) => total + cloudInstanceTotal(sky), 0));

  // Every puff has to stay inside its cupola: poking through the shell would
  // show a cloud hanging outside the sky.
  const baseHeight = MAP_CONFIG.domeBaseHeight;
  const domeHeight = MAP_CONFIG.domeHeight;
  const transform = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();

  for (const sky of map.skies) {
    for (const mesh of sky.cloudMeshes) {
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, transform);
        transform.decompose(position, quaternion, scale);
        // Instance matrices live in the deck's local space: the group itself
        // already sits on the sector centre.
        const localX = position.x;
        const localZ = position.z;
        const height = position.y;
        const angle = Math.atan2(localZ, localX);
        const footprint = 0.5 * Math.hypot(
          scale.x * layerSize(mesh).x,
          scale.z * layerSize(mesh).z,
        );
        for (const sampleHeight of [height, height + scale.y * layerSize(mesh).y]) {
          const profile = Math.sqrt(Math.max(
            0,
            1 - ((sampleHeight - baseHeight) / domeHeight) ** 2,
          ));
          const apothem = MAP_CONFIG.hexRadius * Math.sqrt(3) / 2;
          const nearestNormal = Math.round((angle - Math.PI / 6) / (Math.PI / 3))
            * (Math.PI / 3) + Math.PI / 6;
          const boundary = (apothem / Math.cos(angle - nearestNormal)) * profile;
          const extent = sampleHeight === height ? footprint : footprint * 0.35;
          assert.ok(
            Math.hypot(localX, localZ) + extent <= boundary,
            `${sky.sector.id} cloud ${index} escapes the cupola`,
          );
        }
      }
    }
  }

  // The deck turns slowly and the sky clock advances with the world.
  const before = forest.cloudGroup.rotation.y;
  map.update(1, map.getSector('HEX_S').center);
  assert.ok(forest.cloudGroup.rotation.y > before);
  assert.ok(forest.shellMaterial.uniforms.uTime.value > 0);
});

test('requested cloud coverage maps onto the sky noise distribution', () => {
  const sparse = cloudThresholdFor(0.2);
  const dense = cloudThresholdFor(0.6);
  assert.ok(sparse.threshold > dense.threshold, 'more coverage lowers the threshold');
  assert.ok(sparse.threshold > 0.4 && dense.threshold < 0.6);
  assert.ok(sparse.softness > 0 && dense.softness > 0);
});

test('the forest floor carries undergrowth planted on the relief, inside HEX_S', () => {
  const map = makeMap();
  const sector = map.getSector('HEX_S');
  const detail = map.forestUnderGrowth;
  assert.ok(detail, 'HEX_S receives its undergrowth layer');
  assert.equal(detail.userData.sectorId, 'HEX_S');

  const names = detail.children.map((child) => child.name);
  for (const expected of [
    'ForestGrassTufts_HEX_S',
    'ForestShrubs_HEX_S',
    'ForestRocks_HEX_S',
    'ForestFallenLogs_HEX_S',
    'ForestMushrooms_HEX_S',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }

  const transform = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  let planted = 0;

  for (const layer of detail.children) {
    assert.ok(layer.count > 0, `${layer.name} is empty`);
    for (let index = 0; index < layer.count; index += 1) {
      layer.getMatrixAt(index, transform);
      transform.decompose(position, quaternion, scale);
      for (const value of scale.toArray()) assert.ok(value > 0, 'no degenerate instances');
      assert.equal(
        map.getSectorAt(position.x, position.z)?.id,
        'HEX_S',
        `${layer.name} instance ${index} left the forest`,
      );
      // Undergrowth sits on the terrain rather than floating or sinking.
      const floor = map.getFloorHeightAt(position.x, position.z);
      assert.ok(Math.abs(position.y - floor) < 1.6, `${layer.name} instance ${index} is off the ground`);
      planted += 1;
    }
  }
  assert.ok(planted > 500, `expected a full undergrowth scatter, got ${planted}`);
  assert.ok(detail.userData.grassCount >= Math.floor(MAP_CONFIG.forestGrassCount * 0.5));
});

test('HEX_S mist layers and the shared wind clock animate with the world', () => {
  const map = makeMap();
  assert.equal(map.mistLayers.children.length, MAP_CONFIG.forestMistLayers);
  for (const layer of map.mistLayers.children) {
    assert.equal(layer.material.transparent, true);
    assert.equal(layer.material.depthWrite, false);
    assert.ok(layer.position.y > MAP_CONFIG.floorHeight);
  }

  const mistRotation = map.mistLayers.children[0].rotation.y;
  assert.equal(map.windUniforms.time.value, 0);
  map.update(0.5, map.getSector('HEX_S').center);
  assert.ok(map.windUniforms.time.value > 0, 'the wind clock drives the sway shader');
  assert.ok(map.mistLayers.children[0].rotation.y !== mistRotation, 'the mist drifts');

  assert.equal(map.pineGrove.userData.wind, true);
  assert.equal(map.forestUnderGrowth.userData.windDriven, true);
  assert.equal(map.pineGrove.children.length, 2, 'the grove stays at two draw calls');
});

test('the forest terrain keeps the shared edges flat and mottles the soil', () => {
  const map = makeMap();
  const sector = map.getSector('HEX_S');
  const geometry = map.forestTerrainGeometry;
  const positions = geometry.attributes.position;
  const colors = geometry.attributes.color;
  assert.ok(colors, 'the soil carries vertex shading');

  const tints = new Set();
  for (let index = 0; index < colors.count; index += 1) {
    tints.add(`${colors.getX(index).toFixed(3)},${colors.getY(index).toFixed(3)}`);
  }
  assert.ok(tints.size > 10, 'the soil is mottled rather than one flat colour');

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    assert.ok(Number.isFinite(y));
    // The rim of the hex, where it meets a neighbouring sector, stays flat.
    const distanceToEdge = Math.min(...[0, 1, 2, 3, 4, 5].map((side) => {
      const normalAngle = Math.PI / 6 + side * Math.PI / 3;
      return MAP_CONFIG.hexRadius * Math.sqrt(3) / 2
        - (x * Math.cos(normalAngle) + z * Math.sin(normalAngle));
    }));
    if (distanceToEdge < 1e-6) {
      assert.ok(Math.abs(y - MAP_CONFIG.floorHeight) < 1e-9, 'shared edges stay flat');
    }
  }
  assert.equal(map.getFloorHeightAt(sector.center.x, sector.center.z), MAP_CONFIG.floorHeight);
});
