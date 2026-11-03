// Buying from the Monster Hunter. Builds the stack first, so nothing is charged if building fails.

import * as mc from "@minecraft/server";
import { SHOP, HEAD_POOLS, unlockedTier } from "./shop_data.js";
import { HEADS } from "./heads.js";
import { loadHunter } from "./hunter.js";
import { countItem, removeItem } from "./util.js";

const CURRENCY = "minecraft:emerald";

function enchantType(id) {
    return typeof mc.EnchantmentType === "function" ? new mc.EnchantmentType(id) : id;
}

/** Returns an ItemStack, or null when the item has to be given by command (see buy). */
function buildStack(g, choice) {
    const id = g.choose ? choice : g.randomHead ? HEADS[Math.floor(Math.random() * HEADS.length)][0] : g.id;
    if (g.potion) {
        if (typeof mc.ItemStack.createPotion !== "function") {
            if (g.potion === "Healing") return null; // handled by command in buy()
            throw new Error("ItemStack.createPotion is not available");
        }
        return mc.ItemStack.createPotion({ effect: g.potion, liquid: "Regular", modifier: "Normal" });
    }
    const stack = new mc.ItemStack(id, g.amount ?? 1);
    if (g.enchants) {
        const ench = stack.getComponent("minecraft:enchantable");
        if (!ench) throw new Error(`${id} cannot be enchanted`);
        for (const e of g.enchants) ench.addEnchantment({ type: enchantType(e.id), level: e.level });
    }
    return stack;
}

function handOver(player, stack) {
    const c = player.getComponent("minecraft:inventory")?.container;
    const overflow = c ? c.addItem(stack) : stack;
    if (overflow) player.dimension.spawnItem(overflow, player.location);
}

/** Try to buy offer #index. Returns { ok, msg }. */
export function buy(player, index, choice) {
    const offer = SHOP[index];
    if (!offer) return { ok: false, msg: "§cThat item is no longer sold." };
    const d = loadHunter(player);
    if (offer.tier > unlockedTier(d.points)) return { ok: false, msg: "§cYou haven't unlocked that yet." };
    if (countItem(player, CURRENCY) < offer.price) return { ok: false, msg: `§cYou need ${offer.price} Emeralds.` };

    if (offer.give.choose && !HEAD_POOLS[offer.give.choose]?.map((n) => `mh:${n}_head`).includes(choice)) {
        return { ok: false, msg: "§cPick a head first." };
    }
    let stack;
    try {
        stack = buildStack(offer.give, choice);
    } catch (e) {
        console.warn(`[MH] shop could not build "${offer.name}": ${e}`);
        return { ok: false, msg: "§cThe hunter can't make that right now. You weren't charged." };
    }
    if (removeItem(player, CURRENCY, offer.price) < offer.price) return { ok: false, msg: "§cYou need more Emeralds." };
    try {
        if (stack) handOver(player, stack);
        else player.runCommand("give @s potion 1 21"); // Potion of Healing, for engines without createPotion
    } catch (e) {
        console.warn(`[MH] shop hand-over failed: ${e}`);
        handOver(player, new mc.ItemStack(CURRENCY, offer.price)); // refund
        return { ok: false, msg: "§cSomething went wrong. Your Emeralds were returned." };
    }
    return { ok: true, msg: `§aBought ${offer.name} for ${offer.price} Emeralds.` };
}
