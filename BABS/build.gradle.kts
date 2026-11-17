plugins {
    alias(libs.plugins.android.application) apply false
    // AGP 9 compiles Kotlin itself. Listing the Kotlin plugin here only pins its version,
    // so the Compose compiler plugin below matches it.
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
