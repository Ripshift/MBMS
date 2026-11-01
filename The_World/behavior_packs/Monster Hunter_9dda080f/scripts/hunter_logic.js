// Pure quest / rank / reward logic. No Minecraft imports, so it can be unit-tested in Node.
// Every function that needs randomness takes an `rng` (() => [0,1)).

import { CONFIG } from "./config.js";
import { CULL_POOL, TARGET_POOL, REWARD_ITEMS, DIM_NAMES } from "./quest_data.js";
import { DROP_TABLE } from "./drop_table.js";
import { HEADS, HEAD_BY_BLOCK } from "./heads.js";
import { VANILLA_BY_ITEM } from "./vanilla_heads.js";

const MAX_TIER = CONFIG.ranks.length - 1;
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/* ---------------- locator bar (action bar) ---------------- */

/** Degrees the target is to the player's right (+) or left (-), -180..180. Bedrock yaw: 0 = +z, 90 = -x. */
export function relativeYaw(playerYaw, dx, dz) {
    const target = (Math.atan2(-dx, dz) * 180) / Math.PI;
    let rel = target - playerYaw;
    while (rel > 180) rel -= 360;
    while (rel <= -180) rel += 360;
    return rel;
}

/**
 * One action-bar line: a dotted bar with a marker where the creature is relative to where you look.
 * `dy` is target height minus player height (undefined = height unknown, no arrow).
 */
export function locatorLine(rel, dy, L = CONFIG.locator) {
    const w = L.barWidth;
    const mid = (w - 1) / 2;
    const cells = Array.from({ length: w }, (_, i) => (i === mid ? "§7|" : "§8·"));
    let mark = L.marker;
    let pos = Math.round((rel / L.halfFov) * mid);
    if (pos > mid) { pos = w - 1; mark = L.edgeRight; }
    else if (pos < -mid) { pos = 0; mark = L.edgeLeft; }
    else pos += mid;
    cells[pos] = `§l§6${mark}§r`;
    let line = cells.join("");
    if (dy !== undefined && dy >= L.verticalThreshold) line += `  §f${L.upText}`;
    else if (dy !== undefined && dy <= -L.verticalThreshold) line += `  §f${L.downText}`;
    return line;
}

/* ---------------- rank ---------------- */

export function rankIndex(points) {
    let idx = 0;
    CONFIG.ranks.forEach((r, i) => { if (points >= r.points) idx = i; });
    return idx;
}
export const rankName = (points) => CONFIG.ranks[rankIndex(points)].name;
export function nextRank(points) {
    const i = rankIndex(points);
    return i >= MAX_TIER ? null : CONFIG.ranks[i + 1];
}

/* ---------------- deliver pool (derived from the drop table) ---------------- */

// Raw VMH head blocks that are realistically droppable. Rarer heads open up at higher ranks.
export function deliverPool(tier) {
    const minBase = tier <= 1 ? 0.2 : tier === 2 ? 0.1 : 0.05;
    const out = [];
    for (const [key, [item, chance]] of Object.entries(DROP_TABLE)) {
        if (!item.startsWith("mh:")) continue;
        if (CONFIG.guaranteedDropKeys.includes(key)) continue;
        if (chance < minBase || chance >= 1) continue;
        const head = HEAD_BY_BLOCK.get(item);
        if (head) out.push({ block: item, name: head[4], chance });
    }
    return out;
}

/* ---------------- quest generation ---------------- */

function makeCull(rng, tier) {
    const pool = CULL_POOL.filter((e) => e.minTier <= tier);
    const e = pick(rng, pool);
    const scale = 1 + 0.15 * (tier - e.minTier);
    const count = Math.max(1, Math.round(randInt(rng, e.min, e.max) * scale));
    return { type: "cull", tier, mob: e.mob, name: e.name, head: e.head, count, progress: 0, done: false };
}

function makeTarget(rng, tier) {
    const pool = TARGET_POOL.filter((e) => e.minTier <= tier);
    const e = pick(rng, pool);
    return { type: "target", tier, mob: e.mob, name: e.name, head: e.head, dim: e.dim, count: 1, progress: 0, done: false, lost: false, targetId: null };
}

function makeDeliver(rng, tier) {
    const pool = deliverPool(tier);
    if (pool.length === 0) return null;
    const e = pick(rng, pool);
    const count = randInt(rng, 1 + (tier >= 2 ? 1 : 0), 2 + tier);
    return { type: "deliver", tier, head: e.block, name: e.name, count, progress: 0, done: false };
}

/** Build a board of CONFIG.boardSize distinct quests. */
export function generateBoard(rng, rankTier, day, { allowDeliver = true } = {}) {
    const board = [];
    const seen = new Set();
    let guard = 0;
    while (board.length < CONFIG.boardSize && guard++ < 60) {
        const r = rng();
        let tier = rankTier;
        if (r < 0.2) tier = Math.max(0, rankTier - 1);
        else if (r > 0.9) tier = Math.min(MAX_TIER, rankTier + 1);
        const t = rng();
        let q;
        if (t < 0.45) q = makeCull(rng, tier);
        else if (t < 0.7 && allowDeliver) q = makeDeliver(rng, tier);
        else q = makeTarget(rng, tier);
        if (!q) continue;
        const sig = `${q.type}:${q.mob ?? q.head}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        q.id = `d${day}-${board.length}-${Math.floor(rng() * 1e6)}`;
        board.push(q);
    }
    return board;
}

/* ---------------- description ---------------- */

export function questTitle(q) {
    if (q.type === "cull") return `Cull: ${q.count} ${q.name}${q.count > 1 ? "s" : ""}`;
    if (q.type === "deliver") return `Deliver: ${q.count} ${q.name}${q.count > 1 ? "s" : ""}`;
    return `Hunt: Marked ${q.name}`;
}

export function questDescription(q) {
    if (q.type === "cull") return `Slay ${q.count} ${q.name}${q.count > 1 ? "s" : ""} and return to a Monster Hunter.`;
    if (q.type === "deliver") return `Bring ${q.count} raw ${q.name}${q.count > 1 ? "s" : ""} (mob head blocks) to a Monster Hunter.`;
    return `A marked ${q.name} lurks in ${DIM_NAMES[q.dim] ?? q.dim}. Track it down and kill it. Its head is yours.`;
}

export function progressText(q, haveCount = 0) {
    if (q.type === "deliver") return `${Math.min(haveCount, q.count)}/${q.count} in your pack`;
    if (q.type === "target") return q.lost ? "target lost" : q.done ? "target slain" : "target at large";
    return `${q.progress}/${q.count}`;
}

export function isReady(q, haveCount = 0) {
    if (q.type === "deliver") return haveCount >= q.count;
    return q.done === true;
}

/* ---------------- rewards ---------------- */

/** Diamonds every contract pays: Novice 1, Apprentice 2-3, everyone above 3. */
export function diamondRange(tier) {
    if (tier <= 0) return [1, 1];
    if (tier === 1) return [2, 3];
    return [3, 3];
}


export function computeReward(q, rng) {
    const t = q.tier;
    let emeralds, points;
    if (q.type === "cull") {
        emeralds = Math.round(q.count * (0.8 + 0.5 * t));
        points = Math.round(q.count * (1 + t));
    } else if (q.type === "deliver") {
        emeralds = q.count * (6 + 4 * t);
        points = Math.round(q.count * 10 * (1 + 0.5 * t));
    } else {
        emeralds = 12 + 10 * t;
        points = 40 + 30 * t;
    }
    emeralds = Math.max(1, emeralds);

    const items = [];
    for (const e of REWARD_ITEMS[Math.min(t, REWARD_ITEMS.length - 1)]) {
        if (rng() < e.chance) items.push({ id: e.id, amount: randInt(rng, e.min, e.max) });
    }

    let mask = null;
    const chance = CONFIG.maskChanceByTier[Math.min(t, CONFIG.maskChanceByTier.length - 1)] + (q.type === "target" ? 0.1 : 0);
    if (rng() < chance) {
        const own = q.head && (HEAD_BY_BLOCK.get(q.head)?.[0] ?? VANILLA_BY_ITEM.get(q.head)?.[1]);
        mask = own ?? pick(rng, HEADS)[0];
    }

    // Cull quests award a trophy head of the culled mob. Target quests give it on the kill; deliver none.
    const trophy = q.type === "cull" ? q.head ?? null : null;
    const [dLo, dHi] = diamondRange(t);
    const diamonds = randInt(rng, dLo, dHi);
    return { emeralds, points, diamonds, items, mask, trophy };
}
