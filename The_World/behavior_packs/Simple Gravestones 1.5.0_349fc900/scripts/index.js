// Simple Gravestones (namespace ae_sg).
// Readable rebuild of the original obfuscated script. Same identifiers, structure names and
// dynamic-property keys as the original, so existing gravestones keep working.
// "FIX" = bug fix over the original (1.1.1).  "NEW" = added in 1.2.0.
import {
  BlockInventoryComponent,
  BlockPermutation,
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  EntityEquippableComponent,
  EntityInventoryComponent,
  EntitySwingSource,
  EquipmentSlot,
  ItemStack,
  Player,
  PlayerPermissionLevel,
  system,
  world,
} from "@minecraft/server";

// NEW: settings. Edit here, then bump the pack version before re-uploading to the server.
const CONFIG = {
  // "open"   = anyone can loot any gravestone (original behaviour).
  // "closed" = only the player who died can loot it.
  // This is only the default: an admin can change it in game with /ae_sg:casket open|closed
  // (that choice is saved in the world and wins over this value).
  casket: "open",
  opsCanOpenClosed: true, // closed casket: operators may still open any gravestone
  placeRadius: 6, // how far sideways to look for a good spot (blocks)
  voidSearchRadius: 96, // void deaths: how far (blocks) to look for ground in each direction (only chunks within the server's simulation distance are usable)
  voidIslandLevel: 0, // void deaths with no ground found: bottom of the little end-stone island (y)
  placeVertical: 40, // how far UP to look for open space when someone dies inside solid rock
  xpFallback: "orbs", // when no gravestone fits: "orbs" = drop XP orbs, "keep" = player keeps XP
  xpPerOrb: 1, // XP worth of one spawned orb; test with /summon xp_orb and adjust
  finderTicks: 5, // how often the Grave Finder refreshes while held (20 ticks = 1 s)
  // Thin base of the gravestone: "match" = textured like the block under the grave (see FLOOR_SLOT),
  // "ground" = no base at all, the headstone stands directly on the block.
  platformStyle: "match",
  maxXpOrbs: 200, // safety cap so a huge XP total cannot lag the server
  // keepInventory is a cheat rule, so the script does not use it. Instead it remembers every
  // player's inventory, armour and XP and builds the grave from that copy when they die.
  snapshotTicks: 10, // how often each player's inventory is remembered (20 ticks = 1 s)
  riskSnapshotTicks: 1, // ...and how often while in danger (low health, or below the world)
  riskHealth: 8, // health (2 per heart) at or below which a player counts as in danger
  dropRadius: 6, // blocks around the death spot where dropped items are collected into the grave
  xpOrbRadius: 3, // blocks around the death spot where the player's dropped XP orbs are removed
  dropWaitTicks: 2, // ticks to wait after death so the game has spawned the dropped items
  maxSnapshotAge: 100, // a remembered copy older than this (ticks) is not trusted
};

const FINDER_ID = "ae_sg:grave_finder";
const GRAVESTONE_ID = "ae_sg:gravestone";
const VOID_ISLAND_ID = "ae_sg:void_island"; // structures/ae_sg/void_island.mcstructure (7 x 3 x 7)
const VOID_ISLAND = { size: 7, height: 3, centre: 3 };
const DISABLED_PROP = "ae_sg:disabled";
const CASKET_PROP = "ae_sg:casket";
const HOTBAR_SIZE = 9;
const SEARCH_RANGE = 400;
const MAX_TRACKED_GRAVES = 20;

// Order matters: it is the slot order stored in the ".3" structure.
const equippableIndex = [
  EquipmentSlot.Head,
  EquipmentSlot.Chest,
  EquipmentSlot.Legs,
  EquipmentSlot.Feet,
  EquipmentSlot.Offhand,
];

let enabled = true;

// ---------------------------------------------------------------- startup state
system.run(() => {
  enabled = !(world.getDynamicProperty(DISABLED_PROP) ?? false);
});

// ---------------------------------------------------------------- helpers
function graveKey(dimension, location) {
  return `${dimension.id}_${location.x}_${location.y}_${location.z}`
    .replaceAll(".", "_")
    .replaceAll("-", "negative")
    .replaceAll(":", "_");
}

function propKeyFor(dimension, location) {
  return dimension.id + "." + graveKey(dimension, location);
}

// NEW (1.3.5): the thin base of the gravestone is textured like the block it stands on. A block cannot
// copy another block's texture, so there is a table of 151 base textures (the slot is stored in the block
// states platform_a / platform_b as slot = a * 16 + b; textures ae_sg:plat_<slot> in terrain_texture.json)
// and this table says which slot belongs to which floor block. Slots (first block using each texture):
// 0=dirt, 1=coarse_dirt, 2=podzol, 3=mycelium, 4=farmland, 5=moss_block, 6=mud, 7=packed_mud, 8=mud_bricks, 9=clay, 10=sand, 11=red_sand, 12=gravel, 13=sandstone, 14=red_sandstone, 15=stone, 16=cobblestone, 17=mossy_cobblestone, 18=stone_bricks, 19=mossy_stone_bricks, 20=cracked_stone_bricks, 21=chiseled_stone_bricks, 22=smooth_stone, 23=andesite, 24=polished_andesite, 25=diorite, 26=polished_diorite, 27=granite, 28=polished_granite, 29=tuff, 30=polished_tuff, 31=tuff_bricks, 32=calcite, 33=dripstone_block, 34=deepslate, 35=cobbled_deepslate, 36=polished_deepslate, 37=deepslate_bricks, 38=deepslate_tiles, 39=chiseled_deepslate, 40=bedrock, 41=obsidian, 42=crying_obsidian, 43=netherrack, 44=cracked_nether_bricks, 45=chiseled_nether_bricks, 46=soul_sand, 47=soul_soil, 48=basalt, 49=polished_basalt, 50=smooth_basalt, 51=blackstone, 52=polished_blackstone, 53=polished_blackstone_bricks, 54=gilded_blackstone, 55=crimson_nylium, 56=warped_nylium, 57=nether_wart_block, 58=warped_wart_block, 59=magma, 60=glowstone, 61=shroomlight, 62=end_stone, 63=end_bricks, 64=purpur_block, 65=purpur_pillar, 66=snow, 67=powder_snow, 68=ice, 69=packed_ice, 70=blue_ice, 71=white_terracotta, 72=orange_terracotta, 73=magenta_terracotta, 74=light_blue_terracotta, 75=yellow_terracotta, 76=lime_terracotta, 77=pink_terracotta, 78=gray_terracotta, 79=light_gray_terracotta, 80=cyan_terracotta, 81=purple_terracotta, 82=blue_terracotta, 83=brown_terracotta, 84=green_terracotta, 85=red_terracotta, 86=black_terracotta, 87=oak_planks, 88=spruce_planks, 89=birch_planks, 90=jungle_planks, 91=acacia_planks, 92=dark_oak_planks, 93=mangrove_planks, 94=cherry_planks, 95=bamboo_planks, 96=crimson_planks, 97=warped_planks, 98=pale_oak_planks, 99=quartz_block, 100=smooth_quartz, 101=coal_block, 102=iron_block, 103=gold_block, 104=copper_block, 105=cut_copper, 106=exposed_copper, 107=weathered_copper, 108=oxidized_copper, 109=netherite_block, 110=prismarine, 111=prismarine_bricks, 112=dark_prismarine, 113=white_concrete, 114=orange_concrete, 115=red_concrete, 116=lime_concrete, 117=cyan_concrete, 118=blue_concrete, 119=black_concrete, 120=gray_concrete, 121=white_wool, 122=brown_wool, 123=bone_block, 124=hay_block, 125=oak_log, 126=spruce_log, 127=birch_log, 128=jungle_log, 129=acacia_log, 130=dark_oak_log, 131=mangrove_log, 132=cherry_log, 133=crimson_stem, 134=warped_stem, 135=pale_moss_block, 136=resin_block, 137=coal_ore, 138=iron_ore, 139=gold_ore, 140=diamond_ore, 141=deepslate_coal_ore, 142=deepslate_iron_ore, 143=ancient_debris, 144=grass_block, 145=rooted_dirt, 146=dirt_path, 147=nether_bricks, 148=red_nether_bricks, 149=bricks, 150=terracotta
const FLOOR_SLOT = {
  "dirt": 0,
  "coarse_dirt": 1,
  "podzol": 2,
  "mycelium": 3,
  "farmland": 4,
  "moss_block": 5,
  "mud": 6,
  "packed_mud": 7,
  "mud_bricks": 8,
  "clay": 9,
  "sand": 10,
  "red_sand": 11,
  "gravel": 12,
  "sandstone": 13,
  "red_sandstone": 14,
  "smooth_sandstone": 13,
  "cut_sandstone": 13,
  "chiseled_sandstone": 13,
  "stone": 15,
  "cobblestone": 16,
  "mossy_cobblestone": 17,
  "stone_bricks": 18,
  "mossy_stone_bricks": 19,
  "cracked_stone_bricks": 20,
  "chiseled_stone_bricks": 21,
  "smooth_stone": 22,
  "andesite": 23,
  "polished_andesite": 24,
  "diorite": 25,
  "polished_diorite": 26,
  "granite": 27,
  "polished_granite": 28,
  "tuff": 29,
  "polished_tuff": 30,
  "tuff_bricks": 31,
  "calcite": 32,
  "dripstone_block": 33,
  "deepslate": 34,
  "cobbled_deepslate": 35,
  "polished_deepslate": 36,
  "deepslate_bricks": 37,
  "deepslate_tiles": 38,
  "chiseled_deepslate": 39,
  "bedrock": 40,
  "obsidian": 41,
  "crying_obsidian": 42,
  "netherrack": 43,
  "cracked_nether_bricks": 44,
  "chiseled_nether_bricks": 45,
  "soul_sand": 46,
  "soul_soil": 47,
  "basalt": 48,
  "polished_basalt": 49,
  "smooth_basalt": 50,
  "blackstone": 51,
  "polished_blackstone": 52,
  "polished_blackstone_bricks": 53,
  "gilded_blackstone": 54,
  "crimson_nylium": 55,
  "warped_nylium": 56,
  "nether_wart_block": 57,
  "warped_wart_block": 58,
  "magma": 59,
  "glowstone": 60,
  "shroomlight": 61,
  "end_stone": 62,
  "end_bricks": 63,
  "purpur_block": 64,
  "purpur_pillar": 65,
  "snow": 66,
  "powder_snow": 67,
  "ice": 68,
  "packed_ice": 69,
  "blue_ice": 70,
  "white_terracotta": 71,
  "orange_terracotta": 72,
  "magenta_terracotta": 73,
  "light_blue_terracotta": 74,
  "yellow_terracotta": 75,
  "lime_terracotta": 76,
  "pink_terracotta": 77,
  "gray_terracotta": 78,
  "light_gray_terracotta": 79,
  "cyan_terracotta": 80,
  "purple_terracotta": 81,
  "blue_terracotta": 82,
  "brown_terracotta": 83,
  "green_terracotta": 84,
  "red_terracotta": 85,
  "black_terracotta": 86,
  "oak_planks": 87,
  "spruce_planks": 88,
  "birch_planks": 89,
  "jungle_planks": 90,
  "acacia_planks": 91,
  "dark_oak_planks": 92,
  "mangrove_planks": 93,
  "cherry_planks": 94,
  "bamboo_planks": 95,
  "crimson_planks": 96,
  "warped_planks": 97,
  "pale_oak_planks": 98,
  "quartz_block": 99,
  "smooth_quartz": 100,
  "coal_block": 101,
  "iron_block": 102,
  "gold_block": 103,
  "copper_block": 104,
  "cut_copper": 105,
  "exposed_copper": 106,
  "weathered_copper": 107,
  "oxidized_copper": 108,
  "netherite_block": 109,
  "prismarine": 110,
  "prismarine_bricks": 111,
  "dark_prismarine": 112,
  "white_concrete": 113,
  "orange_concrete": 114,
  "red_concrete": 115,
  "lime_concrete": 116,
  "cyan_concrete": 117,
  "blue_concrete": 118,
  "black_concrete": 119,
  "gray_concrete": 120,
  "white_wool": 121,
  "brown_wool": 122,
  "bone_block": 123,
  "hay_block": 124,
  "oak_log": 125,
  "spruce_log": 126,
  "birch_log": 127,
  "jungle_log": 128,
  "acacia_log": 129,
  "dark_oak_log": 130,
  "mangrove_log": 131,
  "cherry_log": 132,
  "crimson_stem": 133,
  "warped_stem": 134,
  "pale_moss_block": 135,
  "resin_block": 136,
  "coal_ore": 137,
  "iron_ore": 138,
  "gold_ore": 139,
  "diamond_ore": 140,
  "deepslate_coal_ore": 141,
  "deepslate_iron_ore": 142,
  "ancient_debris": 143,
  "grass_block": 144,
  "rooted_dirt": 145,
  "dirt_path": 146,
  "nether_bricks": 147,
  "red_nether_bricks": 148,
  "bricks": 149,
  "terracotta": 150,
  "grass": 144,
  "grass_path": 146,
  "dirt_with_roots": 145,
  "hardened_clay": 150,
  "brick_block": 149,
  "nether_brick": 147,
  "red_nether_brick": 148,
  "stonebrick": 18,
  "magma_block": 59,
  "snow_layer": 66,
};

// Blocks that are not in the table borrow the texture of a similar one.
const FLOOR_SUFFIXES = ["_stairs", "_slab", "_wall", "_pressure_plate", "_button", "_fence_gate", "_fence"];
const FLOOR_PREFIXES = ["stripped_", "waxed_", "infested_", "double_"];
const FLOOR_FALLBACKS = [
  [/^(soul_|basalt|nether_|crimson_|warped_|ancient_debris)/, "netherrack"],
  [/^(end_|purpur)/, "end_stone"],
  [/deepslate/, "deepslate"],
  [/sand/, "sand"],
  [/(snow|ice$)/, "snow"],
  [/gravel/, "gravel"],
  [/(grass|moss|farmland|leaves|fern|bush)/, "grass_block"],
  [/(dirt|roots)/, "dirt"],
  [/(terracotta|clay)/, "terracotta"],
  [/planks/, "oak_planks"],
  [/_log$/, "oak_log"],
  [/(stone|cobble|andesite|diorite|granite|tuff|calcite|dripstone|ore$|brick)/, "stone"],
];

function floorSlot(typeId) {
  const id = (typeId ?? "").replace("minecraft:", "");
  if (id === "") return undefined;
  const tries = [id, id.replace(/_wood$/, "_log").replace(/_hyphae$/, "_stem")];
  for (const prefix of FLOOR_PREFIXES) if (id.startsWith(prefix)) tries.push(id.slice(prefix.length));
  for (const suffix of FLOOR_SUFFIXES) {
    if (id.endsWith(suffix)) {
      const base = id.slice(0, -suffix.length);
      tries.push(base, base + "_planks", base + "s", base + "_block");
    }
  }
  for (const t of tries) if (FLOOR_SLOT[t] !== undefined) return FLOOR_SLOT[t];
  for (const [pattern, base] of FLOOR_FALLBACKS) if (pattern.test(id)) return FLOOR_SLOT[base];
  return undefined;
}

// The block states for the gravestone's base, given the block under it.
function platformStates(dimension, floorTypeId) {
  if (CONFIG.platformStyle === "ground") return { "ae_sg:platform_type": "ground" };
  if (BASE_ENTITIES.has(floorTypeId)) return { "ae_sg:platform_type": "ground" }; // a patch add-on draws the base (see below)
  let slot = floorSlot(floorTypeId);
  if (slot === undefined && dimension.id.includes("nether")) slot = FLOOR_SLOT.netherrack;
  if (slot === undefined && dimension.id.includes("the_end")) slot = FLOOR_SLOT.end_stone;
  if (slot === undefined) return { "ae_sg:platform_type": "overworld" }; // plain dirt patch
  return { "ae_sg:platform_type": "custom", "ae_sg:platform_a": Math.floor(slot / 16), "ae_sg:platform_b": slot % 16 };
}

function spawnItem(item, dimension, location) {
  const entity = dimension.spawnItem(item, {
    x: location.x,
    y: dimension.heightRange.max,
    z: location.z,
  });
  entity.teleport(location);
  return entity;
}

function containerOf(block) {
  return block.getComponent(BlockInventoryComponent.componentId)?.container;
}

// FIX: a block can exist as an object while its chunk is loaded but not ticking (outside the
// simulation distance); touching it then throws LocationInUnloadedChunkError. Probe it first.
function blockAt(dimension, x, y, z) {
  try {
    const block = dimension.getBlock({ x, y, z });
    if (block) void block.isAir;
    return block;
  } catch (e) {
    return undefined; // chunk not loaded / not ticking
  }
}

// ---------------------------------------------------------------- casket (open / closed)
// NEW
function casketMode() {
  const saved = world.getDynamicProperty(CASKET_PROP);
  return saved === "open" || saved === "closed" ? saved : CONFIG.casket;
}

function canOpen(propKey, player) {
  if (casketMode() === "open") return true;
  const owner = world.getDynamicProperty(propKey + ".owner");
  if (!owner) return true; // grave made before 1.2.0: no owner recorded
  if (owner === player.id) return true;
  if (CONFIG.opsCanOpenClosed && player.playerPermissionLevel === PlayerPermissionLevel.Operator) return true;
  return false;
}

const lockedNoticeAt = new Map();
function notifyLocked(propKey, player) {
  const now = system.currentTick;
  if (now - (lockedNoticeAt.get(player.id) ?? -1000) < 40) return; // swinging fires this a lot
  lockedNoticeAt.set(player.id, now);
  const ownerName = world.getDynamicProperty(propKey + ".name") ?? "someone";
  player.onScreenDisplay.setActionBar({ translate: "ae_sg.locked", with: [ownerName] });
}

// ---------------------------------------------------------------- grave list per player (Grave Finder)
function readGraves(playerId) {
  try {
    const list = JSON.parse(world.getDynamicProperty("ae_sg:graves." + playerId) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}
function writeGraves(playerId, list) {
  world.setDynamicProperty("ae_sg:graves." + playerId, list.length ? JSON.stringify(list) : undefined);
}
function rememberGrave(playerId, dimension, location) {
  const list = readGraves(playerId);
  list.push({ d: dimension.id, x: location.x, y: location.y, z: location.z });
  writeGraves(playerId, list.slice(-MAX_TRACKED_GRAVES));
}
function forgetGrave(playerId, dimensionId, location) {
  if (!playerId) return;
  const list = readGraves(playerId).filter(
    (g) => !(g.d === dimensionId && g.x === location.x && g.y === location.y && g.z === location.z),
  );
  writeGraves(playerId, list);
}

// ---------------------------------------------------------------- scratch storage (structures)
// Scratch block at the bottom of the world, under the given player. A barrel is placed there
// temporarily so the structure manager can store / return item stacks, then the block is restored.
// FIX: the original always used world.getPlayers()[0]; it now uses the player actually involved.
function whereOf(player) {
  return { dimension: player.dimension, x: player.location.x, z: player.location.z };
}

function scratchSpot(where) {
  const dimension = where.dimension;
  const location = { x: where.x, y: dimension.heightRange.min, z: where.z };
  const block = dimension.getBlock(location);
  if (!block) throw new Error("gravestone scratch block is not loaded");
  return { dimension, location, block };
}

function save(name, items, where) {
  if (!items) {
    world.structureManager.delete("ae_sg:" + name);
    return;
  }
  const { dimension, location, block } = scratchSpot(where);
  const oldPermutation = block.permutation;
  const oldItems = [];
  const oldContainer = containerOf(block);
  if (oldContainer) {
    for (let i = 0; i < oldContainer.size; i++) {
      oldItems.push(oldContainer.getItem(i));
      oldContainer.setItem(i, undefined);
    }
  }
  block.setType("barrel");
  const barrel = containerOf(block);
  if (!barrel) {
    block.setPermutation(oldPermutation);
    throw new Error("could not place scratch barrel");
  }
  try {
    for (let i = 0; i < items.length; i++) barrel.setItem(i, items[i]);
    world.structureManager.createFromWorld("ae_sg:" + name, dimension, location, location, {
      includeEntities: false,
      includeBlocks: true,
    });
  } finally {
    for (let i = 0; i < barrel.size; i++) barrel.setItem(i, undefined);
    block.setPermutation(oldPermutation);
    if (oldContainer) {
      const restored = containerOf(block);
      if (restored) for (let i = 0; i < restored.size; i++) restored.setItem(i, oldItems[i]);
    }
  }
}

function load(name, where) {
  const results = [];
  const { dimension, location, block } = scratchSpot(where);
  const oldPermutation = block.permutation;
  const oldItems = [];
  const oldContainer = containerOf(block);
  if (oldContainer) {
    for (let i = 0; i < oldContainer.size; i++) {
      oldItems.push(oldContainer.getItem(i));
      oldContainer.setItem(i, undefined);
    }
  }
  try {
    world.structureManager.place("ae_sg:" + name, dimension, location);
    const barrel = containerOf(block);
    if (barrel) {
      for (let i = 0; i < barrel.size; i++) {
        results.push(barrel.getItem(i));
        barrel.setItem(i, undefined);
      }
    }
  } finally {
    block.setPermutation(oldPermutation);
    if (oldContainer) {
      const restored = containerOf(block);
      if (restored) for (let i = 0; i < restored.size; i++) restored.setItem(i, oldItems[i]);
    }
  }
  return results;
}

// ---------------------------------------------------------------- finding a place for the grave
// Original helper (kept, and exported): nearest block above/below that satisfies the filter.
function findSpace(dimension, location, range = 100, filter) {
  if (!dimension.isChunkLoaded(location)) return undefined;
  const { min, max } = dimension.heightRange;
  const ok = (b) => (filter ? filter(b) : b.isAir || b.isLiquid);
  const test = (y) => {
    const block = blockAt(dimension, location.x, y, location.z);
    return block && ok(block) ? block : undefined;
  };
  for (let offset = 0; offset <= range; offset++) {
    if (offset === 0) {
      if (location.y <= min || location.y >= max) continue;
      const block = test(location.y);
      if (block) return block;
    } else {
      for (const dir of [-1, 1]) {
        const y = location.y + offset * dir;
        if (y <= min || y >= max) continue;
        const block = test(y);
        if (block) return block;
      }
    }
  }
  return undefined;
}

// NEW: a gravestone may replace air or water, but never lava.
function isLava(block) {
  return block.typeId === "minecraft:lava" || block.typeId === "minecraft:flowing_lava";
}
function canHold(block) {
  return block.isAir || (block.isLiquid && !isLava(block));
}

// Cast a ray straight down from the cell at fromY. The ray skips air, water, lava and passable
// blocks (grass, flowers, torches...), so the first hit is real ground. The grave goes in the
// cell above it. Returns undefined when the start cell is inside a block or the cell is lava.
function scanDown(dimension, x, z, fromY, depth, min) {
  let hit;
  try {
    hit = dimension.getBlockFromRay(
      { x: x + 0.5, y: fromY + 0.5, z: z + 0.5 },
      { x: 0, y: -1, z: 0 },
      { includeLiquidBlocks: false, includePassableBlocks: false, maxDistance: depth + 1 },
    );
  } catch (e) {
    return undefined; // unloaded chunk
  }
  if (!hit) return undefined;
  try {
    const y = hit.block.location.y + 1;
    if (y > fromY || y <= min) return undefined;
    const cell = blockAt(dimension, x, y, z);
    return cell && canHold(cell) ? y : undefined;
  } catch (e) {
    return undefined; // chunk not ticking
  }
}

// For deaths inside rock: lowest free cell above fromY that rests on a non-air, non-liquid block.
function scanUp(dimension, x, z, fromY, height, max) {
  const highest = Math.min(fromY + height, max - 2);
  let below = blockAt(dimension, x, fromY - 1, z);
  for (let y = fromY; y <= highest; y++) {
    const cell = blockAt(dimension, x, y, z);
    try {
      if (cell && below && cell.isAir && !below.isAir && !below.isLiquid) return y;
    } catch (e) {
      return undefined;
    }
    below = cell;
  }
  return undefined;
}

// NEW: look for ground near the death spot. Works on cliffs, in caves, under water and from
// the air. Picks the closest standable cell (sideways distance + vertical distance).
function findGround(dimension, at) {
  const { min, max } = dimension.heightRange;
  const bx = Math.floor(at.x);
  const bz = Math.floor(at.z);
  const by = Math.min(Math.max(Math.floor(at.y), min + 1), max - 3);
  const R = CONFIG.placeRadius;
  const V = CONFIG.placeVertical;
  let best;
  for (let r = 0; r <= R; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const horizontal = Math.abs(dx) + Math.abs(dz);
        if (best && horizontal >= best.cost) continue;
        const x = bx + dx;
        const z = bz + dz;
        const down = scanDown(dimension, x, z, by, by - min, min); // any depth: sky deaths land on the ground
        const up = scanUp(dimension, x, z, by + 1, V, max);
        for (const y of [down, up]) {
          if (y === undefined) continue;
          const cost = horizontal + Math.abs(y - by);
          if (!best || cost < best.cost) best = { x, y, z, cost };
        }
      }
    }
    // Anything in a later ring costs at least r + 1.
    if (best && best.cost <= r + 1) break;
  }
  return best ? blockAt(dimension, best.x, best.y, best.z) : undefined;
}

// NEW: void deaths (below the bottom of the world). There is nothing under you, so the grave goes
// on the closest ground found along a RANDOM direction: in the End that means end stone, in other
// dimensions any ground. 16 headings are scanned outward from the death spot; every heading that
// reaches ground counts, and one of them is picked at random. Only loaded chunks can be searched.
function findVoidSpot(dimension, at) {
  const { min, max } = dimension.heightRange;
  const inEnd = dimension.id.includes("the_end");
  const accept = (b) => !inEnd || b.typeId === "minecraft:end_stone";
  const HEADINGS = 16;
  const STEP = 4;
  const turn = Math.random() * 2 * Math.PI;
  const found = [];
  for (let h = 0; h < HEADINGS; h++) {
    const angle = turn + (h * 2 * Math.PI) / HEADINGS;
    for (let d = 0; d <= CONFIG.voidSearchRadius; d += STEP) {
      const x = Math.floor(at.x + Math.cos(angle) * d);
      const z = Math.floor(at.z + Math.sin(angle) * d);
      let hit;
      try {
        hit = dimension.getBlockFromRay(
          { x: x + 0.5, y: max - 1.5, z: z + 0.5 },
          { x: 0, y: -1, z: 0 },
          { includeLiquidBlocks: false, includePassableBlocks: false, maxDistance: max - min },
        );
      } catch (e) {
        continue; // unloaded chunk
      }
      try {
        if (!hit || !accept(hit.block)) continue;
        const cell = blockAt(dimension, x, hit.block.location.y + 1, z);
        if (cell && canHold(cell)) {
          found.push(cell);
          break; // closest ground along this heading
        }
      } catch (e) {
        continue; // that chunk is loaded but not ticking: not usable
      }
    }
  }
  return found.length ? found[Math.floor(Math.random() * found.length)] : undefined;
}

// NEW: void death and no ground anywhere in reach: build a small end-stone island from the
// structure file right where the player died, and put the grave on top of it.
function buildVoidIsland(dimension, at) {
  const { min, max } = dimension.heightRange;
  const baseY = Math.min(Math.max(CONFIG.voidIslandLevel, min), max - VOID_ISLAND.height - 2);
  const cx = Math.floor(at.x);
  const cz = Math.floor(at.z);
  try {
    world.structureManager.place(VOID_ISLAND_ID, dimension, {
      x: cx - VOID_ISLAND.centre,
      y: baseY,
      z: cz - VOID_ISLAND.centre,
    });
  } catch (e) {
    console.warn(`[ae_sg] could not build the void island: ${e}`);
    return undefined;
  }
  return blockAt(dimension, cx, baseY + VOID_ISLAND.height, cz);
}

// NEW: always try hard to find somewhere. 0) void death: ground in a random direction, 1) real ground nearby, 2) any free cell in the death
// column (the old behaviour; may float or sit in lava), 3) the same in the 8 neighbouring columns.
function findGraveSpot(dimension, at) {
  if (at.y < dimension.heightRange.min) {
    let voidSpot;
    try {
      voidSpot = findVoidSpot(dimension, at);
    } catch (e) {
      console.warn(`[ae_sg] void search failed: ${e}`);
    }
    voidSpot ??= buildVoidIsland(dimension, at); // nothing usable found: make our own island
    if (voidSpot) return voidSpot;
  }
  const ground = findGround(dimension, at);
  if (ground) return ground;
  const { min, max } = dimension.heightRange;
  const y = Math.min(Math.max(Math.floor(at.y), min + 1), max - 2);
  const free = (b) => b.isAir || b.isLiquid;
  for (let r = 0; r <= 1; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const spot = findSpace(
          dimension,
          { x: Math.floor(at.x) + dx, y, z: Math.floor(at.z) + dz },
          SEARCH_RANGE,
          free,
        );
        if (spot) return spot;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- retrieving a gravestone
// Returns true when the stored items were handed back (the caller then removes the block).
function giveInv(graveBlock, player) {
  const dimension = player.dimension;
  const name = graveKey(graveBlock.dimension, graveBlock.location);
  const propKey = graveBlock.dimension.id + "." + name;

  const where = whereOf(player);
  const hotbar = load(name + ".1", where);
  hotbar.splice(HOTBAR_SIZE, hotbar.length);
  const main = load(name + ".2", where);
  const worn = load(name + ".3", where);

  const container = player.getComponent(EntityInventoryComponent.componentId)?.container;
  const equippable = player.getComponent(EntityEquippableComponent.componentId);
  if (!container || !equippable) return false;

  // Everything is in memory now: drop the stored copies.
  save(name + ".1");
  save(name + ".2");
  save(name + ".3");

  const xp = world.getDynamicProperty(propKey);
  if (xp) player.runCommand(`xp ${xp} @s`);
  world.setDynamicProperty(propKey, undefined);
  world.setDynamicProperty(propKey + ".name", undefined); // FIX: name property was never cleaned up
  world.setDynamicProperty(propKey + ".owner", undefined);

  const inventory = [...hotbar, ...main];
  for (let i = 0; i < inventory.length; i++) {
    if (!inventory[i]) continue;
    try {
      const displaced = container.getItem(i);
      container.setItem(i, inventory[i]);
      if (displaced) spawnItem(displaced, dimension, player.location);
    } catch (e) {
      spawnItem(inventory[i], dimension, player.location); // FIX: never lose a stack
    }
  }
  for (let i = 0; i < worn.length && i < equippableIndex.length; i++) {
    if (!worn[i]) continue;
    try {
      const slot = equippable.getEquipmentSlot(equippableIndex[i]);
      const displaced = slot.getItem();
      slot.setItem(worn[i]);
      if (displaced) spawnItem(displaced, dimension, player.location);
    } catch (e) {
      spawnItem(worn[i], dimension, player.location);
    }
  }
  return true;
}

function removeGrave(block) {
  const { x, y, z } = block.location;
  removeBase(block.dimension, block.location);
  block.dimension.runCommand(`setblock ${x} ${y} ${z} air destroy`);
}

function claimGrave(block, player) {
  if (block.permutation.getState("ae_sg:player_placed")) return; // decorative, player-placed
  const propKey = propKeyFor(block.dimension, block.location);
  if (!canOpen(propKey, player)) {
    notifyLocked(propKey, player);
    return;
  }
  const ownerId = world.getDynamicProperty(propKey + ".owner");
  try {
    if (giveInv(block, player)) {
      removeGrave(block);
      forgetGrave(ownerId, block.dimension.id, block.location);
    }
  } catch (e) {
    console.warn(`[ae_sg] could not open gravestone at ${block.location.x} ${block.location.y} ${block.location.z}: ${e}`);
  }
}

// ---------------------------------------------------------------- registration
system.beforeEvents.startup.subscribe((startup) => {
  startup.blockComponentRegistry.registerCustomComponent("ae_sg:gravestone", {
    beforeOnPlayerPlace: (event) => {
      if (!event.player) return;
      event.permutationToPlace = event.permutationToPlace.withState("ae_sg:player_placed", true);
    },
    onPlayerInteract: (event) => {
      if (!event.player) return;
      claimGrave(event.block, event.player);
    },
    onBreak: (event) => {
      // Only the wither can break a gravestone; put it back.
      if (event.entitySource?.typeId !== "minecraft:wither") return;
      event.block.setPermutation(event.brokenBlockPermutation);
    },
  });

  startup.customCommandRegistry.registerCommand(
    {
      name: "ae_sg:toggle",
      description: "Toggles the gravestone system on or off.",
      cheatsRequired: false,
      permissionLevel: CommandPermissionLevel.GameDirectors,
    },
    () => {
      const wasEnabled = enabled;
      enabled = !enabled;
      system.run(() => world.setDynamicProperty(DISABLED_PROP, wasEnabled));
      return {
        status: CustomCommandStatus.Success,
        message: (wasEnabled ? "Disabled" : "Enabled") + " gravestones",
      };
    },
  );

  // NEW: /ae_sg:casket open|closed
  try {
    startup.customCommandRegistry.registerEnum("ae_sg:casket_mode", ["open", "closed"]);
    startup.customCommandRegistry.registerCommand(
      {
        name: "ae_sg:casket",
        description: "Open casket: anyone can loot gravestones. Closed casket: only the owner can.",
        cheatsRequired: false,
        permissionLevel: CommandPermissionLevel.GameDirectors,
        mandatoryParameters: [{ name: "ae_sg:casket_mode", type: CustomCommandParamType.Enum }],
      },
      (origin, mode) => {
        const chosen = mode === "closed" ? "closed" : "open";
        system.run(() => world.setDynamicProperty(CASKET_PROP, chosen));
        return {
          status: CustomCommandStatus.Success,
          message: chosen === "closed" ? "Closed casket: only owners can open their gravestones" : "Open casket: anyone can open any gravestone",
        };
      },
    );
  } catch (e) {
    console.warn(`[ae_sg] could not register /ae_sg:casket (set CONFIG.casket in the script instead): ${e}`);
  }
});

// Left-clicking (mining swing) a death gravestone from up to 7 blocks away collects it.
world.afterEvents.playerSwingStart.subscribe((event) => {
  if (event.swingSource !== EntitySwingSource.Mine) return;
  const block = event.player.getBlockFromViewDirection({
    includePassableBlocks: true,
    includeLiquidBlocks: false,
    maxDistance: 7,
  })?.block;
  if (block?.typeId !== GRAVESTONE_ID) return;
  claimGrave(block, event.player);
});

// Gravestones are immune to explosions.
world.beforeEvents.explosion.subscribe((event) => {
  event.setImpactedBlocks(event.getImpactedBlocks().filter((b) => b.typeId !== GRAVESTONE_ID));
});

// ---------------------------------------------------------------- death
world.afterEvents.entityDie.subscribe((event) => {
  if (!enabled) return;
  const player = event.deadEntity;
  if (!(player instanceof Player)) return;
  try {
    handleDeath(player);
  } catch (e) {
    console.warn(`[ae_sg] gravestone failed for ${player.name}: ${e}`);
  }
});

function dropEverything(container, equippable, dimension, at) {
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (!item) continue;
    spawnItem(item, dimension, at);
    container.setItem(i, undefined);
  }
  for (const slotId of equippableIndex) {
    const slot = equippable.getEquipmentSlot(slotId);
    const item = slot.getItem();
    if (!item) continue;
    spawnItem(item, dimension, at);
    slot.setItem(undefined);
  }
}

// NEW: no gravestone possible. Drop the player's XP as orbs (or let them keep it).
function releaseXp(player, dimension, at) {
  const total = player.getTotalXp();
  if (CONFIG.xpFallback === "keep" || total < 1) return;
  player.runCommand(`xp -${player.level + 1}l @s`);
  const orbs = Math.min(Math.ceil(total / CONFIG.xpPerOrb), CONFIG.maxXpOrbs);
  for (let i = 0; i < orbs; i++) dimension.spawnEntity("minecraft:xp_orb", at);
}

// ---------------------------------------------------------------- inventory snapshots (NEW 1.3.0)
// keepInventory is a cheat rule, so it is never touched. Every player's inventory, armour and XP
// is remembered while they play (every tick while in danger) and the grave is built from that copy.
const snapshots = new Map();

function readSlots(player) {
  const container = player.getComponent(EntityInventoryComponent.componentId)?.container;
  const equippable = player.getComponent(EntityEquippableComponent.componentId);
  if (!container || !equippable) return undefined;
  const hotbar = [];
  const main = [];
  const worn = [];
  for (let i = 0; i < container.size; i++) (i < HOTBAR_SIZE ? hotbar : main).push(container.getItem(i));
  for (const slotId of equippableIndex) worn.push(equippable.getEquipmentSlot(slotId).getItem());
  return { container, equippable, hotbar, main, worn };
}

function takeSnapshot(player) {
  const health = player.getComponent("minecraft:health");
  if (health && health.currentValue <= 0) return; // already dead: keep the last good copy
  const slots = readSlots(player);
  if (!slots) return;
  snapshots.set(player.id, {
    tick: system.currentTick,
    hotbar: slots.hotbar,
    main: slots.main,
    worn: slots.worn,
    xp: player.getTotalXp(),
  });
}

function inDanger(player) {
  const health = player.getComponent("minecraft:health");
  return (
    player.location.y < player.dimension.heightRange.min + 8 ||
    (health && health.currentValue <= CONFIG.riskHealth)
  );
}

const lastSnap = new Map();
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    try {
      const every = inDanger(player) ? CONFIG.riskSnapshotTicks : CONFIG.snapshotTicks;
      if (system.currentTick - (lastSnap.get(player.id) ?? -1e9) < every) continue;
      lastSnap.set(player.id, system.currentTick);
      takeSnapshot(player);
    } catch (e) {
      /* player is loading / changing dimension */
    }
  }
}, 1);

world.afterEvents.playerLeave.subscribe((event) => {
  snapshots.delete(event.playerId);
  lastSnap.delete(event.playerId);
});

// The game has already dropped the player's items. Pick those up again (only as many of each
// type as the snapshot says the player owned) so the grave does not duplicate them.
function sweepDrops(dimension, at, snap) {
  const needed = new Map();
  for (const item of [...snap.hotbar, ...snap.main, ...snap.worn]) {
    if (item) needed.set(item.typeId, (needed.get(item.typeId) ?? 0) + item.amount);
  }
  const near = { location: at, maxDistance: CONFIG.dropRadius };
  for (const entity of dimension.getEntities({ ...near, type: "minecraft:item" })) {
    try {
      const stack = entity.getComponent("minecraft:item")?.itemStack;
      const left = stack ? needed.get(stack.typeId) : undefined;
      if (!stack || left === undefined || left < stack.amount) continue;
      needed.set(stack.typeId, left - stack.amount);
      entity.remove();
    } catch (e) {
      /* entity already gone */
    }
  }
  if (snap.xp > 0) {
    for (const orb of dimension.getEntities({ location: at, maxDistance: CONFIG.xpOrbRadius, type: "minecraft:xp_orb" })) {
      try { orb.remove(); } catch (e) { /* already gone */ }
    }
  }
}

function handleDeath(player) {
  const dimension = player.dimension;
  const deathLocation = player.location;
  const where = whereOf(player);
  const playerId = player.id;
  const playerName = player.name;

  const live = readSlots(player);
  if (!live) return;
  const liveHasItems = [...live.hotbar, ...live.main, ...live.worn].some((item) => item !== undefined);

  // Legacy path: something (e.g. a keepInventory world) left the items on the player. Otherwise
  // the game has already dropped them and we rebuild the inventory from the snapshot.
  let hotbar, main, worn, xp, fromSnapshot = false, snap;
  if (liveHasItems) {
    ({ hotbar, main, worn } = live);
    xp = player.getTotalXp();
  } else {
    snap = snapshots.get(playerId);
    if (!snap || system.currentTick - snap.tick > CONFIG.maxSnapshotAge) {
      console.warn(`[ae_sg] no recent inventory copy for ${playerName}; nothing to put in a grave`);
      return;
    }
    ({ hotbar, main, worn, xp } = snap);
    fromSnapshot = true;
  }
  snapshots.delete(playerId);

  const hasItems = [...hotbar, ...main, ...worn].some((item) => item !== undefined);
  if (!hasItems && xp < 1) return;

  let spot;
  try {
    spot = findGraveSpot(dimension, deathLocation);
  } catch (e) {
    console.warn(`[ae_sg] grave search failed for ${playerName}: ${e}`);
    // A failed search must not turn into lost items: in the void, build the island instead.
    if (deathLocation.y < dimension.heightRange.min) spot = buildVoidIsland(dimension, deathLocation);
  }
  if (!spot) {
    // Really nowhere to put a gravestone. With a snapshot the game's own drops stay where they are.
    if (!fromSnapshot) {
      dropEverything(live.container, live.equippable, dimension, deathLocation);
      releaseXp(player, dimension, deathLocation);
    }
    return;
  }

  const center = spot.center();
  player.sendMessage({
    translate: "ae_sg.died",
    with: ["" + center.x, "" + (center.y - 0.5), "" + center.z],
  });

  const name = graveKey(dimension, spot.location);
  const propKey = dimension.id + "." + name;
  let floorId;
  try { floorId = spot.below()?.typeId; } catch (e) { /* unloaded */ }
  try {
    let permutation;
    try {
      permutation = BlockPermutation.resolve(GRAVESTONE_ID, platformStates(dimension, floorId));
    } catch (e) {
      // The textured base needs the block states of this add-on's block file; never lose a grave over it.
      console.warn(`[ae_sg] could not pick a base for the gravestone, using the default: ${e}`);
      permutation = BlockPermutation.resolve(GRAVESTONE_ID);
    }
    spot.setPermutation(permutation);
    world.setDynamicProperty(propKey, xp);
    world.setDynamicProperty(propKey + ".name", playerName);
    world.setDynamicProperty(propKey + ".owner", playerId);
    save(name + ".1", hotbar, where);
    save(name + ".2", main, where);
    save(name + ".3", worn, where);
    rememberGrave(playerId, dimension, spot.location);
    spawnBase(dimension, spot, floorId);
  } catch (e) {
    // The items are never lost on failure: they are dropped at the death spot instead.
    console.warn(`[ae_sg] gravestone save failed, dropping items instead: ${e}`);
    if (!fromSnapshot) {
      for (const item of [...hotbar, ...main, ...worn]) if (item) spawnItem(item, dimension, deathLocation);
    }
    if (spot.permutation.matches(GRAVESTONE_ID)) spot.setType("minecraft:air");
    removeBase(dimension, spot.location);
    for (const suffix of [".1", ".2", ".3"]) {
      try { save(name + suffix); } catch (_) { /* nothing to delete */ }
    }
    world.setDynamicProperty(propKey, undefined);
    world.setDynamicProperty(propKey + ".name", undefined);
    world.setDynamicProperty(propKey + ".owner", undefined);
    forgetGrave(playerId, dimension.id, spot.location);
    return;
  }

  if (fromSnapshot) {
    // Wait for the game to spawn the dropped items, then collect them back out of the world.
    system.runTimeout(() => {
      try { sweepDrops(dimension, deathLocation, snap); } catch (e) { console.warn(`[ae_sg] sweep failed: ${e}`); }
    }, CONFIG.dropWaitTicks);
  } else {
    // Legacy path: clear the live inventory and XP, they now live in the grave.
    for (let i = 0; i < live.container.size; i++) live.container.setItem(i, undefined);
    for (const slotId of equippableIndex) live.equippable.getEquipmentSlot(slotId).setItem(undefined);
    player.runCommand(`xp -${player.level + 1}l @s`);
  }
}

// ---------------------------------------------------------------- Grave Finder (NEW)
const DIMENSION_NAMES = {
  "minecraft:overworld": "the Overworld",
  "minecraft:nether": "the Nether",
  "minecraft:the_end": "the End",
};
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const RELATIVE = ["ahead", "ahead-right", "right", "behind-right", "behind", "behind-left", "left", "ahead-left"];

// NEW 1.3.0: the held Grave Finder is swapped between 16 needle pictures (ae_sg:grave_finder_0..15),
// so the icon points at the grave like a recovery compass. Item icons cannot change by themselves.
const FINDER_STEPS = 16;
const isFinder = (id) => id === FINDER_ID || (id?.startsWith(FINDER_ID + "_") ?? false);

function setFinderType(container, slot, item, wanted) {
  if (item.typeId === wanted) return;
  const next = new ItemStack(wanted, 1);
  if (item.nameTag) next.nameTag = item.nameTag;
  container.setItem(slot, next);
}

// Newest grave in the player's current dimension (stale entries are cleaned up as we go).
function nearestTarget(player) {
  const list = readGraves(player.id);
  const keep = [];
  for (const g of list) {
    if (g.d === player.dimension.id) {
      const block = blockAt(player.dimension, g.x, g.y, g.z);
      if (block && block.typeId !== GRAVESTONE_ID) continue; // loaded and gone: forget it
    }
    keep.push(g);
  }
  if (keep.length !== list.length) writeGraves(player.id, keep);
  const here = keep.filter((g) => g.d === player.dimension.id);
  return { here: here[here.length - 1], elsewhere: keep[keep.length - 1] };
}

// Needle step 0..15 (0 = straight ahead, clockwise), or undefined when there is nothing to point at.
function finderStep(player) {
  const { here } = nearestTarget(player);
  if (!here) return undefined;
  const dx = here.x + 0.5 - player.location.x;
  const dz = here.z + 0.5 - player.location.z;
  const dy = here.y - Math.floor(player.location.y);
  if (Math.hypot(dx, dz) < 3 && Math.abs(dy) < 3) return undefined;
  const deg = (rad) => ((rad * 180) / Math.PI + 360) % 360;
  const view = player.getViewDirection();
  const relative = (deg(Math.atan2(dx, -dz)) - deg(Math.atan2(view.x, -view.z)) + 360) % 360;
  return Math.round(relative / (360 / FINDER_STEPS)) % FINDER_STEPS;
}

function finderText(player) {
  const { here } = nearestTarget(player);
  if (!here) return undefined; // nothing to point at: the plain item spins, no text
  const dx = here.x + 0.5 - player.location.x;
  const dz = here.z + 0.5 - player.location.z;
  const dy = here.y - Math.floor(player.location.y);
  const flat = Math.hypot(dx, dz);
  if (flat < 3 && Math.abs(dy) < 3) return "§bGrave Finder§r: you are at your grave";
  const deg = (rad) => ((rad * 180) / Math.PI + 360) % 360;
  const bearing = deg(Math.atan2(dx, -dz)); // 0 = north (-z), 90 = east (+x)
  const view = player.getViewDirection();
  const facing = deg(Math.atan2(view.x, -view.z));
  const relative = (bearing - facing + 360) % 360;
  const side = RELATIVE[Math.round(relative / 45) % 8];
  const compass = CARDINALS[Math.round(bearing / 45) % 8];
  const height = Math.abs(dy) < 3 ? "" : dy > 0 ? `, ${dy} above` : `, ${-dy} below`;
  return `§bGrave Finder§r: ${Math.round(flat)} blocks ${side} (${compass})${height}`;
}

const lastSlot = new Map();
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    try {
      const container = player.getComponent(EntityInventoryComponent.componentId)?.container;
      if (!container) continue;
      const slot = player.selectedSlotIndex;
      const prev = lastSlot.get(player.id);
      lastSlot.set(player.id, slot);
      if (prev !== undefined && prev !== slot) {        // put the finder you stopped holding back to normal
        const old = container.getItem(prev);
        if (old && old.typeId !== FINDER_ID && isFinder(old.typeId)) setFinderType(container, prev, old, FINDER_ID);
      }
      const item = container.getItem(slot);
      if (!item || !isFinder(item.typeId)) continue;
      const text = finderText(player);
      if (text) player.onScreenDisplay.setActionBar(text);
      const step = finderStep(player);
      let wanted = step === undefined ? FINDER_ID : `${FINDER_ID}_${step}`;
      if (step === undefined) {
        // No grave in this dimension: a spinning icon shows which dimension it is in.
        const { here, elsewhere } = nearestTarget(player);
        if (!here && elsewhere?.d === "minecraft:the_end") wanted = FINDER_ID + "_end";
        else if (!here && elsewhere?.d === "minecraft:nether") wanted = FINDER_ID + "_nether";
      }
      setFinderType(container, slot, item, wanted);
    } catch (e) {
      /* player is loading / changing dimension */
    }
  }
}, CONFIG.finderTicks);

// Using the item prints the exact coordinates in chat.
world.afterEvents.itemUse.subscribe((event) => {
  if (!isFinder(event.itemStack?.typeId)) return;
  const player = event.source;
  const { here, elsewhere } = nearestTarget(player);
  const g = here ?? elsewhere;
  if (!g) {
    player.sendMessage("§3<Simple Gravestone> §eNo grave to find.");
    return;
  }
  player.sendMessage(
    `§3<Simple Gravestone> §eYour grave: §b${g.x}, ${g.y}, ${g.z}§e in ${DIMENSION_NAMES[g.d] ?? g.d}.`,
  );
});

// ---------------------------------------------------------------------------------------------
// HOOK for patch add-ons (1.5.0): a base of their own for graves on their blocks.
// A patch add-on (which knows both this add-on and the mod that owns the blocks) ships a small entity
// with its own model/texture for the thin base plate (16 x 1 x 16 at the bottom of the grave block),
// and registers its blocks with a script event:
//   system.sendScriptEvent("ae_sg:register", JSON.stringify({
//     owner: "my_patch", entity: "my_patch:grave_base", blocks: ["mymod:my_block"] }));
// (also testable in chat:  /scriptevent ae_sg:register {"entity":"my_patch:grave_base","blocks":["mymod:my_block"]} )
// When a grave is placed on a registered block, the built-in base is made invisible and the entity is
// spawned at the centre of the grave block's floor (tag "ae_sg_base"). It is removed when the grave is opened.
// Registrations are kept in memory only: send again on every world load and whenever "ae_sg:ready" arrives.
// The entity should be immobile, immune to damage, persistent and without collision (see the project docs).
const BASE_ENTITIES = new Map(); // floor block id -> entity type id
const BASE_OWNERS = new Map();   // floor block id -> owner
const BASE_TAG = "ae_sg_base";

function registerBaseEntity(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (e) { console.warn(`[ae_sg] register: message is not valid JSON: ${e}`); return; }
  const entity = data?.entity;
  const blocks = data?.blocks;
  if (typeof entity !== "string" || !entity.includes(":")) {
    console.warn('[ae_sg] register: "entity" must be a full entity id such as "my_patch:grave_base"');
    return;
  }
  if (!Array.isArray(blocks) || blocks.some((b) => typeof b !== "string" || !b.includes(":"))) {
    console.warn('[ae_sg] register: "blocks" must be a list of full block ids such as "mymod:my_block"');
    return;
  }
  const owner = typeof data.owner === "string" ? data.owner : entity.split(":")[0];
  let added = 0;
  for (const id of blocks) {
    const claimed = BASE_OWNERS.get(id);
    if (claimed !== undefined && claimed !== owner) {
      console.warn(`[ae_sg] register: ${id} is already handled by "${claimed}", "${owner}" was refused for it`);
      continue;
    }
    BASE_OWNERS.set(id, owner);
    BASE_ENTITIES.set(id, entity);
    added++;
  }
  console.warn(`[ae_sg] register: "${owner}" added ${added} block(s) using ${entity}`);
}

function spawnBase(dimension, spot, floorTypeId) {
  const entityId = BASE_ENTITIES.get(floorTypeId);
  if (entityId === undefined) return;
  try {
    const e = dimension.spawnEntity(entityId, { x: spot.location.x + 0.5, y: spot.location.y, z: spot.location.z + 0.5 });
    e.addTag(BASE_TAG);
  } catch (e) {
    console.warn(`[ae_sg] could not spawn the base ${entityId}: ${e}`);
  }
}

function removeBase(dimension, location) {
  try {
    for (const e of dimension.getEntities({
      tags: [BASE_TAG],
      location: { x: location.x + 0.5, y: location.y + 0.2, z: location.z + 0.5 },
      maxDistance: 1,
    })) e.remove();
  } catch (e) { /* unloaded chunk or nothing there */ }
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id === "ae_sg:register") registerBaseEntity(event.message);
});

// Tell add-ons we are listening (they may have started before us).
system.runTimeout(() => {
  try { system.sendScriptEvent("ae_sg:ready", "1"); } catch (e) { console.warn(`[ae_sg] could not announce ready: ${e}`); }
}, 20);

export { findSpace, CONFIG, FLOOR_SLOT, platformStates, registerBaseEntity, BASE_ENTITIES };
