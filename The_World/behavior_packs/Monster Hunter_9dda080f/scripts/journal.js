// Hunter's Journal: right-click the item to read your current contract(s). It is a custom item rather than a
// written book because scripts cannot write book pages. The entries are rebuilt every time it is opened, so a
// contract appears when accepted and disappears when completed, failed or abandoned.

import { world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { loadHunter, prettyId } from "./hunter.js";
import { rankName, nextRank, questTitle, questDescription, progressText } from "./hunter_logic.js";
import { DIM_NAMES } from "./quest_data.js";
import { countItem, showForm } from "./util.js";

export const JOURNAL_ID = "mh:hunter_journal";

/** Every contract the player currently has (up to CONFIG.maxActive). */
export function activeContracts(d) {
    return d.actives ?? [];
}

export function journalText(player, d) {
    const lines = [];
    const next = nextRank(d.points);
    lines.push(`§6Rank: §f${rankName(d.points)}${next ? ` §7(${next.points - d.points} points to ${next.name})` : " §7(max rank)"}`);
    lines.push("");
    const list = activeContracts(d);
    if (list.length === 0) {
        lines.push("§cYou don't have any contracts.", "§7Go see a Monster Hunter to pick one up.");
    }
    list.forEach((q, i) => {
        const have = q.type === "deliver" ? countItem(player, q.head) : 0;
        lines.push(`§l§6${list.length > 1 ? `${i + 1}. ` : ""}${questTitle(q)}§r`);
        lines.push(`§7${questDescription(q)}`);
        lines.push(`§eProgress: §f${progressText(q, have)}`);
        if (q.type === "target") {
            lines.push(q.lost ? "§cThe target is gone. Abandon this contract at a Monster Hunter."
                : `§7Hunt it in ${DIM_NAMES[q.dim] ?? q.dim}. Turn toward the gold marker on the action bar.`);
        }
        if (q.type === "deliver") lines.push(`§7Hand in raw ${prettyId(q.head)}s at a Monster Hunter.`);
        if (q.retry) lines.push("§eThis is a retry.");
        if (q.done) lines.push("§aReady to hand in at a Monster Hunter.");
        lines.push("");
    });
    const retriesLeft = Math.max(0, CONFIG.retriesPerDay - (d.retryDay === d.boardDay ? d.retriesUsed ?? 0 : 0));
    lines.push(`§8Contracts: ${list.length}/${CONFIG.maxActive}   Retries left today: ${retriesLeft}`);
    return lines.join("\n");
}

export async function openJournal(player) {
    try {
        const d = loadHunter(player);
        const f = new ActionFormData().title("§l§6Hunter's Journal").body(journalText(player, d)).button("Close");
        await showForm(f, player);
    } catch (e) {
        console.warn(`[MH] journal error: ${e}`);
    }
}

world.afterEvents.itemUse.subscribe((event) => {
    if (event.itemStack?.typeId !== JOURNAL_ID || !event.source) return;
    openJournal(event.source);
});
