// Hay slab merging: placing a hay slab onto a hay slab makes a full-block double slab.
// Mirrors vanilla: bottom slab merges from its top face (or the upper half of a side),
// top slab merges from its bottom face (or the lower half of a side).
import { world, system, GameMode, Direction, BlockPermutation } from "@minecraft/server";

const SLAB = "hay:hay_slab";
const DOUBLE = "hay:hay_double_slab";

world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
  if (!ev.isFirstEvent) return;
  const { block, player, itemStack, blockFace, faceLocation } = ev;
  if (!itemStack || itemStack.typeId !== SLAB || block.typeId !== SLAB) return;

  const half = block.permutation.getState("minecraft:vertical_half");
  const side = blockFace !== Direction.Up && blockFace !== Direction.Down;
  const merge =
    (half === "bottom" && (blockFace === Direction.Up || (side && faceLocation.y >= 0.5))) ||
    (half === "top" && (blockFace === Direction.Down || (side && faceLocation.y < 0.5)));
  if (!merge) return;

  ev.cancel = true; // stop the normal placement; the swap happens next tick
  system.run(() => {
    if (!block.isValid || block.typeId !== SLAB || !player.isValid) return;
    block.setPermutation(BlockPermutation.resolve(DOUBLE));
    player.dimension.playSound("dig.grass", block.center());
    if (player.getGameMode() !== GameMode.Creative) {
      const slot = player.getComponent("minecraft:inventory").container.getSlot(player.selectedSlotIndex);
      if (slot.hasItem()) {
        if (slot.amount > 1) slot.amount -= 1;
        else slot.setItem(undefined);
      }
    }
  });
});
