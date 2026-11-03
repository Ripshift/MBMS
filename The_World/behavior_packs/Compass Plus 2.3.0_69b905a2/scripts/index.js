// Compass Plus (ae_cp) 2.5.0: a craftable compass whose needle points at the target you choose.
// A script cannot move the vanilla needle, so the held item is swapped between 16 needle pictures
// (ae_cp:compass_0..15) that match the direction of the target. Targets: your graves (from Simple
// Gravestones, or your last 3 death spots without it), spawns, 3 waypoints per dimension and the last Nether portal.
import { BlockTypes, EquipmentSlot, ItemStack, ItemTypes, system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

const CONFIG = {
  maxWaypoints: 3, // waypoints each player can have in each dimension
  updateTicks: 10, // how often the held compass refreshes the action bar
  arriveRadius: 5, // closer than this (blocks) counts as "arrived"
  needleHold: 0.75, // the needle only changes picture once the target is this many steps (22.5 degrees each) away from the shown one; 0.5 = always the nearest, higher = fewer swaps
  giveOnFirstJoin: true, // every player gets one Compass Plus the first time they join (once per player)
  nameMax: 20, // longest waypoint name
  maxGraves: 5, // graves listed when Simple Gravestones is installed
  maxDeaths: 3, // death locations listed when it is not
  maxHidden: 200, // places an add-on may hide for one player (see ae_cp:hide)
  maxSitesPerSrc: 500, // places one add-on may register (see ae_cp:site)
  maxSources: 32, // add-ons that may register places / menu buttons / pins
};

const COMPASS_ID = "ae_cp:compass"; // plain item; variants ae_cp:compass_0..15, compass_nether_0..15, compass_end_0..15 and the spinning compass_nether / compass_end
const NEEDLE_STEPS = 16;
const PROP = "ae_cp:data";
const OVERWORLD = "minecraft:overworld";
const NETHER = "minecraft:nether";
const END = "minecraft:the_end";
const DIM_LABEL = { [OVERWORLD]: "the Overworld", [NETHER]: "the Nether", [END]: "the End" };

// Graves of Simple Gravestones are found without changing that add-on: every grave has saved structures
// named after its position ("ae_sg:minecraft_overworld_10_64_negative20.1"), and they are deleted when the
// grave is opened. Watching that list shows new graves (who just died owns it) and opened ones.
const graveKey = (g) => `g:${g.d}:${g.x}:${g.y}:${g.z}`;
let graveStore = {}; // playerId -> [{d,x,y,z}] oldest..newest, saved as one world property
try {
  graveStore = JSON.parse(world.getDynamicProperty("ae_cp:graves") ?? "{}");
} catch (e) {
  graveStore = {};
}
const saveGraveStore = () => world.setDynamicProperty("ae_cp:graves", JSON.stringify(graveStore));

// Without Simple Gravestones the same section lists the last 3 places the player died.
let deathStore = {}; // playerId -> [{d,x,y,z}] oldest..newest
try {
  deathStore = JSON.parse(world.getDynamicProperty("ae_cp:deaths") ?? "{}");
} catch (e) {
  deathStore = {};
}
const saveDeathStore = () => world.setDynamicProperty("ae_cp:deaths", JSON.stringify(deathStore));
const hasGravestones = () => attempt(() => BlockTypes.get("ae_sg:gravestone") !== undefined) === true;

// ================================================================ hooks for other add-ons (hook version 4)
// Every hook is a /scriptevent message with a JSON body, for example
//   /scriptevent ae_cp:site {"src":"mypack","name":"My Place","d":"minecraft:the_end","x":1,"y":64,"z":2}
// "src" names the sending add-on: use its own namespace (two add-ons with the same "src" would be merged).
// Places and menu buttons are kept in memory only: the sender sends them again after every load and whenever it
// hears  ae_cp:hello  (sent 60 ticks after this add-on loads; the body says which hooks exist: {"v":4,"hooks":[...],"events":[...]}).
// A sender can announce itself with  ae_cp:hello_back {"src","v"}  (this add-on then repeats ae_cp:player for everyone online).
//
// Messages TO Compass Plus
//   ae_cp:site    {"src","name","d","x","y"?,"z", "label"?,"player"?, "order"?,"color"?,"maxDist"?}
//                 adds / updates a place. All places with the same "src" are ONE entry in the target list of their
//                 dimension, pointing at the nearest of them. Or in bulk: {"src","name",...,"sites":[{"d","x","y"?,"z","label"?,"player"?}]}.
//                 "label" replaces the entry name while that place is the nearest. "player" (player id) makes a
//                 place visible to that player only. "order" sorts entries from different add-ons (default 100,
//                 lower = higher in the list). "color" is a Minecraft colour code character 0-9 a-g for the readout.
//                 "maxDist" hides the entry when even the nearest place is farther than that many blocks.
//   ae_cp:remove  {"src","d","x","z"}  or  {"src","sites":[{"d","x","z"}]}   removes places.
//   ae_cp:clear   {"src","all"?}       removes every place of "src" (with "all": also its menu button).
//   ae_cp:menu    {"src","label","d"?} adds a button to the compass menu (only in dimension "d" if given). Picking it
//                 sends  ae_cp:menu_open {"src","player"}  and the other add-on shows its own form.
//   ae_cp:hide / ae_cp:unhide {"src","player","key"}  hides / shows one place of "src" for one player; "key" = "<d>:<x>:<z>".
//                 Saved per player (the player must be online).
//   ae_cp:pin     {"src","player","name","d","x","y"?,"z"}  makes that place the player's tracked target in dimension "d"
//                 (saved per player, one pin per "src").   ae_cp:unpin {"src","player"} removes it.
//   ae_cp:style   {"src","d","prefix"}  gives a custom dimension "d" its own compass look. The sending add-on ships the
//                 items itself: "<prefix>" (the spinning icon) and "<prefix>_0" .. "<prefix>_15" (the needle, 0 = straight
//                 ahead, clockwise), e.g. prefix "mypack:compass". While a player is in "d" the held compass shows those items
//                 instead of the Overworld ones. Checked when it arrives: if the items do not exist it is ignored (console
//                 warning). {"src","d","prefix":null} removes it. Not allowed for the Overworld / Nether / End.
//                 tools/make_dimension_style.py builds the items and textures from one 16-frame texture strip.
// Messages FROM Compass Plus
//   ae_cp:hello {"v","hooks","events"}          see above.
//   ae_cp:player {"player","name","to"?}        a player joined the game (or "to" asked for it): restore hides / pins now.
//   ae_cp:selected {"src","player","key"}       the player started tracking this entry ("key" = the nearest place, or "pin").
//   ae_cp:arrived {"src","player","key"}        the player came within arriveRadius of a place (once per visit).
//   ae_cp:menu_open {"src","player"}            the player picked a menu button of "src".
const HOOK_VERSION = 4;
const HOOKS = ["site", "remove", "clear", "menu", "hide", "unhide", "pin", "unpin", "style", "hello_back"];
const HOOK_EVENTS = ["hello", "player", "selected", "arrived", "menu_open"];
const external = new Map(); // src -> { name, order, color?, maxDist?, sites: Map(slot -> {d,x,y,z,label?,player?}) }
const menus = new Map(); // src -> { label, d? }
const styles = new Map(); // custom dimension id -> { src, prefix } (compass items for that dimension)
const warned = new Set();

const warnOnce = (id, text) => {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`[ae_cp] ${text}`);
};
const siteKey = (s) => `${s.d}:${s.x}:${s.z}`;
const slotOf = (s) => `${s.player ?? ""}|${siteKey(s)}`;
const colorOf = (c) => (typeof c === "string" && /^[0-9a-g]$/.test(c) ? c : undefined);
const dimLabel = (d) => DIM_LABEL[d] ?? "the " + String(d).split(":").pop().replace(/_/g, " ");

function parseSite(m) {
  if (typeof m?.d !== "string" || !Number.isFinite(m.x) || !Number.isFinite(m.z)) return undefined;
  const site = { d: m.d, x: Math.floor(m.x), y: Number.isFinite(m.y) ? Math.floor(m.y) : undefined, z: Math.floor(m.z) };
  if (typeof m.label === "string" && cleanName(m.label, "")) site.label = cleanName(m.label, "");
  if (m.player !== undefined) site.player = String(m.player);
  return site;
}

function emit(id, payload) {
  attempt(() => world.getDimension("minecraft:overworld").runCommand(`scriptevent ${id} ${JSON.stringify(payload)}`));
}

const announceHello = () => emit("ae_cp:hello", { v: HOOK_VERSION, hooks: HOOKS, events: HOOK_EVENTS });
const announcePlayer = (player, to) => emit("ae_cp:player", to ? { player: player.id, name: player.name, to } : { player: player.id, name: player.name });

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (!event.id.startsWith("ae_cp:") || !HOOKS.includes(event.id.slice(6))) return;
  try {
    const m = JSON.parse(event.message);
    if (typeof m?.src !== "string" || !m.src) return;
    const src = m.src;
    const items = Array.isArray(m.sites) ? m.sites : [m];
    switch (event.id) {
      case "ae_cp:site": {
        let group = external.get(src);
        if (!group) {
          if (external.size >= CONFIG.maxSources) return warnOnce("src:" + src, `too many add-ons registered, ignoring "${src}"`);
          group = { name: src, order: 100, sites: new Map() };
          external.set(src, group);
        }
        if (typeof m.name === "string") group.name = cleanName(m.name, group.name);
        if (Number.isFinite(m.order)) group.order = m.order;
        if ("color" in m) group.color = colorOf(m.color);
        if ("maxDist" in m) group.maxDist = Number.isFinite(m.maxDist) && m.maxDist > 0 ? m.maxDist : undefined;
        for (const item of items) {
          const site = parseSite(item);
          if (!site) continue;
          const slot = slotOf(site);
          if (!group.sites.has(slot) && group.sites.size >= CONFIG.maxSitesPerSrc) {
            warnOnce("sites:" + src, `"${src}" has more than ${CONFIG.maxSitesPerSrc} places, ignoring the rest`);
            break;
          }
          group.sites.set(slot, site);
        }
        if (group.sites.size === 0) external.delete(src);
        return;
      }
      case "ae_cp:remove": {
        const group = external.get(src);
        if (!group) return;
        for (const item of items) {
          const site = parseSite(item);
          if (!site) continue;
          if (item.player !== undefined) group.sites.delete(slotOf(site));
          else for (const [slot, s] of [...group.sites]) if (siteKey(s) === siteKey(site)) group.sites.delete(slot);
        }
        if (group.sites.size === 0) external.delete(src);
        return;
      }
      case "ae_cp:clear":
        external.delete(src);
        if (m.all) {
          menus.delete(src);
          for (const [d, st] of [...styles]) if (st.src === src) styles.delete(d);
        }
        return;
      case "ae_cp:style": {
        if (typeof m.d !== "string") return;
        if ([OVERWORLD, NETHER, END].includes(m.d)) return warnOnce("style:" + m.d, `ae_cp:style is not allowed for ${m.d}`);
        if (m.prefix === null) {
          styles.delete(m.d);
          return;
        }
        const prefix = m.prefix;
        const exists = (id) => attempt(() => ItemTypes.get(id) !== undefined) === true;
        if (typeof prefix !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(prefix) || !exists(prefix) || !exists(prefix + "_0") || !exists(prefix + "_15")) {
          return warnOnce("style:" + m.d + prefix, `ae_cp:style for ${m.d}: items "${prefix}" and "${prefix}_0..15" were not found`);
        }
        if (!styles.has(m.d) && styles.size >= CONFIG.maxSources) return warnOnce("style:max", "too many compass styles");
        styles.set(m.d, { src, prefix });
        return;
      }
      case "ae_cp:menu":
        if (!menus.has(src) && menus.size >= CONFIG.maxSources) return warnOnce("menu:" + src, `too many menu buttons, ignoring "${src}"`);
        menus.set(src, { label: cleanName(m.label, src), d: typeof m.d === "string" ? m.d : undefined });
        return;
      case "ae_cp:hello_back":
        for (const p of world.getAllPlayers()) announcePlayer(p, src);
        return;
    }
    // hide / unhide / pin / unpin: saved per player
    const player = world.getAllPlayers().find((p) => p.id === String(m.player));
    if (!player) return; // not online: the other add-on sends it again when it hears ae_cp:player
    const data = load(player);
    if (event.id === "ae_cp:pin") {
      if (typeof m.d !== "string" || !Number.isFinite(m.x) || !Number.isFinite(m.z)) return;
      if (!data.pin[src] && Object.keys(data.pin).length >= CONFIG.maxSources) return warnOnce("pin:" + src, `too many pins, ignoring "${src}"`);
      data.pin[src] = { n: cleanName(m.name, src), d: m.d, x: Math.floor(m.x), y: Number.isFinite(m.y) ? Math.floor(m.y) : undefined, z: Math.floor(m.z) };
      select(player, data, m.d, { key: "pin:" + src, src, siteKey: "pin" });
    } else if (event.id === "ae_cp:unpin") {
      const pin = data.pin[src];
      delete data.pin[src];
      if (pin && data.sel[pin.d] === "pin:" + src) delete data.sel[pin.d];
    } else if (typeof m.key === "string") {
      const hidden = new Set(data.hide[src] ?? []);
      if (event.id === "ae_cp:hide") hidden.add(m.key);
      else hidden.delete(m.key);
      data.hide[src] = [...hidden].slice(-CONFIG.maxHidden);
    }
    save(player, data);
  } catch (e) {
    console.warn(`[ae_cp] bad hook message (${event.id}): ${e}`);
  }
});

// Remember the target a player picks; entries from other add-ons also tell their add-on (ae_cp:selected).
function select(player, data, dim, t) {
  const changed = data.sel[dim] !== t.key;
  data.sel[dim] = t.key;
  if (changed && t.src) emit("ae_cp:selected", { src: t.src, player: player.id, key: t.siteKey });
}

// Ask add-ons that use the hooks to send their places again (this add-on may have started after them).
system.runTimeout(announceHello, 60);

// ae_cp:arrived: a place of an add-on (or a pin) is within arriveRadius. Once per visit (it must be left by twice the radius).
const inside = new Map(); // playerId -> Set("src|key")
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    try {
      const data = load(player);
      const dim = player.dimension.id;
      const { x: px, y: py, z: pz } = player.location;
      const was = inside.get(player.id) ?? new Set();
      const now = new Set();
      const check = (src, key, s) => {
        const id = `${src}|${key}`;
        const radius = was.has(id) ? CONFIG.arriveRadius * 2 : CONFIG.arriveRadius;
        if (Math.hypot(s.x + 0.5 - px, s.z + 0.5 - pz) > radius) return;
        if (s.y !== undefined && Math.abs(s.y - Math.floor(py)) > 3) return;
        now.add(id);
        if (!was.has(id)) emit("ae_cp:arrived", { src, player: player.id, key });
      };
      for (const [src, group] of external) {
        const hidden = new Set(data.hide[src] ?? []);
        for (const site of group.sites.values()) {
          if (site.d !== dim || (site.player && site.player !== player.id) || hidden.has(siteKey(site))) continue;
          check(src, siteKey(site), site);
        }
      }
      for (const [src, pin] of Object.entries(data.pin)) if (pin.d === dim) check(src, "pin", pin);
      if (now.size || was.size) inside.set(player.id, now);
    } catch (e) {
      /* player is loading / changing dimension */
    }
  }
}, 20);

world.afterEvents.playerLeave.subscribe((event) => inside.delete(event.playerId));

// ---------------------------------------------------------------- saved data (per player)
function load(player) {
  try {
    const data = JSON.parse(player.getDynamicProperty(PROP) ?? "{}");
    data.wp ??= {};
    data.portal ??= {};
    data.sel ??= {};
    data.hide ??= {}; // src -> [site keys] hidden for this player (hook ae_cp:hide)
    data.pin ??= {}; // src -> {n,d,x,y,z} place pinned as target (hook ae_cp:pin)
    return data;
  } catch (e) {
    return { wp: {}, portal: {}, sel: {}, hide: {}, pin: {} };
  }
}

function save(player, data) {
  player.setDynamicProperty(PROP, JSON.stringify(data));
}

const floorPos = (l) => ({ x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) });

function cleanName(text, fallback) {
  const name = String(text ?? "").replace(/§./g, "").trim().slice(0, CONFIG.nameMax);
  return name || fallback;
}

function attempt(fn) {
  try {
    return fn();
  } catch (e) {
    return undefined;
  }
}

// ---------------------------------------------------------------- targets for the current dimension
function targetsFor(player, data) {
  const dim = player.dimension.id;
  const list = [];
  const withGraves = hasGravestones();
  const places = withGraves ? graveStore[player.id] : deathStore[player.id];
  const shown = (places ?? []).slice(withGraves ? -CONFIG.maxGraves : -CONFIG.maxDeaths).reverse(); // newest first
  shown.forEach((g, i) => list.push({ key: graveKey(g), name: `${withGraves ? "Grave" : "Death"} ${i + 1}`, x: g.x, y: g.y ?? undefined, z: g.z, d: g.d }));
  const sp = attempt(() => player.getSpawnPoint());
  const spawn = sp && sp.dimension.id === dim ? { key: "spawn", name: "Your Spawn", x: sp.x, y: sp.y, z: sp.z } : undefined;
  const ws = attempt(() => world.getDefaultSpawnLocation());
  if (dim === OVERWORLD) {
    if (ws) list.push({ key: "world", name: "World Spawn", x: ws.x, z: ws.z });
    if (spawn) list.push(spawn);
  } else if (dim === NETHER) {
    if (spawn) list.push(spawn); // (no World Spawn here: it is in the Overworld and means nothing in the Nether)
  } else if (dim === END) {
    list.push({ key: "center", name: "End Center", x: 0, z: 0 });
  }
  const ext = [];
  for (const [src, group] of external) {
    const hidden = new Set(data.hide[src] ?? []);
    let best;
    let bestDist = Infinity;
    for (const site of group.sites.values()) {
      if (site.d !== dim || (site.player && site.player !== player.id) || hidden.has(siteKey(site))) continue;
      const dist = Math.hypot(site.x + 0.5 - player.location.x, site.z + 0.5 - player.location.z);
      if (group.maxDist && dist > group.maxDist) continue;
      if (dist < bestDist) [best, bestDist] = [site, dist];
    }
    if (best) ext.push({ order: group.order, entry: { key: "ext:" + src, src, siteKey: siteKey(best), name: best.label || group.name, color: group.color, x: best.x, y: best.y, z: best.z } });
  }
  ext.sort((a, b) => a.order - b.order); // lower "order" first; equal orders keep the order they registered in
  for (const e of ext) list.push(e.entry);
  for (const [src, pin] of Object.entries(data.pin)) {
    // a pinned place only shows up while it is the one being tracked
    if (pin.d === dim && data.sel[dim] === "pin:" + src) list.push({ key: "pin:" + src, src, siteKey: "pin", name: pin.n, x: pin.x, y: pin.y, z: pin.z });
  }
  (data.wp[dim] ?? []).forEach((w, i) => {
    if (w) list.push({ key: "wp" + i, name: w.n, x: w.x, y: w.y, z: w.z, slot: i });
  });
  const portal = data.portal[dim];
  if (portal && (dim === OVERWORLD || dim === NETHER)) {
    const entry = { key: "portal", name: dim === NETHER ? "Nether Portal" : "Overworld Portal", x: portal.x, y: portal.y, z: portal.z };
    if (dim === NETHER) list.splice(shown.length, 0, entry); // the portal you came out of comes first in the Nether
    else list.push(entry);
  }
  for (const t of list) t.d ??= dim;
  return list;
}

function selectedTarget(player, data, list) {
  const dim = player.dimension.id;
  return list.find((t) => t.key === data.sel[dim]) ?? (dim === NETHER ? list.find((t) => t.key === "portal") : undefined) ?? list[0];
}

function distanceTo(player, t) {
  return Math.round(Math.hypot(t.x + 0.5 - player.location.x, t.z + 0.5 - player.location.z));
}

function readout(player) {
  const data = load(player);
  const t = selectedTarget(player, data, targetsFor(player, data));
  if (!t) return "§eCompass§r: nothing to track here";
  if (t.d !== player.dimension.id) return `§${t.color ?? "b"}${t.name}§r · in ${dimLabel(t.d)}`;
  const flat = distanceTo(player, t);
  const dy = t.y === undefined ? 0 : t.y - Math.floor(player.location.y);
  if (flat <= CONFIG.arriveRadius && Math.abs(dy) <= 3) return `§a${t.name}§r · arrived`;
  const parts = [`§${t.color ?? "b"}${t.name}§r`, `${flat} blocks`];
  if (Math.abs(dy) >= 3) parts.push(dy > 0 ? `${dy} up` : `${-dy} down`);
  return parts.join(" · ");
}

// Which picture the held compass should show. The look follows the dimension you are in (Overworld, Nether
// or End textures): a needle step, or a spinning icon (no target, arrived, or the target is in another dimension).
const STYLE = { [NETHER]: "_nether", [END]: "_end" }; // Overworld = no suffix

function wantedType(player, shownType) {
  const data = load(player);
  const spin = styles.get(player.dimension.id)?.prefix ?? COMPASS_ID + (STYLE[player.dimension.id] ?? ""); // custom dimensions: items from ae_cp:style
  const t = selectedTarget(player, data, targetsFor(player, data));
  if (!t || t.d !== player.dimension.id) return spin;
  const dx = t.x + 0.5 - player.location.x;
  const dz = t.z + 0.5 - player.location.z;
  const dy = t.y === undefined ? 0 : t.y - Math.floor(player.location.y);
  if (Math.hypot(dx, dz) <= CONFIG.arriveRadius && Math.abs(dy) <= 3) return spin;
  const deg = (rad) => ((rad * 180) / Math.PI + 360) % 360;
  const view = player.getViewDirection();
  const relative = (deg(Math.atan2(dx, -dz)) - deg(Math.atan2(view.x, -view.z)) + 360) % 360;
  const exact = relative / (360 / NEEDLE_STEPS); // needle position in steps, 0 = straight ahead, clockwise
  // Hysteresis: every swap of the held item can show a small re-equip dip, so keep the needle picture that is
  // already shown until the target has clearly moved away from it (stops back-and-forth swaps on a step border).
  const prefix = spin + "_";
  const shown = shownType?.startsWith(prefix) ? Number(shownType.slice(prefix.length)) : NaN;
  if (Number.isInteger(shown) && shown >= 0 && shown < NEEDLE_STEPS) {
    const off = Math.abs(((exact - shown + NEEDLE_STEPS * 1.5) % NEEDLE_STEPS) - NEEDLE_STEPS / 2);
    if (off <= CONFIG.needleHold) return shownType;
  }
  return `${prefix}${Math.round(exact) % NEEDLE_STEPS}`;
}

// ---------------------------------------------------------------- held compass + quick cycle
const isCompass = (item) => {
  const id = item?.typeId;
  if (!id) return false;
  if (id === COMPASS_ID || id.startsWith(COMPASS_ID + "_")) return true;
  for (const st of styles.values()) if (id === st.prefix || id.startsWith(st.prefix + "_")) return true; // items of a custom dimension look
  return false;
};

// The same compass with another picture (keeps a custom name).
function retyped(item, wanted) {
  if (item.typeId === wanted) return undefined;
  const next = new ItemStack(wanted, 1);
  if (item.nameTag) next.nameTag = item.nameTag;
  return next;
}

let sweepTick = 0;
system.runInterval(() => {
  sweepTick++;
  for (const player of world.getAllPlayers()) {
    try {
      const container = player.getComponent("minecraft:inventory")?.container;
      if (!container) continue;
      const slot = player.selectedSlotIndex;
      // A compass that is not in a hand goes back to the plain item (every second: the compass you stopped holding, or took out of the left hand).
      if (sweepTick % 2 === 0) {
        for (let i = 0; i < container.size; i++) {
          if (i === slot) continue;
          const old = container.getItem(i);
          if (old && old.typeId !== COMPASS_ID && isCompass(old)) container.setItem(i, retyped(old, COMPASS_ID));
        }
      }
      // Right hand (selected slot) and left hand both show the needle.
      const offhand = player.getComponent("minecraft:equippable")?.getEquipmentSlot(EquipmentSlot.Offhand);
      const mainItem = container.getItem(slot);
      const offItem = attempt(() => offhand?.getItem());
      const inMain = isCompass(mainItem);
      const inOff = isCompass(offItem);
      if (inMain || inOff) player.onScreenDisplay.setActionBar(readout(player));
      if (inMain) {
        const next = retyped(mainItem, wantedType(player, mainItem.typeId));
        if (next) container.setItem(slot, next);
      }
      if (inOff) {
        const next = retyped(offItem, wantedType(player, offItem.typeId));
        if (next) offhand.setItem(next);
      }
    } catch (e) {
      /* player is loading / changing dimension */
    }
  }
}, CONFIG.updateTicks);

function cycle(player) {
  const data = load(player);
  const list = targetsFor(player, data);
  if (list.length === 0) return;
  const current = list.indexOf(selectedTarget(player, data, list));
  select(player, data, player.dimension.id, list[(current + 1) % list.length]);
  save(player, data);
  player.onScreenDisplay.setActionBar(readout(player));
}

// ---------------------------------------------------------------- menus
async function show(form, player) {
  for (let i = 0; i < 6; i++) {
    const response = await form.show(player);
    if (!response.canceled || response.cancelationReason !== "UserBusy") return response;
    await new Promise((resolve) => system.runTimeout(resolve, 10)); // chat / another screen is open
  }
  return { canceled: true };
}

async function mainMenu(player) {
  const data = load(player);
  const list = targetsFor(player, data);
  const current = selectedTarget(player, data, list);
  const form = new ActionFormData().title("Compass").body(current ? `Tracking: ${current.name}` : "Nothing to track here yet.");
  for (const t of list) {
    const where = t.d === player.dimension.id ? `${distanceTo(player, t)} blocks` : `in ${dimLabel(t.d)}`;
    form.button(`${t.name}\n§8${where}${t === current ? " · tracking" : ""}`);
  }
  const subs = [...menus].filter(([, m]) => !m.d || m.d === player.dimension.id); // buttons added by other add-ons
  for (const [, m] of subs) form.button(m.label);
  form.button("Waypoints");
  const r = await show(form, player);
  if (r.canceled) return;
  if (r.selection === list.length + subs.length) return waypointMenu(player);
  if (r.selection >= list.length) return emit("ae_cp:menu_open", { src: subs[r.selection - list.length][0], player: player.id });
  select(player, data, player.dimension.id, list[r.selection]);
  save(player, data);
}

async function waypointMenu(player) {
  const dim = player.dimension.id;
  const data = load(player);
  const slots = Array.from({ length: CONFIG.maxWaypoints }, (_, i) => data.wp[dim]?.[i] ?? null);
  const form = new ActionFormData().title("Waypoints").body(`Up to ${CONFIG.maxWaypoints} in this dimension.`);
  for (const [i, w] of slots.entries()) form.button(w ? `${w.n}\n§8${w.x}, ${w.y}, ${w.z}` : `§7Empty slot ${i + 1}\n§8Set to where you stand`);
  const r = await show(form, player);
  if (r.canceled) return;
  const i = r.selection;
  if (!slots[i]) return setWaypoint(player, i);
  const w = slots[i];
  const sub = new ActionFormData().title(w.n).button("Track").button("Rename").button("Move here").button("Delete");
  const choice = await show(sub, player);
  if (choice.canceled) return;
  const fresh = load(player);
  const list = (fresh.wp[dim] ??= []);
  if (!list[i]) return;
  if (choice.selection === 0) fresh.sel[dim] = "wp" + i;
  else if (choice.selection === 1) {
    const ask = await show(new ModalFormData().title("Rename").textField("Name", "Waypoint", { defaultValue: list[i].n }), player);
    if (ask.canceled) return;
    list[i].n = cleanName(ask.formValues?.[0], list[i].n);
  } else if (choice.selection === 2) Object.assign(list[i], floorPos(player.location));
  else list[i] = null;
  save(player, fresh);
}

async function setWaypoint(player, i) {
  const ask = await show(new ModalFormData().title("New waypoint").textField("Name", "Waypoint", { defaultValue: `Waypoint ${i + 1}` }), player);
  if (ask.canceled) return;
  const dim = player.dimension.id;
  const data = load(player);
  const list = (data.wp[dim] ??= []);
  while (list.length < CONFIG.maxWaypoints) list.push(null);
  list[i] = { n: cleanName(ask.formValues?.[0], `Waypoint ${i + 1}`), ...floorPos(player.location) };
  data.sel[dim] = "wp" + i;
  save(player, data);
}

const lastUse = new Map();
world.afterEvents.itemUse.subscribe((event) => {
  if (!isCompass(event.itemStack)) return;
  const player = event.source;
  if (system.currentTick - (lastUse.get(player.id) ?? -100) < 8) return; // the event can fire twice
  lastUse.set(player.id, system.currentTick);
  try {
    if (player.isSneaking) cycle(player);
    else mainMenu(player).catch((e) => console.warn(`[ae_cp] menu failed: ${e}`));
  } catch (e) {
    console.warn(`[ae_cp] compass use failed: ${e}`);
  }
});

world.afterEvents.playerLeave.subscribe((event) => lastUse.delete(event.playerId));

// ---------------------------------------------------------------- graves from Simple Gravestones
const GRAVE_ID = /^ae_sg:minecraft_(overworld|nether|the_end)_(negative)?(\d+)_(negative)?(\d+)_(negative)?(\d+)\.1$/;

function parseGraveId(id) {
  const m = GRAVE_ID.exec(id);
  if (!m) return undefined;
  return { d: "minecraft:" + m[1], x: (m[2] ? -1 : 1) * +m[3], y: (m[4] ? -1 : 1) * +m[5], z: (m[6] ? -1 : 1) * +m[7] };
}

function graveIds() {
  const ids = attempt(() => world.structureManager.getWorldStructureIds());
  return ids ? new Set(ids.filter((id) => GRAVE_ID.test(id))) : undefined;
}

let knownIds; // grave structures seen so far (the first look is only a baseline)
const recentDeaths = [];

world.afterEvents.entityDie.subscribe((event) => {
  const dead = event.deadEntity;
  if (dead?.typeId !== "minecraft:player") return;
  if (!hasGravestones()) {
    // No gravestones: remember where the player died (a void death has no usable height).
    const l = dead.location;
    const spot = { d: dead.dimension.id, x: Math.floor(l.x), y: l.y < dead.dimension.heightRange.min ? null : Math.floor(l.y), z: Math.floor(l.z) };
    const list = (deathStore[dead.id] ??= []);
    list.push(spot);
    deathStore[dead.id] = list.slice(-CONFIG.maxDeaths);
    saveDeathStore();
    const player = world.getAllPlayers().find((p) => p.id === dead.id);
    if (player) {
      const data = load(player);
      data.sel[spot.d] = graveKey(spot);
      data.sel[OVERWORLD] = graveKey(spot);
      save(player, data);
    }
    return;
  }
  recentDeaths.push({ id: dead.id, d: dead.dimension.id, x: dead.location.x, z: dead.location.z, tick: system.currentTick });
  system.runTimeout(syncGraves, 3); // Simple Gravestones saves the grave in the same tick
});

function syncGraves() {
  try {
    if (!hasGravestones()) return; // nothing to watch
    const now = graveIds();
    if (!now) return;
    if (!knownIds) {
      knownIds = now;
      return;
    }
    while (recentDeaths.length && system.currentTick - recentDeaths[0].tick > 200) recentDeaths.shift();
    let changed = false;
    for (const id of now) {
      if (knownIds.has(id)) continue;
      const g = parseGraveId(id);
      const near = (d) => Math.hypot(d.x - g.x, d.z - g.z);
      const candidates = recentDeaths.filter((d) => d.d === g.d).sort((a, b) => near(a) - near(b));
      const death = candidates[0];
      if (!death) continue; // not made by a death we saw (admin / other add-on)
      recentDeaths.splice(recentDeaths.indexOf(death), 1);
      const list = (graveStore[death.id] ??= []);
      if (!list.some((e) => graveKey(e) === graveKey(g))) list.push(g);
      graveStore[death.id] = list.slice(-CONFIG.maxGraves);
      changed = true;
      const player = world.getAllPlayers().find((p) => p.id === death.id);
      if (player) {
        // The compass points at the new grave (here and after respawning in the Overworld).
        const data = load(player);
        data.sel[g.d] = graveKey(g);
        data.sel[OVERWORLD] = graveKey(g);
        save(player, data);
      }
    }
    for (const id of knownIds) {
      if (now.has(id)) continue; // gone = the grave was opened (its saved items were deleted)
      const g = parseGraveId(id);
      for (const owner of Object.keys(graveStore)) {
        const kept = graveStore[owner].filter((e) => graveKey(e) !== graveKey(g));
        if (kept.length !== graveStore[owner].length) {
          graveStore[owner] = kept;
          changed = true;
        }
      }
    }
    knownIds = now;
    if (changed) saveGraveStore();
  } catch (e) {
    console.warn(`[ae_cp] grave sync failed: ${e}`);
  }
}

system.runTimeout(syncGraves, 1); // baseline
system.runInterval(syncGraves, 20); // also notices graves that were opened

// ---------------------------------------------------------------- last Nether portal (automatic waypoint)
function portalNear(dimension, at) {
  const c = floorPos(at);
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (attempt(() => dimension.getBlock({ x: c.x + dx, y: c.y + dy, z: c.z + dz })?.typeId) === "minecraft:portal") return true;
      }
    }
  }
  return false;
}

function storePortalTrip(player, from, to, toLocation, fromLocation) {
  const data = load(player);
  data.portal[to] = floorPos(toLocation); // where you came out
  data.portal[from] = floorPos(fromLocation); // the portal you went in
  if (to === NETHER) data.sel[NETHER] = "portal"; // arriving in the Nether: the compass points back at the portal you came out of
  save(player, data);
}

// A dimension change by itself proves nothing (respawn, /tp), and for a brand new portal the destination
// portal is built and its chunks load only after the player arrives. So the change just starts a short watch:
// every half second, for up to 12 seconds, look for a portal block around the arrival point while the player
// is still in the new dimension. Found = it was a portal trip, store it. Never found = not a portal trip.
const portalWatch = new Map(); // playerId -> id of the trip being watched (a newer trip cancels an older one)
let portalTripCounter = 0;

world.afterEvents.playerDimensionChange.subscribe((event) => {
  try {
    const from = event.fromDimension.id;
    const to = event.toDimension.id;
    const pair = [OVERWORLD, NETHER];
    if (from === to || !pair.includes(from) || !pair.includes(to)) return;
    const { player, toLocation, fromLocation } = event;
    const trip = ++portalTripCounter;
    portalWatch.set(player.id, trip);
    let tries = 0;
    const look = () => {
      try {
        if (portalWatch.get(player.id) !== trip) return; // a newer trip, or already stored
        if (!player.isValid || player.dimension.id !== to) return void portalWatch.delete(player.id); // left again
        if (portalNear(player.dimension, toLocation)) {
          portalWatch.delete(player.id);
          return storePortalTrip(player, from, to, toLocation, fromLocation);
        }
        if (++tries >= 24) return void portalWatch.delete(player.id); // 12 seconds, no portal: not a portal trip
        system.runTimeout(look, 10);
      } catch (e) {
        portalWatch.delete(player.id);
      }
    };
    system.runTimeout(look, 10);
  } catch (e) {
    console.warn(`[ae_cp] portal tracking failed: ${e}`);
  }
});

world.afterEvents.playerLeave.subscribe((event) => portalWatch.delete(event.playerId));

// ---------------------------------------------------------------- joining players: starter compass + ae_cp:player
world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;
  const player = event.player;
  system.runTimeout(() => {
    try {
      if (!player.isValid) return;
      const data = load(player);
      if (CONFIG.giveOnFirstJoin && !data.given) {
        data.given = true;
        save(player, data);
        const compass = new ItemStack(COMPASS_ID, 1);
        const container = player.getComponent("minecraft:inventory")?.container;
        const left = container?.addItem(compass);
        if (!container || left) player.dimension.spawnItem(left ?? compass, player.location); // inventory full: drop at feet
      }
      announcePlayer(player); // other add-ons can now restore this player's hides / pins
    } catch (e) {
      console.warn(`[ae_cp] join handling failed: ${e}`);
    }
  }, 40); // let the player finish loading in
});
