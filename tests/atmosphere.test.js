import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_CONFIG } from '../src/config/mapConfig.js';
import { createAtmosphere } from '../src/world/Atmosphere.js';

test('atmosphere adds sky, void and a shadow-casting sun', () => {
  const scene = new THREE.Scene();
  const renderer = { shadowMap: {} };
  const atmosphere = createAtmosphere(scene, renderer, MAP_CONFIG);

  assert.equal(atmosphere.sky.name, 'WorldSky');
  assert.equal(atmosphere.voidMesh.name, 'WorldVoid');
  assert.equal(atmosphere.sun.castShadow, true);
  assert.equal(renderer.shadowMap.enabled, true);
  assert.ok(scene.fog);
  assert.equal(atmosphere.voidMesh.position.y, MAP_CONFIG.voidHeight);
  assert.ok(atmosphere.voidMesh.position.y < MAP_CONFIG.floorHeight);
});
