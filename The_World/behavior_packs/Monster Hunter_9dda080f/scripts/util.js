import { world, system, ItemStack } from "@minecraft/server";

export function currentDay() {
    return typeof world.getDay === "function" ? world.getDay() : Math.floor(world.getAbsoluteTime() / 24000);
}

export function isValid(entity) {
    if (!entity) return false;
    try {
        return typeof entity.isValid === "function" ? entity.isValid() : entity.isValid !== false;
    } catch {
        return false;
    }
}

export function sleepTicks(ticks) {
    return new Promise((resolve) => system.runTimeout(resolve, ticks));
}

/** Show a form, retrying while the player has another screen (chat, inventory) open. */
export async function showForm(form, player, tries = 12) {
    for (let i = 0; i < tries; i++) {
        let response;
        try {
            response = await form.show(player);
        } catch {
            return { canceled: true };
        }
        if (response.canceled && response.cancelationReason === "UserBusy") {
            await sleepTicks(10);
            continue;
        }
        return response;
    }
    return { canceled: true };
}

/* ---------------- inventory helpers ---------------- */

function container(player) {
    return player.getComponent("minecraft:inventory")?.container;
}

export function countItem(player, id) {
    const c = container(player);
    if (!c) return 0;
    let n = 0;
    for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (it && it.typeId === id) n += it.amount;
    }
    return n;
}

/** Map of typeId -> total count, for ids passing `filter`. */
export function countMatching(player, filter) {
    const out = new Map();
    const c = container(player);
    if (!c) return out;
    for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (it && filter(it.typeId)) out.set(it.typeId, (out.get(it.typeId) ?? 0) + it.amount);
    }
    return out;
}

/** Remove up to `amount` of an item. Returns how many were removed. */
export function removeItem(player, id, amount) {
    const c = container(player);
    if (!c) return 0;
    let left = amount;
    for (let i = 0; i < c.size && left > 0; i++) {
        const it = c.getItem(i);
        if (!it || it.typeId !== id) continue;
        const take = Math.min(it.amount, left);
        if (take === it.amount) c.setItem(i, undefined);
        else {
            it.amount -= take;
            c.setItem(i, it);
        }
        left -= take;
    }
    return amount - left;
}

/** Give items, dropping any overflow at the player's feet. */
export function giveItem(player, id, amount = 1) {
    const c = container(player);
    let remaining = amount;
    while (remaining > 0) {
        let stack;
        try {
            stack = new ItemStack(id, 1);
        } catch {
            return; // unknown item id - skip rather than crash the quest flow
        }
        const take = Math.min(remaining, stack.maxAmount);
        stack.amount = take;
        remaining -= take;
        const overflow = c ? c.addItem(stack) : stack;
        if (overflow) player.dimension.spawnItem(overflow, player.location);
    }
}
