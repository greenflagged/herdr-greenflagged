pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "orders"

include(":app", ":core")
include(":web")
includeBuild("build-logic")
