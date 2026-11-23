package app.babs.core

/**
 * Automatic load order, ported from Bedrock Hub's add-on engine (engine/addon_engine.py: _relations, _plan_kind,
 * merge_new), which came from the Mod Loader. Orders are in world-file order with later packs winning, the
 * family's default ("last wins").
 *
 * Rules, strongest first. When two disagree, the weaker is dropped:
 * - 10: a pack goes after the packs it depends on
 * -  8: a patch or compat pack goes on top of the pack whose files it changes
 * -  7: an extended version, or a pack that changes everything another does and more, goes on top
 * -  4: of two packs changing the same files, the smaller tweak goes on top (a guess)
 * -  3: a pack named as a patch of another goes after it
 * -  2: the recommended stack: overhauls and frameworks at the bottom, small add-ons, sound and UI in the middle,
 *        performance, animation and texture packs on top
 *
 * Bedrock Hub also compares the identifiers packs define; BABS compares the files only, which catches most of the
 * same overlaps without reading every JSON file on a phone.
 */
object PackOrder {
    class Item(val uuid: String, val name: String, val deps: Set<String>, val paths: Set<String>)

    private val PATCH_NAME = Regex("\\b(patch|compat|compatibility|fix|expanded)\\b", RegexOption.IGNORE_CASE)
    private val CORE_WORDS = Regex(
        "\\b(patch|compat|compatibility|fix|expanded|addon|add-on|bp|rp|behou?rs?|resources?|packs?|v?\\d+(\\.\\d+)*)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val TIER_TOP = Regex(
        "\\b(fps|performance|optimi[sz]|16x|32x|resolution|hd|animation|animations|animated|shader|reskin|" +
            "retexture|texture|textures|actions|ui tweak|clean ui|cosmetic)\\b", RegexOption.IGNORE_CASE,
    )
    private val TIER_MID = Regex(
        "\\b(sound|sounds|audio|ambience|ambient|music|ui|hud|minimap|mini-map|map|inventory|sorting|" +
            "furniture|fishing|utility|tools?)\\b", RegexOption.IGNORE_CASE,
    )
    private val TIER_BASE = Regex(
        "\\b(overhaul|biomes?|realism|framework|library|core|api|world|dimension|dimensions|" +
            "better on bedrock|structures?|generation)\\b", RegexOption.IGNORE_CASE,
    )

    /** Files every pack has, or that Minecraft merges rather than replaces, so sharing them means nothing. */
    val MERGED = setOf(
        "textures/item_texture.json", "textures/terrain_texture.json", "textures/flipbook_textures.json",
        "textures/textures_list.json", "sounds/sound_definitions.json", "sounds/music_definitions.json",
        "ui/_ui_defs.json", "ui/_global_variables.json",
    )
    val SKIP_EXT = setOf("md", "txt", "py", "bbmodel", "psd", "ase", "gitkeep", "lang", "bat", "sh", "ps1")

    /** The files of a pack that count for overlaps: in a folder, not merged, not docs or scripts. */
    fun countedPaths(all: Sequence<String>): Set<String> = all.filter { path ->
        "/" in path && path !in MERGED && path.substringAfterLast('.', "") !in SKIP_EXT &&
            !path.startsWith("texts/") && !path.startsWith("scripts/") && !path.startsWith(".vscode/") &&
            !path.startsWith("docs/") && !path.startsWith("tools/")
    }.toSet()

    private fun core(name: String) = CORE_WORDS.replace(name.lowercase(), " ").replace(Regex("[^a-z0-9]+"), " ").trim()

    private fun tier(item: Item): Int? = when {
        TIER_TOP.containsMatchIn(item.name) -> 2
        TIER_BASE.containsMatchIn(item.name) -> 0
        TIER_MID.containsMatchIn(item.name) -> 1
        item.paths.size >= 150 -> 0
        else -> null
    }

    private data class Edge(val before: String, val after: String, val strength: Int)

    private fun relations(items: List<Item>): List<Edge> {
        val by = items.associateBy { it.uuid }
        val edges = mutableListOf<Edge>()
        for (p in items) for (d in p.deps) if (d in by && d != p.uuid) edges += Edge(d, p.uuid, 10)
        val ids = by.keys.sorted()
        for ((i, a) in ids.withIndex()) for (b in ids.drop(i + 1)) {
            val pa = by.getValue(a)
            val pb = by.getValue(b)
            val shared = pa.paths intersect pb.paths
            if (shared.isEmpty()) continue
            val patchA = PATCH_NAME.containsMatchIn(pa.name)
            val patchB = PATCH_NAME.containsMatchIn(pb.name)
            val ca = core(pa.name)
            val cb = core(pb.name)
            val related = ca.isNotEmpty() && cb.isNotEmpty() && (ca in cb || cb in ca)
            edges += when {
                patchA != patchB -> if (patchA) Edge(b, a, 8) else Edge(a, b, 8)
                related && ca != cb -> if (ca.length > cb.length) Edge(b, a, 7) else Edge(a, b, 7)
                shared == pa.paths && pa.paths != pb.paths -> Edge(a, b, 7)
                shared == pb.paths && pa.paths != pb.paths -> Edge(b, a, 7)
                pa.paths.size >= pb.paths.size -> Edge(a, b, 4)
                else -> Edge(b, a, 4)
            }
        }
        for (p in items) if (PATCH_NAME.containsMatchIn(p.name)) {
            val cp = core(p.name)
            for (q in items) if (q.uuid != p.uuid && !PATCH_NAME.containsMatchIn(q.name)) {
                val cq = core(q.name)
                if (cq.isNotEmpty() && cp.isNotEmpty() && (cq in cp || cp in cq)) edges += Edge(q.uuid, p.uuid, 3)
            }
        }
        val tiers = items.associate { it.uuid to tier(it) }
        for (a in ids) for (b in ids) {
            val ta = tiers[a]
            val tb = tiers[b]
            if (ta != null && tb != null && ta < tb) edges += Edge(a, b, 2)
        }
        return edges
    }

    private fun reaches(adj: Map<String, Set<String>>, from: String, to: String): Boolean {
        val stack = ArrayDeque(listOf(from))
        val seen = HashSet<String>()
        while (stack.isNotEmpty()) {
            val n = stack.removeLast()
            if (n == to) return true
            if (!seen.add(n)) continue
            adj[n]?.let { stack.addAll(it) }
        }
        return false
    }

    /**
     * Bedrock Hub's "repair" order: keeps [current] (world-file order) and new packs in their recommended slots,
     * then moves only what the rules require. Returns the uuids of [items] in world-file order.
     */
    fun order(items: List<Item>, current: List<String>): List<String> {
        val by = items.associateBy { it.uuid }
        val adj = HashMap<String, MutableSet<String>>()
        for (e in relations(items).sortedByDescending { it.strength }) {
            if (e.before == e.after || reaches(adj, e.after, e.before)) continue
            adj.getOrPut(e.before) { mutableSetOf() }.add(e.after)
        }
        // Layered packs (patches, and packs depending on others here) go after the rest, then by name.
        val layered = by.mapValues { (_, p) -> PATCH_NAME.containsMatchIn(p.name) || p.deps.any { it in by } }
        val scratch = by.keys.sortedWith(compareBy({ layered.getValue(it) }, { by.getValue(it).name.lowercase() }))
        val keep = current.filter { it in by }
        val base = if (keep.isEmpty()) scratch else mergeNew(keep, scratch)

        val rank = base.withIndex().associate { it.value to it.index }
        val indegree = by.keys.associateWith { 0 }.toMutableMap()
        adj.values.forEach { afters -> afters.forEach { indegree[it] = indegree.getValue(it) + 1 } }
        val ready = by.keys.filter { indegree.getValue(it) == 0 }.sortedBy { rank.getValue(it) }.toMutableList()
        val order = mutableListOf<String>()
        while (ready.isNotEmpty()) {
            val u = ready.removeAt(0)
            order += u
            for (v in adj[u].orEmpty().sorted()) {
                indegree[v] = indegree.getValue(v) - 1
                if (indegree.getValue(v) == 0) ready += v
            }
            ready.sortBy { rank.getValue(it) }
        }
        return order + base.filter { it !in order }
    }

    /** Puts packs missing from [keep] right after the nearest pack before them in [recommended]. */
    private fun mergeNew(keep: List<String>, recommended: List<String>): List<String> {
        val result = keep.toMutableList()
        val placed = keep.toMutableSet()
        for ((i, u) in recommended.withIndex()) {
            if (u in placed) continue
            var j = i - 1
            while (j >= 0 && recommended[j] !in placed) j--
            result.add(if (j >= 0) result.indexOf(recommended[j]) + 1 else 0, u)
            placed += u
        }
        return result
    }
}
