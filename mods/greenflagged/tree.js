// A project's dependencies as a plain tree, for languages Greenflagged can't
// check. Plain data in and out, with no Herdr imports and no knowledge of any
// language, so `npm test` can run it under Node without the app.
//
// direct:     [{ name, constraint, dev, version?, extras?, marker?, group? }]   an ecosystem's `parse` output
// edge:       { name, version?, constraint?, extras?, marker? }         what a resolver hands back as children
// resolve:    (edge) -> Resolution | null, or a Promise of one
// Resolution: { version: string | null, children: edge[] }
// resolver:   resolve, or { resolve, count?: boolean, direct?: direct[] }; `count: false` skips the
//             count walk, and `direct` replaces the manifest's directs when the lockfile knows them
//             better (one row per locked version of a split dependency, say)
//
// `marker` is row metadata, never identity: rows merge on name@version, and a merged
// row shows the first non-null marker among its edges. Child edges that differ only in
// marker are one edge, and it keeps the first non-null marker too.
//
// A direct with `group: true` is a heading over its edges, not a package (Go's
// "indirect" row): resolve answers its children (or the row's own `members` edges, when
// treeForProject builds it), and it is keyed by groupKey(name), which
// no package key can equal. It sorts after the packages, is never `dev`, and isn't
// counted in "N direct, M total", though the packages under it are. `directRoots` is the
// one place that leaves groups out of the directs. Only a direct may be a group.
//
// A node is built only when its parent is expanded, so a package several others
// depend on costs nothing until someone opens it under each of them.

export const MAX_TREE_NODES = 2000; // unique packages in total; once reached, the dev-only walk stops adding
export const MAX_WALK_VISITS = 10 * MAX_TREE_NODES; // hard ceiling on (package, extras) visits across both walks
export const MAX_WALK_POPS = 100 * MAX_TREE_NODES; // hard ceiling on edge pops across both walks
export const CHUNK = 250; // edge pops (work-queue removals, seen or not) between calls to `pause`

// A row's path is the JSON array of keys from its root, so a name can hold any text.
export const pathOf = (keys) => JSON.stringify(keys);
export const keysOf = (path) => JSON.parse(path);

export const nodeKey = (name, version) => (version ? `${name}@${version}` : name);
// NUL never appears in a package name; JSON (pathOf) escapes it, so a path stays ASCII.
export const groupKey = (name) => `\u0000group:${name}`;

const sortedExtras = (extras) => [...new Set(extras ?? [])].sort();
const isThenable = (value) => Boolean(value) && typeof value.then === "function";
const edgeId = (edge) => JSON.stringify([edge.name, edge.version ?? null, sortedExtras(edge.extras), edge.constraint ?? null, edge.group === true]);
// Traversal identity: a package's children can depend on the extras of the edge that reached it.
const visitId = (key, extras) => `${key}\u0000${extras.join(",")}`;
const byName = (a, b) => (a.group !== b.group ? (a.group ? 1 : -1)
  : a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// One call per distinct edge. Answers the settled value synchronously when it has
// one, so the count walk doesn't pay a microtask per edge. A rejection is dropped
// from the memo, so the next call tries again.
function memoize(resolve) {
  const cache = new Map();
  return (edge) => {
    const id = JSON.stringify([edge.name, edge.version ?? null, sortedExtras(edge.extras), edge.group === true]);
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
    const isGroup = edge.group === true;
    const key = isGroup ? groupKey(edge.name) : nodeKey(edge.name, version);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        name: edge.name, version, constraint: edge.constraint ?? null, marker: edge.marker ?? null, key, group: isGroup, extras: new Set(), edges: new Map(), dev: true,
      };
      byKey.set(key, entry);
    }
    entry.constraint ??= edge.constraint ?? null;
    entry.marker ??= edge.marker ?? null;
    for (const extra of edge.extras ?? []) entry.extras.add(extra);
    for (const child of resolution?.children ?? []) {
      const id = edgeId(child), seen = entry.edges.get(id);
      if (!seen) entry.edges.set(id, child);
      else if (seen.marker == null && child.marker != null) entry.edges.set(id, { ...seen, marker: child.marker });
    }
    entry.dev = entry.dev && Boolean(edge.dev);
  }
  return [...byKey.values()].map((entry) => ({ ...entry, extras: [...entry.extras].sort(), childEdges: [...entry.edges.values()] }));
}

function makeNode(entry, { dev, cycle = false }) {
  const childEdges = cycle ? [] : entry.childEdges;
  return {
    name: entry.name, version: entry.version, constraint: entry.constraint, marker: entry.marker, dev, key: entry.key, extras: entry.extras, group: entry.group,
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

// Resolves each direct dependency once, then merges directs that resolve to the same
// key (the runtime one wins over dev). Then it counts, in two walks.
// Walk 1 starts from the runtime directs. The cap (MAX_TREE_NODES) never cuts it, so
// `runtime` is exact and a runtime package never gets the `dev` tag.
// Walk 2 starts from the dev directs. It is the only walk the cap can stop.
// Both walks also stop at the hard ceilings (`maxVisits`, `maxPops`). How often a real
// lockfile reaches them is unmeasured: the Python resolvers are the first. Then `capped`
// is set and `runtime` may be short, so a runtime package past the ceiling can show
// as `dev`.
export async function buildTree(direct, resolver, { cap = MAX_TREE_NODES, maxVisits = MAX_WALK_VISITS, maxPops = MAX_WALK_POPS, pause } = {}) {
  const counted = typeof resolver === "function" || resolver.count !== false;
  const resolve = memoize(typeof resolver === "function" ? resolver : resolver.resolve);
  const entries = group(await resolveAll(resolve, direct)).sort(byName);
  const tree = { roots: [], total: null, capped: false, runtime: null, resolve, counted };
  if (counted) {
    const seen = new Set(entries.filter((e) => !e.group).map((e) => e.key)), runtime = new Set(), visited = new Set();
    let pops = 0;
    const ceiling = () => {
      if (visited.size < maxVisits && pops < maxPops) return false;
      tree.capped = true;
      return true;
    };
    const walk = async (starts, onKey) => {
      const stack = [];
      for (const entry of starts) {
        const id = visitId(entry.key, entry.extras);
        if (visited.has(id)) continue;
        if (ceiling()) return;
        visited.add(id);
        if (!entry.group) onKey(entry.key);
        for (let i = entry.childEdges.length - 1; i >= 0; i--) stack.push(entry.childEdges[i]);
      }
      while (stack.length) {
        if (ceiling()) return;
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
  tree.roots = entries.map((entry) => makeNode(entry, { dev: entry.group ? false : counted ? !tree.runtime.has(entry.key) : entry.dev }));
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

// Re-opens the saved expanded paths on a (re)built tree. It opens each path's nodes,
// shortest paths first. It drops paths whose packages are gone (a version change
// gives a new key) or can no longer expand. A path whose expansion fails is dropped
// too, so its row draws ▸ and one click retries; the other paths still reopen, and
// the first error is thrown once they have.
export async function expandPaths(tree, expanded) {
  const saved = [...expanded].map((path) => {
    try { return { path, keys: keysOf(path) }; } catch { return { path, keys: null }; }
  });
  let failure = null;
  const broken = new Set(); // nodes whose expansion failed here, so deeper paths don't retry them
  for (const { path, keys } of saved.sort((a, b) => (a.keys?.length ?? 0) - (b.keys?.length ?? 0))) {
    let nodes = tree.roots, found = Array.isArray(keys) && keys.length > 0;
    for (let i = 0; found && i < keys.length; i++) {
      const node = nodes.find((n) => n.key === keys[i]);
      if (!node || node.leaf || broken.has(node)) { found = false; break; }
      if (!node.children) {
        try { await expandNode(tree, node, keys.slice(0, i + 1)); } catch (error) {
          failure ??= { error };
          broken.add(node);
          found = false;
          break;
        }
      }
      nodes = node.children;
    }
    if (!found) expanded.delete(path);
  }
  if (failure) throw failure.error;
}

// The rows to draw, depth first. Recurses only into expanded rows whose children
// are built, and resolves nothing.
export function visibleRows(tree, expanded) {
  const rows = [];
  const visit = (nodes, depth, parent) => {
    for (const node of nodes) {
      const keys = [...parent, node.key], path = pathOf(keys);
      const open = expanded.has(path) && Boolean(node.children) && !node.leaf;
      rows.push({ node, depth, path, keys, open, expandable: !node.leaf });
      if (open) visit(node.children, depth + 1, keys);
    }
  };
  visit(tree.roots, 0, []);
  return rows;
}

// "N direct, M total". When a walk is stopped, M is only a lower bound: the packages
// the walks found before stopping. M can still exceed the cap, because the cap never
// cuts the runtime walk.
// The roots that are packages: every root but the group headings.
export const directRoots = (tree) => tree.roots.filter((node) => !node.group);

export function countsLine(tree) {
  const direct = `${directRoots(tree).length} direct`;
  if (tree.total === null) return direct;
  return `${direct}, ${tree.total}${tree.capped ? "+" : ""} total`;
}

export const NO_LOCKFILE_NOTE = "No lockfile, so only direct dependencies are shown.";
export const MAX_LOCK_CHARS = 16 * 1024 * 1024; // a bigger lockfile isn't parsed
export const failedNote = (file, error) => `Couldn't read ${file ?? "the lockfile"}: ${String(error?.message ?? error)}`;

// The tree for a project (`deps` from its ecosystem's `parse`), with `note` and
// `lockFile` set. `lock` is { file, text, resolver } or null when no lockfile was
// found. If the lockfile or the walk fails, the tree keeps only the directs and says
// why in `note`; this function never sets an error state. If `stale()` is true once
// the walk ends, it returns null before expandPaths runs, so `expanded` is untouched.
// A refresh that starts during expandPaths isn't caught: expandPaths still deletes
// the saved paths that fail or no longer match from `expanded`.
export async function treeForProject(project, lock, { noLockNote = NO_LOCKFILE_NOTE, expanded = new Set(), pause, stale = () => false } = {}) {
  let resolver = () => null, made = null, note = lock ? null : noLockNote;
  if (lock && lock.text.length > MAX_LOCK_CHARS) {
    note = `${lock.file} is too large to parse, so only direct dependencies are shown.`;
  } else if (lock) {
    try {
      made = lock.resolver(lock.text, project);
      if (made?.error) note = failedNote(lock.file, made.error);
      else if (made) resolver = made;
      else note = failedNote(lock.file, "its resolver returned nothing");
    } catch (error) { note = failedNote(lock.file, error); }
  }
  resolver = withMembers(resolver);
  let tree;
  try {
    // `made` may be a bare resolve function, whose `.direct` is undefined.
    tree = await buildTree(made?.direct ?? project.deps, resolver, { pause });
  } catch (error) {
    note = failedNote(lock?.file, error);
    tree = await buildTree(project.deps, withMembers(() => null));
  }
  if (stale()) return null;
  tree.note = note;
  tree.lockFile = lock?.file ?? null;
  try { await expandPaths(tree, expanded); } catch (error) { tree.note ??= failedNote(tree.lockFile, error); }
  return tree;
}

// A heading row that carries its own children (`members`, as a Gradle root's modules
// do) answers them itself; every other edge goes to the lockfile's resolver.
function withMembers(resolver) {
  const base = typeof resolver === "function" ? resolver : resolver.resolve;
  const resolve = (edge) => (edge.group === true && Array.isArray(edge.members) ? { version: null, children: edge.members } : base(edge));
  return typeof resolver === "function" ? resolve : { ...resolver, resolve };
}

// A resolver over a lockfile's package list, for any language whose lock names each
// package once per version. `packages` is [{ name, version, dependencies: edge[],
// optionalDependencies?: Map<extra, edge[]> }], names already normalized. An edge with
// a version finds name@version; one without takes the first package of that name in
// list order. A child edge with no version gets one filled in when only one version of
// that name is locked, so the count walk and the row agree; otherwise it is resolved
// on expand. A package the list lacks resolves to null, which shows the edge as a leaf.
export function graphResolver(packages) {
  const byKey = new Map(), names = new Map();
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (byKey.has(key)) continue;
    byKey.set(key, pkg);
    if (!names.has(pkg.name)) names.set(pkg.name, []);
    names.get(pkg.name).push(key);
  }
  const fill = (edge) => {
    if (edge.version) return edge;
    const keys = names.get(edge.name);
    return keys?.length === 1 ? { ...edge, version: byKey.get(keys[0]).version } : edge;
  };
  const resolve = (edge) => {
    const pkg = byKey.get(edge.version ? `${edge.name}@${edge.version}` : names.get(edge.name)?.[0]);
    if (!pkg) return null;
    const children = [...(pkg.dependencies ?? [])];
    for (const extra of edge.extras ?? []) children.push(...(pkg.optionalDependencies?.get(extra) ?? []));
    return { version: pkg.version, children: children.map(fill) };
  };
  return { resolve };
}

// The direct list for a lock that records the project's own dependencies (`lockRows`,
// each { name, version, marker?, extras?, dev }), joined with the manifest's deps by
// name. A row keeps its own `dev` (the lock section it came from) and takes the
// manifest's constraint, and its extras when the row has none. Manifest deps the lock
// doesn't list are appended as they are, so a stale lock still shows every direct.
export function mergeDirect(manifestDeps, lockRows) {
  const manifest = new Map();
  for (const dep of manifestDeps) if (!manifest.has(dep.name)) manifest.set(dep.name, dep);
  const listed = new Set(), direct = [];
  for (const row of lockRows) {
    const dep = manifest.get(row.name);
    listed.add(row.name);
    direct.push({
      name: row.name, version: row.version ?? null, constraint: dep?.constraint ?? null, marker: row.marker ?? null,
      extras: row.extras?.length ? row.extras : dep?.extras ?? [], dev: Boolean(row.dev),
    });
  }
  for (const dep of manifestDeps) if (!listed.has(dep.name)) direct.push(dep);
  return direct;
}
