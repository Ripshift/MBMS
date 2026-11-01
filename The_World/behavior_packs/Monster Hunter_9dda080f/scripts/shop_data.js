// Monster Hunter shop: what the hunter sells, per tier. Pure data + helpers (no Minecraft imports).
// "icon" is the vanilla inventory texture shown beside the name in the shop menu.
// Tier 1 opens once the player has ANY Hunter points (i.e. after the first completed contract);
// tiers 2-5 open at Apprentice, Veteran, Elite and Legend. Prices are in emeralds - edit freely.

import { CONFIG } from "./config.js";
import { rankIndex } from "./hunter_logic.js";

export const SHOP_TIERS = 5;

const I = (n) => `textures/items/${n}`;
const potion = (name, icon, price, tier, effect) => ({ tier, name, icon: I(icon), price, give: { id: "minecraft:potion", potion: effect } });
const book = (name, price, tier, id, level) => ({ tier, name: `Book: ${name}`, icon: I("book_enchanted"), price, give: { id: "minecraft:enchanted_book", enchants: [{ id, level }] } });

// "Choose a Taxidermy Head" lists. Every id must be a real Taxidermy Head (checked by the tests).
export const HEAD_POOLS = {
    common: ["cow", "pig", "sheep", "chicken", "spider", "cave_spider", "enderman", "drowned", "husk", "fox", "ocelot", "squid"],
    uncommon: ["blaze", "witch", "slime", "magma_cube", "ghast", "phantom", "hoglin", "stray", "bogged", "vindicator", "pillager", "evoker", "zombified_piglin", "piglin_brute", "guardian", "vex"],
    rare: ["ravager", "shulker", "breeze", "creaking", "sniffer", "camel", "iron_golem", "wandering_trader", "silverfish", "strider"],
    boss: ["wither", "warden", "elder_guardian", "blue_wither", "happy_ghast"],
};

export const SHOP = [
    // ---- Tier 1: first completed contract ----
    { tier: 1, name: "Iron Sword",       icon: I("iron_sword"), price: 4,  give: { id: "minecraft:iron_sword" } },
    { tier: 1, name: "Iron Chestplate",  icon: I("iron_chestplate"), price: 6,  give: { id: "minecraft:iron_chestplate" } },
    { tier: 1, name: "Shield",           icon: I("mh_shield"), price: 4,  give: { id: "minecraft:shield" } },
    { tier: 1, name: "Pork Chops x6",    icon: I("porkchop_cooked"), price: 1,  give: { id: "minecraft:cooked_porkchop", amount: 6 } },
    { tier: 1, name: "Leather x4",       icon: I("leather"), price: 1,  give: { id: "minecraft:leather", amount: 4 } },
    { tier: 1, name: "Arrows x16",       icon: I("arrow"), price: 2,  give: { id: "minecraft:arrow", amount: 16 } },
    { tier: 1, name: "Lead",             icon: I("lead"), price: 2,  give: { id: "minecraft:lead" } },
    // ---- Tier 2: Apprentice ----
    { tier: 2, name: "Iron Sword (Knockback I)", icon: I("iron_sword"), price: 6, give: { id: "minecraft:iron_sword", enchants: [{ id: "knockback", level: 1 }] } },
    { tier: 2, name: "Iron Spear",       icon: I("iron_spear"), price: 6, give: { id: "minecraft:iron_spear" } },
    { tier: 2, name: "Crossbow",         icon: I("crossbow_standby"), price: 6, give: { id: "minecraft:crossbow" } },
    { tier: 2, name: "Spyglass",         icon: I("spyglass"), price: 5, give: { id: "minecraft:spyglass" } },
    book("Protection III", 8, 2, "protection", 3),
    book("Smite III", 7, 2, "smite", 3),
    book("Bane of Arthropods III", 7, 2, "bane_of_arthropods", 3),
    potion("Potion of Swiftness", "potion_bottle_moveSpeed", 3, 2, "Swiftness"),
    potion("Potion of Night Vision", "potion_bottle_nightVision", 3, 2, "NightVision"),
    { tier: 2, name: "Golden Carrots x4", icon: I("carrot_golden"), price: 2, give: { id: "minecraft:golden_carrot", amount: 4 } },
    { tier: 2, name: "Choose: Common Taxidermy Head", icon: I("leather_helmet"), price: 10, give: { choose: "common" } },
    // ---- Tier 3: Veteran ----
    potion("Potion of Healing", "potion_bottle_heal", 3, 3, "Healing"),
    potion("Potion of Fire Resistance", "potion_bottle_fireResistance", 4, 3, "FireResistance"),
    { tier: 3, name: "Golden Apple",     icon: I("apple_golden"), price: 8, give: { id: "minecraft:golden_apple" } },
    book("Power I", 6, 3, "power", 1),
    book("Fire Aspect I", 8, 3, "fire_aspect", 1),
    { tier: 3, name: "Random Taxidermy Head", icon: I("leather_helmet"), price: 12, give: { randomHead: true } },
    { tier: 3, name: "Choose: Uncommon Taxidermy Head", icon: I("leather_helmet"), price: 16, give: { choose: "uncommon" } },
    // ---- Tier 4: Elite ----
    { tier: 4, name: "Diamond Sword (Looting III)", icon: I("diamond_sword"), price: 14, give: { id: "minecraft:diamond_sword", enchants: [{ id: "looting", level: 3 }] } },
    book("Looting III", 12, 4, "looting", 3),
    { tier: 4, name: "Ender Dragon Head", icon: I("dragon_breath"), price: 40, give: { id: "minecraft:dragon_head" } },
    { tier: 4, name: "Choose: Rare Taxidermy Head", icon: I("leather_helmet"), price: 28, give: { choose: "rare" } },
    // ---- Tier 5: Legend ----
    { tier: 5, name: "Diamond Sword (Looting III, Fire Aspect II)", icon: I("diamond_sword"), price: 24, give: { id: "minecraft:diamond_sword", enchants: [{ id: "looting", level: 3 }, { id: "fire_aspect", level: 2 }] } },
    { tier: 5, name: "Crossbow (Quick Charge III, Piercing IV)", icon: I("crossbow_standby"), price: 20, give: { id: "minecraft:crossbow", enchants: [{ id: "quick_charge", level: 3 }, { id: "piercing", level: 4 }] } },
    { tier: 5, name: "Choose: Boss Taxidermy Head", icon: I("leather_helmet"), price: 60, give: { choose: "boss" } },
];

/** How many shop tiers a player has unlocked. 0 until they have any Hunter points. */
export function unlockedTier(points) {
    if (!(points > 0)) return 0;
    return Math.min(SHOP_TIERS, rankIndex(points) + 1);
}

/** The rank that unlocks a shop tier (tier 1 = first contract done). */
export function tierUnlockText(tier) {
    return tier <= 1 ? "your first completed contract" : `${CONFIG.ranks[tier - 1].name} rank`;
}

export const offersForTier = (tier) => SHOP.filter((o) => o.tier === tier);
