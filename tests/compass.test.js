import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPASS_CARDINALS,
  Compass,
  cardinalIndexForHeading,
  headingDegreesFromYaw,
  normalizeHeading,
} from '../src/ui/Compass.js';

/**
 * The compass touches the DOM in three ways only — `style.setProperty`,
 * `classList`, `textContent` and `appendChild` — so a tiny element stub lets
 * the whole widget (including the card it builds for itself) be tested in
 * plain Node, without a browser and without a DOM implementation.
 */
function makeElement() {
  const classes = new Set();
  return {
    children: [],
    className: '',
    textContent: '',
    attributes: {},
    properties: {},
    style: {
      setProperty(name, value) {
        this[name] = `${value}`;
      },
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      this.attributes[name] = `${value}`;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

function makeCompass({ yaw = 0 } = {}) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => makeElement() };
  const player = { yaw };
  const compass = new Compass({
    root: makeElement(),
    card: makeElement(),
    letters: makeElement(),
    heading: makeElement(),
    cardinal: makeElement(),
    player,
  });
  globalThis.document = previousDocument;
  return { compass, player };
}

test('the bearing is measured clockwise from -Z, with +X due east', () => {
  assert.equal(headingDegreesFromYaw(0), 0, 'looking at -Z is north');
  assert.equal(headingDegreesFromYaw(-Math.PI / 2), 90, 'looking at +X is east');
  assert.equal(headingDegreesFromYaw(Math.PI), 180, 'looking at +Z is south');
  assert.equal(headingDegreesFromYaw(Math.PI / 2), 270, 'looking at -X is west');
  assert.ok(
    Math.abs(headingDegreesFromYaw(-Math.PI * 2 - 0.5) - headingDegreesFromYaw(-0.5)) < 1e-9,
    'a full extra turn does not change the bearing',
  );

  assert.equal(normalizeHeading(-10), 350);
  assert.equal(normalizeHeading(370), 10);
  assert.equal(normalizeHeading(Number.NaN), 0, 'a broken angle cannot break the HUD');
  assert.equal(normalizeHeading(Number.POSITIVE_INFINITY), 0);

  // The eight points are 45 degrees apart, with rounding either side of a seam.
  assert.equal(COMPASS_CARDINALS.length, 8);
  assert.equal(cardinalIndexForHeading(0), 0);
  assert.equal(cardinalIndexForHeading(45), 1);
  assert.equal(cardinalIndexForHeading(112.5), 3);
  assert.equal(cardinalIndexForHeading(350), 0, 'north wraps through 360');
  assert.equal(cardinalIndexForHeading(-45), 7, 'and through the other side');
});

test('the card is built once and the heading is written into it', () => {
  const { compass } = makeCompass();
  const card = compass.card;
  assert.equal(card.children.length, 12, 'twelve ticks, one of them the north mark');
  assert.equal(compass.tickElements.length, 12);
  assert.equal(compass.tickElements[0].style['--angle'], '0deg');
  assert.equal(compass.tickElements[1].style['--angle'], '30deg');
  assert.equal(compass.tickElements[3].className, 'compass-tick is-major');
  assert.equal(compass.tickElements[0].className, 'compass-tick is-major is-north');
  assert.equal(compass.northMark, compass.tickElements[0], 'north is the tick at angle zero');
  assert.equal(compass.letterElements.length, 8);
  assert.deepEqual(
    compass.letterElements.map((element) => element.textContent),
    ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
  );
  assert.equal(compass.letterElements[2].style['--angle'], '90deg');
});

test('the readout, the card transform and the needle follow the look direction', () => {
  const { compass, player } = makeCompass();

  player.yaw = -Math.PI / 2; // east
  compass.update();
  assert.equal(compass.headingDegrees, 90);
  assert.equal(compass.root.style['--heading'], '90.0');
  assert.equal(compass.headingLabel.textContent, '090°');
  assert.equal(compass.cardinalLabel.textContent, 'E');
  assert.equal(compass.letterElements[2].classList.contains('is-active'), true);
  assert.equal(compass.letterElements[0].classList.contains('is-active'), false);
  assert.equal(compass.root.attributes['aria-label'], 'Bussola: 90 gradi, est');

  player.yaw = Math.PI; // south
  compass.update();
  assert.equal(compass.headingLabel.textContent, '180°');
  assert.equal(compass.cardinalLabel.textContent, 'S');
  assert.equal(compass.root.style['--heading'], '180.0');
  assert.equal(compass.letterElements[4].classList.contains('is-active'), true);
  assert.equal(compass.letterElements[2].classList.contains('is-active'), false);

  // Full circle: 350 degrees reads as north, but the number stays honest.
  player.yaw = (-350 / 180) * Math.PI;
  compass.update();
  assert.equal(compass.headingLabel.textContent, '350°');
  assert.equal(compass.cardinalLabel.textContent, 'N');
});

test('an unmoved bearing writes nothing, a turned one writes once', () => {
  const { compass, player } = makeCompass();
  compass.update();
  const writes = compass.writes;

  // Standing still: the compass is a readout, not an animation.
  player.yaw = 0;
  compass.update();
  compass.update();
  assert.equal(compass.writes, writes);
  // One update from the constructor plus three explicit ones.
  assert.equal(compass.updates, 4);

  // A nudge below the write threshold changes nothing on screen...
  player.yaw = -(0.05 * Math.PI) / 180;
  compass.update();
  assert.equal(compass.writes, writes);

  // ...a real turn rewrites the card, and a new degree rewrites the digits.
  player.yaw = -Math.PI / 180;
  compass.update();
  assert.ok(compass.writes > writes);
  const afterTurn = compass.writes;
  assert.equal(compass.headingLabel.textContent, '001°');

  // Half a degree later the digits are the same, but the card keeps turning.
  player.yaw = -(1.4 * Math.PI) / 180;
  compass.update();
  assert.equal(compass.headingLabel.textContent, '001°');
  assert.ok(compass.writes > afterTurn, 'the card is not stepping in whole degrees');
});

test('the accent and the visibility of the widget are switchable', () => {
  const { compass } = makeCompass();
  assert.equal(compass.setAccent(0xf87171), '#f87171');
  assert.equal(compass.root.style['--compass-accent'], '#f87171');
  assert.equal(compass.setAccent(0x2dd4bf), '#2dd4bf');

  assert.equal(compass.setVisible(false), false);
  assert.equal(compass.root.classList.contains('is-hidden'), true);
  assert.equal(compass.setVisible(true), true);
  assert.equal(compass.root.classList.contains('is-hidden'), false);
});

test('a compass with no DOM at all still computes the bearing', () => {
  const previousDocument = globalThis.document;
  delete globalThis.document;
  const player = { yaw: -Math.PI / 2 };
  const compass = new Compass({ player });
  assert.equal(compass.headingDegrees, 90);
  assert.equal(compass.buildCard(), false, 'nothing to build without a document');
  assert.equal(compass.setAccent(0x123456), '#123456');
  assert.equal(compass.update(), 90);
  globalThis.document = previousDocument;
});
