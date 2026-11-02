import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findManifest } from "../mods/greenflagged/audit.js";
import {
  CARGO_LOCKFILES, CARGO_NOTE, cargoPackages, cargoResolver, parseCargoToml, parseLockDependency,
} from "../mods/greenflagged/cargo.js";
import { parseToml } from "../mods/greenflagged/toml.js";
import { countsLine, expandNode, treeForProject } from "../mods/greenflagged/tree.js";

const fixtures = fileURLToPath(new URL("./fixtures/rust/", import.meta.url));
const read = (...parts) => readFileSync(join(fixtures, ...parts), "utf8");
const summary = (nodes) => nodes.map((n) => [n.name, n.version, n.marker, n.dev]);
const find = (nodes, name, version) => nodes.find((n) => n.name === name && (!version || n.version === version));
const lock = (text) => ({ file: "Cargo.lock", text, resolver: CARGO_LOCKFILES.find((l) => l.file === "Cargo.lock").resolver });

const singleProject = () => parseCargoToml(read("single", "Cargo.toml"));
const singleTree = (project = singleProject(), text = read("single", "Cargo.lock")) =>
  treeForProject(project, lock(text), { noLockNote: CARGO_NOTE });

// --- Cargo.toml ----------------------------------------------------------------

test("parseCargoToml reads a single crate's dependency tables", () => {
  const project = singleProject();
  assert.equal(project.name, "demo");
  assert.deepEqual(project.deps, [
    { name: "serde", constraint: "1.0", dev: false },
    { name: "log", constraint: "0.4", dev: false },
    { name: "syn", constraint: "2", dev: false },
    { name: "tokio", constraint: "1", dev: false },
    { name: "serde_json", constraint: "1", dev: false },
    { name: "cc", constraint: "1.0", dev: false },
    { name: "proptest", constraint: "1.6", dev: true },
    { name: "libc", constraint: "0.2", dev: false, marker: "cfg(unix)" },
  ]);
  assert.deepEqual(project.skipped, ["local-util", "from-git", "pinned-path"]);
});

test("parseCargoToml shows a renamed dependency under its real crate name", () => {
  const { deps } = parseCargoToml('[package]\nname = "a"\n[dependencies]\njson = { package = "serde_json", version = "1" }\n');
  assert.deepEqual(deps, [{ name: "serde_json", constraint: "1", dev: false }]);
});

test("parseCargoToml skips path and git dependencies under their real names, even with a version", () => {
  const { deps, skipped } = parseCargoToml([
    '[package]', 'name = "a"', '[dependencies]',
    'p = { path = "../p" }',
    'g = { git = "https://example.com/g", branch = "main" }',
    'pv = { path = "../pv", version = "1" }',
    'alias = { package = "real", path = "../real" }',
    '[dev-dependencies]', 'p = { path = "../p" }',
  ].join("\n"));
  assert.deepEqual(deps, []);
  assert.deepEqual(skipped, ["p", "g", "pv", "real"]);
});

test("parseCargoToml gives a table spec with no version the constraint *", () => {
  const { deps } = parseCargoToml('[package]\nname = "a"\n[dependencies]\nx = { features = ["y"] }\n');
  assert.deepEqual(deps, [{ name: "x", constraint: "*", dev: false }]);
});

test("parseCargoToml reads a target table written as a dotted header", () => {
  const { deps } = parseCargoToml(read("..", "samples", "Cargo.toml"));
  assert.deepEqual(find(deps, "windows-sys"), { name: "windows-sys", constraint: "0.59", dev: false, marker: "cfg(windows)" });
  assert.deepEqual(find(deps, "libc"), { name: "libc", constraint: "0.2", dev: false, marker: "cfg(unix)" });
});

test("parseCargoToml inherits workspace = true from [workspace.dependencies] in the same file", () => {
  const { deps, skipped } = parseCargoToml([
    '[package]', 'name = "root"',
    '[workspace.dependencies]',
    'serde = { version = "1.0", features = ["derive"] }',
    'json = { package = "serde_json", version = "1" }',
    'util = { path = "util" }',
    'anyhow = "1"',
    '[dependencies]',
    'serde = { workspace = true, features = ["rc"] }',
    'json = { workspace = true }',
    'util = { workspace = true }',
    'anyhow.workspace = true',
    'missing = { workspace = true }',
  ].join("\n"));
  assert.deepEqual(deps, [
    { name: "serde", constraint: "1.0", dev: false },
    { name: "serde_json", constraint: "1", dev: false },
    { name: "anyhow", constraint: "1", dev: false },
    { name: "missing", constraint: "workspace", dev: false },
  ]);
  assert.deepEqual(skipped, ["util"]);
});

test("parseCargoToml shows workspace = true as the constraint workspace in a member's manifest", () => {
  const { deps } = parseCargoToml('[package]\nname = "member"\n[dependencies]\nserde.workspace = true\n');
  assert.deepEqual(deps, [{ name: "serde", constraint: "workspace", dev: false }]);
});

test("parseCargoToml lists a virtual manifest's members", () => {
  assert.deepEqual(parseCargoToml(read("workspace", "Cargo.toml")), {
    name: null,
    deps: [{ name: "crates/core", constraint: null, dev: false }, { name: "crates/cli", constraint: null, dev: false }],
    skipped: [],
    workspace: true,
  });
});

test("parseCargoToml answers no dependencies for a manifest with neither [package] nor [workspace]", () => {
  assert.deepEqual(parseCargoToml(""), { name: null, deps: [], skipped: [] });
});

test("parseCargoToml treats __proto__ as a plain crate name", () => {
  const { deps } = parseCargoToml('[package]\nname = "a"\n[dependencies]\n__proto__ = "1"\n');
  assert.deepEqual(deps, [{ name: "__proto__", constraint: "1", dev: false }]);
});

test("parseCargoToml names Cargo.toml and the line in a TOML error", () => {
  const result = parseCargoToml('[package]\nname = "a"\nname = "b"\n');
  assert.match(result.error, /^Cargo\.toml line 3: /);
  assert.match(parseCargoToml(null).error, /^Cargo\.toml: /);
});

// --- Cargo.lock ----------------------------------------------------------------

test("parseLockDependency reads each lock version's dependency item", () => {
  assert.deepEqual(parseLockDependency("serde"), { name: "serde" });
  assert.deepEqual(parseLockDependency("syn 2.0.101"), { name: "syn", version: "2.0.101" });
  assert.deepEqual(parseLockDependency("syn 1.0.109 (registry+https://github.com/rust-lang/crates.io-index)"),
    { name: "syn", version: "1.0.109" });
  assert.equal(parseLockDependency(""), null);
  assert.equal(parseLockDependency(3), null);
});

test("cargoPackages keeps entries with a name and version, with source and edges", () => {
  const { value } = parseToml(read("single", "Cargo.lock"));
  const packages = cargoPackages(value);
  assert.equal(packages.length, 23);
  assert.deepEqual(find(packages, "demo").source, null);
  assert.deepEqual(find(packages, "num-derive").dependencies, [
    { name: "proc-macro2" }, { name: "quote" }, { name: "syn", version: "1.0.109" },
  ]);
  assert.deepEqual(cargoPackages({ package: [{ name: "x" }, { version: "1" }, "y"] }), []);
});

// --- the tree ------------------------------------------------------------------

test("a single crate shows its tree, with the twice-locked crate at the version it uses", async () => {
  const tree = await singleTree();
  assert.equal(tree.note, null);
  assert.equal(tree.lockFile, "Cargo.lock");
  assert.deepEqual(summary(tree.roots), [
    ["cc", "1.2.25", null, false],
    ["libc", "0.2.172", "cfg(unix)", false],
    ["log", "0.4.27", null, false],
    ["proptest", "1.6.0", null, true],
    ["serde", "1.0.219", null, false],
    ["serde_json", "1.0.140", null, false],
    ["syn", "2.0.101", null, false],
    ["tokio", "1.45.1", null, false],
  ]);
  // 8 directs; runtime adds serde_derive, proc-macro2, quote, unicode-ident, itoa, memchr, ryu,
  // pin-project-lite, shlex; dev adds num-derive and syn 1.0.109.
  assert.equal(countsLine(tree), "8 direct, 19 total");
});

test("a transitive edge that names a version resolves to that version", async () => {
  const tree = await singleTree();
  const proptest = find(tree.roots, "proptest");
  await expandNode(tree, proptest, [proptest.key]);
  const numDerive = find(proptest.children, "num-derive");
  await expandNode(tree, numDerive, [proptest.key, numDerive.key]);
  assert.deepEqual(summary(numDerive.children), [
    ["proc-macro2", "1.0.95", null, false],
    ["quote", "1.0.40", null, false],
    ["syn", "1.0.109", null, true],
  ]);
  const serde = find(tree.roots, "serde");
  await expandNode(tree, serde, [serde.key]);
  const derive = find(serde.children, "serde_derive");
  await expandNode(tree, derive, [serde.key, derive.key]);
  assert.equal(find(derive.children, "syn").version, "2.0.101");
});

test("a renamed dependency's lock entry resolves", async () => {
  const tree = await singleTree();
  const json = find(tree.roots, "serde_json");
  await expandNode(tree, json, [json.key]);
  assert.deepEqual(json.children.map((n) => n.name), ["itoa", "memchr", "ryu", "serde"]);
});

test("a direct the lock lacks is a leaf with its constraint", async () => {
  const project = { ...singleProject() };
  project.deps = [...project.deps, { name: "missing", constraint: "3", dev: false }];
  const tree = await singleTree(project);
  const missing = find(tree.roots, "missing");
  assert.equal(missing.version, null);
  assert.equal(missing.constraint, "3");
  assert.equal(missing.leaf, true);
});

test("without the project's own lock entry, the directs resolve by name", async () => {
  const tree = await singleTree({ ...singleProject(), name: "renamed" });
  assert.equal(find(tree.roots, "syn").version, "1.0.109"); // first locked version: no root entry to say otherwise
  assert.equal(find(tree.roots, "serde").version, "1.0.219");
});

test("a virtual workspace's top level is its crates, each with its own subtree", async () => {
  const tree = await treeForProject(parseCargoToml(read("workspace", "Cargo.toml")), lock(read("workspace", "Cargo.lock")), { noLockNote: CARGO_NOTE });
  assert.equal(tree.note, null);
  assert.deepEqual(summary(tree.roots), [["ws-cli", "0.1.0", null, false], ["ws-core", "0.1.0", null, false]]);
  assert.equal(countsLine(tree), "2 direct, 4 total");
  const cli = find(tree.roots, "ws-cli");
  await expandNode(tree, cli, [cli.key]);
  assert.deepEqual(summary(cli.children), [["anyhow", "1.0.98", null, false], ["ws-core", "0.1.0", null, false]]);
  const core = find(cli.children, "ws-core");
  await expandNode(tree, core, [cli.key, core.key]);
  assert.deepEqual(summary(core.children), [["serde", "1.0.219", null, false]]);
});

test("a virtual workspace without its lock shows the members with the Cargo note", async () => {
  const tree = await treeForProject(parseCargoToml(read("workspace", "Cargo.toml")), null, { noLockNote: CARGO_NOTE });
  assert.equal(tree.note, CARGO_NOTE);
  assert.deepEqual(tree.roots.map((n) => [n.name, n.leaf]), [["crates/cli", true], ["crates/core", true]]);
});

test("a lock that isn't text, isn't TOML or has no packages is an error the tree shows as its note", async () => {
  assert.deepEqual(cargoResolver(null, singleProject()), { error: "the lockfile is not text" });
  assert.match(cargoResolver("[[package]\n", singleProject()).error, /^line 1: /);
  const tree = await singleTree(singleProject(), "version = 4\n");
  assert.equal(tree.note, "Couldn't read Cargo.lock: no [[package]] entries with a name and version");
  assert.equal(tree.roots.length, 8);
});

test("findManifest picks Cargo.toml and parses it", async () => {
  const folder = join(fixtures, "single");
  const project = await findManifest(folder, "/nowhere", async (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } });
  assert.ok(project.path.endsWith("/Cargo.toml"));
  assert.equal(project.ecosystem.id, "cargo");
  assert.equal(project.ecosystem.note, CARGO_NOTE);
  assert.equal(project.name, "demo");
  assert.equal(project.deps.length, 8);
});
