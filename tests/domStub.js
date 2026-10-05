/**
 * HexMap only uses a canvas for the optional debug labels. A tiny canvas stub
 * keeps the structural tests runnable in plain Node without a DOM.
 */
export function installCanvasStub() {
  if (globalThis.document?.createElement) return;
  const canvasContext = {
    beginPath() {},
    roundRect() {},
    fill() {},
    stroke() {},
    fillText() {},
  };
  for (const property of [
    'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline',
  ]) {
    Object.defineProperty(canvasContext, property, { set() {}, configurable: true });
  }
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext }),
  };
}
