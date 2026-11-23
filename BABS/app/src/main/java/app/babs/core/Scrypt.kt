package app.babs.core

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * scrypt (RFC 7914), as Node's crypto.scryptSync, which Bedrock Hub's settings vault uses. Android has no scrypt of
 * its own. PBKDF2 is done here too, on bytes, so a passphrase is always its UTF-8 bytes whatever the provider does.
 */
object Scrypt {
    fun derive(password: ByteArray, salt: ByteArray, n: Int, r: Int, p: Int, length: Int): ByteArray {
        require(n > 1 && n and (n - 1) == 0) { "N must be a power of 2" }
        val blockBytes = 128 * r
        val b = pbkdf2(password, salt, p * blockBytes)
        val x = IntArray(32 * r)
        val v = IntArray(32 * r * n)
        val y = IntArray(32 * r)
        for (i in 0 until p) {
            val offset = i * blockBytes
            for (k in 0 until 32 * r) x[k] = le32(b, offset + k * 4)
            for (j in 0 until n) {
                System.arraycopy(x, 0, v, j * 32 * r, 32 * r)
                blockMix(x, y, r)
            }
            for (j in 0 until n) {
                val index = x[(2 * r - 1) * 16] and (n - 1)
                val base = index * 32 * r
                for (k in 0 until 32 * r) x[k] = x[k] xor v[base + k]
                blockMix(x, y, r)
            }
            for (k in 0 until 32 * r) putLe32(b, offset + k * 4, x[k])
        }
        return pbkdf2(password, b, length)
    }

    /** PBKDF2-HMAC-SHA256 with one iteration, as scrypt uses it. */
    private fun pbkdf2(password: ByteArray, salt: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // An empty key isn't allowed by SecretKeySpec; the vault needs 12 bytes or more anyway.
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        val out = ByteArray(length)
        var block = 1
        var filled = 0
        while (filled < length) {
            mac.update(salt)
            mac.update(byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
            val u = mac.doFinal()
            val n = minOf(u.size, length - filled)
            System.arraycopy(u, 0, out, filled, n)
            filled += n
            block++
        }
        return out
    }

    private fun blockMix(b: IntArray, y: IntArray, r: Int) {
        val x = IntArray(16)
        System.arraycopy(b, (2 * r - 1) * 16, x, 0, 16)
        for (i in 0 until 2 * r) {
            for (k in 0 until 16) x[k] = x[k] xor b[i * 16 + k]
            salsa8(x)
            // Even blocks go to the first half, odd to the second
            val to = if (i % 2 == 0) (i / 2) * 16 else (r + i / 2) * 16
            System.arraycopy(x, 0, y, to, 16)
        }
        System.arraycopy(y, 0, b, 0, 32 * r)
    }

    private fun salsa8(b: IntArray) {
        val x = b.copyOf()
        repeat(4) {
            x[4] = x[4] xor Integer.rotateLeft(x[0] + x[12], 7); x[8] = x[8] xor Integer.rotateLeft(x[4] + x[0], 9)
            x[12] = x[12] xor Integer.rotateLeft(x[8] + x[4], 13); x[0] = x[0] xor Integer.rotateLeft(x[12] + x[8], 18)
            x[9] = x[9] xor Integer.rotateLeft(x[5] + x[1], 7); x[13] = x[13] xor Integer.rotateLeft(x[9] + x[5], 9)
            x[1] = x[1] xor Integer.rotateLeft(x[13] + x[9], 13); x[5] = x[5] xor Integer.rotateLeft(x[1] + x[13], 18)
            x[14] = x[14] xor Integer.rotateLeft(x[10] + x[6], 7); x[2] = x[2] xor Integer.rotateLeft(x[14] + x[10], 9)
            x[6] = x[6] xor Integer.rotateLeft(x[2] + x[14], 13); x[10] = x[10] xor Integer.rotateLeft(x[6] + x[2], 18)
            x[3] = x[3] xor Integer.rotateLeft(x[15] + x[11], 7); x[7] = x[7] xor Integer.rotateLeft(x[3] + x[15], 9)
            x[11] = x[11] xor Integer.rotateLeft(x[7] + x[3], 13); x[15] = x[15] xor Integer.rotateLeft(x[11] + x[7], 18)
            x[1] = x[1] xor Integer.rotateLeft(x[0] + x[3], 7); x[2] = x[2] xor Integer.rotateLeft(x[1] + x[0], 9)
            x[3] = x[3] xor Integer.rotateLeft(x[2] + x[1], 13); x[0] = x[0] xor Integer.rotateLeft(x[3] + x[2], 18)
            x[6] = x[6] xor Integer.rotateLeft(x[5] + x[4], 7); x[7] = x[7] xor Integer.rotateLeft(x[6] + x[5], 9)
            x[4] = x[4] xor Integer.rotateLeft(x[7] + x[6], 13); x[5] = x[5] xor Integer.rotateLeft(x[4] + x[7], 18)
            x[11] = x[11] xor Integer.rotateLeft(x[10] + x[9], 7); x[8] = x[8] xor Integer.rotateLeft(x[11] + x[10], 9)
            x[9] = x[9] xor Integer.rotateLeft(x[8] + x[11], 13); x[10] = x[10] xor Integer.rotateLeft(x[9] + x[8], 18)
            x[12] = x[12] xor Integer.rotateLeft(x[15] + x[14], 7); x[13] = x[13] xor Integer.rotateLeft(x[12] + x[15], 9)
            x[14] = x[14] xor Integer.rotateLeft(x[13] + x[12], 13); x[15] = x[15] xor Integer.rotateLeft(x[14] + x[13], 18)
        }
        for (i in 0 until 16) b[i] += x[i]
    }

    private fun le32(b: ByteArray, i: Int) =
        (b[i].toInt() and 0xff) or ((b[i + 1].toInt() and 0xff) shl 8) or ((b[i + 2].toInt() and 0xff) shl 16) or ((b[i + 3].toInt() and 0xff) shl 24)

    private fun putLe32(b: ByteArray, i: Int, v: Int) {
        b[i] = v.toByte(); b[i + 1] = (v ushr 8).toByte(); b[i + 2] = (v ushr 16).toByte(); b[i + 3] = (v ushr 24).toByte()
    }
}
