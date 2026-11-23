package app.babs.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.OutputStreamWriter
import java.util.concurrent.TimeUnit

/**
 * One child process (the server, the bridge, or a diagnostic shell) with its output sent to the console.
 * stdout and stderr are merged, as in Bedrock Hub.
 */
class ManagedProcess(
    private val source: Source,
    private val scope: CoroutineScope,
) {
    @Volatile private var process: Process? = null
    @Volatile private var stopping = false
    private var stdin: OutputStreamWriter? = null

    val isAlive: Boolean get() = process?.isAlive == true

    /**
     * The signal that ended the program inside proot, if one did. proot itself exits 0 either way,
     * but prints "proot info: vpid 1: terminated with signal N".
     */
    @Volatile var lastSignal: Int? = null
        private set

    /**
     * Starts the process. [onLine] sees every output line (for "Server started." and similar),
     * [onExit] runs once when it ends, with whether the exit was asked for.
     */
    fun start(
        launch: Launch,
        workDir: File,
        onLine: (String) -> Unit = {},
        onExit: (code: Int, requested: Boolean) -> Unit = { _, _ -> },
    ) {
        check(!isAlive) { "${source.tag} is already running" }
        stopping = false
        lastSignal = null
        val p = ProcessBuilder(launch.command)
            .directory(workDir)
            .redirectErrorStream(true)
            .apply { environment().putAll(launch.env) }
            .start()
        process = p
        stdin = OutputStreamWriter(p.outputStream, Charsets.UTF_8)

        scope.launch(Dispatchers.IO) {
            p.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                lines.forEach { raw ->
                    // HMBC colours its log with ANSI escape codes, which the console can't show.
                    val line = raw.replace(ANSI, "")
                    PROOT_SIGNAL.find(line)?.let { lastSignal = it.groupValues[1].toIntOrNull() }
                    Hub.log(source, line)
                    onLine(line)
                }
            }
            val code = p.waitFor()
            onExit(code, stopping)
        }
    }

    /** Sends a line to the process's console, such as a server command. */
    fun send(line: String): Boolean {
        val w = stdin ?: return false
        return runCatching {
            w.write(line)
            w.write("\n")
            w.flush()
        }.isSuccess
    }

    /**
     * Stops the process: sends [gracefulCommand] first if given (the server's `stop` saves the world),
     * waits up to [timeoutMs], then terminates it.
     */
    suspend fun stop(gracefulCommand: String? = null, timeoutMs: Long = 20_000) {
        val p = process ?: return
        if (!p.isAlive) return
        stopping = true
        if (gracefulCommand != null) send(gracefulCommand) else p.destroy()
        val exited = withContext(Dispatchers.IO) {
            withTimeoutOrNull(timeoutMs) { p.waitFor(timeoutMs, TimeUnit.MILLISECONDS) } == true
        }
        if (!exited) {
            Hub.log(Source.Babs, "${source.tag} didn't stop within ${timeoutMs / 1000}s, so it was forced to stop")
            p.destroyForcibly()
        }
    }
}

private val PROOT_SIGNAL = Regex("""proot info: vpid 1: terminated with signal (\d+)""")

/**
 * Why a process ended, for the status cards. [code] is the exit code, [signal] the signal from proot's report.
 * A JVM or shell killed directly reports 128 + the signal as its exit code.
 */
fun exitReason(code: Int, signal: Int?): String = when (signal ?: (code - 128).takeIf { code > 128 }) {
    9 -> "Killed (signal 9). Android may have run low on memory, or stopped it for using too much CPU in the background"
    15 -> "Told to stop from outside BABS (signal 15)"
    11 -> "Crashed (signal 11, a memory fault)"
    6 -> "Crashed (signal 6, aborted)"
    null -> if (code == 0) "Stopped on its own" else "Exited with code $code"
    else -> "Stopped by signal ${signal ?: (code - 128)}"
}

/** ANSI colour and cursor codes, like ESC[36;1m. */
private val ANSI = Regex("\u001B\\[[0-9;?]*[A-Za-z]")
