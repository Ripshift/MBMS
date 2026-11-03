// Backpacker (bapa:) - server-friendly backpacks.
// Based on BackpackPlus by Behold Studio. The storage layer was rewritten:
//  - A placed backpack keeps its items only in its container entity (the game saves that natively).
//  - A picked-up backpack keeps its FULL contents (27 / 54 slots) in ONE structure file ("vault") per backpack.
//    The item carries the vault id twice: as a dynamic property and as a hidden lore line. The vault is saved and
//    verified before the placed backpack is removed, and it is deleted only after a successful restore.
//  - Items are never rebuilt from scratch: enchantments, shulker contents, names ... travel inside the vault structure.
import {
	BlockPermutation,
	EquipmentSlot,
	GameMode,
	ItemStack,
	StructureSaveMode,
	system,
	world
} from "@minecraft/server";

// ---- Server settings (edit here) ------------------------------------------------------------
const CONFIG = {
	// How many backpacks one player may carry. 0 = unlimited. Creative players are exempt.
	maxBackpacksPerPlayer: 2,
	// Only backpacks within this many blocks of a player are checked for button clicks.
	buttonScanRadius: 8,
	// Prints what happens on placing / picking up to the chat and the content log. Set to false when everything works.
	debug: true
};

const BACKPACK_ENTITY = "bapa:backpack_container";
const LARGE_BACKPACK_ENTITY = "bapa:large_backpack_container";
const BACKPACK_ENTITY_TYPES = [BACKPACK_ENTITY, LARGE_BACKPACK_ENTITY];
const BACKPACK_FAMILY = "bapa_container";
const BACKPACK_TYPE = "bapa:backpack";
const LARGE_BACKPACK_TYPE = "bapa:large_backpack";
const BACKPACK_TAG_PREFIX = "bapa_backpack:";
const BACKPACK_TYPE_TAG_PREFIX = "bapa_type:";
const BACKPACK_NAMESPACE = "bapa:";
const BACKPACK_SUFFIX = "backpack";
const LARGE_BACKPACK_SUFFIX = "large_backpack";
const BACKPACK_EQUIPPED_SUFFIX = "_equipped";
const BACKPACK_SCAN_RADIUS = 1.5;
const BACKPACK_SLOT_COUNT = 27;
const LARGE_BACKPACK_SLOT_COUNT = 54;
const LARGE_BACKPACK_TITLE = "Large Backpack";
const BACKPACK_FILTER_BUTTON_ITEM = "bapa:backpack_filter_button";
const BACKPACK_TRANSFER_BUTTON_ITEM = "bapa:backpack_transfer_button";
const BACKPACK_FILTER_SORT_MODES = [
	{ id: "items_first", message: "§bFilter 1/3: items, then blocks." },
	{ id: "blocks_first", message: "§bFilter 2/3: blocks, then items." },
	{ id: "fullest_first", message: "§bFilter 3/3: fullest stacks first." }
];
const BACKPACK_FILTER_BUTTON_CLEANUP_RADIUS = 8;
const BACKPACK_TRANSFER_BUTTON_CLEANUP_RADIUS = 8;
const BACKPACK_LIMIT_WARNING_COOLDOWN_MS = 2000;
const BACKPACK_LIMIT_DROP_DISTANCE = 3.25;
const BACKPACK_LIMIT_DROP_UPWARD_OFFSET = 0.8;
const BACKPACK_LIMIT_DROP_IMPULSE = 0.38;
const BACKPACK_LIMIT_DROP_VERTICAL_IMPULSE = 0.16;
const BACKPACK_LIMIT_PARTICLE_COUNT = 6;
const BACKPACK_PENDING_MAX_AGE_MS = 1500;
const BACKPACK_INFO_LORE_PREFIX = "§7Stored: ";
const BACKPACK_DIMENSIONS = ["overworld", "nether", "the_end"];

// Tick intervals
const BUTTON_POLL_INTERVAL_TICKS = 1;
const OFFHAND_SYNC_INTERVAL_TICKS = 5;
const FULL_INVENTORY_SYNC_EVERY = 8; // every 8th offhand sync also scans the whole inventory
const LIMIT_CHECK_INTERVAL_TICKS = 20;
const SWEEP_INTERVAL_TICKS = 40;

// Vault (structure) storage
const VAULT_ITEM_PROPERTY = "bapa:vault";
const LORE_SENTINEL = "\u00a7r\u00a7r\u00a7r"; // marks the hidden lore line that repeats the vault id
const VAULT_MARKER_PREFIX = "bapa:p_";
const VAULT_STRUCTURE_PREFIX = "bapa:v_";
const VAULT_BARREL = "minecraft:barrel";
const VAULT_CELL_SLOTS = 27;
const VAULT_SEARCH_DEPTH = 8;
const VAULT_SAFE_BLOCKS = new Set(["minecraft:air", "minecraft:bedrock", "minecraft:void_air", "minecraft:cave_air"]);

const pendingPlacements = new Map();
const activeBreaks = new Set();
const swapBlocked = new Set();
const ACCESSORY_PROPERTY = "bapa:acc"; // on the item: "", "l", "n", "s", "ln" or "ls" (what hangs from the backpack)
const STATE_LAVA = "bapa:lava";
const STATE_LAMP = "bapa:lamp"; // 0 none, 1 lantern, 2 soul lantern
const ACCESSORY_SCAN_RADIUS = 32;
const ACCESSORY_SCAN_INTERVAL_TICKS = 20;
const LIGHT_BLOCK_PREFIX = "minecraft:light_block_";
const STATE_DARK = "bapa:dark"; // 1 = the player switched the backpack's light off
const DARK_PROPERTY = "bapa:dark"; // same, kept on the item while it is carried
const lightButtonStates = new Map();
const wornLights = new Map(); // player key -> { dimensionId, x, y, z }
const backpackLimitWarnings = new Map();
const backpackFilterButtonStates = new Map();
const backpackTransferButtonStates = new Map();
const backpackBlockItemTypeCache = new Map();
let offhandSyncCounter = 0;

function debugLog(message, player) {
	if (!CONFIG.debug) return;
	console.warn(`[bapa] ${message}`);
	if (player) {
		try { player.sendMessage(`§8[bapa] ${message}`); } catch { }
	}
}

// ---- carried over from BackpackPlus (button handling, filter, transfer) ----

function safeGet(getter, fallback = undefined) {
	try {
		return getter();
	} catch {
		return fallback;
	}
}

function isBaseBackpackTypeId(typeId) {
	return typeof typeId === "string"
		&& typeId.startsWith(BACKPACK_NAMESPACE)
		&& typeId.endsWith(BACKPACK_SUFFIX);
}

function normalizeBackpackTypeId(typeId) {
	if (typeof typeId !== "string") return typeId;
	const match = /^(.*)_equipped(?:_(?:l|n|s|ln|ls))?$/.exec(typeId);
	return match && isBaseBackpackTypeId(match[1]) ? match[1] : typeId;
}

function isEquippedBackpackTypeId(typeId) {
	return typeof typeId === "string" && /_equipped(?:_(?:l|n|s|ln|ls))?$/.test(typeId)
		&& isBaseBackpackTypeId(normalizeBackpackTypeId(typeId)) && normalizeBackpackTypeId(typeId) !== typeId;
}

function getEquippedBackpackTypeId(typeId, accessory) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	return isBaseBackpackTypeId(normalizedTypeId)
		? `${normalizedTypeId}${BACKPACK_EQUIPPED_SUFFIX}${accessory ? `_${accessory}` : ""}`
		: undefined;
}

function isBackpackTypeId(typeId) {
	return isBaseBackpackTypeId(normalizeBackpackTypeId(typeId));
}

function isLargeBackpackTypeId(typeId) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	return typeof typeId === "string"
		&& normalizedTypeId.startsWith(BACKPACK_NAMESPACE)
		&& normalizedTypeId.endsWith(LARGE_BACKPACK_SUFFIX);
}

function toTitleCase(value) {
	return String(value ?? "")
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function getBackpackContainerTitle(typeId) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!isBackpackTypeId(normalizedTypeId)) return "Backpack";

	const localId = normalizedTypeId.slice(BACKPACK_NAMESPACE.length);
	if (localId === LARGE_BACKPACK_SUFFIX) return LARGE_BACKPACK_TITLE;

	const largeSuffix = `_${LARGE_BACKPACK_SUFFIX}`;
	if (localId.endsWith(largeSuffix)) {
		const colorName = localId.slice(0, -largeSuffix.length);
		return `${toTitleCase(colorName)} Large Backpack`;
	}

	if (localId === BACKPACK_SUFFIX) return "Backpack";

	const normalSuffix = `_${BACKPACK_SUFFIX}`;
	if (localId.endsWith(normalSuffix)) {
		const colorName = localId.slice(0, -normalSuffix.length);
		return `${toTitleCase(colorName)} Backpack`;
	}

	return "Backpack";
}

function getBackpackSlotCount(typeId) {
	if (isLargeBackpackTypeId(typeId)) return LARGE_BACKPACK_SLOT_COUNT;
	return BACKPACK_SLOT_COUNT;
}

function getBackpackFilterButtonSlot(typeId) {
	return getBackpackSlotCount(typeId);
}

function getBackpackTransferButtonSlot(typeId) {
	return getBackpackFilterButtonSlot(typeId) + 1;
}

function getBackpackEntityTypeId(typeId) {
	if (isLargeBackpackTypeId(typeId)) return LARGE_BACKPACK_ENTITY;
	return BACKPACK_ENTITY;
}

function backpackTag(pos) {
	return `${BACKPACK_TAG_PREFIX}${pos.x},${pos.y},${pos.z}`;
}

function blockLocationKey(dimension, pos) {
	const dimensionId = safeGet(() => dimension.id, "unknown");
	return `${dimensionId}:${pos.x},${pos.y},${pos.z}`;
}

function getBlockCenter(pos) {
	return { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
}

function getDropLocation(player) {
	const viewDirection = safeGet(() => player.getViewDirection(), { x: 0, y: 0, z: 1 });
	return {
		x: player.location.x + viewDirection.x * BACKPACK_LIMIT_DROP_DISTANCE,
		y: player.location.y + BACKPACK_LIMIT_DROP_UPWARD_OFFSET,
		z: player.location.z + viewDirection.z * BACKPACK_LIMIT_DROP_DISTANCE
	};
}

function getHorizontalViewDirection(player) {
	const viewDirection = safeGet(() => player.getViewDirection(), { x: 0, y: 0, z: 1 });
	const horizontalLength = Math.hypot(viewDirection.x, viewDirection.z);
	if (horizontalLength < 0.001) return { x: 0, y: 0, z: 1 };

	return {
		x: viewDirection.x / horizontalLength,
		y: 0,
		z: viewDirection.z / horizontalLength
	};
}

function getPlayerKey(player) {
	if (!player) return "unknown";
	return player.id ?? player.name ?? player.nameTag ?? "unknown";
}

function getBackpackEntitiesAt(dimension, pos, entityTypes = BACKPACK_ENTITY_TYPES) {
	const tag = backpackTag(pos);
	const entities = [];

	try {
		for (const entityType of entityTypes) {
			for (const entity of dimension.getEntities({
				type: entityType,
				location: getBlockCenter(pos),
				maxDistance: BACKPACK_SCAN_RADIUS
			})) {
				if (entity.hasTag(tag)) entities.push(entity);
			}
		}
	} catch { }

	return entities;
}

function getBackpackLocationFromEntity(entity) {
	const tag = safeGet(() => entity?.getTags().find((value) => value.startsWith(BACKPACK_TAG_PREFIX)), undefined);
	if (!tag) return undefined;

	const serialized = tag.slice(BACKPACK_TAG_PREFIX.length).split(",");
	if (serialized.length !== 3) return undefined;

	const x = Number(serialized[0]);
	const y = Number(serialized[1]);
	const z = Number(serialized[2]);

	if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return undefined;
	return { x, y, z };
}

function getEntityContainer(entity) {
	return safeGet(() => entity?.getComponent("minecraft:inventory")?.container, null);
}

function getRawContainerSize(container) {
	const size = safeGet(() => container?.size, undefined);
	return typeof size === "number" && size > 0 ? Math.floor(size) : 0;
}

function hasBackpackFilterButtonSlot(container, typeId) {
	return getRawContainerSize(container) > getBackpackFilterButtonSlot(typeId);
}

function hasBackpackTransferButtonSlot(container, typeId) {
	return getRawContainerSize(container) > getBackpackTransferButtonSlot(typeId);
}

function getBackpackButtonStateKey(entity) {
	const location = getBackpackLocationFromEntity(entity);
	if (location) {
		return `${entity.typeId}:${blockLocationKey(entity.dimension, location)}`;
	}

	return `${safeGet(() => entity?.typeId, "unknown")}:${safeGet(() => entity?.id, "unknown")}`;
}

function getBackpackFilterButtonState(entity) {
	const key = getBackpackButtonStateKey(entity);
	let state = backpackFilterButtonStates.get(key);
	if (!state) {
		state = { armed: false, pending: false, sortModeIndex: -1 };
		backpackFilterButtonStates.set(key, state);
	}
	return state;
}

function getBackpackTransferButtonState(entity) {
	const key = getBackpackButtonStateKey(entity);
	let state = backpackTransferButtonStates.get(key);
	if (!state) {
		state = { armed: false, pending: false, nextDirection: "to_backpack" };
		backpackTransferButtonStates.set(key, state);
	}
	return state;
}

function createBackpackFilterButtonItem() {
	try {
		return new ItemStack(BACKPACK_FILTER_BUTTON_ITEM, 1);
	} catch {
		return undefined;
	}
}

function createBackpackTransferButtonItem() {
	try {
		return new ItemStack(BACKPACK_TRANSFER_BUTTON_ITEM, 1);
	} catch {
		return undefined;
	}
}

function isBackpackFilterButtonItem(itemStack) {
	return itemStack?.typeId === BACKPACK_FILTER_BUTTON_ITEM;
}

function isBackpackTransferButtonItem(itemStack) {
	return itemStack?.typeId === BACKPACK_TRANSFER_BUTTON_ITEM;
}

function isBackpackControlButtonItem(itemStack) {
	return isBackpackFilterButtonItem(itemStack)
		|| isBackpackTransferButtonItem(itemStack)
		|| isBackpackLightButtonItem(itemStack);
}

function setBackpackActionBar(player, text) {
	safeGet(() => player?.onScreenDisplay?.setActionBar(text));
}

function getClosestBackpackPlayer(entity) {
	const entityLocation = safeGet(() => entity?.location, undefined);
	const dimensionId = safeGet(() => entity?.dimension?.id, undefined);
	if (!entityLocation || !dimensionId) return undefined;

	let closestPlayer = undefined;
	let closestDistanceSquared = Number.POSITIVE_INFINITY;
	for (const player of world.getAllPlayers()) {
		if (safeGet(() => player.dimension?.id, undefined) !== dimensionId) continue;

		const playerLocation = safeGet(() => player.location, undefined);
		if (!playerLocation) continue;

		const deltaX = playerLocation.x - entityLocation.x;
		const deltaY = playerLocation.y - entityLocation.y;
		const deltaZ = playerLocation.z - entityLocation.z;
		const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
		if (distanceSquared < closestDistanceSquared) {
			closestPlayer = player;
			closestDistanceSquared = distanceSquared;
		}
	}

	return closestPlayer;
}

function clearBackpackFilterButtonFromPlayer(player) {
	if (!player) return false;

	let cleared = false;
	const cursor = safeGet(() => player.getComponent("minecraft:cursor_inventory"), null);
	if (isBackpackFilterButtonItem(safeGet(() => cursor?.item, undefined))) {
		safeGet(() => cursor.clear());
		cleared = true;
	}

	const inventory = safeGet(() => player.getComponent("minecraft:inventory")?.container, null);
	if (inventory) {
		for (let slot = 0; slot < inventory.size; slot++) {
			if (!isBackpackFilterButtonItem(safeGet(() => inventory.getItem(slot), undefined))) continue;
			safeGet(() => inventory.setItem(slot, undefined));
			cleared = true;
		}
	}

	const equippable = getPlayerEquippable(player);
	if (equippable) {
		for (const slot of [EquipmentSlot.Mainhand, EquipmentSlot.Offhand]) {
			if (!isBackpackFilterButtonItem(safeGet(() => equippable.getEquipment(slot), undefined))) continue;
			safeGet(() => equippable.setEquipment(slot, undefined));
			cleared = true;
		}
	}

	return cleared;
}

function clearBackpackFilterButtonArtifacts(entity, typeId) {
	const container = getEntityContainer(entity);
	const storageSlotCount = getBackpackSlotCount(typeId);
	for (let slot = 0; slot < storageSlotCount; slot++) {
		if (!isBackpackFilterButtonItem(safeGet(() => container?.getItem(slot), undefined))) continue;
		safeGet(() => container.setItem(slot, undefined));
	}

	let sourcePlayer = undefined;
	const dimensionId = safeGet(() => entity?.dimension?.id, undefined);
	for (const player of world.getAllPlayers()) {
		if (safeGet(() => player.dimension?.id, undefined) !== dimensionId) continue;
		if (clearBackpackFilterButtonFromPlayer(player) && !sourcePlayer) {
			sourcePlayer = player;
		}
	}

	const entityLocation = safeGet(() => entity?.location, undefined);
	const droppedItems = entityLocation
		? safeGet(() => entity.dimension.getEntities({
			type: "minecraft:item",
			location: entityLocation,
			maxDistance: BACKPACK_FILTER_BUTTON_CLEANUP_RADIUS
		}), [])
		: [];

	for (const itemEntity of droppedItems) {
		const itemStack = safeGet(() => itemEntity.getComponent("minecraft:item")?.itemStack, undefined);
		if (!isBackpackFilterButtonItem(itemStack)) continue;
		safeGet(() => itemEntity.remove());
	}

	return sourcePlayer ?? getClosestBackpackPlayer(entity);
}

function clearBackpackTransferButtonFromPlayer(player) {
	if (!player) return false;

	let cleared = false;
	const cursor = safeGet(() => player.getComponent("minecraft:cursor_inventory"), null);
	if (isBackpackTransferButtonItem(safeGet(() => cursor?.item, undefined))) {
		safeGet(() => cursor.clear());
		cleared = true;
	}

	const inventory = safeGet(() => player.getComponent("minecraft:inventory")?.container, null);
	if (inventory) {
		for (let slot = 0; slot < inventory.size; slot++) {
			if (!isBackpackTransferButtonItem(safeGet(() => inventory.getItem(slot), undefined))) continue;
			safeGet(() => inventory.setItem(slot, undefined));
			cleared = true;
		}
	}

	const equippable = getPlayerEquippable(player);
	if (equippable) {
		for (const slot of [EquipmentSlot.Mainhand, EquipmentSlot.Offhand]) {
			if (!isBackpackTransferButtonItem(safeGet(() => equippable.getEquipment(slot), undefined))) continue;
			safeGet(() => equippable.setEquipment(slot, undefined));
			cleared = true;
		}
	}

	return cleared;
}

function clearBackpackTransferButtonArtifacts(entity, typeId) {
	const container = getEntityContainer(entity);
	const storageSlotCount = getBackpackSlotCount(typeId);
	for (let slot = 0; slot < storageSlotCount; slot++) {
		if (!isBackpackTransferButtonItem(safeGet(() => container?.getItem(slot), undefined))) continue;
		safeGet(() => container.setItem(slot, undefined));
	}

	let sourcePlayer = undefined;
	const dimensionId = safeGet(() => entity?.dimension?.id, undefined);
	for (const player of world.getAllPlayers()) {
		if (safeGet(() => player.dimension?.id, undefined) !== dimensionId) continue;
		if (clearBackpackTransferButtonFromPlayer(player) && !sourcePlayer) {
			sourcePlayer = player;
		}
	}

	const entityLocation = safeGet(() => entity?.location, undefined);
	const droppedItems = entityLocation
		? safeGet(() => entity.dimension.getEntities({
			type: "minecraft:item",
			location: entityLocation,
			maxDistance: BACKPACK_TRANSFER_BUTTON_CLEANUP_RADIUS
		}), [])
		: [];

	for (const itemEntity of droppedItems) {
		const itemStack = safeGet(() => itemEntity.getComponent("minecraft:item")?.itemStack, undefined);
		if (!isBackpackTransferButtonItem(itemStack)) continue;
		safeGet(() => itemEntity.remove());
	}

	return sourcePlayer ?? getClosestBackpackPlayer(entity);
}

function getBackpackFilterSortKey(itemStack) {
	const typeId = String(itemStack?.typeId ?? "");
	const nameTag = String(safeGet(() => itemStack?.nameTag, "") ?? "");
	return `${typeId}\u0000${nameTag}`;
}

function getNextBackpackFilterSortMode(state) {
	const modeCount = BACKPACK_FILTER_SORT_MODES.length;
	if (!modeCount || !state) return undefined;

	const currentIndex = Number.isInteger(state.sortModeIndex) ? state.sortModeIndex : -1;
	const nextIndex = (currentIndex + 1 + modeCount) % modeCount;
	state.sortModeIndex = nextIndex;
	return BACKPACK_FILTER_SORT_MODES[nextIndex];
}

function isBackpackBlockItem(itemStack) {
	const typeId = String(itemStack?.typeId ?? "");
	if (!typeId) return false;

	const cached = backpackBlockItemTypeCache.get(typeId);
	if (cached !== undefined) return cached;

	const hasBlockPlacer = safeGet(() => !!itemStack.getComponent?.("minecraft:block_placer"), false);
	const isBlock = hasBlockPlacer || safeGet(() => {
		BlockPermutation.resolve(typeId);
		return true;
	}, false);
	backpackBlockItemTypeCache.set(typeId, isBlock);
	return isBlock;
}

function compareBackpackStorageEntriesByKey(left, right) {
	if (left.key < right.key) return -1;
	if (left.key > right.key) return 1;
	return left.slot - right.slot;
}

function compareBackpackStorageEntries(left, right, sortMode) {
	const modeId = sortMode?.id;
	if (modeId === "items_first" || modeId === "blocks_first") {
		const leftCategory = left.isBlock ? 1 : 0;
		const rightCategory = right.isBlock ? 1 : 0;
		if (leftCategory !== rightCategory) {
			const blocksFirst = modeId === "blocks_first";
			return blocksFirst ? rightCategory - leftCategory : leftCategory - rightCategory;
		}
	} else if (modeId === "fullest_first") {
		const leftAmount = getBackpackItemAmount(left.itemStack) ?? 0;
		const rightAmount = getBackpackItemAmount(right.itemStack) ?? 0;
		if (leftAmount !== rightAmount) return rightAmount - leftAmount;
	}

	return compareBackpackStorageEntriesByKey(left, right);
}

function getBackpackItemAmount(itemStack) {
	const amount = Number(safeGet(() => itemStack?.amount, NaN));
	return Number.isInteger(amount) && amount > 0 ? amount : undefined;
}

function getBackpackItemMaxAmount(itemStack) {
	const maxAmount = Number(safeGet(() => itemStack?.maxAmount, NaN));
	return Number.isInteger(maxAmount) && maxAmount > 0 ? maxAmount : undefined;
}

function cloneBackpackItemStack(itemStack) {
	return safeGet(() => itemStack?.clone(), undefined);
}

function setBackpackItemAmount(itemStack, amount) {
	if (!Number.isInteger(amount) || amount < 1) return false;
	return safeGet(() => {
		itemStack.amount = amount;
		return itemStack.amount === amount;
	}, false);
}

function canCombineBackpackItemStacks(left, right) {
	return safeGet(() => left?.isStackableWith(right) === true, false);
}

function getBackpackItemTotals(entries) {
	const totals = new Map();
	for (const entry of entries) {
		const amount = getBackpackItemAmount(entry.itemStack);
		if (amount === undefined) return undefined;

		const key = entry.key ?? getBackpackFilterSortKey(entry.itemStack);
		totals.set(key, (totals.get(key) ?? 0) + amount);
	}
	return totals;
}

function areBackpackItemTotalsEqual(left, right) {
	if (!left || !right || left.size !== right.size) return false;
	for (const [key, amount] of left) {
		if (right.get(key) !== amount) return false;
	}
	return true;
}

function consolidateBackpackStorageEntries(sortedEntries) {
	const consolidatedEntries = [];

	for (const entry of sortedEntries) {
		// Only work on copies so a failed filter never mutates the original slots.
		const itemStack = cloneBackpackItemStack(entry.itemStack);
		const sourceAmount = getBackpackItemAmount(itemStack);
		const sourceMaxAmount = getBackpackItemMaxAmount(itemStack);
		if (!itemStack || sourceAmount === undefined || sourceMaxAmount === undefined || sourceAmount > sourceMaxAmount) {
			return undefined;
		}

		let remainingAmount = sourceAmount;
		for (let index = consolidatedEntries.length - 1; index >= 0; index--) {
			const targetEntry = consolidatedEntries[index];
			if (targetEntry.key !== entry.key) break;

			const targetStack = targetEntry.itemStack;
			if (!canCombineBackpackItemStacks(targetStack, itemStack)) continue;

			const targetAmount = getBackpackItemAmount(targetStack);
			const targetMaxAmount = getBackpackItemMaxAmount(targetStack);
			if (targetAmount === undefined || targetMaxAmount === undefined || targetAmount > targetMaxAmount) {
				return undefined;
			}

			const transferAmount = Math.min(targetMaxAmount - targetAmount, remainingAmount);
			if (transferAmount <= 0) continue;
			if (!setBackpackItemAmount(targetStack, targetAmount + transferAmount)) return undefined;

			remainingAmount -= transferAmount;
			if (remainingAmount === 0) break;
		}

		if (remainingAmount > 0) {
			if (remainingAmount !== sourceAmount && !setBackpackItemAmount(itemStack, remainingAmount)) {
				return undefined;
			}
			consolidatedEntries.push({
				slot: entry.slot,
				key: entry.key,
				isBlock: entry.isBlock,
				itemStack
			});
		}
	}

	return consolidatedEntries;
}

function getBackpackStorageEntries(container, storageSlotCount) {
	const entries = [];
	for (let slot = 0; slot < storageSlotCount; slot++) {
		const itemStack = safeGet(() => container.getItem(slot), undefined);
		if (!itemStack) continue;
		entries.push({
			slot,
			itemStack,
			key: getBackpackFilterSortKey(itemStack),
			isBlock: isBackpackBlockItem(itemStack)
		});
	}
	return entries;
}

function organizeBackpackStorage(entity, typeId, sortMode) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!entity || entity.typeId !== getBackpackEntityTypeId(normalizedTypeId)) return false;

	const container = getEntityContainer(entity);
	const storageSlotCount = getBackpackSlotCount(normalizedTypeId);
	if (!container || getRawContainerSize(container) < storageSlotCount) return false;

	const originalEntries = getBackpackStorageEntries(container, storageSlotCount);

	const entriesGroupedForStacking = [...originalEntries].sort(compareBackpackStorageEntriesByKey);
	const consolidatedEntries = consolidateBackpackStorageEntries(entriesGroupedForStacking);
	const originalTotals = getBackpackItemTotals(originalEntries);
	const consolidatedTotals = getBackpackItemTotals(consolidatedEntries ?? []);
	if (!consolidatedEntries || !areBackpackItemTotalsEqual(originalTotals, consolidatedTotals)) return false;
	const orderedEntries = [...consolidatedEntries].sort((left, right) => {
		return compareBackpackStorageEntries(left, right, sortMode);
	});

	const changed = orderedEntries.length !== originalEntries.length
		|| orderedEntries.some((entry, index) => entry.slot !== originalEntries[index]?.slot);
	if (!changed) return true;

	try {
		for (let slot = 0; slot < storageSlotCount; slot++) {
			container.setItem(slot, undefined);
		}
		for (let slot = 0; slot < orderedEntries.length; slot++) {
			container.setItem(slot, orderedEntries[slot].itemStack);
		}

		const writtenEntries = getBackpackStorageEntries(container, storageSlotCount);
		const writtenTotals = getBackpackItemTotals(writtenEntries);
		if (writtenEntries.length !== orderedEntries.length
			|| !areBackpackItemTotalsEqual(consolidatedTotals, writtenTotals)) {
			throw new Error("Backpack filter verification failed.");
		}
	} catch {
		// Restore the exact slot layout if a container write cannot be verified.
		for (let slot = 0; slot < storageSlotCount; slot++) {
			safeGet(() => container.setItem(slot, undefined));
		}
		for (const entry of originalEntries) {
			safeGet(() => container.setItem(entry.slot, entry.itemStack));
		}
		return false;
	}

	return true;
}

function getItemDynamicProperties(itemStack) {
	const propertyIds = safeGet(() => itemStack?.getDynamicPropertyIds(), []);
	const properties = {};

	for (const propertyId of propertyIds) {
		const value = safeGet(() => itemStack.getDynamicProperty(propertyId));
		if (value !== undefined) properties[propertyId] = value;
	}

	return Object.keys(properties).length ? properties : undefined;
}

function getBackpackTransferItemKey(itemStack) {
	// Identity of a stack without its amount. Used to verify that a move or sort did not change any item.
	if (getBackpackItemAmount(itemStack) === undefined) return undefined;

	const fingerprint = { id: itemStack.typeId };
	const nameTag = safeGet(() => itemStack.nameTag, "");
	if (nameTag) fingerprint.n = nameTag;
	const lore = safeGet(() => itemStack.getLore(), []);
	if (lore?.length) fingerprint.l = lore;

	const damage = safeGet(() => itemStack.getComponent("minecraft:durability")?.damage, undefined);
	if (typeof damage === "number" && damage > 0) fingerprint.d = damage;

	const enchantments = safeGet(
		() => itemStack.getComponent("minecraft:enchantable")?.getEnchantments().map((e) => `${e.type.id}:${e.level}`).sort(),
		[]
	);
	if (enchantments?.length) fingerprint.e = enchantments;

	const potion = safeGet(() => {
		const component = itemStack.getComponent("minecraft:potion");
		return component ? `${component.potionEffectType?.id}|${component.potionDeliveryType}` : undefined;
	}, undefined);
	if (potion) fingerprint.p = potion;

	const properties = getItemDynamicProperties(itemStack);
	if (properties) {
		const ordered = {};
		for (const propertyId of Object.keys(properties).sort()) ordered[propertyId] = properties[propertyId];
		fingerprint.dp = ordered;
	}

	return safeGet(() => JSON.stringify(fingerprint), undefined);
}

function getBackpackTransferEntries(container, slotCount) {
	if (!container || !Number.isInteger(slotCount) || slotCount < 0) return undefined;

	const entries = [];
	for (let slot = 0; slot < slotCount; slot++) {
		const itemStack = safeGet(() => container.getItem(slot), undefined);
		if (!itemStack) continue;

		const snapshot = cloneBackpackItemStack(itemStack);
		const amount = getBackpackItemAmount(snapshot);
		const key = getBackpackTransferItemKey(snapshot);
		if (!snapshot || amount === undefined || key === undefined) return undefined;
		entries.push({ slot, itemStack: snapshot, key, amount });
	}

	return entries;
}

function combineBackpackTransferTotals(...totalMaps) {
	const combined = new Map();
	for (const totals of totalMaps) {
		if (!totals) return undefined;
		for (const [key, amount] of totals) {
			combined.set(key, (combined.get(key) ?? 0) + amount);
		}
	}
	return combined;
}

function areBackpackTransferItemsEqual(left, right) {
	if (!left || !right) return !left && !right;

	const leftAmount = getBackpackItemAmount(left);
	const rightAmount = getBackpackItemAmount(right);
	if (leftAmount === undefined || rightAmount === undefined || leftAmount !== rightAmount) {
		return false;
	}

	return getBackpackTransferItemKey(left) === getBackpackTransferItemKey(right);
}

function writeBackpackTransferContainerSlot(container, slot, itemStack) {
	if (!container || !Number.isInteger(slot) || slot < 0) return false;

	const expected = itemStack ? cloneBackpackItemStack(itemStack) : undefined;
	if (itemStack && !expected) return false;

	try {
		container.setItem(slot, expected);
	} catch {
		return false;
	}

	const written = safeGet(() => container.getItem(slot), undefined);
	return areBackpackTransferItemsEqual(expected, written);
}

function restoreBackpackTransferEntries(container, slotCount, entries) {
	if (!container || !Number.isInteger(slotCount) || !Array.isArray(entries)) return false;

	for (let slot = 0; slot < slotCount; slot++) {
		if (!writeBackpackTransferContainerSlot(container, slot, undefined)) return false;
	}

	for (const entry of entries) {
		if (!Number.isInteger(entry?.slot) || entry.slot < 0 || entry.slot >= slotCount) return false;
		if (!writeBackpackTransferContainerSlot(container, entry.slot, entry.itemStack)) return false;
	}

	const restoredEntries = getBackpackTransferEntries(container, slotCount);
	if (!restoredEntries || restoredEntries.length !== entries.length) return false;

	return restoredEntries.every((entry, index) => {
		const expected = entries[index];
		return entry.slot === expected.slot
			&& areBackpackTransferItemsEqual(entry.itemStack, expected.itemStack);
	});
}

function addItemToBackpackStorage(container, storageSlotCount, itemStack) {
	let remaining = cloneBackpackItemStack(itemStack);
	let remainingAmount = getBackpackItemAmount(remaining);
	if (!remaining || remainingAmount === undefined) return { success: false };

	for (let slot = 0; slot < storageSlotCount && remainingAmount > 0; slot++) {
		const currentItem = safeGet(() => container.getItem(slot), undefined);
		if (!currentItem || !canCombineBackpackItemStacks(currentItem, remaining)) continue;

		const currentAmount = getBackpackItemAmount(currentItem);
		const currentMaxAmount = getBackpackItemMaxAmount(currentItem);
		if (currentAmount === undefined || currentMaxAmount === undefined || currentAmount > currentMaxAmount) {
			return { success: false };
		}

		const movedAmount = Math.min(currentMaxAmount - currentAmount, remainingAmount);
		if (movedAmount <= 0) continue;

		const updatedItem = cloneBackpackItemStack(currentItem);
		if (!updatedItem || !setBackpackItemAmount(updatedItem, currentAmount + movedAmount)) {
			return { success: false };
		}
		if (!writeBackpackTransferContainerSlot(container, slot, updatedItem)) return { success: false };

		remainingAmount -= movedAmount;
		if (remainingAmount === 0) return { success: true, leftover: undefined };
		if (!setBackpackItemAmount(remaining, remainingAmount)) return { success: false };
	}

	for (let slot = 0; slot < storageSlotCount && remainingAmount > 0; slot++) {
		if (safeGet(() => container.getItem(slot), undefined)) continue;

		const maxAmount = getBackpackItemMaxAmount(remaining);
		if (maxAmount === undefined) return { success: false };

		const movedAmount = Math.min(maxAmount, remainingAmount);
		const insertedItem = cloneBackpackItemStack(remaining);
		if (!insertedItem || !setBackpackItemAmount(insertedItem, movedAmount)) {
			return { success: false };
		}
		if (!writeBackpackTransferContainerSlot(container, slot, insertedItem)) return { success: false };

		remainingAmount -= movedAmount;
		if (remainingAmount === 0) return { success: true, leftover: undefined };
		if (!setBackpackItemAmount(remaining, remainingAmount)) return { success: false };
	}

	return { success: true, leftover: remaining };
}

function addItemToPlayerInventory(inventory, itemStack) {
	const transferable = cloneBackpackItemStack(itemStack);
	if (!transferable) return { success: false };

	try {
		const leftover = inventory.addItem(transferable);
		if (!leftover) return { success: true, leftover: undefined };

		const clonedLeftover = cloneBackpackItemStack(leftover);
		return clonedLeftover && getBackpackItemAmount(clonedLeftover) !== undefined
			? { success: true, leftover: clonedLeftover }
			: { success: false };
	} catch {
		return { success: false };
	}
}

function moveAllBackpackTransferItems({
	sourceContainer,
	sourceSlotCount,
	targetContainer,
	targetSlotCount,
	targetKind,
	shouldMove
}) {
	const originalSourceEntries = getBackpackTransferEntries(sourceContainer, sourceSlotCount);
	const originalTargetEntries = getBackpackTransferEntries(targetContainer, targetSlotCount);
	const originalTotals = combineBackpackTransferTotals(
		getBackpackItemTotals(originalSourceEntries ?? []),
		getBackpackItemTotals(originalTargetEntries ?? [])
	);
	if (!originalSourceEntries || !originalTargetEntries || !originalTotals) {
		return { success: false };
	}

	let movedAmount = 0;
	let movedStacks = 0;
	let skippedAmount = 0;
	let movableAmount = 0;

	try {
		for (const entry of originalSourceEntries) {
			if (!shouldMove(entry.itemStack)) {
				skippedAmount += entry.amount;
				continue;
			}

			movableAmount += entry.amount;
			const result = targetKind === "backpack"
				? addItemToBackpackStorage(targetContainer, targetSlotCount, entry.itemStack)
				: addItemToPlayerInventory(targetContainer, entry.itemStack);
			if (!result?.success) throw new Error("Backpack transfer target write failed.");

			const leftoverAmount = result.leftover ? getBackpackItemAmount(result.leftover) : 0;
			if (!Number.isInteger(leftoverAmount) || leftoverAmount < 0 || leftoverAmount > entry.amount) {
				throw new Error("Backpack transfer target returned an invalid remainder.");
			}

			const transferredAmount = entry.amount - leftoverAmount;
			if (transferredAmount <= 0) continue;
			if (!writeBackpackTransferContainerSlot(sourceContainer, entry.slot, result.leftover)) {
				throw new Error("Backpack transfer source write failed.");
			}

			movedAmount += transferredAmount;
			movedStacks++;
		}

		const finalSourceEntries = getBackpackTransferEntries(sourceContainer, sourceSlotCount);
		const finalTargetEntries = getBackpackTransferEntries(targetContainer, targetSlotCount);
		const finalTotals = combineBackpackTransferTotals(
			getBackpackItemTotals(finalSourceEntries ?? []),
			getBackpackItemTotals(finalTargetEntries ?? [])
		);
		if (!finalSourceEntries || !finalTargetEntries || !areBackpackItemTotalsEqual(originalTotals, finalTotals)) {
			throw new Error("Backpack transfer verification failed.");
		}

		return {
			success: true,
			movedAmount,
			movedStacks,
			unmovedAmount: movableAmount - movedAmount,
			skippedAmount,
			originalSourceEntries,
			originalTargetEntries
		};
	} catch {
		// Restore both exact layouts if any stack count or item identity cannot be verified.
		restoreBackpackTransferEntries(targetContainer, targetSlotCount, originalTargetEntries);
		restoreBackpackTransferEntries(sourceContainer, sourceSlotCount, originalSourceEntries);
		return { success: false };
	}
}

function getBackpackTransferActionText(direction, result) {
	if (!result?.success) return "§cTransfer failed. Items were restored.";

	const destination = direction === "to_backpack" ? "into the backpack" : "to your inventory";
	if (!result.movedAmount) {
		return direction === "to_backpack"
			? "§7No inventory items could be moved into the backpack."
			: "§7No backpack items could be moved to your inventory.";
	}

	let text = "§aMoved " + result.movedAmount + " item"
		+ (result.movedAmount === 1 ? "" : "s") + " " + destination + ".";
	const blockedAmount = Math.max(0, result.unmovedAmount ?? 0);
	if (blockedAmount > 0) {
		text += " §e" + blockedAmount + " item" + (blockedAmount === 1 ? "" : "s") + " could not fit.";
	}
	if (result.skippedAmount > 0) {
		text += " §7Other backpacks were kept in the inventory.";
	}
	return text;
}

function runBackpackTransferAction(entity, typeId, player, state) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	const backpackContainer = getEntityContainer(entity);
	const inventory = safeGet(() => player?.getComponent("minecraft:inventory")?.container, null);
	const inventorySlotCount = getRawContainerSize(inventory);
	const backpackSlotCount = getBackpackSlotCount(normalizedTypeId);
	if (!backpackContainer || !inventory || inventorySlotCount <= 0 || backpackSlotCount <= 0) {
		setBackpackActionBar(player, "§cUnable to access the backpack inventory.");
		return false;
	}

	const direction = state?.nextDirection === "to_inventory" ? "to_inventory" : "to_backpack";
	const movingToBackpack = direction === "to_backpack";
	const result = movingToBackpack
		? moveAllBackpackTransferItems({
			sourceContainer: inventory,
			sourceSlotCount: inventorySlotCount,
			targetContainer: backpackContainer,
			targetSlotCount: backpackSlotCount,
			targetKind: "backpack",
			shouldMove: (itemStack) => !isBackpackControlButtonItem(itemStack) && !isBackpackTypeId(itemStack?.typeId)
		})
		: moveAllBackpackTransferItems({
			sourceContainer: backpackContainer,
			sourceSlotCount: backpackSlotCount,
			targetContainer: inventory,
			targetSlotCount: inventorySlotCount,
			targetKind: "inventory",
			shouldMove: (itemStack) => !isBackpackControlButtonItem(itemStack)
		});

	if (!result.success) {
		setBackpackActionBar(player, getBackpackTransferActionText(direction, result));
		return false;
	}

	if (state) {
		state.nextDirection = movingToBackpack ? "to_inventory" : "to_backpack";
	}
	setBackpackActionBar(player, getBackpackTransferActionText(direction, result));
	return true;
}

function syncBackpackFilterButton(entity, typeId) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!entity || entity.typeId !== getBackpackEntityTypeId(normalizedTypeId)) return;

	const container = getEntityContainer(entity);
	if (!container || !hasBackpackFilterButtonSlot(container, normalizedTypeId)) return;

	const buttonSlot = getBackpackFilterButtonSlot(normalizedTypeId);
	const currentItem = safeGet(() => container.getItem(buttonSlot), undefined);
	const state = getBackpackFilterButtonState(entity);
	if (isBackpackFilterButtonItem(currentItem)) {
		state.armed = true;
		return;
	}

	if (currentItem) {
		// The helper slot is never player storage; return accidental items instead of hiding them.
		safeGet(() => container.setItem(buttonSlot, undefined));
		const returnItem = safeGet(() => currentItem.clone(), currentItem);
		const returnLocation = getBackpackLocationFromEntity(entity) ?? safeGet(() => entity.location, undefined);
		if (returnLocation) {
			safeGet(() => entity.dimension.spawnItem(returnItem, getBlockCenter(returnLocation)));
		}
		state.armed = false;
	}

	const shouldActivate = !currentItem && state.armed && !state.pending;
	const marker = createBackpackFilterButtonItem();
	if (!marker) return;

	safeGet(() => container.setItem(buttonSlot, marker));
	state.armed = false;
	if (!shouldActivate) return;

	state.pending = true;
	system.runTimeout(() => {
		state.pending = false;
		const player = clearBackpackFilterButtonArtifacts(entity, normalizedTypeId);
		const sortMode = getNextBackpackFilterSortMode(state);
		const organized = organizeBackpackStorage(entity, normalizedTypeId, sortMode);
		const saved = organized;
		setBackpackActionBar(
			player,
			saved ? (sortMode?.message ?? "§bBackpack sorted and stacked.") : "§cUnable to organize backpack."
		);
		syncBackpackFilterButton(entity, normalizedTypeId);
	}, 1);
}

function syncBackpackTransferButton(entity, typeId) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!entity || entity.typeId !== getBackpackEntityTypeId(normalizedTypeId)) return;

	const container = getEntityContainer(entity);
	if (!container || !hasBackpackTransferButtonSlot(container, normalizedTypeId)) return;

	const buttonSlot = getBackpackTransferButtonSlot(normalizedTypeId);
	const currentItem = safeGet(() => container.getItem(buttonSlot), undefined);
	const state = getBackpackTransferButtonState(entity);
	if (isBackpackTransferButtonItem(currentItem)) {
		state.armed = true;
		return;
	}

	if (currentItem) {
		// The helper slot is never player storage; return accidental items instead of hiding them.
		safeGet(() => container.setItem(buttonSlot, undefined));
		const returnItem = safeGet(() => currentItem.clone(), currentItem);
		const returnLocation = getBackpackLocationFromEntity(entity) ?? safeGet(() => entity.location, undefined);
		if (returnLocation) {
			safeGet(() => entity.dimension.spawnItem(returnItem, getBlockCenter(returnLocation)));
		}
		state.armed = false;
	}

	const shouldActivate = !currentItem && state.armed && !state.pending;
	const marker = createBackpackTransferButtonItem();
	if (!marker) return;

	safeGet(() => container.setItem(buttonSlot, marker));
	state.armed = false;
	if (!shouldActivate) return;

	state.pending = true;
	system.runTimeout(() => {
		state.pending = false;
		const player = clearBackpackTransferButtonArtifacts(entity, normalizedTypeId);
		runBackpackTransferAction(entity, normalizedTypeId, player, state);
		syncBackpackTransferButton(entity, normalizedTypeId);
	}, 1);
}

function removeBackpackEntity(entity) {
	if (!entity) return;
	backpackFilterButtonStates.delete(getBackpackButtonStateKey(entity));
	backpackTransferButtonStates.delete(getBackpackButtonStateKey(entity));

	try {
		entity.remove();
	} catch { }
}

function removeBackpackEntities(entities) {
	for (const entity of entities ?? []) {
		removeBackpackEntity(entity);
	}
}

function getPlayerEquippable(player) {
	return safeGet(() => player?.getComponent("minecraft:equippable") ?? player?.getComponent("equippable"), null);
}

function giveOrDropItem(player, itemStack, dimension, location) {
	if (!itemStack) return;

	const inventory = safeGet(() => player?.getComponent("minecraft:inventory")?.container, null);
	const leftover = inventory ? safeGet(() => inventory.addItem(itemStack), itemStack) : itemStack;
	if (!leftover) return;

	safeGet(() => dimension.spawnItem(leftover, location));
}

function spawnBackpackLimitParticles(dimension, location) {
	for (let index = 0; index < BACKPACK_LIMIT_PARTICLE_COUNT; index++) {
		const offsetX = (Math.random() - 0.5) * 0.45;
		const offsetY = Math.random() * 0.35;
		const offsetZ = (Math.random() - 0.5) * 0.45;

		safeGet(() => dimension.spawnParticle("minecraft:basic_flame_particle", {
			x: location.x + offsetX,
			y: location.y + offsetY,
			z: location.z + offsetZ
		}));
	}
}

function ejectOverflowBackpack(player, itemStack) {
	if (!itemStack) return false;

	const dropLocation = getDropLocation(player);
	const horizontalDirection = getHorizontalViewDirection(player);

	try {
		const droppedEntity = player.dimension.spawnItem(itemStack, dropLocation);
		safeGet(() => droppedEntity.clearVelocity());
		safeGet(() => droppedEntity.applyImpulse({
			x: horizontalDirection.x * BACKPACK_LIMIT_DROP_IMPULSE,
			y: BACKPACK_LIMIT_DROP_VERTICAL_IMPULSE,
			z: horizontalDirection.z * BACKPACK_LIMIT_DROP_IMPULSE
		}));
		spawnBackpackLimitParticles(player.dimension, dropLocation);
		return true;
	} catch {
		return false;
	}
}


// =================================================================================================
// Backpacker: new code (vault storage, placement, breaking, sweep, events)
// =================================================================================================

// ---- small helpers -------------------------------------------------------------------------------
function getBackpackTypeIdForEntity(entity) {
	return entity?.typeId === LARGE_BACKPACK_ENTITY ? LARGE_BACKPACK_TYPE : BACKPACK_TYPE;
}

function countStoredItems(container, slotCount) {
	let stacks = 0;
	let amount = 0;
	if (!container) return { stacks, amount };

	for (let slot = 0; slot < slotCount; slot++) {
		const item = safeGet(() => container.getItem(slot), undefined);
		if (!item || isBackpackControlButtonItem(item)) continue;
		stacks++;
		amount += item.amount;
	}
	return { stacks, amount };
}

function getBlockInventory(block) {
	return safeGet(() => block?.getComponent("minecraft:inventory")?.container, null);
}

function newVaultId() {
	const time = Date.now().toString(36);
	const random = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0");
	return `${time}${random}`;
}

function getVaultStructureId(vaultId) {
	return `${VAULT_STRUCTURE_PREFIX}${vaultId}`;
}

function getPendingMarkerKey(dimension, pos) {
	const dimensionId = String(safeGet(() => dimension.id, "x")).replace("minecraft:", "").charAt(0);
	const part = (value) => (value < 0 ? `n${-value}` : `${value}`);
	return `${VAULT_MARKER_PREFIX}${dimensionId}_${part(pos.x)}_${part(pos.y)}_${part(pos.z)}`;
}

function readPendingMarker(dimension, pos) {
	const value = safeGet(() => world.getDynamicProperty(getPendingMarkerKey(dimension, pos)), undefined);
	return typeof value === "string" && value.length ? value : undefined;
}

function writePendingMarker(dimension, pos, vaultId) {
	safeGet(() => world.setDynamicProperty(getPendingMarkerKey(dimension, pos), vaultId));
}

function clearPendingMarker(dimension, pos) {
	safeGet(() => world.setDynamicProperty(getPendingMarkerKey(dimension, pos), undefined));
}

// ---- vault: one structure per backpack, made of 1-2 temporary barrels at the build limit ------------
function findVaultSpot(dimension, x, z, cells) {
	const range = safeGet(() => dimension.heightRange, undefined);
	if (!range) return undefined;

	for (let top = range.max - 1; top >= range.max - VAULT_SEARCH_DEPTH && top - cells + 1 >= range.min; top--) {
		let usable = true;
		for (let k = 0; k < cells; k++) {
			const block = safeGet(() => dimension.getBlock({ x, y: top - k, z }), undefined);
			if (!block || !VAULT_SAFE_BLOCKS.has(block.typeId)) {
				usable = false;
				break;
			}
		}
		if (usable) return { baseY: top - cells + 1 };
	}
	return undefined;
}

function restoreVaultCells(dimension, x, z, baseY, originals) {
	for (let k = 0; k < originals.length; k++) {
		const block = safeGet(() => dimension.getBlock({ x, y: baseY + k, z }), undefined);
		if (!block) continue;
		// Empty the barrel first so nothing drops when the original block comes back.
		safeGet(() => getBlockInventory(block)?.clearAll());
		safeGet(() => block.setPermutation(originals[k]));
	}
}

// Copies every storage slot into barrels, saves them as a structure, then puts the world back.
// Returns { ok, vaultId, stacks } or { ok: false, reason }. Never changes the source container.
function saveVault(dimension, x, z, container, slotCount) {
	const cells = Math.ceil(slotCount / VAULT_CELL_SLOTS);
	const spot = findVaultSpot(dimension, x, z, cells);
	if (!spot) return { ok: false, reason: "no free space at the build limit" };

	const vaultId = newVaultId();
	const structureId = getVaultStructureId(vaultId);
	const expected = countStoredItems(container, slotCount);
	const originals = [];
	let ok = false;
	let reason = "unknown error";

	try {
		for (let k = 0; k < cells; k++) {
			const block = dimension.getBlock({ x, y: spot.baseY + k, z });
			originals.push(block.permutation);
			block.setPermutation(BlockPermutation.resolve(VAULT_BARREL));
		}

		const barrels = [];
		for (let k = 0; k < cells; k++) {
			const barrel = getBlockInventory(dimension.getBlock({ x, y: spot.baseY + k, z }));
			if (!barrel) throw new Error("barrel has no inventory");
			barrels.push(barrel);
		}

		for (let slot = 0; slot < slotCount; slot++) {
			const item = container.getItem(slot);
			if (!item) continue;
			barrels[Math.floor(slot / VAULT_CELL_SLOTS)].setItem(slot % VAULT_CELL_SLOTS, item);
		}

		let copiedStacks = 0;
		let copiedAmount = 0;
		for (const barrel of barrels) {
			const counted = countStoredItems(barrel, VAULT_CELL_SLOTS);
			copiedStacks += counted.stacks;
			copiedAmount += counted.amount;
		}
		if (copiedStacks !== expected.stacks || copiedAmount !== expected.amount) {
			throw new Error("copy check failed");
		}

		world.structureManager.createFromWorld(
			structureId,
			dimension,
			{ x, y: spot.baseY, z },
			{ x, y: spot.baseY + cells - 1, z },
			{ includeBlocks: true, includeEntities: false, saveMode: StructureSaveMode.World }
		);
		if (!world.structureManager.get(structureId)) throw new Error("structure missing after save");
		ok = true;
	} catch (error) {
		reason = String(error?.message ?? error);
	} finally {
		restoreVaultCells(dimension, x, z, spot.baseY, originals);
	}

	if (!ok) {
		safeGet(() => world.structureManager.delete(structureId));
		debugLog(`saveVault failed: ${reason}`);
		return { ok: false, reason };
	}
	return { ok: true, vaultId, stacks: expected.stacks };
}

// Places the vault structure, moves the items into the (empty) backpack container, then deletes the vault.
// Returns { ok } or { ok: false, missing?, reason }. On any failure nothing is lost: the vault stays.
function loadVault(dimension, x, z, vaultId, container, slotCount) {
	const structureId = getVaultStructureId(vaultId);
	const structure = safeGet(() => world.structureManager.get(structureId), undefined);
	if (!structure) return { ok: false, missing: true, reason: "vault not found" };

	const cells = Math.max(1, Math.floor(safeGet(() => structure.size.y, 1)));
	const spot = findVaultSpot(dimension, x, z, cells);
	if (!spot) return { ok: false, reason: "no free space at the build limit" };

	const originals = [];
	const written = [];
	let ok = false;
	let reason = "unknown error";

	try {
		for (let k = 0; k < cells; k++) {
			originals.push(dimension.getBlock({ x, y: spot.baseY + k, z }).permutation);
		}

		world.structureManager.place(structureId, dimension, { x, y: spot.baseY, z }, {
			includeBlocks: true,
			includeEntities: false
		});

		const staged = [];
		for (let k = 0; k < cells; k++) {
			const barrel = getBlockInventory(dimension.getBlock({ x, y: spot.baseY + k, z }));
			if (!barrel) throw new Error("placed vault has no inventory");
			for (let slot = 0; slot < VAULT_CELL_SLOTS; slot++) {
				const item = barrel.getItem(slot);
				if (item) staged.push({ slot: k * VAULT_CELL_SLOTS + slot, item });
			}
		}

		if (staged.some((entry) => entry.slot >= slotCount)) throw new Error("vault does not fit this backpack");

		// Every item goes back to its own slot; if something else sits there (bundle items are filled in too),
		// to the first free slot. Nothing is overwritten.
		const before = countStoredItems(container, slotCount);
		let cursor = 0;
		let stagedAmount = 0;
		for (const entry of staged) {
			stagedAmount += entry.item.amount;
			let target = entry.slot;
			if (safeGet(() => container.getItem(target), undefined)) {
				while (cursor < slotCount && safeGet(() => container.getItem(cursor), undefined)) cursor++;
				if (cursor >= slotCount) throw new Error("backpack is full");
				target = cursor;
			}
			container.setItem(target, entry.item);
			written.push(target);
		}

		const after = countStoredItems(container, slotCount);
		if (after.stacks !== before.stacks + staged.length || after.amount !== before.amount + stagedAmount) throw new Error("restore check failed");
		ok = true;
	} catch (error) {
		reason = String(error?.message ?? error);
		for (const slot of written) safeGet(() => container.setItem(slot, undefined));
	} finally {
		restoreVaultCells(dimension, x, z, spot.baseY, originals);
	}

	if (!ok) {
		debugLog(`loadVault failed: ${reason}`);
		return { ok: false, reason };
	}

	safeGet(() => world.structureManager.delete(structureId));
	return { ok: true };
}

// ---- backpack items ------------------------------------------------------------------------------
function encodeVaultLore(id) {
	return LORE_SENTINEL + id.split("").map((c) => "\u00a7" + c).join("");
}

function decodeVaultLore(lore) {
	if (!Array.isArray(lore)) return undefined;
	for (const line of lore) {
		if (typeof line !== "string" || !line.startsWith(LORE_SENTINEL)) continue;
		const id = line.slice(LORE_SENTINEL.length).split("\u00a7").join("");
		if (id.length) return id;
	}
	return undefined;
}

// The vault id is stored twice (dynamic property + hidden lore line). Either copy is enough to find the vault.
function readVaultId(itemStack) {
	const value = safeGet(() => itemStack?.getDynamicProperty(VAULT_ITEM_PROPERTY), undefined);
	if (typeof value === "string" && value.length) return value;
	return decodeVaultLore(safeGet(() => itemStack?.getLore(), undefined));
}

function applyVaultToItem(itemStack, vaultId, stacks, slotCount) {
	if (!itemStack || !vaultId) return;
	safeGet(() => itemStack.setDynamicProperty(VAULT_ITEM_PROPERTY, vaultId));
	const lore = [];
	if (Number.isInteger(stacks) && stacks > 0) lore.push(`${BACKPACK_INFO_LORE_PREFIX}${stacks}/${slotCount}`);
	lore.push(encodeVaultLore(vaultId));
	safeGet(() => itemStack.setLore(lore));
}

function createBackpackItem(typeId, vaultId, stacks) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!isBackpackTypeId(normalizedTypeId)) return undefined;

	let itemStack;
	try {
		itemStack = new ItemStack(normalizedTypeId, 1);
	} catch {
		return undefined;
	}

	applyVaultToItem(itemStack, vaultId, stacks, getBackpackSlotCount(normalizedTypeId));
	return itemStack;
}

// Saves the placed backpack into a vault and returns { ok, item, reason }. The placed backpack is not touched.
function packBackpackItem(typeId, container, slotCount, dimension, location) {
	const counted = container ? countStoredItems(container, slotCount) : { stacks: 0 };
	if (!counted.stacks) {
		const empty = createBackpackItem(typeId);
		return empty ? { ok: true, item: empty } : { ok: false, reason: "item" };
	}

	const saved = saveVault(dimension, location.x, location.z, container, slotCount);
	if (!saved.ok) return { ok: false, reason: saved.reason };
	const item = createBackpackItem(typeId, saved.vaultId, saved.stacks);
	if (!item || readVaultId(item) !== saved.vaultId) {
		safeGet(() => world.structureManager.delete(getVaultStructureId(saved.vaultId)));
		return { ok: false, reason: "item" };
	}
	// remember what hangs from the backpack (the worn model and the light follow this)
	safeGet(() => item.setDynamicProperty(ACCESSORY_PROPERTY, accessorySuffix(scanAccessories(container, slotCount))));
	const placedBlock = safeGet(() => dimension.getBlock(location), undefined);
	if (safeGet(() => placedBlock?.permutation.getState(STATE_DARK), 0) === 1) safeGet(() => item.setDynamicProperty(DARK_PROPERTY, true));
	return { ok: true, item };
}

// Gives the backpack item to the player (or drops it) and READS IT BACK: the vault id must be on the stack that
// ends up in the world. Returns false (and takes the item away again) otherwise.
function deliverVerifiedBackpack(player, item, dimension, location) {
	const expectedVault = readVaultId(item);
	const matches = (stack) => !expectedVault || readVaultId(stack) === expectedVault;

	const inventory = safeGet(() => player?.getComponent("minecraft:inventory")?.container, null);
	if (inventory) {
		for (let slot = 0; slot < inventory.size; slot++) {
			if (safeGet(() => inventory.getItem(slot), undefined)) continue;
			try {
				inventory.setItem(slot, item);
			} catch {
				break;
			}
			const stored = safeGet(() => inventory.getItem(slot), undefined);
			if (stored && matches(stored)) return true;
			debugLog("the vault id did not survive being put into the inventory", player);
			safeGet(() => inventory.setItem(slot, undefined));
			return false;
		}
	}

	let dropped;
	try {
		dropped = dimension.spawnItem(item, getBlockCenter(location));
	} catch {
		return false;
	}
	const droppedStack = safeGet(() => dropped.getComponent("minecraft:item")?.itemStack, undefined);
	if (droppedStack && matches(droppedStack)) return true;
	debugLog("the vault id did not survive being dropped", player);
	safeGet(() => dropped.remove());
	return false;
}

// A vault that was saved for an item that could not be delivered is deleted again.
function discardPackedVault(packed) {
	const vaultId = readVaultId(packed?.item);
	if (vaultId) safeGet(() => world.structureManager.delete(getVaultStructureId(vaultId)));
}

// Pack + deliver. Returns { ok, packed }. On failure nothing was removed and no vault is left behind.
function packAndDeliver(player, typeId, container, slotCount, dimension, location) {
	const packed = packBackpackItem(typeId, container, slotCount, dimension, location);
	if (!packed.ok || !packed.item) return { ok: false, packed };
	debugLog(`pick-up: ${readVaultId(packed.item) ? `vault ${readVaultId(packed.item)}` : "empty backpack"}`, player);
	if (deliverVerifiedBackpack(player, packed.item, dimension, location)) return { ok: true, packed };
	discardPackedVault(packed);
	return { ok: false, packed: { ...packed, reason: "delivery" } };
}

// Same backpack as another item id (base <-> worn model). The vault id, name, lore, enchantments and every other
// dynamic property are copied and read back. undefined = nothing safe was done (the original stays).
function createConvertedBackpackItem(sourceItemStack, equipped) {
	if (!sourceItemStack || !isBackpackTypeId(sourceItemStack.typeId)) return undefined;

	const baseTypeId = normalizeBackpackTypeId(sourceItemStack.typeId);
	const targetTypeId = equipped ? getEquippedBackpackTypeId(baseTypeId, readAccessorySuffix(sourceItemStack)) : baseTypeId;
	if (!targetTypeId) return undefined;

	let targetItemStack;
	try {
		targetItemStack = new ItemStack(targetTypeId, 1);
	} catch {
		return undefined;
	}

	const nameTag = safeGet(() => sourceItemStack.nameTag, undefined);
	if (typeof nameTag === "string" && nameTag.length) safeGet(() => { targetItemStack.nameTag = nameTag; });

	for (const propertyId of safeGet(() => sourceItemStack.getDynamicPropertyIds(), [])) {
		const value = safeGet(() => sourceItemStack.getDynamicProperty(propertyId), undefined);
		if (value !== undefined) safeGet(() => targetItemStack.setDynamicProperty(propertyId, value));
	}
	const lore = safeGet(() => sourceItemStack.getLore(), []);
	if (lore?.length) safeGet(() => targetItemStack.setLore(lore));

	const enchantments = safeGet(() => sourceItemStack.getComponent("minecraft:enchantable")?.getEnchantments(), undefined);
	if (enchantments?.length) safeGet(() => targetItemStack.getComponent("minecraft:enchantable")?.addEnchantments(enchantments));

	const vaultId = readVaultId(sourceItemStack);
	if (vaultId && readVaultId(targetItemStack) !== vaultId) applyVaultToItem(targetItemStack, vaultId);
	if (vaultId && readVaultId(targetItemStack) !== vaultId) return undefined;
	return targetItemStack;
}

// ---- entity per placed backpack -----------------------------------------------------------------
function spawnBackpackEntity(block) {
	if (!block || !isBackpackTypeId(block.typeId)) return null;

	const dimension = block.dimension;
	const pos = block.location;

	let entity = null;
	try {
		entity = dimension.spawnEntity(getBackpackEntityTypeId(block.typeId), {
			x: pos.x + 0.5,
			y: pos.y,
			z: pos.z + 0.5
		});
	} catch {
		return null;
	}

	try {
		entity.nameTag = getBackpackContainerTitle(block.typeId);
		entity.addTag(backpackTag(pos));
		entity.addTag(`${BACKPACK_TYPE_TAG_PREFIX}${normalizeBackpackTypeId(block.typeId).slice(BACKPACK_NAMESPACE.length)}`);
	} catch { }

	return entity;
}

// Several entities for one block (should not happen): move everything into the first, drop the rest.
function mergeDuplicateEntities(keeper, extras, block) {
	const keeperContainer = getEntityContainer(keeper);
	const slotCount = getBackpackSlotCount(block.typeId);

	for (const extra of extras) {
		const container = getEntityContainer(extra);
		for (let slot = 0; container && keeperContainer && slot < slotCount; slot++) {
			const item = safeGet(() => container.getItem(slot), undefined);
			if (!item || isBackpackControlButtonItem(item)) continue;

			const leftover = safeGet(() => keeperContainer.addItem(item), item);
			if (leftover) safeGet(() => block.dimension.spawnItem(leftover, getBlockCenter(block.location)));
			safeGet(() => container.setItem(slot, undefined));
		}
		removeBackpackEntity(extra);
	}
}

function restorePendingVault(block, entity) {
	const vaultId = readPendingMarker(block.dimension, block.location);
	if (!vaultId) return;

	const container = getEntityContainer(entity);
	const slotCount = getBackpackSlotCount(block.typeId);
	if (!container) return;

	const result = loadVault(block.dimension, block.location.x, block.location.z, vaultId, container, slotCount);
	if (result.ok || result.missing) clearPendingMarker(block.dimension, block.location);
}

function ensureBackpackEntity(block) {
	if (!block || !isBackpackTypeId(block.typeId)) return null;

	const expectedType = getBackpackEntityTypeId(block.typeId);
	const entities = getBackpackEntitiesAt(block.dimension, block.location);
	let entity = entities.find((candidate) => candidate.typeId === expectedType) ?? null;

	if (entity) {
		const extras = entities.filter((candidate) => candidate !== entity);
		if (extras.length) mergeDuplicateEntities(entity, extras, block);
	} else {
		if (entities.length) mergeDuplicateEntities(entities[0], entities.slice(1), block);
		entity = spawnBackpackEntity(block);
		if (entity && entities.length) removeBackpackEntity(entities[0]);
	}
	if (!entity) return null;

	restorePendingVault(block, entity);
	return entity;
}

// ---- placing and breaking ------------------------------------------------------------------------
function rememberPendingPlacement(player, typeId, vaultId, dark) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!isBackpackTypeId(normalizedTypeId)) return;

	const key = getPlayerKey(player);
	const queue = pendingPlacements.get(key) ?? [];
	const now = Date.now();
	const lastEntry = queue[queue.length - 1];
	const vault = vaultId ?? "";

	if (lastEntry && lastEntry.typeId === normalizedTypeId && lastEntry.vault === vault && !!lastEntry.dark === !!dark && now - lastEntry.time < 100) {
		lastEntry.time = now;
		pendingPlacements.set(key, queue);
		return;
	}

	queue.push({ typeId: normalizedTypeId, vault, time: now, dark: !!dark });
	pendingPlacements.set(key, queue);
}

function consumePendingPlacement(player, typeId) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!isBackpackTypeId(normalizedTypeId)) return undefined;

	const key = getPlayerKey(player);
	const queue = pendingPlacements.get(key);
	if (!queue?.length) return undefined;

	const now = Date.now();
	for (let index = queue.length - 1; index >= 0; index--) {
		if (now - queue[index].time > BACKPACK_PENDING_MAX_AGE_MS) queue.splice(index, 1);
	}

	let result;
	for (let index = queue.length - 1; index >= 0; index--) {
		if (queue[index].typeId !== normalizedTypeId) continue;
		result = queue.splice(index, 1)[0];
		break;
	}

	if (queue.length) pendingPlacements.set(key, queue);
	else pendingPlacements.delete(key);
	return result;
}

function breakBackpackAt(dimension, location, player) {
	const breakKey = blockLocationKey(dimension, location);
	if (activeBreaks.has(breakKey)) return;
	activeBreaks.add(breakKey);

	system.run(() => {
		try {
			const block = dimension.getBlock(location);
			if (!block || !isBackpackTypeId(block.typeId)) return;

			const typeId = block.typeId;
			const slotCount = getBackpackSlotCount(typeId);
			const allEntities = getBackpackEntitiesAt(dimension, location);
			const entity = ensureBackpackEntity(block);
			const container = getEntityContainer(entity);

			const waitingVault = readPendingMarker(dimension, location);
			if (container && waitingVault) {
				// The contents are still being restored from a vault: hand the vault back instead of mixing contents.
				if (countStoredItems(container, slotCount).stacks) {
					safeGet(() => player?.sendMessage("§eThe backpack is still being filled, try again in a moment."));
					return;
				}
				const waiting = createBackpackItem(typeId, waitingVault, 0);
				if (!waiting || !deliverVerifiedBackpack(player, waiting, dimension, location)) {
					safeGet(() => player?.sendMessage("§cThe backpack could not be picked up."));
					return;
				}
				clearPendingMarker(dimension, location);
				removeBackpackEntities([entity, ...allEntities.filter((other) => other !== entity)]);
				safeGet(() => block.setPermutation(BlockPermutation.resolve("minecraft:air")));
				return;
			}

			if (container) {
				const result = packAndDeliver(player, typeId, container, slotCount, dimension, location);
				if (!result.ok) {
					safeGet(() => player?.sendMessage(`§cThe backpack contents could not be stored safely (${result.packed.reason ?? "delivery"}). The backpack was left in place.`));
					return;
				}
				clearPendingMarker(dimension, location);
				safeGet(() => container.clearAll());
				removeBackpackEntities([entity, ...allEntities.filter((other) => other !== entity)]);
				safeGet(() => block.setPermutation(BlockPermutation.resolve("minecraft:air")));
				return;
			}

			// No entity could be created: hand over a vault that was still waiting for this block.
			const item = createBackpackItem(typeId, readPendingMarker(dimension, location), 0);
			if (!item) {
				safeGet(() => player?.sendMessage("§cThe backpack could not be picked up."));
				return;
			}
			clearPendingMarker(dimension, location);
			removeBackpackEntities(allEntities);
			safeGet(() => block.setPermutation(BlockPermutation.resolve("minecraft:air")));
			giveOrDropItem(player, item, dimension, getBlockCenter(location));
		} finally {
			system.run(() => activeBreaks.delete(breakKey));
		}
	});
}

// ---- sweep: entities whose block is gone, retry pending restores ---------------------------------
function salvageOrphanEntity(entity, dimension, location) {
	const container = getEntityContainer(entity);
	const typeTag = safeGet(() => entity.getTags().find((tag) => tag.startsWith(BACKPACK_TYPE_TAG_PREFIX)), undefined);
	let typeId = typeTag ? `${BACKPACK_NAMESPACE}${typeTag.slice(BACKPACK_TYPE_TAG_PREFIX.length)}` : undefined;
	if (!isBackpackTypeId(typeId)) typeId = getBackpackTypeIdForEntity(entity);
	const slotCount = getBackpackSlotCount(typeId);

	const result = packAndDeliver(null, typeId, container, slotCount, dimension, location);
	if (!result.ok) return; // try again on the next sweep

	safeGet(() => container?.clearAll());
	clearPendingMarker(dimension, location);
	removeBackpackEntity(entity);
}

function sweepBackpackEntities() {
	for (const dimensionId of BACKPACK_DIMENSIONS) {
		const dimension = safeGet(() => world.getDimension(dimensionId), null);
		if (!dimension) continue;

		for (const entityTypeId of BACKPACK_ENTITY_TYPES) {
			for (const entity of safeGet(() => dimension.getEntities({ type: entityTypeId }), [])) {
				const location = getBackpackLocationFromEntity(entity);
				if (!location) continue;

				const block = safeGet(() => dimension.getBlock(location), null);
				if (!block) continue; // chunk not ready

				if (!isBackpackTypeId(block.typeId)) {
					salvageOrphanEntity(entity, dimension, location);
					continue;
				}

				if (readPendingMarker(dimension, location)) restorePendingVault(block, entity);
			}
		}
	}

}

// ---- button polling (only backpacks near players) -------------------------------------------------
function pollBackpackButtons() {
	for (const player of world.getAllPlayers()) {
		const nearby = safeGet(() => player.dimension.getEntities({
			families: [BACKPACK_FAMILY],
			location: player.location,
			maxDistance: CONFIG.buttonScanRadius
		}), []);

		for (const entity of nearby) {
			if (!getBackpackLocationFromEntity(entity)) continue;
			const typeId = getBackpackTypeIdForEntity(entity);
			syncBackpackFilterButton(entity, typeId);
			syncBackpackTransferButton(entity, typeId);
			syncBackpackLightButton(entity, typeId);
		}
	}
}

// ---- worn backpack visual and drops ---------------------------------------------------------------
// The worn model is a separate "_equipped" item id that the game draws on the player (a backpack in the offhand
// slot is shown on the back). The swap keeps everything on the item (vault id, name, lore, enchantments) and is
// read back; if the copy does not match, the item is left as it is. "_equipped" items outside the offhand turn back
// into normal ones.
function syncOffhandBackpackVisual(player, scanInventory) {
	const equippable = getPlayerEquippable(player);
	if (!equippable) return;

	const offhandItem = safeGet(() => equippable.getEquipment(EquipmentSlot.Offhand), undefined);
	const playerKey = getPlayerKey(player);
	if (!isBackpackTypeId(offhandItem?.typeId)) swapBlocked.delete(playerKey);
	const wantedWornTypeId = isBackpackTypeId(offhandItem?.typeId)
		? getEquippedBackpackTypeId(offhandItem.typeId, readAccessorySuffix(offhandItem)) : undefined;
	if (wantedWornTypeId && offhandItem.typeId !== wantedWornTypeId && !swapBlocked.has(playerKey)) {
		const wornItem = createConvertedBackpackItem(offhandItem, true);
		if (wornItem) {
			safeGet(() => equippable.setEquipment(EquipmentSlot.Offhand, wornItem));
			const vaultId = readVaultId(offhandItem);
			const now = safeGet(() => equippable.getEquipment(EquipmentSlot.Offhand), undefined);
			if (vaultId && readVaultId(now) !== vaultId) {
				// The game dropped the vault id during the swap: put the original back and stop swapping this one.
				safeGet(() => equippable.setEquipment(EquipmentSlot.Offhand, offhandItem));
				swapBlocked.add(playerKey);
				debugLog("worn model swap lost the vault id, the original item was put back", player);
			}
		}
	}

	updateWornLight(player, safeGet(() => equippable.getEquipment(EquipmentSlot.Offhand), undefined));

	const mainhandItem = safeGet(() => equippable.getEquipment(EquipmentSlot.Mainhand), undefined);
	if (isEquippedBackpackTypeId(mainhandItem?.typeId)) {
		const normalizedItem = createConvertedBackpackItem(mainhandItem, false);
		if (normalizedItem) safeGet(() => equippable.setEquipment(EquipmentSlot.Mainhand, normalizedItem));
	}

	if (!scanInventory) return;
	const inventory = safeGet(() => player?.getComponent("minecraft:inventory")?.container, null);
	if (!inventory) return;

	for (let slot = 0; slot < inventory.size; slot++) {
		const itemStack = safeGet(() => inventory.getItem(slot), undefined);
		if (!isEquippedBackpackTypeId(itemStack?.typeId)) continue;

		const normalizedItem = createConvertedBackpackItem(itemStack, false);
		if (normalizedItem) safeGet(() => inventory.setItem(slot, normalizedItem));
	}
}

function normalizeDroppedBackpackItem(entity) {
	if (!entity || safeGet(() => entity.typeId, undefined) !== "minecraft:item") return;

	const itemStack = safeGet(() => entity.getComponent("minecraft:item")?.itemStack, undefined);
	if (!isEquippedBackpackTypeId(itemStack?.typeId)) return;

	const normalizedItem = createConvertedBackpackItem(itemStack, false);
	const location = safeGet(() => entity.location, undefined);
	const dimension = safeGet(() => entity.dimension, undefined);
	if (!normalizedItem || !location || !dimension) return;

	safeGet(() => entity.remove());
	safeGet(() => dimension.spawnItem(normalizedItem, location));
}

// ---- carrying limit -------------------------------------------------------------------------------
function isCreativePlayer(player) {
	return safeGet(() => player.getGameMode() === GameMode.Creative, false);
}

function warnBackpackLimit(player, limit) {
	const playerKey = getPlayerKey(player);
	const now = Date.now();
	const lastWarningAt = backpackLimitWarnings.get(playerKey) ?? 0;
	if (now - lastWarningAt < BACKPACK_LIMIT_WARNING_COOLDOWN_MS) return;

	backpackLimitWarnings.set(playerKey, now);
	safeGet(() => player.sendMessage(`§cYou can not have more than ${limit} backpack${limit === 1 ? "" : "s"}`));
}

function enforceBackpackLimit(player) {
	const limit = CONFIG.maxBackpacksPerPlayer;
	if (!Number.isInteger(limit) || limit <= 0) return;
	if (isCreativePlayer(player)) return;

	const inventory = safeGet(() => player?.getComponent("minecraft:inventory")?.container, null);
	if (!inventory) return;

	const backpackSlots = [];
	for (let slot = 0; slot < inventory.size; slot++) {
		const itemStack = safeGet(() => inventory.getItem(slot), undefined);
		if (!isBackpackTypeId(itemStack?.typeId)) continue;
		backpackSlots.push({ slot, itemStack });
	}

	if (backpackSlots.length <= limit) return;

	let removedBackpacks = 0;
	for (let index = backpackSlots.length - 1; index >= limit; index--) {
		const entry = backpackSlots[index];
		try {
			inventory.setItem(entry.slot);
			if (ejectOverflowBackpack(player, entry.itemStack)) removedBackpacks++;
		} catch { }
	}

	if (removedBackpacks > 0) warnBackpackLimit(player, limit);
}

// ---- recolor: dye a placed backpack (every item stays inside) -----------------------------------------
// Which dye gives which look, per backpack family. "" = the plain (undyed) look.
const BACKPACK_RECOLOR = {
	small: { blue_dye: "blue", green_dye: "green", purple_dye: "purple", red_dye: "red", brown_dye: "" },
	large: { blue_dye: "blue", green_dye: "green", purple_dye: "purple", red_dye: "red", brown_dye: "" },
	axolotl: { blue_dye: "blue" }
};
const BACKPACK_FAMILY_SUFFIX = { small: BACKPACK_SUFFIX, large: LARGE_BACKPACK_SUFFIX, axolotl: `axolotl_${BACKPACK_SUFFIX}` };
const recolorKeys = new Set();

function getBackpackFamily(typeId) {
	const localId = String(normalizeBackpackTypeId(typeId)).slice(BACKPACK_NAMESPACE.length);
	if (localId.endsWith(LARGE_BACKPACK_SUFFIX)) return "large";
	if (localId.endsWith(`axolotl_${BACKPACK_SUFFIX}`)) return "axolotl";
	return "small";
}

function getBackpackDyeColor(itemStack) {
	const id = itemStack?.typeId;
	if (typeof id !== "string" || !id.startsWith("minecraft:") || !id.endsWith("_dye")) return undefined;
	return id.slice("minecraft:".length, -"_dye".length);
}

function consumeHeldDye(player, color) {
	if (isCreativePlayer(player)) return;
	const inventory = safeGet(() => player.getComponent("minecraft:inventory")?.container, null);
	const slot = safeGet(() => player.selectedSlotIndex, undefined);
	if (!inventory || !Number.isInteger(slot)) return;

	const held = safeGet(() => inventory.getItem(slot), undefined);
	if (!held || getBackpackDyeColor(held) !== color) return;
	if (held.amount > 1) {
		held.amount -= 1;
		safeGet(() => inventory.setItem(slot, held));
	} else {
		safeGet(() => inventory.setItem(slot, undefined));
	}
}

// Changes the block and the entity tags only. The container entity (and so every item) is never touched.
function recolorBackpackAt(player, dimension, location, dye) {
	const block = safeGet(() => dimension.getBlock(location), null);
	if (!block || !isBackpackTypeId(block.typeId)) return;

	const family = getBackpackFamily(block.typeId);
	const color = BACKPACK_RECOLOR[family][`${dye}_dye`];
	const dyeName = dye.replace("_", " ");
	if (color === undefined) {
		const options = Object.keys(BACKPACK_RECOLOR[family]).map((id) => id.slice(0, -"_dye".length).replace("_", " ")).join(", ");
		safeGet(() => player?.sendMessage(`§7This backpack can be dyed with: ${options}.`));
		return;
	}

	const newTypeId = `${BACKPACK_NAMESPACE}${color ? `${color}_` : ""}${BACKPACK_FAMILY_SUFFIX[family]}`;
	if (normalizeBackpackTypeId(block.typeId) === newTypeId) {
		safeGet(() => player?.sendMessage("§7That backpack already has this look."));
		return;
	}

	const entity = ensureBackpackEntity(block);
	if (!entity) {
		safeGet(() => player?.sendMessage("§cThe backpack could not be dyed right now."));
		return;
	}

	const direction = safeGet(() => block.permutation.getState("minecraft:cardinal_direction"), undefined);
	let permutation;
	try {
		const states = direction ? { "minecraft:cardinal_direction": direction } : {};
		for (const stateName of [STATE_LAVA, STATE_LAMP]) {
			const value = safeGet(() => block.permutation.getState(stateName), undefined);
			if (value !== undefined) states[stateName] = value;
		}
		permutation = BlockPermutation.resolve(newTypeId, states);
		block.setPermutation(permutation);
	} catch {
		safeGet(() => player?.sendMessage("§cThe backpack could not be dyed right now."));
		return;
	}

	for (const candidate of getBackpackEntitiesAt(dimension, location)) {
		safeGet(() => {
			for (const tag of candidate.getTags()) {
				if (tag.startsWith(BACKPACK_TYPE_TAG_PREFIX)) candidate.removeTag(tag);
			}
			candidate.addTag(`${BACKPACK_TYPE_TAG_PREFIX}${newTypeId.slice(BACKPACK_NAMESPACE.length)}`);
			candidate.nameTag = getBackpackContainerTitle(newTypeId);
		});
	}

	consumeHeldDye(player, dye);
	safeGet(() => player?.sendMessage(`§aBackpack dyed (${dyeName}).`));
}

// ---- light on/off button ----------------------------------------------------------------------------
// A third helper slot (after filter and transfer) holds a marker item that is the button's icon. Taking it out is
// the click: the light state (block state bapa:dark) flips and the marker comes back with the other icon.
function getBackpackLightButtonSlot(typeId) {
	return getBackpackSlotCount(typeId) + 2;
}

function isBackpackLightButtonItem(itemStack) {
	const id = itemStack?.typeId;
	return typeof id === "string" && id.startsWith("bapa:backpack_light_") && id.endsWith("_button");
}

// The button icon follows the backpack's colour theme (the axolotl backpack uses light blue).
function getBackpackLightTheme(typeId) {
	const local = String(normalizeBackpackTypeId(typeId)).slice(BACKPACK_NAMESPACE.length);
	if (local.endsWith("axolotl_backpack")) return "light_blue";
	const color = local.replace(/_?(large_)?backpack$/, "");
	return ["blue", "green", "purple", "red", "light_blue"].includes(color) ? color : "default";
}

function getLightButtonItemId(typeId, dark) {
	const theme = getBackpackLightTheme(typeId);
	const state = dark ? "off" : "on";
	return theme === "default" ? `bapa:backpack_light_${state}_button` : `bapa:backpack_light_${theme}_${state}_button`;
}

function clearLightButtonItemsFromPlayers(entity) {
	const dimensionId = safeGet(() => entity?.dimension?.id, undefined);
	for (const player of world.getAllPlayers()) {
		if (safeGet(() => player.dimension?.id, undefined) !== dimensionId) continue;
		const cursor = safeGet(() => player.getComponent("minecraft:cursor_inventory"), null);
		if (isBackpackLightButtonItem(safeGet(() => cursor?.item, undefined))) safeGet(() => cursor.clear());
		const inventory = safeGet(() => player.getComponent("minecraft:inventory")?.container, null);
		if (!inventory) continue;
		for (let slot = 0; slot < inventory.size; slot++) {
			if (isBackpackLightButtonItem(safeGet(() => inventory.getItem(slot), undefined))) safeGet(() => inventory.setItem(slot, undefined));
		}
	}
	const entityLocation = safeGet(() => entity?.location, undefined);
	const dropped = entityLocation ? safeGet(() => entity.dimension.getEntities({
		type: "minecraft:item", location: entityLocation, maxDistance: BACKPACK_TRANSFER_BUTTON_CLEANUP_RADIUS
	}), []) : [];
	for (const itemEntity of dropped) {
		if (isBackpackLightButtonItem(safeGet(() => itemEntity.getComponent("minecraft:item")?.itemStack, undefined))) safeGet(() => itemEntity.remove());
	}
}

function syncBackpackLightButton(entity, typeId) {
	const normalizedTypeId = normalizeBackpackTypeId(typeId);
	if (!entity || entity.typeId !== getBackpackEntityTypeId(normalizedTypeId)) return;

	const container = getEntityContainer(entity);
	const slot = getBackpackLightButtonSlot(normalizedTypeId);
	if (!container || getRawContainerSize(container) <= slot) return; // backpacks placed before this feature have no button slot

	const location = getBackpackLocationFromEntity(entity);
	const block = location ? safeGet(() => entity.dimension.getBlock(location), null) : null;
	if (!block || !isBackpackTypeId(block.typeId)) return;
	const dark = safeGet(() => block.permutation.getState(STATE_DARK), undefined);
	if (dark === undefined) return;

	const setMarker = (isDark) => safeGet(() => container.setItem(slot, new ItemStack(getLightButtonItemId(normalizedTypeId, isDark), 1)));
	const current = safeGet(() => container.getItem(slot), undefined);
	let state = lightButtonStates.get(entity.id);
	if (!state) {
		state = { armed: false };
		lightButtonStates.set(entity.id, state);
	}

	if (isBackpackLightButtonItem(current)) {
		if (current.typeId !== getLightButtonItemId(normalizedTypeId, dark === 1)) setMarker(dark === 1);
		state.armed = true;
		return;
	}

	if (current) {
		// the helper slot is never storage: give an accidentally placed item back
		safeGet(() => container.setItem(slot, undefined));
		safeGet(() => entity.dimension.spawnItem(current, getBlockCenter(location)));
		state.armed = false;
		setMarker(dark === 1);
		return;
	}

	if (!state.armed) {
		setMarker(dark === 1);
		return;
	}

	// the marker was taken out: that is a click
	state.armed = false;
	clearLightButtonItemsFromPlayers(entity);
	const nextDark = dark === 1 ? 0 : 1;
	try {
		block.setPermutation(block.permutation.withState(STATE_DARK, nextDark));
	} catch {
		debugLog("could not switch the backpack light");
	}
	setMarker(nextDark === 1);
}

// ---- lava bucket / lantern: model parts and light ---------------------------------------------------
// What is inside decides what hangs from the backpack: a lava bucket on one side, a lantern or soul lantern on the
// other. Placed: block states bapa:lava / bapa:lamp (model parts + block light). Worn: a worn-model variant of the
// item (id suffix) plus an invisible light block at the wearer's head.
function scanAccessories(container, slotCount) {
	let lava = 0;
	let lamp = 0;
	const size = Math.min(slotCount ?? 0, safeGet(() => container?.size, 0) ?? 0);
	for (let slot = 0; slot < size; slot++) {
		const id = safeGet(() => container.getItem(slot)?.typeId, undefined);
		if (id === "minecraft:lava_bucket") lava = 1;
		else if (id === "minecraft:lantern") lamp = 1;
		else if (id === "minecraft:soul_lantern" && lamp === 0) lamp = 2;
	}
	return { lava, lamp };
}

function accessorySuffix(flags) {
	return `${flags?.lava ? "l" : ""}${flags?.lamp === 1 ? "n" : flags?.lamp === 2 ? "s" : ""}`;
}

function readAccessorySuffix(itemStack) {
	const value = safeGet(() => itemStack?.getDynamicProperty(ACCESSORY_PROPERTY), undefined);
	return typeof value === "string" && ["l", "n", "s", "ln", "ls"].includes(value) ? value : "";
}

// Light level: lava 10, soul lantern 8, lantern 12, lava + lantern 15 (lava + soul lantern: 12).
function accessoryLightLevel(flags) {
	const lava = !!flags?.lava;
	if (lava && flags.lamp === 1) return 15;
	if (lava && flags.lamp === 2) return 12;
	if (flags?.lamp === 1) return 12;
	if (flags?.lamp === 2) return 8;
	return lava ? 10 : 0;
}

function updateBackpackAccessories() {
	for (const player of world.getAllPlayers()) {
		const nearby = safeGet(() => player.dimension.getEntities({
			families: [BACKPACK_FAMILY],
			location: player.location,
			maxDistance: ACCESSORY_SCAN_RADIUS
		}), []);

		for (const entity of nearby) {
			const location = getBackpackLocationFromEntity(entity);
			if (!location) continue;
			const block = safeGet(() => entity.dimension.getBlock(location), null);
			if (!block || !isBackpackTypeId(block.typeId)) continue;

			const flags = scanAccessories(getEntityContainer(entity), getBackpackSlotCount(block.typeId));
			const lava = safeGet(() => block.permutation.getState(STATE_LAVA), undefined);
			const lamp = safeGet(() => block.permutation.getState(STATE_LAMP), undefined);
			if (lava === undefined || lamp === undefined) continue;
			if (lava === flags.lava && lamp === flags.lamp) continue;
			try {
				block.setPermutation(block.permutation.withState(STATE_LAVA, flags.lava).withState(STATE_LAMP, flags.lamp));
			} catch {
				debugLog("could not update the lava/lantern model", player);
			}
		}
	}
}

function removeWornLight(playerKey) {
	const previous = wornLights.get(playerKey);
	if (!previous) return;
	wornLights.delete(playerKey);
	safeGet(() => {
		const block = world.getDimension(previous.dimensionId).getBlock({ x: previous.x, y: previous.y, z: previous.z });
		if (block?.typeId.startsWith(LIGHT_BLOCK_PREFIX)) block.setType("minecraft:air");
	});
}

function updateWornLight(player, offhandItem) {
	const playerKey = getPlayerKey(player);
	const dark = safeGet(() => offhandItem?.getDynamicProperty(DARK_PROPERTY), false) === true;
	const suffix = isBackpackTypeId(offhandItem?.typeId) && !dark ? readAccessorySuffix(offhandItem) : "";
	const level = accessoryLightLevel({ lava: suffix.includes("l") ? 1 : 0, lamp: suffix.includes("n") ? 1 : suffix.includes("s") ? 2 : 0 });
	if (!level) {
		removeWornLight(playerKey);
		return;
	}

	const loc = player.location;
	const target = { x: Math.floor(loc.x), y: Math.floor(loc.y + 1), z: Math.floor(loc.z) };
	const previous = wornLights.get(playerKey);
	const block = safeGet(() => player.dimension.getBlock(target), null);
	if (!block) return;
	const wantedId = `${LIGHT_BLOCK_PREFIX}${level}`;
	if (previous && previous.dimensionId === player.dimension.id && previous.x === target.x && previous.y === target.y && previous.z === target.z && block.typeId === wantedId) return;

	if (block.typeId !== "minecraft:air" && !block.typeId.startsWith(LIGHT_BLOCK_PREFIX)) return; // never replace a real block
	try {
		block.setType(wantedId);
	} catch {
		return;
	}
	const moved = previous && (previous.dimensionId !== player.dimension.id || previous.x !== target.x || previous.y !== target.y || previous.z !== target.z);
	if (moved) {
		const stale = { ...previous };
		wornLights.delete(playerKey);
		safeGet(() => {
			const old = world.getDimension(stale.dimensionId).getBlock({ x: stale.x, y: stale.y, z: stale.z });
			if (old?.typeId.startsWith(LIGHT_BLOCK_PREFIX)) old.setType("minecraft:air");
		});
	}
	wornLights.set(playerKey, { dimensionId: player.dimension.id, x: target.x, y: target.y, z: target.z });
}

world.afterEvents.playerLeave.subscribe((event) => {
	removeWornLight(event.playerId);
});

// ---- events ----------------------------------------------------------------------------------------
// The vault id is read before the block is placed (the item is gone afterwards).
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
	const itemStack = event.itemStack;
	if (!isBackpackTypeId(itemStack?.typeId)) return;

	debugLog(`place: vault ${readVaultId(itemStack) ?? "none"}`, event.player);
	rememberPendingPlacement(event.player, itemStack.typeId, readVaultId(itemStack), safeGet(() => itemStack.getDynamicProperty(DARK_PROPERTY), false) === true);
});

world.afterEvents.playerPlaceBlock.subscribe((event) => {
	const block = event.block;
	if (!block || !isBackpackTypeId(block.typeId)) return;

	const pending = consumePendingPlacement(event.player, block.typeId);
	if (pending?.vault) writePendingMarker(block.dimension, block.location, pending.vault);
	if (pending?.dark) {
		system.run(() => safeGet(() => {
			const placed = block.dimension.getBlock(block.location);
			if (placed && isBackpackTypeId(placed.typeId)) placed.setPermutation(placed.permutation.withState(STATE_DARK, 1));
		}));
	}

	system.run(() => {
		const liveBlock = safeGet(() => block.dimension.getBlock(block.location), undefined);
		if (!liveBlock || !isBackpackTypeId(liveBlock.typeId)) return;
		ensureBackpackEntity(liveBlock);
	});
});

world.beforeEvents.playerBreakBlock.subscribe((event) => {
	const block = event.block;
	if (!block || !isBackpackTypeId(block.typeId)) return;

	event.cancel = true;
	breakBackpackAt(block.dimension, block.location, event.player);
});

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
	const block = event.block;
	if (!block || !isBackpackTypeId(block.typeId)) return;

	system.run(() => {
		const liveBlock = safeGet(() => block.dimension.getBlock(block.location), undefined);
		if (!liveBlock || !isBackpackTypeId(liveBlock.typeId)) return;
		ensureBackpackEntity(liveBlock);
	});
});

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
	const color = getBackpackDyeColor(event.itemStack);
	if (!color || !isBackpackTypeId(event.block?.typeId)) return;

	event.cancel = true;
	const { player, block } = event;
	const key = blockLocationKey(block.dimension, block.location);
	if (recolorKeys.has(key)) return; // the same click can arrive twice
	recolorKeys.add(key);
	system.run(() => {
		try {
			recolorBackpackAt(player, block.dimension, block.location, color);
		} finally {
			recolorKeys.delete(key);
		}
	});
});

world.afterEvents.entityHitEntity.subscribe((event) => {
	if (!BACKPACK_ENTITY_TYPES.includes(event.hitEntity?.typeId)) return;
	if (event.damagingEntity?.typeId !== "minecraft:player") return;

	const location = getBackpackLocationFromEntity(event.hitEntity);
	if (!location) return;

	breakBackpackAt(event.hitEntity.dimension, location, event.damagingEntity);
});

world.afterEvents.entitySpawn.subscribe((event) => {
	normalizeDroppedBackpackItem(event.entity);
});

system.runInterval(pollBackpackButtons, BUTTON_POLL_INTERVAL_TICKS);

system.runInterval(() => {
	offhandSyncCounter = (offhandSyncCounter + 1) % FULL_INVENTORY_SYNC_EVERY;
	const scanInventory = offhandSyncCounter === 0;
	for (const player of world.getAllPlayers()) {
		syncOffhandBackpackVisual(player, scanInventory);
	}
}, OFFHAND_SYNC_INTERVAL_TICKS);

system.runInterval(() => {
	for (const player of world.getAllPlayers()) {
		enforceBackpackLimit(player);
	}
}, LIMIT_CHECK_INTERVAL_TICKS);

system.runInterval(sweepBackpackEntities, SWEEP_INTERVAL_TICKS);

system.runInterval(updateBackpackAccessories, ACCESSORY_SCAN_INTERVAL_TICKS);
