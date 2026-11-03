// Ancient End Compass Patch (ae_ac): tells Compass Plus where the Ancient End cities are.
// Every city contains one invisible marker entity (ancientend:city_marker, defined by the Ancient End pack).
// When a city generates (or its chunks load) the marker is seen here, the city position is saved, and the
// position is sent to Compass Plus with the script event "ae_cp:site". Compass Plus lists the nearest one
// as "Ancient End City" in the End. The two packs are not linked in any other way.
import { system, world } from "@minecraft/server";

const CONFIG = {
  markerId: "ancientend:city_marker",
  cityName: "Ancient End City", // shown in the compass (Compass Plus cuts names at 20 characters)
  sameCityRadius: 24, // markers closer than this (blocks) are the same city
  scanTicks: 100, // how often loaded End chunks are searched for markers (a backup for the spawn event)
  debug: false,
};

const PROP = "ae_ac:cities";
let cities = []; // [{d,x,y,z}]
try {
  cities = JSON.parse(world.getDynamicProperty(PROP) ?? "[]");
} catch (e) {
  cities = [];
}
const saveCities = () => world.setDynamicProperty(PROP, JSON.stringify(cities));
const log = (m) => CONFIG.debug && console.warn(`[ae_ac] ${m}`);

// Compass Plus listens for this event. /scriptevent works between add-ons and does not need Compass Plus to be installed.
function send(c) {
  try {
    const message = JSON.stringify({ src: "ancientend", name: CONFIG.cityName, d: c.d, x: c.x, y: c.y, z: c.z });
    world.getDimension("minecraft:overworld").runCommand(`scriptevent ae_cp:site ${message}`);
  } catch (e) {
    console.warn(`[ae_ac] could not send a city to Compass Plus: ${e}`);
  }
}

function sendAll() {
  for (const c of cities) send(c);
}

function record(entity) {
  try {
    if (!entity?.isValid || entity.typeId !== CONFIG.markerId) return;
    const l = entity.location;
    const c = { d: entity.dimension.id, x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) };
    if (cities.some((o) => o.d === c.d && Math.hypot(o.x - c.x, o.z - c.z) < CONFIG.sameCityRadius)) return;
    cities.push(c);
    saveCities();
    send(c);
    log(`city recorded at ${c.x} ${c.y} ${c.z} (${c.d})`);
  } catch (e) {
    log(`record failed: ${e}`);
  }
}

world.afterEvents.entitySpawn.subscribe((event) => record(event.entity));
world.afterEvents.entityLoad?.subscribe((event) => record(event.entity));

// Backup: look for markers in the loaded chunks of the End now and then (only while someone is there).
system.runInterval(() => {
  try {
    const end = world.getDimension("minecraft:the_end");
    if (!world.getAllPlayers().some((p) => p.dimension.id === end.id)) return;
    for (const e of end.getEntities({ type: CONFIG.markerId })) record(e);
  } catch (e) {
    /* chunks loading */
  }
}, CONFIG.scanTicks);

// Compass Plus asks for the list when it starts (hello); also send it once after loading in case it started first.
system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id === "ae_cp:hello") sendAll();
});
system.runTimeout(sendAll, 100);
