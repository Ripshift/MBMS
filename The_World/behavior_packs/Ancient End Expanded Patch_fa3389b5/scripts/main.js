// Ancient End Expanded Patch.
// Vanilla End Expansion changes the top layer of the outer End islands (raw purpur, end sand, nests, plus veins,
// spikes and pools inside it). Ancient End only builds a city where the ground is plain end stone, so without
// this patch most sites would be rejected. This patch registers those blocks as ground through the Ancient End
// ground hook (ae_ae:ground / ae_ae:ready). Neither add-on knows about this patch.
//   /scriptevent vaen_ae_patch:status   -> shows how often the registrations were sent
import { world, system } from "@minecraft/server";

const OWNER = "vaen_ae_patch";

// Blocks that count as ground for a city site (a few per event to keep the command line short).
const GROUPS = [
  ["vaen:raw_purpur_block", "vaen:end_sand", "vaen:endermite_nest"], // the mod's surface blocks
  ["minecraft:blackstone", "minecraft:amethyst_block"],              // veins placed into that surface
  ["minecraft:obsidian", "minecraft:crying_obsidian"],               // obsidian spikes
  ["minecraft:water", "minecraft:flowing_water"],                    // purpur pools
];

const stats = { rounds: 0, sent: 0, failed: 0, lastTick: -1 };

function sendEvent(id, message) {
  try {
    if (typeof system.sendScriptEvent === "function") { system.sendScriptEvent(id, message); return true; }
  } catch (e) { /* fall through to the command */ }
  try {
    world.getDimension("overworld").runCommand(`scriptevent ${id} ${message}`);
    return true;
  } catch (e) {
    return false;
  }
}

// Ancient End keeps registrations in memory only: send on load and whenever it announces itself.
function register() {
  stats.rounds++;
  stats.lastTick = system.currentTick;
  for (const blocks of GROUPS) {
    if (sendEvent("ae_ae:ground", JSON.stringify({ owner: OWNER, blocks }))) stats.sent++;
    else stats.failed++;
  }
}

system.runTimeout(register, 60);

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id === "ae_ae:ready") {
    register();
  } else if (ev.id === "vaen_ae_patch:status") {
    const msg = `Ancient End Expanded Patch: ${GROUPS.length} block groups, ${stats.rounds} registration rounds, ${stats.sent} sent, ${stats.failed} failed (last at tick ${stats.lastTick}).`;
    if (ev.sourceEntity && typeof ev.sourceEntity.sendMessage === "function") ev.sourceEntity.sendMessage(msg);
    else world.sendMessage(msg);
  }
});
