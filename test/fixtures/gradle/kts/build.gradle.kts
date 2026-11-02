// A hand-written Kotlin multiplatform build covering what gradle.js reads.
plugins {
    kotlin("multiplatform") version "1.9.24"
    alias(libs.plugins.kotlin.jvm) apply false
}

val kotlinVersion = "1.9.24"

buildscript {
    dependencies {
        classpath("com.example:never-a-row:1.0")
    }
}

dependencies {
    implementation(kotlin("stdlib"))
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation('com.squareup.okio:okio:3.9.0')
    implementation(libs.bundles.ktor.server)
    implementation(libs.logback) {
        exclude(group = "org.slf4j", module = "slf4j-api")
    }
    implementation(platform(libs.koin.bom))
    implementation(libs.koin.core)
    implementation("org.jetbrains.kotlin:kotlin-reflect:$kotlinVersion")
    implementation(Deps.coroutines)
    implementation(project(":core"))
    implementation(files("libs/vendor.jar"))
    api(group = "com.google.guava", name = "guava", version = "33.2.1-jre")
    testImplementation(kotlin("test"))
    testImplementation(libs.mockk)
    detekt("io.gitlab.arturbosch.detekt:detekt-cli:1.23.6")
}

kotlin {
    jvm()
    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.coroutines.core)
        }
        val commonTest by getting {
            dependencies {
                implementation("app.cash.turbine:turbine:1.1.0")
            }
        }
    }
}
