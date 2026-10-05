/**
 * A tiny deterministic PRNG (LCG). Every procedural scatter in the world uses
 * one of these so a given seed always rebuilds the same forest, clouds and
 * undergrowth, on every machine and on every reload.
 */
export function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function between(random, min, max) {
  return min + random() * (max - min);
}
