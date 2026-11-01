// Ancient End (ancientend): places the Ancient End cities with a script instead of a feature rule.
// A world feature can only write inside the chunk being generated, so a 48 x 48 city came out cut into
// floating pieces. Here the whole structure is placed in one piece, and only where it fits.
//
// How it works:
//  * The End is split into square cells (cellSize). Each cell may hold one city (chance), at a position
//    that is fixed for the world (hash of a per-world seed), with up to "attempts" alternative positions.
//  * While a player is in the End, cells near them are looked at. A position is judged only when its whole
//    footprint is loaded: a 7 x 7 grid of columns must have a solid end stone surface (or a registered ground block, see the ground hook below) and end stone all the way
//    down to (city bottom + maxOverhang), and the surface may not vary more than maxVariation.
//    A site that would hang over the void is skipped (next position, then the cell stays empty).
//  * Half of the cities (fixed per cell) are turned 180 degrees so they do not all face the same way. How the game
//    positions a rotated structure is not documented, so it is measured once per world with a tiny test structure
//    (placed high in the air and removed again). If that fails, no city is turned. 90 degrees is not used: the end
//    stone pillars keep their axis in a state that a structure rotation may not swap.
//  * The city is placed with its top layer level with the LOWEST sampled surface point, so its sides are never
//    exposed above the ground. Result is saved per cell, so a city is never placed twice.
// The invisible ancientend:city_marker inside the structure lets the Compass Patch find every city.
//
// Test commands (chat):  /scriptevent ae_ae:status   (counts, last failure reasons)
//                        /scriptevent ae_ae:reset    (forget all cells; existing cities stay in the world)
import { BlockPermutation, StructureRotation, system, world } from "@minecraft/server";

const CONFIG = {
  structureId: "ancientendcity:ancientendcity",
  dimension: "minecraft:the_end",
  cellSize: 256, // blocks; one city at most per cell
  chance: 0.6, // chance that a cell has a city at all (0..1)
  attempts: 8, // different positions tried inside a cell before it stays empty
  margin: 8, // keep this far from the cell edge so neighbouring cities cannot touch
  scanRadius: 96, // cells within this distance of a player are looked at
  mainIslandRadius: 150, // no city whose centre is closer than this to (0, 0): dragon island
  maxOverhang: 6, // how many of the lowest city layers may stick out below the island
  maxVariation: 20, // largest allowed difference between the highest and lowest surface sample
  checksPerRun: 2, // positions judged per run (each one reads about 1000-2000 blocks)
  runTicks: 20,
  rotate180: true, // turn half of the cities by 180 degrees (needs the one-time measurement)
  debug: false, // log placements and failure reasons to the content log
};

const PROP_SEED = "ae_ae:seed";
const PROP_ROT = "ae_ae:rot180"; // measured result: { o: [dx, dz], ex: [ex, ez] } (see calibrate)
const PROP_CELLS = "ae_ae:cells"; // { "cx,cz": 0 (finished, empty) | n (positions already failed) | [x,y,z] (city placed) }
const AIR_LIKE = new Set(["minecraft:air"]);
const CHORUS = new Set(["minecraft:chorus_plant", "minecraft:chorus_flower"]);

// Ground hook: other add-ons (patches) can register block ids that count as "end stone" for the site check
// (surface and the solid column below it), for worlds where another add-on changes the End surface:
//   /scriptevent ae_ae:ground {"owner":"some_id","blocks":["ns:block","ns:other"]}
// Registrations are kept in memory only; Ancient End sends  ae_ae:ready  shortly after loading and the add-ons
// send again. Air is refused. Nothing in this file knows which add-ons use it.
const GROUND = new Map(); // block id -> owner
const NEVER_GROUND = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const isGround = (id) => id === "minecraft:end_stone" || GROUND.has(id);

let seed;
let cells;
let size;
let structureMissing = false;
let rot; // measured 180 degree placement, undefined = not available
let calibTried = false;
const recent = []; // last failure reasons, for /scriptevent ae_ae:status

const log = (m) => CONFIG.debug && console.warn(`[ae_ae] ${m}`);
const note = (m) => {
  recent.push(m);
  if (recent.length > 8) recent.shift();
  log(m);
};

function ensureState() {
  if (cells) return;
  seed = world.getDynamicProperty(PROP_SEED);
  if (typeof seed !== "number") {
    seed = Math.floor(Math.random() * 2147483647);
    world.setDynamicProperty(PROP_SEED, seed);
  }
  try {
    cells = JSON.parse(world.getDynamicProperty(PROP_CELLS) ?? "{}");
  } catch (e) {
    cells = {};
  }
  try {
    const saved = JSON.parse(world.getDynamicProperty(PROP_ROT) ?? "null");
    if (saved?.o && saved?.ex) rot = saved;
  } catch (e) {
    rot = undefined;
  }
}

const saveCells = () => world.setDynamicProperty(PROP_CELLS, JSON.stringify(cells));

// deterministic 0..1 value from (cell x, cell z, n) and the world seed
function rnd(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Measure where a structure placed with Rotate180 ends up. A 3 x 1 x 2 test structure with a gold block at its local
// corner (0,0,0) and an emerald block at (2,0,0) is placed high above a player, the two blocks are located, and the
// blocks are removed again. o = where the local corner went (relative to the placement point), ex = where local +x points.
function calibrate(dim, player) {
  const id = "ae_ae:calib";
  try {
    try {
      world.structureManager.delete(id);
    } catch (e) {
      /* none yet */
    }
    const s = world.structureManager.createEmpty(id, { x: 3, y: 1, z: 2 });
    s.setBlockPermutation({ x: 0, y: 0, z: 0 }, BlockPermutation.resolve("minecraft:gold_block"));
    s.setBlockPermutation({ x: 2, y: 0, z: 0 }, BlockPermutation.resolve("minecraft:emerald_block"));
    const P = { x: Math.floor(player.location.x), y: dim.heightRange.max - 8, z: Math.floor(player.location.z) };
    world.structureManager.place(id, dim, P, { rotation: StructureRotation.Rotate180, includeEntities: false, includeBlocks: true });
    let gold, emerald;
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        const b = dim.getBlock({ x: P.x + dx, y: P.y, z: P.z + dz });
        if (b?.typeId === "minecraft:gold_block") gold = { b, dx, dz };
        else if (b?.typeId === "minecraft:emerald_block") emerald = { b, dx, dz };
      }
    }
    if (gold) gold.b.setType("minecraft:air");
    if (emerald) emerald.b.setType("minecraft:air");
    try {
      world.structureManager.delete(id);
    } catch (e) {
      /* ignore */
    }
    if (!gold || !emerald) throw new Error("test blocks not found");
    const ex = [(emerald.dx - gold.dx) / 2, (emerald.dz - gold.dz) / 2];
    if (Math.abs(ex[0]) + Math.abs(ex[1]) !== 1) throw new Error(`unexpected direction ${ex}`);
    rot = { o: [gold.dx, gold.dz], ex };
    world.setDynamicProperty(PROP_ROT, JSON.stringify(rot));
    log(`rotation measured: corner -> ${rot.o}, +x -> ${rot.ex}`);
  } catch (e) {
    rot = undefined;
    console.warn(`[ae_ae] rotation measurement failed, cities will not be turned: ${e}`);
  }
}

// Placement point for a turned city whose footprint should start at (x0, z0).
function anchorFor(x0, z0) {
  const ez = [-rot.ex[1], rot.ex[0]]; // local +z (a turn keeps the handedness)
  let minX = Infinity;
  let minZ = Infinity;
  for (const lx of [0, size.x - 1]) {
    for (const lz of [0, size.z - 1]) {
      minX = Math.min(minX, rot.o[0] + lx * rot.ex[0] + lz * ez[0]);
      minZ = Math.min(minZ, rot.o[1] + lx * rot.ex[1] + lz * ez[1]);
    }
  }
  return { x: x0 - minX, z: z0 - minZ };
}

// Judge one position (x0, z0 = corner of the footprint). Returns {loaded:false}, {ok:false, reason} or {ok:true, y0}.
function evaluate(dim, x0, z0) {
  const offs = (n) => Array.from({ length: 7 }, (_, i) => Math.round((i * (n - 1)) / 6));
  const xs = offs(size.x).map((o) => x0 + o);
  const zs = offs(size.z).map((o) => z0 + o);
  const cols = [];
  try {
    for (const x of xs) {
      for (const z of zs) {
        if (!dim.getBlock({ x, y: 64, z })) return { loaded: false }; // chunk not loaded yet
        const top = dim.getTopmostBlock({ x, z });
        if (!top || AIR_LIKE.has(top.typeId)) return { ok: false, reason: `void at ${x},${z}` };
        let y = top.y;
        let id = top.typeId;
        while (CHORUS.has(id)) {
          y--;
          const b = dim.getBlock({ x, y, z });
          if (!b) return { loaded: false };
          id = b.typeId;
        }
        if (AIR_LIKE.has(id)) return { ok: false, reason: `void at ${x},${z}` };
        if (!isGround(id)) return { ok: false, reason: `${id} at ${x},${z}` };
        cols.push({ x, z, y });
      }
    }
    const ys = cols.map((c) => c.y);
    const topSolid = Math.min(...ys);
    if (Math.max(...ys) - topSolid > CONFIG.maxVariation) return { ok: false, reason: `surface varies ${Math.max(...ys) - topSolid}` };
    const y0 = topSolid - (size.y - 1);
    if (y0 < dim.heightRange.min) return { ok: false, reason: "too low" };
    const needBottom = y0 + CONFIG.maxOverhang;
    for (const c of cols) {
      for (let y = c.y; y >= needBottom; y--) {
        const b = dim.getBlock({ x: c.x, y, z: c.z });
        if (!b) return { loaded: false };
        if (!isGround(b.typeId)) return { ok: false, reason: `not solid down to y${needBottom} at ${c.x},${c.z}` };
      }
    }
    return { ok: true, y0 };
  } catch (e) {
    return { loaded: false }; // chunk not loaded (yet)
  }
}

function run() {
  try {
    const dim = world.getDimension(CONFIG.dimension);
    const players = dim.getPlayers();
    if (players.length === 0) return;
    if (structureMissing) return;
    if (!size) {
      const s = world.structureManager.get(CONFIG.structureId);
      if (!s) {
        structureMissing = true;
        console.warn(`[ae_ae] structure ${CONFIG.structureId} not found; no cities will be placed`);
        return;
      }
      size = s.size;
    }
    ensureState();
    if (CONFIG.rotate180 && !rot && !calibTried) {
      calibTried = true;
      calibrate(dim, players[0]);
    }
    let budget = CONFIG.checksPerRun;
    let changed = false;
    const C = CONFIG.cellSize;
    for (const p of players) {
      const r = CONFIG.scanRadius;
      for (let cx = Math.floor((p.location.x - r) / C); cx <= Math.floor((p.location.x + r) / C); cx++) {
        for (let cz = Math.floor((p.location.z - r) / C); cz <= Math.floor((p.location.z + r) / C); cz++) {
          const key = `${cx},${cz}`;
          let state = cells[key];
          if (state === 0 || Array.isArray(state)) continue; // finished
          if (state === undefined) {
            if (rnd(cx, cz, 0) >= CONFIG.chance) {
              cells[key] = 0;
              changed = true;
              continue;
            }
            cells[key] = -1; // -1 = this cell has a city, no position tried yet (n > 0 = n positions already failed)
            changed = true;
          }
          let tried = cells[key] === -1 ? 0 : cells[key];
          while (budget > 0) {
            if (tried >= CONFIG.attempts) {
              cells[key] = 0;
              changed = true;
              note(`cell ${key}: no suitable site (${tried} tried)`);
              break;
            }
            const span = C - 2 * CONFIG.margin;
            const x0 = cx * C + CONFIG.margin + Math.floor(rnd(cx, cz, 2 * tried + 1) * Math.max(1, span - size.x));
            const z0 = cz * C + CONFIG.margin + Math.floor(rnd(cx, cz, 2 * tried + 2) * Math.max(1, span - size.z));
            const centre = Math.hypot(x0 + size.x / 2, z0 + size.z / 2);
            if (centre < CONFIG.mainIslandRadius) {
              tried++;
              cells[key] = tried;
              changed = true;
              note(`site ${x0},${z0}: too close to the dragon island`);
              continue;
            }
            const res = evaluate(dim, x0, z0);
            if (res.loaded === false) break; // wait until the chunks are loaded; the cell is looked at again later
            budget--;
            if (!res.ok) {
              tried++;
              cells[key] = tried;
              changed = true;
              note(`site ${x0},${z0}: ${res.reason}`);
              continue;
            }
            try {
              const turned = CONFIG.rotate180 && rot !== undefined && rnd(cx, cz, 99) < 0.5;
              const at = turned ? anchorFor(x0, z0) : { x: x0, z: z0 };
              const options = { includeEntities: true, includeBlocks: true };
              if (turned) options.rotation = StructureRotation.Rotate180;
              world.structureManager.place(CONFIG.structureId, dim, { x: at.x, y: res.y0, z: at.z }, options);
              cells[key] = [x0, res.y0, z0, turned ? 180 : 0];
              changed = true;
              log(`CITY placed at ${x0} ${res.y0} ${z0}${turned ? " (turned 180)" : ""}`);
            } catch (e) {
              tried++;
              cells[key] = tried;
              changed = true;
              note(`site ${x0},${z0}: place failed (${e})`);
            }
            break;
          }
          if (budget <= 0) break;
        }
        if (budget <= 0) break;
      }
      if (budget <= 0) break;
    }
    if (changed) saveCells();
  } catch (e) {
    console.warn(`[ae_ae] run failed: ${e}`);
  }
}

system.runInterval(run, CONFIG.runTicks);

// Tell add-ons that registered blocks are kept in memory only: they send their registrations again on this.
function announce() {
  try {
    if (typeof system.sendScriptEvent === "function") system.sendScriptEvent("ae_ae:ready", "1");
    else world.getDimension("overworld").runCommand("scriptevent ae_ae:ready 1");
  } catch (e) {
    log(`ae_ae:ready not sent: ${e}`);
  }
}
system.runTimeout(announce, 20);

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "ae_ae:ground") return;
  try {
    const m = JSON.parse(event.message);
    const owner = typeof m.owner === "string" && m.owner ? m.owner : "unknown";
    let added = 0;
    for (const id of Array.isArray(m.blocks) ? m.blocks : []) {
      if (typeof id !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) || NEVER_GROUND.has(id)) {
        console.warn(`[ae_ae] ground: refused "${id}" from ${owner}`);
        continue;
      }
      if (!GROUND.has(id)) {
        GROUND.set(id, owner);
        added++;
      }
    }
    if (added > 0) log(`ground: ${owner} registered ${added} block(s), ${GROUND.size} in total`);
  } catch (e) {
    console.warn(`[ae_ae] ground: bad registration (${e})`);
  }
});

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "ae_ae:status" && event.id !== "ae_ae:reset") return;
  try {
    ensureState();
    const tell = (m) => (event.sourceEntity?.sendMessage ? event.sourceEntity.sendMessage(m) : world.sendMessage(m));
    if (event.id === "ae_ae:reset") {
      cells = {};
      saveCells();
      rot = undefined;
      calibTried = false;
      world.setDynamicProperty(PROP_ROT, undefined);
      return tell("§e[Ancient End]§r all cells forgotten (cities already in the world stay)");
    }
    const placed = Object.entries(cells).filter(([, v]) => Array.isArray(v));
    const empty = Object.values(cells).filter((v) => v === 0).length;
    const pending = Object.values(cells).filter((v) => typeof v === "number" && v !== 0).length;
    tell(`§e[Ancient End]§r cities placed: ${placed.length}, empty cells: ${empty}, in progress: ${pending}, rotation: ${rot ? "measured" : "off"}, extra ground blocks: ${GROUND.size}`);
    for (const [, v] of placed.slice(-5)) tell(`  city at ${v[0]} ${v[1]} ${v[2]}${v[3] === 180 ? " (turned 180)" : ""}`);
    for (const m of recent.slice(-5)) tell(`  §7${m}`);
  } catch (e) {
    console.warn(`[ae_ae] status failed: ${e}`);
  }
});
