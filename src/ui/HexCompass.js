import { getHexVertices } from '../world/hexGrid.js';
import { getSectorInfo } from '../config/mapConfig.js';

export function layoutHexCompass(sectors, hexRadius, size, padding = 18) {
  if (!sectors?.length) {
    return { size, scale: 1, minX: 0, minZ: 0, cells: [] };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const sector of sectors) {
    minX = Math.min(minX, sector.center.x - hexRadius);
    maxX = Math.max(maxX, sector.center.x + hexRadius);
    minZ = Math.min(minZ, sector.center.z - hexRadius);
    maxZ = Math.max(maxZ, sector.center.z + hexRadius);
  }

  const worldW = Math.max(maxX - minX, 1);
  const worldD = Math.max(maxZ - minZ, 1);
  const inner = Math.max(size - padding * 2, 1);
  const scale = inner / Math.max(worldW, worldD);
  const offsetX = (size - worldW * scale) / 2;
  const offsetY = (size - worldD * scale) / 2;

  const toCanvas = (x, z) => ({
    x: offsetX + (x - minX) * scale,
    y: offsetY + (z - minZ) * scale,
  });

  const cells = sectors.map((sector) => {
    const vertices = getHexVertices(sector.center.x, sector.center.z, hexRadius)
      .map((vertex) => toCanvas(vertex.x, vertex.z));
    const center = toCanvas(sector.center.x, sector.center.z);
    return {
      id: sector.id,
      order: sector.order,
      points: vertices,
      cx: center.x,
      cy: center.y,
    };
  });

  return { size, scale, minX, minZ, offsetX, offsetY, toCanvas, cells };
}

function hexCss(color) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export class HexCompass {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.world = world;
    this.context = canvas.getContext('2d');
    this.size = canvas.width;
    this.layout = layoutHexCompass(world.sectors, world.config.hexRadius, this.size);
    this.visited = new Set();
    this.currentId = null;
  }

  markVisited(sectorId) {
    if (!sectorId) return false;
    const sizeBefore = this.visited.size;
    this.visited.add(sectorId);
    this.currentId = sectorId;
    return this.visited.size !== sizeBefore;
  }

  clearCurrent() {
    this.currentId = null;
  }

  get exploredCount() {
    return this.visited.size;
  }

  draw(playerX, playerZ, facingYaw) {
    const context = this.context;
    if (!context) return;
    const { size, cells, toCanvas } = this.layout;
    context.clearRect(0, 0, size, size);

    context.fillStyle = 'rgba(14, 20, 22, 0.72)';
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = 'rgba(233, 239, 238, 0.16)';
    context.lineWidth = 1.5;
    context.stroke();

    for (const cell of cells) {
      const info = getSectorInfo(cell.id, cell.order);
      const visited = this.visited.has(cell.id);
      const current = this.currentId === cell.id;
      context.beginPath();
      cell.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.closePath();
      context.fillStyle = visited ? hexCss(info.color) : 'rgba(36, 44, 46, 0.92)';
      if (visited) context.globalAlpha = current ? 0.92 : 0.55;
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = current ? hexCss(info.accent) : 'rgba(238, 241, 239, 0.22)';
      context.lineWidth = current ? 2.4 : 1;
      context.stroke();
    }

    if (typeof playerX !== 'number' || typeof playerZ !== 'number' || !toCanvas) return;
    const marker = toCanvas(playerX, playerZ);
    const headingX = -Math.sin(facingYaw ?? 0);
    const headingY = -Math.cos(facingYaw ?? 0);
    const tip = 9;
    const rear = 5.5;
    const side = 4.2;
    context.beginPath();
    context.moveTo(marker.x + headingX * tip, marker.y + headingY * tip);
    context.lineTo(
      marker.x - headingX * rear + headingY * side,
      marker.y - headingY * rear - headingX * side,
    );
    context.lineTo(
      marker.x - headingX * rear - headingY * side,
      marker.y - headingY * rear + headingX * side,
    );
    context.closePath();
    context.fillStyle = '#f4f7f4';
    context.strokeStyle = 'rgba(12, 16, 18, 0.85)';
    context.lineWidth = 1.2;
    context.fill();
    context.stroke();
  }
}
