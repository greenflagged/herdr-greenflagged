import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ECOSYSTEMS } from "../mods/greenflagged/audit.js";
import {
  GRADLE_COMPANIONS, GRADLE_LOCKFILES, GRADLE_NOTE, GRADLE_RESOLVED_GROUP, MAX_GRADLE_LENGTH, gradleLockResolver, isConfiguration, parseGradle,
  readGradleLock, readSettings, readVersionCatalog,
} from "../mods/greenflagged/gradle.js";
import { countsLine, directRoots, expandNode, groupKey, pathOf, treeForProject, visibleRows } from "../mods/greenflagged/tree.js";

// Every file under fixtures/gradle/ is hand-written for what gradle.js reads.
const fixtures = fileURLToPath(new URL("./fixtures/gradle/", import.meta.url));
const read = (...parts) => readFileSync(join(fixtures, ...parts), "utf8");
const kts = {
  build: read("kts", "build.gradle.kts"),
  files: {
    "settings.gradle.kts": read("kts", "settings.gradle.kts"),
    "settings.gradle": null,
    "gradle/libs.versions.toml": read("kts", "gradle", "libs.versions.toml"),
  },
  lock: read("kts", "gradle.lockfile"),
};
const groovy = {
  build: read("groovy", "build.gradle"),
  files: { "settings.gradle.kts": null, "settings.gradle": read("groovy", "settings.gradle"), "gradle/libs.versions.toml": null },
};
const at = (files, root = "/r", folder = "/r") => ({ files, root, folder });
const ktsProject = parseGradle(kts.build, at(kts.files), "build.gradle.kts");
const groovyProject = parseGradle(groovy.build, at(groovy.files));
const byName = (deps) => Object.fromEntries(deps.map((d) => [d.name, d]));
const deps = (body, context) => parseGradle(`dependencies {\n${body}\n}`, context).deps;
const pairs = (list) => list.map((d) => [d.name, d.constraint]);
const lockTree = (project, text, options) => treeForProject(project, { file: "gradle.lockfile", text, resolver: gradleLockResolver }, options);

// --- coordinates -------------------------------------------------------------------

test("string notation in both quote styles, with and without parentheses", () => {
  const k = byName(ktsProject.deps), g = byName(groovyProject.deps);
  assert.equal(k["org.jetbrains.kotlinx:kotlinx-serialization-json"].constraint, "1.6.3");
  assert.equal(k["com.squareup.okio:okio"].constraint, "3.9.0"); // 'single' in .kts
  assert.equal(g["com.squareup.retrofit2:retrofit"].constraint, "2.11.0"); // no parentheses
  assert.equal(g["com.google.code.gson:gson"].constraint, "2.11.0"); // parentheses in .gradle
  assert.deepEqual(pairs(deps('implementation "a:b:1"\nimplementation("c:d:2")\nimplementation(\'e:f:3\')')), [["a:b", "1"], ["c:d", "2"], ["e:f", "3"]]);
});

test("a coordinate with no version is managed, and a classifier or @ext is dropped", () => {
  assert.deepEqual(pairs(deps('implementation("a:b")\nimplementation("c:d:1.0:sources")\nimplementation("e:f:2.0@aar")')), [["a:b", "managed"], ["c:d", "1.0"], ["e:f", "2.0"]]);
});

test("several coordinates in one Groovy call are several rows", () => {
  const g = byName(groovyProject.deps);
  assert.equal(g["org.projectlombok:lombok"].constraint, "1.18.32");
  assert.equal(g["org.jetbrains:annotations"].constraint, "24.1.0");
});

test("the Groovy map form and Kotlin's named arguments", () => {
  const g = byName(groovyProject.deps), k = byName(ktsProject.deps);
  assert.equal(g["org.apache.commons:commons-lang3"].constraint, "3.14.0");
  assert.equal(k["com.google.guava:guava"].constraint, "33.2.1-jre");
  assert.deepEqual(pairs(deps("implementation(name = \"solo\")\nimplementation group: 'g', name: 'a'")), [["solo", "managed"], ["g:a", "managed"]]);
});

test("kotlin(\"x\") is org.jetbrains.kotlin:kotlin-x, with a version when one is given", () => {
  const k = byName(ktsProject.deps), g = byName(groovyProject.deps);
  assert.deepEqual(k["org.jetbrains.kotlin:kotlin-stdlib"], { name: "org.jetbrains.kotlin:kotlin-stdlib", constraint: "managed", dev: false });
  assert.equal(k["org.jetbrains.kotlin:kotlin-test"].dev, true);
  assert.equal(g["org.jetbrains.kotlin:kotlin-stdlib"].constraint, "managed"); // Groovy kotlin('stdlib')
  assert.deepEqual(pairs(deps('implementation(kotlin("stdlib", "1.9.0"))\nimplementation(kotlin("reflect", version = "1.8.0"))')),
    [["org.jetbrains.kotlin:kotlin-stdlib", "1.9.0"], ["org.jetbrains.kotlin:kotlin-reflect", "1.8.0"]]);
});

test("versions built from variables are shown as written", () => {
  const k = byName(ktsProject.deps), g = byName(groovyProject.deps);
  assert.equal(k["org.jetbrains.kotlin:kotlin-reflect"].constraint, "$kotlinVersion");
  assert.equal(g["com.squareup.okhttp3:okhttp"].constraint, "$okhttpVersion");
  assert.equal(g["commons-io:commons-io"].constraint, "commonsIoVersion"); // version: commonsIoVersion
  assert.deepEqual(pairs(deps('implementation("g:a:${v.x}")\nimplementation(group = "g", name = "b", version = libVersion)\nimplementation("$grp:$art:1.0")')),
    [["g:a", "${v.x}"], ["g:b", "libVersion"], ["$grp:$art:1.0", null]]);
});

test("a bare identifier coordinate is a row named as written", () => {
  assert.deepEqual(byName(ktsProject.deps)["Deps.coroutines"], { name: "Deps.coroutines", constraint: null, dev: false });
  assert.deepEqual(byName(groovyProject.deps)["deps.okhttp"], { name: "deps.okhttp", constraint: null, dev: false });
  assert.deepEqual(pairs(deps("implementation(coroutines)")), [["coroutines", null]]);
});

test("other argument shapes are left out", () => {
  assert.deepEqual(deps('implementation(npm("left-pad", "1.3.0"))\nimplementation("a:b:" + v)\nimplementation("not a coordinate")\nimplementation(gradleTestKit())'), []);
});

test("platform and enforcedPlatform are BOM rows", () => {
  assert.equal(byName(ktsProject.deps)["io.insert-koin:koin-bom"].marker, "BOM"); // platform(libs.koin.bom)
  assert.equal(byName(groovyProject.deps)["org.springframework.boot:spring-boot-dependencies"].marker, "BOM"); // Groovy, no parentheses
  assert.deepEqual(deps('implementation(enforcedPlatform("g:bom:1"))\ntestImplementation(platform("g:test-bom:2"))'), [
    { name: "g:bom", constraint: "1", dev: false, marker: "enforced BOM" },
    { name: "g:test-bom", constraint: "2", dev: true, marker: "BOM" },
  ]);
});

test("project, files and fileTree are skipped, never rows", () => {
  assert.deepEqual(ktsProject.skipped, [":core", "libs/vendor.jar"]);
  assert.deepEqual(groovyProject.skipped, [":lib", "fileTree(dir: 'libs', include: ['*.jar'])"]);
  const result = parseGradle('dependencies {\n implementation(projects.core)\n api(project(path = ":x"))\n}');
  assert.deepEqual(result.deps, []);
  assert.deepEqual(result.skipped, ["projects.core", 'project(path = ":x")']);
});

test("a closure after a coordinate adds no rows", () => {
  assert.deepEqual(pairs(deps('implementation("a:b:1") {\n  exclude(group = "x", module = "y")\n  version { strictly("1.0") }\n  implementation("never:a-row:1")\n}')), [["a:b", "1"]]);
  assert.ok(!("org.slf4j:slf4j-api" in byName(ktsProject.deps)));
});

test("buildscript dependencies and unknown configurations add nothing", () => {
  const names = ktsProject.deps.map((d) => d.name);
  assert.ok(!names.includes("com.example:never-a-row"));
  assert.ok(!names.includes("io.gitlab.arturbosch.detekt:detekt-cli"));
  assert.deepEqual(parseGradle('buildscript { dependencies { implementation("a:b:1") } }').deps, []);
});

test("a duplicate group:artifact keeps the first row", () => {
  assert.deepEqual(pairs(deps('implementation("a:b:1")\ntestImplementation("a:b:2")')), [["a:b", "1"]]);
});

// --- configurations ---------------------------------------------------------------

test("configurations: the base names and their prefixed and suffixed variants", () => {
  for (const name of ["implementation", "api", "compileOnly", "runtimeOnly", "kapt", "ksp", "annotationProcessor", "testImplementation",
    "androidTestImplementation", "debugImplementation", "jvmMainApi", "kaptTest", "kspAndroid", "testRuntimeOnly", "testAnnotationProcessor"]) {
    assert.equal(isConfiguration(name), true, name);
  }
  for (const name of ["classpath", "detekt", "exclude", "Implementation", "platform", "kotlin", "testFixtures"]) {
    assert.equal(isConfiguration(name), false, name);
  }
});

test("test and androidTest configurations are dev", () => {
  const g = byName(groovyProject.deps);
  assert.equal(g["junit:junit"].dev, true);
  assert.equal(g["androidx.test.ext:junit"].dev, true);
  assert.equal(g["com.squareup.retrofit2:retrofit"].dev, false);
  assert.deepEqual(deps('kaptTest("a:b:1")\njvmTestImplementation("c:d:1")\ndebugImplementation("e:f:1")').map((d) => d.dev), [true, true, false]);
});

// --- Kotlin Multiplatform -------------------------------------------------------------

test("KMP source sets are read, and *Test ones are dev", () => {
  const k = byName(ktsProject.deps);
  assert.deepEqual(k["org.jetbrains.kotlinx:kotlinx-coroutines-core"], { name: "org.jetbrains.kotlinx:kotlinx-coroutines-core", constraint: "1.8.1", dev: false });
  assert.equal(k["app.cash.turbine:turbine"].dev, true); // val commonTest by getting { dependencies { } }
  assert.equal(byName(groovyProject.deps)["io.kotest:kotest-runner-junit5"].dev, true); // Groovy sourceSets { jvmTest { … } }
});

test("the other KMP spellings of a source set", () => {
  const text = `kotlin {
    sourceSets {
      commonTest { dependencies { implementation("a:one:1") } }
      named("jvmTest") { dependencies { implementation("a:two:1") } }
      getByName("androidUnitTest").dependencies { implementation("a:three:1") }
      sourceSets["iosTest"].dependencies { implementation("a:four:1") }
      jvmMain.dependencies { implementation("a:five:1") }
      val jsMain by creating { dependencies { implementation("a:six:1") } }
    }
  }`;
  assert.deepEqual(parseGradle(text).deps.map((d) => [d.name, d.dev]), [
    ["a:one", true], ["a:two", true], ["a:three", true], ["a:four", true], ["a:five", false], ["a:six", false],
  ]);
});

test("if blocks are see-through; constraints are not dependencies", () => {
  const text = 'dependencies {\n if (ci) {\n  implementation("a:b:1")\n }\n constraints {\n  implementation("c:d:2")\n }\n}';
  assert.deepEqual(pairs(parseGradle(text).deps), [["a:b", "1"]]);
});

// --- the version catalog ----------------------------------------------------------------

test("catalog references resolve, a bundle to each of its libraries", () => {
  const k = byName(ktsProject.deps);
  assert.equal(k["io.ktor:ktor-server-core"].constraint, "2.3.11"); // module + version.ref, via the bundle
  assert.equal(k["io.ktor:ktor-server-netty"].constraint, "2.3.11"); // bundle entry spelled with `_`
  assert.equal(k["ch.qos.logback:logback-classic"].constraint, "1.5.6"); // a string alias
  assert.equal(k["io.insert-koin:koin-core"].constraint, "managed"); // module with no version
  assert.equal(k["io.mockk:mockk"].constraint, "1.13.11"); // rich version = { strictly }
  assert.equal(k["org.jetbrains.kotlinx:kotlinx-coroutines-core"].constraint, "1.8.1"); // group/name, version.ref to a rich version
});

test("readVersionCatalog normalises aliases, reads every form, and gives null for non-TOML", () => {
  const catalog = readVersionCatalog(`[versions]
v = "1.0"
[libraries]
androidx-core-ktx = "androidx.core:core-ktx:1.13.1"
androidx_appcompat = { module = "androidx.appcompat:appcompat", version = "1.7.0" }
ref = { group = "g", name = "a", version = { ref = "v" } }
prefer = { module = "g:p", version = { prefer = "2.0" } }
broken = { version = "1.0" }
[bundles]
ui = ["androidx-core-ktx", "androidx_appcompat"]
[plugins]
kotlin-android = "org.jetbrains.kotlin.android:1.9.24"`);
  assert.deepEqual(Object.fromEntries(catalog.libraries), {
    "androidx.core.ktx": { name: "androidx.core:core-ktx", constraint: "1.13.1" },
    "androidx.appcompat": { name: "androidx.appcompat:appcompat", constraint: "1.7.0" },
    ref: { name: "g:a", constraint: "1.0" },
    prefer: { name: "g:p", constraint: "2.0" },
  });
  assert.deepEqual(catalog.bundles.get("ui"), ["androidx.core.ktx", "androidx.appcompat"]);
  assert.equal(catalog.plugins.get("kotlin.android"), "org.jetbrains.kotlin.android");
  assert.equal(readVersionCatalog("[libraries\nx"), null);
  assert.equal(readVersionCatalog(null), null);
  const both = { files: { "gradle/libs.versions.toml": '[libraries]\nandroidx-core-ktx = "a:b:1"' } };
  assert.deepEqual(pairs(deps("implementation(libs.androidx.core.ktx)", both)), [["a:b", "1"]]);
});

test("an unknown alias, or no catalog at all, is a row named as written", () => {
  assert.deepEqual(pairs(deps("implementation(libs.nope)\nimplementation(libs.bundles.nope)", at(kts.files))), [["libs.nope", null], ["libs.bundles.nope", null]]);
  assert.deepEqual(pairs(deps("implementation(libs.ktor.server.core)")), [["libs.ktor.server.core", null]]);
  assert.deepEqual(pairs(deps("implementation(libs.ktor.server.core)", at({ "gradle/libs.versions.toml": "not = [toml" }))), [["libs.ktor.server.core", null]]);
});

// --- settings, name and subprojects ------------------------------------------------------

test("readSettings reads includes in both styles and rootProject.name, not includeBuild", () => {
  assert.deepEqual(readSettings(kts.files["settings.gradle.kts"]), { name: "orders", includes: [":app", ":core", ":web"] });
  assert.deepEqual(readSettings(groovy.files["settings.gradle"]), { name: "legacy-app", includes: [":app", ":lib"] });
  assert.deepEqual(readSettings("include(\":a\")\ninclude ':b', ':c'\ninclude(\":a\")"), { name: null, includes: [":a", ":b", ":c"] });
  assert.equal(readSettings(null), null);
  assert.equal(readSettings('"unclosed'), null);
});

test("the name is rootProject.name at the root, the folder's name elsewhere", () => {
  const settings = { "settings.gradle.kts": 'rootProject.name = "big"' };
  assert.equal(parseGradle("", at(settings, "/r", "/r")).name, "big");
  assert.equal(parseGradle("", at({}, "/w/proj", "/w/proj")).name, "proj");
  assert.equal(parseGradle("", at({ "settings.gradle.kts": 'include(":a")' }, "/w/proj", "/w/proj")).name, "proj");
  assert.equal(parseGradle("", at(settings, "/r", "/r/app")).name, "app");
  assert.equal(parseGradle("").name, null);
});

test("a root build file that declares nothing lists its subprojects", () => {
  const settings = { "settings.gradle.kts": kts.files["settings.gradle.kts"] };
  const root = parseGradle("plugins { java }", at(settings));
  assert.deepEqual(root.deps, [":app", ":core", ":web"].map((name) => ({ name, constraint: null, dev: false, marker: "subproject" })));
  assert.deepEqual(parseGradle('dependencies { implementation("a:b:1") }', at(settings)).deps.map((d) => d.name), ["a:b"]);
  assert.deepEqual(parseGradle("plugins { java }", at(settings, "/r", "/r/app")).deps, []);
});

// --- Kotlin ------------------------------------------------------------------------------

test("a Kotlin plugin makes the language Kotlin; a Java build has none", () => {
  assert.equal(ktsProject.language, "Kotlin");
  assert.equal(groovyProject.language, "Kotlin"); // id 'org.jetbrains.kotlin.jvm' version '…'
  for (const text of [
    'plugins { kotlin("jvm") }',
    'plugins { kotlin("multiplatform") apply false }',
    'plugins { id("org.jetbrains.kotlin.jvm") version "1.9.24" }',
    "plugins {\n id 'org.jetbrains.kotlin.android'\n}",
    "apply plugin: 'kotlin-android'",
    'apply(plugin = "kotlin")',
  ]) assert.equal(parseGradle(text).language, "Kotlin", text);
  const catalog = at({ "gradle/libs.versions.toml": '[plugins]\nkotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version = "1.9.24" }' });
  assert.equal(parseGradle("plugins { alias(libs.plugins.kotlin.jvm) }", catalog).language, "Kotlin");
  for (const text of ["plugins { java\n application }", "plugins { id 'java-library' }", 'plugins { alias(libs.plugins.kotlin.jvm) }', 'dependencies { implementation(kotlin("stdlib")) }']) {
    assert.equal("language" in parseGradle(text), false, text);
  }
});

// --- hostile input -----------------------------------------------------------------------

test("hostile input never throws and never hangs", () => {
  const inputs = [")}}}", "{{{{((((", "dependencies {" + "(".repeat(10000), "dependencies { implementation(", "dependencies { implementation 'a:b', }",
    "\u0000\u0001￿", "`", "/* never closed", "dependencies {\n implementation(" + "platform(".repeat(100) + '"a:b:1"' + ")".repeat(100) + ")\n}",
    'dependencies { implementation("${"', "val x by", "include", 'rootProject.name ='];
  for (let i = 0; i < 50; i++) {
    let s = "";
    for (let j = 0; j < 200; j++) s += String.fromCharCode(Math.floor(((i * 7919 + j * 104729) % 65521) % 128));
    inputs.push(s);
  }
  for (const text of inputs) {
    const result = parseGradle(text, at(kts.files));
    assert.ok(result.error || Array.isArray(result.deps), JSON.stringify(text.slice(0, 40)));
  }
  for (const input of [null, undefined, 42, {}]) assert.equal(parseGradle(input).error, "build.gradle is not text");
});

test("an unclosed string is refused with the file and line", () => {
  assert.deepEqual(parseGradle('plugins {}\ndependencies {\n implementation("a:b:1)\n}', null, "build.gradle.kts"), { error: "build.gradle.kts line 3: a string is never closed" });
  assert.deepEqual(parseGradle('x = """never'), { error: 'build.gradle line 1: a """ string is never closed' });
});

test("input over the cap is refused", () => {
  assert.equal(MAX_GRADLE_LENGTH, 1048576);
  assert.match(parseGradle(" ".repeat(MAX_GRADLE_LENGTH + 1)).error, /1048576-character cap/);
});

// A linearity guard, not a Herdr budget: see gradle.js's header. It compares two sizes
// rather than timing against a fixed limit, because CI runners are several times slower
// than a laptop. 8x the statements should take about 8x as long; quadratic would be 64x.
test("scanning a KMP build file near the cap stays linear", () => {
  const kmp = (n) => {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(`implementation("g:a-${i}:1.${i}.0") { exclude(group = "x") }`);
    return `kotlin {\n sourceSets {\n commonMain.dependencies {\n${lines.join("\n")}\n}\n}\n}\n`;
  };
  const small = kmp(2000);
  const large = kmp(16000);
  assert.ok(large.length > 900_000 && large.length <= MAX_GRADLE_LENGTH);
  assert.equal(parseGradle(large).deps.length, 16000);
  const bestOf = (text) => {
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      parseGradle(text);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const smallMs = bestOf(small);
  const largeMs = bestOf(large);
  assert.ok(largeMs < 1000, `16,000 statements took ${largeMs.toFixed(1)} ms`);
  assert.ok(largeMs < smallMs * 24, `8x the input took ${(largeMs / smallMs).toFixed(1)}x as long (${smallMs.toFixed(1)} ms → ${largeMs.toFixed(1)} ms)`);
});

// --- gradle.lockfile ---------------------------------------------------------------------

test("readGradleLock reads the lines and skips comments, blanks and empty=", () => {
  const { entries } = readGradleLock(kts.lock);
  assert.equal(entries.length, 16);
  assert.deepEqual(entries[0], { name: "app.cash.turbine:turbine", version: "1.1.0" });
  assert.deepEqual(readGradleLock("a:b:1=c\r\n\r\na:b:1=d\nempty="), { entries: [{ name: "a:b", version: "1" }] });
});

test("a malformed lockfile line is refused, and the tree says so", async () => {
  assert.deepEqual(readGradleLock("a:b:1=c\nnot a line\n"), { error: "gradle.lockfile line 2: expected group:artifact:version=configurations" });
  const tree = await lockTree(ktsProject, "a:b=c\n");
  assert.match(tree.note, /^Couldn't read gradle\.lockfile: gradle\.lockfile line 1: /);
  assert.equal(directRoots(tree).length, ktsProject.deps.length);
});

test("declared dependencies take the locked version and keep their constraint, dev and tag", async () => {
  const tree = await lockTree(ktsProject, kts.lock);
  const roots = byName(directRoots(tree));
  assert.equal(roots["io.ktor:ktor-server-core"].version, "2.3.11");
  assert.equal(roots["org.jetbrains.kotlin:kotlin-stdlib"].version, "1.9.24");
  assert.equal(roots["org.jetbrains.kotlin:kotlin-stdlib"].constraint, "managed");
  assert.equal(roots["io.insert-koin:koin-bom"].marker, "BOM");
  assert.equal(roots["io.mockk:mockk"].dev, true);
  assert.equal(roots["app.cash.turbine:turbine"].dev, true);
  assert.equal(roots["com.squareup.okio:okio"].dev, false);
  assert.equal(tree.note, null);
});

test("undeclared locked entries go under a collapsed resolved group", async () => {
  const tree = await lockTree(ktsProject, kts.lock);
  const group = tree.roots.at(-1);
  assert.equal(group.name, GRADLE_RESOLVED_GROUP);
  assert.equal(group.group, true);
  assert.equal(group.dev, false);
  const expanded = new Set();
  assert.ok(!visibleRows(tree, expanded).some((r) => r.depth > 0));
  await expandNode(tree, group, [groupKey(GRADLE_RESOLVED_GROUP)]);
  expanded.add(pathOf([groupKey(GRADLE_RESOLVED_GROUP)]));
  const children = visibleRows(tree, expanded).filter((r) => r.depth === 1).map((r) => [r.node.name, r.node.version, r.node.dev]);
  assert.deepEqual(children, [["ch.qos.logback:logback-core", "1.5.6", false], ["org.slf4j:slf4j-api", "2.0.13", false]]);
});

test("an as-written row stays, and the lock's coordinate for it is under resolved", async () => {
  const project = parseGradle('dependencies {\n implementation(Deps.coroutines)\n}');
  const tree = await lockTree(project, "org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1=runtimeClasspath\n");
  assert.deepEqual(directRoots(tree).map((n) => [n.name, n.version]), [["Deps.coroutines", null]]);
  assert.equal(tree.roots.at(-1).name, GRADLE_RESOLVED_GROUP);
  assert.equal(countsLine(tree), "1 direct, 2 total");
});

test("the counts line counts directs and resolved entries", async () => {
  const tree = await lockTree(ktsProject, kts.lock);
  assert.equal(countsLine(tree), `${ktsProject.deps.length} direct, ${ktsProject.deps.length + 2} total`);
});

test("a dependency locked at two versions is two rows", async () => {
  const project = parseGradle('dependencies {\n implementation("a:b:1")\n}');
  const tree = await lockTree(project, "a:b:1.0=compileClasspath\na:b:2.0=runtimeClasspath\n");
  assert.deepEqual(directRoots(tree).map((n) => n.version), ["1.0", "2.0"]);
});

// --- the registry ------------------------------------------------------------------------

test("both Gradle entries share the lockfile, companions and note", () => {
  const entries = ECOSYSTEMS.filter((e) => e.file === "build.gradle.kts" || e.file === "build.gradle");
  assert.deepEqual(entries.map((e) => e.file), ["build.gradle.kts", "build.gradle"]);
  for (const e of entries) {
    assert.equal(e.id, "maven");
    assert.equal(e.name, "Java/Kotlin");
    assert.equal(e.audited, false);
    assert.equal(e.lockfiles, GRADLE_LOCKFILES);
    assert.equal(e.companions, GRADLE_COMPANIONS);
    assert.equal(e.note, GRADLE_NOTE);
  }
  assert.deepEqual(GRADLE_LOCKFILES.map((l) => l.file), ["gradle.lockfile"]);
  assert.match(GRADLE_NOTE, /gradle dependencies/);
});

test("without a lockfile the tree shows the Gradle note", async () => {
  const tree = await treeForProject(ktsProject, null, { noLockNote: GRADLE_NOTE });
  assert.equal(tree.note, GRADLE_NOTE);
});

test("each entry names its own file in errors", () => {
  const [kotlin, groovyEntry] = ECOSYSTEMS.filter((e) => e.file.startsWith("build.gradle"));
  assert.match(kotlin.parse('"', {}).error, /^build\.gradle\.kts line 1: /);
  assert.match(groovyEntry.parse('"', {}).error, /^build\.gradle line 1: /);
});

test("deep nesting doesn't make the scan quadratic", () => {
  const depth = 100000, ids = 100000;
  const text = "if {\n".repeat(depth) + "dependencies {\n" + "x\n".repeat(ids) + "}" + "}".repeat(depth);
  assert.ok(text.length <= MAX_GRADLE_LENGTH);
  const start = performance.now();
  assert.deepEqual(parseGradle(text).deps, []);
  assert.ok(performance.now() - start < 500, `took ${(performance.now() - start).toFixed(0)} ms`);
});
