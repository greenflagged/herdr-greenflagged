// A project's dependencies as a plain tree, for languages Greenflagged can't
// check. Plain data in and out, with no Herdr imports and no knowledge of any
// language, so `npm test` can run it under Node without the app.
//
// direct:     [{ name, constraint, dev, version?, extras? }]   an ecosystem's `parse` output
// edge:       { name, version?, constraint?, extras? }         what a resolver hands back as children
// resolve:    (edge) -> Resolution | null, or a Promise of one
// Resolution: { version: string | null, children: edge[] }
// resolver:   resolve, or { resolve, count?: boolean }; `count: false` skips the count walk
//
// A node is built only when its parent is expanded, so a package several others
// depend on costs nothing until someone opens it under each of them.

export const MAX_TREE_NODES = 2000; // unique packages the dev-only walk may add before it stops
export const CHUNK = 250; // edge pops (work-queue removals, seen or not) between calls to `pause`
export const PATH_SEP = " > "; // no npm, PyPI, crates.io or Go name or version contains a space

export const nodeKey = (name, version) => (version ? `${name}@${version}` : name);

const sortedExtras = (extras) => [...new Set(extras ?? [])].sort();
const isThenable = (value) => Boolean(value) && typeof value.then === "function";
const edgeId = (edge) => JSON.stringify([edge.name, edge.version ?? null, sortedExtras(edge.extras), edge.constraint ?? null]);
// Traversal identity: a package's children can depend on the extras of the edge that reached it.
const visitId = (key, extras) => `${key}\u0000${extras.join(",")}`;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// One call per distinct edge. Answers the settled value synchronously when it has
// one, so the count walk doesn't pay a microtask per edge. A rejection is dropped
// from the memo, so the next call tries again.
function memoize(resolve) {
  const cache = new Map();
  return (edge) => {
    const id = JSON.stringify([edge.name, edge.version ?? null, sortedExtras(edge.extras)]);
    const entry = cache.get(id);
    if (entry) return entry.done ? entry.value : entry.pending;
    let value;
    try { value = resolve(edge); } catch (error) { return Promise.reject(error); }
    if (!isThenable(value)) {
      cache.set(id, { done: true, value: value ?? null });
      return value ?? null;
    }
    const slot = { done: false, pending: null };
    slot.pending = Promise.resolve(value).then(
      (result) => { slot.done = true; slot.value = result ?? null; return slot.value; },
      (error) => { if (cache.get(id) === slot) cache.delete(id); throw error; },
    );
    cache.set(id, slot);
    return slot.pending;
  };
}

// Groups resolved edges by key: duplicates become one entry whose extras and child
// edges are the union, so row ids are unique at every level by construction.
function group(resolved) {
  const byKey = new Map();
  for (const { edge, resolution } of resolved) {
    const version = resolution?.version ?? edge.version ?? null;
    const key = nodeKey(edge.name, version);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { name: edge.name, version, constraint: edge.constraint ?? null, key, extras: new Set(), edges: new Map(), dev: true };
      byKey.set(key, entry);
    }
    entry.constraint ??= edge.constraint ?? null;
    for (const extra of edge.extras ?? []) entry.extras.add(extra);
    for (const child of resolution?.children ?? []) entry.edges.set(edgeId(child), child);
    entry.dev = entry.dev && Boolean(edge.dev);
  }
  return [...byKey.values()].map((entry) => ({ ...entry, extras: [...entry.extras].sort(), childEdges: [...entry.edges.values()] }));
}

function makeNode(entry, { dev, cycle = false }) {
  const childEdges = cycle ? [] : entry.childEdges;
  return {
    name: entry.name, version: entry.version, constraint: entry.constraint, dev, key: entry.key, extras: entry.extras,
    cycle, leaf: cycle || childEdges.length === 0, loading: false, children: cycle ? [] : null, childEdges, pending: null,
  };
}

async function resolveAll(resolve, edges) {
  return Promise.all(edges.map(async (edge) => {
    let resolution = resolve(edge);
    if (isThenable(resolution)) resolution = await resolution;
    return { edge, resolution };
  }));
}

// Resolves the directs once each, merges directs that resolve to one key (the
// runtime one wins over dev), then counts. Walk 1 runs from the runtime directs and
// is never cut, so `runtime` is exact and a runtime package never wears the `dev`
// tag. Walk 2 runs from the dev directs, and is the only walk the cap stops.
export async function buildTree(direct, resolver, { cap = MAX_TREE_NODES, pause } = {}) {
  const counted = typeof resolver === "function" || resolver.count !== false;
  const resolve = memoize(typeof resolver === "function" ? resolver : resolver.resolve);
  const entries = group(await resolveAll(resolve, direct)).sort(byName);
  const tree = { roots: [], total: null, capped: false, runtime: null, resolve, counted };
  if (counted) {
    const seen = new Set(entries.map((e) => e.key)), runtime = new Set(), visited = new Set();
    let pops = 0;
    const walk = async (starts, onKey) => {
      const stack = [];
      for (const entry of starts) {
        const id = visitId(entry.key, entry.extras);
        if (visited.has(id)) continue;
        visited.add(id);
        onKey(entry.key);
        for (let i = entry.childEdges.length - 1; i >= 0; i--) stack.push(entry.childEdges[i]);
      }
      while (stack.length) {
        const edge = stack.pop();
        pops++;
        if (pause && pops % CHUNK === 0) await pause();
        let resolution = resolve(edge);
        if (isThenable(resolution)) resolution = await resolution;
        const key = nodeKey(edge.name, resolution?.version ?? edge.version ?? null);
        const id = visitId(key, sortedExtras(edge.extras));
        if (visited.has(id)) continue;
        if (onKey(key) === false) return;
        visited.add(id);
        const children = resolution?.children ?? [];
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    };
    await walk(entries.filter((e) => !e.dev), (key) => { runtime.add(key); seen.add(key); });
    await walk(entries.filter((e) => e.dev), (key) => {
      if (seen.has(key)) return true;
      if (seen.size >= cap) { tree.capped = true; return false; }
      seen.add(key);
      return true;
    });
    tree.runtime = runtime;
    tree.total = seen.size;
  }
  tree.roots = entries.map((entry) => makeNode(entry, { dev: counted ? !tree.runtime.has(entry.key) : entry.dev }));
  return tree;
}

// Builds `node.children` once, one level only. `keys` is the root path including
// the node; a child already on it is a cycle and doesn't expand. `loading` and the
// pending promise are set before anything is awaited, so a caller can draw the
// loading state straight away; a concurrent call gets the same promise. On failure
// the node goes back to unbuilt, so the next call tries again.
export function expandNode(tree, node, keys) {
  if (node.children) return Promise.resolve();
  if (node.pending) return node.pending;
  node.loading = true;
  const pending = (async () => {
    try {
      const entries = group(await resolveAll(tree.resolve, node.childEdges)).sort(byName);
      node.children = entries.map((entry) => {
        const cycle = keys.includes(entry.key);
        return makeNode(entry, { dev: tree.counted ? !tree.runtime.has(entry.key) : false, cycle });
      });
      node.loading = false;
      node.pending = null;
    } catch (error) {
      // In `catch`, not `finally`: Herdr's interrupts skip `finally` (see toml.js).
      node.loading = false;
      node.pending = null;
      throw error;
    }
  })();
  if (node.loading) node.pending = pending;
  return pending;
}

// Makes a saved set of expanded paths true on a (re)built tree: opens each path's
// nodes, shortest paths first, and drops paths whose packages are gone (a version
// change gives a new key) or can no longer expand.
export async function expandPaths(tree, expanded) {
  const depth = (path) => path.split(PATH_SEP).length;
  for (const path of [...expanded].sort((a, b) => depth(a) - depth(b))) {
    const keys = path.split(PATH_SEP);
    let nodes = tree.roots, found = true;
    for (let i = 0; i < keys.length; i++) {
      const node = nodes.find((n) => n.key === keys[i]);
      if (!node || node.leaf) { found = false; break; }
      if (!node.children) await expandNode(tree, node, keys.slice(0, i + 1));
      nodes = node.children;
    }
    if (!found) expanded.delete(path);
  }
}

// The rows to draw, depth first. Recurses only into expanded rows whose children
// are built, and resolves nothing.
export function visibleRows(tree, expanded) {
  const rows = [];
  const visit = (nodes, depth, parent) => {
    for (const node of nodes) {
      const keys = [...parent, node.key], path = keys.join(PATH_SEP);
      const open = expanded.has(path) && Boolean(node.children) && !node.leaf;
      rows.push({ node, depth, path, keys, open, expandable: !node.leaf });
      if (open) visit(node.children, depth + 1, keys);
    }
  };
  visit(tree.roots, 0, []);
  return rows;
}

// "N direct, M total". Capped, M is the lower bound the walks know, which can
// exceed the cap because the runtime walk is never cut.
export function countsLine(tree) {
  const direct = `${tree.roots.length} direct`;
  if (tree.total === null) return direct;
  return `${direct}, ${tree.total}${tree.capped ? "+" : ""} total`;
}
