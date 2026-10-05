import * as THREE from 'three';

/**
 * Distance from the centre of a flat-top hexagon to its boundary, measured
 * along a ray leaving the centre at `angle`. The six side normals sit at
 * 30-degree increments, so projecting the ray onto the nearest normal gives
 * the exact intersection with the flat-top hex.
 */
export function hexBoundaryDistanceAtAngle(radius, angle) {
  const apothem = radius * Math.sqrt(3) / 2;
  const nearestNormal = Math.round((angle - Math.PI / 6) / (Math.PI / 3))
    * (Math.PI / 3) + Math.PI / 6;
  return apothem / Math.cos(angle - nearestNormal);
}

/**
 * A curved hexagonal cupola. The plan follows the exact hex boundary while the
 * profile is a quarter ellipse, so the spring line is a true hexagon and the
 * apex stays a single point.
 */
export function createHexDomeGeometry(radius, baseHeight, domeHeight, radialSegments, verticalSegments) {
  const sampleCount = radialSegments * 6;
  const positions = [];
  const indices = [];
  const rings = [];

  for (let row = 0; row < verticalSegments; row += 1) {
    const progress = row / verticalSegments;
    const profile = Math.cos(progress * Math.PI / 2);
    const y = baseHeight + Math.sin(progress * Math.PI / 2) * domeHeight;
    const ringStart = positions.length / 3;
    rings.push(ringStart);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const angle = sample / sampleCount * Math.PI * 2;
      const boundary = hexBoundaryDistanceAtAngle(radius, angle);
      positions.push(
        Math.cos(angle) * boundary * profile,
        y,
        Math.sin(angle) * boundary * profile,
      );
    }
  }

  const apexIndex = positions.length / 3;
  positions.push(0, baseHeight + domeHeight, 0);
  for (let row = 0; row < rings.length - 1; row += 1) {
    const innerStart = rings[row];
    const outerStart = rings[row + 1];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const next = (sample + 1) % sampleCount;
      const inner = innerStart + sample;
      const innerNext = innerStart + next;
      const outer = outerStart + sample;
      const outerNext = outerStart + next;
      indices.push(inner, outer, outerNext);
      indices.push(inner, outerNext, innerNext);
    }
  }

  const finalRing = rings[rings.length - 1];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const next = (sample + 1) % sampleCount;
    indices.push(finalRing + sample, apexIndex, finalRing + next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = 'HexagonalDomeGeometry';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Structural ribs for a cupola: horizontal rings plus six curved meridians
 * that meet at the apex. Drawn as line segments so the shell keeps reading as
 * architecture from the floor of the sector.
 */
export function createHexDomeRibGeometry(radius, baseHeight, domeHeight, radialSegments, verticalSegments) {
  const sampleCount = radialSegments * 6;
  const positions = [];
  const addLine = (a, b) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  const pointAt = (angle, progress) => {
    const profile = Math.cos(progress * Math.PI / 2);
    const boundary = hexBoundaryDistanceAtAngle(radius, angle);
    return new THREE.Vector3(
      Math.cos(angle) * boundary * profile,
      baseHeight + Math.sin(progress * Math.PI / 2) * domeHeight,
      Math.sin(angle) * boundary * profile,
    );
  };

  for (let row = 0; row < verticalSegments; row += 1) {
    const progress = row / verticalSegments;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      addLine(
        pointAt(sample / sampleCount * Math.PI * 2, progress),
        pointAt((sample + 1) % sampleCount / sampleCount * Math.PI * 2, progress),
      );
    }
  }
  for (let sample = 0; sample < 6; sample += 1) {
    const angle = sample / 6 * Math.PI * 2;
    for (let row = 0; row < verticalSegments - 1; row += 1) {
      addLine(pointAt(angle, row / verticalSegments), pointAt(angle, (row + 1) / verticalSegments));
    }
    addLine(pointAt(angle, (verticalSegments - 1) / verticalSegments),
      new THREE.Vector3(0, baseHeight + domeHeight, 0));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = 'HexagonalDomeRibs';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
