import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findManifest } from "../mods/greenflagged/audit.js";
import {
  PYTHON_LOCKFILES, PYTHON_NOTE, normalizeName, parsePyproject, parseRequirement, parseRequirements, poetryPackages, poetryResolver,
  stripLockFiles, uvPackages, uvResolver,
} from "../mods/greenflagged/python.js";
import { parseToml } from "../mods/greenflagged/toml.js";
import { countsLine, expandNode, treeForProject } from "../mods/greenflagged/tree.js";

const fixtures = fileURLToPath(new URL("./fixtures/python/", import.meta.url));
const read = (...parts) => readFileSync(join(fixtures, ...parts), "utf8");
const toml = (text) => {
  const result = parseToml(text);
  assert.equal(result.error, undefined, result.error);
  return result.value;
};
const summary = (nodes) => nodes.map((n) => [n.name, n.version, n.marker, n.dev]);
const find = (nodes, name, version) => nodes.find((n) => n.name === name && (!version || n.version === version));
const lock = (file, text) => ({ file, text, resolver: PYTHON_LOCKFILES.find((l) => l.file === file).resolver });

const uvProject = () => parsePyproject(read("uv", "pyproject.toml"));
const uvTree = (project = uvProject(), text = read("uv", "uv.lock")) => treeForProject(project, lock("uv.lock", text));

// --- names and requirement strings ---------------------------------------------

test("normalizeName folds case and runs of - _ . the way PyPI compares names", () => {
  assert.equal(normalizeName("PyYAML"), "pyyaml");
  assert.equal(normalizeName("typing_extensions"), "typing-extensions");
  assert.equal(normalizeName("Zope.__Interface"), "zope-interface");
  assert.equal(normalizeName(null), null);
  assert.equal(normalizeName(3), null);
});

test("parseRequirement reads the PEP 508 subset manifests and lockfiles use", () => {
  assert.deepEqual(parseRequirement("requests"), { name: "requests", constraint: "*", extras: [], marker: null });
  assert.deepEqual(parseRequirement("requests==2.31.0"), { name: "requests", constraint: "==2.31.0", extras: [], marker: null });
  assert.deepEqual(parseRequirement(" Django >=4.2,<5 "), { name: "django", constraint: ">=4.2,<5", extras: [], marker: null });
  assert.deepEqual(parseRequirement("chardet (>=3.0.2,<6)"), { name: "chardet", constraint: ">=3.0.2,<6", extras: [], marker: null });
  assert.deepEqual(parseRequirement("httpx[ HTTP2 , cli ]>=0.27"), { name: "httpx", constraint: ">=0.27", extras: ["http2", "cli"], marker: null });
  assert.deepEqual(parseRequirement('tzdata ; python_version >= "3.9" and platform_system == "Windows"'),
    { name: "tzdata", constraint: "*", extras: [], marker: 'python_version >= "3.9" and platform_system == "Windows"' });
  assert.deepEqual(parseRequirement("pkg @ https://example.com/pkg.tar.gz ; os_name == 'nt'"),
    { name: "pkg", url: true, extras: [], marker: "os_name == 'nt'" });
});

test("parseRequirement answers null for what doesn't read as a requirement", () => {
  for (const text of ["", "!!!", "name[unclosed", "name what", null]) assert.equal(parseRequirement(text), null, String(text));
});

test("parseRequirement keeps a ; inside quotes as part of the marker", () => {
  assert.equal(parseRequirement(`a ; extra == "x;y"`).marker, `extra == "x;y"`);
});

// --- pyproject.toml ------------------------------------------------------------

test("parsePyproject reads PEP 621 dependencies, optional dependencies and dependency groups", () => {
  assert.deepEqual(uvProject(), {
    name: "uv-demo",
    deps: [
      { name: "httpx", constraint: ">=0.27", dev: false, extras: ["http2"] },
      { name: "numpy", constraint: ">=1.26", dev: false },
      { name: "rich", constraint: ">=13", dev: false },
      { name: "pytest", constraint: ">=8", dev: true },
    ],
    skipped: [],
  });
});

test("parsePyproject follows include-group once, even through a cycle", () => {
  const { deps } = parsePyproject('[dependency-groups]\na = ["x", { include-group = "b" }]\nb = ["y", { include-group = "a" }]\n');
  assert.deepEqual(deps.map((d) => d.name), ["x", "y"]);
});

test("parsePyproject reads poetry's tables, marks dev by group and skips path and git sources", () => {
  assert.deepEqual(parsePyproject(read("poetry", "pyproject.toml")), {
    name: "poetry-demo",
    deps: [
      { name: "requests", constraint: "^2.31", dev: false },
      { name: "pyyaml", constraint: ">=6.0", dev: false, extras: ["libyaml"], marker: "sys_platform != 'win32'" },
      { name: "click", constraint: "^8.1", dev: false },
      { name: "pytest", constraint: "^8.0", dev: true },
      { name: "black", constraint: "^24.0", dev: true },
    ],
    skipped: ["local-lib", "forked"],
  });
});

test("parsePyproject joins a poetry multiple-constraints entry into one dependency", () => {
  const { deps } = parsePyproject('[tool.poetry.dependencies]\nfoo = [{ version = "<2", python = "<3.9" }, { version = ">=2", python = ">=3.9" }]\n');
  assert.deepEqual(deps, [{ name: "foo", constraint: "<2 || >=2", dev: false }]);
});

test("parsePyproject says when no dependency table exists", () => {
  assert.deepEqual(parsePyproject(read("requirements", "pyproject.toml")), { name: "legacy-app", deps: [], skipped: [], undeclared: true });
  assert.equal(parsePyproject("").undeclared, true);
  assert.equal(parsePyproject("[project]\ndependencies = []").undeclared, undefined);
});

test("parsePyproject reports bad TOML with its line", () => {
  assert.match(parsePyproject("[project]\nname = \n").error, /^pyproject\.toml line \d+/);
});

test("parsePyproject treats __proto__ as a plain dependency name", () => {
  const { deps } = parsePyproject('[tool.poetry.dependencies]\n__proto__ = "1.0"\n');
  assert.deepEqual(deps, [{ name: "-proto-", constraint: "1.0", dev: false }]);
  assert.equal(Object.prototype.polluted, undefined);
});

// --- requirements.txt ----------------------------------------------------------

test("parseRequirements reads requirements and counts local, URL and included lines as skipped", () => {
  assert.deepEqual(parseRequirements(read("requirements", "requirements.txt")), {
    name: null,
    deps: [
      { name: "django", constraint: ">=4.2,<5", dev: false },
      { name: "requests", constraint: ">= 2.31", dev: false, extras: ["socks", "security"] },
      { name: "typing-extensions", constraint: "*", dev: false, marker: 'python_version < "3.10"' },
      { name: "zope-interface", constraint: "==6.1", dev: false },
      { name: "foo", constraint: "==${VERSION}", dev: false },
    ],
    skipped: [
      "other.txt",
      ".",
      "git+https://example.com/x.git#egg=foo",
      "mypkg @ https://example.com/mypkg-1.0.tar.gz",
      "https://example.com/bare-1.0.tar.gz",
      "./local/pkg",
      "dist/thing-1.0-py3-none-any.whl",
    ],
  });
});

test("parseRequirements truncates a long skipped line", () => {
  const { skipped } = parseRequirements(`-e git+https://example.com/${"x".repeat(100)}.git`);
  assert.equal(skipped[0].length, 60);
  assert.ok(skipped[0].endsWith("…"));
});

test("findManifest falls back to requirements.txt under the pyproject's name", async () => {
  const folder = join(fixtures, "requirements");
  const project = await findManifest(folder, "/nowhere", async (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } });
  assert.ok(project.path.endsWith("/requirements.txt"));
  assert.equal(project.name, "legacy-app");
  assert.equal(project.deps.length, 5);
});

// --- the lockfile strip --------------------------------------------------------

for (const [dir, file, packages] of [["uv", "uv.lock", uvPackages], ["poetry", "poetry.lock", poetryPackages]]) {
  test(`stripLockFiles leaves ${file} reading exactly as before, minus the file lists`, () => {
    const raw = read(dir, file), stripped = stripLockFiles(raw);
    assert.ok(stripped.length < raw.length);
    assert.doesNotMatch(stripped, /^\s*\{ ?(url|file) = /m);
    assert.doesNotMatch(stripped, /^sdist = /m);
    // Every package and every edge, not a count: a wrong drop would still parse.
    assert.deepEqual(packages(toml(stripped)), packages(toml(raw)));
  });
}

test("stripLockFiles keeps the empty arrays, so the lock still parses", () => {
  assert.equal(stripLockFiles('wheels = [\n    { url = "a" },\n]\nfiles = [\n    {file = "b"},\n]\n'), "wheels = [\n]\nfiles = [\n]\n");
});

test("stripLockFiles keeps a url line outside a wheels block and a single-line wheels array", () => {
  const outside = 'x = [\n    { url = "keep" },\n]\n';
  assert.equal(stripLockFiles(outside), outside);
  const inline = 'wheels = [{ url = "keep" }]\nname = "a"\n';
  assert.equal(stripLockFiles(inline), inline);
});

// --- uv.lock -------------------------------------------------------------------

test("uvResolver builds the tree from the project's own lock entry, one row per locked version", async () => {
  const tree = await uvTree();
  assert.equal(tree.note, null);
  assert.equal(countsLine(tree), "6 direct, 13 total");
  assert.deepEqual(summary(tree.roots), [
    ["httpx", "0.28.1", null, false],
    ["numpy", "2.0.2", "python_full_version < '3.10'", false],
    ["numpy", "2.2.6", "python_full_version >= '3.10'", false],
    ["pytest", "8.4.2", "python_full_version < '3.10'", true],
    ["pytest", "9.2.0", "python_full_version >= '3.10'", true],
    ["rich", "14.2.0", null, false],
  ]);
  assert.deepEqual(find(tree.roots, "httpx").extras, ["http2"]);
  assert.equal(find(tree.roots, "httpx").constraint, ">=0.27");
});

test("uvResolver follows an edge's extras into optional-dependencies", async () => {
  const tree = await uvTree();
  const httpx = find(tree.roots, "httpx");
  await expandNode(tree, httpx, [httpx.key]);
  assert.deepEqual(summary(httpx.children), [
    ["anyio", "4.12.1", "python_full_version < '3.10'", false],
    ["anyio", "4.16.0", "python_full_version >= '3.10'", false],
    ["certifi", "2026.10.23", null, false],
    ["h2", "4.3.0", "python_full_version < '3.10'", false],
    ["h2", "4.4.1", "python_full_version >= '3.10'", false],
    ["httpcore", "1.0.9", null, false],
    ["idna", "3.20", null, false],
  ]);
});

test("uvResolver resolves an unversioned edge to the only locked version, and a diamond under each parent", async () => {
  const tree = await uvTree();
  const httpx = find(tree.roots, "httpx");
  await expandNode(tree, httpx, [httpx.key]);
  const anyio = find(httpx.children, "anyio", "4.12.1"), httpcore = find(httpx.children, "httpcore");
  await expandNode(tree, anyio, [httpx.key, anyio.key]);
  assert.deepEqual(summary(anyio.children), [["idna", "3.20", "python_full_version < '3.10'", false]]);
  await expandNode(tree, httpcore, [httpx.key, httpcore.key]);
  assert.deepEqual(summary(httpcore.children), [["certifi", "2026.10.23", null, false]]);
  assert.ok(find(httpx.children, "certifi").leaf);
});

test("uvResolver shows an edge to a package the lock lacks as a leaf with its own version", async () => {
  const text = read("uv", "uv.lock").replace('{ name = "certifi" },\n]\nwheels', '{ name = "certifi" },\n    { name = "ghost", version = "1.0" },\n]\nwheels');
  const tree = await uvTree(uvProject(), text);
  const httpx = find(tree.roots, "httpx");
  await expandNode(tree, httpx, [httpx.key]);
  const httpcore = find(httpx.children, "httpcore");
  await expandNode(tree, httpcore, [httpx.key, httpcore.key]);
  const ghost = find(httpcore.children, "ghost");
  assert.equal(ghost.version, "1.0");
  assert.ok(ghost.leaf);
});

test("uvResolver finds the project by its one virtual package when the name doesn't match", () => {
  const project = { ...uvProject(), name: "renamed" };
  const made = uvResolver(read("uv", "uv.lock"), project);
  assert.equal(made.direct.length, 8); // httpx, numpy ×2, rich, pytest ×2 from each of two groups
  assert.ok(uvResolver(read("uv", "uv.lock"), { name: null, deps: [] }).direct);
});

test("uvResolver without a project entry resolves the manifest's directs by name", async () => {
  const text = read("uv", "uv.lock").replace('source = { virtual = "." }', 'source = { registry = "https://pypi.org/simple" }');
  const made = uvResolver(text, uvProject());
  assert.equal(made.direct, undefined);
  const tree = await uvTree(uvProject(), text);
  assert.deepEqual(summary(tree.roots), [
    ["httpx", "0.28.1", null, false],
    ["numpy", "2.0.2", null, false],
    ["pytest", "8.4.2", null, true],
    ["rich", "14.2.0", null, false],
  ]);
});

test("uvResolver calls a lock with no packages an error, which the tree shows as a note", async () => {
  assert.deepEqual(uvResolver("version = 1\n", uvProject()), { error: "no [[package]] entries with a name and version" });
  const tree = await uvTree(uvProject(), "version = 1\n");
  assert.match(tree.note, /^Couldn't read uv\.lock:/);
  assert.equal(tree.roots.length, 4);
});

test("a uv.lock that isn't TOML leaves the directs with a note", async () => {
  const tree = await uvTree(uvProject(), "[[package]\n");
  assert.match(tree.note, /^Couldn't read uv\.lock: line 1/);
  assert.deepEqual(tree.roots.map((n) => n.name), ["httpx", "numpy", "pytest", "rich"]);
});

test("with no lockfile the Python note shows and the directs have no version", async () => {
  const tree = await treeForProject(uvProject(), null, { noLockNote: PYTHON_NOTE });
  assert.equal(tree.note, PYTHON_NOTE);
  assert.deepEqual(tree.roots.map((n) => [n.name, n.version]), [["httpx", null], ["numpy", null], ["pytest", null], ["rich", null]]);
});

// --- poetry.lock ---------------------------------------------------------------

const poetryTree = () => treeForProject(parsePyproject(read("poetry", "pyproject.toml")), lock("poetry.lock", read("poetry", "poetry.lock")));

test("poetryResolver resolves the manifest's directs by normalized name", async () => {
  const tree = await poetryTree();
  assert.equal(tree.note, null);
  assert.equal(countsLine(tree), "5 direct, 9 total");
  assert.deepEqual(summary(tree.roots), [
    ["black", "24.10.0", null, true],
    ["click", "8.1.8", null, false],
    ["pytest", "8.3.5", null, true],
    ["pyyaml", "6.0.2", "sys_platform != 'win32'", false],
    ["requests", "2.32.3", null, false],
  ]);
});

test("poetryResolver reads string, table and array dependency forms with their markers", async () => {
  const tree = await poetryTree();
  const black = find(tree.roots, "black"), click = find(tree.roots, "click");
  await expandNode(tree, black, [black.key]);
  assert.deepEqual(summary(black.children), [["click", "8.1.8", null, false], ["tomli", "2.2.1", 'python_version < "3.11"', true]]);
  await expandNode(tree, click, [click.key]);
  assert.deepEqual(summary(click.children), [["colorama", "0.4.6", 'platform_system == "Windows"', false]]);
});

test("poetryResolver leaves an optional dependency out unless its extra is asked for", async () => {
  const { resolve } = poetryResolver(read("poetry", "poetry.lock"), null);
  assert.deepEqual(resolve({ name: "requests" }).children.map((e) => e.name), ["certifi", "idna"]);
  assert.deepEqual(resolve({ name: "requests", extras: ["use-chardet-on-py3"] }).children.map((e) => [e.name, e.constraint]),
    [["certifi", ">=2017.4.17"], ["idna", ">=2.5,<4"], ["chardet", ">=3.0.2,<6"]]);
  assert.deepEqual(resolve({ name: "requests", extras: ["socks"] }).children.at(-1),
    { name: "pysocks", constraint: ">=1.5.6,!=1.5.7", marker: 'python_version >= "3.7"' });
});

test("poetryResolver calls a lock with no packages an error", () => {
  assert.deepEqual(poetryResolver("[metadata]\nlock-version = \"2.1\"\n", null), { error: "no [[package]] entries with a name and version" });
});
