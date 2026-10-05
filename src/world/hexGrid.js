export const INITIAL_SECTORS = Object.freeze([
  Object.freeze({ id: 'HEX_CENTER', q: 0, r: 0 }),
  Object.freeze({ id: 'HEX_N', q: 0, r: -1 }),
  Object.freeze({ id: 'HEX_NE', q: 1, r: -1 }),
  Object.freeze({ id: 'HEX_SE', q: 1, r: 0 }),
  // The new eastward cap shares its northwest and southwest sides with the
  // northeast and southeast sectors, closing the gap on the outer rim.
  Object.freeze({ id: 'HEX_E', q: 2, r: -1 }),
  Object.freeze({ id: 'HEX_S', q: 0, r: 1 }),
  Object.freeze({ id: 'HEX_SW', q: -1, r: 1 }),
  Object.freeze({ id: 'HEX_NW', q: -1, r: 0 }),
]);

// Flat-top axial grid. The order also defines the clockwise direction labels
// used in the sector data and is shared by all future map generation.
export const HEX_DIRECTIONS = Object.freeze([
  Object.freeze({ id: 'N', q: 0, r: -1 }),
  Object.freeze({ id: 'NE', q: 1, r: -1 }),
  Object.freeze({ id: 'SE', q: 1, r: 0 }),
  Object.freeze({ id: 'S', q: 0, r: 1 }),
  Object.freeze({ id: 'SW', q: -1, r: 1 }),
  Object.freeze({ id: 'NW', q: -1, r: 0 }),
]);

// A flat-top regular hexagon, listed counter-clockwise in the x/z plane.
// Exact fractional coordinates avoid tiny trigonometric seams at shared edges.
export const HEX_VERTEX_UNITS = Object.freeze([
  Object.freeze({ x: 1, z: 0 }),
  Object.freeze({ x: 0.5, z: Math.sqrt(3) / 2 }),
  Object.freeze({ x: -0.5, z: Math.sqrt(3) / 2 }),
  Object.freeze({ x: -1, z: 0 }),
  Object.freeze({ x: -0.5, z: -Math.sqrt(3) / 2 }),
  Object.freeze({ x: 0.5, z: -Math.sqrt(3) / 2 }),
]);

// Edge normals for the vertex order above. Each edge points to the axial cell
// on the other side of that complete hex side.
const SIDE_DIRECTIONS = Object.freeze([
  HEX_DIRECTIONS[2], // SE
  HEX_DIRECTIONS[3], // S
  HEX_DIRECTIONS[4], // SW
  HEX_DIRECTIONS[5], // NW
  HEX_DIRECTIONS[0], // N
  HEX_DIRECTIONS[1], // NE
]);

export function axialToWorld(q, r, radius) {
  return {
    x: radius * 1.5 * q,
    z: radius * Math.sqrt(3) * (r + q / 2),
  };
}

export function getHexVertices(centerX, centerZ, radius) {
  return HEX_VERTEX_UNITS.map(({ x, z }) => ({
    x: centerX + radius * x,
    z: centerZ + radius * z,
  }));
}

function coordinateKey(q, r) {
  return `${q},${r}`;
}

/**
 * Create sector records and their exact edge topology from axial coordinates.
 * Adjacent pairs are emitted once as gates; all other sides are outer walls.
 * Pass a larger definition list later to expand the same generator.
 */
export function buildHexMapData(radius, definitions = INITIAL_SECTORS) {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError('Hex radius must be a positive finite number.');
  }

  const sectors = definitions.map((definition, index) => {
    const center = axialToWorld(definition.q, definition.r, radius);
    return {
      id: definition.id,
      q: definition.q,
      r: definition.r,
      center,
      order: index,
      neighbors: [],
    };
  });

  const byCoordinate = new Map();
  const byId = new Map();
  for (const sector of sectors) {
    const key = coordinateKey(sector.q, sector.r);
    if (byCoordinate.has(key)) {
      throw new Error(`Duplicate axial coordinate: ${key}`);
    }
    if (byId.has(sector.id)) {
      throw new Error(`Duplicate sector id: ${sector.id}`);
    }
    byCoordinate.set(key, sector);
    byId.set(sector.id, sector);
  }

  for (const sector of sectors) {
    sector.neighbors = HEX_DIRECTIONS
      .map((direction) => byCoordinate.get(coordinateKey(
        sector.q + direction.q,
        sector.r + direction.r,
      )))
      .filter(Boolean)
      .map((neighbor) => neighbor.id);
  }

  const sharedEdges = [];
  const boundaryEdges = [];

  for (const sector of sectors) {
    const vertices = getHexVertices(sector.center.x, sector.center.z, radius);

    for (let sideIndex = 0; sideIndex < HEX_VERTEX_UNITS.length; sideIndex += 1) {
      const direction = SIDE_DIRECTIONS[sideIndex];
      const neighbor = byCoordinate.get(coordinateKey(
        sector.q + direction.q,
        sector.r + direction.r,
      ));
      const start = vertices[sideIndex];
      const end = vertices[(sideIndex + 1) % vertices.length];
      const center = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
      const length = Math.hypot(end.x - start.x, end.z - start.z);

      if (neighbor) {
        // Each shared side is one portal connection, never two overlapping walls.
        if (sector.order < neighbor.order) {
          sharedEdges.push({
            id: `GATE_${sector.id}__${neighbor.id}`,
            aSectorId: sector.id,
            bSectorId: neighbor.id,
            sideIndex,
            start,
            end,
            center,
            length,
          });
        }
      } else {
        boundaryEdges.push({
          id: `${sector.id}_BOUNDARY_${sideIndex}`,
          sectorId: sector.id,
          sideIndex,
          start,
          end,
          center,
          length,
        });
      }
    }
  }

  const vertices = sectors.flatMap((sector) => (
    getHexVertices(sector.center.x, sector.center.z, radius)
  ));
  const bounds = vertices.reduce((result, point) => ({
    minX: Math.min(result.minX, point.x),
    maxX: Math.max(result.maxX, point.x),
    minZ: Math.min(result.minZ, point.z),
    maxZ: Math.max(result.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });

  return { sectors, byId, sharedEdges, boundaryEdges, bounds, radius };
}

export function isPointInsideHex(x, z, centerX, centerZ, radius, epsilon = 1e-5) {
  const localX = x - centerX;
  const localZ = z - centerZ;
  const apothem = radius * Math.sqrt(3) / 2;

  // The six side normals sit halfway between consecutive vertices.
  for (let side = 0; side < 6; side += 1) {
    const a = HEX_VERTEX_UNITS[side];
    const b = HEX_VERTEX_UNITS[(side + 1) % 6];
    const midpointX = (a.x + b.x) / 2;
    const midpointZ = (a.z + b.z) / 2;
    const normalLength = Math.hypot(midpointX, midpointZ);
    const projection = (localX * midpointX + localZ * midpointZ) / normalLength;
    if (projection > apothem + epsilon) return false;
  }

  return true;
}
