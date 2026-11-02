import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findManifest, lastValidProject, staleNote } from "../mods/greenflagged/audit.js";
import { openCache, sessionReader } from "../mods/greenflagged/cache.js";
import {
  GO_INDIRECT_GROUP, GO_LOCKFILES, GO_MODULE_CACHE, GO_NO_CACHE_NOTE, GO_NOTE, escapeModulePath, escapeVersion, goModCacheFile, goResolver, parseGoMod,
  readGoMod, scanGoMod, selectedVersions,
} from "../mods/greenflagged/go.js";
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

test("readGoMod never throws, and reads nothing from empty or non-text input", () => {
  const empty = { name: null, direct: [], indirect: [], skipped: [] };
  for (const input of ["", null, undefined, 42, {}, ["require a v1"]]) assert.deepEqual(readGoMod(input), empty, String(input));
  for (const input of ["(\n)\n)\n((", "require (\nrequire (\n", "=> => =>", "replace => =>\n", "require\n"]) {
    const result = readGoMod(input);
    assert.ok(result.error === undefined || /^go\.mod line \d+: /.test(result.error), input);
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
  for (const target of ["./local", "../local", "/abs/path", "../", "C:\\mods\\x"]) {
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

// --- malformed go.mod -------------------------------------------------------------

test("a malformed go.mod is refused with an error naming the line", () => {
  const cases = [
    // A block never closed: the error names the line that opened it.
    ["module m\nrequire (\n\ta v1.0.0\n", 2, "the `require (` block is never closed"],
    ["module m\nreplace(\n\ta => b v1.0.0\n", 2, "the `replace (` block is never closed"],
    ["module m\nfrobnicate (\n\tx\n", 2, "the `frobnicate (` block is never closed"],
    // A directive keyword inside a block, for every keyword.
    ...["module example.com/m", "go 1.22", "toolchain go1.22.4", "godebug default=go1.21", "require c v1.0.0",
      "replace a => b v2.0.0", "exclude a v0.9.0", "retract v1.0.1", "tool golang.org/x/tools/cmd/stringer",
      "ignore ./node_modules"].map((line) => [`module m\nrequire (\n\ta v1.0.0\n${line}\n)\n`, 4,
      `\`${line.split(" ")[0]}\` inside the \`require (\` block opened on line 2`]),
    // A block opener inside a block, either spelling.
    ["require (\n\ta v1.0.0\nrequire (\n\tb v1.0.0\n)\n", 3, "`require (` inside the `require (` block opened on line 1"],
    ["exclude (\n\tx v1.0.0\nreplace(\n)\n", 3, "`replace (` inside the `exclude (` block opened on line 1"],
    // A require that isn't a path and a version, single-line or in a block.
    ["module m\nrequire a\n", 2, "a require needs a module path and a version"],
    ["require (\n\tb v1.0.0\n\tc\n)\n", 3, "a require needs a module path and a version"],
    ["require a v1.0.0 extra\n", 1, "a require needs a module path and a version"],
    ["require\n", 1, "a require needs a module path and a version"],
    ["require ()\n", 1, "a require needs a module path and a version"],
    ["require a v1.0.0 )\n", 1, "a stray `(` or `)` in a require"],
    ["require a v1.0.0\nreplace a => ( b\n", 2, "a stray `(` or `)` in a replace"],
  ];
  const badReplace = "a replace needs `path [version] => ./local/path` or `path [version] => path version`";
  // A replace with no `=>`, or a right side that's neither a local path alone nor a path and a version.
  for (const line of ["a b v1.0.0", "a =>", "=> b v1.0.0", "a v1 v2 => b v1.0.0", "a => b", "a => ./b v1.0.0", "a => b v1.0.0 extra", "a => b => c v1"]) {
    cases.push([`require a v1.0.0\nreplace ${line}\n`, 2, badReplace]);
    cases.push([`require a v1.0.0\n\nreplace (\n\t${line}\n)\n`, 4, badReplace]);
  }
  for (const [text, line, why] of cases) {
    const error = `go.mod line ${line}: ${why}`;
    assert.deepEqual(readGoMod(text), { error }, text);
    assert.deepEqual(parseGoMod(text), { error }, text);
    assert.deepEqual(goResolver(text, null), { error }, text);
  }
});

test("lines are counted from 1 with CRLF too, blank and comment lines included", () => {
  assert.deepEqual(readGoMod("// header\r\n\r\nmodule m\r\nrequire a\r\n"), { error: "go.mod line 4: a require needs a module path and a version" });
});

test("a malformed go.mod reaches the panel as the project's error, through findManifest", async () => {
  const project = await findManifest("/r", "/Users/a", async (path) => (path === "/r/go.mod" ? "module r\nrequire (\n\ta v1.0.0\n" : null));
  assert.equal(project.path, "/r/go.mod");
  assert.equal(project.error, "go.mod line 2: the `require (` block is never closed");
});

test("a lock read that comes back malformed gives the tree a note, not a partial tree", async () => {
  const good = "module m\nrequire a v1.0.0\n";
  const tree = await treeForProject(parseGoMod(good), { file: "go.mod", text: "module m\nrequire (\n", resolver: goResolver });
  assert.equal(tree.note, "Couldn't read go.mod: go.mod line 2: the `require (` block is never closed");
  assert.deepEqual(directRoots(tree).map((n) => n.name), ["a"]);
});

test("exclude, retract, go, toolchain, godebug, tool, ignore and unknown directives are ignored, line or block", () => {
  const base = "module m\nrequire a v1.0.0\n";
  const want = readGoMod(base);
  for (const extra of [
    "exclude a v0.9.0\n", "exclude (\n\ta v0.9.0\n\tb v1.0.0\n)\n",
    "retract v1.0.1\n", "retract (\n\tv1.0.1 // oops\n\t[v1.1.0, v1.1.5] // broken\n)\n",
    "go 1.22\n", "go (\n\t1.22\n)\n", "toolchain go1.22.4\n", "godebug default=go1.21\n", "godebug (\n\tpanicnil=1\n)\n",
    "tool golang.org/x/tools/cmd/stringer\n", "tool (\n\tgolang.org/x/tools/cmd/stringer\n)\n",
    "ignore ./node_modules\n", "ignore (\n\t./vendor\n)\n",
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

test("headless edit: valid → malformed keeps the last valid tree with a stale error → valid again", async () => {
  const at = (text) => findManifest("/r", "/Users/a", async (path) => (path === "/r/go.mod" ? text : null));
  const valid = "module r\nrequire (\n\ta v1.0.0\n\tb v1.0.0 // indirect\n)\n";
  const first = await at(valid);
  const tree = await goTree(valid);
  // Mid-edit, a block not yet closed: same file, so the last valid project and tree stay.
  const editing = await at("module r\nrequire (\n\ta v1.0.0\n\tc v1.0.0\n");
  assert.equal(lastValidProject(first, editing), first);
  assert.equal(staleNote(editing.error), "go.mod line 2: the `require (` block is never closed · showing the last valid version");
  assert.equal(countsLine(tree), "1 direct, 2 total");
  // Saved again, valid: a fresh tree with the new module, no stale note.
  const fixed = "module r\nrequire (\n\ta v1.0.0\n\tc v1.0.0\n)\n";
  const again = await at(fixed);
  assert.equal(again.error, undefined);
  assert.deepEqual(directRoots(await goTree(fixed)).map((n) => n.name), ["a", "c"]);
});

// --- the module cache (#13) ----------------------------------------------------------

// A fake module cache at DIR. `files` maps a path relative to DIR to text, null or an
// Error to reject with; every read is recorded as its absolute path. `memo` may be
// shared between builds, as main.js shares one per machine and folder.
const DIR = "/gm";
const at = (name, version) => `${DIR}/${goModCacheFile(name, version)}`;
function goCache(files = {}, memo = null) {
  const seen = [];
  const read = async (path) => {
    seen.push(path);
    const value = files[path];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  const shared = memo ?? sessionReader(read);
  return { seen, files, memo: shared, cache: openCache(GO_MODULE_CACHE, DIR, read, shared) };
}
const LOCK = `${DIR}/cache/lock`;
const cacheTree = (text, cache, options = {}) =>
  treeForProject(parseGoMod(text), { ...GO_LOCKFILES[0], text }, { ...options, cache });
const open = async (tree, ...names) => {
  let nodes = tree.roots, keys = [], node = null;
  for (const name of names) {
    node = nodes.find((n) => n.name === name);
    assert.ok(node, `no row ${name}`);
    keys = [...keys, node.key];
    await expandNode(tree, node, keys);
    nodes = node.children;
  }
  return node;
};
const row = (n) => [n.name, n.version, n.constraint, n.marker];

const APP = `module example.com/app

go 1.22

require (
	github.com/fsnotify/fsnotify v1.9.0
	go.opentelemetry.io/otel/sdk v1.44.0
	github.com/BurntSushi/toml v1.4.0
	golang.org/x/sys v0.30.0 // indirect
)

replace github.com/google/uuid => github.com/fork/uuid v1.7.0

replace github.com/go-logr/logr => ./logr
`;
const warm = () => ({
  [LOCK]: "",
  [at("github.com/fsnotify/fsnotify", "v1.9.0")]: read("fsnotify-v1.9.0.mod"),
  [at("go.opentelemetry.io/otel/sdk", "v1.44.0")]: read("otel-sdk-v1.44.0.mod"),
  [at("golang.org/x/sys", "v0.30.0")]: "module golang.org/x/sys\n\ngo 1.18\n",
});

// --- escaping and the allowlist

test("module paths and versions are escaped as Go stores them", () => {
  assert.equal(escapeModulePath("github.com/BurntSushi/toml"), "github.com/!burnt!sushi/toml");
  assert.equal(escapeModulePath("github.com/fsnotify/fsnotify"), "github.com/fsnotify/fsnotify");
  assert.equal(escapeVersion("v1.0.0-RC1"), "v1.0.0-!r!c1");
  assert.equal(escapeVersion("v2.0.0+incompatible"), "v2.0.0+incompatible");
  for (const bad of ["github.com/a!b", "github.com/é", "v1!", "v1.0.0-ü", null, undefined, 7]) {
    assert.equal(escapeModulePath(bad), null, String(bad));
  }
  assert.equal(goModCacheFile("github.com/BurntSushi/toml", "v1.4.0"), "cache/download/github.com/!burnt!sushi/toml/@v/v1.4.0.mod");
  assert.equal(goModCacheFile("example.com/x", "v1.0.0-RC1"), "cache/download/example.com/x/@v/v1.0.0-!r!c1.mod");
  assert.equal(goModCacheFile("example.com/x", "v2.0.0+incompatible"), "cache/download/example.com/x/@v/v2.0.0+incompatible.mod");
});

test("the allowlist refuses climbing, absolute and odd paths and versions", () => {
  const paths = ["../../etc/passwd", "github.com/a/../../../x", "/etc/passwd", "a//b", "a/./b", "a/", "a\\b", "a b", "a%2e", "a\u0000b", "", "..", "a/.."];
  for (const path of paths) assert.equal(goModCacheFile(path, "v1.0.0"), null, JSON.stringify(path));
  const versions = ["../x", "..", ".", "v1/../../x", "v1 x", "v1/x", "", null, "v1\u0000"];
  for (const version of versions) assert.equal(goModCacheFile("example.com/x", version), null, JSON.stringify(version));
});

test("a crafted go.mod and a crafted .mod never make the panel read outside the cache's .mod files", async () => {
  const crafted = [
    "../../etc/passwd v1.0.0", "/etc/passwd v1.0.0", "github.com/a/../../../x v1.0.0", "a/./b v1.0.0", "ok.com/x ../../../../etc/passwd",
    "ok.com/y v1/../../x", "ok.com/z ..", "a%2e%2e v1.0.0", "Ünïcode.com/x v1.0.0", "a!b.com/x v1.0.0",
  ];
  const text = `module m\nrequire (\n${crafted.map((l) => `\t${l}`).join("\n")}\n\tgood.com/dep v1.0.0\n)\n`;
  const { seen, cache } = goCache({
    [LOCK]: "",
    [at("good.com/dep", "v1.0.0")]: `module good.com/dep\nrequire (\n${crafted.map((l) => `\t${l}`).join("\n")}\n)\n`,
  });
  const tree = await cacheTree(text, cache);
  const expandAll = async (nodes, keys, depth) => {
    for (const node of nodes) {
      if (node.leaf || depth > 3) continue;
      await expandNode(tree, node, [...keys, node.key]);
      await expandAll(node.children, [...keys, node.key], depth + 1);
    }
  };
  await expandAll(tree.roots, [], 0);
  assert.ok(seen.length > 1);
  for (const path of seen) {
    assert.ok(path === LOCK || (path.startsWith(`${DIR}/cache/download/`) && path.endsWith(".mod") && !path.includes("/../")), path);
  }
  const tags = new Set(tree.roots.filter((n) => n.name !== "good.com/dep").map((n) => n.tag));
  assert.deepEqual([...tags], ["unreadable"]);
});

// --- selected versions, replace, children

test("scanGoMod and selectedVersions: a direct line beats an indirect one, else the first wins", () => {
  const scanned = scanGoMod("module m\nrequire (\n\ta v1 // indirect\n\ta v2\n\tb v1\n\tb v3\n\tc v4 // indirect\n)\n");
  assert.equal(scanned.name, "m");
  assert.deepEqual([...selectedVersions(scanned.requires)], [["a", "v2"], ["b", "v1"], ["c", "v4"]]);
  assert.match(scanGoMod("require (\n").error, /never closed/);
});

test("a child shows the version the project selects, with the version asked for as its constraint", async () => {
  const { cache } = goCache(warm());
  const tree = await cacheTree(APP, cache);
  const fsnotify = await open(tree, "github.com/fsnotify/fsnotify");
  assert.deepEqual(fsnotify.children.map(row), [["golang.org/x/sys", "v0.30.0", "v0.13.0", null]]);
  assert.equal(fsnotify.children[0].dev, false);
  assert.equal(fsnotify.children[0].leaf, false); // deferred: opening it reads its own .mod
  const sys = await open(tree, "github.com/fsnotify/fsnotify", "golang.org/x/sys");
  assert.deepEqual([sys.leaf, sys.tag], [true, null]); // a .mod with no requires
});

test("otel/sdk opens into its 16 requires: project replaces applied, its own replaces ignored, unlisted ones as asked", async () => {
  const { cache } = goCache(warm());
  const tree = await cacheTree(APP, cache);
  const sdk = await open(tree, "go.opentelemetry.io/otel/sdk");
  const rows = sdk.children.map(row);
  assert.equal(rows.length, 15); // 16 requires, logr dropped by the project's local replace
  assert.ok(!rows.some(([name]) => name === "github.com/go-logr/logr"));
  assert.deepEqual(rows.find(([name]) => name === "github.com/fork/uuid"), ["github.com/fork/uuid", "v1.7.0", "v1.6.0", "replaces github.com/google/uuid"]);
  // otel/sdk's own `replace go.opentelemetry.io/otel => ../` is ignored.
  assert.deepEqual(rows.find(([name]) => name === "go.opentelemetry.io/otel"), ["go.opentelemetry.io/otel", "v1.44.0", "v1.44.0", null]);
  assert.deepEqual(rows.find(([name]) => name === "golang.org/x/sys"), ["golang.org/x/sys", "v0.30.0", "v0.45.0", null]);
  assert.deepEqual(rows.find(([name]) => name === "gopkg.in/yaml.v3"), ["gopkg.in/yaml.v3", "v3.0.1", "v3.0.1", null]);
  assert.ok(sdk.children.every((n) => n.dev === false));
});

test("a child naming the project's own module is dropped, and duplicates are one row", async () => {
  const text = "module example.com/app\nrequire a.com/x v1.0.0\n";
  const { cache } = goCache({
    [LOCK]: "",
    [at("a.com/x", "v1.0.0")]: "module a.com/x\nrequire (\n\texample.com/app v0.1.0\n\tb.com/y v1.0.0\n\tb.com/y v1.0.0 // indirect\n)\n",
  });
  const x = await open(await cacheTree(text, cache), "a.com/x");
  assert.deepEqual(x.children.map(row), [["b.com/y", "v1.0.0", "v1.0.0", null]]);
});

test("a cycle between modules shows (cycle)", async () => {
  const text = "module m\nrequire a.com/a v1.0.0\n";
  const { cache } = goCache({
    [LOCK]: "",
    [at("a.com/a", "v1.0.0")]: "module a.com/a\nrequire b.com/b v1.0.0\n",
    [at("b.com/b", "v1.0.0")]: "module b.com/b\nrequire a.com/a v1.0.0\n",
  });
  const tree = await cacheTree(text, cache);
  const b = await open(tree, "a.com/a", "b.com/b");
  assert.deepEqual(b.children.map((n) => [n.name, n.cycle, n.leaf]), [["a.com/a", true, true]]);
});

// --- missing, malformed, failing

test("a module whose .mod isn't cached becomes, once opened, a leaf tagged not downloaded", async () => {
  const { cache } = goCache(warm());
  const tree = await cacheTree(APP, cache);
  const toml = tree.roots.find((n) => n.name === "github.com/BurntSushi/toml");
  assert.equal(toml.leaf, false);
  await open(tree, "github.com/BurntSushi/toml");
  assert.deepEqual([toml.leaf, toml.tag, toml.children], [true, "not downloaded", []]);
});

test("a malformed .mod gives a leaf tagged unreadable", async () => {
  const { cache } = goCache({ ...warm(), [at("github.com/BurntSushi/toml", "v1.4.0")]: "require (\n\ta v1\n" });
  const toml = await open(await cacheTree(APP, cache), "github.com/BurntSushi/toml");
  assert.deepEqual([toml.leaf, toml.tag], [true, "unreadable"]);
});

test("a .mod read that fails leaves the row unbuilt, and a second open retries", async () => {
  const file = at("github.com/BurntSushi/toml", "v1.4.0");
  const { cache, files, seen } = goCache({ ...warm(), [file]: new Error("permission denied") });
  const tree = await cacheTree(APP, cache);
  const toml = tree.roots.find((n) => n.name === "github.com/BurntSushi/toml");
  await assert.rejects(expandNode(tree, toml, [toml.key]), /permission denied/);
  assert.deepEqual([toml.children, toml.leaf, toml.tag], [null, false, null]);
  files[file] = "module github.com/BurntSushi/toml\nrequire a.com/x v1.0.0\n";
  await expandNode(tree, toml, [toml.key]);
  assert.deepEqual(toml.children.map((n) => n.name), ["a.com/x"]);
  assert.equal(seen.filter((p) => p === file).length, 2);
});

// --- the flat fallback

const flatRows = (tree) => visibleRows(tree, new Set()).map((r) => [r.node.name, r.node.version, r.node.marker, r.node.leaf]);

test("with no cache the tree is goResolver's flat view with a note", async () => {
  const text = read("go.mod");
  const flat = await goTree(text);
  const tree = await cacheTree(text, null);
  assert.deepEqual(flatRows(tree), flatRows(flat));
  assert.equal(countsLine(tree), countsLine(flat));
  assert.equal(tree.note, GO_NO_CACHE_NOTE);
  assert.equal(tree.lazy, false);
  assert.equal(tree.cacheBacked, true);
});

test("with neither cache/lock nor the first module's .mod, the flat view, after reading only those two", async () => {
  const text = read("go.mod");
  const { cache, seen } = goCache({});
  const tree = await cacheTree(text, cache);
  assert.deepEqual(flatRows(tree), flatRows(await goTree(text)));
  assert.equal(tree.note, GO_NO_CACHE_NOTE);
  const first = readGoMod(text).direct[0];
  assert.deepEqual(seen, [LOCK, at(first.name, first.version)]);
});

test("without cache/lock, the first module's .mod alone is enough", async () => {
  const files = warm();
  delete files[LOCK];
  const { cache } = goCache(files);
  const tree = await cacheTree(APP, cache);
  assert.equal(tree.note, null);
  assert.equal(tree.lazy, true);
});

test("a probe read that fails gives the flat view and says the cache couldn't be read", async () => {
  const { cache } = goCache({ [LOCK]: new Error("host unreachable") });
  const tree = await cacheTree(APP, cache);
  assert.equal(tree.note, "Go's module cache couldn't be read: host unreachable");
  assert.equal(tree.lazy, false);
  assert.ok(tree.roots.every((n) => n.group || n.leaf));
});

test("an emptied cache isn't hidden by the session memo", async () => {
  const files = warm();
  const first = at("github.com/fsnotify/fsnotify", "v1.9.0");
  const { cache, memo } = goCache(files);
  await open(await cacheTree(APP, cache), "github.com/fsnotify/fsnotify"); // fsnotify's .mod is now in the memo
  const emptied = goCache({}, memo);
  const tree = await cacheTree(APP, emptied.cache);
  assert.equal(tree.note, GO_NO_CACHE_NOTE);
  assert.deepEqual(emptied.seen, [LOCK, first]);
});

test("a fallback heals once the cache appears, on a rebuild with the same memo", async () => {
  const files = {};
  const { cache, memo } = goCache(files);
  const before = await cacheTree(APP, cache);
  assert.equal(before.note, GO_NO_CACHE_NOTE);
  assert.equal(before.cacheBacked, true);
  Object.assign(files, warm());
  const after = await cacheTree(APP, goCache(files, memo).cache);
  assert.equal(after.note, null);
  assert.equal(after.lazy, true);
  assert.equal(after.cacheBacked, true);
});

// --- laziness, counts

test("a first build reads only the probe; each open reads one .mod; a rebuild reopens from the memo", async () => {
  const { cache, seen, memo, files } = goCache(warm());
  const tree = await cacheTree(APP, cache);
  assert.deepEqual(seen, [LOCK]);
  const fsnotify = at("github.com/fsnotify/fsnotify", "v1.9.0");
  await open(tree, "github.com/fsnotify/fsnotify");
  assert.deepEqual(seen, [LOCK, fsnotify]);
  const again = goCache(files, memo);
  const expanded = new Set([pathOf(["github.com/fsnotify/fsnotify@v1.9.0"])]);
  const rebuilt = await cacheTree(APP, again.cache, { expanded });
  assert.deepEqual(again.seen, [LOCK]); // fsnotify's .mod came from the memo
  assert.deepEqual(visibleRows(rebuilt, expanded).map((r) => r.node.name).slice(0, 2), ["github.com/BurntSushi/toml", "github.com/fsnotify/fsnotify"]);
  assert.equal(rebuilt.roots.find((n) => n.name === "github.com/fsnotify/fsnotify").children.length, 1);
});

test("the cache view counts exactly as the flat view: duplicates and shared replacements once", async () => {
  const text = [
    "module m", "require (", "\ta v1.0.0", "\ta v1.0.0 // indirect", "\tb v1.0.0", "\tc v1.0.0 // indirect", "\td v2.0.0 // indirect", "\te v1.0.0", ")",
    "replace c => shared v9.0.0", "replace d => shared v9.0.0", "replace e => ./e",
  ].join("\n");
  const { cache } = goCache({ [LOCK]: "" });
  const tree = await cacheTree(text, cache);
  const flat = await goTree(text);
  assert.equal(countsLine(tree), countsLine(flat));
  assert.equal(countsLine(tree), "2 direct, 3 total");
  assert.ok(tree.roots.every((n) => n.dev === false));
});

test("the hand-written go.mod: same rows and counts as the flat view, every module expandable", async () => {
  const text = read("go.mod");
  const { cache } = goCache({ [LOCK]: "" });
  const tree = await cacheTree(text, cache);
  const flat = await goTree(text);
  assert.equal(countsLine(tree), countsLine(flat));
  assert.deepEqual(tree.roots.map((n) => [n.name, n.version, n.marker]), flat.roots.map((n) => [n.name, n.version, n.marker]));
  assert.ok(tree.roots.every((n) => !n.leaf));
  const group = tree.roots.at(-1);
  await expandNode(tree, group, [group.key]);
  assert.ok(group.children.every((n) => !n.leaf && n.dev === false));
});
