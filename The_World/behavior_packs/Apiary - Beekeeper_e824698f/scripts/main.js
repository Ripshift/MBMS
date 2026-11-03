import { world, system, EquipmentSlot } from "@minecraft/server";

// ---------------------------------------------------------------------------
// Apiary: honeycomb promotion only. There is no scanning or auto-conversion.
// Crouch + right-click a jobless villager (unskilled or nitwit) holding honeycomb.
// ---------------------------------------------------------------------------
const CONFIG = {
    // Chat messages that explain why a promotion did or did not happen. Set false when done testing.
    debug: true,
    // Nitwits can never take a job, so they count as jobless.
    includeNitwits: true,
    // true = honeycomb also replaces villagers that already have a profession (they lose their trades).
    anyVillager: false,
};

const KEEPER = "apiary:beekeeper";
const VILLAGER = "minecraft:villager_v2";
// Vanilla villager_v2: minecraft:variant is 0 while unskilled and 14 for nitwits; professions remove it.
const VARIANT_UNSKILLED = 0;
const VARIANT_NITWIT = 14;

function tell(player, text) {
    if (!CONFIG.debug) return;
    try {
        player.sendMessage("§e[Apiary]§r " + text);
    } catch {
        // ignore
    }
}

function isBaby(villager) {
    return !!villager.getComponent("minecraft:is_baby");
}

function isJobless(villager) {
    const variant = villager.getComponent("minecraft:variant");
    if (variant) {
        if (variant.value === VARIANT_UNSKILLED) return true;
        if (CONFIG.includeNitwits && variant.value === VARIANT_NITWIT) return true;
    }
    if (CONFIG.includeNitwits) {
        try {
            if (villager.matches({ families: ["nitwit"] })) return true;
        } catch {
            // ignore
        }
    }
    return false;
}

function isCreative(player) {
    try {
        return String(player.getGameMode()).toLowerCase() === "creative";
    } catch {
        return false;
    }
}

world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    const { player, target, itemStack } = event;

    if (!itemStack || itemStack.typeId !== "minecraft:honeycomb") return;
    if (!player.isSneaking) return;
    if (target.typeId !== VILLAGER) return;

    let blocked = null;
    if (isBaby(target)) {
        blocked = "Baby villagers cannot be promoted.";
    } else if (!CONFIG.anyVillager && !isJobless(target)) {
        const variant = target.getComponent("minecraft:variant");
        blocked = "This villager already has a job (variant " + (variant ? variant.value : "none") + ").";
    }

    event.cancel = true; // stop the villager reacting to the honeycomb itself

    system.run(() => {
        if (blocked) {
            tell(player, blocked);
            return;
        }
        if (!target.isValid || !player.isValid) return;

        if (!isCreative(player)) {
            const equipment = player.getComponent("minecraft:equippable");
            if (!equipment) return;
            const held = equipment.getEquipment(EquipmentSlot.Mainhand);
            if (!held || held.typeId !== "minecraft:honeycomb") return;
            if (held.amount > 1) {
                held.amount -= 1;
                equipment.setEquipment(EquipmentSlot.Mainhand, held);
            } else {
                equipment.setEquipment(EquipmentSlot.Mainhand, undefined);
            }
        }

        const { location, dimension } = target;
        const name = target.nameTag;
        const keeper = dimension.spawnEntity(KEEPER, location);
        if (name) keeper.nameTag = name;
        target.remove();

        tell(player, "Villager promoted to Beekeeper.");
        try {
            player.playSound("mob.villager.yes");
        } catch {
            // sound is optional
        }
    });
});
