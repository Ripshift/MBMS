import { GameMode, ItemStack, system, world } from "@minecraft/server";

const BOATS = new Map([
  ["labo:warped_boat", "labo:warped_boat"],
  ["labo:crimson_boat", "labo:crimson_boat"],
  ["labo:warped_chest_boat", "labo:warped_chest_boat"],
  ["labo:crimson_chest_boat", "labo:crimson_chest_boat"]
]);

const LAVA = new Set(["minecraft:lava", "minecraft:flowing_lava"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const SURVIVAL_HITS_TO_BREAK = 4;
const HURT_TICKS = 8;

const hitState = new Map();
const hurtUntil = new Map();
const riderState = new Map();

const EXIT_FIRE_TICKS = 120;
const boatFx = new Map();
let tickCounter = 0;

function isNetherBoat(entity) {
  try {
    return !!entity && BOATS.has(entity.typeId);
  } catch {
    return false;
  }
}

function isCreativePlayer(entity) {
  try {
    return entity?.typeId === "minecraft:player" && entity.getGameMode() === GameMode.Creative;
  } catch {
    return false;
  }
}

function setHurtVisual(boat, value) {
  try {
    boat.setProperty("labo:hurt", value);
  } catch {}
}

function markHurt(boat) {
  try {
    setHurtVisual(boat, true);
    hurtUntil.set(boat.id, tickCounter + HURT_TICKS);
  } catch {}
}

function dropContents(boat, dimension, location) {
  try {
    const container = boat.getComponent("minecraft:inventory")?.container;
    if (!container) return;
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (!item) continue;
      dimension.spawnItem(item, { x: location.x, y: location.y + 0.25, z: location.z });
      container.setItem(i, undefined);
    }
  } catch (error) {
    console.warn(`[Vitalli Nether Boats] Chest contents drop failed: ${error}`);
  }
}

function breakBoat(boat, itemId, dropItem) {
  let dimension;
  let location;

  try {
    dimension = boat.dimension;
    location = { ...boat.location };
  } catch {
    return;
  }

  try {
    boat.getComponent("minecraft:rideable")?.ejectRiders();
  } catch {}

  dropContents(boat, dimension, location);

  try {
    hitState.delete(boat.id);
    hurtUntil.delete(boat.id);
    boatFx.delete(boat.id);
    boat.remove();
  } catch {
    return;
  }

  if (!dropItem) return;

  try {
    dimension.spawnItem(
      new ItemStack(itemId, 1),
      { x: location.x, y: location.y + 0.25, z: location.z }
    );
  } catch (error) {
    console.warn(`[Vitalli Nether Boats] Custom boat drop failed: ${error}`);
  }
}

function boatLiquid(boat) {
  let found = null;
  try {
    const { x, y, z } = boat.location;
    const dimension = boat.dimension;
    for (const dy of [0.18, 0.0, -0.18, -0.36]) {
      const block = dimension.getBlock({
        x: Math.floor(x),
        y: Math.floor(y + dy),
        z: Math.floor(z)
      });
      if (!block) continue;
      if (LAVA.has(block.typeId)) return "lava";
      if (WATER.has(block.typeId)) found = "water";
    }
  } catch {}
  return found;
}

function playBoatSounds(boat, liquid) {
  let fx = boatFx.get(boat.id);
  const { x, z } = boat.location;
  if (!fx) {
    fx = { liquid, x, z, nextPaddle: 0, seen: tickCounter };
    boatFx.set(boat.id, fx);
  }

  const moved = Math.hypot(x - fx.x, z - fx.z);
  fx.x = x;
  fx.z = z;
  fx.seen = tickCounter;

  try {
    const at = boat.location;
    const dimension = boat.dimension;

    if (liquid && liquid !== fx.liquid) {
      dimension.playSound(liquid === "lava" ? "liquid.lavapop" : "random.splash", at, { volume: 0.8 });
    }

    if (liquid && moved > 0.04 && tickCounter >= fx.nextPaddle) {
      dimension.playSound("boat.paddle_water", at, { volume: 0.6, pitch: 0.9 + Math.random() * 0.2 });
      if (liquid === "lava" && Math.random() < 0.3) {
        dimension.playSound("liquid.lavapop", at, { volume: 0.4 });
      }
      fx.nextPaddle = tickCounter + 12;
    }
  } catch {}

  fx.liquid = liquid;
}

function handleDismount(player, prev) {
  if (!prev.lava) return;

  try {
    player.addEffect("fire_resistance", EXIT_FIRE_TICKS, { amplifier: 0, showParticles: false });
  } catch {}
}

world.afterEvents.entityHitEntity.subscribe((event) => {
  const boat = event.hitEntity;
  const itemId = BOATS.get(boat?.typeId);
  if (!itemId) return;

  markHurt(boat);

  const attacker = event.damagingEntity;
  if (isCreativePlayer(attacker)) {
    system.run(() => breakBoat(boat, itemId, false));
    return;
  }

  let state = hitState.get(boat.id);
  if (!state || tickCounter - state.lastHitTick > 100) {
    state = { hits: 0, lastHitTick: tickCounter };
  }

  state.hits += 1;
  state.lastHitTick = tickCounter;
  hitState.set(boat.id, state);

  if (state.hits >= SURVIVAL_HITS_TO_BREAK) {
    system.run(() => breakBoat(boat, itemId, true));
  }
});

system.runInterval(() => {
  tickCounter++;

  for (const [boatId, until] of hurtUntil) {
    if (until > tickCounter) continue;

    hurtUntil.delete(boatId);
    try {
      const entity = world.getEntity(boatId);
      if (entity) setHurtVisual(entity, false);
    } catch {}
  }

  for (const [boatId, state] of hitState) {
    if (tickCounter - state.lastHitTick > 100) hitState.delete(boatId);
  }

  if (tickCounter % 200 === 0) {
    for (const [boatId, fx] of boatFx) {
      if (tickCounter - fx.seen > 200) boatFx.delete(boatId);
    }
  }

  const present = new Set();

  for (const player of world.getAllPlayers()) {
    present.add(player.id);

    let boat;
    try {
      boat = player.getComponent("minecraft:riding")?.entityRidingOn;
    } catch {
      continue;
    }

    const prev = riderState.get(player.id);

    if (!isNetherBoat(boat)) {
      if (prev) {
        riderState.delete(player.id);
        handleDismount(player, prev);
      }
      continue;
    }

    let state = prev;
    if (!state) {
      state = { lava: false, location: { ...boat.location }, dimensionId: boat.dimension.id };
      riderState.set(player.id, state);
    }
    try {
      state.location = { ...boat.location };
      state.dimensionId = boat.dimension.id;
    } catch {}

    if (tickCounter % 2 !== 0) continue;

    const liquid = boatLiquid(boat);
    playBoatSounds(boat, liquid);
    state.lava = liquid === "lava";
    if (!state.lava) continue;

    let riders = [player];
    try {
      riders = boat.getComponent("minecraft:rideable")?.getRiders() ?? riders;
    } catch {}

    for (const rider of riders) {
      try {
        const current = rider.getEffect("fire_resistance");
        if (current && current.duration > 10) continue;
        rider.addEffect("fire_resistance", 20, { amplifier: 0, showParticles: false });
      } catch {}
    }
  }

  for (const id of riderState.keys()) {
    if (!present.has(id)) riderState.delete(id);
  }
}, 1);
