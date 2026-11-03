import { world, system, GameMode } from "@minecraft/server";

const ITEM_ID = "ioa:iron_oxeye_daisy";
const GROW_EVENT = "minecraft:ageable_grow_up";

// Right-click a baby mob with the Iron Oxeye Daisy to age it up instantly.
world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
  const { player, target, itemStack } = ev;
  if (!itemStack || itemStack.typeId !== ITEM_ID) return;
  if (!target.hasComponent("minecraft:is_baby")) return;

  // Stop the vanilla interaction (e.g. a baby villager opening trade, a lead, etc.)
  ev.cancel = true;
  const slot = player.selectedSlotIndex;

  system.run(() => {
    try {
      if (!target.isValid || !player.isValid) return;
      target.triggerEvent(GROW_EVENT);
    } catch (e) {
      // Mob has no grow up event: leave the item alone.
      return;
    }

    if (player.getGameMode() !== GameMode.Creative) {
      const container = player.getComponent("inventory").container;
      const held = container.getItem(slot);
      if (held && held.typeId === ITEM_ID) {
        if (held.amount > 1) {
          held.amount -= 1;
          container.setItem(slot, held);
        } else {
          container.setItem(slot, undefined);
        }
      }
    }

    const loc = target.location;
    const top = loc.y + 0.5;
    for (let i = 0; i < 7; i++) {
      target.dimension.spawnParticle("minecraft:villager_happy", {
        x: loc.x + (Math.random() - 0.5) * 0.8,
        y: top + Math.random() * 0.8,
        z: loc.z + (Math.random() - 0.5) * 0.8,
      });
    }
    player.playSound("random.eat");
    player.playSound("random.levelup", { volume: 0.4 });
  });
});
