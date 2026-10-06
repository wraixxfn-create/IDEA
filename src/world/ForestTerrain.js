import * as THREE from 'three';
import { HEX_VERTEX_UNITS } from './hexGrid.js';

/**
 * ForestTerrain — the ground model of HEX_S and its collision surface.
 *
 * The forest floor used to be two different things: a coarse polar mesh for
 * the eyes, and a trigonometric formula for the feet. They disagreed by up to
 * ~3.8 units — more than twice the explorer's height — so walking across the
 * relief sank the character into the visible ground.
 *
 * This module builds **one** model and uses it for both. The hexagon is
 * subdivided into a regular triangular lattice (the classic "centered
 * hexagonal" subdivision: six wedges, each a triangular grid of N x N cells),
 * the height of every lattice vertex is baked once, and the mesh, the
 * collision query and the scatter planting all read the same baked heights.
 *
 *   • The lattice is an affine map of the (i, j) wedge coordinates, so a
 *     barycentric lookup in lattice space is *exactly* the rendered triangle:
 *     `heightAt()` returns the surface the player can see, to the last bit.
 *   • Cell size is uniform (no degenerate slivers at the centre, no 7-unit
 *     gaps at the rim), the six corners and the six sides fall exactly on
 *     lattice vertices, and the rim is pinned to the shared floor height, so
 *     neighbouring sectors stay seamless.
 *   • The relief itself is fractal value noise with domain warping, smoothed
 *     and slope-limited on the baked grid, which gives rolling, walkable
 *     ground instead of the old 54-degree spikes.
 */

const SQRT3 = Math.sqrt(3);
const TAU = Math.PI * 2;
const WEDGE_ANGLE = Math.PI / 3;

function clamp01(value) {
  return value < 0 ? 0 : (value > 1 ? 1 : value);
}

function smoothStep(value, start, end) {
  if (end <= start) return value >= end ? 1 : 0;
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
}

/** Signed distance from a flat-top hexagon's boundary (positive = inside). */
export function distanceToHexEdge(x, z, radius) {
  const apothem = radius * SQRT3 / 2;
  let nearest = apothem;
  for (let side = 0; side < 6; side += 1) {
    const normalAngle = Math.PI / 6 + side * WEDGE_ANGLE;
    const projection = x * Math.cos(normalAngle) + z * Math.sin(normalAngle);
    nearest = Math.min(nearest, apothem - projection);
  }
  return nearest;
}

/** ---- Deterministic value noise ---------------------------------------- */

function hash2d(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = quintic(x - x0);
  const fy = quintic(y - y0);
  const n00 = hash2d(x0, y0, seed);
  const n10 = hash2d(x0 + 1, y0, seed);
  const n01 = hash2d(x0, y0 + 1, seed);
  const n11 = hash2d(x0 + 1, y0 + 1, seed);
  const top = n00 + (n10 - n00) * fx;
  const bottom = n01 + (n11 - n01) * fx;
  return top + (bottom - top) * fy;
}

function fbm(x, y, seed, octaves, gain, lacunarity) {
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  let normalisation = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += amplitude * valueNoise(x * frequency, y * frequency, seed + octave * 1013);
    normalisation += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return normalisation > 0 ? total / normalisation : 0;
}

/** ---- Soil shading ------------------------------------------------------ */

const SOIL_BASE_TINT = new THREE.Color(0.92, 0.88, 0.80);
const SOIL_MOSS_TINT = new THREE.Color(0.42, 0.78, 0.38);
const SOIL_DRY_TINT = new THREE.Color(1.08, 0.92, 0.62);
const SOIL_HUMUS_TINT = new THREE.Color(0.42, 0.38, 0.30);
const SOIL_SHADOW_TINT = new THREE.Color(0.28, 0.32, 0.24);
const SOIL_SCREE_TINT = new THREE.Color(0.74, 0.62, 0.48);
const soilScratch = new THREE.Color();

/**
 * Per-vertex soil shading: mossy hollows, sun-bleached leaf drifts on the
 * ridges, damp humus in the dips and bare earth wherever the ground tips too
 * steeply for litter to settle. Multiplied into the shared soil colour, so the
 * biome keeps its identity while the floor stops reading as flat brown.
 */
export function forestSoilTintAt(x, z, height, slope = 0) {
  const patch = (
    Math.sin(x * 0.052 + 1.7) * Math.cos(z * 0.041 - 0.9)
    + 0.55 * Math.sin((x + z) * 0.026 + 2.4)
    + 0.35 * Math.cos((x - z) * 0.083)
  ) / 1.9;
  const dryness = (
    Math.sin(x * 0.031 - 0.4) * Math.sin(z * 0.037 + 1.1)
    + 0.5 * Math.cos((x * 0.7 + z) * 0.045)
  ) / 1.5;
  const flatness = 1 - clamp01(slope / 0.55);
  const mossAmount = THREE.MathUtils.smoothstep(patch, 0.12, 0.72) * (0.35 + 0.65 * flatness);
  const dryAmount = THREE.MathUtils.smoothstep(dryness, 0.08, 0.78);
  const hollowAmount = THREE.MathUtils.smoothstep(-height, 0.6, 5.5);
  const screeAmount = THREE.MathUtils.smoothstep(slope, 0.32, 0.72);

  const shadowNoise = (
    Math.sin(x * 0.14 + z * 0.11 + 3.7) * Math.cos(x * 0.09 - z * 0.16)
    + 0.4 * Math.sin((x - z) * 0.19 + 1.2)
  ) / 1.4;
  const shadowAmount = THREE.MathUtils.smoothstep(shadowNoise, -0.1, 0.6);

  soilScratch.copy(SOIL_BASE_TINT);
  soilScratch.lerp(SOIL_MOSS_TINT, mossAmount * 0.85);
  soilScratch.lerp(SOIL_DRY_TINT, dryAmount * 0.5 * (0.45 + 0.55 * clamp01(height / 4 + 0.5)));
  soilScratch.lerp(SOIL_HUMUS_TINT, hollowAmount * 0.5);
  soilScratch.lerp(SOIL_SCREE_TINT, screeAmount * 0.65);
  soilScratch.lerp(SOIL_SHADOW_TINT, shadowAmount * 0.28);
  return soilScratch;
}

/** ---- Lattice addressing ------------------------------------------------ */

/**
 * Canonical index of the lattice vertex (i, j) of wedge k.
 *
 * Wedge k is spanned by hex corners k and k+1, so every vertex with j === 0
 * lies on the spoke towards corner k and every vertex with i === 0 lies on the
 * spoke towards corner k+1. Those spokes are shared with the neighbouring
 * wedge; folding them onto one index keeps the mesh welded (no shading seams)
 * and lets the height lookup cross a wedge boundary without a special case.
 */
export function latticeVertexIndex(wedge, i, j, divisions) {
  if (i === 0 && j === 0) return 0;
  const n = divisions;
  if (j === 0) return 1 + wedge * n + (i - 1);
  if (i === 0) return 1 + ((wedge + 1) % 6) * n + (j - 1);
  const interiorBase = 1 + 6 * n;
  const perWedge = ((n - 1) * n) / 2;
  const row = (i - 1) * n - ((i - 1) * i) / 2;
  return interiorBase + wedge * perWedge + row + (j - 1);
}

export function latticeVertexCount(divisions) {
  return 3 * divisions * divisions + 3 * divisions + 1;
}

/** ---- The terrain ------------------------------------------------------- */

export class ForestTerrain {
  constructor({ radius = 220, config = {}, sectorId = 'HEX_S' } = {}) {
    this.radius = radius;
    this.sectorId = sectorId;
    this.divisions = Math.max(6, Math.round(config.forestTerrainDivisions ?? 96));
    this.amplitude = config.forestTerrainAmplitude ?? 9;
    this.edgeBlend = config.forestTerrainEdgeBlend ?? 46;
    this.baseScale = Math.max(1, config.forestTerrainBaseScale ?? 168);
    this.octaves = Math.max(1, Math.round(config.forestTerrainOctaves ?? 5));
    this.gain = config.forestTerrainGain ?? 0.46;
    this.lacunarity = config.forestTerrainLacunarity ?? 2.03;
    this.warp = config.forestTerrainWarp ?? 26;
    this.relax = config.forestTerrainRelax ?? 2;
    // Face gradient cap. An equilateral face can tilt up to 2/sqrt(3) times
    // the steepest of its three edges, so the per-edge budget is scaled down
    // to keep the *rendered* slope under the configured maximum.
    this.maxFaceSlope = Math.tan(THREE.MathUtils.degToRad(config.forestTerrainMaxSlopeDeg ?? 30));
    this.maxSlope = this.maxFaceSlope * SQRT3 / 2;
    this.seed = config.forestTerrainSeed ?? 0x5eed1eaf;
    this.bias = 0;
    this.cellSize = this.radius / this.divisions;

    // Inverse of [Vk Vk+1] per wedge, so a world point can be resolved into
    // lattice coordinates with four multiplications.
    this.wedgeBasis = [];
    for (let k = 0; k < 6; k += 1) {
      const a = HEX_VERTEX_UNITS[k];
      const b = HEX_VERTEX_UNITS[(k + 1) % 6];
      const determinant = a.x * b.z - b.x * a.z;
      this.wedgeBasis.push({
        ax: a.x, az: a.z, bx: b.x, bz: b.z,
        m00: b.z / determinant,
        m01: -b.x / determinant,
        m10: -a.z / determinant,
        m11: a.x / determinant,
      });
    }

    this.build();
  }

  /** ---- Height field ---------------------------------------------------- */

  /** How much relief a point is allowed: 1 inside, 0 on every shared edge. */
  maskAt(x, z) {
    const edgeDistance = Math.max(0, distanceToHexEdge(x, z, this.radius));
    return smoothStep(edgeDistance, 0, this.edgeBlend);
  }

  /** Normalised relief shape in roughly [-1, 1], before mask and amplitude. */
  shapeAt(x, z) {
    const scale = 1 / this.baseScale;
    const warpX = fbm((x + 184) * scale * 0.62, (z - 97) * scale * 0.62, this.seed + 77, 3, 0.5, 2) * this.warp;
    const warpZ = fbm((x - 241) * scale * 0.62, (z + 316) * scale * 0.62, this.seed + 913, 3, 0.5, 2) * this.warp;
    const base = fbm(
      (x + warpX) * scale,
      (z + warpZ) * scale,
      this.seed,
      this.octaves,
      this.gain,
      this.lacunarity,
    );
    // tanh keeps the extremes rounded: broad basins and soft crowns instead of
    // the needle peaks a raw fBm produces, and the gradient stays bounded.
    return Math.tanh(base * 2.4);
  }

  /** Raw (unbaked) relief used to seed the lattice. */
  sampleField(x, z) {
    const mask = this.maskAt(x, z);
    if (mask <= 0) return 0;
    return this.amplitude * mask * (this.shapeAt(x, z) - this.bias);
  }

  /** ---- Baking ---------------------------------------------------------- */

  build() {
    const n = this.divisions;
    const count = latticeVertexCount(n);
    const positions = new Float32Array(count * 3);
    const heights = new Float32Array(count);
    const masks = new Float32Array(count);
    const isRim = new Uint8Array(count);
    const step = this.radius / n;

    // Pass one: lattice layout, relief shape and the mask that flattens the
    // hexagon back to the shared floor height along every side.
    let shapeTotal = 0;
    let maskTotal = 0;
    for (let k = 0; k < 6; k += 1) {
      const a = HEX_VERTEX_UNITS[k];
      const b = HEX_VERTEX_UNITS[(k + 1) % 6];
      for (let i = 0; i <= n; i += 1) {
        for (let j = 0; j <= n - i; j += 1) {
          const index = latticeVertexIndex(k, i, j, n);
          const x = (a.x * i + b.x * j) * step;
          const z = (a.z * i + b.z * j) * step;
          positions[index * 3] = x;
          positions[index * 3 + 2] = z;
          if (i + j === n) {
            isRim[index] = 1;
            masks[index] = 0;
            heights[index] = 0;
            continue;
          }
          const mask = this.maskAt(x, z);
          const shape = this.shapeAt(x, z);
          masks[index] = mask;
          heights[index] = shape;
          shapeTotal += shape * mask;
          maskTotal += mask;
        }
      }
    }

    // Centre the relief on the floor height: the forest then has as many
    // hollows as crowns and never drifts away from its neighbours' level.
    this.bias = maskTotal > 0 ? shapeTotal / maskTotal : 0;
    for (let v = 0; v < count; v += 1) {
      heights[v] = isRim[v] ? 0 : this.amplitude * masks[v] * (heights[v] - this.bias);
    }

    const indices = new Uint32Array(6 * n * n * 3);
    let cursor = 0;
    for (let k = 0; k < 6; k += 1) {
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n - i; j += 1) {
          const a = latticeVertexIndex(k, i, j, n);
          const b = latticeVertexIndex(k, i + 1, j, n);
          const c = latticeVertexIndex(k, i, j + 1, n);
          // Reverse the x/z winding so every face points upward (+Y).
          indices[cursor] = a; indices[cursor + 1] = c; indices[cursor + 2] = b;
          cursor += 3;
          if (i + j < n - 1) {
            const d = latticeVertexIndex(k, i + 1, j + 1, n);
            indices[cursor] = b; indices[cursor + 1] = c; indices[cursor + 2] = d;
            cursor += 3;
          }
        }
      }
    }

    this.vertexCount = count;
    this.positions = positions;
    this.heights = heights;
    this.isRim = isRim;
    this.indices = indices;
    this.triangleCount = cursor / 3;

    this.relaxHeights(this.relax);
    this.limitSlopes(24);
    this.writeHeights();
    this.geometry = this.createGeometry();
  }

  /** A couple of Laplacian passes: removes noise speckle, keeps the shapes. */
  relaxHeights(passes) {
    if (passes <= 0) return;
    const { heights, indices, isRim } = this;
    const total = new Float32Array(heights.length);
    const hits = new Uint16Array(heights.length);
    for (let pass = 0; pass < passes; pass += 1) {
      total.fill(0);
      hits.fill(0);
      for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t];
        const b = indices[t + 1];
        const c = indices[t + 2];
        total[a] += heights[b] + heights[c]; hits[a] += 2;
        total[b] += heights[a] + heights[c]; hits[b] += 2;
        total[c] += heights[a] + heights[b]; hits[c] += 2;
      }
      for (let v = 0; v < heights.length; v += 1) {
        if (isRim[v] || hits[v] === 0) continue;
        heights[v] += ((total[v] / hits[v]) - heights[v]) * 0.42;
      }
    }
  }

  /**
   * Walkability guarantee: no lattice edge may be steeper than `maxSlope`.
   * Anything sharper is split between its two ends (the rim never moves), so
   * the ground the collision reports is ground the explorer can actually walk.
   */
  limitSlopes(passes) {
    const { heights, indices, isRim } = this;
    const limit = this.maxSlope * this.cellSize;
    for (let pass = 0; pass < passes; pass += 1) {
      let corrections = 0;
      for (let t = 0; t < indices.length; t += 3) {
        for (let edge = 0; edge < 3; edge += 1) {
          const a = indices[t + edge];
          const b = indices[t + ((edge + 1) % 3)];
          const delta = heights[a] - heights[b];
          const excess = Math.abs(delta) - limit;
          if (excess <= 0) continue;
          const sign = delta > 0 ? 1 : -1;
          const lockedA = isRim[a];
          const lockedB = isRim[b];
          if (lockedA && lockedB) continue;
          if (lockedA) {
            heights[b] += sign * excess;
          } else if (lockedB) {
            heights[a] -= sign * excess;
          } else {
            heights[a] -= sign * excess * 0.5;
            heights[b] += sign * excess * 0.5;
          }
          corrections += 1;
        }
      }
      if (corrections === 0) break;
    }
  }

  writeHeights() {
    let min = Infinity;
    let max = -Infinity;
    for (let v = 0; v < this.vertexCount; v += 1) {
      const y = this.isRim[v] ? 0 : this.heights[v];
      this.heights[v] = y;
      this.positions[v * 3 + 1] = y;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    this.minHeight = min;
    this.maxHeight = max;
  }

  createGeometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.name = `ForestTerrainGeometry_${this.sectorId}`;
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    geometry.computeVertexNormals();

    const normals = geometry.getAttribute('normal');
    const colors = new Float32Array(this.vertexCount * 3);
    let steepest = 0;
    for (let v = 0; v < this.vertexCount; v += 1) {
      const up = THREE.MathUtils.clamp(normals.getY(v), 1e-4, 1);
      const slope = Math.sqrt(Math.max(0, 1 - up * up)) / up;
      if (slope > steepest) steepest = slope;
      const tint = forestSoilTintAt(
        this.positions[v * 3],
        this.positions[v * 3 + 2],
        this.heights[v],
        slope,
      );
      colors[v * 3] = tint.r;
      colors[v * 3 + 1] = tint.g;
      colors[v * 3 + 2] = tint.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    this.steepestSlope = steepest;
    geometry.userData.terrain = 'baked-hex-lattice';
    geometry.userData.divisions = this.divisions;
    geometry.userData.cellSize = this.cellSize;
    geometry.userData.vertexCount = this.vertexCount;
    geometry.userData.triangleCount = this.triangleCount;
    geometry.userData.maxSlopeDegrees = Math.atan(steepest) * 180 / Math.PI;
    geometry.userData.heightRange = [this.minHeight, this.maxHeight];
    return geometry;
  }

  /** ---- Queries --------------------------------------------------------- */

  /**
   * Lattice address of a local point: wedge, cell corner and the barycentric
   * weights of the exact rendered triangle that covers it.
   */
  locate(x, z) {
    const n = this.divisions;
    let angle = Math.atan2(z, x);
    if (angle < 0) angle += TAU;
    let wedge = Math.floor(angle / WEDGE_ANGLE);
    if (wedge < 0) wedge = 0;
    if (wedge > 5) wedge = 5;

    const basis = this.wedgeBasis[wedge];
    const scale = n / this.radius;
    let a = (basis.m00 * x + basis.m01 * z) * scale;
    let b = (basis.m10 * x + basis.m11 * z) * scale;
    if (a < 0) a = 0;
    if (b < 0) b = 0;
    const span = a + b;
    if (span > n) {
      // Outside the hexagon: project onto the rim rather than reading garbage.
      const k = n / span;
      a *= k;
      b *= k;
    }

    let i = Math.floor(a);
    let j = Math.floor(b);
    if (i > n) i = n;
    if (j > n) j = n;
    let fa = a - i;
    let fb = b - j;
    if (i + j >= n) {
      const index = latticeVertexIndex(wedge, Math.min(i, n), Math.min(j, n - Math.min(i, n)), n);
      return { wedge, i, j, indices: [index, index, index], weights: [1, 0, 0] };
    }

    if (fa + fb <= 1) {
      return {
        wedge,
        i,
        j,
        indices: [
          latticeVertexIndex(wedge, i, j, n),
          latticeVertexIndex(wedge, i + 1, j, n),
          latticeVertexIndex(wedge, i, j + 1, n),
        ],
        weights: [1 - fa - fb, fa, fb],
      };
    }

    if (i + j > n - 2) {
      // Numerically on the rim band; fall back to the up-triangle corner.
      fa = Math.min(fa, 1);
      fb = Math.min(fb, 1 - fa);
      return {
        wedge,
        i,
        j,
        indices: [
          latticeVertexIndex(wedge, i, j, n),
          latticeVertexIndex(wedge, i + 1, j, n),
          latticeVertexIndex(wedge, i, j + 1, n),
        ],
        weights: [1 - fa - fb, fa, fb],
      };
    }

    return {
      wedge,
      i,
      j,
      indices: [
        latticeVertexIndex(wedge, i + 1, j, n),
        latticeVertexIndex(wedge, i, j + 1, n),
        latticeVertexIndex(wedge, i + 1, j + 1, n),
      ],
      weights: [1 - fb, 1 - fa, fa + fb - 1],
    };
  }

  /** Height of the rendered surface at a sector-local point. */
  heightAt(x, z) {
    const { indices, weights } = this.locate(x, z);
    return this.heights[indices[0]] * weights[0]
      + this.heights[indices[1]] * weights[1]
      + this.heights[indices[2]] * weights[2];
  }

  /** Face normal of the rendered triangle under a sector-local point. */
  normalAt(x, z, target = new THREE.Vector3()) {
    const { indices } = this.locate(x, z);
    const [a, b, c] = indices;
    if (a === b || b === c) return target.set(0, 1, 0);
    const p = this.positions;
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    target.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (target.lengthSq() < 1e-12) return target.set(0, 1, 0);
    target.normalize();
    if (target.y < 0) target.negate();
    return target;
  }

  /** Steepness (rise over run) of the ground under a sector-local point. */
  slopeAt(x, z, scratch = new THREE.Vector3()) {
    const normal = this.normalAt(x, z, scratch);
    const up = Math.max(1e-4, normal.y);
    return Math.sqrt(Math.max(0, 1 - up * up)) / up;
  }

  dispose() {
    this.geometry?.dispose();
  }
}

export function createForestTerrain(radius, config, sectorId = 'HEX_S') {
  return new ForestTerrain({ radius, config, sectorId });
}
