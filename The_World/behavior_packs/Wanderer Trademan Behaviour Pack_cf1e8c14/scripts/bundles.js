// ============================================================================
// WANDERER TRADEMAN - bundle definitions (edit this file to add/change bundles)
// ============================================================================
// Bundle capacity is 64 "weight". Each item weighs 64 / (its max stack size):
//   stacks to 64 -> 1 each | stacks to 16 -> 4 each | does NOT stack -> 64 (fills the bundle alone)
// Anything that doesn't fit is skipped (and reported in chat while DEBUG is on).
//
// Content entries (the "contents" array):
//   ["minecraft:poppy", 1]                         fixed item, count
//   { id, n, chance: 0.25 }                        included only 25% of the time
//   { pick: 3, from: [id | [id, n], ...] }         random distinct picks (pick may be [min, max])
//   { enchantedBook: [[enchantId, level], ...] }   one book with ONE random enchant from the list
// A bundle may instead use "variants": [{ weight, contents }, ...] to roll one of several contents.
//
// Trade slots (which group of the trader's table the bundle goes in):
//   slot: "nature" | "biome" | "builder" | "curio" | "collector"   (see SLOTS below)
//   color: bundle dye color, or null for the plain (undyed) bundle
//   nameColor: Minecraft color code for the name (e.g. "§a" neon green) - may differ from the bundle color
//   copies: how many times it is listed in its group (more copies = more likely to be picked)
// ============================================================================

// Shown on the bundle in the trade screen; the script treats it as "not filled yet".
export const SEAL = "§r§7§oSealed by the Wanderer";

// How many trades of each slot a trader offers (num_to_select).
export const SLOTS = {
  nature: 3,     // pick 3 of the 8 nature bundles
  biome: 3,      // pick 3 of the 9 biome bundles
  builder: 3,    // pick 3 of the 8 builder packs
  curio: 2,      // pick 2 of the 8 curios
  collector: 1,  // 49 satchels + 1 legendary = 2% chance for the legendary
};

const COLORS = ["white","orange","magenta","light_blue","yellow","lime","pink","gray","light_gray","cyan","purple","blue","brown","green","red","black"];
const terracotta = ["minecraft:hardened_clay", ...COLORS.map((c) => `minecraft:${c}_terracotta`)];

const SHERDS = ["angler","archer","arms_up","blade","brewer","burn","danger","explorer","flow","friend","guster","heart","heartbreak","howl","miner","mourner","plenty","prize","scrape","sheaf","shelter","skull","snort"]
  .map((s) => `minecraft:${s}_pottery_sherd`);
const TRIMS = ["sentry","dune","coast","wild","ward","eye","vex","tide","snout","rib","spire","wayfinder","shaper","silence","raiser","host","flow","bolt"]
  .map((s) => `minecraft:${s}_armor_trim_smithing_template`);
const DISCS = ["13","cat","blocks","chirp","far","mall","mellohi","stal","strad","ward","11","wait","pigstep","otherside","5","relic","creator","creator_music_box","precipice","lava_chicken","tears","bounce"]
  .map((s) => `minecraft:music_disc_${s}`);
const PATTERNS = ["creeper","skull","flower","mojang","globe","piglin","flow","guster"]
  .map((s) => `minecraft:${s}_banner_pattern`);


const cushion16 = COLORS.map((c) => `minecraft:${c}_cushion`);
const dye16 = COLORS.map((c) => `minecraft:${c}_dye`);
const glass16 = COLORS.map((c) => `minecraft:${c}_stained_glass`);
const concrete16 = COLORS.map((c) => `minecraft:${c}_concrete`);
const CANDLES = ["minecraft:candle", ...COLORS.map((c) => `minecraft:${c}_candle`)];
const SMALL_FLOWERS = ["dandelion","poppy","blue_orchid","allium","azure_bluet","red_tulip","orange_tulip","white_tulip","pink_tulip","oxeye_daisy","cornflower","lily_of_the_valley"]
  .map((f) => `minecraft:${f}`);
const PLANKS = ["oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak","poplar","bamboo","crimson","warped"].map((w) => `minecraft:${w}_planks`);
const COPPER = ["copper_block","exposed_copper","weathered_copper","oxidized_copper","cut_copper","exposed_cut_copper","weathered_cut_copper","oxidized_cut_copper",
                "waxed_copper","waxed_exposed_copper","waxed_weathered_copper","waxed_oxidized_copper","waxed_cut_copper","waxed_exposed_cut_copper","waxed_weathered_cut_copper","waxed_oxidized_cut_copper"]
  .map((c) => `minecraft:${c}`);

// Rainbow-lettered name: cycles color codes per letter.
const RAINBOW = ["§c","§6","§e","§a","§b","§9","§d"];
const rainbow = (text) => { let i = 0; return [...text].map((ch) => (/[A-Za-z]/.test(ch) ? RAINBOW[i++ % RAINBOW.length] + ch : ch)).join(""); };

export const BUNDLES = [
  {
    key: "wildflower", name: "Wildflower Bundle", color: "blue", nameColor: "§9", price: 4, maxUses: 3, slot: "nature", copies: 1,
    flavor: "Gathered from a meadow far away.",
    contents: [
      ["minecraft:dandelion", 1], ["minecraft:poppy", 1], ["minecraft:cornflower", 1], ["minecraft:oxeye_daisy", 1],
      ["minecraft:azure_bluet", 1], ["minecraft:allium", 1], ["minecraft:lily_of_the_valley", 1], ["minecraft:pink_petals", 4],
    ],
  },
  {
    key: "cherry_grove", name: "Cherry Grove Bundle", color: "pink", nameColor: "§d", price: 9, maxUses: 3, slot: "nature", copies: 1,
    flavor: "A keepsake from a blossoming grove.",
    // Empty bee nests stack to 64, so they weigh just 1 and fit fine. 5% chance for the bonus.
    contents: [["minecraft:cherry_sapling", 4], ["minecraft:pink_petals", 8], ["minecraft:moss_block", 8], { id: "minecraft:bee_nest", n: 1, chance: 0.05 }],
  },
  {
    key: "swamp_herbalist", name: "Swamp Herbalist Bundle", color: "green", nameColor: "§2", price: 7, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Damp, earthy, and faintly medicinal.",
    contents: [["minecraft:blue_orchid", 2], ["minecraft:waterlily", 8], ["minecraft:vine", 8], ["minecraft:slime_ball", 2], ["minecraft:clay_ball", 8], ["minecraft:sugar_cane", 4], ["minecraft:red_mushroom", 1], ["minecraft:brown_mushroom", 1]],
  },
  {
    key: "desert_curio", name: "Desert Curio Bundle", color: "yellow", nameColor: "§e", price: 8, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Dust and curiosities from the dunes.",
    contents: [
      ["minecraft:cactus", 8], ["minecraft:deadbush", 4], ["minecraft:sand", 16], ["minecraft:red_sand", 16],
      { pick: 1, from: SHERDS, chance: 0.3 },
    ],
  },
  {
    key: "ocean_explorer", name: "Ocean Explorer Bundle", color: "cyan", nameColor: "§3", price: 11, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Still smells faintly of the sea.",
    contents: [
      ["minecraft:sea_pickle", 4], ["minecraft:kelp", 16],
      ["minecraft:tube_coral_fan", 1], ["minecraft:brain_coral_fan", 1], ["minecraft:bubble_coral_fan", 1], ["minecraft:fire_coral_fan", 1], ["minecraft:horn_coral_fan", 1],
      ["minecraft:prismarine", 8],
      { id: "minecraft:nautilus_shell", n: 1, chance: 0.1 },
    ],
  },
  {
    key: "mesa_prospector", name: "Mesa Prospector Bundle", color: "orange", nameColor: "§c", price: 11, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Dust, old rails, and a glint of gold.",
    // Mesa: a little terracotta, plus what you find in its abandoned mineshafts and gold-rich hills.
    contents: [
      ["minecraft:red_sand", 8], { pick: 4, from: ["minecraft:hardened_clay", "minecraft:orange_terracotta", "minecraft:red_terracotta", "minecraft:yellow_terracotta", "minecraft:brown_terracotta", "minecraft:white_terracotta", "minecraft:light_gray_terracotta"] },
      ["minecraft:rail", 8], ["minecraft:golden_rail", 2], ["minecraft:oak_fence", 4], ["minecraft:torch", 4], ["minecraft:web", 2],
      ["minecraft:raw_gold", 3], ["minecraft:gold_nugget", 6], ["minecraft:deadbush", 2],
    ],
  },
  {
    key: "mangrove_swamp", name: "Mangrove Swamp Bundle", color: "red", nameColor: "§4", price: 8, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Roots, mud, and the hum of frogs.",
    contents: [
      ["minecraft:mangrove_propagule", 4], ["minecraft:mangrove_log", 4], ["minecraft:mangrove_roots", 4], ["minecraft:muddy_mangrove_roots", 4],
      ["minecraft:mud", 8], ["minecraft:packed_mud", 4], ["minecraft:vine", 4], ["minecraft:moss_carpet", 4], ["minecraft:waterlily", 4],
    ],
  },
  {
    key: "dappled_forest", name: "Dappled Forest Bundle", color: "brown", nameColor: "§6", price: 10, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Autumn, bottled.",
    contents: [
      ["minecraft:poplar_sapling", 3], ["minecraft:red_poplar_leaves", 4], ["minecraft:orange_poplar_leaves", 4], ["minecraft:yellow_poplar_leaves", 4],
      ["minecraft:poplar_log", 8], ["minecraft:shelf_mushroom", 3], ["minecraft:red_shrub", 3], ["minecraft:leaf_litter", 8], ["minecraft:coarse_dirt", 8], ["minecraft:brown_mushroom", 2],
    ],
  },
  {
    key: "seeds_of_the_world", name: "Seeds of the World Bundle", color: "lime", nameColor: "§a", price: 6, maxUses: 3, slot: "nature", copies: 1,
    flavor: "Everything you need for a fresh start.",
    contents: [
      ["minecraft:wheat_seeds", 1], ["minecraft:beetroot_seeds", 1], ["minecraft:carrot", 1], ["minecraft:potato", 1],
      ["minecraft:melon_seeds", 1], ["minecraft:pumpkin_seeds", 1], ["minecraft:torchflower_seeds", 1], ["minecraft:pitcher_pod", 1],
    ],
  },
  {
    key: "campsite", name: "Campsite Bundle", color: "green", nameColor: "§e", price: 9, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Everything for a night under the stars.",
    contents: [
      ["minecraft:campfire", 1], ["minecraft:torch", 4], ["minecraft:straw_bed", 3], { pick: 2, from: cushion16 }, ["minecraft:hay_block", 2],
      ["minecraft:cooked_beef", 2], ["minecraft:baked_potato", 2],
    ],
  },
  {
    key: "witchs_bundle", name: "Witch's Bag", color: "purple", nameColor: "§a", price: 10, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Smells of something brewing.",
    contents: [
      ["minecraft:spider_eye", 2], ["minecraft:nether_wart", 4], ["minecraft:glowstone_dust", 4], ["minecraft:redstone", 4],
      ["minecraft:sugar", 4], ["minecraft:gunpowder", 2], ["minecraft:glass_bottle", 3], ["minecraft:red_mushroom", 2], ["minecraft:brown_mushroom", 2],
    ],
  },
  {
    key: "cave_bundle", name: "Dripstone Cave Bundle", color: null, nameColor: "§i", price: 9, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Drip. Drip. Drip.",
    contents: [["minecraft:dripstone_block", 8], ["minecraft:pointed_dripstone", 8], ["minecraft:copper_ore", 3], ["minecraft:raw_copper", 6], ["minecraft:raw_copper_block", 1], ["minecraft:clay", 4]],
  },
  {
    key: "stone_masons_crate", name: "Stone Mason's Crate", color: "gray", nameColor: "§7", price: 4, maxUses: 3, slot: "builder", copies: 1,
    flavor: "Samples for the discerning builder.",
    // 12 each (not 16): five stacks of 16 would weigh 80 and not fit in a 64-weight bundle.
    contents: [["minecraft:andesite", 12], ["minecraft:diorite", 12], ["minecraft:granite", 12], ["minecraft:tuff", 12], ["minecraft:calcite", 12]],
  },
  {
    key: "terracotta_collection", name: "Terracotta Palette", color: "orange", nameColor: "§6", price: 4, maxUses: 3, slot: "builder", copies: 1,
    flavor: "Preview your palette before you build.",
    contents: terracotta.map((id) => [id, 1]),
  },
  {
    key: "archaeologists_satchel", name: "Archaeologist's Satchel", color: "brown", nameColor: "§n", price: 18, maxUses: 2, slot: "collector", copies: 49,
    flavor: "Artifacts from a dozen dig sites.",
    // Brush is left out: it does not stack, so it would fill the whole bundle on its own.
    contents: [
      { pick: [2, 3], from: SHERDS },
      ["minecraft:suspicious_sand", 2], ["minecraft:suspicious_gravel", 2],
      { id: "minecraft:emerald", n: 3 },
    ],
  },

  // ---- Nature ---------------------------------------------------------------
  {
    key: "arborists_sampler", name: "Arborist's Sampler", color: "lime", nameColor: "§2", price: 10, maxUses: 3, slot: "nature", copies: 1,
    flavor: "One of every tree worth planting.",
    contents: ["oak_sapling","spruce_sapling","birch_sapling","jungle_sapling","acacia_sapling","dark_oak_sapling","cherry_sapling","pale_oak_sapling","mangrove_propagule","azalea","flowering_azalea","poplar_sapling"].map((i) => [`minecraft:${i}`, 1]),
  },
  {
    key: "florists_delivery", name: "Florist's Delivery", color: "white", nameColor: "§d", price: 7, maxUses: 3, slot: "nature", copies: 1,
    flavor: "Tall blooms, wrapped with care.",
    contents: [["minecraft:sunflower", 2], ["minecraft:lilac", 2], ["minecraft:rose_bush", 2], ["minecraft:peony", 2], ["minecraft:pitcher_plant", 1], ["minecraft:torchflower", 2], ["minecraft:spore_blossom", 1]],
  },
  {
    key: "lush_cave", name: "Lush Cave Bundle", color: "green", nameColor: "§a", price: 9, maxUses: 3, slot: "nature", copies: 1,
    flavor: "Still dripping with cave dew.",
    contents: [["minecraft:glow_berries", 8], ["minecraft:moss_block", 8], ["minecraft:spore_blossom", 2], ["minecraft:azalea", 2], ["minecraft:big_dripleaf", 2], ["minecraft:small_dripleaf_block", 2], ["minecraft:clay_ball", 8], ["minecraft:hanging_roots", 4]],
  },
  {
    key: "pale_garden", name: "Pale Garden Bundle", color: "light_gray", nameColor: "§7", price: 12, maxUses: 3, slot: "nature", copies: 1,
    flavor: "Quiet. Too quiet.",
    contents: [["minecraft:pale_moss_block", 8], ["minecraft:pale_moss_carpet", 8], ["minecraft:pale_hanging_moss", 4], ["minecraft:pale_oak_sapling", 2], ["minecraft:open_eyeblossom", 1], ["minecraft:closed_eyeblossom", 1]],
  },
  {
    key: "jungle_expedition", name: "Jungle Expedition", color: "green", nameColor: "§6", price: 8, maxUses: 3, slot: "nature", copies: 1,
    flavor: "Humid, loud, and full of life.",
    contents: [["minecraft:cocoa_beans", 4], ["minecraft:bamboo", 8], ["minecraft:melon_seeds", 2], ["minecraft:melon_slice", 4], ["minecraft:vine", 4], ["minecraft:jungle_sapling", 2]],
  },
  {
    key: "frostbound", name: "Frostbound Bundle", color: "white", nameColor: "§b", price: 9, maxUses: 3, slot: "biome", copies: 1,
    flavor: "Cold to the touch.",
    contents: [["minecraft:ice", 8], ["minecraft:packed_ice", 4], ["minecraft:blue_ice", 2], ["minecraft:snowball", 4], ["minecraft:sweet_berries", 4], ["minecraft:spruce_sapling", 2]],
  },
  {
    key: "mushroom_isle", name: "Mushroom Isle Bundle", color: "brown", nameColor: "§c", price: 8, maxUses: 3, slot: "biome", copies: 1,
    flavor: "From an island with no neighbors.",
    contents: [["minecraft:red_mushroom", 4], ["minecraft:brown_mushroom", 4], ["minecraft:mycelium", 8], ["minecraft:mushroom_stem", 4], ["minecraft:red_mushroom_block", 4], ["minecraft:brown_mushroom_block", 4]],
  },

  // ---- Builder --------------------------------------------------------------
  {
    key: "dyers_palette", name: "Dyer's Pot", color: "white", nameColor: "", rainbow: true, price: 8, maxUses: 3, slot: "builder", copies: 1,
    flavor: "Every color the Wanderer could find.",
    contents: dye16.map((id) => [id, 1]),
  },
  {
    key: "glass_gallery", name: "Glass Gallery", color: "light_blue", nameColor: "§b", price: 5, maxUses: 3, slot: "builder", copies: 1,
    flavor: "Sixteen shades of see-through.",
    contents: [["minecraft:glass", 2], ...glass16.map((id) => [id, 2])],
  },
  {
    key: "concrete_palette", name: "Concrete Mix", color: "light_gray", nameColor: "§f", price: 5, maxUses: 3, slot: "builder", copies: 1,
    flavor: "Sharp, modern, and a little cold.",
    contents: concrete16.map((id) => [id, 2]),
  },
  {
    key: "wood_sampler", name: "Wood Sampler", color: null, nameColor: "§6", price: 5, maxUses: 3, slot: "builder", copies: 1,
    flavor: "Planks from every forest he has crossed.",
    contents: PLANKS.map((id) => [id, 4]),
  },
  {
    key: "copper_collection", name: "Copper Collection", color: "orange", nameColor: "§n", price: 8, maxUses: 3, slot: "builder", copies: 1,
    flavor: "Fresh to fully weathered.",
    contents: COPPER.map((id) => [id, 2]),
  },
  {
    key: "lamplighter", name: "Lamplighter's Satchel", color: "yellow", nameColor: "§f", price: 10, maxUses: 3, slot: "builder", copies: 1,
    flavor: "For those who hate the dark.",
    contents: [["minecraft:lantern", 4], ["minecraft:soul_lantern", 2], ["minecraft:sea_lantern", 2], ["minecraft:shroomlight", 2], { pick: 4, from: CANDLES }],
  },

  // ---- Curios (dimensions & flavor) ----------------------------------------
  {
    key: "nether_tourist", name: "Nether Tourist Bundle", color: "red", nameColor: "§c", price: 12, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Souvenirs from somewhere warm.",
    contents: [["minecraft:crimson_fungus", 2], ["minecraft:warped_fungus", 2], ["minecraft:weeping_vines", 4], ["minecraft:twisting_vines", 4], ["minecraft:shroomlight", 2], ["minecraft:glowstone", 4], ["minecraft:basalt", 8], ["minecraft:blackstone", 8]],
  },
  {
    key: "end_souvenir", name: "End Souvenir Bundle", color: "black", nameColor: "§d", price: 13, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Don't ask how he got there.",
    contents: [["minecraft:chorus_fruit", 4], ["minecraft:end_stone", 8], ["minecraft:purpur_block", 8], ["minecraft:end_rod", 4], ["minecraft:chorus_flower", 1]],
  },
  {
    key: "sculk_sampler", name: "Sculk Sampler", color: "cyan", nameColor: "§b", price: 15, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Please keep it quiet.",
    contents: [["minecraft:sculk", 8], ["minecraft:sculk_vein", 8], ["minecraft:sculk_sensor", 1], ["minecraft:sculk_catalyst", 1]],
  },
  {
    key: "beekeepers", name: "Beekeeper's Bundle", color: "yellow", nameColor: "§6", price: 12, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Sweet, sticky, and mostly buzz-free.",
    contents: [["minecraft:honeycomb", 8], ["minecraft:honey_bottle", 2], ["minecraft:beehive", 1], ["minecraft:campfire", 1], { pick: 3, from: SMALL_FLOWERS }, { pick: 2, from: CANDLES },
               { id: "minecraft:bee_nest", n: 1, chance: 0.1 }],
  },
  {
    key: "picnic_basket", name: "Picnic Basket", color: "white", nameColor: "§e", price: 6, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Packed with love, mostly.",
    contents: [["minecraft:bread", 4], ["minecraft:apple", 4], ["minecraft:cookie", 8], ["minecraft:melon_slice", 4], ["minecraft:pumpkin_pie", 2], ["minecraft:sweet_berries", 4]],
  },
  {
    key: "spooky_season", name: "Spooky Season Bundle", color: "orange", nameColor: "§5", price: 10, maxUses: 3, slot: "curio", copies: 1,
    flavor: "Boo.",
    contents: [["minecraft:pumpkin", 4], ["minecraft:carved_pumpkin", 2], ["minecraft:lit_pumpkin", 2], ["minecraft:soul_lantern", 2], ["minecraft:web", 4], ["minecraft:bone", 4], ["minecraft:rotten_flesh", 2], ["minecraft:spider_eye", 1]],
  },
  {
    key: "travelers_treasure", name: "Traveler's Treasure Pack", color: "black", nameColor: "§6", price: 27, maxUses: 1, slot: "collector", copies: 1,
    flavor: "The finest things the Wanderer ever found.",
    // Music discs, banner patterns and enchanted books do not stack, so each one is a bundle on its own.
    variants: [
      { weight: 55, contents: [{ pick: 5, from: [...TRIMS, "minecraft:skeleton_skull", "minecraft:zombie_head", "minecraft:creeper_head", "minecraft:piglin_head",
                                                  "minecraft:cherry_sapling", "minecraft:pale_oak_sapling", "minecraft:flowering_azalea", "minecraft:mangrove_propagule", "minecraft:poplar_sapling"] }] },
      { weight: 15, contents: [{ pick: 1, from: DISCS }] },
      { weight: 15, contents: [{ pick: 1, from: PATTERNS }] },
      { weight: 15, contents: [{ enchantedBook: [["minecraft:mending", 1], ["minecraft:silk_touch", 1], ["minecraft:frost_walker", 2], ["minecraft:swift_sneak", 2],
                                                  ["minecraft:depth_strider", 3], ["minecraft:aqua_affinity", 1], ["minecraft:channeling", 1], ["minecraft:soul_speed", 2]] }] },
    ],
  },
];

// Full display name (color code + name). Used for the trade and to recognise purchased bundles.
for (const b of BUNDLES) b.title = b.rainbow ? rainbow(b.name) : b.nameColor + b.name;

// Item id of a bundle (null color = plain bundle).
export const bundleItemId = (b) => (b.color ? `minecraft:${b.color}_bundle` : "minecraft:bundle");

// ---------------------------------------------------------------------------
// The one thing the Wanderer ALWAYS buys from players (offered on every trader).
// Must be easy to get and must not appear in any bundle (build_trades.mjs checks this).
// ---------------------------------------------------------------------------
export const BUY = { item: "minecraft:lapis_block", quantity: 1, emeralds: 2, maxUses: 8 };
