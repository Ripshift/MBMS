import { system, world, Difficulty } from "@minecraft/server"; // Adicionado world e Difficulty

// Offsets (relative to block origin) for each hole on the trap's top face.
// Positions match the 8 dark holes in the spike_trap.png texture (16x16).
// Pixels: (2,3) (13,3) (5,5) (10,5) (5,10) (10,10) (2,12) (13,12) -> (px+0.5)/16
const HOLE_OFFSETS = [
    [0.156, 0.219], [0.844, 0.219],
    [0.344, 0.344], [0.656, 0.344],
    [0.344, 0.656], [0.656, 0.656],
    [0.156, 0.781], [0.844, 0.781]
];

function emitHoleParticles(block, particleId) {
    if (!particleId) return;
    const dim = block.dimension;
    const { x, y, z } = block.location;
    const baseY = y + 1.01;

    const spawnAt = (dx, dz, yJitter) => {
        // Small horizontal jitter so each puff looks organic, but stays inside the hole
        const jx = (Math.random() - 0.5) * 0.06;
        const jz = (Math.random() - 0.5) * 0.06;
        try {
            dim.spawnParticle(particleId, {
                x: x + dx + jx,
                y: baseY + yJitter,
                z: z + dz + jz
            });
        } catch (e) {
            // Particle may not be loaded; ignore.
        }
    };

    for (const [dx, dz] of HOLE_OFFSETS) {
        // Initial puff (immediate)
        spawnAt(dx, dz, 0);

        // 1-2 follow-up puffs over the next few ticks, staggered randomly
        const extra = 1 + Math.floor(Math.random() * 2); // 1 or 2
        for (let i = 0; i < extra; i++) {
            const delay = 1 + Math.floor(Math.random() * 3); // 1..3 ticks
            system.runTimeout(() => spawnAt(dx, dz, Math.random() * 0.05), delay);
        }
    }
}

system.beforeEvents.startup.subscribe(startup => {
    startup.blockComponentRegistry.registerCustomComponent("wypnt_mss:trap", {
        onStepOn: (eventData, p) => {
            const { block, entity } = eventData;
            const blockAbove = block.above();
            const params = p.params;

            // Lógica de Dano
            if (blockAbove.typeId === params.spike) {
                const isHard = world.getDifficulty() === Difficulty.Hard;
                const isItem = entity?.typeId === "minecraft:item";

                // Só aplica dano se: 1. Não for item OU 2. For item mas o jogo estiver no Hard
                if (!isItem || (isItem && isHard)) {
                    entity?.applyDamage(params.damage, { cause: 'contact' });
                }
                return;
            }

            // Ativação por pisada
            if (blockAbove.isAir || blockAbove.isLiquid) {
                block.dimension.playSound(params.soundOn, block.location, { pitch: 1.1, volume: 1.0 });
                blockAbove.setType(params.spike);
                blockAbove.setPermutation(blockAbove.permutation.withState("wypnt_mss:spike", true));
                emitHoleParticles(block, params.particle);
                
                // Repete a lógica de verificação de dificuldade aqui para o dano inicial
                const isHard = world.getDifficulty() === Difficulty.Hard;
                const isItem = entity?.typeId === "minecraft:item";

                if (!isItem || (isItem && isHard)) {
                    entity?.applyDamage(params.damage, { cause: 'contact' });
                }
            }
        },

        onStepOff: (eventData, p) => {
            const { block } = eventData;
            const params = p.params;

            if (block.above().typeId !== params.spike) return;

            const redstonePower = block.getRedstonePower?.() ?? 0;
            if (redstonePower === 0) {
                block.above().setType("minecraft:air");
                block.dimension.playSound(params.soundOff, block.location, { pitch: 1.1, volume: 1.0 });
            }
        },

        onRedstoneUpdate: (eventData, p) => {
            const { block, powerLevel } = eventData;
            const blockAbove = block.above();
            const params = p.params;

            if (powerLevel > 0) {
                if (blockAbove.typeId !== params.spike && (blockAbove.isAir || blockAbove.isLiquid)) {
                    block.dimension.playSound(params.soundOn, block.location, { pitch: 1.1, volume: 1.0 });
                    blockAbove.setType(params.spike);
                    blockAbove.setPermutation(blockAbove.permutation.withState("wypnt_mss:spike", true));
                    emitHoleParticles(block, params.particle);
                }
            } else {
                if (blockAbove.typeId === params.spike) {
                    const entitiesOnTop = block.dimension.getEntities({
                        location: { x: block.location.x + 0.5, y: block.location.y + 1, z: block.location.z + 0.5 },
                        maxDistance: 0.6
                    });

                    if (entitiesOnTop.length === 0) {
                        blockAbove.setType("minecraft:air");
                        block.dimension.playSound(params.soundOff, block.location, { pitch: 1.1, volume: 1.0 });
                    }
                }
            }
        }
    });
});