// Head drops (player kills only), charged-creeper drops, and quest-progress hooks on death.
// Replaces VMH's per-mob loot tables. Rates live in drop_table.js + config.js.

import { world, system, ItemStack } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { DROP_TABLE } from "./drop_table.js";
import { onMobKilled } from "./hunter.js";

const chargedCreepers = new Map(); // creeper id -> tick it was removed
const angryMobs = new Set();       // wolf/bee ids a player has hit

const blacklistMobs = new Set([
    "minecraft:player",
    "minecraft:wither_skeleton", // vanilla skull
    "minecraft:snowball", "minecraft:ender_eye", "minecraft:ender_pearl", "minecraft:splash_potion",
    "minecraft:xp_bottle", "minecraft:fireball", "minecraft:dragon_fireball", "minecraft:egg",
]);
const variantMobs = new Set([
    "minecraft:wolf", "minecraft:cat", "minecraft:fox", "minecraft:horse", "minecraft:llama",
    "minecraft:trader_llama", "minecraft:mooshroom", "minecraft:panda", "minecraft:parrot",
    "minecraft:rabbit", "minecraft:frog", "minecraft:axolotl",
]);
const vanillaHeads = new Set([
    "minecraft:creeper", "minecraft:skeleton", "minecraft:zombie", "minecraft:wither_skeleton",
    "minecraft:piglin", "minecraft:ender_dragon",
]);
const WITHER_KEYS = ["wither", "wither_projectile", "blue_wither", "blue_wither_projectile"];

/* ---------------- tracking ---------------- */

world.beforeEvents.entityRemove.subscribe(({ removedEntity }) => {
    try {
        if (removedEntity.typeId === "minecraft:creeper" && removedEntity.getComponent("minecraft:is_charged")) {
            chargedCreepers.set(removedEntity.id, system.currentTick);
        }
    } catch { /* entity already gone */ }
});

// Forget creepers that never killed anything (the explosion kills happen the same tick).
system.runInterval(() => {
    const now = system.currentTick;
    for (const [id, tick] of chargedCreepers) if (now - tick > 100) chargedCreepers.delete(id);
}, 200);

world.afterEvents.entityHurt.subscribe(({ hurtEntity, damageSource, damage }) => {
    if (hurtEntity.typeId !== "minecraft:wolf" && hurtEntity.typeId !== "minecraft:bee") return;
    if (damageSource.damagingEntity?.typeId !== "minecraft:player") return;
    const health = hurtEntity.getComponent("minecraft:health");
    if (health && health.currentValue >= damage) angryMobs.add(hurtEntity.id);
});

/* ---------------- drop key (ported from VMH) ---------------- */

function dropKey(deadEntity) {
    let entity = deadEntity.typeId.split(":")[1];
    const id = deadEntity.typeId;

    if (id === "minecraft:creeper" && deadEntity.getComponent("minecraft:is_charged")) entity = "charged_creeper";
    else if (id === "minecraft:trader_llama") entity = "llama";
    else if (id === "minecraft:strider" && deadEntity.getComponent("minecraft:is_shaking")) entity = "suffocated_strider";
    else if (id === "minecraft:happy_ghast" && deadEntity.getComponent("minecraft:is_baby")) entity = "ghastling";
    else if (id === "minecraft:sheep") {
        const color = deadEntity.getComponent("minecraft:color");
        if (color) entity += `_${color.value}`;
    }

    if (angryMobs.has(deadEntity.id)) {
        angryMobs.delete(deadEntity.id);
        entity = "angry_" + entity;
    }

    if (variantMobs.has(id)) {
        const variant = deadEntity.getComponent("variant");
        entity += `_${variant ? variant.value : 0}`;
    } else if (id === "minecraft:cow" || id === "minecraft:chicken" || id === "minecraft:pig") {
        entity += `_${deadEntity.getProperty("minecraft:climate_variant")}`;
    } else if (id === "minecraft:copper_golem") {
        entity += `_${deadEntity.getProperty("minecraft:oxidation_level")}`;
    } else if (id === "minecraft:zombie_nautilus") {
        entity += `_${deadEntity.getProperty("minecraft:variant")}`;
    }
    return entity;
}

function lootingLevel(player) {
    try {
        const held = player.getComponent("minecraft:equippable")?.getEquipment("Mainhand");
        return held?.getComponent("minecraft:enchantable")?.getEnchantment("looting")?.level ?? 0;
    } catch {
        return 0;
    }
}

/* ---------------- death handler ---------------- */

world.afterEvents.entityDie.subscribe((event) => {
    try {
        handleDeath(event);
    } catch (e) {
        console.warn(`[MH] death handler error: ${e}`);
    }
});

function handleDeath({ damageSource, deadEntity }) {
    const killer = damageSource.damagingEntity; // can be undefined (fall, lava, ...) - never assume it exists
    const playerKiller = killer?.typeId === "minecraft:player" ? killer : undefined;

    // 1) quest hooks (cull progress / marked-mob kill)
    const marked = onMobKilled(deadEntity, playerKiller);

    if (blacklistMobs.has(deadEntity.typeId)) return;
    if (marked) return; // quest already handed out the trophy

    // 2) charged-creeper mechanic from VMH: 100% drop, not for vanilla-head mobs
    const chargedKill = !!killer && chargedCreepers.has(killer.id);
    if (chargedKill) chargedCreepers.delete(killer.id);
    const viaCharged = chargedKill && CONFIG.chargedCreeperDrops && !vanillaHeads.has(deadEntity.typeId);

    // 3) wild drop: player kills only
    const wild = !!playerKiller && CONFIG.wildDrops === "rare";
    if (!wild && !viaCharged) return;

    let key;
    if (deadEntity.typeId === "minecraft:wither") key = WITHER_KEYS[Math.floor(Math.random() * WITHER_KEYS.length)];
    else key = dropKey(deadEntity);

    const entry = DROP_TABLE[key];
    if (CONFIG.debugDrops) console.warn(`[MH] ${deadEntity.typeId} -> key "${key}" ${entry ? "(" + entry[0] + ")" : "has no head"}`);
    if (!entry) return; // no head defined for this mob / variant

    let chance;
    if (viaCharged) chance = 1;
    else if (CONFIG.guaranteedDropKeys.includes(key)) chance = 1;
    else {
        const looting = playerKiller ? lootingLevel(playerKiller) : 0;
        chance = Math.min(1, (entry[1] + looting * CONFIG.lootingBonusPerLevel) * CONFIG.wildDropMultiplier);
    }
    const roll = Math.random();
    if (CONFIG.debugDrops) console.warn(`[MH] chance ${chance.toFixed(3)} roll ${roll.toFixed(3)}`);
    if (roll >= chance) return;

    const { x, y, z } = deadEntity.location;
    deadEntity.dimension.spawnItem(new ItemStack(entry[0], 1), { x, y: y + 0.5, z });
}
