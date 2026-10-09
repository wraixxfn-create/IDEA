import { planLavaPool, measureLavaPoolShoreline, buildLavaPool } from './LavaPool.js';
import { distanceToHexEdge } from './ForestTerrain.js';
import { DEFAULT_VOLCANIC_FORMATIONS } from './VolcanicFormations.js';

/** Additional lava fills existing hollows; no carve or collision edit. */
export function planLavaBasins(terrain, config = {}) {
  if (!terrain?.lavaPool || terrain.sectorId !== 'HEX_SE'
    || config.lavaBasinsEnabled === false || config.lavaBasins === false
    || config.lavaBasins === null) return [];
  const settings = config.lavaBasins ?? {};
  const hollows = [terrain.layout.basin, ...(terrain.layout.pits ?? [])];
  const formations = config.volcanicFormationsEnabled === false ? []
    : (Array.isArray(config.volcanicFormations) ? config.volcanicFormations : DEFAULT_VOLCANIC_FORMATIONS);
  const fills = [];
  for (const [index, hollow] of hollows.entries()) {
    if (!hollow) continue;
    const centre = {
      x: hollow.x,
      z: hollow.z - (index === 0 ? hollow.radius * 0.22 : 0),
    };
    const floor = terrain.heightAt(centre.x, centre.z);
    // Back off the fill until every bearing closes inside the hollow and
    // clears the portals and landmarks. Never manufacture a bank or spillway.
    for (let fraction = Math.min(1, Math.max(0.025, settings.fillFraction ?? 0.72)); fraction >= 0.025; fraction *= 0.78) {
      const depth = terrain.amplitude * hollow.depth * fraction;
      const pool = planLavaPool({ lavaPool: {
        id: `lava-basin-hex-se-${index}`, ...centre,
        radius: hollow.radius * 1.6, basin: depth / terrain.amplitude,
        minShoreRadius: 0, lift: 0.025, segments: 160, rings: 28,
        seedOffset: 71 + index,
      } }, { amplitude: terrain.amplitude, floorLevel: floor });
      const shoreline = measureLavaPoolShoreline(terrain, pool);
      // Reject unsafe hollows rather than cutting holes in the existing world.
      if (shoreline.min < 4 || shoreline.max > hollow.radius * (index === 0 ? 1.15 : 1.5)) continue;
      let safe = true;
      for (let i = 0; i < shoreline.radii.length; i += 1) {
        for (let ring = 0; ring <= 12; ring += 1) {
          const angle = i * Math.PI * 2 / shoreline.radii.length;
          const radius = shoreline.radii[i] * ring / 12;
          const x = pool.x + Math.cos(angle) * radius;
          const z = pool.z + Math.sin(angle) * radius;
          if (distanceToHexEdge(x, z, terrain.radius) < 14
            || terrain.gateAprons.some((gate) => Math.hypot(x - gate.x, z - gate.z) < gate.outer + 4)
            || formations.some((formation) => Math.hypot(x - formation.x, z - formation.z) < formation.footprintRadius + 4)) safe = false;
        }
      }
      if (safe) {
        fills.push({ pool, shoreline });
        break;
      }
    }
  }
  return fills;
}

export function buildLavaBasins(terrain, config = {}) {
  return (terrain?.lavaBasins ?? []).map(({ pool, shoreline }) => {
    const basin = buildLavaPool(terrain, pool, config, { shoreline });
    basin.group.name = `LavaBasin_${pool.id}`;
    basin.mesh.name = `LavaBasinMesh_${pool.id}`;
    basin.geometry.name = `LavaBasinGeometry_${pool.id}`;
    return basin;
  });
}
