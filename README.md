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

Run the topology, sky, undergrowth and controller checks with:

```bash
npm test
```
