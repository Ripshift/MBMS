import { world, system } from "@minecraft/server";

// Small Cactus
//  1) Stacking: a small cactus on top of another makes the lower one a full block (16 px)
//     and the upper one 2 px (18 px total). Heights come from two block states, kept in sync here.
//  2) A third small cactus on top of a stack of two merges all three into a normal
//     two-block-tall cactus (the third item is used up).
//  3) Drinking Cactus Juice gives nausea for 12 seconds.
//  4) Contact damage, like the vanilla cactus.
const BLOCK_ID = "smallcactus:small_cactus";
const ABOVE = "smallcactus:above";
const BELOW = "smallcactus:below";

// ---------- stacking ----------
function sync(block) {
  try {
    if (!block || block.typeId !== BLOCK_ID) return;
    const above = block.above()?.typeId === BLOCK_ID;
    const below = block.below()?.typeId === BLOCK_ID;
    const perm = block.permutation;
    if (perm.getState(ABOVE) === above && perm.getState(BELOW) === below) return;
    block.setPermutation(perm.withState(ABOVE, above).withState(BELOW, below));
  } catch { /* chunk unloaded */ }
}

// Called on the top block: if two small cacti are under it, turn the lot into a 2-tall cactus.
function tryMerge(block) {
  try {
    if (!block || block.typeId !== BLOCK_ID) return false;
    const mid = block.below();
    const base = mid?.below();
    if (mid?.typeId !== BLOCK_ID || base?.typeId !== BLOCK_ID) return false;
    base.setType("minecraft:cactus");
    mid.setType("minecraft:cactus");
    block.setType("minecraft:air");
    return true;
  } catch { return false; }
}

const stackComponent = {
  onPlace(event) {
    const block = event.block;
    system.run(() => {
      if (tryMerge(block)) return;
      sync(block);
      sync(block.below());
      sync(block.above());
    });
  },
  // Self-heals when a neighbour is broken or removed by anything.
  onTick(event) {
    if (tryMerge(event.block)) return;
    sync(event.block);
  },
};

// Custom component V2: needs @minecraft/server 2.0.0 and is registered on startup.
system.beforeEvents.startup.subscribe((e) => {
  e.blockComponentRegistry.registerCustomComponent("smallcactus:stack", stackComponent);
});

// ---------- Cactus Juice: nausea for 12 seconds when drunk ----------
const JUICE_ID = "smallcactus:cactus_juice";
const NAUSEA_TICKS = 240;    // 12 seconds

world.afterEvents.itemCompleteUse.subscribe((event) => {
  try {
    if (event.itemStack?.typeId !== JUICE_ID) return;
    event.source.addEffect("nausea", NAUSEA_TICKS, { amplifier: 0, showParticles: true });
  } catch { /* player left */ }
});

// ---------- contact damage ----------
const CHECK_TICKS = 10;      // how often to check (vanilla cactus damages about every 0.5 s)
const DAMAGE = 1;            // half a heart
const REACH = 0.55;          // horizontal distance (centre to centre) that counts as touching

function heightOf(block) {
  const perm = block.permutation;
  if (perm.getState(ABOVE)) return 1;          // 16 px
  if (perm.getState(BELOW)) return 2 / 16;     // top of a stack (16 + 2 = 18 px total)
  return 7 / 16;                               // single
}

function touching(entity) {
  const { x, y, z } = entity.location;
  const dim = entity.dimension;
  const by = Math.floor(y);
  for (let bx = Math.floor(x - 0.8); bx <= Math.floor(x + 0.8); bx++) {
    for (let bz = Math.floor(z - 0.8); bz <= Math.floor(z + 0.8); bz++) {
      if (Math.abs(x - (bx + 0.5)) > REACH || Math.abs(z - (bz + 0.5)) > REACH) continue;
      let block;
      try { block = dim.getBlock({ x: bx, y: by, z: bz }); } catch { continue; }
      if (block && block.typeId === BLOCK_ID && y < by + heightOf(block)) return true;
    }
  }
  return false;
}

system.runInterval(() => {
  const seen = new Set();
  for (const player of world.getAllPlayers()) {
    const nearby = player.dimension.getEntities({
      location: player.location, maxDistance: 16, families: ["mob"],
    });
    for (const entity of [player, ...nearby]) {
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      try {
        if (touching(entity)) entity.applyDamage(DAMAGE, { cause: "contact" });
      } catch { /* entity unloaded or not damageable */ }
    }
  }
}, CHECK_TICKS);
