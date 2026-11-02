import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findManifest, parentFolders } from "../mods/greenflagged/audit.js";
import {
  CARGO_LOCKFILES, CARGO_NOTE, cargoAllows, cargoPackages, cargoProject, cargoResolver, cargoUnlocked, parseCargoToml, parseLockDependency,
} from "../mods/greenflagged/cargo.js";
import { parseToml } from "../mods/greenflagged/toml.js";
import { countsLine, expandNode, pathOf, treeForProject } from "../mods/greenflagged/tree.js";
import { MAX_MEMBERS } from "../mods/greenflagged/workspace.js";

const fixtures = fileURLToPath(new URL("./fixtures/rust/", import.meta.url));
const read = (...parts) => readFileSync(join(fixtures, ...parts), "utf8");
const summary = (nodes) => nodes.map((n) => [n.name, n.version, n.marker, n.dev]);
const find = (nodes, name, version) => nodes.find((n) => n.name === name && (!version || n.version === version));
const lock = (text) => ({ file: "Cargo.lock", text, resolver: CARGO_LOCKFILES.find((l) => l.file === "Cargo.lock").resolver });

// The workspace fixture through the same steps as the panel: findManifest, then cargoProject.
const home = join(fixtures, "..");
const workspaceFolder = join(fixtures, "workspace");
const fsIo = {
  read: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  list: (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; } },
  parents: (folder) => parentFolders(folder, home),
};
const gather = async (folder, io = fsIo, top = home) => cargoProject(await findManifest(folder, top, io.read), io);
const shape = (nodes) => nodes.map((n) => [n.name, n.version, n.kind, n.dev, n.cycle]);
const workspaceLock = () => read("workspace", "Cargo.lock");
// The fixture lock without one crate's [[package]] entry, or with extra entries.
const withoutEntry = (text, name) => text.split("\n[[package]]").filter((part) => !part.startsWith(`\nname = "${name}"`)).join("\n[[package]]");
const openAt = async (tree, nodes, keys) => {
  let node;
  for (let i = 0; i < keys.length; i++) {
    node = nodes.find((n) => n.key === keys[i]);
    await expandNode(tree, node, keys.slice(0, i + 1));
    nodes = node.children;
  }
  return node;
};

// An in-memory folder tree: `files` maps absolute paths to text.
const memoryIo = (files, { list } = {}) => ({
  read: async (path) => files[path] ?? null,
  list: list ?? (async (dir) => {
    const names = new Set();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) continue;
      const rest = path.slice(dir.length + 1);
      if (rest.includes("/")) names.add(rest.split("/")[0]);
    }
    return [...names];
  }),
  parents: (folder) => parentFolders(folder, "/home"),
});

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
    { name: "cc", constraint: "1.0", dev: false, marker: "build" },
    { name: "proptest", constraint: "1.6", dev: true },
    { name: "libc", constraint: "0.2", dev: false, marker: "cfg(unix)" },
  ]);
  assert.deepEqual(project.skipped, ["local-util", "from-git", "pinned-path"]);
  assert.deepEqual(project.local, [
    { name: "local-util", constraint: null, dev: false },
    { name: "from-git", constraint: null, dev: false },
    { name: "pinned-path", constraint: null, dev: false },
  ]);
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

test("parseCargoToml tags build rows `build`, after which a target's cfg follows, and keeps them runtime", () => {
  const { deps, local } = parseCargoToml([
    '[package]', 'name = "a"',
    "[target.'cfg(windows)'.dev-dependencies]", 'winapi-test = "0.3"', 'helper = { path = "helper" }',
    "[target.'cfg(unix)'.build-dependencies]", 'pkg-config = "0.3"',
  ].join("\n"));
  assert.deepEqual(deps, [
    { name: "winapi-test", constraint: "0.3", dev: true, marker: "cfg(windows)" },
    { name: "pkg-config", constraint: "0.3", dev: false, marker: "build, cfg(unix)" },
  ]);
  assert.deepEqual(local, [{ name: "helper", constraint: null, dev: true, marker: "cfg(windows)" }]);
});

test("parseCargoToml takes the crate from the workspace entry, ignoring a member's own package", () => {
  const { deps, skipped } = parseCargoToml([
    '[package]', 'name = "root"',
    '[workspace.dependencies]', 'foo = "1.2"', 'bar = { package = "real-bar", version = "2" }',
    '[dependencies]',
    'foo = { workspace = true, package = "other" }',
    'bar = { workspace = true, package = "other-bar" }',
    'baz = { workspace = true, package = "other-baz" }',
  ].join("\n"));
  assert.deepEqual(deps, [
    { name: "foo", constraint: "1.2", dev: false },
    { name: "real-bar", constraint: "2", dev: false },
    { name: "baz", constraint: "workspace", dev: false },
  ]);
  assert.deepEqual(skipped, []);
});

test("parseCargoToml treats __proto__ = { workspace = true } as a crate the workspace table lacks", () => {
  const { deps } = parseCargoToml([
    '[package]', 'name = "a"', '[workspace.dependencies]', 'serde = "1"',
    '[dependencies]', '__proto__ = { workspace = true }', 'constructor.workspace = true',
  ].join("\n"));
  assert.deepEqual(deps, [
    { name: "__proto__", constraint: "workspace", dev: false },
    { name: "constructor", constraint: "workspace", dev: false },
  ]);
});

test("parseCargoToml shows workspace = true as the constraint workspace in a member's manifest", () => {
  const { deps } = parseCargoToml('[package]\nname = "member"\n[dependencies]\nserde.workspace = true\n');
  assert.deepEqual(deps, [{ name: "serde", constraint: "workspace", dev: false }]);
});

test("parseCargoToml lists a virtual manifest's members and its [workspace] record", () => {
  const project = parseCargoToml(read("workspace", "Cargo.toml"));
  assert.deepEqual({ ...project, workspace: null }, {
    name: null, version: null,
    deps: [{ name: "crates/*", constraint: null, dev: false }],
    skipped: [], local: [], workspace: null, virtual: true, layout: "workspace",
  });
  assert.deepEqual(project.workspace.members, ["crates/*"]);
  assert.deepEqual(project.workspace.exclude, ["crates/old"]);
  assert.deepEqual(JSON.parse(JSON.stringify(project.workspace.dependencies)), {
    serde: "1", "ws-core": { path: "crates/core" }, json: { package: "serde_json", version: "1" },
  });
  assert.equal(project.workspace.package.version, "0.1.0");
});

test("parseCargoToml answers no dependencies for a manifest with neither [package] nor [workspace]", () => {
  assert.deepEqual(parseCargoToml(""), { name: null, version: null, deps: [], skipped: [], local: [], root: null });
});

test("parseCargoToml reads the package version and its workspace pointer", () => {
  const project = parseCargoToml('[package]\nname = "a"\nversion = "1.2.3"\nworkspace = "../.."\n');
  assert.equal(project.version, "1.2.3");
  assert.equal(project.root, "../..");
  assert.equal(project.workspace, undefined);
  assert.equal(parseCargoToml('[package]\nname = "a"\nversion = 3\n').version, null);
});

test("parseCargoToml takes version.workspace = true from its own [workspace.package], else the inherited one", () => {
  const member = '[package]\nname = "m"\nversion.workspace = true\n';
  assert.equal(parseCargoToml(member).version, null);
  assert.equal(parseCargoToml(member, { package: { version: "2.0.0" } }).version, "2.0.0");
  const root = '[package]\nname = "r"\nversion.workspace = true\n[workspace.package]\nversion = "1.0.0"\n';
  assert.equal(parseCargoToml(root, { package: { version: "2.0.0" } }).version, "1.0.0");
});

test("parseCargoToml reads workspace = true from the inherited table, and its own table wins", () => {
  const inherited = { dependencies: { serde: "1", json: { package: "serde_json", version: "1" }, util: { path: "../util" } } };
  const member = '[package]\nname = "m"\n[dependencies]\nserde.workspace = true\njson.workspace = true\nutil.workspace = true\n';
  const { deps, skipped, local } = parseCargoToml(member, inherited);
  assert.deepEqual(deps, [{ name: "serde", constraint: "1", dev: false }, { name: "serde_json", constraint: "1", dev: false }]);
  assert.deepEqual(skipped, ["util"]);
  assert.deepEqual(local, [{ name: "util", constraint: null, dev: false }]);
  const own = parseCargoToml(`${member}[workspace.dependencies]\nserde = "2"\n`, inherited);
  assert.deepEqual(own.deps, [
    { name: "serde", constraint: "2", dev: false }, { name: "json", constraint: "workspace", dev: false }, { name: "util", constraint: "workspace", dev: false },
  ]);
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
    ["cc", "1.2.25", "build", false],
    ["from-git", "0.2.0", null, false], // path and git directs come from the project's lock entry
    ["libc", "0.2.172", "cfg(unix)", false],
    ["local-util", "0.1.0", null, false],
    ["log", "0.4.27", null, false],
    ["pinned-path", "0.3.1", null, false],
    ["proptest", "1.6.0", null, true],
    ["serde", "1.0.219", null, false],
    ["serde_json", "1.0.140", null, false],
    ["syn", "2.0.101", null, false],
    ["tokio", "1.45.1", null, false],
  ]);
  // 11 directs (8 registry, 3 path or git); runtime adds serde_derive, proc-macro2, quote,
  // unicode-ident, itoa, memchr, ryu, pin-project-lite, shlex; dev adds num-derive and syn 1.0.109.
  assert.equal(countsLine(tree), "11 direct, 22 total");
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

test("without the project's own lock entry, a twice-locked direct takes the version its constraint allows", async () => {
  const tree = await singleTree({ ...singleProject(), name: "renamed" });
  assert.equal(find(tree.roots, "syn").version, "2.0.101"); // syn = "2", though 1.0.109 is locked first
  assert.equal(find(tree.roots, "serde").version, "1.0.219");
  // Path and git directs come from the manifest, resolved by name in the lock.
  assert.equal(find(tree.roots, "from-git").version, "0.2.0");
  const project = singleProject();
  project.name = null;
  project.deps = project.deps.map((dep) => (dep.name === "syn" ? { ...dep, constraint: "1" } : dep));
  assert.equal(find((await singleTree(project)).roots, "syn").version, "1.0.109");
});

test("cargoAllows reads Cargo's requirement forms", () => {
  const cases = [
    ["2.0.101", "2", true], ["1.0.109", "2", false], ["0.2.172", "0.2", true], ["0.3.0", "0.2", false],
    ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false], ["0.0.9", "0.0", true], ["0.1.0", "0.0", false],
    ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false], ["1.9.0", "~1", true],
    ["1.0.5", "=1.0.5", true], ["1.0.6", "=1.0.5", false], ["1.2.7", "=1.2", true],
    ["2.5.0", ">=1, <3", true], ["3.0.0", ">=1, <3", false], ["1.4.0", "1.*", true], ["2.0.0", "1.*", false],
    ["9.9.9", "*", true],
  ];
  for (const [version, requirement, want] of cases) assert.equal(cargoAllows(version, requirement), want, `${version} ${requirement}`);
  for (const requirement of ["workspace", "", "1,", "^", null]) assert.equal(cargoAllows("1.0.0", requirement), null, String(requirement));
});

test("cargoAllows matches a pre-release version only against a pre-release of the same core", () => {
  const cases = [
    ["2.0.0-alpha", "2", false], ["2.0.0-alpha", "*", false], ["2.0.0-alpha", ">=1", false], ["2.0.0-alpha", "<2", false],
    ["1.0.1-alpha", ">=1.0.0-alpha", false], ["2.0.0-alpha", "^2.0.0-alpha", true], ["2.0.0-beta", "^2.0.0-alpha", true],
    ["2.0.0-alpha", "^2.0.0-beta", false], ["2.0.0-alpha.2", "^2.0.0-alpha.10", false], ["2.0.0-alpha.1", "^2.0.0-alpha", true],
    ["2.0.0-rc.1", ">=2.0.0-alpha, <3", true], ["2.0.0-alpha", "=2.0.0-alpha", true], ["2.0.0-beta", "=2.0.0-alpha", false],
    ["2.0.0", "^2.0.0-alpha", true], ["2.0.0", "<2.0.0-alpha", false], ["2.0.0", "2", true],
  ];
  for (const [version, requirement, want] of cases) assert.equal(cargoAllows(version, requirement), want, `${version} ${requirement}`);
  for (const requirement of ["2.0-alpha", "2.*-alpha", "^2.0.0-al!pha", "^2.0.0-"]) assert.equal(cargoAllows("2.0.0-alpha", requirement), null, requirement);
});

test("cargoAllows ignores build metadata in the version and the requirement", () => {
  const cases = [
    ["1.0.0", "1.0.0+build", true], ["1.0.0+build.5", "=1.0.0", true], ["1.0.0+a", "=1.0.0+b", true],
    ["1.0.1", "=1.0.0+build", false], ["2.0.0-alpha+build", "^2.0.0-alpha", true], ["2.0.0-alpha", "2.0.0-alpha+build", true],
  ];
  for (const [version, requirement, want] of cases) assert.equal(cargoAllows(version, requirement), want, `${version} ${requirement}`);
});

test("a path or git direct listed only by the lock keeps its dev flag and target marker", () => {
  const project = parseCargoToml([
    '[package]', 'name = "a"', 'version = "0.1.0"',
    '[dev-dependencies]', 'gitdep = { git = "https://example.com/gitdep" }',
    "[target.'cfg(windows)'.dependencies]", 'helper = { path = "helper" }',
  ].join("\n"));
  const text = [
    '[[package]]', 'name = "a"', 'version = "0.1.0"', 'dependencies = ["gitdep", "helper"]',
    '[[package]]', 'name = "gitdep"', 'version = "0.3.0"', 'source = "git+https://example.com/gitdep#abc"',
    '[[package]]', 'name = "helper"', 'version = "0.2.0"',
  ].join("\n");
  assert.deepEqual(cargoResolver(text, project).direct, [
    { name: "gitdep", constraint: null, dev: true, version: "0.3.0" },
    { name: "helper", constraint: null, dev: false, marker: "cfg(windows)", version: "0.2.0" },
  ]);
});

test("a root package that is also a workspace picks its own lock entry by name", async () => {
  const project = parseCargoToml([
    '[package]', 'name = "app"', '[workspace]', 'members = ["crates/x"]',
    '[dependencies]', 'x = { path = "crates/x" }', 'syn = "1"',
  ].join("\n"));
  const text = [
    '[[package]]', 'name = "x"', 'version = "0.1.0"', 'dependencies = ["syn 2.0.101"]',
    '[[package]]', 'name = "app"', 'version = "0.1.0"', 'dependencies = ["syn 1.0.109", "x"]',
    '[[package]]', 'name = "syn"', 'version = "1.0.109"', 'source = "registry+https://github.com/rust-lang/crates.io-index"',
    '[[package]]', 'name = "syn"', 'version = "2.0.101"', 'source = "registry+https://github.com/rust-lang/crates.io-index"',
  ].join("\n");
  const tree = await treeForProject(project, lock(text), { noLockNote: CARGO_NOTE });
  assert.equal(tree.note, null);
  assert.deepEqual(summary(tree.roots), [["syn", "1.0.109", null, false], ["x", "0.1.0", null, false]]);
  assert.equal(countsLine(tree), "2 direct, 3 total");
});

test("a virtual manifest read alone shows a workspace row over the lock's sourceless packages", async () => {
  const tree = await treeForProject(parseCargoToml(read("workspace", "Cargo.toml")), lock(workspaceLock()), { noLockNote: CARGO_NOTE });
  assert.equal(tree.note, null);
  assert.deepEqual(shape(tree.roots), [["workspace", null, "workspace", false, false]]);
  assert.deepEqual(shape(tree.roots[0].children), [["ws-cli", "0.1.0", null, false, false], ["ws-core", "0.1.0", null, false, false]]);
});

test("a virtual workspace with neither its members nor its lock shows the member strings with the Cargo note", async () => {
  const project = parseCargoToml(read("workspace", "Cargo.toml"));
  assert.equal(cargoUnlocked(project), null);
  const tree = await treeForProject(project, null, { noLockNote: CARGO_NOTE, unlocked: cargoUnlocked });
  assert.equal(tree.note, CARGO_NOTE);
  assert.deepEqual(tree.roots.map((n) => [n.name, n.leaf]), [["crates/*", true]]);
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

// --- workspaces ----------------------------------------------------------------

test("cargoProject gathers a virtual workspace's crates at its root", async () => {
  const project = await gather(workspaceFolder);
  assert.equal(project.layout, "workspace");
  assert.equal(project.name, "workspace");
  assert.equal(project.workspaceFolder, workspaceFolder);
  assert.equal(project.note, null);
  assert.equal(project.membersIncomplete, false);
  assert.deepEqual(project.skipped, ["ws-core", "ws-cli"]);
  assert.deepEqual(project.crates.map((c) => [c.name, c.version, c.path]), [
    ["ws-cli", "0.1.0", join(workspaceFolder, "crates", "cli", "Cargo.toml")],
    ["ws-core", "0.1.0", join(workspaceFolder, "crates", "core", "Cargo.toml")],
  ]);
  const [cli, core] = project.crates;
  assert.deepEqual(cli.deps, [{ name: "anyhow", constraint: "1", dev: false }, { name: "serde_json", constraint: "1", dev: true }]);
  assert.deepEqual(cli.local, [{ name: "ws-core", constraint: null, dev: false }]);
  assert.deepEqual(core.deps, [{ name: "serde", constraint: "1", dev: false }]);
  assert.deepEqual(core.local, [{ name: "ws-cli", constraint: null, dev: true }]);
});

test("cargoProject places a member folder's crate in its workspace", async () => {
  const project = await gather(join(workspaceFolder, "crates", "cli"));
  assert.equal(project.layout, "crate");
  assert.equal(project.name, "ws-cli");
  assert.equal(project.version, "0.1.0");
  assert.equal(project.workspaceFolder, workspaceFolder);
  assert.equal(project.path, join(workspaceFolder, "crates", "cli", "Cargo.toml"));
  assert.deepEqual(project.deps, [{ name: "anyhow", constraint: "1", dev: false }, { name: "serde_json", constraint: "1", dev: true }]);
  assert.deepEqual(project.skipped, ["ws-core"]);
  assert.deepEqual(project.crates.map((c) => c.name), ["ws-cli", "ws-core"]);
});

test("cargoProject follows package.workspace to the root", async () => {
  const io = memoryIo({
    "/home/w/Cargo.toml": '[workspace]\nmembers = ["deep/*/x"]\n[workspace.dependencies]\nserde = "1"\n',
    "/home/w/deep/a/x/Cargo.toml": '[package]\nname = "x"\nversion = "1.0.0"\nworkspace = "../../.."\n[dependencies]\nserde.workspace = true\n',
    "/home/w/deep/a/Cargo.toml": '[workspace]\nmembers = []\n', // not the root: package.workspace names it
  });
  const project = await gather("/home/w/deep/a/x", io, "/home");
  assert.equal(project.layout, "crate");
  assert.equal(project.workspaceFolder, "/home/w");
  assert.deepEqual(project.deps, [{ name: "serde", constraint: "1", dev: false }]);
});

test("cargoProject leaves a crate with no workspace above it unchanged", async () => {
  const single = await findManifest(join(fixtures, "single"), home, fsIo.read);
  assert.equal(await cargoProject(single, fsIo), single);
  const io = memoryIo({ "/home/a/Cargo.toml": '[package]\nname = "a"\n', "/Cargo.toml": '[workspace]\nmembers = ["home/a"]\n' });
  const bounded = await findManifest("/home/a", "/home", io.read);
  assert.equal(await cargoProject(bounded, io), bounded); // the walk stops after home
});

test("cargoProject leaves an excluded crate, and one the members don't match, unchanged", async () => {
  const old = await findManifest(join(workspaceFolder, "crates", "old"), home, fsIo.read);
  assert.equal(await cargoProject(old, fsIo), old);
  const io = memoryIo({
    "/home/w/Cargo.toml": '[workspace]\nmembers = ["crates/a"]\n',
    "/home/w/crates/a/Cargo.toml": '[package]\nname = "a"\n',
    "/home/w/crates/b/Cargo.toml": '[package]\nname = "b"\n',
  });
  const b = await findManifest("/home/w/crates/b", "/home", io.read);
  assert.equal(await cargoProject(b, io), b);
});

test("cargoProject marks the members incomplete when a folder can't be listed", async () => {
  const files = {
    "/home/w/Cargo.toml": '[workspace]\nmembers = ["crates/*", "tools/t"]\n',
    "/home/w/tools/t/Cargo.toml": '[package]\nname = "t"\nversion = "1.0.0"\n',
  };
  const project = await gather("/home/w", memoryIo(files, { list: async () => null }), "/home");
  assert.equal(project.membersIncomplete, true);
  assert.deepEqual(project.crates.map((c) => c.name), ["t"]); // the literal member needs no listing
  const none = await gather("/home/w", memoryIo({ "/home/w/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n' }, { list: () => { throw new Error("no find"); } }), "/home");
  assert.equal(none.membersIncomplete, true);
  assert.deepEqual(none.crates, []);
});

test("cargoProject keeps a member folder in the workspace when the listing that would find it fails", async () => {
  const files = {
    "/home/w/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\nserde = "1"\n',
    "/home/w/crates/a/Cargo.toml": '[package]\nname = "a"\nversion = "0.2.0"\n[dependencies]\nserde.workspace = true\n',
  };
  const project = await gather("/home/w/crates/a", memoryIo(files, { list: async () => null }), "/home");
  assert.equal(project.membersIncomplete, true);
  assert.equal(project.layout, "crate");
  assert.equal(project.workspaceFolder, "/home/w"); // the root's Cargo.lock, not crates/a's
  assert.deepEqual(project.crates.map((c) => c.name), ["a"]);
  assert.deepEqual(project.deps, [{ name: "serde", constraint: "1", dev: false }]);
  // A complete listing that misses the folder still leaves it standalone.
  const stray = await findManifest("/home/w/b", "/home", memoryIo({ ...files, "/home/w/b/Cargo.toml": '[package]\nname = "b"\n' }).read);
  assert.equal(await cargoProject(stray, memoryIo({ ...files, "/home/w/b/Cargo.toml": '[package]\nname = "b"\n' })), stray);
});

test("cargoProject says how many member manifests it couldn't read", async () => {
  const files = {
    "/home/w/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "/home/w/crates/a/Cargo.toml": '[package]\nname = "a"\n',
    "/home/w/crates/b/Cargo.toml": '[package\nname = "b"\n',
  };
  const one = await gather("/home/w", memoryIo(files), "/home");
  assert.deepEqual(one.crates.map((c) => c.name), ["a"]);
  assert.equal(one.membersIncomplete, false);
  assert.equal(one.note, "1 member Cargo.toml couldn't be read.");
  const member = await gather("/home/w/crates/a", memoryIo(files), "/home");
  assert.equal(member.note, "1 member Cargo.toml couldn't be read.");
  const two = await gather("/home/w", memoryIo({ ...files, "/home/w/crates/c/Cargo.toml": "= nope\n" }), "/home");
  assert.equal(two.note, "2 member Cargo.toml files couldn't be read.");
  const clean = await gather("/home/w", memoryIo({ ...files, "/home/w/crates/b/Cargo.toml": '[package]\nname = "b"\n' }), "/home");
  assert.equal(clean.note, null);
});

test("cargoProject reads at most MAX_MEMBERS members and says so", async () => {
  const files = { "/home/w/Cargo.toml": '[workspace]\nmembers = ["c/*"]\n' };
  for (let i = 0; i < MAX_MEMBERS + 10; i++) files[`/home/w/c/m${String(i).padStart(3, "0")}/Cargo.toml`] = `[package]\nname = "m${i}"\n`;
  const project = await gather("/home/w", memoryIo(files), "/home");
  assert.equal(project.crates.length, MAX_MEMBERS);
  assert.equal(project.membersIncomplete, true);
  assert.equal(project.note, `Showing the first ${MAX_MEMBERS} workspace members.`);
});

test("cargoProject answers the project unchanged when reading throws", async () => {
  const project = await findManifest(join(workspaceFolder, "crates", "cli"), home, fsIo.read);
  const io = { ...fsIo, read: () => { throw new Error("boom"); }, parents: () => { throw new Error("boom"); } };
  assert.equal(await cargoProject(project, io), project);
  assert.equal(await cargoProject(project, { ...fsIo, read: () => Promise.reject(new Error("boom")) }), project);
});

test("a workspace shows its row, open, with its crates and their manifests' rows under it", async () => {
  const expanded = new Set();
  const tree = await treeForProject(await gather(workspaceFolder), lock(workspaceLock()), { noLockNote: CARGO_NOTE, expanded });
  assert.equal(tree.note, null);
  const [root] = tree.roots;
  assert.deepEqual(shape(tree.roots), [["workspace", null, "workspace", false, false]]);
  assert.ok(expanded.has(pathOf([root.key])));
  assert.deepEqual(shape(root.children), [["ws-cli", "0.1.0", null, false, false], ["ws-core", "0.1.0", null, false, false]]);
  // Runtime: ws-cli, ws-core, anyhow, serde; serde_json only through ws-cli's dev table.
  assert.equal(countsLine(tree), "2 projects, 5 total");
  const core = await openAt(tree, tree.roots, [root.key, "ws-core@0.1.0"]);
  // ws-core's manifest declares ws-cli dev, though the workspace row reaches ws-cli at runtime.
  assert.deepEqual(shape(core.children), [["serde", "1.0.219", null, false, false], ["ws-cli", "0.1.0", "project", true, false]]);
  const devCli = await openAt(tree, tree.roots, [root.key, "ws-core@0.1.0", "ws-cli@0.1.0"]);
  assert.deepEqual(shape(devCli.children), [
    ["anyhow", "1.0.98", null, false, false], ["serde_json", "1.0.140", null, true, false], ["ws-core", "0.1.0", "project", false, true],
  ]);
  const cli = await openAt(tree, tree.roots, [root.key, "ws-cli@0.1.0"]);
  assert.deepEqual(shape(cli.children), [
    ["anyhow", "1.0.98", null, false, false], ["serde_json", "1.0.140", null, true, false], ["ws-core", "0.1.0", "project", false, false],
  ]);
  const json = await openAt(tree, tree.roots, [root.key, "ws-cli@0.1.0", "serde_json@1.0.140"]);
  assert.deepEqual(shape(json.children), [["serde", "1.0.219", null, false, false]]); // reached at runtime elsewhere
});

test("a member folder shows its crate's tree from the workspace's lock, with siblings as projects", async () => {
  const tree = await treeForProject(await gather(join(workspaceFolder, "crates", "cli")), lock(workspaceLock()), { noLockNote: CARGO_NOTE });
  assert.equal(tree.note, null);
  assert.deepEqual(shape(tree.roots), [
    ["anyhow", "1.0.98", null, false, false], ["serde_json", "1.0.140", null, true, false], ["ws-core", "0.1.0", "project", false, false],
  ]);
  assert.equal(countsLine(tree), "3 direct, 4 total"); // ws-cli itself isn't counted
  const core = await openAt(tree, tree.roots, ["ws-core@0.1.0"]);
  assert.deepEqual(shape(core.children), [["serde", "1.0.219", null, false, false], ["ws-cli", "0.1.0", "project", true, true]]);
  assert.equal(find(core.children, "ws-cli").leaf, true);
});

test("without a lock, a workspace and a member folder keep their shape at manifest versions", async () => {
  const workspace = await treeForProject(await gather(workspaceFolder), null, { noLockNote: CARGO_NOTE, unlocked: cargoUnlocked });
  assert.equal(workspace.note, CARGO_NOTE);
  const [root] = workspace.roots;
  assert.deepEqual(shape(workspace.roots), [["workspace", null, "workspace", false, false]]);
  assert.deepEqual(shape(root.children), [["ws-cli", "0.1.0", null, false, false], ["ws-core", "0.1.0", null, false, false]]);
  const cli = await openAt(workspace, workspace.roots, [root.key, "ws-cli@0.1.0"]);
  assert.deepEqual(cli.children.map((n) => [n.name, n.version, n.constraint, n.kind, n.dev]), [
    ["anyhow", null, "1", null, false], ["serde_json", null, "1", null, true], ["ws-core", "0.1.0", null, "project", false],
  ]);
  assert.equal(countsLine(workspace), "2 projects, 5 total");
  const member = await treeForProject(await gather(join(workspaceFolder, "crates", "cli")), null, { noLockNote: CARGO_NOTE, unlocked: cargoUnlocked });
  assert.deepEqual(shape(member.roots), [["anyhow", null, null, false, false], ["serde_json", null, null, true, false], ["ws-core", "0.1.0", "project", false, false]]);
  assert.equal(countsLine(member), "3 direct, 4 total");
});

test("without a lock, a standalone crate shows its directs as before", async () => {
  assert.equal(cargoUnlocked(singleProject()), null);
  const tree = await treeForProject(singleProject(), null, { noLockNote: CARGO_NOTE, unlocked: cargoUnlocked });
  assert.equal(tree.note, CARGO_NOTE);
  assert.equal(tree.roots.length, 8);
});

test("a stale lock without the member's entry still shows its siblings", async () => {
  const tree = await treeForProject(await gather(join(workspaceFolder, "crates", "cli")), lock(withoutEntry(workspaceLock(), "ws-cli")), { noLockNote: CARGO_NOTE });
  assert.deepEqual(shape(tree.roots), [
    ["anyhow", "1.0.98", null, false, false], ["serde_json", "1.0.140", null, true, false], ["ws-core", "0.1.0", "project", false, false],
  ]);
});

test("the lock's sourceless packages fill in members the listing missed", async () => {
  const project = { ...await gather(workspaceFolder), membersIncomplete: true };
  project.crates = project.crates.filter((c) => c.name === "ws-core");
  const { resolve, direct } = cargoResolver(workspaceLock(), project);
  assert.deepEqual(resolve(direct[0]).children.map((e) => [e.name, e.version]), [["ws-core", "0.1.0"], ["ws-cli", "0.1.0"]]);
});

test("a lock edge to a workspace crate is a project row too", async () => {
  const text = `${workspaceLock()}\n[[package]]\nname = "outside"\nversion = "0.5.0"\ndependencies = ["ws-core"]\n`;
  const project = { ...await gather(workspaceFolder), membersIncomplete: true };
  const tree = await treeForProject(project, lock(text), { noLockNote: CARGO_NOTE });
  const [root] = tree.roots;
  assert.deepEqual(root.children.map((n) => n.name), ["outside", "ws-cli", "ws-core"]);
  const outside = await openAt(tree, tree.roots, [root.key, "outside@0.5.0"]);
  assert.deepEqual(shape(outside.children), [["ws-core", "0.1.0", "project", false, false]]);
  const core = await openAt(tree, tree.roots, [root.key, "outside@0.5.0", "ws-core@0.1.0"]);
  assert.deepEqual(core.children.map((n) => n.name), ["serde", "ws-cli"]);
});

test("a crate with no version anywhere is 0.0.0, and never collides with its workspace row", async () => {
  const project = {
    name: "tool", deps: [], skipped: [], layout: "workspace",
    crates: [{ name: "tool", version: null, folder: "/w/tool", path: "/w/tool/Cargo.toml", deps: [{ name: "x", constraint: "1", dev: false }], skipped: [], local: [] }],
  };
  const tree = await treeForProject(project, null, { noLockNote: CARGO_NOTE, unlocked: cargoUnlocked });
  const [root] = tree.roots;
  assert.deepEqual(shape(root.children), [["tool", "0.0.0", null, false, false]]);
  assert.equal(root.children[0].key, "tool@0.0.0");
  assert.equal(countsLine(tree), "1 projects, 2 total");
});

test("a row only the lock entry lists declares no dev", async () => {
  const project = parseCargoToml('[package]\nname = "a"\nversion = "0.1.0"\n');
  const text = [
    '[[package]]', 'name = "a"', 'version = "0.1.0"', 'dependencies = ["extra"]',
    '[[package]]', 'name = "extra"', 'version = "1.0.0"', 'source = "registry+https://github.com/rust-lang/crates.io-index"',
  ].join("\n");
  assert.deepEqual(cargoResolver(text, project).direct, [{ name: "extra", constraint: null, version: "1.0.0" }]);
  assert.equal((await treeForProject(project, lock(text))).roots[0].dev, false);
});

test("under a dev-only project row, every row is dev", async () => {
  // ws-cli's entry lists `extra`, which its manifest never names.
  const text = workspaceLock().replace(' "anyhow",\n "serde_json",', ' "anyhow",\n "extra",\n "serde_json",')
    + '\n[[package]]\nname = "extra"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
  const tree = await treeForProject(await gather(join(workspaceFolder, "crates", "core")), lock(text), { noLockNote: CARGO_NOTE });
  assert.deepEqual(shape(tree.roots), [["serde", "1.0.219", null, false, false], ["ws-cli", "0.1.0", "project", true, false]]);
  const cli = await openAt(tree, tree.roots, ["ws-cli@0.1.0"]);
  assert.deepEqual(shape(cli.children), [
    ["anyhow", "1.0.98", null, true, false], ["extra", "1.0.0", null, true, false],
    ["serde_json", "1.0.140", null, true, false], ["ws-core", "0.1.0", "project", true, true],
  ]);
});
