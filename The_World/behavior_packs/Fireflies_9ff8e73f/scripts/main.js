import { world, system } from "@minecraft/server";

// Breaking a Firefly Jar releases the firefly.
const jarComponent = {
	onPlayerDestroy(event) {
		const { block, dimension } = event;
		const pos = { x: block.location.x + 0.5, y: block.location.y + 0.2, z: block.location.z + 0.5 };
		dimension.spawnEntity("korbonff:firefly_single", pos);
		dimension.playSound("block.beehive.exit", pos);
	},
};

// system.beforeEvents.startup on newer API versions, worldInitialize on older ones.
const startup = system.beforeEvents?.startup ?? world.beforeEvents.worldInitialize;
startup.subscribe((event) => {
	event.blockComponentRegistry.registerCustomComponent("korbonff:firefly_jar", jarComponent);
});
