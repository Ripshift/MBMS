// Monster Hunter expansion - all tunables in one place.

export const CONFIG = {
    // ---- Head drops (replaces VMH's 349 loot-table files) ----
    // "rare": mobs killed BY A PLAYER can drop their raw head block at a reduced rate.
    // "off":  no wild drops at all; heads come only from Monster Hunter quests.
    wildDrops: "rare",
    // Multiplies every base chance in drop_table.js (VMH's original rates x this).
    wildDropMultiplier: 0.5,
    // Added per Looting level to the base chance (before the multiplier).
    lootingBonusPerLevel: 0.01,
    // These always drop on a player kill (bosses / one-of-a-kind), ignoring the multiplier.
    guaranteedDropKeys: [
        "ender_dragon", "wither", "wither_projectile", "blue_wither", "blue_wither_projectile",
        "warden", "elder_guardian",
    ],
    // Original VMH feature: a mob killed by a charged creeper always drops its head.
    // Not a direct player kill, so set false for strict player-kill-only.
    chargedCreeperDrops: true,

    // Logs every player-kill drop roll to the content log (set true to see why a head did or did not drop).
    debugDrops: false,

    // ---- Hide Tanning Rack ----
    tanningCost: { item: "minecraft:leather", amount: 2 },

    // ---- Monster Hunter NPC village spawning ----
    villageSpawnChance: 0.35,   // rolled once per newly-seen villager
    bellSearchRadius: 48,       // blocks (x/z) to look for a village bell
    bellSearchHeight: 16,
    hunterLeash: 14,            // blocks a hunter may stroll from where he spawned before being put back
    hunterSpacing: 80,          // no second hunter within this many blocks

    // ---- Quests ----
    maxActive: 2,               // contracts a hunter can carry at once (only one may be a marked-target hunt)
    boardSize: 5,               // quests offered per player per game day
    retriesPerDay: 1,           // failed or abandoned contracts that get re-posted per day (0 = none)
    targetSpawnMin: 24,         // marked mob spawns this far from the player
    targetSpawnMax: 44,
    // Marked-mob locator on the action bar (like a locator bar: a marker slides along the bar as you
    // turn toward the creature; the ONLY text is an up/down arrow when it is above/below you).
    locator: {
        barWidth: 21,           // cells in the bar (odd, so there is a centre)
        halfFov: 60,            // degrees from straight ahead that map onto the bar; beyond = pinned to an edge
        verticalThreshold: 4,   // blocks of height difference before the arrow shows
        refreshTicks: 4,        // how often the bar redraws
        marker: "O",            // the creature marker
        edgeLeft: "<",          // shown at the left edge when the creature is off to the left
        edgeRight: ">",
        upText: "↑",       // up arrow. Set to "UP" if arrows do not render for you
        downText: "↓",     // down arrow. Set to "DOWN" for text
    },
    ranks: [
        { name: "Novice", points: 0 },
        { name: "Apprentice", points: 150 },
        { name: "Veteran", points: 600 },
        { name: "Elite", points: 1800 },
        { name: "Legend", points: 4500 },
    ],
    // chance (per tier) that a quest also rewards a ready-made Taxidermy Head (Mask)
    maskChanceByTier: [0.0, 0.04, 0.1, 0.18, 0.3],

    // ---- Noteblocks (from VMH) ----
    noteblockVolume: 100.0,
};
