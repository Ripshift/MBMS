package app.babs.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.babs.R

/** One set of the colours the screens use. */
data class Palette(
    val bg: Color,
    val side: Color,
    val panel: Color,
    val panel2: Color,
    val line: Color,
    val text: Color,
    val muted: Color,
    val accent: Color,
    val accentDark: Color,
    val green: Color,
    val red: Color,
    val warn: Color,
    val ok: Color,
    val err: Color,
    val console: Color,
)

/** Bedrock Hub's colours (renderer/styles.css), which came from the Mod Loader. The default. */
val HubPalette = Palette(
    bg = Color(0xFF14171C), side = Color(0xFF0E1014), panel = Color(0xFF1B1F26), panel2 = Color(0xFF252A33),
    line = Color(0xFF2E3440), text = Color(0xFFE7EAEE), muted = Color(0xFF8B95A5), accent = Color(0xFF3D8BFD),
    accentDark = Color(0xFF2B6FD1), green = Color(0xFF3FA152), red = Color(0xFFC8473F), warn = Color(0xFFE0A030),
    ok = Color(0xFF4CC16A), err = Color(0xFFEF5B53), console = Color(0xFF0E1014),
)

/**
 * The Minecraft menu: dirt brown behind everything (as the old pause menu), dark Minecraft grey panels, Minecraft
 * green buttons and white text. Colours chosen to look like the game's menus, not taken from it.
 */
val MinecraftPalette = Palette(
    bg = Color(0xFF5B3E29), side = Color(0xFF1E1E1F), panel = Color(0xFF313233), panel2 = Color(0xFF48494A),
    line = Color(0xFF1E1E1F), text = Color(0xFFFFFFFF), muted = Color(0xFFD0D1D4), accent = Color(0xFF3C8527),
    accentDark = Color(0xFF2A641C), green = Color(0xFF3C8527), red = Color(0xFFB3261E), warn = Color(0xFFFFD83D),
    ok = Color(0xFF7CDA5C), err = Color(0xFFFF6B6B), console = Color(0xFF1E1E1F),
)

/**
 * The colours the screens draw with. Backed by Compose state, so switching the theme redraws everything that
 * reads them. Tapping the grass block in the top bar switches between Bedrock Hub's and the Minecraft menu's.
 */
object HubColors {
    var palette by mutableStateOf(HubPalette)
    val minecraft: Boolean get() = palette == MinecraftPalette

    val Bg get() = palette.bg
    val Side get() = palette.side
    val Panel get() = palette.panel
    val Panel2 get() = palette.panel2
    val Line get() = palette.line
    val Text get() = palette.text
    val Muted get() = palette.muted
    val Accent get() = palette.accent
    val AccentDark get() = palette.accentDark
    val Green get() = palette.green
    val Red get() = palette.red
    val Warn get() = palette.warn
    val Ok get() = palette.ok
    val Err get() = palette.err
    val Console get() = palette.console
}

/**
 * Links (text buttons): Bedrock Hub's blue, or in the Minecraft menu a light green that reads on its grey, where
 * the button green would be too dark.
 */
@Composable
fun linkColors() = ButtonDefaults.textButtonColors(contentColor = if (HubColors.minecraft) Color(0xFF8CDB5E) else HubColors.Accent)

/** Monocraft, an open-licence (SIL OFL 1.1) pixel font made to look like Minecraft's, by Idrees Hassan. */
val Monocraft = FontFamily(Font(R.font.monocraft))

private fun scheme(p: Palette) = darkColorScheme(
    primary = p.accent,
    onPrimary = Color.White,
    primaryContainer = p.accentDark,
    onPrimaryContainer = Color.White,
    secondary = p.accent,
    onSecondary = Color.White,
    // Bedrock Hub's plain buttons are panel grey; the Minecraft menu's are green like the rest.
    secondaryContainer = if (p == MinecraftPalette) p.green else p.panel2,
    onSecondaryContainer = if (p == MinecraftPalette) Color.White else p.text,
    tertiary = p.green,
    onTertiary = Color.White,
    background = p.bg,
    onBackground = p.text,
    surface = p.bg,
    onSurface = p.text,
    surfaceVariant = p.panel2,
    onSurfaceVariant = p.muted,
    surfaceContainerLowest = p.side,
    surfaceContainerLow = p.panel,
    surfaceContainer = p.side,
    surfaceContainerHigh = p.panel2,
    surfaceContainerHighest = p.panel,
    outline = p.line,
    outlineVariant = p.line,
    error = p.err,
    onError = Color.White,
    errorContainer = if (p == MinecraftPalette) Color(0xFF5A1F1C) else Color(0xFF3A1E1D),
    onErrorContainer = p.text,
)

/** Bedrock Hub's cards have 10px corners, its buttons and fields 6px. */
private val hubShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(10.dp),
    large = RoundedCornerShape(10.dp),
)

/** Minecraft's menus are square. */
private val minecraftShapes = Shapes(
    extraSmall = RoundedCornerShape(0.dp),
    small = RoundedCornerShape(0.dp),
    medium = RoundedCornerShape(2.dp),
    large = RoundedCornerShape(2.dp),
    extraLarge = RoundedCornerShape(2.dp),
)

/** Every text style in Monocraft. It's wide, so a touch smaller than the defaults. */
private fun pixelTypography(): Typography {
    val base = Typography()
    fun TextStyle.pixel() = copy(fontFamily = Monocraft, letterSpacing = 0.sp, fontSize = fontSize * 0.92f, lineHeight = lineHeight * 1.05f)
    return base.copy(
        displayLarge = base.displayLarge.pixel(), displayMedium = base.displayMedium.pixel(), displaySmall = base.displaySmall.pixel(),
        headlineLarge = base.headlineLarge.pixel(), headlineMedium = base.headlineMedium.pixel(), headlineSmall = base.headlineSmall.pixel(),
        titleLarge = base.titleLarge.pixel(), titleMedium = base.titleMedium.pixel(), titleSmall = base.titleSmall.pixel(),
        bodyLarge = base.bodyLarge.pixel(), bodyMedium = base.bodyMedium.pixel(), bodySmall = base.bodySmall.pixel(),
        labelLarge = base.labelLarge.pixel(), labelMedium = base.labelMedium.pixel(), labelSmall = base.labelSmall.pixel(),
    )
}

@Composable
fun BabsTheme(content: @Composable () -> Unit) {
    val minecraft = HubColors.minecraft
    MaterialTheme(
        colorScheme = scheme(HubColors.palette),
        shapes = if (minecraft) minecraftShapes else hubShapes,
        typography = if (minecraft) pixelTypography() else Typography(),
        content = content,
    )
}

/**
 * The old pause menu's backdrop: dirt, darkened. Drawn as blocks of 8 by 8 pixels in four browns, picked by a
 * fixed pattern so it doesn't shimmer. An original pattern, not the game's texture.
 */
fun Modifier.dirtBackground(): Modifier = drawWithCache {
    // One bitmap pixel per 4dp, made once per size and drawn scaled up without smoothing, so it stays crisp.
    val px = 4.dp.toPx()
    val cols = (size.width / px).toInt().coerceAtLeast(1) + 1
    val rows = (size.height / px).toInt().coerceAtLeast(1) + 1
    val shades = intArrayOf(0xFF5B3E29.toInt(), 0xFF6B4A32.toInt(), 0xFF4C3322.toInt(), 0xFF7A563B.toInt())
    val pixels = IntArray(cols * rows) { i ->
        val x = (i % cols) % 8
        val y = (i / cols) % 8
        // Repeats every 8 pixels each way, like a block texture.
        val h = (x * 73 + y * 151 + x * y * 31) % 97
        shades[if (h < 46) 0 else if (h < 70) 1 else if (h < 86) 2 else 3]
    }
    val image = android.graphics.Bitmap.createBitmap(pixels, cols, rows, android.graphics.Bitmap.Config.ARGB_8888).asImageBitmap()
    val dst = IntSize((cols * px).toInt(), (rows * px).toInt())
    onDrawBehind {
        drawImage(image, dstSize = dst, filterQuality = FilterQuality.None)
        // Darkened, as the game darkens the dirt behind its menus.
        drawRect(Color.Black.copy(alpha = 0.35f))
    }
}
