// Head block behaviour carried over from VMH: placement rotation + noteblock sounds.

import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { HEAD_BY_BLOCK } from "./heads.js";

/* ---------------- placement rotation ---------------- */

function getPreciseRotation(playerYRotation) {
    if (playerYRotation < 0) playerYRotation += 360;
    const rotation = Math.round(playerYRotation / 22.5);
    return rotation !== 16 ? rotation : 0;
}

const RotationBlockComponent = {
    beforeOnPlayerPlace(event) {
        const { player } = event;
        if (!player) return;
        const blockFace = event.permutationToPlace.getState("minecraft:block_face");
        if (blockFace !== "up") return;
        event.permutationToPlace = event.permutationToPlace.withState(
            "mh:head_rotation",
            getPreciseRotation(player.getRotation().y)
        );
    },
};

/* ---------------- noteblocks ---------------- */

const noteblockState = new Map(); // "x*y*z" -> { previousPowered }

function playHeadSound(headBlockId, noteblock) {
    const head = HEAD_BY_BLOCK.get(headBlockId);
    if (head) noteblock.dimension.playSound(head[3], noteblock.location, { volume: CONFIG.noteblockVolume });
}

const NoteblockComponent = {
    onTick(event) {
        const block = event.block;
        const neighbors = [block.north(), block.south(), block.east(), block.west(), block.below()];
        for (const neighbor of neighbors) {
            if (!neighbor || neighbor.typeId !== "minecraft:noteblock") continue;

            const { x, y, z } = neighbor.location;
            const key = `${x}*${y}*${z}`;
            const state = noteblockState.get(key) ?? {};
            const powerNeighbors = [neighbor.north(), neighbor.south(), neighbor.east(), neighbor.west(), neighbor.below()];
            const powered = powerNeighbors.some((n) => (n?.getRedstonePower() ?? 0) > 0);

            if (powered && !state.previousPowered) playHeadSound(block.typeId, neighbor);
            state.previousPowered = powered;
            noteblockState.set(key, state);
        }
    },
};

system.beforeEvents.startup.subscribe((init) => {
    init.blockComponentRegistry.registerCustomComponent("mh:rotation_comp", RotationBlockComponent);
    init.blockComponentRegistry.registerCustomComponent("mh:check_noteblock", NoteblockComponent);
});

// Right-clicking a noteblock with a head on top plays the head's sound.
world.afterEvents.playerInteractWithBlock.subscribe(({ player, block }) => {
    if (!player || player.isSneaking) return;
    if (block.typeId !== "minecraft:noteblock") return;
    const above = block.above();
    if (above) playHeadSound(above.typeId, block);
});
