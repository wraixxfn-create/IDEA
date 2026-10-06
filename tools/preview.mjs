/**
 * A tiny software previewer used while developing the procedural props.
 *
 * The world is drawn by the GPU, but the rigs are built on the CPU — and when
 * a wing has to fold against a flank without a feather poking through the
 * breast, being able to look at the model from Node is worth more than any
 * number of assertions. This module rasterises a three.js scene graph into a
 * PNG (flat Lambert shading, a z-buffer and vertex colours) so the rig can be
 * eyeballed from a terminal, in stills or in a contact sheet of a whole cycle.
 *
 * It is a development tool: nothing in `src/` imports it and `vite build`
 * never sees it.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as THREE from 'three';

/* ---- PNG ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- Rasteriser --------------------------------------------------------- */

const DEFAULT_LIGHT = new THREE.Vector3(-0.42, 0.56, -0.72).normalize();

function shade(color, normal, lights) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const light of lights) {
    const diffuse = Math.max(0, normal.dot(light.direction)) * light.intensity;
    r += light.color.r * (light.ambient + diffuse);
    g += light.color.g * (light.ambient + diffuse);
    b += light.color.b * (light.ambient + diffuse);
  }
  return [color.r * r, color.g * g, color.b * b];
}

/**
 * Rasterise `root` (a three.js Object3D) with `camera` into an RGBA buffer,
 * then alpha-composite it over `background`.
 */
export function renderToBuffer(root, camera, { width = 640, height = 480, background = 0xdfe6e8, lights = null } = {}) {
  const lightList = lights ?? [
    { direction: DEFAULT_LIGHT, color: new THREE.Color(0xfff6e2), intensity: 0.86, ambient: 0.34 },
    { direction: DEFAULT_LIGHT.clone().multiplyScalar(-1).setY(0.25).normalize(), color: new THREE.Color(0x93b7c9), intensity: 0.3, ambient: 0 },
  ];

  const color = new Uint8Array(width * height * 4);
  const depth = new Float32Array(width * height).fill(Infinity);
  const bg = new THREE.Color(background);
  for (let i = 0; i < width * height; i += 1) {
    color[i * 4] = bg.r * 255;
    color[i * 4 + 1] = bg.g * 255;
    color[i * 4 + 2] = bg.b * 255;
    color[i * 4 + 3] = 255;
  }

  root.updateWorldMatrix(true, true);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const viewMatrix = camera.matrixWorldInverse.clone();
  const projection = camera.projectionMatrix.clone();

  const projected = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  const world = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const tints = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  const normal = new THREE.Vector3();
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();

  root.traverse((object) => {
    if (!object.isMesh) return;
    let visible = true;
    for (let parent = object; parent; parent = parent.parent) visible = visible && parent.visible;
    if (!visible) return;
    const geometry = object.geometry;
    const position = geometry.attributes.position;
    if (!position) return;
    const index = geometry.index;
    const vertexColor = geometry.attributes.color;
    const materialColor = object.material?.color ?? new THREE.Color(0xffffff);
    const side = object.material?.side ?? THREE.FrontSide;
    const doubleSided = side === THREE.DoubleSide;
    const skinned = object.isSkinnedMesh && object.skeleton ? object : null;
    if (skinned) skinned.skeleton.update();
    // Morph targets: the wing fold is a shape change, so the software
    // rasteriser has to apply it too or the preview would lie.
    const morphAttributes = geometry.morphAttributes?.position ?? [];
    const morphInfluences = object.morphTargetInfluences ?? [];
    const morphs = [];
    morphAttributes.forEach((attribute, target) => {
      const influence = morphInfluences[target] ?? 0;
      if (Math.abs(influence) > 1e-4) morphs.push([attribute, influence]);
    });
    const count = index ? index.count : position.count;

    for (let i = 0; i < count; i += 3) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertexIndex = index ? index.getX(i + corner) : i + corner;
        const point = world[corner].fromBufferAttribute(position, vertexIndex);
        for (const [attribute, influence] of morphs) {
          point.x += attribute.getX(vertexIndex) * influence;
          point.y += attribute.getY(vertexIndex) * influence;
          point.z += attribute.getZ(vertexIndex) * influence;
        }
        // `applyBoneTransform` already answers in world space; a skinned vertex
        // must not be pushed through the mesh's own matrix a second time.
        if (skinned) object.applyBoneTransform(vertexIndex, point);
        else object.localToWorld(point);
        if (vertexColor) {
          tints[corner].setRGB(
            vertexColor.getX(vertexIndex),
            vertexColor.getY(vertexIndex),
            vertexColor.getZ(vertexIndex),
          );
        } else {
          tints[corner].setRGB(1, 1, 1);
        }
        tints[corner].multiply(materialColor);
      }

      edgeA.subVectors(world[1], world[0]);
      edgeB.subVectors(world[2], world[0]);
      normal.crossVectors(edgeA, edgeB);
      if (normal.lengthSq() < 1e-12) continue;
      normal.normalize();

      const base = tints[0].clone().add(tints[1]).add(tints[2]).multiplyScalar(1 / 3);
      const face = shade(base, normal, lightList);

      for (let corner = 0; corner < 3; corner += 1) {
        projected[corner]
          .set(world[corner].x, world[corner].y, world[corner].z, 1)
          .applyMatrix4(viewMatrix)
          .applyMatrix4(projection);
      }
      drawTriangle(projected[0], projected[1], projected[2], face, {
        width, height, color, depth, doubleSided,
      });
    }
  });

  return { width, height, data: color };
}

function drawTriangle(a, b, c, face, { width, height, color, depth, doubleSided }) {
  if (a.w <= 0.0001 || b.w <= 0.0001 || c.w <= 0.0001) return;
  const ax = (a.x / a.w * 0.5 + 0.5) * width;
  const ay = (0.5 - a.y / a.w * 0.5) * height;
  const az = a.z / a.w;
  const bx = (b.x / b.w * 0.5 + 0.5) * width;
  const by = (0.5 - b.y / b.w * 0.5) * height;
  const bz = b.z / b.w;
  const cx = (c.x / c.w * 0.5 + 0.5) * width;
  const cy = (0.5 - c.y / c.w * 0.5) * height;
  const cz = c.z / c.w;

  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const flip = area > 0;
  if (flip && !doubleSided) return;

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  const inverse = 1 / area;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inverse;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inverse;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.0005 || w1 < -0.0005 || w2 < -0.0005) continue;
      const z = w0 * az + w1 * bz + w2 * cz;
      const offset = y * width + x;
      if (z >= depth[offset]) continue;
      depth[offset] = z;
      color[offset * 4] = Math.min(255, face[0] * 255);
      color[offset * 4 + 1] = Math.min(255, face[1] * 255);
      color[offset * 4 + 2] = Math.min(255, face[2] * 255);
    }
  }
}

/**
 * A contact sheet: `frames` renderings laid out in a grid inside one PNG. This
 * is how a flap cycle is reviewed — twelve poses side by side show the arc of
 * the wing in one glance, which a single still never can.
 */
export function renderContactSheet(root, camera, frames, {
  columns = 4,
  cellWidth = 320,
  cellHeight = 240,
  background = 0xdfe6e8,
  label = null,
  lights = null,
} = {}) {
  const rows = Math.ceil(frames.length / columns);
  const width = columns * cellWidth;
  const height = rows * cellHeight;
  const sheet = new Uint8Array(width * height * 4);
  const bg = new THREE.Color(background);
  for (let i = 0; i < width * height; i += 1) {
    sheet[i * 4] = bg.r * 255;
    sheet[i * 4 + 1] = bg.g * 255;
    sheet[i * 4 + 2] = bg.b * 255;
    sheet[i * 4 + 3] = 255;
  }

  frames.forEach((frame, index) => {
    if (typeof frame === 'function') frame(index);
    const cell = renderToBuffer(root, camera, { width: cellWidth, height: cellHeight, background, lights });
    const column = index % columns;
    const row = Math.floor(index / columns);
    for (let y = 0; y < cellHeight; y += 1) {
      for (let x = 0; x < cellWidth; x += 1) {
        const source = (y * cellWidth + x) * 4;
        const targetX = column * cellWidth + x;
        const targetY = row * cellHeight + y;
        const target = (targetY * width + targetX) * 4;
        sheet[target] = cell.data[source];
        sheet[target + 1] = cell.data[source + 1];
        sheet[target + 2] = cell.data[source + 2];
        sheet[target + 3] = 255;
      }
    }
  });

  if (label) drawLabel(sheet, width, height, label);
  return { width, height, data: sheet };
}

/** A blocky 5x7 caption, so a sheet says what it is after it is saved. */
function drawLabel(sheet, width, height, text) {
  const glyphs = LABEL_FONT;
  let x = 6;
  const y = height - 16;
  for (const character of text.toUpperCase()) {
    const glyph = glyphs[character] ?? glyphs[' '];
    if (!glyph) {
      x += 6;
      continue;
    }
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row][column] !== '1') continue;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const px = x + column * 2 + dx;
            const py = y + row * 2 + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const offset = (py * width + px) * 4;
            sheet[offset] = 40;
            sheet[offset + 1] = 44;
            sheet[offset + 2] = 48;
            sheet[offset + 3] = 255;
          }
        }
      }
    }
    x += 12;
  }
}

const LABEL_FONT = {
  ' ': null,
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

export function savePng(path, image) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(image.width, image.height, image.data));
  return path;
}
