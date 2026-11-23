package app.babs.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.babs.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Babs pops up, winks at you, and then the app opens. About a second and a half, shown once per launch.
 */
@Composable
fun Splash(onDone: () -> Unit) {
    val scale = remember { Animatable(0.6f) }
    val alpha = remember { Animatable(0f) }
    var winking by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        launch { alpha.animateTo(1f, tween(250)) }
        scale.animateTo(1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow))
        delay(150)
        winking = true
        delay(380)
        winking = false
        delay(450)
        alpha.animateTo(0f, tween(220))
        onDone()
    }
    val minecraft = HubColors.minecraft
    Box(
        Modifier
            .fillMaxSize()
            .then(if (minecraft) Modifier.dirtBackground() else Modifier.background(HubColors.Bg)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.graphicsLayer {
                scaleX = scale.value
                scaleY = scale.value
                this.alpha = alpha.value
            },
        ) {
            Image(
                painterResource(if (winking) R.drawable.ic_mascot_wink else R.drawable.ic_mascot),
                contentDescription = "Babs the elephant",
                modifier = Modifier.size(168.dp),
            )
            Spacer(Modifier.height(12.dp))
            Text("BABS", color = HubColors.Text, fontWeight = FontWeight.Bold, fontSize = 30.sp, letterSpacing = 2.sp)
            Text("Bridged Android Bedrock Server", color = HubColors.Muted, fontSize = 13.sp)
        }
    }
}
