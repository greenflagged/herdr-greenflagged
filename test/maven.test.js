import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ECOSYSTEMS, findManifest } from "../mods/greenflagged/audit.js";
import { MAVEN_NOTE, parsePom } from "../mods/greenflagged/maven.js";
import { countsLine, treeForProject } from "../mods/greenflagged/tree.js";

// Both POMs are hand-written for what maven.js reads.
const fixtures = fileURLToPath(new URL("./fixtures/maven/", import.meta.url));
const read = (file) => readFileSync(join(fixtures, file), "utf8");
const files = (tree) => async (path) => tree[path] ?? null;
const byName = (deps) => Object.fromEntries(deps.map((d) => [d.name, d]));
const pom = (deps, extra = "") => `<project><artifactId>x</artifactId>${extra}<dependencies>${deps}</dependencies></project>`;
const dep = (g, a, more = "") => `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId>${more}</dependency>`;

test("reads the fixture's direct dependencies as groupId:artifactId", () => {
  const { name, deps, skipped, language } = parsePom(read("pom.xml"));
  assert.equal(name, "orders-service");
  assert.equal(language, "Kotlin");
  assert.deepEqual(skipped, ["com.oracle:ojdbc"]);
  assert.deepEqual(deps.map((d) => [d.name, d.constraint]), [
    ["org.jetbrains.kotlin:kotlin-stdlib", "1.9.24"],
    ["org.springframework:spring-context", "6.1.8"],
    ["com.fasterxml.jackson.core:jackson-databind", "2.17.1"],
    ["com.example:orders-api", "2.4.0-SNAPSHOT"],
    ["jakarta.servlet:jakarta.servlet-api", "6.0.0"],
    ["org.postgresql:postgresql", "42.7.3"],
    ["org.junit.jupiter:junit-jupiter", "managed"],
    ["org.assertj:assertj-core", "3.25.3"],
    ["org.slf4j:slf4j-api", "2.0.13"],
  ]);
});

test("fills ${…} from properties, nested ones and project.version", () => {
  const deps = byName(parsePom(read("pom.xml")).deps);
  assert.equal(deps["org.springframework:spring-context"].constraint, "6.1.8");
  assert.equal(deps["com.fasterxml.jackson.core:jackson-databind"].constraint, "2.17.1"); // ${jackson.base}.1
  assert.equal(deps["com.example:orders-api"].constraint, "2.4.0-SNAPSHOT"); // ${project.groupId} from <parent>
});

test("fills project.parent.version, and shows an unknown property as written", () => {
  const text = `<project><parent><groupId>p</groupId><artifactId>pp</artifactId><version>9.0</version></parent><artifactId>x</artifactId>
    <dependencies>${dep("a", "b", "<version>${project.parent.version}</version>")}${dep("c", "d", "<version>${nope}</version>")}${dep("e", "f", "<version>${project.version}</version>")}</dependencies></project>`;
  assert.deepEqual(parsePom(text).deps.map((d) => d.constraint), ["9.0", "${nope}", "9.0"]);
});

test("a cyclic or self-referencing property ends", () => {
  const props = "<properties><a>${b}</a><b>${a}</b><c>${c}${c}</c></properties>";
  const result = parsePom(pom(dep("g", "x", "<version>${a}</version>") + dep("g", "y", "<version>${c}</version>"), props));
  assert.equal(result.error, undefined);
  assert.equal(result.deps.length, 2);
  for (const d of result.deps) assert.match(d.constraint, /\$\{[abc]\}/);
});

test("a chain of properties deeper than 10 is shown as written", () => {
  let props = "<p0>1.0</p0>";
  for (let i = 1; i <= 15; i++) props += `<p${i}>\${p${i - 1}}</p${i}>`;
  const deps = parsePom(pom(dep("g", "far", "<version>${p15}</version>") + dep("g", "near", "<version>${p5}</version>"), `<properties>${props}</properties>`)).deps;
  assert.match(deps[0].constraint, /\$\{p\d+\}/);
  assert.equal(deps[1].constraint, "1.0");
});

test("test scope is dev; provided and runtime are tagged; system is skipped", () => {
  const deps = byName(parsePom(read("pom.xml")).deps);
  assert.equal(deps["org.junit.jupiter:junit-jupiter"].dev, true);
  assert.equal(deps["jakarta.servlet:jakarta.servlet-api"].marker, "provided");
  assert.equal(deps["jakarta.servlet:jakarta.servlet-api"].dev, false);
  assert.equal(deps["org.postgresql:postgresql"].marker, "runtime");
  assert.equal(deps["org.springframework:spring-context"].marker, undefined);
  assert.equal(deps["com.oracle:ojdbc"], undefined);
});

test("a missing version comes from the same POM's dependencyManagement, scope included", () => {
  const deps = byName(parsePom(read("pom.xml")).deps);
  assert.deepEqual(deps["org.assertj:assertj-core"], { name: "org.assertj:assertj-core", constraint: "3.25.3", dev: true });
});

test("an explicit scope beats the managed one", () => {
  const managed = `<dependencyManagement><dependencies>${dep("g", "a", "<version>1.0</version><scope>test</scope>")}</dependencies></dependencyManagement>`;
  const deps = parsePom(pom(dep("g", "a", "<scope>runtime</scope>"), managed)).deps;
  assert.deepEqual(deps, [{ name: "g:a", constraint: "1.0", dev: false, marker: "runtime" }]);
});

test("a version set in another file (a parent or a BOM) is shown as managed", () => {
  const deps = byName(parsePom(read("pom.xml")).deps);
  assert.equal(deps["org.junit.jupiter:junit-jupiter"].constraint, "managed");
  assert.deepEqual(parsePom(pom(dep("g", "a"))).deps, [{ name: "g:a", constraint: "managed", dev: false }]);
});

test("dependencyManagement and profiles never give rows", () => {
  const names = parsePom(read("pom.xml")).deps.map((d) => d.name);
  assert.ok(!names.includes("org.junit:junit-bom"));
  assert.ok(!names.includes("com.example:only-in-a-profile"));
});

test("a duplicate groupId:artifactId keeps the first", () => {
  const deps = parsePom(pom(dep("g", "a", "<version>1</version>") + dep("g", "a", "<version>2</version><scope>test</scope>"))).deps;
  assert.deepEqual(deps, [{ name: "g:a", constraint: "1", dev: false }]);
});

test("a dependency without a groupId or artifactId is left out", () => {
  const deps = parsePom(pom("<dependency><artifactId>a</artifactId></dependency>" + dep("g", "b", "<version>1</version>"))).deps;
  assert.deepEqual(deps.map((d) => d.name), ["g:b"]);
});

test("a parent POM with modules and no dependencies lists its modules", async () => {
  const project = parsePom(read("parent-pom.xml"));
  assert.equal(project.name, "example-parent");
  assert.equal(project.language, undefined);
  assert.deepEqual(project.deps, ["orders-api", "orders-service", "orders-web"].map((name) => ({ name, constraint: null, dev: false, marker: "module" })));
  // Every module row counts as a direct.
  assert.equal(countsLine(await treeForProject(project, null, { noLockNote: MAVEN_NOTE })), "3 direct, 3 total");
});

test("a POM with modules and dependencies lists only its dependencies", () => {
  const deps = parsePom(pom(dep("g", "a", "<version>1</version>"), "<modules><module>m</module></modules>")).deps;
  assert.deepEqual(deps.map((d) => d.name), ["g:a"]);
});

test("a POM without kotlin-maven-plugin has no language", () => {
  assert.equal("language" in parsePom(pom(dep("g", "a"))), false);
});

test("a DOCTYPE is refused with the file and line", () => {
  const text = '<?xml version="1.0"?>\n<!DOCTYPE project [<!ENTITY x SYSTEM "http://evil">]>\n<project>&x;</project>';
  assert.deepEqual(parsePom(text), { error: "pom.xml line 2: DOCTYPE and entity declarations aren't read" });
});

test("findManifest surfaces a refused POM as the error state", async () => {
  const project = await findManifest("/r", "/Users/a", files({ "/r/pom.xml": "<!DOCTYPE x>\n<project/>" }));
  assert.equal(project.path, "/r/pom.xml");
  assert.equal(project.error, "pom.xml line 1: DOCTYPE and entity declarations aren't read");
});

test("anything but a project root, or no text, is an error", () => {
  assert.equal(parsePom("<settings/>").error, "pom.xml: the root element is <settings>, not <project>");
  assert.equal(parsePom(null).error, "pom.xml: XML input is not a string");
});

test("the pom.xml entry carries a note and no lockfiles, and the tree shows the note", async () => {
  const entry = ECOSYSTEMS.find((e) => e.file === "pom.xml");
  assert.equal(entry.audited, false);
  assert.equal(entry.name, "Java/Kotlin");
  assert.equal(entry.lockfiles, undefined);
  assert.equal(entry.note, MAVEN_NOTE);
  assert.match(MAVEN_NOTE, /mvn dependency:tree/);
  const tree = await treeForProject(parsePom(read("pom.xml")), null, { noLockNote: entry.note });
  assert.equal(tree.note, MAVEN_NOTE);
  assert.equal(countsLine(tree), "9 direct, 9 total");
});

test("findManifest reads a Kotlin POM's language onto the project", async () => {
  const project = await findManifest("/r", "/Users/a", files({ "/r/pom.xml": read("pom.xml") }));
  assert.equal(project.language, "Kotlin");
  assert.equal(project.ecosystem.name, "Java/Kotlin");
  assert.equal(project.root, "/r");
});
