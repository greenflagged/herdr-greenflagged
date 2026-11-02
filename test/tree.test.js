import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK, MAX_LOCK_CHARS, MAX_TREE_NODES, MAX_WALK_POPS, MAX_WALK_VISITS, NO_LOCKFILE_NOTE, buildTree, countsLine, expandNode, expandPaths,
  directRoots, graphResolver, groupKey, keysOf, mergeDirect, nodeKey, pathOf, treeForProject, visibleRows,
} from "../mods/greenflagged/tree.js";

// A resolver over a plain graph: { name: { version, children: [edge] } }.
const over = (graph) => (edge) => graph[edge.name] ?? null;
const dep = (name, dev = false, extra = {}) => ({ name, constraint: "*", dev, ...extra });

// Runs `fn` with the resolver as given and with every answer wrapped in a Promise.
function each(name, fn) {
  test(`${name} (sync resolver)`, () => fn((resolve) => resolve));
  test(`${name} (async resolver)`, () => fn((resolve) => (edge) => Promise.resolve(resolve(edge))));
}

const find = (nodes, name) => nodes.find((n) => n.name === name);
// Tests write a path as its keys joined by " > "; the tree stores it as pathOf(keys).
const p = (readable) => pathOf(readable.split(" > "));
const readable = (path) => keysOf(path).join(" > ");
const rowAt = (tree, expanded, path) => visibleRows(tree, expanded).find((r) => r.path === p(path));

// Expands the node at `path` (unversioned graphs only).
async function open(tree, expanded, path) {
  const keys = path.split(" > ");
  let nodes = tree.roots, node;
  for (let i = 0; i < keys.length; i++) {
    node = nodes.find((n) => n.key === keys[i]);
    await expandNode(tree, node, keys.slice(0, i + 1));
    nodes = node.children;
  }
  expanded.add(p(path));
  return node;
}

const chain = (prefix, length) => {
  const graph = {};
  for (let i = 1; i <= length; i++) graph[`${prefix}${i}`] = { version: null, children: i < length ? [{ name: `${prefix}${i + 1}` }] : [] };
  return graph;
};

each("a diamond counts its shared package once and expands it under each parent", async (wrap) => {
  const graph = { a: { version: "1", children: [{ name: "c" }] }, b: { version: "1", children: [{ name: "c" }] }, c: { version: "1", children: [{ name: "d" }] }, d: { version: "1", children: [] } };
  const tree = await buildTree([dep("a"), dep("b")], wrap(over(graph)));
  assert.equal(tree.total, 4);
  assert.equal(countsLine(tree), "2 direct, 4 total");
  const expanded = new Set();
  await open(tree, expanded, "a@1");
  await open(tree, expanded, "b@1");
  const rows = visibleRows(tree, expanded).filter((r) => r.node.name === "c");
  assert.deepEqual(rows.map((r) => readable(r.path)), ["a@1 > c@1", "b@1 > c@1"]);
  assert.ok(rows.every((r) => r.expandable && !r.node.cycle));
  assert.notEqual(rows[0].node, rows[1].node);
  await open(tree, expanded, "b@1 > c@1");
  assert.ok(rowAt(tree, expanded, "b@1 > c@1 > d@1"));
  assert.equal(rowAt(tree, expanded, "a@1 > c@1 > d@1"), undefined);
});

each("a real cycle is cut and a shared dependency isn't", async (wrap) => {
  const graph = { a: { version: null, children: [{ name: "b" }] }, b: { version: null, children: [{ name: "a" }] } };
  const tree = await buildTree([dep("a")], wrap(over(graph)));
  assert.equal(tree.total, 2);
  const expanded = new Set();
  await open(tree, expanded, "a");
  await open(tree, expanded, "a > b");
  const inner = rowAt(tree, expanded, "a > b > a");
  assert.equal(inner.node.cycle, true);
  assert.equal(inner.node.leaf, true);
  assert.equal(inner.expandable, false);
  assert.deepEqual(inner.node.children, []);
  assert.equal(rowAt(tree, expanded, "a > b").node.cycle, false);
});

each("dev marking follows reachability", async (wrap) => {
  const graph = { x: { version: null, children: [{ name: "shared" }, { name: "devonly" }] }, y: { version: null, children: [{ name: "shared" }] }, shared: { version: null, children: [] }, devonly: { version: null, children: [] } };
  const tree = await buildTree([dep("x", true), dep("y")], wrap(over(graph)));
  const x = find(tree.roots, "x");
  assert.equal(x.dev, true);
  assert.equal(find(tree.roots, "y").dev, false);
  await expandNode(tree, x, ["x"]);
  assert.equal(find(x.children, "shared").dev, false);
  assert.equal(find(x.children, "devonly").dev, true);
});

each("with no lockfile the tree is the directs and dev is the manifest flag", async (wrap) => {
  const tree = await buildTree([dep("b", true), dep("a")], wrap(() => null));
  assert.deepEqual(tree.roots.map((n) => [n.name, n.dev, n.leaf]), [["a", false, true], ["b", true, true]]);
  assert.equal(tree.total, 2);
  assert.equal(countsLine(tree), "2 direct, 2 total");
});

each("a dev root reachable at runtime isn't dev", async (wrap) => {
  const graph = { a: { version: null, children: [{ name: "b" }] }, b: { version: null, children: [] } };
  const tree = await buildTree([dep("a"), dep("b", true)], wrap(over(graph)));
  assert.equal(find(tree.roots, "b").dev, false);
});

each("the cap never cuts the runtime walk", async (wrap) => {
  const tree = await buildTree([dep("r1")], wrap(over(chain("r", 50))), { cap: 10 });
  assert.equal(tree.total, 50);
  assert.equal(tree.capped, false);
  assert.equal(countsLine(tree), "1 direct, 50 total");
  let node = tree.roots[0];
  const keys = [node.key];
  while (!node.leaf) {
    await expandNode(tree, node, keys);
    node = node.children[0];
    keys.push(node.key);
  }
  assert.equal(node.name, "r50");
  assert.equal(node.dev, false);
});

each("the cap stops the dev-only walk", async (wrap) => {
  const tree = await buildTree([dep("d1", true)], wrap(over(chain("d", 50))), { cap: 10 });
  assert.equal(tree.total, 10);
  assert.equal(tree.capped, true);
  assert.equal(countsLine(tree), "1 direct, 10+ total");
});

each("a graph of exactly the cap isn't capped", async (wrap) => {
  const tree = await buildTree([dep("d1", true)], wrap(over(chain("d", 10))), { cap: 10 });
  assert.equal(tree.total, 10);
  assert.equal(tree.capped, false);
});

each("a capped total can exceed the cap", async (wrap) => {
  const graph = { ...chain("r", 15), ...chain("d", 10) };
  const tree = await buildTree([dep("r1"), dep("d1", true)], wrap(over(graph)), { cap: 10 });
  assert.equal(tree.capped, true);
  assert.equal(tree.total, 16); // 15 runtime plus the dev root, counted before either walk
  assert.equal(countsLine(tree), "2 direct, 16+ total");
});

each("the roots are counted whatever the cap", async (wrap) => {
  const tree = await buildTree([dep("a"), dep("b", true), dep("c", true)], wrap(() => null), { cap: 1 });
  assert.equal(tree.total, 3);
  assert.equal(tree.capped, false);
});

each("directs that resolve to one key become one root", async (wrap) => {
  const resolve = (e) => ({ version: "1", children: e.extras?.includes("bar") ? [{ name: "extra" }] : [{ name: "base" }] });
  const tree = await buildTree([dep("foo"), dep("foo", true, { extras: ["bar"] })], wrap(resolve));
  assert.equal(tree.roots.length, 1);
  const [root] = tree.roots;
  assert.deepEqual(root.extras, ["bar"]);
  assert.equal(root.dev, false);
  assert.deepEqual(root.childEdges.map((e) => e.name).sort(), ["base", "extra"]);
  assert.deepEqual(visibleRows(tree, new Set()).map((r) => readable(r.path)), ["foo@1"]);
});

each("a package's children follow the edge that reached it", async (wrap) => {
  const graph = {
    a: { version: null, children: [{ name: "httpx" }] },
    b: { version: null, children: [{ name: "httpx", extras: ["socks"] }] },
    socksio: { version: null, children: [] },
  };
  const resolve = (e) => e.name === "httpx"
    ? { version: "0.27", children: e.extras?.includes("socks") ? [{ name: "socksio" }] : [] }
    : graph[e.name] ?? null;
  for (const order of [[dep("a"), dep("b")], [dep("b"), dep("a")]]) {
    const tree = await buildTree(order, wrap(resolve));
    assert.equal(tree.total, 4);
    assert.ok(tree.runtime.has("socksio"));
  }
  const tree = await buildTree([dep("a", true), dep("b")], wrap(resolve));
  const expanded = new Set();
  await open(tree, expanded, "a");
  await open(tree, expanded, "b");
  await open(tree, expanded, "b > httpx@0.27");
  const socksio = rowAt(tree, expanded, "b > httpx@0.27 > socksio");
  assert.ok(socksio);
  assert.equal(socksio.node.dev, false);
  assert.equal(rowAt(tree, expanded, "a > httpx@0.27").node.leaf, true);
});

each("siblings that resolve to one key become one row", async (wrap) => {
  const graph = {
    foo: { version: null, children: [{ name: "bar" }, { name: "bar", extras: ["y"] }] },
    bar: { version: "2", children: [] },
  };
  const resolve = (e) => e.name === "bar" ? { version: "2", children: e.extras?.includes("y") ? [{ name: "why" }] : [{ name: "base" }] } : graph[e.name] ?? null;
  const tree = await buildTree([dep("foo")], wrap(resolve));
  await expandNode(tree, tree.roots[0], ["foo"]);
  const bars = tree.roots[0].children.filter((n) => n.name === "bar");
  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0].extras, ["y"]);
  assert.deepEqual(bars[0].childEdges.map((e) => e.name).sort(), ["base", "why"]);
});

test("a declined count resolves only what is opened", async () => {
  const graph = { a: { version: null, children: [{ name: "b" }, { name: "c" }] }, b: { version: null, children: [{ name: "d" }] }, c: { version: null, children: [] }, d: { version: null, children: [] } };
  const calls = [];
  const spy = (e) => { calls.push(e.name); return graph[e.name] ?? null; };
  const tree = await buildTree([dep("a")], { resolve: spy, count: false });
  assert.deepEqual(calls, ["a"]);
  await expandNode(tree, tree.roots[0], ["a"]);
  assert.deepEqual(calls.sort(), ["a", "b", "c"]);
  const expanded = new Set([p("a")]);
  visibleRows(tree, expanded);
  visibleRows(tree, expanded);
  await expandNode(tree, tree.roots[0], ["a"]);
  assert.equal(calls.length, 3);
});

test("a counted tree resolves each distinct edge once", async () => {
  const graph = { a: { version: null, children: [{ name: "c" }] }, b: { version: null, children: [{ name: "c" }] }, c: { version: null, children: [{ name: "d" }] }, d: { version: null, children: [] } };
  const calls = [];
  const tree = await buildTree([dep("a"), dep("b")], (e) => { calls.push(e.name); return graph[e.name] ?? null; });
  const expanded = new Set();
  await open(tree, expanded, "a > c");
  await open(tree, expanded, "b > c");
  assert.deepEqual(calls.sort(), ["a", "b", "c", "d"]);
});

test("a declined count tags only dev roots", async () => {
  const graph = { r: { version: null, children: [{ name: "s" }] }, d: { version: null, children: [{ name: "s" }] }, s: { version: null, children: [] } };
  const tree = await buildTree([dep("r"), dep("d", true)], { resolve: over(graph), count: false });
  assert.equal(tree.total, null);
  assert.equal(tree.runtime, null);
  assert.equal(countsLine(tree), "2 direct");
  const d = find(tree.roots, "d"), r = find(tree.roots, "r");
  assert.equal(d.dev, true);
  assert.equal(r.dev, false);
  await expandNode(tree, d, ["d"]);
  await expandNode(tree, r, ["r"]);
  assert.equal(d.children[0].dev, false);
  assert.equal(r.children[0].dev, false);
});

test("a resolver that throws or rejects fails the build", async () => {
  await assert.rejects(buildTree([dep("a")], () => { throw new Error("bad lock"); }), /bad lock/);
  await assert.rejects(buildTree([dep("a")], () => Promise.reject(new Error("bad read"))), /bad read/);
  const graph = { a: { version: null, children: [{ name: "b" }] } };
  await assert.rejects(buildTree([dep("a")], (e) => { if (e.name === "b") throw new Error("deep"); return graph[e.name]; }), /deep/);
});

test("a failed expansion can be retried", async () => {
  let failures = 1;
  const graph = { a: { version: null, children: [{ name: "c" }] }, c: { version: null, children: [] } };
  const resolve = (e) => {
    if (e.name === "c" && failures-- > 0) return Promise.reject(new Error("read failed"));
    return Promise.resolve(graph[e.name] ?? null);
  };
  const tree = await buildTree([dep("a")], { resolve, count: false });
  const root = tree.roots[0];
  const first = expandNode(tree, root, ["a"]);
  assert.equal(root.loading, true);
  assert.equal(expandNode(tree, root, ["a"]), first);
  await assert.rejects(first, /read failed/);
  assert.equal(root.loading, false);
  assert.equal(root.children, null);
  await expandNode(tree, root, ["a"]);
  assert.equal(root.loading, false);
  assert.deepEqual(root.children.map((n) => n.name), ["c"]);
});

test("pause is called per chunk of edge pops", async () => {
  let pauses = 0;
  const plain = await buildTree([dep("n1")], over(chain("n", 600)));
  const paused = await buildTree([dep("n1")], over(chain("n", 600)), { pause: () => { pauses++; } });
  assert.ok(pauses >= 2);
  assert.equal(paused.total, plain.total);

  const names = ["p", "q", "r", "s"], graph = {};
  for (const name of names) {
    const others = names.filter((n) => n !== name).map((n) => ({ name: n }));
    graph[name] = { version: null, children: Array.from({ length: 50 }, () => others).flat() };
  }
  // A root's own edges are deduped when it is built, so the dense part sits below it.
  graph.top = { version: null, children: [{ name: "p" }] };
  let densePauses = 0;
  const dense = await buildTree([dep("top")], over(graph), { pause: async () => { densePauses++; } });
  assert.equal(dense.total, 5);
  assert.ok(densePauses >= 2, `${densePauses} pauses for ${1 + 4 * 150} pops with CHUNK ${CHUNK}`);
});

test("expandPaths reopens saved rows after a rebuild and drops stale ones", async () => {
  const graph = (cVersion) => ({ a: { version: null, children: [{ name: "c" }] }, c: { version: cVersion, children: [{ name: "d" }] }, d: { version: null, children: [] } });
  const tree1 = await buildTree([dep("a")], over(graph("1")));
  const expanded = new Set();
  await open(tree1, expanded, "a");
  await open(tree1, expanded, "a > c@1");

  const tree2 = await buildTree([dep("a")], over(graph("1")));
  await expandPaths(tree2, expanded);
  assert.ok(rowAt(tree2, expanded, "a > c@1 > d"));

  const tree3 = await buildTree([dep("a")], over(graph("2")));
  await expandPaths(tree3, expanded);
  assert.deepEqual([...expanded].map(readable), ["a"]);
  const rows = visibleRows(tree3, expanded);
  assert.deepEqual(rows.map((r) => [readable(r.path), r.open]), [["a", true], ["a > c@2", false]]);
});

test("expandPaths builds a parent the saved set doesn't list", async () => {
  const graph = { a: { version: null, children: [{ name: "c" }] }, c: { version: null, children: [{ name: "d" }] }, d: { version: null, children: [] } };
  const tree = await buildTree([dep("a")], over(graph));
  const expanded = new Set([p("a > c")]);
  await expandPaths(tree, expanded);
  assert.deepEqual([...expanded].map(readable), ["a > c"]);
  assert.ok(tree.roots[0].children[0].children);
  expanded.add(p("a"));
  assert.ok(rowAt(tree, expanded, "a > c > d"));
});

test("a direct missing from the lock is a leaf that keeps its constraint", async () => {
  const tree = await buildTree([{ name: "gone", constraint: "^1.2", dev: false }], () => null);
  assert.deepEqual(
    [tree.roots[0].version, tree.roots[0].constraint, tree.roots[0].leaf],
    [null, "^1.2", true],
  );
});

test("rows are sorted by name with depth, open state and paths", async () => {
  const graph = { b: { version: "2", children: [{ name: "z" }, { name: "y" }] }, a: { version: "1", children: [] }, y: { version: null, children: [] }, z: { version: null, children: [] } };
  const tree = await buildTree([dep("b"), dep("a")], over(graph));
  const expanded = new Set();
  await open(tree, expanded, "b@2");
  assert.deepEqual(visibleRows(tree, expanded).map((r) => [readable(r.path), r.depth, r.open, r.expandable]), [
    ["a@1", 0, false, false],
    ["b@2", 0, true, true],
    ["b@2 > y", 1, false, false],
    ["b@2 > z", 1, false, false],
  ]);
});

test("constants and keys", () => {
  assert.equal(MAX_TREE_NODES, 2000);
  assert.equal(MAX_WALK_VISITS, 10 * MAX_TREE_NODES);
  assert.equal(MAX_WALK_POPS, 100 * MAX_TREE_NODES);
  assert.equal(nodeKey("a", "1.0"), "a@1.0");
  assert.equal(nodeKey("a", null), "a");
});

test("a name holding ' > ' keeps its own path", async () => {
  const graph = { "a > b": { version: null, children: [{ name: "x" }] }, a: { version: null, children: [{ name: "b" }] }, b: { version: null, children: [{ name: "y" }] }, x: { version: null, children: [] }, y: { version: null, children: [] } };
  const tree = await buildTree([dep("a > b"), dep("a")], over(graph));
  const weird = find(tree.roots, "a > b");
  await expandNode(tree, weird, ["a > b"]);
  const expanded = new Set([pathOf(["a > b"])]);
  const rebuilt = await buildTree([dep("a > b"), dep("a")], over(graph));
  await expandPaths(rebuilt, expanded);
  assert.deepEqual([...expanded], [pathOf(["a > b"])]);
  assert.deepEqual(find(rebuilt.roots, "a > b").children.map((n) => n.name), ["x"]);
  assert.equal(find(rebuilt.roots, "a").children, null);
});

test("expandPaths keeps reopening after one path fails, then throws", async () => {
  const graph = { a: { version: null, children: [{ name: "bad" }] }, b: { version: null, children: [{ name: "c" }] }, bad: { version: null, children: [] }, c: { version: null, children: [] } };
  const resolve = (e) => (e.name === "bad" ? Promise.reject(new Error("read failed")) : graph[e.name] ?? null);
  const tree = await buildTree([dep("a"), dep("b")], { resolve, count: false });
  const expanded = new Set([p("a"), p("b")]);
  await assert.rejects(expandPaths(tree, expanded), /read failed/);
  assert.deepEqual([...expanded].map(readable), ["b"]);
  assert.equal(find(tree.roots, "a").children, null);
  assert.deepEqual(find(tree.roots, "b").children.map((n) => n.name), ["c"]);
});

test("expandPaths drops a saved path that isn't a key array", async () => {
  const tree = await buildTree([dep("a")], over({ a: { version: null, children: [{ name: "b" }] } }));
  const expanded = new Set(["a > b", "[]"]);
  await expandPaths(tree, expanded);
  assert.equal(expanded.size, 0);
});

each("the hard ceiling on visits stops both walks and marks the total capped", async (wrap) => {
  const tree = await buildTree([dep("r1")], wrap(over(chain("r", 50))), { maxVisits: 10 });
  assert.equal(tree.capped, true);
  assert.equal(tree.total, 10);
  assert.equal(countsLine(tree), "1 direct, 10+ total");
});

each("the hard ceiling on pops stops a dense walk", async (wrap) => {
  const names = ["p", "q", "r"], graph = {};
  for (const name of names) graph[name] = { version: null, children: Array.from({ length: 100 }, () => names.map((n) => ({ name: n }))).flat() };
  const tree = await buildTree([dep("p")], wrap(over(graph)), { maxPops: 50 });
  assert.equal(tree.capped, true);
  assert.ok(tree.total <= 3);
});

// treeForProject is the glue main.js calls once it has read a lockfile.
const project = (deps) => ({ deps });
const lockOf = (resolver, text = "lock") => ({ file: "x.lock", text, resolver });

test("treeForProject with no lockfile shows the directs and the no-lockfile note", async () => {
  const tree = await treeForProject(project([dep("a"), dep("b", true)]), null);
  assert.equal(tree.note, NO_LOCKFILE_NOTE);
  assert.equal(tree.lockFile, null);
  assert.deepEqual(tree.roots.map((n) => n.name), ["a", "b"]);
  assert.equal((await treeForProject(project([dep("a")]), null, { noLockNote: "own note" })).note, "own note");
});

test("treeForProject walks the lockfile's resolver", async () => {
  const graph = { a: { version: "1", children: [{ name: "c" }] }, c: { version: "2", children: [] } };
  const seen = [];
  const tree = await treeForProject(project([dep("a")]), lockOf((text, proj) => { seen.push(text, proj.deps.length); return { resolve: over(graph) }; }));
  assert.deepEqual(seen, ["lock", 1]);
  assert.equal(tree.note, null);
  assert.equal(tree.lockFile, "x.lock");
  assert.equal(countsLine(tree), "1 direct, 2 total");
});

test("treeForProject falls back to the directs with a note when the lockfile fails", async () => {
  const cases = [
    [() => ({ error: "bad header" }), /^Couldn't read x\.lock: bad header$/],
    [() => { throw new Error("boom"); }, /^Couldn't read x\.lock: boom$/],
    [() => ({ resolve: () => { throw new Error("deep"); } }), /^Couldn't read x\.lock: deep$/],
    [() => null, /^Couldn't read x\.lock: its resolver returned nothing$/],
    [() => undefined, /^Couldn't read x\.lock: its resolver returned nothing$/],
  ];
  for (const [resolver, note] of cases) {
    const tree = await treeForProject(project([dep("a")]), lockOf(resolver));
    assert.match(tree.note, note);
    assert.deepEqual(tree.roots.map((n) => [n.name, n.leaf]), [["a", true]]);
  }
});

test("treeForProject doesn't parse a lockfile over the size bound", async () => {
  let called = false;
  const tree = await treeForProject(project([dep("a")]), lockOf(() => { called = true; return { resolve: () => null }; }, "x".repeat(MAX_LOCK_CHARS + 1)));
  assert.equal(called, false);
  assert.equal(tree.note, "x.lock is too large to parse, so only direct dependencies are shown.");
});

test("treeForProject reopens saved rows, and a stale build leaves them alone", async () => {
  const graph = { a: { version: null, children: [{ name: "c" }] }, c: { version: null, children: [] } };
  const expanded = new Set([p("a"), p("gone")]);
  assert.equal(await treeForProject(project([dep("a")]), lockOf(() => ({ resolve: over(graph) })), { expanded, stale: () => true }), null);
  assert.equal(expanded.size, 2);
  const tree = await treeForProject(project([dep("a")]), lockOf(() => ({ resolve: over(graph) })), { expanded });
  assert.deepEqual([...expanded].map(readable), ["a"]);
  assert.deepEqual(tree.roots[0].children.map((n) => n.name), ["c"]);
});

// --- graphResolver and mergeDirect ---------------------------------------------

const pkg = (name, version, dependencies = [], optional = {}) => ({ name, version, dependencies, optionalDependencies: new Map(Object.entries(optional)) });

test("graphResolver finds name@version, and the first of a name in list order for an unversioned edge", () => {
  const { resolve } = graphResolver([pkg("a", "1.0"), pkg("a", "2.0"), pkg("b", "1.0")]);
  assert.equal(resolve({ name: "a", version: "2.0" }).version, "2.0");
  assert.equal(resolve({ name: "a" }).version, "1.0");
  assert.equal(resolve({ name: "a", version: "3.0" }), null);
  assert.equal(resolve({ name: "missing" }), null);
});

test("graphResolver fills a child's version only when one version of it is locked", () => {
  const { resolve } = graphResolver([pkg("root", "1", [{ name: "one" }, { name: "two" }]), pkg("one", "1.5"), pkg("two", "1"), pkg("two", "2")]);
  assert.deepEqual(resolve({ name: "root" }).children, [{ name: "one", version: "1.5" }, { name: "two" }]);
});

test("graphResolver adds the optional dependencies an edge's extras ask for", () => {
  const { resolve } = graphResolver([pkg("a", "1", [{ name: "b" }], { fast: [{ name: "c" }], other: [{ name: "d" }] }), pkg("b", "1"), pkg("c", "1")]);
  assert.deepEqual(resolve({ name: "a" }).children.map((e) => e.name), ["b"]);
  assert.deepEqual(resolve({ name: "a", extras: ["fast"] }).children.map((e) => e.name), ["b", "c"]);
});

test("mergeDirect takes the constraint and extras from the manifest and dev from the lock row", () => {
  const manifest = [{ name: "a", constraint: ">=1", dev: true, extras: ["x"] }, { name: "gone", constraint: "*", dev: false }];
  assert.deepEqual(mergeDirect(manifest, [{ name: "a", version: "1.0", marker: "m", dev: false }, { name: "b", version: "2.0", extras: ["y"], dev: true }]), [
    { name: "a", version: "1.0", constraint: ">=1", marker: "m", extras: ["x"], dev: false },
    { name: "b", version: "2.0", constraint: null, marker: null, extras: ["y"], dev: true },
    { name: "gone", constraint: "*", dev: false },
  ]);
});

each("a package under both dependencies and a dev group is one runtime row", async (wrap) => {
  const direct = mergeDirect([], [{ name: "a", version: "1", dev: true }, { name: "a", version: "1", dev: false }]);
  const tree = await buildTree(direct, wrap(() => ({ version: "1", children: [] })));
  assert.equal(countsLine(tree), "1 direct, 1 total");
  assert.equal(tree.roots[0].dev, false);
});

each("a row keeps the first marker among its edges, on roots and children", async (wrap) => {
  const graph = { p: { version: "1", children: [{ name: "c", version: "1", constraint: ">=1", marker: "first" }, { name: "c", version: "1", constraint: "<2", marker: "second" }] } };
  const tree = await buildTree([
    { name: "p", version: "1", constraint: "*", dev: false },
    { name: "p", version: "1", constraint: ">=0", dev: false, marker: "late" },
  ], wrap((edge) => graph[edge.name] ?? { version: edge.version, children: [] }));
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].marker, "late");
  await expandNode(tree, tree.roots[0], [tree.roots[0].key]);
  assert.deepEqual(tree.roots[0].children.map((n) => [n.key, n.marker]), [["c@1", "first"]]);
});

each("child edges that differ only in marker keep the first non-null marker", async (wrap) => {
  const graph = { p: { version: "1", children: [
    { name: "c", version: "1", constraint: ">=1" },
    { name: "c", version: "1", constraint: ">=1", marker: "first" },
    { name: "c", version: "1", constraint: ">=1", marker: "last" },
  ] } };
  const tree = await buildTree([{ name: "p", version: "1", constraint: "*", dev: false }], wrap((edge) => graph[edge.name] ?? { version: edge.version, children: [] }));
  await expandNode(tree, tree.roots[0], [tree.roots[0].key]);
  assert.deepEqual(tree.roots[0].children.map((n) => [n.key, n.marker]), [["c@1", "first"]]);
});

test("treeForProject builds from a resolver's direct list when it has one", async () => {
  const project = { deps: [dep("a")] };
  const resolver = () => ({ resolve: () => null, direct: [{ name: "a", version: "1", constraint: "*", dev: false }, { name: "a", version: "2", constraint: "*", dev: false }] });
  const tree = await treeForProject(project, { file: "x.lock", text: "", resolver });
  assert.deepEqual(tree.roots.map((n) => n.key), ["a@1", "a@2"]);
  const plain = await treeForProject(project, { file: "x.lock", text: "", resolver: () => ({ resolve: () => null }) });
  assert.deepEqual(plain.roots.map((n) => n.key), ["a"]);
  const bare = await treeForProject(project, { file: "x.lock", text: "", resolver: () => () => ({ version: "3", children: [] }) });
  assert.deepEqual(bare.roots.map((n) => n.key), ["a@3"]);
});

// --- group directs (Go's "indirect" row) ------------------------------------------

each("a versioned direct whose resolve is null keeps its version as a plain leaf", async (wrap) => {
  const tree = await buildTree([{ name: "m", version: "v1.2.0", constraint: "v1.0.0", dev: false }], wrap(() => null));
  const [node] = tree.roots;
  assert.deepEqual([node.key, node.version, node.constraint, node.leaf], ["m@v1.2.0", "v1.2.0", "v1.0.0", true]);
  assert.equal(node.marker, null);
  assert.equal(node.dev, false);
  assert.equal(node.cycle, false);
});

const indirectGroup = { name: "indirect", version: null, constraint: null, dev: false, group: true };
const grouped = (graph) => (edge) => (edge.group === true ? { version: null, children: [{ name: "i1", version: "1" }, { name: "i2", version: "1" }] } : graph[edge.name] ?? null);

each("a group direct is keyed apart, sorts last, isn't counted and never gets dev", async (wrap) => {
  const tree = await buildTree([indirectGroup, dep("z", true), dep("a", true)], wrap(grouped({})));
  assert.deepEqual(tree.roots.map((n) => n.key), ["a", "z", groupKey("indirect")]);
  const group = tree.roots.at(-1);
  assert.deepEqual([group.group, group.dev, group.leaf], [true, false, false]);
  assert.deepEqual(directRoots(tree).map((n) => n.name), ["a", "z"]);
  assert.equal(countsLine(tree), "2 direct, 4 total");
  await expandNode(tree, group, [group.key]);
  assert.deepEqual(group.children.map((n) => [n.key, n.dev, n.group]), [["i1@1", false, false], ["i2@1", false, false]]);
});

each("a group alone is not dev, and its children are counted", async (wrap) => {
  const tree = await buildTree([indirectGroup], wrap(grouped({})));
  assert.equal(tree.roots[0].dev, false);
  assert.equal(countsLine(tree), "0 direct, 2 total");
});

test("expandPaths reopens a group by its reserved key", async () => {
  const tree = await buildTree([dep("a"), indirectGroup], grouped({}));
  const expanded = new Set([pathOf([groupKey("indirect")])]);
  await expandPaths(tree, expanded);
  assert.equal(tree.roots.at(-1).children.length, 2);
  assert.equal(expanded.size, 1);
  assert.equal(keysOf([...expanded][0])[0], groupKey("indirect"));
  assert.ok(!/\u0000/.test([...expanded][0]), "a path is plain ASCII");
});

each("a package named like the group is its own row, even unversioned", async (wrap) => {
  const tree = await buildTree([indirectGroup, dep("indirect")], wrap(grouped({})));
  assert.deepEqual(tree.roots.map((n) => [n.key, n.group, n.leaf, n.childEdges.length]), [
    ["indirect", false, true, 0], [groupKey("indirect"), true, false, 2],
  ]);
  assert.equal(countsLine(tree), "1 direct, 3 total");
});

// --- deferred children (`load`) --------------------------------------------------

// A lazy resolver: every package is deferred, and `load` answers from `graph`
// ({ name: { children, tag? } }), recording each call. `fail` names packages whose
// load rejects until it is cleared.
function lazy(graph, { fail = new Set(), extra = {} } = {}) {
  const loads = [];
  const resolver = {
    resolve: (edge) => ({ version: edge.version ?? null, deferred: true }),
    load: async (edge) => {
      loads.push(`${edge.name}@${edge.version}`);
      if (fail.has(edge.name)) throw new Error(`can't read ${edge.name}`);
      return graph[edge.name] ?? { children: [] };
    },
    count: false,
    ...extra,
  };
  return { resolver, loads };
}
const v1 = (name) => ({ name, version: "v1" });

test("a deferred node is expandable, and load isn't called until it is expanded", async () => {
  const { resolver, loads } = lazy({ a: { children: [v1("b")] } });
  const tree = await buildTree([dep("a", false, { version: "v1" })], resolver);
  const a = tree.roots[0];
  assert.equal(a.leaf, false);
  assert.deepEqual(a.childEdges, []);
  assert.deepEqual(loads, []);
  assert.deepEqual(visibleRows(tree, new Set()).map((r) => r.expandable), [true]);
  await expandNode(tree, a, [a.key]);
  assert.deepEqual(loads, ["a@v1"]);
  assert.deepEqual(a.children.map((n) => [n.name, n.version, n.leaf, n.dev]), [["b", "v1", false, false]]);
});

test("a load with no children makes the node a leaf carrying its tag", async () => {
  const { resolver } = lazy({ a: { children: [], tag: "not downloaded" }, b: { children: [] } });
  const tree = await buildTree([dep("a", false, { version: "v1" }), dep("b", false, { version: "v1" })], resolver);
  const [a, b] = tree.roots;
  await expandNode(tree, a, [a.key]);
  await expandNode(tree, b, [b.key]);
  assert.deepEqual([a.leaf, a.tag, a.children], [true, "not downloaded", []]);
  assert.deepEqual([b.leaf, b.tag], [true, null]);
  assert.deepEqual(visibleRows(tree, new Set([pathOf([a.key])])).map((r) => r.expandable), [false, false]);
});

test("a load rejection puts the node back to unbuilt, and a retry loads again", async () => {
  const fail = new Set(["a"]);
  const { resolver, loads } = lazy({ a: { children: [v1("b")] } }, { fail });
  const tree = await buildTree([dep("a", false, { version: "v1" })], resolver);
  const a = tree.roots[0];
  await assert.rejects(expandNode(tree, a, [a.key]), /can't read a/);
  assert.deepEqual([a.children, a.loading, a.pending, a.leaf], [null, false, null, false]);
  fail.clear();
  await expandNode(tree, a, [a.key]);
  assert.deepEqual(a.children.map((n) => n.name), ["b"]);
  assert.deepEqual(loads, ["a@v1", "a@v1"]);
});

test("load is memoized per name@version across two parents", async () => {
  const { resolver, loads } = lazy({ a: { children: [v1("c")] }, b: { children: [v1("c")] }, c: { children: [v1("d")] } });
  const tree = await buildTree([dep("a", false, { version: "v1" }), dep("b", false, { version: "v1" })], resolver);
  const [a, b] = tree.roots;
  await expandNode(tree, a, [a.key]);
  await expandNode(tree, b, [b.key]);
  await expandNode(tree, a.children[0], [a.key, "c@v1"]);
  await expandNode(tree, b.children[0], [b.key, "c@v1"]);
  assert.deepEqual(loads, ["a@v1", "b@v1", "c@v1"]);
  assert.deepEqual(b.children[0].children.map((n) => n.name), ["d"]);
});

test("a deferred cycle draws as a leaf with (cycle)", async () => {
  const { resolver, loads } = lazy({ a: { children: [v1("b")] }, b: { children: [v1("a")] } });
  const tree = await buildTree([dep("a", false, { version: "v1" })], resolver);
  const a = tree.roots[0];
  await expandNode(tree, a, [a.key]);
  const b = a.children[0];
  await expandNode(tree, b, [a.key, b.key]);
  assert.deepEqual(b.children.map((n) => [n.name, n.cycle, n.leaf]), [["a", true, true]]);
  assert.deepEqual(loads, ["a@v1", "b@v1"]);
});

test("resolver.total is the M of a resolver that doesn't count", async () => {
  const { resolver } = lazy({}, { extra: { total: 7 } });
  const tree = await buildTree([dep("a", false, { version: "v1" })], resolver);
  assert.equal(countsLine(tree), "1 direct, 7 total");
  const { resolver: none } = lazy({});
  assert.equal(countsLine(await buildTree([dep("a")], none)), "1 direct");
});

test("treeForProject takes an async resolver; its note lands on the tree, and lazy follows load", async () => {
  const { resolver } = lazy({ a: { children: [v1("b")] } }, { extra: { direct: [dep("a", false, { version: "v1" })], note: "a note" } });
  let given;
  const lock = { file: "x.lock", text: "", resolver: async (_text, _project, cache) => { given = cache; return resolver; } };
  const tree = await treeForProject(project([dep("a")]), lock, { cache: "the cache" });
  assert.equal(given, "the cache");
  assert.equal(tree.note, "a note");
  assert.equal(tree.lazy, true);
  assert.equal(tree.cacheBacked, false);
  const plain = await treeForProject(project([dep("a")]), { file: "x.lock", text: "", resolver: () => over({}) });
  assert.equal(plain.lazy, false);
  assert.equal(plain.note, null);
});

test("cacheBacked follows the lockfile's cache declaration on every tree, failures included", async () => {
  const declared = (resolver) => ({ file: "x.lock", text: "", resolver, cache: { locate: [] } });
  const ok = await treeForProject(project([dep("a")]), declared(async () => ({ resolve: () => null, note: "flat" })), { cache: null });
  assert.equal(ok.cacheBacked, true);
  assert.equal(ok.lazy, false);
  const rejected = await treeForProject(project([dep("a")]), declared(async () => { throw new Error("boom"); }));
  assert.equal(rejected.cacheBacked, true);
  assert.match(rejected.note, /boom/);
  const errored = await treeForProject(project([dep("a")]), declared(() => ({ error: "bad" })));
  assert.equal(errored.cacheBacked, true);
  const big = await treeForProject(project([dep("a")]), { ...declared(() => null), text: "x".repeat(MAX_LOCK_CHARS + 1) });
  assert.equal(big.cacheBacked, true);
  assert.equal((await treeForProject(project([dep("a")]), null)).cacheBacked, false);
});

test("expandPaths reopens a deferred path after a rebuild", async () => {
  const { resolver, loads } = lazy({ a: { children: [v1("b")] }, b: { children: [v1("c")] } });
  const lock = { file: "x.lock", text: "", resolver: () => ({ ...resolver, direct: [dep("a", false, { version: "v1" })] }) };
  const expanded = new Set([pathOf(["a@v1"]), pathOf(["a@v1", "b@v1"])]);
  const tree = await treeForProject(project([dep("a")]), lock, { expanded });
  assert.deepEqual(visibleRows(tree, expanded).map((r) => r.node.name), ["a", "b", "c"]);
  assert.deepEqual(loads, ["a@v1", "b@v1"]);
  assert.equal(expanded.size, 2);
});

test("a plain resolver's tree has no deferred node, no tag and no load", async () => {
  const graph = { a: { version: "1", children: [{ name: "b" }] }, b: { version: "2", children: [] } };
  const tree = await buildTree([dep("a")], over(graph));
  assert.equal(tree.load, null);
  assert.equal(countsLine(tree), "1 direct, 2 total");
  const a = tree.roots[0];
  assert.deepEqual([a.deferred, a.tag, a.leaf], [false, null, false]);
  await expandNode(tree, a, [a.key]);
  assert.deepEqual(a.children.map((n) => [n.name, n.version, n.leaf, n.deferred, n.tag]), [["b", "2", true, false, null]]);
});
