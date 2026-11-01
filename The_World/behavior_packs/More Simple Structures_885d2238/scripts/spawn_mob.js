import { world, system, ItemStack, BlockPermutation } from "@minecraft/server";

system.afterEvents.scriptEventReceive.subscribe(event => {
    if (event.id === "wypnt_mss:spawn_cemetery_2_grave") {

        const entity = event.sourceEntity;
        if (!entity) return;

        // Gets the block where the mob is looking / positioned
        const block = entity.dimension.getBlock(entity.location);

        // Generates the feature
        entity.dimension.placeFeature(
            "wypnt_mss:cemetery_2_with_graves_feature",
            block.center(),
            true
        );
    }
    if (event.id === "wypnt_mss:spawn_queen_spider_feature") {

        const entity = event.sourceEntity;
        if (!entity) return;

        // Gets the block where the mob is looking / positioned
        const block = entity.dimension.getBlock(entity.location);

        // Generates the feature
        entity.dimension.placeFeature(
            "wypnt_mss:spider_nest_with_webs_feature",
            block.center(),
            true
        );
    }
});

system.beforeEvents.startup.subscribe(startup => {
    startup.blockComponentRegistry.registerCustomComponent("wypnt_mss:spawn_mobs", {
        onTick: (eventData) => {
            const block = eventData.block;
            const dimension = block.dimension;

            // Reads the value of the state
            const structureType = block.permutation.getState("wypnt_mss:structure");
            if (!structureType) return;

            // Configuration by structure:
            let spawns = [];

            if (structureType === "piglin_boat") {
               // Boat → 4 piglins + 2 brutes
                spawns = [
                    { id: "minecraft:piglin", count: 4 },
                    { id: "minecraft:piglin_brute", count: 2 }
                ];
            }

            else if (structureType === "piglin_outpost") {
                // Outpost → 8 piglins + 2 brutes
                spawns = [
                    { id: "minecraft:piglin", count: 8 },
                    { id: "minecraft:piglin_brute", count: 2 }
                ];
            }

            else {
                return;
            }

            // Central position of the block 
            const pos = block.center();

           // Spawns the configured mobs.
            for (const entry of spawns) {
                for (let i = 0; i < entry.count; i++) {
                    dimension.spawnEntity(entry.id, pos);
                }
            }

            // After spawning everything → turn into air
            block.setType("minecraft:air");
        }
    });
});