# HEXFIELD — World Foundation

A browser-based Three.js exploration world built from reusable flat-top hexagonal sectors, procedural architecture, an explorer you can follow or look through, and a painted sky — complete with sun and clouds — over every sector.

## Run

```bash
npm install
npm run dev
```

For a production build, run `npm run build`. The generated site is static and does not require a backend.

## Controls

- **W / A / S / D** — move relative to the camera
- **Shift** — trigger a directional dash (short burst with a cooldown)
- **Mouse** — orbit in third person, look around in first person; the follow camera keeps itself above the terrain, and flight allows a wider vertical orbit
- **V** — switch between third and first person (also on the pause menu; the choice is remembered)
- **M** — open the world map, and press it again to close it (**Esc** and the ✕ button close it too)
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

## Two views

Press **V** (or use the pause-menu button) to swap the camera between the two modes at any time; the choice is kept in `localStorage`, so the world reopens in the view you left it in.

- **Third person** — the orbiting follow camera. It no longer only checks the ground directly beneath the lens: the whole boom from the explorer to the camera is sampled against the relief, so a bank rising behind the explorer pushes the camera up and over instead of burying it in the soil (`cameraFloorClearance`, `cameraClearanceSamples`).
- **First person** — the lens rides at eye height (`firstPersonEyeHeight`, 1.63 u) a hand's width in front of the chest (`firstPersonEyeForward`), so looking down shows the explorer's own torso and boots rather than the inside of its helmet. The helmet itself is hidden, the body turns to follow the look direction instead of the input direction, the pitch limiter is released (you can look straight up at the cupola) and a small gait-driven head bob (`firstPersonBob`) rides on the walk.

## World map

**M** opens the overview in `src/ui/Minimap.js` and **M** closes it again (so do **Esc** and the ✕ in the panel's header). Opening it releases the pointer lock and remembers whether the explorer was playing, so closing the map drops straight back into the world instead of into the pause menu.

The panel draws the eight sectors, their portals and the explorer's position and heading on a 2D canvas at 12 Hz. The bitmap is resized only when the device pixel ratio actually changes — the canvas used to be multiplied by that ratio on every single frame, which within a second left the tab allocating gigapixel canvases and far too busy to answer the keypress that would have closed the map.

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

- **Ground** — `src/world/ForestTerrain.js` bakes a real forest floor: a hexagonal triangular lattice (96 divisions, ~28 k welded vertices, 55 k triangles) displaced by warped fractal noise, relaxed, slope-limited and faded to the exact shared-edge height, so adjacent hexagons stay seamless. Every terrain vertex is shaded for mossy hollows, sun-bleached leaf drifts, damp humus and bare scree on the steep faces, and hand-sized leaf litter is scattered over it, each leaf lying on the slope it fell on.
- **Undergrowth** — `src/world/ForestDetail.js` plants grass and fern tufts, shrubs, mossy boulders, fallen logs and mushroom clusters. Everything follows a density field, so the floor grows in drifts and clearings instead of an even sprinkle, and every instance is planted on the terrain relief, tilted into the slope it stands on, and kept inside the hex.
- **Pines** — `src/world/PineGrove.js` grows mature spruces and saplings with exposed roots, bark grain, hanging cones, per-tree height and needle-hue variation, and fuller needle sprays.
- **Wind** — `src/world/wind.js` injects a shared sway into the standard vertex shader. One clock drives the crowns, the grass and the ferns, so the whole forest breathes on the same gust while trunks stay planted.
- **Mist** — procedural ground-mist layers drift between the trunks with a soft radial falloff and no texture seam, hung low enough that the fog pools in the hollows while the crowns of the relief break through it.
- **Light** — a dedicated green, amber and teal canopy-light rig plus a brighter canopy wash keeps the dense grove readable; the forest also receives the fullest cloud deck and the strongest sun halo.

### One surface for the eye and the feet

The old forest floor was drawn from one formula and collided against another, so the explorer sank up to **3.8 u** into the middle of the sector and, in a quarter of its area, walked under a mesh that was drawn above it. `ForestTerrain` now owns both: the lattice is baked once, and `heightAt` / `normalAt` / `slopeAt` read the **same vertex buffer** the GPU draws, through the barycentric coordinates of the triangle the explorer is standing on.

- Height lookups agree with a raycast against the rendered mesh to under **0.001 u** anywhere in the hex, and cost about 100 ns.
- `PlayerController` follows the ground with a contact resolver that snaps to the surface while the step stays within the walkable slope, and lets go of it over a real drop, so ramps are walked and cliffs are fallen off.
- The relief is slope-limited at bake time (24.8° steepest face), the rim is perfectly flat for the full width of every portal, and `geometry.userData` carries the resulting `heightRange` and `maxSlopeDegrees`.

The pause menu offers resume, a view toggle and the map overview. **Esc** also returns from the overview to the menu; **F3** toggles the overview.

Run the topology, terrain, sky, undergrowth, map, character and controller checks (40 tests) with:

```bash
npm test
```
