import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK, MAX_TREE_NODES, PATH_SEP, buildTree, countsLine, expandNode, expandPaths, nodeKey, visibleRows,
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
const rowAt = (tree, expanded, path) => visibleRows(tree, expanded).find((r) => r.path === path);

// Expands the node at `path` (names joined by PATH_SEP, unversioned graphs only).
async function open(tree, expanded, path) {
  const keys = path.split(PATH_SEP);
  let nodes = tree.roots, node;
  for (let i = 0; i < keys.length; i++) {
    node = nodes.find((n) => n.key === keys[i]);
    await expandNode(tree, node, keys.slice(0, i + 1));
    nodes = node.children;
  }
  expanded.add(path);
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
  assert.deepEqual(rows.map((r) => r.path), ["a@1 > c@1", "b@1 > c@1"]);
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
  assert.deepEqual(visibleRows(tree, new Set()).map((r) => r.path), ["foo@1"]);
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
  const expanded = new Set(["a"]);
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
  assert.deepEqual([...expanded], ["a"]);
  const rows = visibleRows(tree3, expanded);
  assert.deepEqual(rows.map((r) => [r.path, r.open]), [["a", true], ["a > c@2", false]]);
});

test("expandPaths builds a parent the saved set doesn't list", async () => {
  const graph = { a: { version: null, children: [{ name: "c" }] }, c: { version: null, children: [{ name: "d" }] }, d: { version: null, children: [] } };
  const tree = await buildTree([dep("a")], over(graph));
  const expanded = new Set(["a > c"]);
  await expandPaths(tree, expanded);
  assert.deepEqual([...expanded], ["a > c"]);
  assert.ok(tree.roots[0].children[0].children);
  expanded.add("a");
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
  assert.deepEqual(visibleRows(tree, expanded).map((r) => [r.path, r.depth, r.open, r.expandable]), [
    ["a@1", 0, false, false],
    ["b@2", 0, true, true],
    ["b@2 > y", 1, false, false],
    ["b@2 > z", 1, false, false],
  ]);
});

test("constants and keys", () => {
  assert.equal(MAX_TREE_NODES, 2000);
  assert.equal(PATH_SEP, " > ");
  assert.equal(nodeKey("a", "1.0"), "a@1.0");
  assert.equal(nodeKey("a", null), "a");
});
