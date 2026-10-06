import { getHexVertices } from '../world/hexGrid.js';
import { getSectorInfo } from '../config/mapConfig.js';

/**
 * The world map overlay (M).
 *
 * It lives in its own module mainly because of one bug: the renderer used to
 * read `canvas.width`, multiply it by the device pixel ratio and write it
 * back — every single animation frame. On a 2x display the bitmap therefore
 * doubled sixty times a second, and within a second the tab was busy
 * allocating gigapixel canvases and stopped answering the keyboard, so M could
 * no longer close the map it had just opened.
 *
 * The CSS size is now captured once, the backing store is only touched when
 * the device pixel ratio actually changes, and the transform is *set* rather
 * than accumulated.
 */
export class Minimap {
  constructor({ canvas, legend = null, world, player, hexRadius, margin = 30 }) {
    this.canvas = canvas;
    this.legend = legend;
    this.world = world;
    this.player = player;
    this.hexRadius = hexRadius;
    this.margin = margin;
    // CSS owns the layout size; the bitmap follows it and the pixel ratio.
    this.cssWidth = Number(canvas?.width) || 420;
    this.cssHeight = Number(canvas?.height) || 400;
    this.measureCssSize();
    this.pixelRatio = 0;
    this.renders = 0;
  }

  /**
   * Reads the size the stylesheet gave the canvas. Never writes it back: the
   * layout stays responsive and the bitmap simply follows.
   */
  measureCssSize() {
    const rect = this.canvas?.getBoundingClientRect?.();
    if (rect && rect.width > 1 && rect.height > 1) {
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;
    }
    return { width: this.cssWidth, height: this.cssHeight };
  }

  /** Resizes the backing store only when it is actually the wrong size. */
  syncCanvasSize(pixelRatio) {
    const ratio = Math.max(0.5, Math.min(pixelRatio || 1, 2));
    this.measureCssSize();
    const backingWidth = Math.round(this.cssWidth * ratio);
    const backingHeight = Math.round(this.cssHeight * ratio);
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    this.pixelRatio = ratio;
    return ratio;
  }

  render(pixelRatio = globalThis.devicePixelRatio || 1) {
    const canvas = this.canvas;
    if (!canvas) return false;
    const context = canvas.getContext('2d');
    if (!context) return false;

    const ratio = this.syncCanvasSize(pixelRatio);
    const width = this.cssWidth;
    const height = this.cssHeight;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const { world, player, margin } = this;
    const bounds = world.bounds;
    const worldWidth = bounds.maxX - bounds.minX;
    const worldDepth = bounds.maxZ - bounds.minZ;
    const scale = Math.min(
      (width - margin * 2) / worldWidth,
      (height - margin * 2) / worldDepth,
    );
    const offsetX = (width - worldWidth * scale) / 2;
    const offsetZ = (height - worldDepth * scale) / 2;
    const toScreen = (wx, wz) => ({
      x: offsetX + (wx - bounds.minX) * scale,
      y: offsetZ + (wz - bounds.minZ) * scale,
    });

    const currentSector = world.getSectorAt(player.position.x, player.position.z);
    const playerScreen = toScreen(player.position.x, player.position.z);

    for (const sector of world.sectors) {
      const info = getSectorInfo(sector.id, sector.order);
      const screenVerts = getHexVertices(sector.center.x, sector.center.z, this.hexRadius)
        .map((vertex) => toScreen(vertex.x, vertex.z));

      context.beginPath();
      context.moveTo(screenVerts[0].x, screenVerts[0].y);
      for (let i = 1; i < screenVerts.length; i += 1) {
        context.lineTo(screenVerts[i].x, screenVerts[i].y);
      }
      context.closePath();

      const isCurrent = currentSector?.id === sector.id;
      const baseColor = `#${info.accent.toString(16).padStart(6, '0')}`;
      context.fillStyle = isCurrent ? `${baseColor}38` : 'rgba(22, 28, 30, 0.55)';
      context.fill();
      context.strokeStyle = isCurrent ? baseColor : 'rgba(200, 215, 210, 0.28)';
      context.lineWidth = isCurrent ? 2.2 : 1;
      context.stroke();

      const center = toScreen(sector.center.x, sector.center.z);
      context.fillStyle = isCurrent ? '#ffffff' : 'rgba(220, 230, 226, 0.6)';
      context.font = isCurrent
        ? '700 11px ui-monospace, monospace'
        : '500 9px ui-monospace, monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(sector.id, center.x, center.y - 6);
      context.fillStyle = isCurrent ? 'rgba(255,255,255,0.72)' : 'rgba(200, 210, 206, 0.42)';
      context.font = '500 8px ui-sans-serif, system-ui, sans-serif';
      context.fillText(info.name, center.x, center.y + 8);
    }

    // Portals between sectors.
    context.strokeStyle = 'rgba(235, 186, 105, 0.45)';
    context.lineWidth = 1.5;
    for (const gate of world.gates) {
      const point = toScreen(gate.center.x, gate.center.z);
      context.beginPath();
      context.arc(point.x, point.y, 3, 0, Math.PI * 2);
      context.stroke();
    }

    // The explorer, with a little heading needle.
    context.fillStyle = '#ef6456';
    context.shadowColor = '#ef6456';
    context.shadowBlur = 8;
    context.beginPath();
    context.arc(playerScreen.x, playerScreen.y, 5, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;

    const needle = 12;
    context.strokeStyle = '#ef6456';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(playerScreen.x, playerScreen.y);
    context.lineTo(
      playerScreen.x - Math.sin(player.facingYaw) * needle,
      playerScreen.y - Math.cos(player.facingYaw) * needle,
    );
    context.stroke();

    if (this.legend) {
      if (currentSector) {
        const info = getSectorInfo(currentSector.id, currentSector.order);
        const accent = info.accent.toString(16).padStart(6, '0');
        this.legend.innerHTML = `<span><span class="legend-dot" style="background:#ef6456"></span>`
          + `Tu sei in <strong style="color:#${accent}">${info.name}</strong></span>`;
      } else {
        this.legend.innerHTML = '<span><span class="legend-dot" style="background:#ef6456"></span>'
          + 'Posizione sconosciuta</span>';
      }
    }

    this.renders += 1;
    return true;
  }
}
