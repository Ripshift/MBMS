// Farmer's Toolkit - script (namespace fato), @minecraft/server 2.6.0
import {
  world,
  system,
  ItemStack,
  EquipmentSlot,
  EntityComponentTypes,
  GameMode
} from "@minecraft/server";

// ---------------------------------------------------------------- utils
const Utils = {
  diceRoll(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
  },

  mainhand(player) {
    return player.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand);
  },

  // Adds 0-1 durability damage to the held item and breaks it at max.
  damageItem(player) {
    if (player.matches({ gameMode: GameMode.Creative })) return;
    const equipment = player.getComponent("minecraft:equippable");
    const held = equipment?.getEquipment(EquipmentSlot.Mainhand);
    const durability = held?.getComponent("minecraft:durability");
    if (!durability) return;
    durability.damage += Utils.diceRoll(0, 1);
    if (durability.damage >= durability.maxDurability) {
      player.playSound("random.break");
      equipment.setEquipment(EquipmentSlot.Mainhand, undefined);
    } else {
      equipment.setEquipment(EquipmentSlot.Mainhand, held);
    }
  },

  getEntityPlayerIsLookingAt(player, maxRange = 5, coneAngle = 15) {
    const eye = player.getHeadLocation();
    const view = player.getViewDirection();
    const entities = player.dimension.getEntities({
      location: eye,
      maxDistance: maxRange,
      excludeTypes: ["minecraft:player"]
    });
    const coneThreshold = Math.cos((coneAngle * Math.PI) / 180);
    let closest = null;
    let closestDistance = maxRange;
    for (const entity of entities) {
      const height = entity.getComponent("minecraft:collision_box")?.height ?? 1.8;
      let bestAlignment = -Infinity;
      let bestDist = Infinity;
      for (const t of [0.1, 0.5, 0.9]) {
        const dx = entity.location.x - eye.x;
        const dy = entity.location.y + height * t - eye.y;
        const dz = entity.location.z - eye.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const alignment = (dx * view.x + dy * view.y + dz * view.z) / (dist || 1);
        if (alignment > bestAlignment) {
          bestAlignment = alignment;
          bestDist = dist;
        }
      }
      if (bestAlignment >= coneThreshold && bestDist < closestDistance) {
        closest = entity;
        closestDistance = bestDist;
      }
    }
    return closest;
  }
};

// ---------------------------------------------------------------- shepherd's crook
const CROOK_ID = "fato:shepherds_crook";
const LIVESTOCK = [
  "minecraft:sheep",
  "minecraft:pig",
  "minecraft:cow",
  "minecraft:chicken",
  "minecraft:goat",
  "minecraft:mooshroom"
];

class ShepherdsCrookUse {
  constructor() {
    this.onUse = this.onUse.bind(this);
  }
  // Right click: pull the livestock you are looking at to you.
  onUse(e) {
    if (e.itemStack?.typeId !== CROOK_ID) return;
    const player = e.source;
    const mob = Utils.getEntityPlayerIsLookingAt(player);
    if (mob && LIVESTOCK.includes(mob.typeId)) {
      mob.teleport({ x: player.location.x, y: player.location.y, z: player.location.z });
    }
    try {
      player.playAnimation("animation.player.first_person.use_crook");
    } catch (err) {
      // animation is optional
    }
    player.playSound("item.shepherds_crook.swing");
  }
}

// A knockback landing spot is safe when feet and head are free and the floor is solid ground.
function isSafeLanding(dimension, x, y, z) {
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  const feet = dimension.getBlock({ x: bx, y: by, z: bz });
  const head = dimension.getBlock({ x: bx, y: by + 1, z: bz });
  const floor = dimension.getBlock({ x: bx, y: by - 1, z: bz });
  if (!feet || !head || !floor) return false;
  return feet.isAir && head.isAir && !floor.isAir && !floor.isLiquid;
}

function onCrookHit(e) {
  const attacker = e.damagingEntity;
  if (attacker.typeId !== "minecraft:player") return;
  const target = e.hitEntity;
  if (!LIVESTOCK.includes(target.typeId)) return;
  if (Utils.mainhand(attacker)?.typeId !== CROOK_ID) return;

  const health = target.getComponent(EntityComponentTypes.Health);
  if (health) health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + 2));

  const dx = target.location.x - attacker.location.x;
  const dz = target.location.z - attacker.location.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len === 0) return;
  const ux = dx / len, uz = dz / len;
  for (const distance of [3, 2, 1]) {
    const x = target.location.x + ux * distance;
    const z = target.location.z + uz * distance;
    if (isSafeLanding(target.dimension, x, target.location.y, z)) {
      target.clearVelocity();
      target.teleport({ x, y: target.location.y, z });
      return;
    }
  }
}

// ---------------------------------------------------------------- sickle
const SICKLE_ID = "fato:sickle";
const COOLDOWN_TICKS = 2;
// state: block state holding the growth stage; max: fully grown value; replant: stage after harvest
const SICKLE_CROPS = {
  "minecraft:wheat": { state: "growth", max: 7, replant: 2, item: "minecraft:wheat", count: [1, 1], seed: "minecraft:wheat_seeds", seedCount: [1, 2] },
  "minecraft:carrots": { state: "growth", max: 7, replant: 0, item: "minecraft:carrot", count: [2, 4] },
  "minecraft:potatoes": { state: "growth", max: 7, replant: 0, item: "minecraft:potato", count: [2, 4] },
  "minecraft:beetroot": { state: "growth", max: 7, replant: 0, item: "minecraft:beetroot", count: [1, 1], seed: "minecraft:beetroot_seeds", seedCount: [1, 2] },
  "minecraft:nether_wart": { state: "age", max: 3, replant: 0, item: "minecraft:nether_wart", count: [2, 4] }
};
const recentlyHarvested = new Map();

function initSickle() {
  world.beforeEvents.playerBreakBlock.subscribe((e) => {
    const crop = SICKLE_CROPS[e.block.typeId];
    if (!crop) return;
    if (e.itemStack?.typeId !== SICKLE_ID) return;
    // Not ripe: break it like normal.
    if (e.block.permutation.getState(crop.state) !== crop.max) return;

    const loc = e.block.location;
    const dimension = e.dimension;
    const player = e.player;
    const key = `${dimension.id},${loc.x},${loc.y},${loc.z}`;
    e.cancel = true;
    const last = recentlyHarvested.get(key);
    if (last !== undefined && system.currentTick - last < COOLDOWN_TICKS) return;
    recentlyHarvested.set(key, system.currentTick);

    system.run(() => {
      try {
        const block = dimension.getBlock(loc);
        if (!block || block.typeId !== e.block.typeId || block.permutation.getState(crop.state) !== crop.max) return;
        const pos = { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
        const sickle = player.isValid ? Utils.mainhand(player) : undefined;
        const enchantable = sickle?.typeId === SICKLE_ID ? sickle.getComponent("minecraft:enchantable") : undefined;

        let count = Utils.diceRoll(crop.count[0], crop.count[1]);
        const fortune = enchantable?.getEnchantment("fortune")?.level ?? 0;
        for (let i = 0; i < fortune; i++) {
          if (Utils.diceRoll(1, 100) <= 33) count++;
        }
        dimension.spawnItem(new ItemStack(crop.item, count), pos);
        if (crop.seed) {
          dimension.spawnItem(new ItemStack(crop.seed, Utils.diceRoll(crop.seedCount[0], crop.seedCount[1])), pos);
        }
        block.setPermutation(block.permutation.withState(crop.state, crop.replant));
        dimension.playSound("dig.grass", pos);
        dimension.spawnParticle("minecraft:crop_growth_emitter", pos);

        if (enchantable) {
          const unbreaking = enchantable.getEnchantment("unbreaking")?.level ?? 0;
          if (unbreaking === 0 || Utils.diceRoll(1, 100) <= 100 / (unbreaking + 1)) {
            Utils.damageItem(player);
          }
        }
      } finally {
        system.runTimeout(() => recentlyHarvested.delete(key), 20);
      }
    });
  });
}

// ---------------------------------------------------------------- farmer's hat
function initFarmersHat() {
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      const helmet = player.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Head);
      if (helmet?.typeId === "fato:farmers_hat") {
        player.addEffect("speed", 30, { showParticles: false });
        player.addEffect("haste", 30, { showParticles: false });
      }
    }
  }, 20);
}

// ---------------------------------------------------------------- watering can
const WATERABLE_CROPS = {
  "minecraft:wheat": 7,
  "minecraft:carrots": 7,
  "minecraft:potatoes": 7,
  "minecraft:beetroot": 7,
  "minecraft:pumpkin_stem": 7,
  "minecraft:melon_stem": 7,
  "minecraft:sweet_berry_bush": 3
};
const WATERABLE_SAPLINGS = [
  "minecraft:oak_sapling",
  "minecraft:spruce_sapling",
  "minecraft:birch_sapling",
  "minecraft:jungle_sapling",
  "minecraft:acacia_sapling",
  "minecraft:dark_oak_sapling",
  "minecraft:cherry_sapling",
  "minecraft:mangrove_propagule"
];
const WATER_CHANCE = 60;

function center(block) {
  return { x: block.location.x + 0.5, y: block.location.y + 0.5, z: block.location.z + 0.5 };
}

class WateringCanUse {
  constructor() {
    this.onUse = this.onUse.bind(this);
  }
  onUse(e) {
    if (e.itemStack?.typeId === "fato:watering_can") this.onEmptyCanUse(e.source);
    else this.onFullCanUse(e.source);
  }
  getTarget(player) {
    return player.getBlockFromViewDirection({ includeLiquidBlocks: true, includePassableBlocks: true })?.block;
  }
  onEmptyCanUse(player) {
    if (this.getTarget(player)?.typeId === "minecraft:water") this.setCan(player, "fato:watering_can", "fato:watering_can_filled");
  }
  // The can is only emptied when the water did something.
  onFullCanUse(player) {
    const block = this.getTarget(player);
    if (!block) return;
    let used = false;
    if (WATERABLE_SAPLINGS.includes(block.typeId)) {
      used = this.waterSapling(block, player);
    } else if (block.typeId in WATERABLE_CROPS) {
      used = this.waterCrop(block, player);
      const soil = block.below();
      if (soil && this.moistenIfDry(soil)) used = true;
    } else if (block.typeId === "minecraft:farmland") {
      used = this.moistenIfDry(block);
    }
    if (used) this.setCan(player, "fato:watering_can_filled", "fato:watering_can");
  }
  moistenIfDry(block) {
    if (block.typeId !== "minecraft:farmland") return false;
    const moisture = block.permutation.getState("moisturized_amount");
    if (typeof moisture !== "number" || moisture >= 7) return false;
    this.splash(block);
    block.setPermutation(block.permutation.withState("moisturized_amount", 7));
    return true;
  }
  splash(block) {
    block.dimension.spawnParticle("minecraft:water_splash_particle", center(block));
  }
  waterCrop(block, player) {
    const growth = block.permutation.getState("growth");
    if (typeof growth !== "number" || growth >= WATERABLE_CROPS[block.typeId]) return false;
    if (Utils.diceRoll(1, 100) <= WATER_CHANCE) {
      block.setPermutation(block.permutation.withState("growth", growth + 1));
      block.dimension.spawnParticle("minecraft:crop_growth_emitter", center(block));
    } else {
      this.splash(block);
    }
    player.playSound("block.beehive.drip");
    return true;
  }
  waterSapling(block, player) {
    if (block.permutation.getState("age_bit") !== false) return false;
    if (Utils.diceRoll(1, 100) <= WATER_CHANCE) {
      block.setPermutation(block.permutation.withState("age_bit", true));
      block.dimension.spawnParticle("minecraft:crop_growth_emitter", center(block));
    } else {
      this.splash(block);
    }
    player.playSound("block.beehive.drip");
    return true;
  }
  setCan(player, from, to) {
    const equipment = player.getComponent("minecraft:equippable");
    if (!equipment) return;
    if (equipment.getEquipment(EquipmentSlot.Mainhand)?.typeId !== from) return;
    equipment.setEquipment(EquipmentSlot.Mainhand, new ItemStack(to, 1));
    player.playSound("bucket.fill_water");
  }
}

// ---------------------------------------------------------------- traps
const RABBIT = { baitItem: "minecraft:carrot", catchRadius: 2, catchChance: 0.5 };
const FISH = { catchChance: 0.5 };

function setState(block, name, value) {
  block.setPermutation(block.permutation.withState(name, value));
}
function consumeOneMainhand(player) {
  if (player.matches({ gameMode: GameMode.Creative })) return;
  const equip = player.getComponent("minecraft:equippable");
  const item = equip?.getEquipment(EquipmentSlot.Mainhand);
  if (!item) return;
  if (item.amount > 1) {
    item.amount -= 1;
    equip.setEquipment(EquipmentSlot.Mainhand, item);
  } else {
    equip.setEquipment(EquipmentSlot.Mainhand, undefined);
  }
}
function giveLoot(player, table) {
  player.runCommand(`loot give @s loot "${table}"`);
}
function spawnLoot(dimension, block, table) {
  const { x, y, z } = block.location;
  dimension.runCommand(`loot spawn ${x} ${y} ${z} loot "${table}"`);
}
function playSound(dimension, sound, block) {
  const { x, y, z } = block.center();
  dimension.runCommand(`playsound ${sound} @a ${x} ${y} ${z}`);
}
function isWater(block) {
  return block?.typeId === "minecraft:water" || block?.typeId === "minecraft:flowing_water";
}

const rabbitTrap = {
  onTick(e) {
    const { block, dimension } = e;
    if (block.permutation.getState("fato:stage") !== "baited") return;
    const rabbits = dimension.getEntities({
      type: "minecraft:rabbit",
      location: block.center(),
      maxDistance: RABBIT.catchRadius
    });
    if (rabbits.length === 0) return;
    if (Math.random() >= RABBIT.catchChance) return;
    rabbits[0].remove();
    setState(block, "fato:stage", "trapped");
    playSound(dimension, "mob.rabbit.hurt", block);
  },
  onPlayerInteract(e) {
    const { block, dimension, player } = e;
    if (!player) return;
    const stage = block.permutation.getState("fato:stage");
    const held = Utils.mainhand(player);
    if (stage === "empty" && held?.typeId === RABBIT.baitItem) {
      setState(block, "fato:stage", "baited");
      consumeOneMainhand(player);
      playSound(dimension, "random.pop", block);
    } else if (stage === "baited" && !held && player.isSneaking) {
      setState(block, "fato:stage", "empty");
      dimension.spawnItem(new ItemStack(RABBIT.baitItem, 1), block.center());
    } else if (stage === "trapped") {
      giveLoot(player, "fato/rabbit_trap");
      setState(block, "fato:stage", "empty");
    }
  },
  onPlayerBreak(e) {
    const { block, dimension, brokenBlockPermutation } = e;
    const stage = brokenBlockPermutation.getState("fato:stage");
    if (stage === "baited") dimension.spawnItem(new ItemStack(RABBIT.baitItem, 1), block.center());
    else if (stage === "trapped") spawnLoot(dimension, block, "fato/rabbit_trap");
  }
};

const fishTrap = {
  onTick(e) {
    const { block, dimension } = e;
    if (block.permutation.getState("fato:full") === true) return;
    if (!isWater(block.below())) return;
    if (Math.random() >= FISH.catchChance) return;
    if (Utils.diceRoll(1, 100) <= 30) {
      setState(block, "fato:full", true);
      playSound(dimension, "random.splash", block);
    }
  },
  onPlayerInteract(e) {
    const { block, player } = e;
    if (!player) return;
    if (block.permutation.getState("fato:full") !== true) return;
    giveLoot(player, "fato/fish_trap");
    setState(block, "fato:full", false);
  },
  onPlayerBreak(e) {
    const { block, dimension, brokenBlockPermutation } = e;
    if (brokenBlockPermutation.getState("fato:full") === true) spawnLoot(dimension, block, "fato/fish_trap");
  }
};

// ---------------------------------------------------------------- init
system.beforeEvents.startup.subscribe((init) => {
  init.itemComponentRegistry.registerCustomComponent("fato:use", new ShepherdsCrookUse());
  init.itemComponentRegistry.registerCustomComponent("fato:watering_can_use", new WateringCanUse());
  init.blockComponentRegistry.registerCustomComponent("fato:rabbit_trap_behavior", rabbitTrap);
  init.blockComponentRegistry.registerCustomComponent("fato:fish_trap_behavior", fishTrap);
});

world.afterEvents.entityHitEntity.subscribe(onCrookHit);
initSickle();
initFarmersHat();
