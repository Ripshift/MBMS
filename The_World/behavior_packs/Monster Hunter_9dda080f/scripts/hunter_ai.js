// Monster Hunter behaviour that the entity file cannot do on its own:
//  - flee for a few seconds when a player hits him (he takes no damage, so vanilla "panic" never fires)
//  - stay near where he was first seen (a leash: if he wanders too far he is put back at his home spot)
// The idle strolling, looking around and avoiding zombies/illagers live in entities/monster_hunter.json
// (the same villager-style goals the Beekeeper uses).

import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { isValid } from "./util.js";

const TYPE = "mh:monster_hunter";
const HOME_KEY = "mh:home";
const DIMS = ["overworld", "nether", "the_end"];

function setHome(e) {
    try {
        const l = e.location;
        e.setDynamicProperty(HOME_KEY, JSON.stringify({ x: l.x, y: l.y, z: l.z }));
    } catch { /* entity gone */ }
}

function getHome(e) {
    try {
        const raw = e.getDynamicProperty(HOME_KEY);
        if (typeof raw === "string") return JSON.parse(raw);
    } catch { /* corrupt */ }
    return undefined;
}

// Remember the spawn spot (hunters spawned by village script, egg, or /summon all fire entitySpawn).
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    if (entity.typeId === TYPE) setHome(entity);
});

function scare(hunter) {
    try { hunter.triggerEvent("mh:flee"); } catch { /* entity gone */ }
}

world.afterEvents.entityHitEntity.subscribe(({ damagingEntity, hitEntity }) => {
    if (hitEntity?.typeId === TYPE && damagingEntity?.typeId === "minecraft:player") scare(hitEntity);
});

world.afterEvents.projectileHitEntity.subscribe((event) => {
    try {
        const hit = event.getEntityHit()?.entity;
        if (hit?.typeId === TYPE) scare(hit);
    } catch { /* ignore */ }
});

// Leash. Hunters that already existed before this feature simply adopt their current spot as home.
system.runInterval(() => {
    for (const id of DIMS) {
        let dim;
        try { dim = world.getDimension(id); } catch { continue; }
        let hunters = [];
        try { hunters = dim.getEntities({ type: TYPE }); } catch { continue; }
        for (const h of hunters) {
            if (!isValid(h)) continue;
            const home = getHome(h);
            if (!home) { setHome(h); continue; }
            const dx = h.location.x - home.x, dz = h.location.z - home.z;
            if (dx * dx + dz * dz > CONFIG.hunterLeash * CONFIG.hunterLeash) {
                try { h.teleport({ x: home.x, y: home.y, z: home.z }, { dimension: dim }); } catch { /* chunk unloaded */ }
            }
        }
    }
}, 60);
