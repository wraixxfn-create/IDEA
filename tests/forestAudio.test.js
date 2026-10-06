import test from 'node:test';
import assert from 'node:assert/strict';
import { ForestAudio, forestCallMix } from '../src/world/ForestAudio.js';

class FakeAudioParam {
  constructor(value = 0) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
}

class FakeAudioNode {
  constructor(type) {
    this.type = type;
    this.connections = [];
  }
  connect(node) { this.connections.push(node); return node; }
  disconnect() {}
  start() {}
  stop() {}
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 8000;
    this.currentTime = 2;
    this.state = 'running';
    this.destination = new FakeAudioNode('destination');
    this.oscillators = [];
    this.panners = [];
  }
  createGain() {
    const node = new FakeAudioNode('gain');
    node.gain = new FakeAudioParam();
    return node;
  }
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (channel) => data[channel] };
  }
  createBufferSource() { return new FakeAudioNode('buffer-source'); }
  createBiquadFilter() {
    const node = new FakeAudioNode('filter');
    node.frequency = new FakeAudioParam();
    node.Q = new FakeAudioParam();
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeAudioNode('compressor');
    for (const parameter of ['threshold', 'knee', 'ratio', 'attack', 'release']) {
      node[parameter] = new FakeAudioParam();
    }
    return node;
  }
  createStereoPanner() {
    const node = new FakeAudioNode('panner');
    node.pan = new FakeAudioParam();
    this.panners.push(node);
    return node;
  }
  createOscillator() {
    const node = new FakeAudioNode('oscillator');
    node.frequency = new FakeAudioParam();
    this.oscillators.push(node);
    return node;
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

test('bird calls pan relative to the camera and grow quieter with distance', () => {
  const listener = { x: 0, y: 0, z: 0 };
  const forward = { x: 0, y: 0, z: -1 };
  const right = forestCallMix({ x: 10, y: 2, z: -8 }, listener, forward);
  const left = forestCallMix({ x: -10, y: 2, z: -8 }, listener, forward);
  const far = forestCallMix({ x: 10, y: 2, z: -80 }, listener, forward);
  const overhead = forestCallMix({ x: 0, y: 20, z: 0 }, listener, forward);

  assert.ok(right.pan > 0, 'a bird on the right should sound on the right');
  assert.ok(left.pan < 0, 'a bird on the left should sound on the left');
  assert.ok(far.gain < right.gain, 'distant calls should be quieter');
  assert.equal(overhead.pan, 0, 'a bird directly overhead has no horizontal pan');
});

test('forest ambience and singing birds start only after audio is enabled', async () => {
  const context = new FakeAudioContext();
  const audio = new ForestAudio({ contextFactory: () => context, seed: 21 });
  assert.equal(audio.isEnabled, false);
  assert.equal(await audio.setEnabled(true), true);
  assert.equal(audio.available, true);

  const singer = {
    id: 'tit-1',
    state: 'sing',
    stateTime: 0.1,
    stateSerial: 1,
    position: { x: 10, y: 6, z: -8 },
    species: { id: 'tit' },
  };
  audio.update(1, {
    inForest: true,
    rainEnabled: true,
    birds: [singer],
    birdOrigin: { x: 100, y: 0, z: 20 },
    listenerPosition: { x: 100, y: 0, z: 20 },
    cameraForward: { x: 0, y: 0, z: -1 },
  });
  assert.equal(audio.forestGain.gain.value, 1);
  assert.ok(context.oscillators.length >= 4, 'a singing bird should produce a short phrase');
  assert.ok(context.panners.some((panner) => panner.pan.value > 0.5), 'calls use the forest origin for stereo position');

  await audio.setEnabled(false);
  assert.equal(audio.masterGain.gain.value, 0);
  audio.update(0.1, { inForest: false, birds: [] });
  assert.equal(audio.forestGain.gain.value, 0);
  audio.dispose();
});

test('audio degrades gracefully when Web Audio is unavailable', async () => {
  const audio = new ForestAudio({ contextFactory: () => null });
  assert.equal(await audio.setEnabled(true), false);
  assert.equal(audio.available, false);
  assert.equal(audio.isEnabled, false);
});
