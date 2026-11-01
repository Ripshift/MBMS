// Quest pools and reward tables. Pure data - no Minecraft imports (unit-testable).
// minTier: lowest Hunter Rank index (0 Novice .. 4 Legend) that is offered this quest.
// head: item id given as the trophy (raw VMH head block, or a vanilla head). null = none.

export const CULL_POOL = [
    { mob: "minecraft:zombie", name: "Zombie", head: "minecraft:zombie_head", min: 10, max: 16, minTier: 0 },
    { mob: "minecraft:skeleton", name: "Skeleton", head: "minecraft:skeleton_skull", min: 8, max: 14, minTier: 0 },
    { mob: "minecraft:spider", name: "Spider", head: "mh:spider_head_block", min: 8, max: 14, minTier: 0 },
    { mob: "minecraft:creeper", name: "Creeper", head: "minecraft:creeper_head", min: 5, max: 9, minTier: 0 },
    { mob: "minecraft:slime", name: "Slime", head: "mh:slime_head_block", min: 6, max: 10, minTier: 0 },
    { mob: "minecraft:silverfish", name: "Silverfish", head: "mh:silverfish_head_block", min: 6, max: 10, minTier: 0 },
    { mob: "minecraft:husk", name: "Husk", head: "mh:husk_head_block", min: 8, max: 12, minTier: 1 },
    { mob: "minecraft:stray", name: "Stray", head: "mh:stray_head_block", min: 6, max: 10, minTier: 1 },
    { mob: "minecraft:drowned", name: "Drowned", head: "mh:drowned_head_block", min: 6, max: 10, minTier: 1 },
    { mob: "minecraft:witch", name: "Witch", head: "mh:witch_head_block", min: 3, max: 6, minTier: 1 },
    { mob: "minecraft:cave_spider", name: "Cave Spider", head: "mh:cave_spider_head_block", min: 8, max: 12, minTier: 1 },
    { mob: "minecraft:bogged", name: "Bogged", head: "mh:bogged_head_block", min: 5, max: 9, minTier: 1 },
    { mob: "minecraft:pillager", name: "Pillager", head: "mh:pillager_head_block", min: 6, max: 10, minTier: 2 },
    { mob: "minecraft:vindicator", name: "Vindicator", head: "mh:vindicator_head_block", min: 4, max: 8, minTier: 2 },
    { mob: "minecraft:enderman", name: "Enderman", head: "mh:enderman_head_block", min: 4, max: 8, minTier: 2 },
    { mob: "minecraft:phantom", name: "Phantom", head: "mh:phantom_head_block", min: 4, max: 8, minTier: 2 },
    { mob: "minecraft:blaze", name: "Blaze", head: "mh:blaze_head_block", min: 6, max: 10, minTier: 2 },
    { mob: "minecraft:magma_cube", name: "Magma Cube", head: "mh:magma_cube_head_block", min: 6, max: 10, minTier: 2 },
    { mob: "minecraft:hoglin", name: "Hoglin", head: "mh:hoglin_head_block", min: 3, max: 6, minTier: 2 },
    { mob: "minecraft:guardian", name: "Guardian", head: "mh:guardian_head_block", min: 4, max: 8, minTier: 2 },
    { mob: "minecraft:ghast", name: "Ghast", head: "mh:ghast_head_block", min: 2, max: 4, minTier: 3 },
    { mob: "minecraft:piglin_brute", name: "Piglin Brute", head: "mh:piglin_brute_head_block", min: 2, max: 4, minTier: 3 },
    { mob: "minecraft:ravager", name: "Ravager", head: "mh:ravager_head_block", min: 1, max: 3, minTier: 3 },
    { mob: "minecraft:evocation_illager", name: "Evoker", head: "mh:evoker_head_block", min: 2, max: 4, minTier: 3 },
    { mob: "minecraft:breeze", name: "Breeze", head: "mh:breeze_head_block", min: 3, max: 6, minTier: 3 },
    { mob: "minecraft:zoglin", name: "Zoglin", head: "mh:zoglin_head_block", min: 3, max: 6, minTier: 3 },
    { mob: "minecraft:wither_skeleton", name: "Wither Skeleton", head: "minecraft:wither_skeleton_skull", min: 6, max: 10, minTier: 4 },
];

// Marked-mob hunts. dim: dimension the mob must be hunted in.
export const TARGET_POOL = [
    { mob: "minecraft:creeper", name: "Creeper", head: "minecraft:creeper_head", dim: "minecraft:overworld", minTier: 0 },
    { mob: "minecraft:skeleton", name: "Skeleton", head: "minecraft:skeleton_skull", dim: "minecraft:overworld", minTier: 0 },
    { mob: "minecraft:spider", name: "Spider", head: "mh:spider_head_block", dim: "minecraft:overworld", minTier: 0 },
    { mob: "minecraft:zombie", name: "Zombie", head: "minecraft:zombie_head", dim: "minecraft:overworld", minTier: 0 },
    { mob: "minecraft:witch", name: "Witch", head: "mh:witch_head_block", dim: "minecraft:overworld", minTier: 1 },
    { mob: "minecraft:enderman", name: "Enderman", head: "mh:enderman_head_block", dim: "minecraft:overworld", minTier: 1 },
    { mob: "minecraft:husk", name: "Husk", head: "mh:husk_head_block", dim: "minecraft:overworld", minTier: 1 },
    { mob: "minecraft:slime", name: "Slime", head: "mh:slime_head_block", dim: "minecraft:overworld", minTier: 1 },
    { mob: "minecraft:pillager", name: "Pillager", head: "mh:pillager_head_block", dim: "minecraft:overworld", minTier: 2 },
    { mob: "minecraft:vindicator", name: "Vindicator", head: "mh:vindicator_head_block", dim: "minecraft:overworld", minTier: 2 },
    { mob: "minecraft:blaze", name: "Blaze", head: "mh:blaze_head_block", dim: "minecraft:nether", minTier: 2 },
    { mob: "minecraft:magma_cube", name: "Magma Cube", head: "mh:magma_cube_head_block", dim: "minecraft:nether", minTier: 2 },
    { mob: "minecraft:hoglin", name: "Hoglin", head: "mh:hoglin_head_block", dim: "minecraft:nether", minTier: 2 },
    { mob: "minecraft:evocation_illager", name: "Evoker", head: "mh:evoker_head_block", dim: "minecraft:overworld", minTier: 3 },
    { mob: "minecraft:ravager", name: "Ravager", head: "mh:ravager_head_block", dim: "minecraft:overworld", minTier: 3 },
    { mob: "minecraft:breeze", name: "Breeze", head: "mh:breeze_head_block", dim: "minecraft:overworld", minTier: 3 },
    { mob: "minecraft:piglin_brute", name: "Piglin Brute", head: "mh:piglin_brute_head_block", dim: "minecraft:nether", minTier: 3 },
    { mob: "minecraft:ghast", name: "Ghast", head: "mh:ghast_head_block", dim: "minecraft:nether", minTier: 3 },
    { mob: "minecraft:wither_skeleton", name: "Wither Skeleton", head: "minecraft:wither_skeleton_skull", dim: "minecraft:nether", minTier: 4 },
    { mob: "minecraft:warden", name: "Warden", head: "mh:warden_head_block", dim: "minecraft:overworld", minTier: 4 },
];

export const DIM_NAMES = {
    "minecraft:overworld": "the Overworld",
    "minecraft:nether": "the Nether",
    "minecraft:the_end": "the End",
};

// Extra item rewards by tier: { id, min, max, chance }
export const REWARD_ITEMS = [
    [{ id: "minecraft:bread", min: 4, max: 8, chance: 0.6 }, { id: "minecraft:iron_ingot", min: 2, max: 5, chance: 0.4 }],
    [{ id: "minecraft:iron_ingot", min: 4, max: 8, chance: 0.6 }, { id: "minecraft:golden_carrot", min: 4, max: 8, chance: 0.4 }, { id: "minecraft:arrow", min: 16, max: 32, chance: 0.4 }],
    [{ id: "minecraft:gold_ingot", min: 4, max: 8, chance: 0.5 }, { id: "minecraft:diamond", min: 1, max: 2, chance: 0.35 }, { id: "minecraft:experience_bottle", min: 4, max: 8, chance: 0.4 }],
    [{ id: "minecraft:diamond", min: 2, max: 4, chance: 0.6 }, { id: "minecraft:golden_apple", min: 1, max: 2, chance: 0.4 }, { id: "minecraft:ender_pearl", min: 2, max: 4, chance: 0.3 }],
    [{ id: "minecraft:diamond", min: 4, max: 8, chance: 0.7 }, { id: "minecraft:netherite_scrap", min: 1, max: 2, chance: 0.35 }, { id: "minecraft:golden_apple", min: 2, max: 4, chance: 0.5 }],
];
