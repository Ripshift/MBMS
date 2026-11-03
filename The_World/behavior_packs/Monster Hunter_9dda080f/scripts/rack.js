// Hide Tanning Rack: raw mob head block + leather -> wearable Taxidermy Head.

import { system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { HEAD_BY_BLOCK } from "./heads.js";
import { VANILLA_BY_ITEM, ICON_ONLY_BLOCKS } from "./vanilla_heads.js";
import { countItem, countMatching, removeItem, giveItem, showForm } from "./util.js";
import { prettyId } from "./hunter.js";

system.beforeEvents.startup.subscribe((init) => {
    init.blockComponentRegistry.registerCustomComponent("mh:tanning_rack", {
        onPlayerInteract(event) {
            const player = event.player;
            if (!player) return;
            system.run(() => openRack(player));
        },
    });
});

async function openRack(player) {
    try {
        let notice = "";
        while (true) {
            // raw mob head blocks AND the vanilla heads (zombie, skeleton, wither skeleton, creeper, piglin)
            const heads = countMatching(player, (id) => (HEAD_BY_BLOCK.has(id) && !ICON_ONLY_BLOCKS.has(id)) || VANILLA_BY_ITEM.has(id));
            const info = (id) => {
                const v = VANILLA_BY_ITEM.get(id);
                return v ? { result: v[1], name: v[2] } : { result: HEAD_BY_BLOCK.get(id)[0], name: HEAD_BY_BLOCK.get(id)[4] };
            };
            const cost = CONFIG.tanningCost;
            const leather = countItem(player, cost.item);
            const costName = prettyId(cost.item);

            const f = new ActionFormData().title("§l§6Hide Tanning Rack");
            let body = `§7Each mask costs §f1 mob head§7 + §f${cost.amount} ${costName}§7.   You have: §f${leather} ${costName}`;
            if (notice) body = `${notice}\n\n${body}`;
            if (heads.size === 0) {
                body += "\n\n§7You have no mob heads. Mobs drop them rarely when you kill them, and Monster Hunters pay them out as trophies.";
            }
            f.body(body);

            const ids = [...heads.keys()].sort();
            for (const id of ids) {
                const h = info(id);
                f.button(`${h.name} x${heads.get(id)}\n§8-> Taxidermy ${h.name}`);
            }
            f.button("Close");

            const r = await showForm(f, player);
            if (r.canceled || r.selection >= ids.length) return;

            const blockId = ids[r.selection];
            const head = info(blockId);
            if (countItem(player, cost.item) < cost.amount) {
                notice = `§cYou need ${cost.amount} ${costName}.`;
                continue;
            }
            if (countItem(player, blockId) < 1) {
                notice = "§cThat head is no longer in your pack.";
                continue;
            }
            removeItem(player, blockId, 1);
            removeItem(player, cost.item, cost.amount);
            giveItem(player, head.result, 1);
            try { player.playSound("armor.equip_leather"); } catch { /* sound optional */ }
            notice = `§aTanned: Taxidermy ${head.name}`;
        }
    } catch (e) {
        console.warn(`[MH] rack error: ${e}`);
    }
}
