// Per-player Hunter state (rank, board, active quests) + quest actions.
// State is stored as JSON in a player dynamic property, so it survives restarts and works for every player.

import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { DIM_NAMES } from "./quest_data.js";
import { generateBoard, rankIndex, rankName, computeReward, isReady, relativeYaw, locatorLine } from "./hunter_logic.js";
import { countItem, removeItem, giveItem, currentDay, isValid } from "./util.js";
import { HEAD_BY_ITEM } from "./heads.js";

const KEY = "mh:hunter";
const MARK_TAG = "mh_marked";
const OWNER_PROP = "mh:owner";

export function prettyId(id) {
    const head = HEAD_BY_ITEM.get(id);
    if (head) return "Taxidermy " + head[4];
    const raw = id.split(":")[1].replace(/_block$/, "").replace(/_/g, " ");
    return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---------------- state ---------------- */

const blank = () => ({ points: 0, completed: 0, actives: [], board: [], boardDay: -1 });

/** Pre-v1 saves held one `active` contract; fold it into the `actives` list. */
function migrate(d) {
    if (!Array.isArray(d.actives)) d.actives = [];
    if (d.active) { d.actives.push(d.active); }
    delete d.active;
    return d;
}

export function loadHunter(player) {
    try {
        const raw = player.getDynamicProperty(KEY);
        if (typeof raw === "string") return migrate({ ...blank(), ...JSON.parse(raw) });
    } catch { /* corrupt - start fresh */ }
    return blank();
}

export function saveHunter(player, data) {
    player.setDynamicProperty(KEY, JSON.stringify(data));
}

export function ensureBoard(player, data) {
    const day = currentDay();
    if (data.boardDay !== day) {
        data.board = generateBoard(Math.random, rankIndex(data.points), day, { allowDeliver: CONFIG.wildDrops !== "off" });
        data.boardDay = day;
        saveHunter(player, data);
    }
    return data.board;
}

export function setPoints(player, points) {
    const d = loadHunter(player);
    d.points = Math.max(0, points);
    saveHunter(player, d);
}

export function resetHunter(player) {
    abandonQuest(player);
    player.setDynamicProperty(KEY, undefined);
}

/* ---------------- marked-mob placement ---------------- */

function standableY(dim, x, z, nearY) {
    for (let y = nearY + 10; y >= nearY - 10; y--) {
        const floor = dim.getBlock({ x, y, z });
        const a = dim.getBlock({ x, y: y + 1, z });
        const b = dim.getBlock({ x, y: y + 2, z });
        if (floor && a && b && floor.isSolid && a.isAir && b.isAir) return y + 1;
    }
    return undefined;
}

function findSpot(player) {
    const dim = player.dimension;
    const o = player.location;
    for (let i = 0; i < 24; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = CONFIG.targetSpawnMin + Math.random() * (CONFIG.targetSpawnMax - CONFIG.targetSpawnMin);
        const x = Math.floor(o.x + Math.cos(ang) * dist);
        const z = Math.floor(o.z + Math.sin(ang) * dist);
        try {
            let y;
            if (dim.id === "minecraft:overworld") {
                const top = dim.getTopmostBlock({ x, z });
                if (!top || top.isLiquid || /leaves|log|ice/.test(top.typeId)) continue;
                y = top.location.y + 1;
            } else {
                y = standableY(dim, x, z, Math.floor(o.y));
            }
            if (y !== undefined) return { x: x + 0.5, y, z: z + 0.5 };
        } catch { /* unloaded chunk - try another spot */ }
    }
    return undefined;
}

function spawnTarget(player, q) {
    const spot = findSpot(player);
    if (!spot) return false;
    let mob;
    try {
        mob = player.dimension.spawnEntity(q.mob, spot);
    } catch {
        return false;
    }
    mob.nameTag = `§6Marked ${q.name}`; // named mobs never despawn
    mob.addTag(MARK_TAG);
    mob.setDynamicProperty(OWNER_PROP, player.id);
    const t = q.tier;
    const long = 20 * 60 * 90;
    try {
        mob.addEffect("strength", long, { amplifier: Math.min(t, 3), showParticles: true });
        mob.addEffect("resistance", long, { amplifier: t >= 2 ? 1 : 0, showParticles: false });
        mob.addEffect("health_boost", long, { amplifier: 1 + t, showParticles: false });
    } catch { /* some mobs reject some effects - not fatal */ }
    q.targetId = mob.id;
    q.spot = { x: Math.round(spot.x), z: Math.round(spot.z) };
    return true;
}

/* ---------------- failed contracts / retry ---------------- */

const sigOf = (b) => `${b.type}:${b.mob ?? b.head}`;

function freshCopy(q) {
    return { ...q, id: `${q.id}r`, progress: 0, done: false, lost: false, targetId: null, spot: undefined, retry: true };
}

/**
 * A contract was failed (target died without the hunter) or abandoned. The first one each game day is
 * re-posted on the board so it can be retried; later ones are not. `replaceIfNoRetry` posts a brand new
 * contract instead, so the board does not shrink when the failure was not the hunter's choice.
 */
function postFailure(d, q, replaceIfNoRetry) {
    if ((d.retryDay === d.boardDay ? d.retriesUsed ?? 0 : 0) < CONFIG.retriesPerDay) {
        if (d.retryDay !== d.boardDay) { d.retryDay = d.boardDay; d.retriesUsed = 0; }
        d.retriesUsed += 1;
        d.board.push(freshCopy(q));
        return "retry";
    }
    if (replaceIfNoRetry) {
        const have = new Set(d.board.map(sigOf));
        have.add(sigOf(q));
        const fresh = generateBoard(Math.random, rankIndex(d.points), d.boardDay, { allowDeliver: CONFIG.wildDrops !== "off" })
            .find((b) => !have.has(sigOf(b)));
        if (fresh) { fresh.id += "n"; d.board.push(fresh); return "new"; }
    }
    return "none";
}

/* ---------------- quest actions ---------------- */

export function acceptQuest(player, questId) {
    const d = loadHunter(player);
    if (d.actives.length >= CONFIG.maxActive) {
        return { ok: false, msg: `§cYou can carry ${CONFIG.maxActive} contracts at once. Finish or abandon one first.` };
    }
    const q = d.board.find((x) => x.id === questId);
    if (!q) return { ok: false, msg: "§cThat contract is gone." };
    if (q.type === "target") {
        if (d.actives.some((a) => a.type === "target")) {
            return { ok: false, msg: "§cYou can only hunt one marked target at a time." };
        }
        if (player.dimension.id !== q.dim) {
            return { ok: false, msg: `§cThis hunt takes place in ${DIM_NAMES[q.dim] ?? q.dim}. Go there first.` };
        }
        if (!spawnTarget(player, q)) {
            return { ok: false, msg: "§cNo room to track the target here. Try somewhere more open." };
        }
    }
    d.board = d.board.filter((x) => x.id !== questId);
    d.actives.push(q);
    saveHunter(player, d);
    // Everyone who takes a contract gets a Hunter's Journal to read it back (replaced if lost).
    if (countItem(player, "mh:hunter_journal") === 0) giveItem(player, "mh:hunter_journal", 1);
    return { ok: true, msg: "§aContract accepted. Good hunting. Check your Hunter's Journal any time." };
}

/** Abandon one contract (questId) or, with no id, all of them. */
export function abandonQuest(player, { retry = false, questId } = {}) {
    const d = loadHunter(player);
    const list = questId ? d.actives.filter((x) => x.id === questId) : [...d.actives];
    for (const q of list) {
        if (q.type === "target" && q.targetId) {
            try {
                const e = world.getEntity(q.targetId);
                if (isValid(e)) e.remove();
            } catch { /* already gone */ }
        }
        d.actives = d.actives.filter((x) => x !== q && x.id !== q.id);
        if (retry) postFailure(d, q, false);
    }
    saveHunter(player, d);
}

export function turnIn(player, questId) {
    const d = loadHunter(player);
    const q = questId ? d.actives.find((x) => x.id === questId) : d.actives[0];
    if (!q) return { ok: false, lines: ["You have no such contract."] };
    const have = q.type === "deliver" ? countItem(player, q.head) : 0;
    if (!isReady(q, have)) return { ok: false, lines: ["That contract isn't finished yet."] };

    if (q.type === "deliver") removeItem(player, q.head, q.count);
    const r = computeReward(q, Math.random);
    const before = rankIndex(d.points);

    const lines = [];
    giveItem(player, "minecraft:emerald", r.emeralds);
    lines.push(`${r.emeralds} Emeralds`);
    giveItem(player, "minecraft:diamond", r.diamonds);
    lines.push(`${r.diamonds} Diamond${r.diamonds > 1 ? "s" : ""}`);
    for (const it of r.items) {
        giveItem(player, it.id, it.amount);
        lines.push(`${it.amount} ${prettyId(it.id)}`);
    }
    if (r.trophy) {
        giveItem(player, r.trophy, 1);
        lines.push(`Trophy: ${prettyId(r.trophy)}`);
    }
    if (r.mask) {
        giveItem(player, r.mask, 1);
        lines.push(`§dRare: ${prettyId(r.mask)}`);
    }
    if (!d.gotRack) {
        d.gotRack = true; // first contract ever: a Hide Tanning Rack so the player can use their first head right away
        giveItem(player, "mh:hide_tanning_rack", 1);
        lines.push("§dHide Tanning Rack");
    }
    lines.push(`+${r.points} Hunter points`);

    d.points += r.points;
    d.completed += 1;
    d.actives = d.actives.filter((x) => x.id !== q.id);
    saveHunter(player, d);
    const after = rankIndex(d.points);
    return { ok: true, lines, rankUp: after > before ? rankName(d.points) : null };
}

/* ---------------- kill tracking (called from drops.js) ---------------- */

const isBaby = (e) => {
    try { return !!e.getComponent("minecraft:is_baby"); } catch { return false; }
};

/** Returns true if the dead mob was a marked quest target (so no wild drop is rolled). */
export function onMobKilled(dead, playerKiller) {
    let marked = false;
    try { marked = dead.hasTag(MARK_TAG); } catch { /* ignore */ }

    if (marked) {
        const ownerId = dead.getDynamicProperty(OWNER_PROP);
        const owner = world.getAllPlayers().find((p) => p.id === ownerId);
        if (owner) {
            const d = loadHunter(owner);
            const q = d.actives.find((x) => x.type === "target" && x.targetId === dead.id);
            if (q) {
                if (playerKiller) {
                    q.done = true;
                    q.progress = 1;
                    if (q.head) giveItem(owner, q.head, 1);
                    owner.sendMessage(`§6The marked ${q.name} is dead. §aReturn to a Monster Hunter. §7(Trophy added to your pack)`);
                } else {
                    // The target died before the hunter got it: clear the contract; the board offers a retry or a new one.
                    d.actives = d.actives.filter((x) => x.id !== q.id);
                    const res = postFailure(d, q, true);
                    const tail = res === "retry" ? "It is back on the board for one retry." : res === "new" ? "No retries left today, so a new contract is posted." : "";
                    owner.sendMessage(`§cThe marked ${q.name} died without you. The contract is cleared. ${tail}`);
                }
                saveHunter(owner, d);
            }
        }
        return true;
    }

    if (playerKiller) {
        const d = loadHunter(playerKiller);
        let changed = false;
        for (const q of d.actives) {
            if (q.type !== "cull" || q.done || q.mob !== dead.typeId || isBaby(dead)) continue;
            q.progress += 1;
            changed = true;
            if (q.progress >= q.count) {
                q.done = true;
                playerKiller.sendMessage(`§aContract complete: ${q.count} ${q.name}. Return to a Monster Hunter.`);
            } else {
                playerKiller.onScreenDisplay.setActionBar(`§6${q.name}: ${q.progress}/${q.count}`);
            }
        }
        if (changed) saveHunter(playerKiller, d);
    }
    return false;
}

/* ---------------- target tracker (action bar locator) ---------------- */
// The marker slides along a bar as the player turns toward the marked creature. The only text is an
// up/down arrow when it is well above/below. See CONFIG.locator.

const trackers = new Map(); // player id -> { targetId, dim, x, y, z } (last known position)

// Slow loop: sync trackers with each player's saved quest (JSON parse is too heavy for the fast loop).
system.runInterval(() => {
    const live = new Set();
    for (const p of world.getAllPlayers()) {
        try {
            const raw = p.getDynamicProperty(KEY);
            if (typeof raw !== "string" || !raw.includes('"target"')) continue;
            const c = JSON.parse(raw);
            const q = (c.actives ?? (c.active ? [c.active] : [])).find((x) => x.type === "target" && !x.done && !x.lost);
            if (!q) continue;
            live.add(p.id);
            const t = trackers.get(p.id);
            if (!t || t.targetId !== q.targetId) {
                trackers.set(p.id, { targetId: q.targetId, dim: q.dim, x: q.spot?.x, y: undefined, z: q.spot?.z });
            }
        } catch { /* player mid-transfer */ }
    }
    for (const id of [...trackers.keys()]) if (!live.has(id)) trackers.delete(id);
}, 20);

// Fast loop: redraw the bar.
system.runInterval(() => {
    for (const p of world.getAllPlayers()) {
        const t = trackers.get(p.id);
        if (!t || p.dimension.id !== t.dim) continue;
        try {
            const e = t.targetId ? world.getEntity(t.targetId) : undefined;
            if (isValid(e) && e.dimension.id === p.dimension.id) {
                t.x = e.location.x; t.y = e.location.y; t.z = e.location.z; // refresh last known position
            }
            if (t.x === undefined) continue;
            const rel = relativeYaw(p.getRotation().y, t.x - p.location.x, t.z - p.location.z);
            const dy = t.y === undefined ? undefined : t.y - p.location.y;
            p.onScreenDisplay.setActionBar(locatorLine(rel, dy));
        } catch { /* entity or player became invalid this tick */ }
    }
}, CONFIG.locator.refreshTicks);
