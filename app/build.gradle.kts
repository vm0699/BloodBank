plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.savro.lifelink"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.savro.lifelink"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        // Backend base URL (DigiLocker OAuth exchange). Empty = offline demo mode with a simulated DigiLocker.
        // Override per build:  ./gradlew assembleRelease -PapiBase=https://api.example.com
        buildConfigField("String", "API_BASE", "\"${(project.findProperty("apiBase") as String?) ?: ""}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity:1.8.2")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.browser:browser:1.8.0")
    implementation(platform("com.google.firebase:firebase-bom:33.5.1"))
    implementation("com.google.firebase:firebase-messaging")
}

// Push notifications: drop your Firebase project's google-services.json into app/ and rebuild.
// Without it the app builds and runs normally; push is simply inactive (in-app alerts + polling still work).
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

val syncWebAsset = tasks.register<Copy>("syncWebAsset") {
    from(rootProject.file("index.html"))
    into(layout.projectDirectory.dir("src/main/assets"))
    rename("index.html", "lifelink.html")
}

// Leaflet (map engine) is vendored under libs/ so the app shell works offline; only map tiles need a network.
val syncLibs = tasks.register<Copy>("syncLibs") {
    from(rootProject.file("libs"))
    into(layout.projectDirectory.dir("src/main/assets/libs"))
}

tasks.named("preBuild") {
    dependsOn(syncWebAsset, syncLibs)
}
