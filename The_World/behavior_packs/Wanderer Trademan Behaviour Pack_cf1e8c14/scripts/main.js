import { world, system, ItemStack, EnchantmentTypes } from "@minecraft/server";
import { BUNDLES, SEAL } from "./bundles.js";

// ---------------------------------------------------------------------------
// Wanderer Trademan - fills purchased bundles with their contents.
// (The trade table's fill_container crashes on bundles, so the script does it.)
// Bundle definitions live in bundles.js.
// ---------------------------------------------------------------------------

const DEBUG = false;              // print what happens to chat (turn off once everything is verified)
const FALLBACK_SWEEP_TICKS = 0;   // 0 = event-driven only (verified: bundles fill the moment a trade completes). Set to e.g. 20 to also sweep inventories as a safety net.

const BY_NAME = new Map(BUNDLES.map((b) => [b.title, b]));
const say = (m) => { if (DEBUG) world.sendMessage("§e[WT] " + m); };

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = rand(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Turn a bundle's content spec into a flat list of ItemStacks. */
function roll(contents, invalid) {
  const stacks = [];
  // A bad item id must not ruin the whole bundle: skip it and report it.
  const add = (id, n = 1) => { try { stacks.push(new ItemStack(id, n)); } catch (e) { invalid.push(id); } };
  for (const e of contents) {
    if (Array.isArray(e)) { add(e[0], e[1]); continue; }
    if (e.chance !== undefined && Math.random() >= e.chance) continue;
    if (e.id) { add(e.id, e.n ?? 1); continue; }
    if (e.pick !== undefined) {
      const n = Array.isArray(e.pick) ? rand(e.pick[0], e.pick[1]) : e.pick;
      for (const f of shuffled(e.from).slice(0, n)) Array.isArray(f) ? add(f[0], f[1]) : add(f);
      continue;
    }
    if (e.enchantedBook) {
      const [id, level] = e.enchantedBook[rand(0, e.enchantedBook.length - 1)];
      try {
        const book = new ItemStack("minecraft:enchanted_book", 1);
        book.getComponent("minecraft:enchantable").addEnchantment({ type: EnchantmentTypes.get(id), level });
        stacks.push(book);
      } catch (err) { invalid.push("enchanted book (" + id + "): " + err); }
    }
  }
  return stacks;
}

function pickContents(bundle) {
  if (!bundle.variants) return bundle.contents;
  const total = bundle.variants.reduce((s, v) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const v of bundle.variants) { if ((r -= v.weight) < 0) return v.contents; }
  return bundle.variants[0].contents;
}

const bundleOf = (item) =>
  item && item.typeId.endsWith("bundle") && item.getLore().includes(SEAL) ? BY_NAME.get(item.nameTag) : undefined;

/** Fills the item in place. Returns true if the item was changed and must be written back. */
function fill(item, bundle) {
  item.setLore(["§r§7§o" + bundle.flavor]);
  const comp = item.getComponent("minecraft:inventory");
  if (!comp) { say("No inventory component on " + item.typeId); return true; }
  try {
    const c = comp.container;
    const skipped = [];
    const invalid = [];
    const stacks = roll(pickContents(bundle), invalid);
    if (invalid.length) say(bundle.title + ": INVALID items skipped: " + invalid.join(", "));
    for (const s of stacks) {
      const left = c.addItem(s);
      if (left) skipped.push(left.typeId.replace("minecraft:", "") + " x" + left.amount);
    }
    say(bundle.title + ": filled" + (skipped.length ? ", did NOT fit: " + skipped.join(", ") : " OK"));
  } catch (e) {
    say(bundle.title + ": fill error: " + e);
  }
  return true;
}

function sweep(player) {
  const inv = player.getComponent("minecraft:inventory")?.container;
  if (!inv) return;
  for (let i = 0; i < inv.size; i++) {
    const item = inv.getItem(i);
    const bundle = bundleOf(item);
    if (bundle && fill(item, bundle)) inv.setItem(i, item);
  }
}

// Event-driven: runs when a slot in a player's inventory changes (e.g. a trade result lands).
world.afterEvents.playerInventoryItemChange.subscribe((ev) => {
  if (!bundleOf(ev.itemStack)) return;
  system.run(() => sweep(ev.player));
});

// Safety net in case the event does not fire for trade results.
if (FALLBACK_SWEEP_TICKS > 0) {
  system.runInterval(() => { for (const p of world.getAllPlayers()) sweep(p); }, FALLBACK_SWEEP_TICKS);
}
