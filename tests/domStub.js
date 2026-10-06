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

/**
 * PlayerController listens on `window` and `document`. These shims let the
 * controller be constructed (and disposed) inside a plain Node test, and they
 * keep whatever the canvas stub already installed.
 */
export function installInputStub() {
  const noop = () => {};
  const listeners = new Map();
  const addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  const removeEventListener = (type, listener) => {
    listeners.get(type)?.delete(listener);
  };

  if (!globalThis.window) globalThis.window = {};
  globalThis.window.addEventListener ??= addEventListener;
  globalThis.window.removeEventListener ??= removeEventListener;
  globalThis.window.dispatch = (type, event) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  if (!globalThis.document) globalThis.document = {};
  globalThis.document.addEventListener ??= noop;
  globalThis.document.removeEventListener ??= noop;
  if (!('pointerLockElement' in globalThis.document)) {
    globalThis.document.pointerLockElement = null;
  }
  return globalThis.window;
}
