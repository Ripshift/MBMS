// Spawns a Monster Hunter next to villagers in bell-centred villages (once per village).
// Bedrock spawn rules cannot target village structures, so villagers are used as the anchor.

import { world, system, BlockVolume } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { isValid } from "./util.js";

const CHECKED_TAG = "mh_vchk";
const queue = [];

world.afterEvents.entitySpawn.subscribe(({ entity, cause }) => {
    if (entity.typeId !== "minecraft:villager_v2") return;
    if (cause === "Born") return; // only villagers that come with the world / structures
    queue.push(entity);
});

function hasBellNearby(dim, loc) {
    const r = CONFIG.bellSearchRadius;
    const h = CONFIG.bellSearchHeight;
    const volume = new BlockVolume(
        { x: Math.floor(loc.x) - r, y: Math.floor(loc.y) - h, z: Math.floor(loc.z) - r },
        { x: Math.floor(loc.x) + r, y: Math.floor(loc.y) + h, z: Math.floor(loc.z) + r }
    );
    const it = dim.getBlocks(volume, { includeTypes: ["minecraft:bell"] }, true);
    for (const _ of it) return true;
    return false;
}

export function spawnHunterNear(dim, loc) {
    return dim.spawnEntity("mh:monster_hunter", { x: loc.x + 1.5, y: loc.y, z: loc.z + 1.5 });
}

function process(villager) {
    if (!isValid(villager) || villager.hasTag(CHECKED_TAG)) return;
    villager.addTag(CHECKED_TAG);
    if (Math.random() >= CONFIG.villageSpawnChance) return;
    const dim = villager.dimension;
    const loc = villager.location;
    if (dim.getEntities({ type: "mh:monster_hunter", location: loc, maxDistance: CONFIG.hunterSpacing, limit: 1 }).length > 0) return;
    if (!hasBellNearby(dim, loc)) return;
    spawnHunterNear(dim, loc);
}

// Small batches keep chunk-load bursts from causing lag.
system.runInterval(() => {
    for (let i = 0; i < 2 && queue.length > 0; i++) {
        const v = queue.shift();
        try { process(v); } catch { /* chunk unloaded between queue and processing */ }
    }
}, 10);
