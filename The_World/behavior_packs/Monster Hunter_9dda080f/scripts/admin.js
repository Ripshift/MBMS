// Operator test commands (scriptevent needs operator permission).
//   /scriptevent mh:givehead cow        raw head block   (use the key from heads.js, e.g. cow, angry_bee, wolf_head)
//   /scriptevent mh:givemask cow        Taxidermy Head
//   /scriptevent mh:rank 300            set your Hunter points
//   /scriptevent mh:newboard            reroll today's contracts
//   /scriptevent mh:reset               wipe your Hunter data
//   /scriptevent mh:hunter              spawn a Monster Hunter beside you

import { system } from "@minecraft/server";
import { loadHunter, saveHunter, setPoints, resetHunter } from "./hunter.js";
import { giveItem } from "./util.js";
import { spawnHunterNear } from "./village.js";

system.afterEvents.scriptEventReceive.subscribe((ev) => {
    if (!ev.id.startsWith("mh:")) return;
    const player = ev.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    const cmd = ev.id.slice(3);
    const arg = ev.message.trim();

    if (cmd === "givehead" || cmd === "givemask") {
        if (!arg) return player.sendMessage("§cUsage: /scriptevent mh:" + cmd + " <mob>   e.g. cow");
        const base = arg.endsWith("_head") ? arg : `${arg}_head`;
        const id = cmd === "givehead" ? `mh:${base}_block` : `mh:${base}`;
        giveItem(player, id, 1);
        player.sendMessage(`§aGave ${id}`);
    } else if (cmd === "rank") {
        const n = parseInt(arg, 10);
        if (Number.isNaN(n)) return player.sendMessage("§cUsage: /scriptevent mh:rank <points>");
        setPoints(player, n);
        player.sendMessage(`§aHunter points set to ${n}`);
    } else if (cmd === "newboard") {
        const d = loadHunter(player);
        d.boardDay = -1;
        saveHunter(player, d);
        player.sendMessage("§aBoard will reroll when you next open it.");
    } else if (cmd === "reset") {
        resetHunter(player);
        player.sendMessage("§aHunter data reset.");
    } else if (cmd === "hunter") {
        spawnHunterNear(player.dimension, player.location);
    }
});
