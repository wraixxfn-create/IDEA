# HEXFIELD — World Foundation

A browser-based Three.js exploration world built from reusable flat-top hexagonal sectors, procedural architecture, an explorer you can follow or look through, a painted sky — complete with sun and clouds — over every sector, and rain falling over the forest.

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
- **M** — open the world map, and press it again to close it (**Esc** and the ✕ button close it too). The map is an overlay, not a pause screen: the world keeps running underneath it, the keyboard keeps working, and closing it never needs a key to be pressed twice
- The follow-camera distance is fixed (scrolling does not zoom)
- **Space** — jump. One press is one jump: an upward impulse handed to the ordinary gravity and ground-contact solver, so the arc lands on the relief (in flight, Space rises instead)
- **Double-tap Space** — toggle flight; the first press of the pair is the jump, so the takeoff reads as a jump that keeps going rather than as a dead press
- **Hold Space / Ctrl** — rise / descend while flying; double-tap Space again to land
- **F3** — toggle the top-down development overview and sector/gate annotations
- **Esc** — open the pause menu and release the pointer

The HUD carries a **heading compass** in the top-left corner; it needs no key, and it works the same in both views.

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

## Heading compass

The top-left corner of the HUD carries a compass rose (`src/ui/Compass.js`). It reads the explorer's look direction — the same `player.yaw` the camera and the map needle use — and turns it into a bearing, a turning card and a three-digit readout with the cardinal it points at.

The world has no authored north/south axis, so the compass defines one and every other heading in the game follows it: **north is -Z** (the top of the minimap) and **east is +X** (its right). The view direction is `(-sin yaw, -cos yaw)`, which makes the bearing simply `-yaw`, normalised into `[0, 360)`.

- **The card turns, the letters do not.** The ring is rotated by a single CSS custom property (`--heading`) written once per frame; each letter counters that rotation so it stays upright, and the fixed index at the top marks the current bearing — the letter under the index is the one the explorer is looking at.
- **It is a readout, not an animation.** The card is only rewritten when the bearing moves by a tenth of a degree and the digits only when the rounded bearing changes, so standing still costs nothing.
- **It belongs to the biome.** The needle, the north wedge and the cardinal take the accent colour of the sector the explorer is standing in, alongside the sigils and the cloth trim.

## World map

**M** opens the overview in `src/ui/Minimap.js` and **M** closes it again (so do **Esc** and the ✕ in the panel's header). The overlay itself lives in `src/ui/MapOverlay.js`, which exists because of a bug the players kept hitting: opening the map used to *pause* the world. It released the pointer lock, and closing it asked for the lock back from the keypress that closed it — a lock the browser grants a frame or two later. Everything typed in that window was dropped, and the key the player was already holding (the **W** they were walking with) had been cleared when the lock was released, so the explorer stood still until the key was released and pressed again.

The map is now a true overlay:

- it **never touches the pointer lock** and **never clears the key state**, so the explorer keeps walking, dashing and flying while the panel is up, and closing it needs no re-arming at all;
- the world **keeps running** behind it — the wind, the mist, the portals and the explorer all advance — so closing the map drops the player exactly where they are;
- the only lock request left is a fallback for the case where the browser dropped the lock on its own (Esc, a tab switch, a fullscreen change) while the map was open, and it is skipped when the map was opened from the pause menu.

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
- **Undergrowth** — `src/world/ForestDetail.js` plants ~7,200 grass and fern tufts, ~570 shrubs, 150 mossy boulders, 56 fallen logs, **760 broken branches** and ~340 mushroom clusters. Everything follows a density field, so the floor grows in drifts and clearings instead of an even sprinkle, and every instance is planted on the terrain relief, tilted into the slope it stands on, and kept inside the hex. The scatter resolves its minimum spacing through a uniform grid, so tripling the instance count did not triple the build time.
- **Pines** — `src/world/PineGrove.js` grows a wood of **170 trunks** in three classes: the eighteen authored mature spruces, **54 young pines** that carry the density (the same boughs, forks and sprays in a shorter, cheaper tree), and ~100 saplings filling the last gaps. Every tree keeps its exposed roots, bark grain, hanging cones, per-tree height and needle-hue variation.
- **Leaves** — the floor itself is carpeted with **16,000** hand-sized fallen leaves, each lying on the slope it fell on (`HexMap.buildForestLeafLitter`).
- **Wind** — `src/world/wind.js` injects a shared sway into the standard vertex shader. One clock drives the crowns, the grass and the ferns, so the whole forest breathes on the same gust while trunks stay planted.
- **Mist** — **eight** stacked, drifting layers of ground fog with a soft radial falloff and no texture seam. Each layer samples the mist noise through its own phase offset and its own heading, so the stack reads as one deep volume of fog rather than eight sheets of glass; it starts just above the soil, pools in the hollows, climbs to about 16 units and fades out near the lens, so the ground underfoot stays crisp while the distance is swallowed.
- **Birds** — `src/world/ForestBirds.js` adds the only wildlife in the map, and only here: a lively mixed flock of **32** woodland birds (16 chaffinches, 11 great tits and 5 jays) that perch in the pines, drop to the floor to feed, hop, preen, sing, and put themselves up when the explorer walks into them. Every bird is procedural geometry on a 25-bone rig, and the flock shares the sector's wind clock, its baked terrain and its own tree placements, so a bird lands on a branch that is really there and stands on the ground the explorer is walking on.
- **Forest sound** — `src/world/ForestAudio.js` builds a soft, layered bed of canopy wind, leaf rustle and rain, then adds short bird calls when the visible birds enter their singing animation. Calls are panned from the camera and fade with distance; the rain layer follows the forest weather toggle. Audio starts on the first explore click (the browser's required gesture), and the HUD button or **B** key switches it on or off.
- **Light** — a dedicated green, amber and teal canopy-light rig plus a brighter canopy wash keeps the dense grove readable; the forest also receives the fullest cloud deck and the strongest sun halo.
- **Rain** — `HEX_S` is the only sector with weather. `src/world/Rain.js` plants a seeded field of **34,000** falling streaks and **5,200** impact ripples on the same baked lattice the explorer walks on: a drop's column carries the height it will land on (so it melts into the relief it is actually above, not into a global plane), and a ripple is tilted into the slope it hits. The fall, the recycle and the ripple growth all happen in the vertex shader from one shared clock, so a whole-sector downpour costs two draw calls and a single uniform update per frame; drops and splashes fade out with the distance to the camera, so the density near the lens is what the eye reads. The floor is wetted with it — the soil and the leaf litter darken and lose their matte finish while it rains — and the field steps aside with the mist in the F3 overview. `world.setRainEnabled(false)` (or `forestRainEnabled: false` in `mapConfig`) clears the sky over the wood.

### The birds of HEX_S

Three species, one rig each, no imported meshes and no sprite billboards anywhere:

- **The model** — body, neck, head, beak, eyes and legs are procedural, and each species has its own palette and proportions: the chaffinch's rufous breast and blue-grey crown, the great tit's black cap and white cheeks, the jay's pink-brown body, white rump and blue wing panel. The head is feathered with rows of overlapping covert scales, laid on the skull's own surface, and each eye carries its ring and a highlight.
- **The wing** — one continuous feathered surface per wing, built along the bones of the rig: a rounded leading edge, a swelling chord and a trailing edge that frays into the separated tips of the primaries. It is built **twice** with the same vertex count — held out for flight and folded back along the flank — and the difference between the two shapes is baked as a **morph target**, so folding a wing is a change of shape, exactly as it is on a real bird, while the bones carry the beat, the twist and the whip. Nothing about the wing is a flat plate: the cross-section is a wing's, and the primaries are separate surfaces.
- **The movement** — `applyPose` solves the wing as a chain of three aimed segments rather than stacked Euler angles, so the humerus leads the beat, the forearm follows and the hand whips last; the body counter-rotates, the tail fan springs and counterweights, the legs tuck in the air and grip on a perch, and the head snaps through saccades between long holds. Seeded wing stretches, tail flicks and quick head fidgets keep resting birds gently animated too.
- **The flock** — 32 independent birds on a seeded state machine (perch, take off, travel, chase, follow, wander, glide, descend, land, hop, forage, preen, sing, look, flush) that share the wood: a bird that goes up takes its neighbours with it, the alarm fades when the explorer leaves, and a flight mix of flaps and short glides is what makes the jay in the air read differently from the tits. Birds keep to the sector and stay under the canopy, so nothing ever flies through the dome into the next hexagon.
- **The tools** — `node tools/bird-preview.mjs chaffinch glide three-quarter` renders a species in a named pose from one of four review views, and `node tools/bird-flight.mjs chaffinch` runs the **real simulation** and photographs the flock the moment it reaches each state, so the sheets are the animation itself rather than a hand-posed approximation. Both write PNGs into `previews/` (gitignored) through the CPU rasteriser in `tools/preview.mjs`.

### One surface for the eye and the feet

The old forest floor was drawn from one formula and collided against another, so the explorer sank up to **3.8 u** into the middle of the sector and, in a quarter of its area, walked under a mesh that was drawn above it. `ForestTerrain` now owns both: the lattice is baked once, and `heightAt` / `normalAt` / `slopeAt` read the **same vertex buffer** the GPU draws, through the barycentric coordinates of the triangle the explorer is standing on.

- Height lookups agree with a raycast against the rendered mesh to under **0.001 u** anywhere in the hex, and cost about 100 ns.
- `PlayerController` follows the ground with a contact resolver that snaps to the surface while the step stays within the walkable slope, and lets go of it over a real drop, so ramps are walked and cliffs are fallen off.
- The relief is slope-limited at bake time (24.8° steepest face), the rim is perfectly flat for the full width of every portal, and `geometry.userData` carries the resulting `heightRange` and `maxSlopeDegrees`.

The pause menu offers resume, a view toggle and the map overview. **Esc** also returns from the overview to the menu; **F3** toggles the overview.

## HEX_SE — the volcanic ground

`HEX_SE` is the second sector whose flat plate is replaced by modelled ground. `src/world/VolcanicTerrain.js` bakes a large volcanic landscape on the same welded hexagonal lattice engine as the forest — it subclasses `ForestTerrain`, so the mesh the eye sees and the surface the feet stand on are again one baked model, its rim pinned to the shared floor height and its faces slope-limited at bake time.

- **Massif and its crater** — one major elevated volcanic region: a broad convex cone with an irregular skirt, crowned by the sector's **single main crater**. The crater is the landmark: a rim ring about a hundred units across, cut into the massif's summit and raised into a broad shoulder that stands about eleven units above the plains, so the ground of the whole sector is highest along that ring. Inside it, a deep floor — the vent sits roughly thirteen units below the crest that surrounds it — reached across a long, broken inner wall. Nothing about it is a circle: the rim radius is wobbled by a coarse and a fine noise (44–53 units per bearing), the crest height varies by more than seven units around the ring so the crown is a chain of shoulders and saddles, and one bearing carries a **breach** — a saddle low enough to read as the way the last eruption left. The wall is glazed with gullies and terraces sampled on the unit circle of the bearing, so the ridges wrap the crater seamlessly and no two sides climb alike; the cone's own top is levelled into the crater, which is what makes it a crater in the mountain rather than a bowl dropped on it.
- **Basin** — one lower basin-like region: a flat-floored bowl sitting about ten units below the plains that ring it.
- **Ridges** — elevated volcanic ridges as two fissure zones of ridged multifractal noise, so the crests wander like dyke swarms off the massif's flanks instead of lining up as hills.
- **Rock and depressions** — four irregular rocky patches of coarse, crested roughness and three shallow depressions on the open plains.
- **Plains** — broad domain-warped undulation between the features. Around seventy percent of the sector walks at under 12° and half of it stays within three units of plain level, so the landscape never turns uniformly mountainous and large areas stay comfortable to cross.
- **Boundary discipline** — the relief fades to exactly the shared floor height along all six sides, and a radial apron around each of the sector's four portals (fully flat inside 19 units, relief back by 58) keeps every entrance a level stroll. Walls, gates, neighbouring sectors and the global hexagonal structure are untouched by it.
- **Material** — a simple gray/dark basalt with a subtle per-vertex shading (pale ash on the high flats, darker rock pooling in the hollows). No lava, no textures, no particles, no atmosphere at this stage: this step establishes the terrain shape only, and the crater reuses exactly that rock — no new material, no new environmental system.
- **Budget** — 64 lattice divisions: 12,481 vertices and 24,576 triangles, under half the forest floor's density, baked in about a fifth of a second. The field is fully seeded, and the whole feature layout (cone, crater, basin, ridge zones, rock patches, pits) is plain data in `DEFAULT_VOLCANIC_LAYOUT`, overridable through `volcanicFeatures`, so the ground — the crater included — can be reshaped later without touching the engine.

Run the topology, terrain, sky, rain, undergrowth, birds, map overlay, map drawing, compass, character and controller checks (83 tests) with:

```bash
npm test
```
