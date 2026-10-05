# HEXFIELD — World Foundation

A browser-based Three.js exploration world made from seven reusable, flat-top hexagonal sectors. The initial scene contains sector floors, perimeter/partition walls, detailed portal-style gates, and a minimal third-person explorer represented by a simple oval.

## Run

```bash
npm install
npm run dev
```

For a production build, run `npm run build`. The generated site is static and does not require a backend.

## Controls

- **W / A / S / D** — move relative to the follow camera
- **Shift** — sprint
- **Mouse** — orbit the third-person camera (click the scene to capture the pointer; press **Esc** to release)
- **Mouse wheel** — zoom the follow camera
- **Double-tap Space** — toggle flight; the second press lifts off
- **Hold Space / Ctrl** — rise / descend while flying; double-tap Space again to land
- **F3** — toggle the top-down development overview and sector/gate annotations

## Map foundation

`src/config/mapConfig.js` contains the shared scale and material settings. `src/world/hexGrid.js` defines the axial hex grid, initial seven sector records, neighbors, shared edges, and outer boundary edges. `src/world/HexMap.js` generates the floors, wall instances, and open gate frames from that data. Sector IDs are kept in the data model and are only rendered while debug view is enabled.

The seven initial sectors form one radius-1 axial cluster. Each sector has radius **220 world units**, identical flat-top geometry, and the same elevation. Every shared full side becomes one open passage with a beveled surround, sector-colored light channel, hexagonal crest, and recessed transom; unshared sides receive perimeter walls.

Run the topology checks with:

```bash
npm test
```
