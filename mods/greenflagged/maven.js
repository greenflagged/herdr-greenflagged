// Maven's pom.xml for the plain dependency tree. Plain data in and out, with no Herdr
// imports, so `npm test` can run it under Node without the app. Nothing here throws,
// whatever the input, and nothing is run: no `mvn`, no `~/.m2/repository`, no network.
// The POM is read with xml.js, which refuses a DOCTYPE and any entity it would have to
// expand.
//
// Maven keeps no lockfile, so the tree is the POM's direct dependencies as leaves, and
// the panel shows MAVEN_NOTE instead of the no-lockfile sentence.
//
// Maven edge cases, so RECIPE.md can point here instead of growing:
// - Rows come from `<project><dependencies>` only, named `groupId:artifactId`. Entries
//   in `<dependencyManagement>`, `<build>` and `<profiles>` are never rows; profiles are
//   conditional. A dependency without a groupId or artifactId is left out.
// - Scope: `test` is `dev`; `provided` and `runtime` are shown as a tag; `system` is a
//   local jar and is counted on the "not checked" line. `compile`, `import` and anything
//   else are plain rows.
// - `${…}` in groupId, artifactId and version is filled from `<properties>`,
//   `project.version`, `project.groupId`, `project.artifactId`,
//   `project.parent.version` and `project.parent.groupId` (each falling back to the
//   `<parent>` value, as Maven does). A reference to a property that refers to another
//   is followed up to 10 deep; a cycle, an unknown property, or a value over 1,000
//   characters is shown as written.
// - A dependency with no `<version>` takes the version (interpolated) from the same
//   POM's `<dependencyManagement>` when that pins one. A dependency with no `<scope>`
//   takes the managed scope too, as Maven does, so a managed `test` scope is `dev`; an
//   explicit scope wins. A version set anywhere else (a `<parent>`, a BOM import) is
//   shown as `managed`: the parent POM is never fetched.
// - A duplicate `groupId:artifactId` keeps its first entry.
// - A POM with `<modules>` and no `<dependency>` of its own (an aggregator or parent
//   POM) lists its modules as rows tagged `module`, with no version. The counts line
//   counts every row, so a parent POM with three modules reads "3 direct, 3 total". A POM with
//   modules and dependencies lists only its dependencies; open a module's folder to see
//   that module.
// - `<classifier>`, `<type>`, `<optional>` and `<exclusions>` are not read.
// - The project's name is its own `<artifactId>`.
// - The language is "Kotlin" when `kotlin-maven-plugin` appears as any artifactId in the
//   POM, else the entry's "Java/Kotlin".

import { child, children, parseXml, textOf } from "./xml.js";

const MAX_REFERENCE_DEPTH = 10;
const MAX_VALUE_LENGTH = 1000;
const REFERENCE = /\$\{([^}]*)\}/g; // only ever run over one element's text

export const MAVEN_NOTE = "Maven keeps no lockfile; the full tree needs `mvn dependency:tree`, which this panel doesn't run.";

// A `${…}` filler over the POM's properties. Each property is resolved once and
// remembered, so a hostile chain of references costs at most one pass per property.
function interpolator(project) {
  const parent = child(project, "parent");
  const raw = new Map();
  for (const p of child(project, "properties")?.children ?? []) if (!raw.has(p.name)) raw.set(p.name, p.text);
  const builtin = {
    "project.version": textOf(project, "version") ?? textOf(parent, "version"),
    "project.groupId": textOf(project, "groupId") ?? textOf(parent, "groupId"),
    "project.artifactId": textOf(project, "artifactId"),
    "project.parent.version": textOf(parent, "version"),
    "project.parent.groupId": textOf(parent, "groupId"),
  };
  const done = new Map(), active = new Set();
  const lookup = (key) => {
    if (done.has(key)) return done.get(key);
    const value = raw.has(key) ? raw.get(key) : builtin[key] ?? (key.startsWith("pom.") ? builtin[`project.${key.slice(4)}`] : null) ?? null;
    if (value === null || active.has(key) || active.size >= MAX_REFERENCE_DEPTH) return null;
    active.add(key);
    const filled = fill(value);
    active.delete(key);
    done.set(key, filled);
    return filled;
  };
  const fill = (value) => {
    if (typeof value !== "string" || value.indexOf("${") === -1) return value;
    const out = value.replace(REFERENCE, (whole, key) => lookup(key.trim()) ?? whole);
    return out.length > MAX_VALUE_LENGTH ? value : out;
  };
  return fill;
}

// Whether any element in the document is `<artifactId>kotlin-maven-plugin</artifactId>`.
function appliesKotlin(root) {
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (el.name === "artifactId" && el.text === "kotlin-maven-plugin") return true;
    for (const c of el.children) stack.push(c);
  }
  return false;
}

// pom.xml → { name, deps, skipped, language? } or { error }.
export function parsePom(text) {
  const parsed = parseXml(text);
  if (parsed.error) return { error: parsed.line ? `pom.xml ${parsed.error}` : `pom.xml: ${parsed.error}` };
  const project = parsed.root;
  if (project.name !== "project") return { error: `pom.xml: the root element is <${project.name}>, not <project>` };
  const fill = interpolator(project);

  const managed = new Map();
  for (const d of children(child(child(project, "dependencyManagement"), "dependencies"), "dependency")) {
    const group = fill(textOf(d, "groupId")), artifact = fill(textOf(d, "artifactId"));
    if (!group || !artifact) continue;
    const key = `${group}:${artifact}`;
    if (!managed.has(key)) managed.set(key, { version: fill(textOf(d, "version")) || null, scope: textOf(d, "scope") || null });
  }

  const declared = children(child(project, "dependencies"), "dependency");
  const deps = new Map(), skipped = [];
  for (const d of declared) {
    const group = fill(textOf(d, "groupId")), artifact = fill(textOf(d, "artifactId"));
    if (!group || !artifact) continue;
    const name = `${group}:${artifact}`;
    if (deps.has(name) || skipped.includes(name)) continue;
    const pinned = managed.get(name);
    const version = fill(textOf(d, "version")) || pinned?.version || "managed";
    const scope = textOf(d, "scope") || pinned?.scope || "compile";
    if (scope === "system") { skipped.push(name); continue; }
    const dep = { name, constraint: version, dev: scope === "test" };
    if (scope === "provided" || scope === "runtime") dep.marker = scope;
    deps.set(name, dep);
  }

  let rows = [...deps.values()];
  if (!declared.length) {
    const modules = children(child(project, "modules"), "module").map((m) => m.text).filter(Boolean);
    rows = [...new Set(modules)].map((name) => ({ name, constraint: null, dev: false, marker: "module" }));
  }
  const result = { name: fill(textOf(project, "artifactId")) || null, deps: rows, skipped };
  if (appliesKotlin(project)) result.language = "Kotlin";
  return result;
}
