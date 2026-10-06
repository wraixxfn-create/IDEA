/**
 * The heading compass in the top-left corner of the HUD.
 *
 * It reads the explorer's look direction — the same `player.yaw` the camera and
 * the map needle use — and turns it into a bearing, a rotating compass card and
 * a three-digit readout.
 *
 * The world has no authored north/south axis, so the compass defines one and
 * every other heading in the game follows it: **north is -Z** (the top of the
 * minimap) and **east is +X** (the right of the minimap). The view direction is
 * `(-sin yaw, -cos yaw)`, which makes the bearing simply `-yaw` normalised into
 * `[0, 360)`.
 *
 * The card rotates by a single CSS custom property (`--heading`) on the root:
 * the ring of ticks and letters turns by `-heading`, each letter counter-rotates
 * so it stays upright, and the fixed index at the top marks the current bearing.
 * One property write per frame, no per-letter DOM churn.
 */

export const COMPASS_CARDINALS = Object.freeze([
  Object.freeze({ short: 'N', name: 'nord' }),
  Object.freeze({ short: 'NE', name: 'nord-est' }),
  Object.freeze({ short: 'E', name: 'est' }),
  Object.freeze({ short: 'SE', name: 'sud-est' }),
  Object.freeze({ short: 'S', name: 'sud' }),
  Object.freeze({ short: 'SW', name: 'sud-ovest' }),
  Object.freeze({ short: 'W', name: 'ovest' }),
  Object.freeze({ short: 'NW', name: 'nord-ovest' }),
]);

/** Normalises any angle into `[0, 360)`. */
export function normalizeHeading(degrees) {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = degrees % 360;
  const normalized = wrapped < 0 ? wrapped + 360 : wrapped;
  // IEEE 754 can hand back -0 here; a HUD wants a plain zero.
  return normalized === 0 ? 0 : normalized;
}

/**
 * The bearing the explorer is looking at, in degrees clockwise from north.
 * North is -Z and east is +X, matching the minimap's own axes.
 */
export function headingDegreesFromYaw(yaw) {
  return normalizeHeading((-yaw * 180) / Math.PI);
}

/** The nearest of the eight compass points, as an index into the table. */
export function cardinalIndexForHeading(degrees) {
  const step = 360 / COMPASS_CARDINALS.length;
  const index = Math.round(normalizeHeading(degrees) / step) % COMPASS_CARDINALS.length;
  return index < 0 ? index + COMPASS_CARDINALS.length : index;
}

export class Compass {
  constructor({
    root = null,
    card = null,
    letters = null,
    heading = null,
    cardinal = null,
    player = null,
    getHeading = null,
  } = {}) {
    this.root = root;
    this.card = card;
    this.letters = letters;
    this.headingLabel = heading;
    this.cardinalLabel = cardinal;
    this.player = player;
    this.getHeading = getHeading;
    this.tickElements = [];
    this.letterElements = [];
    this.northMark = null;
    this.accent = null;
    this.renderedHeading = undefined;
    this.renderedRounded = undefined;
    this.headingDegrees = 0;
    this.cardinalIndex = 0;
    // Frame bookkeeping: `updates` counts calls, `writes` counts the DOM work
    // that actually had to happen (a bearing that has not moved writes nothing).
    this.updates = 0;
    this.writes = 0;
    this.buildCard();
    this.update();
  }

  /** Reads the bearing from the controller, or from an injected source. */
  readHeading() {
    if (typeof this.getHeading === 'function') {
      return normalizeHeading(this.getHeading(this));
    }
    return headingDegreesFromYaw(this.player?.yaw ?? 0);
  }

  /**
   * Draws the ticks and the eight letters once. Everything is positioned from
   * the `--angle` custom property, so the whole ring is static markup that the
   * card transform and the heading variable animate together.
   */
  buildCard() {
    const create = globalThis.document?.createElement?.bind(globalThis.document);
    if (!create || !this.card || typeof this.card.appendChild !== 'function') return false;

    // Twelve ticks: the four cardinals are long, the rest hairlines, and the
    // one at angle zero is the north mark (drawn in the sector accent, so the
    // ring carries its own north instead of a second overlapping glyph).
    for (let tick = 0; tick < 12; tick += 1) {
      const element = create('span');
      const classes = ['compass-tick'];
      if (tick % 3 === 0) classes.push('is-major');
      if (tick === 0) classes.push('is-north');
      element.className = classes.join(' ');
      element.style.setProperty('--angle', `${tick * 30}deg`);
      this.card.appendChild(element);
      this.tickElements.push(element);
    }
    this.northMark = this.tickElements[0];

    if (this.letters && typeof this.letters.appendChild === 'function') {
      for (let index = 0; index < COMPASS_CARDINALS.length; index += 1) {
        const cardinal = COMPASS_CARDINALS[index];
        const element = create('span');
        element.className = `compass-letter letter-${cardinal.short.toLowerCase()}`;
        element.textContent = cardinal.short;
        element.style.setProperty('--angle', `${(index * 360) / COMPASS_CARDINALS.length}deg`);
        this.letters.appendChild(element);
        this.letterElements.push(element);
      }
    }
    return true;
  }

  /** Recolours the needle and the north mark with the current sector accent. */
  setAccent(color) {
    const hex = `#${(Number(color) >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
    this.accent = hex;
    this.root?.style?.setProperty?.('--compass-accent', hex);
    return hex;
  }

  /** Hides the whole widget, for whoever needs the corner back. */
  setVisible(visible) {
    this.root?.classList?.toggle?.('is-hidden', !visible);
    return Boolean(visible);
  }

  /**
   * One call per frame. The card is only rotated when the bearing actually
   * changed by a tenth of a degree, and the digits only when the rounded
   * bearing did — the compass is a readout, not an animation.
   */
  update() {
    const heading = this.readHeading();
    this.updates += 1;
    const rounded = Math.round(heading) % 360;
    const cardinalIndex = cardinalIndexForHeading(heading);
    const cardinal = COMPASS_CARDINALS[cardinalIndex];

    if (this.renderedHeading === undefined || Math.abs(heading - this.renderedHeading) >= 0.1) {
      this.renderedHeading = heading;
      this.root?.style?.setProperty?.('--heading', heading.toFixed(1));
      this.writes += 1;
    }

    if (this.renderedRounded !== rounded) {
      this.renderedRounded = rounded;
      if (this.headingLabel) this.headingLabel.textContent = `${String(rounded).padStart(3, '0')}°`;
      this.writes += 1;
    }

    if (this.cardinalIndex !== cardinalIndex) {
      this.cardinalIndex = cardinalIndex;
      if (this.cardinalLabel) this.cardinalLabel.textContent = cardinal.short;
      if (this.letterElements.length) {
        this.letterElements[cardinalIndex]?.classList?.add('is-active');
        for (let index = 0; index < this.letterElements.length; index += 1) {
          if (index !== cardinalIndex) this.letterElements[index].classList?.remove('is-active');
        }
      }
      this.root?.setAttribute?.(
        'aria-label',
        `Bussola: ${rounded} gradi, ${cardinal.name}`,
      );
      this.writes += 1;
    }

    this.headingDegrees = heading;
    return heading;
  }
}
