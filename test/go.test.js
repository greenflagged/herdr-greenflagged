import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findManifest } from "../mods/greenflagged/audit.js";
import { GO_INDIRECT_GROUP, GO_LOCKFILES, GO_NOTE, goResolver, parseGoMod, readGoMod } from "../mods/greenflagged/go.js";
import { countsLine, directRoots, expandNode, groupKey, pathOf, treeForProject, visibleRows } from "../mods/greenflagged/tree.js";

// go.mod is hand-written for the grammar. The other three are verbatim copies of real,
// published go.mod files from the Go module cache:
//   otel-sdk-v1.44.0.mod      go.opentelemetry.io/otel/sdk@v1.44.0
//   fsnotify-v1.9.0.mod       github.com/fsnotify/fsnotify@v1.9.0
//   go-sqlite3-v1.14.22.mod   github.com/mattn/go-sqlite3@v1.14.22
// None of the real files at hand uses a module→module replace, a block replace or a
// block exclude, so those are covered by the hand-written file and inline strings only.
const fixtures = fileURLToPath(new URL("./fixtures/go/", import.meta.url));
const read = (file) => readFileSync(join(fixtures, file), "utf8");
const mod = (version, extra = {}) => ({ version, constraint: version, dev: false, ...extra });
const pairs = (modules) => modules.map((m) => [m.name, m.version]);
const goTree = (text, options) => treeForProject(parseGoMod(text), { file: "go.mod", text, resolver: goResolver }, options);

// --- require -------------------------------------------------------------------

test("readGoMod reads a single-line require and the module name", () => {
  const result = readGoMod("module example.com/x\n\ngo 1.22\n\nrequire github.com/a/b v1.2.3\n");
  assert.deepEqual(result, { name: "example.com/x", direct: [{ name: "github.com/a/b", ...mod("v1.2.3") }], indirect: [], skipped: [] });
});

test("readGoMod reads require blocks, two of them, with quoted paths and CRLF", () => {
  const text = 'module m\r\nrequire (\r\n\tgithub.com/a/b v1.0.0\r\n\t"github.com/c/d" v2.0.0\r\n)\r\nrequire (\r\n\tgithub.com/e/f v0.1.0\r\n)\r\n';
  assert.deepEqual(pairs(readGoMod(text).direct), [["github.com/a/b", "v1.0.0"], ["github.com/c/d", "v2.0.0"], ["github.com/e/f", "v0.1.0"]]);
});

test("readGoMod opens a block written without a space before the paren", () => {
  assert.deepEqual(pairs(readGoMod("require(\n\ta v1.0.0\n)\n").direct), [["a", "v1.0.0"]]);
});

test("// indirect modules go in their own list; other comments stay direct", () => {
  const result = readGoMod("require (\n\ta v1.0.0 // indirect\n\tb v1.0.0 // pinned\n\tc v1.0.0 // indirect; for tests\n)\n");
  assert.deepEqual(pairs(result.direct), [["b", "v1.0.0"]]);
  assert.deepEqual(pairs(result.indirect), [["a", "v1.0.0"], ["c", "v1.0.0"]]);
});

test("a module required twice: direct beats indirect in any order, else the first line wins", () => {
  const indirectFirst = readGoMod("require a v1.0.0 // indirect\nrequire a v1.2.0\n");
  assert.deepEqual(pairs(indirectFirst.direct), [["a", "v1.2.0"]]);
  assert.deepEqual(indirectFirst.indirect, []);
  const directFirst = readGoMod("require a v1.2.0\nrequire a v1.0.0 // indirect\n");
  assert.deepEqual(pairs(directFirst.direct), [["a", "v1.2.0"]]);
  assert.deepEqual(directFirst.indirect, []);
  assert.deepEqual(pairs(readGoMod("require a v1.0.0\nrequire a v1.1.0\n").direct), [["a", "v1.0.0"]]);
  assert.deepEqual(pairs(readGoMod("require a v1.0.0 // indirect\nrequire a v1.1.0 // indirect\n").indirect), [["a", "v1.0.0"]]);
});

test("a require line with no version is skipped", () => {
  assert.deepEqual(readGoMod("require a\nrequire (\n\tb\n\tc v1.0.0\n)\n").direct.map((m) => m.name), ["c"]);
});

test("readGoMod never throws and reads nothing from empty or non-text input", () => {
  const empty = { name: null, direct: [], indirect: [], skipped: [] };
  for (const input of ["", null, undefined, 42, {}, ["require a v1"], "(\n)\n)\n((", "require (\nrequire (\n", "=> => =>"]) {
    const result = readGoMod(input);
    if (typeof input !== "string" || input === "") assert.deepEqual(result, empty, String(input));
    assert.deepEqual(parseGoMod(input).deps, result.direct);
  }
});

// --- replace -------------------------------------------------------------------

test("replace by another module shows the replacement with a marker; the required version stays the constraint", () => {
  const { direct } = readGoMod("require old.example/a v1.0.0\nreplace old.example/a => new.example/a v1.5.0\n");
  assert.deepEqual(direct, [{ name: "new.example/a", version: "v1.5.0", constraint: "v1.0.0", dev: false, marker: "replaces old.example/a" }]);
});

test("replace of the same path changes only the version", () => {
  const { direct } = readGoMod("require a.example/x v1.0.0\nreplace a.example/x => a.example/x v1.0.3\n");
  assert.deepEqual(direct, [{ name: "a.example/x", version: "v1.0.3", constraint: "v1.0.0", dev: false }]);
});

test("a versioned replace applies only to that version and beats a general one", () => {
  const replaces = "replace (\n\ta.example/x v1.0.0 => b.example/x v1.0.1\n\ta.example/x => c.example/x v9.0.0\n)\n";
  assert.deepEqual(pairs(readGoMod(`require a.example/x v1.0.0\n${replaces}`).direct), [["b.example/x", "v1.0.1"]]);
  assert.deepEqual(pairs(readGoMod(`require a.example/x v1.2.0\n${replaces}`).direct), [["c.example/x", "v9.0.0"]]);
  assert.deepEqual(pairs(readGoMod("require a.example/x v1.2.0\nreplace a.example/x v1.0.0 => b.example/x v1.0.1\n").direct), [["a.example/x", "v1.2.0"]]);
});

test("a replace written before its require still applies", () => {
  assert.deepEqual(pairs(readGoMod("replace a => b v2.0.0\nrequire a v1.0.0\n").direct), [["b", "v2.0.0"]]);
});

test("a local replace drops the module and lists its original path as skipped", () => {
  for (const target of ["./local", "../local", "/abs/path", "../", "C:\\mods\\x", "nover"]) {
    const result = readGoMod(`require (\n\ta v1.0.0\n\tb v1.0.0 // indirect\n\tkeep v1.0.0\n)\nreplace a => ${target}\nreplace b v1.0.0 => ${target}\n`);
    assert.deepEqual(pairs(result.direct), [["keep", "v1.0.0"]], target);
    assert.deepEqual(result.indirect, [], target);
    assert.deepEqual(result.skipped, ["a", "b"], target);
  }
});

test("replace applies to indirect modules too", () => {
  const { indirect } = readGoMod("require a v1.0.0 // indirect\nreplace a => z v1.1.0\n");
  assert.deepEqual(indirect, [{ name: "z", version: "v1.1.0", constraint: "v1.0.0", dev: false, marker: "replaces a" }]);
});

test("modules replaced by the same module@version share one row naming every old path", async () => {
  const text = "require (\n\ta v1.0.0\n\tb v1.0.0\n\tz v1.0.0\n\tc v1.0.0 // indirect\n)\nreplace a => z v1.0.0\nreplace b => z v1.0.0\nreplace c => z v1.0.0\n";
  const { direct, indirect } = readGoMod(text);
  assert.deepEqual(direct, [{ name: "z", version: "v1.0.0", constraint: "v1.0.0", dev: false, marker: "replaces a, b, c" }]);
  assert.deepEqual(indirect, []);
  const tree = await goTree(text);
  assert.equal(countsLine(tree), "1 direct, 1 total");
  assert.deepEqual(directRoots(tree).map((n) => n.marker), ["replaces a, b, c"]);
});

test("replaced by different versions of one module, they stay two rows", () => {
  const { direct } = readGoMod("require (\n\ta v1.0.0\n\tb v1.0.0\n)\nreplace a => z v1.0.0\nreplace b => z v2.0.0\n");
  assert.deepEqual(direct.map((m) => [m.name, m.version, m.marker]), [["z", "v1.0.0", "replaces a"], ["z", "v2.0.0", "replaces b"]]);
});

test("a replace of a module that isn't required is ignored, not skipped", () => {
  const result = readGoMod("require a v1.0.0\nreplace (\n\tb => ./b\n\tc => d v1.0.0\n)\n");
  assert.deepEqual(pairs(result.direct), [["a", "v1.0.0"]]);
  assert.deepEqual(result.skipped, []);
});

// --- ignored directives ----------------------------------------------------------

test("a block opener inside an open block starts the new block instead of listing `require`", () => {
  const result = readGoMod("require (\n\ta v1.0.0\nrequire (\n\tb v1.0.0\n)\nreplace(\n\tb => c v2.0.0\n)\n");
  assert.deepEqual(pairs(result.direct), [["a", "v1.0.0"], ["c", "v2.0.0"]]);
  assert.deepEqual(pairs(readGoMod("require (\nrequire (\n").direct), []);
  assert.deepEqual(pairs(readGoMod("exclude (\n\tx v1.0.0\nrequire (\n\ty v1.0.0\n)\n").direct), [["y", "v1.0.0"]]);
});

test("exclude, retract, go, toolchain, godebug, tool and unknown directives are ignored, line or block", () => {
  const base = "module m\nrequire a v1.0.0\n";
  const want = readGoMod(base);
  for (const extra of [
    "exclude a v0.9.0\n", "exclude (\n\ta v0.9.0\n\tb v1.0.0\n)\n",
    "retract v1.0.1\n", "retract (\n\tv1.0.1 // oops\n\t[v1.1.0, v1.1.5] // broken\n)\n",
    "go 1.22\n", "go (\n\t1.22\n)\n", "toolchain go1.22.4\n", "godebug default=go1.21\n", "godebug (\n\tpanicnil=1\n)\n",
    "tool golang.org/x/tools/cmd/stringer\n", "tool (\n\tgolang.org/x/tools/cmd/stringer\n)\n",
    "frobnicate b v1.0.0\n", "frobnicate (\n\tb v1.0.0\n\tc v2.0.0\n)\n",
  ]) {
    assert.deepEqual(readGoMod(base + extra), want, extra);
    assert.deepEqual(readGoMod(extra + base), want, extra);
  }
});

test("a require block after an unknown block still parses, and the unknown block's lines don't leak", () => {
  const result = readGoMod("frobnicate (\n\tleak v9.9.9\n)\nrequire (\n\ta v1.0.0\n)\n");
  assert.deepEqual(pairs(result.direct), [["a", "v1.0.0"]]);
});

// --- the hand-written fixture ------------------------------------------------------

test("the hand-written go.mod reads to its directs, indirects and skipped", () => {
  const result = readGoMod(read("go.mod"));
  assert.equal(result.name, "example.com/app");
  assert.deepEqual(result.direct, [
    { name: "github.com/single/line", ...mod("v1.0.0") },
    { name: "github.com/block/one", ...mod("v1.1.0") },
    { name: "github.com/quoted/path", ...mod("v0.3.0") },
    { name: "github.com/renamed/new", version: "v1.5.0", constraint: "v1.0.0", dev: false, marker: "replaces github.com/renamed/old" },
    { name: "github.com/bumped/same", version: "v1.0.3", constraint: "v1.0.0", dev: false },
    { name: "github.com/pinned/fork", version: "v1.0.1", constraint: "v1.0.0", dev: false, marker: "replaces github.com/pinned/only" },
    { name: "github.com/commented/direct", ...mod("v2.0.0") },
    { name: "github.com/twice/required", ...mod("v1.2.0") },
  ]);
  assert.deepEqual(result.indirect, [
    { name: "github.com/indirect/plain", ...mod("v0.5.0") },
    { name: "github.com/indirect/fork", version: "v0.6.1", constraint: "v0.6.0", dev: false, marker: "replaces github.com/indirect/renamed" },
  ]);
  assert.deepEqual(result.skipped, ["github.com/local/dot", "github.com/local/dotdot"]);
  assert.deepEqual(parseGoMod(read("go.mod")), { name: result.name, deps: result.direct, skipped: result.skipped });
});

// --- real go.mod files ---------------------------------------------------------------

test("otel/sdk's go.mod: six direct, six indirect, four local replaces skipped", async () => {
  const text = read("otel-sdk-v1.44.0.mod");
  const result = readGoMod(text);
  assert.equal(result.name, "go.opentelemetry.io/otel/sdk");
  assert.deepEqual(pairs(result.direct), [
    ["github.com/go-logr/logr", "v1.4.3"], ["github.com/google/go-cmp", "v0.7.0"], ["github.com/google/uuid", "v1.6.0"],
    ["github.com/stretchr/testify", "v1.11.1"], ["go.uber.org/goleak", "v1.3.0"], ["golang.org/x/sys", "v0.45.0"],
  ]);
  assert.deepEqual(result.indirect.map((m) => m.name), [
    "github.com/cespare/xxhash/v2", "github.com/davecgh/go-spew", "github.com/go-logr/stdr",
    "github.com/pmezard/go-difflib", "go.opentelemetry.io/auto/sdk", "gopkg.in/yaml.v3",
  ]);
  assert.deepEqual(result.skipped, ["go.opentelemetry.io/otel", "go.opentelemetry.io/otel/metric", "go.opentelemetry.io/otel/sdk/metric", "go.opentelemetry.io/otel/trace"]);
  assert.equal(countsLine(await goTree(text)), "6 direct, 12 total");
});

test("fsnotify's go.mod: one direct module, its retract block ignored", () => {
  const result = readGoMod(read("fsnotify-v1.9.0.mod"));
  assert.equal(result.name, "github.com/fsnotify/fsnotify");
  assert.deepEqual(result.direct, [{ name: "golang.org/x/sys", ...mod("v0.13.0") }]);
  assert.deepEqual(result.indirect, []);
  assert.deepEqual(result.skipped, []);
});

test("go-sqlite3's go.mod: no requires, and a retract range with +incompatible ignored", async () => {
  const text = read("go-sqlite3-v1.14.22.mod");
  assert.deepEqual(readGoMod(text), { name: "github.com/mattn/go-sqlite3", direct: [], indirect: [], skipped: [] });
  const tree = await goTree(text);
  assert.deepEqual(tree.roots, []);
  assert.equal(countsLine(tree), "0 direct, 0 total");
});

// --- the tree ------------------------------------------------------------------------

test("the tree: directs as versioned leaves, the indirect group last, no note", async () => {
  const text = read("go.mod");
  const tree = await goTree(text);
  assert.equal(tree.note, null);
  assert.equal(tree.lockFile, "go.mod");
  const group = tree.roots.at(-1);
  assert.equal(group.name, GO_INDIRECT_GROUP);
  assert.equal(group.key, groupKey("indirect"));
  assert.equal(group.group, true);
  assert.equal(group.dev, false);
  assert.equal(group.leaf, false);
  const modules = tree.roots.slice(0, -1);
  assert.deepEqual(modules.map((n) => n.name), [...modules.map((n) => n.name)].sort());
  for (const node of modules) {
    assert.ok(node.version, node.name);
    assert.equal(node.leaf, true, node.name);
    assert.equal(node.dev, false, node.name);
    assert.equal(node.group, false, node.name);
  }
  assert.equal(directRoots(tree).length, 8);
  assert.equal(countsLine(tree), "8 direct, 10 total");
  assert.deepEqual(visibleRows(tree, new Set()).map((r) => r.node.name), [...modules.map((n) => n.name), "indirect"]);

  await expandNode(tree, group, [group.key]);
  assert.deepEqual(group.children.map((n) => [n.name, n.version, n.marker, n.dev, n.leaf]), [
    ["github.com/indirect/fork", "v0.6.1", "replaces github.com/indirect/renamed", false, true],
    ["github.com/indirect/plain", "v0.5.0", null, false, true],
  ]);
  const expanded = new Set([pathOf([group.key])]);
  assert.deepEqual(visibleRows(tree, expanded).slice(-2).map((r) => [r.node.name, r.depth]), [
    ["github.com/indirect/fork", 1], ["github.com/indirect/plain", 1],
  ]);
});

test("a saved open group reopens on a rebuilt tree", async () => {
  const text = read("go.mod");
  const expanded = new Set([pathOf([groupKey("indirect")])]);
  const tree = await goTree(text, { expanded });
  assert.equal(tree.roots.at(-1).children.length, 2);
  assert.equal(expanded.size, 1);
});

test("no group row when go.mod has no indirect modules", async () => {
  const tree = await goTree("module m\nrequire (\n\tb v1.0.0\n\ta v2.0.0\n)\n");
  assert.deepEqual(tree.roots.map((n) => [n.name, n.version, n.leaf]), [["a", "v2.0.0", true], ["b", "v1.0.0", true]]);
  assert.equal(countsLine(tree), "2 direct, 2 total");
});

test("a go.mod with only indirect modules draws the group alone", async () => {
  const tree = await goTree("module m\nrequire a v1.0.0 // indirect\n");
  assert.deepEqual(tree.roots.map((n) => n.name), ["indirect"]);
  assert.equal(countsLine(tree), "0 direct, 1 total");
});

test("a module literally named indirect is its own row, before the group", async () => {
  const tree = await goTree("require (\n\tindirect v1.0.0\n\tother v1.0.0 // indirect\n)\n");
  assert.deepEqual(tree.roots.map((n) => [n.name, n.key, n.leaf]), [["indirect", "indirect@v1.0.0", true], ["indirect", groupKey("indirect"), false]]);
  assert.equal(countsLine(tree), "1 direct, 2 total");
});

test("the Go entry finds go.mod as the manifest and lists it as its own lockfile", async () => {
  const text = read("go.mod");
  const project = await findManifest("/r/cmd", "/Users/a", async (path) => ({ "/r/go.mod": text })[path] ?? null);
  assert.equal(project.path, "/r/go.mod");
  assert.equal(project.ecosystem.file, "go.mod");
  assert.equal(project.ecosystem.lockfiles, GO_LOCKFILES);
  assert.equal(project.ecosystem.note, GO_NOTE);
  assert.equal(project.name, "example.com/app");
  assert.deepEqual(project.deps, readGoMod(text).direct);
  assert.deepEqual(project.skipped, ["github.com/local/dot", "github.com/local/dotdot"]);
});

test("if go.mod can't be read a second time, the note replaces the no-lockfile sentence", async () => {
  const project = parseGoMod(read("go.mod"));
  const tree = await treeForProject(project, null, { noLockNote: GO_NOTE });
  assert.equal(tree.note, GO_NOTE);
  assert.equal(countsLine(tree), "8 direct, 8 total");
});
