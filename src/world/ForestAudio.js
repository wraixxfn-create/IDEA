import { between, makeRandom } from './random.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function smoothParam(param, value, context, seconds = 0.35) {
  if (!param || !context) return;
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, context.currentTime, Math.max(0.01, seconds));
  } else {
    param.value = value;
  }
}

/**
 * The apparent direction and distance of a bird call, relative to the camera.
 * Panning is horizontal (as it is for a stereo headset); height still helps
 * the distance fade so a bird high in the canopy sounds farther away.
 */
export function forestCallMix(source, listener, cameraForward = { x: 0, z: -1 }) {
  if (!source || !listener) return { pan: 0, gain: 1 };

  const dx = (source.x ?? 0) - (listener.x ?? 0);
  const dy = (source.y ?? 0) - (listener.y ?? 0);
  const dz = (source.z ?? 0) - (listener.z ?? 0);
  const distance = Math.hypot(dx, dy, dz);
  const horizontalDistance = Math.hypot(dx, dz);
  const forwardLength = Math.hypot(cameraForward?.x ?? 0, cameraForward?.z ?? -1) || 1;
  const forwardX = (cameraForward?.x ?? 0) / forwardLength;
  const forwardZ = (cameraForward?.z ?? -1) / forwardLength;
  const rightX = -forwardZ;
  const rightZ = forwardX;
  const pan = horizontalDistance > 1e-4
    ? clamp((dx * rightX + dz * rightZ) / horizontalDistance, -1, 1)
    : 0;

  return {
    pan,
    gain: 1 / ((1 + distance / 38) ** 1.15),
  };
}

function createNoiseBuffer(context, { pink = false, seed = 1 } = {}) {
  const seconds = 2;
  const frames = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  const random = makeRandom(seed);

  for (let channel = 0; channel < 2; channel += 1) {
    const samples = buffer.getChannelData(channel);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;

    for (let index = 0; index < frames; index += 1) {
      const white = random() * 2 - 1;
      if (!pink) {
        samples[index] = white;
        continue;
      }

      // Paul Kellet's compact pink-noise filter: a soft, wind-like spectrum
      // without loading a recording or leaving the browser.
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pinkSample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      samples[index] = pinkSample;
    }
  }
  return buffer;
}

function makeFilter(context, { type, frequency, q = 0.7 }) {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

/**
 * A small, procedural forest soundscape.
 *
 * It is intentionally opt-in until the first user gesture (Web Audio is
 * blocked by browsers before that). The bed is made from filtered, looped
 * noise — wind in the canopy, leaf rustle and a soft rain hiss — while bird
 * phrases are short synthesized calls triggered by the same `sing` state that
 * animates a bird's beak. Calls are stereo-positioned from the camera.
 */
export class ForestAudio {
  constructor({ contextFactory = null, seed = 0x4f524553 } = {}) {
    this.contextFactory = contextFactory ?? (() => {
      const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return typeof AudioContext === 'function' ? new AudioContext() : null;
    });
    this.random = makeRandom(seed);
    this.context = null;
    this.masterGain = null;
    this.forestGain = null;
    this.rainLayerGain = null;
    this.loopingNodes = [];
    this.enabled = false;
    this.available = null;
    this.zoneTarget = null;
    this.rainTarget = null;
    this.songCooldown = 0.8;
    this.songQueue = new Map();
    this.heardSongSerial = new Map();
  }

  get isEnabled() {
    return this.enabled;
  }

  ensureGraph() {
    if (this.context) return true;
    let context = null;
    try {
      context = this.contextFactory();
      if (!context) {
        this.available = false;
        return false;
      }

      this.context = context;
      this.masterGain = context.createGain();
      this.masterGain.gain.value = 0;
      this.forestGain = context.createGain();
      this.forestGain.gain.value = 0;

      // A gentle compressor keeps overlapping calls from ever becoming sharp.
      const compressor = context.createDynamicsCompressor?.();
      if (compressor) {
        compressor.threshold.value = -25;
        compressor.knee.value = 18;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.012;
        compressor.release.value = 0.25;
        this.masterGain.connect(compressor);
        compressor.connect(context.destination);
      } else {
        this.masterGain.connect(context.destination);
      }
      this.forestGain.connect(this.masterGain);

      const pinkNoise = createNoiseBuffer(context, { pink: true, seed: 0x51a7 });
      const whiteNoise = createNoiseBuffer(context, { seed: 0x71e5 });
      const leafNoise = createNoiseBuffer(context, { seed: 0x1ea4 });

      this.createNoiseLayer(pinkNoise, {
        filters: [
          { type: 'highpass', frequency: 55, q: 0.55 },
          { type: 'lowpass', frequency: 620, q: 0.6 },
        ],
        gain: 0.11,
        pan: -0.06,
        wobbleHz: 0.08,
        wobbleDepth: 0.035,
      });
      this.createNoiseLayer(leafNoise, {
        filters: [
          { type: 'bandpass', frequency: 1550, q: 0.48 },
          { type: 'lowpass', frequency: 4200, q: 0.55 },
        ],
        gain: 0.026,
        pan: 0.2,
        wobbleHz: 0.12,
        wobbleDepth: 0.012,
      });
      const rainLayer = this.createNoiseLayer(whiteNoise, {
        filters: [
          { type: 'highpass', frequency: 420, q: 0.5 },
          { type: 'lowpass', frequency: 6500, q: 0.65 },
        ],
        gain: 0.031,
        pan: 0,
      });
      this.rainLayerGain = rainLayer.gain;
      this.available = true;
      return true;
    } catch {
      this.available = false;
      this.enabled = false;
      try { context?.close?.(); } catch { /* a partial graph is disposable */ }
      this.context = null;
      return false;
    }
  }

  createNoiseLayer(buffer, { filters, gain, pan = 0, wobbleHz = 0, wobbleDepth = 0 }) {
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    let output = source;
    for (const options of filters) {
      const filter = makeFilter(context, options);
      output.connect(filter);
      output = filter;
    }

    const layerGain = context.createGain();
    layerGain.gain.value = gain;
    output.connect(layerGain);
    let finalOutput = layerGain;
    let panner = null;
    if (typeof context.createStereoPanner === 'function') {
      panner = context.createStereoPanner();
      panner.pan.value = pan;
      layerGain.connect(panner);
      finalOutput = panner;
    }
    finalOutput.connect(this.forestGain);
    source.start();
    this.loopingNodes.push(source);

    if (wobbleHz > 0 && wobbleDepth > 0) {
      const lfo = context.createOscillator();
      const depth = context.createGain();
      lfo.frequency.value = wobbleHz;
      depth.gain.value = wobbleDepth;
      lfo.connect(depth);
      depth.connect(layerGain.gain);
      lfo.start();
      this.loopingNodes.push(lfo);
    }

    return { source, gain: layerGain, panner };
  }

  async setEnabled(next) {
    const enabled = Boolean(next);
    if (!enabled) {
      this.enabled = false;
      this.songQueue.clear();
      if (this.context) smoothParam(this.masterGain.gain, 0, this.context, 0.18);
      return false;
    }

    if (!this.ensureGraph()) return false;
    try {
      // Call resume synchronously in the click handler's activation window.
      const resumed = this.context.resume?.();
      if (resumed && typeof resumed.then === 'function') await resumed;
    } catch {
      this.enabled = false;
      return false;
    }

    this.enabled = true;
    smoothParam(this.masterGain.gain, 0.62, this.context, 0.3);
    return true;
  }

  async toggle() {
    return this.setEnabled(!this.enabled);
  }

  update(delta, {
    inForest = false,
    rainEnabled = true,
    birds = [],
    birdOrigin = null,
    listenerPosition = null,
    cameraForward = null,
  } = {}) {
    if (!this.context) return;
    const dt = Math.max(0, delta);
    const audible = this.enabled && inForest;
    const nextZone = audible ? 1 : 0;
    if (this.zoneTarget !== nextZone) {
      this.zoneTarget = nextZone;
      smoothParam(this.forestGain.gain, nextZone, this.context, 0.75);
    }

    const nextRain = rainEnabled ? 0.031 : 0;
    if (this.rainTarget !== nextRain) {
      this.rainTarget = nextRain;
      smoothParam(this.rainLayerGain.gain, nextRain, this.context, 0.65);
    }

    if (!audible) {
      this.songQueue.clear();
      return;
    }

    // Audio follows the flock's actual song state, so a bird that sings is the
    // bird whose beak moves. The queue spaces simultaneous singers naturally.
    for (const bird of birds) {
      if (bird.state !== 'sing') continue;
      const serial = bird.stateSerial ?? 0;
      if (this.heardSongSerial.get(bird.id) === serial) continue;
      this.heardSongSerial.set(bird.id, serial);
      this.songQueue.set(bird.id, { bird, serial });
    }

    this.songCooldown -= dt;
    if (this.songCooldown > 0 || !this.songQueue.size) return;

    let singer = null;
    for (const [id, entry] of this.songQueue) {
      this.songQueue.delete(id);
      if (entry.bird.state === 'sing' && (entry.bird.stateSerial ?? 0) === entry.serial) {
        singer = entry.bird;
        break;
      }
    }
    if (!singer) return;

    this.playBirdPhrase(singer, listenerPosition, cameraForward, birdOrigin);
    this.songCooldown = between(this.random, 1.15, 2.5);
  }

  playBirdPhrase(bird, listenerPosition, cameraForward, birdOrigin = null) {
    if (!this.context || !this.forestGain) return;
    const origin = birdOrigin ?? { x: 0, y: 0, z: 0 };
    const sourcePosition = {
      x: bird.position.x + (origin.x ?? 0),
      y: bird.position.y + (origin.y ?? 0),
      z: bird.position.z + (origin.z ?? 0),
    };
    const mix = forestCallMix(sourcePosition, listenerPosition, cameraForward ?? { x: 0, z: -1 });
    const speciesId = bird.species?.id ?? 'chaffinch';
    const notes = this.makePhrase(speciesId);
    const startedAt = this.context.currentTime + 0.025;
    const speciesLevel = speciesId === 'jay' ? 0.13 : 0.105;

    for (const note of notes) {
      this.scheduleChirp({
        ...note,
        startAt: startedAt + note.offset,
        pan: mix.pan,
        level: speciesLevel * mix.gain * note.level,
      });
    }
  }

  makePhrase(speciesId) {
    const random = this.random;
    const count = speciesId === 'chaffinch'
      ? 5 + Math.floor(random() * 3)
      : speciesId === 'jay'
        ? 2 + Math.floor(random() * 3)
        : 3 + Math.floor(random() * 2);
    const notes = [];
    let offset = 0;
    const jay = speciesId === 'jay';
    const tit = speciesId === 'tit';

    for (let index = 0; index < count; index += 1) {
      let startHz;
      let endHz;
      let duration;
      let level;
      if (jay) {
        startHz = between(random, 720, 1120);
        endHz = startHz * between(random, 0.7, 0.95);
        duration = between(random, 0.11, 0.2);
        level = between(random, 0.72, 1);
      } else if (tit) {
        startHz = between(random, 2150, 2950);
        endHz = startHz * (random() < 0.5 ? between(random, 0.78, 0.92) : between(random, 1.06, 1.2));
        duration = between(random, 0.075, 0.14);
        level = between(random, 0.58, 0.86);
      } else {
        startHz = between(random, 2450, 3550);
        const contour = index % 3 === 1 ? between(random, 0.78, 0.93) : between(random, 1.04, 1.19);
        endHz = startHz * contour;
        duration = between(random, 0.065, 0.135);
        level = between(random, 0.5, 0.82);
      }

      notes.push({
        offset,
        duration,
        startHz,
        endHz,
        level,
        waveform: jay ? 'triangle' : 'sine',
        cutoff: jay ? 2300 : (tit ? 5200 : 6100),
      });
      offset += duration + (jay ? between(random, 0.08, 0.19) : between(random, 0.045, 0.13));
    }
    return notes;
  }

  scheduleChirp({ startAt, duration, startHz, endHz, level, waveform, cutoff, pan }) {
    const context = this.context;
    if (!context) return;

    const oscillator = context.createOscillator();
    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(startHz, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(endHz, startAt + duration);

    // A quiet second harmonic gives the whistle a little body without making
    // the calls piercing or turning them into pure arcade bleeps.
    const harmonic = context.createOscillator();
    harmonic.type = waveform;
    harmonic.frequency.setValueAtTime(startHz * 2.01, startAt);
    harmonic.frequency.exponentialRampToValueAtTime(endHz * 2.01, startAt + duration);
    const harmonicGain = context.createGain();
    harmonicGain.gain.value = 0.13;

    const filter = makeFilter(context, { type: 'lowpass', frequency: cutoff, q: 0.65 });
    const envelope = context.createGain();
    const attack = Math.min(0.014, duration * 0.24);
    const releaseAt = startAt + duration;
    envelope.gain.setValueAtTime(0.0001, startAt);
    envelope.gain.linearRampToValueAtTime(Math.max(0.0002, level), startAt + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, releaseAt);

    let output = envelope;
    let panner = null;
    if (typeof context.createStereoPanner === 'function') {
      panner = context.createStereoPanner();
      panner.pan.setValueAtTime(pan, startAt);
      envelope.connect(panner);
      output = panner;
    }
    output.connect(this.forestGain);

    oscillator.connect(filter);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(filter);
    filter.connect(envelope);
    oscillator.start(startAt);
    harmonic.start(startAt);
    oscillator.stop(releaseAt + 0.035);
    harmonic.stop(releaseAt + 0.035);

    const disconnect = () => {
      oscillator.disconnect();
      harmonic.disconnect();
      harmonicGain.disconnect();
      filter.disconnect();
      envelope.disconnect();
      panner?.disconnect();
    };
    oscillator.onended = disconnect;
  }

  dispose() {
    for (const node of this.loopingNodes) {
      try { node.stop(); } catch { /* already stopped or not started */ }
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
    this.loopingNodes.length = 0;
    try { this.context?.close?.(); } catch { /* page is already closing */ }
    this.context = null;
    this.enabled = false;
  }
}
