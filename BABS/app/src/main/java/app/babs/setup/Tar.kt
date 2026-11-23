package app.babs.setup

import android.system.Os
import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.InputStream
import java.nio.file.Files

/**
 * A small tar extractor for Linux root filesystems on Android.
 *
 * Reads ustar, GNU long names (L/K) and PAX headers (x). Symlinks are made as real symlinks. Android doesn't let
 * apps make hard links, so a hard link becomes a symlink, as proot's --link2symlink does. Device files and FIFOs are skipped, since proot binds the
 * real /dev. Every file and directory keeps its mode, plus owner read/write, so the app can always change or
 * delete what it unpacked.
 */
object Tar {
    private const val BLOCK = 512

    fun extract(input: InputStream, dest: File) {
        val data = DataInputStream(input)
        val header = ByteArray(BLOCK)
        val destPath = dest.toPath().normalize()
        val dirModes = mutableListOf<Pair<File, Int>>()
        var longName: String? = null
        var longLink: String? = null
        var pax: Map<String, String> = emptyMap()

        while (true) {
            if (!readBlock(data, header)) break
            if (header.all { it == 0.toByte() }) break

            val type = header[156].toInt().toChar()
            var size = parseNumber(header, 124, 12)
            when (type) {
                'L' -> { longName = readString(data, size); continue }
                'K' -> { longLink = readString(data, size); continue }
                'x' -> { pax = parsePax(readBytes(data, size)); continue }
                'g' -> { skip(data, padded(size)); continue }
            }

            val ustar = cString(header, 257, 6).startsWith("ustar")
            val prefix = if (ustar) cString(header, 345, 155) else ""
            val rawName = cString(header, 0, 100).let { if (prefix.isNotEmpty()) "$prefix/$it" else it }
            val name = pax["path"] ?: longName ?: rawName
            val link = pax["linkpath"] ?: longLink ?: cString(header, 157, 100)
            pax["size"]?.toLongOrNull()?.let { size = it }
            val mode = parseNumber(header, 100, 8).toInt() and 0x1FF // rwx bits only, no setuid/sticky
            longName = null
            longLink = null
            pax = emptyMap()

            val rel = normalize(name)
            if (rel == null) { skip(data, padded(size)); continue }
            val target = File(dest, rel)
            if (!target.toPath().normalize().startsWith(destPath)) {
                throw IllegalStateException("Archive entry escapes the target folder: $name")
            }

            when (type) {
                '5' -> {
                    target.mkdirs()
                    dirModes += target to mode
                    skip(data, padded(size))
                }
                '2' -> {
                    target.parentFile?.mkdirs()
                    deleteIfPresent(target)
                    Os.symlink(link, target.path)
                    skip(data, padded(size))
                }
                '1' -> {
                    // A symlink, with the absolute path as the guest sees it. Copying instead would turn
                    // Ubuntu's Rust coreutils (one binary, ~100 hard links) into 1.2 GB.
                    val source = normalize(link) ?: throw IllegalStateException("Bad hard link $name -> $link")
                    target.parentFile?.mkdirs()
                    deleteIfPresent(target)
                    Os.symlink("/$source", target.path)
                    skip(data, padded(size))
                }
                '0', '\u0000', '7' -> {
                    target.parentFile?.mkdirs()
                    deleteIfPresent(target)
                    target.outputStream().use { out -> copy(data, out, size) }
                    Os.chmod(target.path, mode or 0x180) // + owner rw
                    skip(data, padded(size) - size)
                }
                else -> skip(data, padded(size)) // devices, FIFOs
            }
        }

        // Directory modes last, so read-only directories don't block their own contents. Deepest first.
        dirModes.asReversed().forEach { (dir, mode) -> Os.chmod(dir.path, mode or 0x1C0) } // + owner rwx
    }

    /** Strips "./" and leading "/". Returns null for the archive root, throws on "..". */
    private fun normalize(name: String): String? {
        val parts = name.split('/').filter { it.isNotEmpty() && it != "." }
        if (parts.any { it == ".." }) throw IllegalStateException("Archive entry uses '..': $name")
        return parts.joinToString("/").ifEmpty { null }
    }

    private fun deleteIfPresent(file: File) {
        Files.deleteIfExists(file.toPath())
    }

    private fun padded(size: Long) = (size + BLOCK - 1) / BLOCK * BLOCK

    private fun readBlock(data: DataInputStream, block: ByteArray): Boolean = try {
        data.readFully(block)
        true
    } catch (_: EOFException) {
        false
    }

    private fun readBytes(data: DataInputStream, size: Long): ByteArray {
        val bytes = ByteArray(size.toInt())
        data.readFully(bytes)
        skip(data, padded(size) - size)
        return bytes
    }

    private fun readString(data: DataInputStream, size: Long) =
        String(readBytes(data, size), Charsets.UTF_8).trimEnd('\u0000')

    private fun copy(data: DataInputStream, out: java.io.OutputStream, size: Long) {
        val buf = ByteArray(64 * 1024)
        var left = size
        while (left > 0) {
            val n = data.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) throw EOFException("Archive ended inside a file")
            out.write(buf, 0, n)
            left -= n
        }
    }

    private fun skip(data: DataInputStream, count: Long) {
        var left = count
        while (left > 0) {
            val n = data.skip(left)
            if (n <= 0) {
                if (data.read() < 0) throw EOFException("Archive ended early")
                left--
            } else {
                left -= n
            }
        }
    }

    private fun cString(b: ByteArray, off: Int, len: Int): String {
        var end = off
        while (end < off + len && b[end] != 0.toByte()) end++
        return String(b, off, end - off, Charsets.UTF_8)
    }

    /** Octal, or GNU base-256 when the high bit of the first byte is set. */
    private fun parseNumber(b: ByteArray, off: Int, len: Int): Long {
        if (b[off].toInt() and 0x80 != 0) {
            var v = (b[off].toLong() and 0x7F)
            for (i in off + 1 until off + len) v = (v shl 8) or (b[i].toLong() and 0xFF)
            return v
        }
        val s = cString(b, off, len).trim()
        return if (s.isEmpty()) 0 else s.toLong(8)
    }

    /** PAX records: "<length> <key>=<value>\n". */
    private fun parsePax(bytes: ByteArray): Map<String, String> {
        val out = mutableMapOf<String, String>()
        var i = 0
        while (i < bytes.size) {
            var sp = i
            while (sp < bytes.size && bytes[sp] != ' '.code.toByte()) sp++
            val len = String(bytes, i, sp - i, Charsets.US_ASCII).toIntOrNull() ?: break
            val record = String(bytes, sp + 1, len - (sp - i) - 2, Charsets.UTF_8) // minus "len ", minus "\n"
            val eq = record.indexOf('=')
            if (eq > 0) out[record.substring(0, eq)] = record.substring(eq + 1)
            i += len
        }
        return out
    }
}
