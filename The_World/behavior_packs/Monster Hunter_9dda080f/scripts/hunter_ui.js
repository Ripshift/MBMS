// Monster Hunter NPC menus. Only ActionFormData is used (button indices are unambiguous).

import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import {
    loadHunter, ensureBoard, acceptQuest, abandonQuest, turnIn, prettyId,
} from "./hunter.js";
import {
    rankIndex, rankName, nextRank, diamondRange, questTitle, questDescription, progressText, isReady, computeReward,
} from "./hunter_logic.js";
import { countItem, showForm } from "./util.js";
import { SHOP, SHOP_TIERS, HEAD_POOLS, unlockedTier, tierUnlockText } from "./shop_data.js";
import { HEAD_BY_ITEM } from "./heads.js";
import { buy } from "./shop.js";

export async function openHunterMenu(player) {
    try {
        let screen = "main";
        while (screen) {
            if (screen === "main") screen = await mainScreen(player);
            else if (screen === "board") screen = await boardScreen(player);
            else if (screen.startsWith("quest:")) screen = await questScreen(player, screen.slice(6));
            else if (screen === "actives") screen = await activesScreen(player);
            else if (screen.startsWith("active:")) screen = await activeScreen(player, screen.slice(7));
            else if (screen === "shop") screen = await shopScreen(player);
            else if (screen === "rank") screen = await rankScreen(player);
            else if (screen === "help") screen = await helpScreen(player);
            else screen = null;
        }
    } catch (e) {
        console.warn(`[MH] hunter menu error: ${e}`);
    }
}

function header(d) {
    const next = nextRank(d.points);
    const nextTxt = next ? ` §7(${next.points - d.points} to ${next.name})` : " §7(max rank)";
    return `§6Rank: §f${rankName(d.points)}${nextTxt}\n§6Points: §f${d.points}   §6Contracts: §f${d.completed}`;
}

async function mainScreen(player) {
    const d = loadHunter(player);
    const f = new ActionFormData().title("§l§6Monster Hunter");
    let body = header(d) + "\n\n";
    const targets = [];
    if (d.actives.length) {
        body += `§eActive contracts (${d.actives.length}/${CONFIG.maxActive}):`;
        for (const q of d.actives) {
            const have = q.type === "deliver" ? countItem(player, q.head) : 0;
            body += `\n§f${questTitle(q)} §7- ${progressText(q, have)}`;
        }
        f.button(`Active Contracts (${d.actives.length}/${CONFIG.maxActive})`);
        targets.push("actives");
    } else {
        body += "§7Ready for a new contract?";
    }
    if (d.actives.length < CONFIG.maxActive) {
        f.button("Contract Board");
        targets.push("board");
    }
    if (unlockedTier(d.points) > 0) {
        f.button("Trade");
        targets.push("shop");
    }
    f.button("Hunter Rank");
    targets.push("rank");
    f.button("How It Works");
    targets.push("help");
    f.button("Close");
    targets.push(null);
    f.body(body);
    const r = await showForm(f, player);
    if (r.canceled) return null;
    return targets[r.selection];
}

async function boardScreen(player) {
    const d = loadHunter(player);
    if (d.actives.length >= CONFIG.maxActive) return "actives";
    const board = ensureBoard(player, d);
    const f = new ActionFormData().title("§l§6Contract Board");
    f.body(board.length ? "Pick a contract. The board refreshes each day." : "No contracts left today. Come back tomorrow.");
    for (const q of board) f.button(`${questTitle(q)}${q.retry ? " §e(retry)" : ""}\n§8Tier ${q.tier + 1}`);
    f.button("Back");
    const r = await showForm(f, player);
    if (r.canceled) return null;
    if (r.selection >= board.length) return "main";
    return `quest:${board[r.selection].id}`;
}

function diamondText(tier) {
    const [lo, hi] = diamondRange(tier);
    return lo === hi ? `${lo} Diamond${lo > 1 ? "s" : ""}` : `${lo}-${hi} Diamonds`;
}

async function questScreen(player, id) {
    const d = loadHunter(player);
    const q = d.board.find((x) => x.id === id);
    if (!q) return "board";
    const preview = computeReward(q, () => 0.999); // deterministic part only
    let body = `${questDescription(q)}\n\n§6Reward:\n§f- ${preview.emeralds} Emeralds\n§f- ${diamondText(q.tier)}\n§f- ${preview.points} Hunter points`;
    if (q.type === "cull" && q.head) body += `\n§f- Trophy: ${prettyId(q.head)}`;
    if (q.type === "target" && q.head) body += `\n§f- Trophy: ${prettyId(q.head)} (on the kill)`;
    body += "\n§7Plus a chance at extra loot and a rare Taxidermy Head.";
    const f = new ActionFormData().title(`§l${questTitle(q)}`).body(body).button("Accept Contract").button("Back");
    const r = await showForm(f, player);
    if (r.canceled) return null;
    if (r.selection === 1) return "board";
    const res = acceptQuest(player, id);
    player.sendMessage(res.msg);
    return res.ok ? null : "board";
}

async function activesScreen(player) {
    const d = loadHunter(player);
    if (!d.actives.length) return "main";
    const f = new ActionFormData().title("§l§6Active Contracts")
        .body(`§7You can carry ${CONFIG.maxActive} contracts at once. Pick one to turn in or abandon.`);
    for (const q of d.actives) {
        const have = q.type === "deliver" ? countItem(player, q.head) : 0;
        f.button(`${questTitle(q)}\n§8${isReady(q, have) ? "§aReady to turn in" : progressText(q, have)}`);
    }
    f.button("Back");
    const r = await showForm(f, player);
    if (r.canceled) return null;
    if (r.selection >= d.actives.length) return "main";
    return `active:${d.actives[r.selection].id}`;
}

async function activeScreen(player, id) {
    const d = loadHunter(player);
    const q = d.actives.find((x) => x.id === id);
    if (!q) return "actives";
    const have = q.type === "deliver" ? countItem(player, q.head) : 0;
    const ready = isReady(q, have);
    let body = `${questDescription(q)}\n\n§6Progress: §f${progressText(q, have)}`;
    if (q.type === "target" && q.lost) body += "\n§cThe target is gone. Abandon this contract.";
    const f = new ActionFormData().title(`§l${questTitle(q)}`).body(body);
    const targets = [];
    if (ready) { f.button("§aTurn In"); targets.push("turnin"); }
    f.button("§cAbandon"); targets.push("abandon");
    f.button("Back"); targets.push("actives");
    const r = await showForm(f, player);
    if (r.canceled) return null;
    const choice = targets[r.selection];
    if (choice === "actives") return "actives";
    if (choice === "abandon") return await confirmAbandon(player, id);
    return await turnInScreen(player, id);
}

async function confirmAbandon(player, id) {
    const f = new ActionFormData().title("Abandon contract?")
        .body("Progress is lost. A marked target will vanish. The first abandoned contract each day returns to the board for a retry.")
        .button("§cYes, abandon").button("No, keep going");
    const r = await showForm(f, player);
    if (r.canceled || r.selection === 1) return `active:${id}`;
    abandonQuest(player, { retry: true, questId: id });
    player.sendMessage("§7Contract abandoned. It stays on the board for a retry if you have one left today.");
    return "main";
}

async function chooseHeadScreen(player, offer) {
    const ids = HEAD_POOLS[offer.give.choose].map((n) => `mh:${n}_head`).filter((id) => HEAD_BY_ITEM.has(id));
    const f = new ActionFormData().title("§l§6Choose a Head")
        .body(`§7Pick the Taxidermy Head you want. Price: §2${offer.price} Emeralds`);
    for (const id of ids) f.button(HEAD_BY_ITEM.get(id)[4]);
    f.button("Back");
    const r = await showForm(f, player);
    if (r.canceled || r.selection >= ids.length) return undefined;
    return ids[r.selection];
}

async function shopScreen(player, note = "") {
    const d = loadHunter(player);
    const open = unlockedTier(d.points);
    const owned = countItem(player, "minecraft:emerald");
    let body = `§aEmeralds: §f${owned}\n`;
    if (note) body += `\n${note}\n`;
    if (open < SHOP_TIERS) body += `\n§7Next stock unlocks at ${tierUnlockText(open + 1)}.`;
    const f = new ActionFormData().title("§l§6Hunter's Wares").body(body);
    const idx = [];
    SHOP.forEach((o, i) => {
        if (o.tier > open) return;
        f.button(`${o.name}\n§8Tier ${o.tier}  -  §2${o.price} Emerald${o.price > 1 ? "s" : ""}`, o.icon);
        idx.push(i);
    });
    f.button("Back");
    const r = await showForm(f, player);
    if (r.canceled) return null;
    if (r.selection >= idx.length) return "main";
    const offerIndex = idx[r.selection];
    const offer = SHOP[offerIndex];
    let choice;
    if (offer.give.choose) {
        choice = await chooseHeadScreen(player, offer);
        if (choice === undefined) return shopScreen(player, "");
    }
    const res = buy(player, offerIndex, choice);
    return shopScreen(player, res.msg);
}

async function turnInScreen(player, id) {
    const res = turnIn(player, id);
    const body = res.ok ? `§aContract complete!\n\n§f${res.lines.join("\n§f")}` : res.lines.join("\n");
    if (res.ok && res.rankUp) {
        player.sendMessage(`§6Hunter Rank up: §f${res.rankUp}`);
        player.onScreenDisplay.setTitle(`§6${res.rankUp}`, { subtitle: "Hunter Rank up", fadeInDuration: 10, stayDuration: 50, fadeOutDuration: 20 });
    }
    const f = new ActionFormData().title(res.ok ? "§l§6Reward" : "Not yet").body(body).button("Back");
    await showForm(f, player);
    return "main";
}

async function rankScreen(player) {
    const d = loadHunter(player);
    const cur = rankIndex(d.points);
    const lines = CONFIG.ranks.map((r, i) => `${i === cur ? "§a> " : "§7  "}${r.name} §8(${r.points}+)`);
    const f = new ActionFormData().title("§l§6Hunter Rank")
        .body(`${header(d)}\n\n${lines.join("\n")}\n\n§7Higher ranks unlock tougher contracts, bigger rewards and rarer Taxidermy Heads.`)
        .button("Back");
    const r = await showForm(f, player);
    return r.canceled ? null : "main";
}

async function helpScreen(player) {
    const f = new ActionFormData().title("§l§6How It Works")
        .body(
            "§61. Take up to two contracts§f from the board: kill a number of mobs, bring heads, or hunt a marked mob.\n\n" +
            "§62. Hunt.§f Mob heads drop rarely when YOU kill a mob. Contracts are the reliable source.\n\n" +
            "§63. Tan it.§f Take a raw mob head to a Hide Tanning Rack with leather to make a wearable Taxidermy Head.\n\n" +
            "§64. Report back§f for emeralds, loot and Hunter Rank.\n\n" +
            "§65. Trade.§f Once you have Hunter points, the hunter sells gear for emeralds. Higher ranks unlock more stock.\n\n" +
            "§6Journal.§f Right-click your Hunter's Journal any time to read your current contracts. Lost it? Craft a new one from a Book and Leather."
        )
        .button("Back");
    const r = await showForm(f, player);
    return r.canceled ? null : "main";
}

// Open the menu when a player interacts with a hunter.
const lastOpen = new Map();
world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
    if (ev.target.typeId !== "mh:monster_hunter") return;
    ev.cancel = true;
    const player = ev.player;
    const now = Date.now();
    if (now - (lastOpen.get(player.id) ?? 0) < 600) return;
    lastOpen.set(player.id, now);
    system.run(() => openHunterMenu(player));
});
