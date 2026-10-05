# HEXFIELD — World Foundation

A browser-based Three.js exploration world built from reusable flat-top hexagonal sectors, procedural architecture, and a third-person explorer.

## Run

```bash
npm install
npm run dev
```

For a production build, run `npm run build`. The generated site is static and does not require a backend.

## Controls

- **W / A / S / D** — move relative to the follow camera
- **Shift** — trigger a directional dash (short burst with a cooldown)
- **Mouse** — orbit the third-person camera; horizontal mouse-look is corrected and vertical orbit reaches almost straight up or down
- **Mouse wheel** — zoom the follow camera
- **Double-tap Space** — toggle flight; the second press lifts off
- **Hold Space / Ctrl** — rise / descend while flying; double-tap Space again to land
- **F3** — toggle the top-down development overview and sector/gate annotations
- **Esc** — open the pause menu and release the pointer

## Map foundation

`src/config/mapConfig.js` contains shared scale, movement, and material settings. `src/world/hexGrid.js` defines the axial grid, neighbors, shared edges, and outer boundary edges. `src/world/HexMap.js` generates the floors, walls, portal architecture, animated doors, and collision geometry from that data. Sector IDs appear only in the development overview.

The map contains **eight** radius-220 sectors. The original center-plus-six cluster has a new outer **HEX_E** sector at axial coordinate `(2, -1)`, bridging the outer edges of `HEX_NE` and `HEX_SE`. Its addition creates 14 shared portals and 20 perimeter walls. Walls are **45 world units** high.

Each portal is a detailed, sector-lit assembly with a reinforced metal exoskeleton, layered jamb armour, a hex crest, and twin sliding leaves. The leaves open smoothly as the explorer approaches and close after a short delay; their collision moves with the animation. The opening remains tall enough for walking and low flight, while the solid lintel still blocks higher flight.

The pause menu offers resume and map overview. **Esc** also returns from the overview to the menu; **F3** toggles the overview.

Run the topology and controller checks with:

```bash
npm test
```
