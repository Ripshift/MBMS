// Vanilla End Expansion - Endermite Nests and Purpur Gel Block behaviour.
// Replaces the old tick functions (kept in _backup_original/functions_v1.0.0).
// Everything new that this script adds is named with the namespace  vaen:
//   /scriptevent vaen:status   -> shows how many nests / gel landings happened since load
import { world, system, GameMode, EntityDamageCause } from "@minecraft/server";

const CONFIG = {
  checkTicks: 1,            // how often players are checked (1 = every tick)
  // Endermite Nest
  soundVolume: 1,           // nest sound volume
  nestEndermites: 3,        // endermites per nest
  // Purpur Gel Block (honey block clone)
  gelSlowAmplifier: 1,      // slowness level while standing on it: 1 = Slowness II = -30% speed (3 = Slowness IV = -60%, honey's speed x0.4)
  gelSlowTicks: 8,          // players: slowness is refreshed every check, so this only has to outlast one check
  gelMobs: true,            // slow mobs standing on it too
  gelMobScanTicks: 5,       // how often mobs near players are checked
  gelMobRadius: 32,         // only mobs within this distance of a player are checked
  gelFallDamageFactor: 0.2, // share of fall damage that still hurts on the gel (honey: 20%)
  debug: false,
};

// Block / particle ids. If the content is ever renamed, change them here only.
const ID = {
  nest: "vaen:endermite_nest",
  sand: "vaen:end_sand",
  gel: "vaen:purpur_gel_block",
  nestParticle: "vaen:endermite_spawn",
};

const NEST_OFFSETS = [[0.2, 0.2], [-0.2, -0.2], [0, 0]];
const stats = { nests: 0, gelLandings: 0, errors: 0 };

function log(...a) { if (CONFIG.debug) console.warn("[vaen]", ...a); }

// Block directly under the entity's feet.
function blockBelow(entity) {
  const p = entity.location;
  const x = Math.floor(p.x), y = Math.floor(p.y - 0.001), z = Math.floor(p.z);
  const block = entity.dimension.getBlock({ x, y, z });
  return block ? { block, x, y, z } : undefined;
}

function activateNest(player, block, x, y, z) {
  const dim = player.dimension;
  const p = player.location;
  block.setType(ID.sand);
  for (let i = 0; i < CONFIG.nestEndermites; i++) {
    const [dx, dz] = NEST_OFFSETS[i % NEST_OFFSETS.length];
    try { dim.spawnEntity("minecraft:endermite", { x: p.x + dx, y: p.y, z: p.z + dz }); } catch (e) { log("spawn", e); }
  }
  try { dim.spawnParticle(ID.nestParticle, { x: x + 0.5, y: y + 1, z: z + 0.5 }); } catch (e) { log("particle", e); }
  try { dim.playSound("dig.sand", { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, { volume: CONFIG.soundVolume }); } catch (e) { log("sound", e); }
  stats.nests++;
}

function slowOnGel(entity, ticks) {
  const cur = entity.getEffect("slowness");
  if (cur && cur.amplifier > CONFIG.gelSlowAmplifier) return; // a stronger slowness from elsewhere wins
  entity.addEffect("slowness", ticks, { amplifier: CONFIG.gelSlowAmplifier, showParticles: false });
}

system.runInterval(() => {
  for (const player of world.getPlayers({ excludeGameModes: [GameMode.Spectator] })) {
    try {
      if (player.isOnGround === false) continue; // only when standing on the block
      const below = blockBelow(player);
      if (!below) continue;
      const id = below.block.typeId;
      if (id === ID.nest) activateNest(player, below.block, below.x, below.y, below.z);
      else if (id === ID.gel) slowOnGel(player, CONFIG.gelSlowTicks);
    } catch (e) {
      stats.errors++;
      if (stats.errors <= 3) console.warn("[vaen] error:", e);
    }
  }
}, CONFIG.checkTicks);

// Mobs (and other living entities) standing on a Purpur Gel Block are slowed too.
// Only entities near a player are looked at, every gelMobScanTicks.
if (CONFIG.gelMobs) {
  system.runInterval(() => {
    const seen = new Set();
    for (const player of world.getPlayers()) {
      try {
        const near = player.dimension.getEntities({ location: player.location, maxDistance: CONFIG.gelMobRadius });
        for (const e of near) {
          if (e.typeId === "minecraft:player" || seen.has(e.id)) continue;
          seen.add(e.id);
          try {
            if (e.isOnGround === false || !e.getComponent("minecraft:health")) continue;
            const below = blockBelow(e);
            if (below && below.block.typeId === ID.gel) slowOnGel(e, CONFIG.gelMobScanTicks * 2 + 2);
          } catch (err) { /* entity unloaded or cannot take effects */ }
        }
      } catch (e) {
        stats.errors++;
        if (stats.errors <= 3) console.warn("[vaen] mob scan error:", e);
      }
    }
  }, CONFIG.gelMobScanTicks);
}

// Honey-like landing: give back most of the fall damage when the entity lands on a Purpur Gel Block.
// (A block cannot change fall damage by itself, so the damage is dealt and then partly healed.
//  A fall that would kill outright still kills.)
world.afterEvents.entityHurt.subscribe((ev) => {
  try {
    if (ev.damageSource.cause !== EntityDamageCause.fall) return;
    const entity = ev.hurtEntity;
    const below = blockBelow(entity);
    if (!below || below.block.typeId !== ID.gel) return;
    const hp = entity.getComponent("minecraft:health");
    if (!hp || hp.currentValue <= 0) return;
    const give = ev.damage * (1 - CONFIG.gelFallDamageFactor);
    hp.setCurrentValue(Math.min(hp.effectiveMax, hp.currentValue + give));
    stats.gelLandings++;
  } catch (e) {
    stats.errors++;
    if (stats.errors <= 3) console.warn("[vaen] hurt error:", e);
  }
});

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "vaen:status") return;
  const msg = `Vanilla End Expansion: ${stats.nests} nests triggered, ${stats.gelLandings} gel landings, ${stats.errors} errors since load.`;
  if (ev.sourceEntity && typeof ev.sourceEntity.sendMessage === "function") ev.sourceEntity.sendMessage(msg);
  else world.sendMessage(msg);
});
