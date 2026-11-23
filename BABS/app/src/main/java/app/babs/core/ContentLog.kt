package app.babs.core

/** One message the server reported about packs or the world, as Bedrock Hub's Content Log shows it. */
data class ContentEntry(
    val id: Int,
    val time: String,
    val level: Level,
    val category: String,
    val message: String,
    val count: Int = 1,
    val detail: String = "",
) {
    enum class Level(val word: String) { Error("Error"), Warning("Warning"), Info("Info") }
}

/**
 * What the server reported about its packs since the last Start, ported from Bedrock Hub's `src/contentlog.js`.
 * Only Content Log lines have a [Category] after the time and level. A repeated message counts up instead of adding
 * a row. Script errors put their stack trace on the lines after, which becomes the entry's [ContentEntry.detail].
 *
 * The server only prints these with `content-log-console-output-enabled=true`, which BABS sets before each Start.
 */
class ContentLog {
    private val entries = mutableListOf<ContentEntry>()
    private val byKey = HashMap<String, Int>()
    private var open: Int? = null

    val all: List<ContentEntry> get() = entries.toList()

    fun clear() {
        entries.clear()
        byKey.clear()
        open = null
    }

    /** Returns true when an entry was added or changed. */
    fun add(line: String): Boolean {
        val match = CONTENT_LINE.find(line)
        if (match == null) {
            if (STAMPED_LINE.containsMatchIn(line)) open = null
            return open?.let { addDetail(it, line) } ?: false
        }
        val (time, levelWord, category, message) = match.destructured
        val level = when (levelWord) {
            "ERROR" -> ContentEntry.Level.Error
            "WARN" -> ContentEntry.Level.Warning
            else -> ContentEntry.Level.Info
        }
        val key = "$level|$category|$message"
        val index = byKey[key]
        if (index != null) {
            entries[index] = entries[index].let { it.copy(count = it.count + 1, time = time) }
            open = index
            return true
        }
        if (entries.size >= MAX_ENTRIES) {
            open = null
            return false
        }
        entries += ContentEntry(entries.size + 1, time, level, category, message)
        byKey[key] = entries.lastIndex
        open = entries.lastIndex
        return true
    }

    /** A repeat has the same stack trace, so it's only kept once. */
    private fun addDetail(index: Int, line: String): Boolean {
        val entry = entries[index]
        if (entry.count > 1 || entry.detail.length + line.length > MAX_DETAIL) return false
        entries[index] = entry.copy(detail = if (entry.detail.isEmpty()) line else entry.detail + "\n" + line)
        return true
    }

    companion object {
        const val MAX_ENTRIES = 1000
        private const val MAX_DETAIL = 4000
        private val CONTENT_LINE = Regex("""^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})\S* (\w+)] \[([^\]]+)] ?(.*)$""")
        private val STAMPED_LINE = Regex("""^\[\d{4}-\d{2}-\d{2} """)

        /** All entries as text, for Share, the same layout as Bedrock Hub's Copy all. */
        fun toText(entries: List<ContentEntry>) = entries.joinToString("\n") { e ->
            val repeats = if (e.count > 1) " (x${e.count})" else ""
            "${e.time} ${e.level.word.uppercase()} [${e.category}] ${e.message}$repeats" + if (e.detail.isNotEmpty()) "\n${e.detail}" else ""
        }
    }
}
