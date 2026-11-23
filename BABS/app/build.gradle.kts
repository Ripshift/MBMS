plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "app.babs"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.babs"
        minSdk = 29
        targetSdk = 37
        versionCode = 14
        versionName = "0.14.0"

        // Phones and tablets are arm64. x86_64 is the emulator, which runs the server without box64.
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }

        // A GitHub OAuth app's client id turns on "Sign in with GitHub" (device sign-in) for GitHub Cloud.
        // Set babsGithubClientId in gradle.properties or ~/.gradle/gradle.properties. Without it, a token is pasted.
        buildConfigField("String", "GITHUB_CLIENT_ID", "\"${project.findProperty("babsGithubClientId") ?: ""}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        // proot and box64 ship as lib*.so so Android extracts them to the (executable) native library folder.
        jniLibs { useLegacyPackaging = true }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
