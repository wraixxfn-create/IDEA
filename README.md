# HEXFIELD — World Foundation

A browser-based Three.js exploration world built from reusable flat-top hexagonal sectors, procedural architecture, a third-person explorer, and a painted sky — complete with sun and clouds — over every sector.

## Run

```bash
npm install
npm run dev
```

For a production build, run `npm run build`. The generated site is static and does not require a backend.

## Controls

- **W / A / S / D** — move relative to the follow camera
- **Shift** — trigger a directional dash (short burst with a cooldown)
- **Mouse** — orbit the third-person camera; the lower orbit limit keeps the camera above the map floor, and flight allows a wider vertical orbit
- The follow-camera distance is fixed (scrolling does not zoom)
- **Double-tap Space** — toggle flight; the second press lifts off
- **Hold Space / Ctrl** — rise / descend while flying; double-tap Space again to land
- **F3** — toggle the top-down development overview and sector/gate annotations
- **Esc** — open the pause menu and release the pointer

## The explorer

The third-person avatar is a fully articulated character (`src/player/CharacterRig.js`) rather than a placeholder primitive. It is built entirely from procedural geometry — no external assets — and merged into one mesh per material and per joint, so a character with ~40 modelled parts still costs about 20 draw calls.

- **Built** — a hooded warden: layered plate over a dark under-suit, a visored helmet with a swept crest, pauldrons, hip guards, armoured cuisses and greaves, and a flight pack with twin thruster housings. Per-vertex ambient occlusion is baked into the plate and cloth colours, so joints and undersides stay defined without a shadow map.
- **Skeleton** — `root → body → hips → torso → (neck → head, arms → elbows → hands, mantle + tabards)`, plus `hips → legs → knees → ankles`. The body pivot carries the lean, the turn banking and the landing squash.
- **Animation** — a small state machine blends idle sway, a gait that scales from a walk to a full sprint, a hover and a glide flight pose, an airborne fall pose, a dash burst and a landing impact. Blends use exponential smoothing, and the gait advances with the *measured* ground speed, so the feet never skate.
- **Cloth** — a shoulder mantle and two belt tabards are animated on the CPU (about 80 vertices each) with a shared wind clock, so the cloth gusts with the forest.
- **Glow** — the chest and hip sigils, the visor eye-line, the thruster rings and the cloth trim all take the accent colour of the sector the explorer is standing in, and pulse with effort while running, dashing or flying.
- **Grounding** — a soft radial contact shadow fades and spreads with altitude, and dash leaves two stretched afterimages behind.
- **Lighting** — the armour also receives a small PMREM environment baked from the world's own sky colours, so the plate reads as metal under the painted cupolas.

## Map foundation

`src/config/mapConfig.js` contains shared scale, movement, sky, and material settings. `src/world/hexGrid.js` defines the axial grid, neighbors, shared edges, and outer boundary edges. `src/world/HexMap.js` generates the floors, walls, portal architecture, animated doors, and collision geometry from that data. Sector IDs appear only in the development overview.

The map contains **eight** radius-220 sectors. The original center-plus-six cluster has a new outer **HEX_E** sector at axial coordinate `(2, -1)`, bridging the outer edges of `HEX_NE` and `HEX_SE`. Its addition creates 14 shared portals and 20 perimeter walls. Walls are **45 world units** high.

Each portal is a detailed, sector-lit assembly with a reinforced metal exoskeleton, layered jamb armour, a hex crest, and twin sliding leaves. The leaves open smoothly as the explorer approaches and close after a short delay; their collision moves with the animation. The opening remains tall enough for walking and low flight, while the solid lintel still blocks higher flight.

## Sky, sun and clouds

Every sector is capped by a curved hexagonal cupola that is **painted with a real sky** rather than left transparent: `src/world/SkyDome.js` shades the shell from the view direction, so the gradient, the sun and the clouds behave as if they were at infinity while the cupola keeps its architectural silhouette from outside. All eight domes share one sun, and the directional key light in `src/main.js` is aimed along exactly the same vector, so the light the explorer walks in always agrees with the sky above.

- **Gradient** — a realistic zenith-to-horizon ramp with a haze band, tinted towards each sector's own accent so every hex keeps its identity.
- **Sun** — a disc with a tight core, a wide halo and a warm wash across the sky around it.
- **Clouds** — two layers: a procedural high-altitude deck shaded inside the sky shader, plus a deck of instanced, softly lumpy cloud bodies drifting on their own lanes inside each cupola. Cloud coverage is calibrated against the noise distribution (`cloudThresholdFor`), so "42% coverage" really covers 42% of the sky instead of veiling all of it.
- **Ribs** — thin structural meridians and rings stay visible against the sky, and the shells step aside automatically in the F3 overview so the map underneath is never hidden.

## HEX_S — the forest biome

`HEX_S` is the showcase sector and carries the densest treatment:

- **Ground** — a seeded soil surface with a gentle interior relief that fades to the exact shared-edge height, so adjacent hexagons stay seamless. Every terrain vertex is shaded for mossy hollows, sun-bleached leaf drifts and damp humus, and a deeper layer of individual leaf litter is scattered across it.
- **Undergrowth** — `src/world/ForestDetail.js` plants grass and fern tufts, shrubs, mossy boulders, fallen logs and mushroom clusters. Everything follows a density field, so the floor grows in drifts and clearings instead of an even sprinkle, and every instance is planted on the terrain relief and kept inside the hex.
- **Pines** — `src/world/PineGrove.js` grows mature spruces and saplings with exposed roots, bark grain, hanging cones, per-tree height and needle-hue variation, and fuller needle sprays.
- **Wind** — `src/world/wind.js` injects a shared sway into the standard vertex shader. One clock drives the crowns, the grass and the ferns, so the whole forest breathes on the same gust while trunks stay planted.
- **Mist** — two procedural ground-mist layers drift between the trunks, with a soft radial falloff and no texture seam.
- **Light** — a dedicated green, amber and teal canopy-light rig plus a brighter canopy wash keeps the dense grove readable; the forest also receives the fullest cloud deck and the strongest sun halo.

The pause menu offers resume and map overview. **Esc** also returns from the overview to the menu; **F3** toggles the overview.

Run the topology, sky, undergrowth, character and controller checks with:

```bash
npm test
```
