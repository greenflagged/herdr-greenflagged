// Rust's half of the plain dependency tree: Cargo.toml's dependency tables in,
// Cargo.lock's [[package]] entries read into the package list that tree.js's
// graphResolver walks. Plain data in and out, with no Herdr imports, so `npm test`
// can run it under Node without the app. Nothing here throws, whatever the input,
// text or not. No regex ever sees more than one lock dependency item.
//
// Rust edge cases, so RECIPE.md can point here instead of growing:
// - `[dependencies]` and `[build-dependencies]` are runtime rows, `[dev-dependencies]`
//   are `dev`, and the same three tables under `[target.<cfg>]` carry the cfg string
//   as the row's marker. The first table that names a crate wins.
// - `alias = { package = "real" }` shows the real crate name, which is what the lock
//   records. A `path` or `git` dependency is skipped even when it also gives a version.
// - `workspace = true` inherits from `[workspace.dependencies]` in the same file. A
//   member's manifest doesn't have that table, so its row shows the constraint
//   `workspace`, and the version from the lock when there is one.
// - A virtual manifest (`[workspace]` with no `[package]`) lists its `members` strings
//   as the top level without a lock. With one, the top level is every lock package
//   with no `source`: the workspace's crates, plus any path dependency outside it.
// - A workspace member has no Cargo.lock beside its Cargo.toml (the lock is at the
//   workspace root), so it shows its directs with the no-lockfile note.
// - Features aren't read: Cargo.lock lists optional dependencies whatever features
//   are on, so an `optional = true` crate is a normal row. `[patch]` and `[replace]`
//   aren't applied.

import { parseToml } from "./toml.js";
import { graphResolver } from "./tree.js";

const isTable = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

// A direct dependency in parse's shape; `marker` only when there is one.
const direct = (name, constraint, dev, marker) => ({ name, constraint, dev, ...(marker ? { marker } : {}) });

const TABLES = [["dependencies", false], ["build-dependencies", false], ["dev-dependencies", true]];

// One Cargo dependency spec: "1.0", or { version?, package?, path?, git?, workspace? }.
// Answers { dep } or { skip: name }, or null for a shape it doesn't know.
function cargoSpec(key, spec, dev, marker, inherited) {
  if (typeof spec === "string") return { dep: direct(key, spec, dev, marker) };
  if (!isTable(spec)) return null;
  let table = spec;
  if (spec.workspace === true) {
    const base = inherited?.[key];
    if (typeof base === "string") table = { ...spec, version: base };
    else if (isTable(base)) table = { ...base, ...spec };
    else return { dep: direct(typeof spec.package === "string" ? spec.package : key, "workspace", dev, marker) };
  }
  const name = typeof table.package === "string" ? table.package : key;
  if (has(table, "path") || has(table, "git")) return { skip: name };
  return { dep: direct(name, typeof table.version === "string" ? table.version : "*", dev, marker) };
}

// Cargo.toml → { name, deps, skipped }, or for a virtual manifest
// { name: null, deps: [member rows], skipped: [], workspace: true }.
export function parseCargoToml(text) {
  const parsed = parseToml(text);
  if (parsed.error) return { error: parsed.line ? `Cargo.toml ${parsed.error}` : `Cargo.toml: ${parsed.error}` };
  const doc = parsed.value;
  const pkg = isTable(doc.package) ? doc.package : null, workspace = isTable(doc.workspace) ? doc.workspace : null;
  if (!pkg && workspace) {
    const members = [...new Set(strings(workspace.members))];
    return { name: null, deps: members.map((m) => direct(m, null, false)), skipped: [], workspace: true };
  }
  const inherited = workspace && isTable(workspace.dependencies) ? workspace.dependencies : null;
  const deps = new Map(), skipped = [], seen = new Set();
  const read = (table, dev, marker) => {
    if (!isTable(table)) return;
    for (const [key, spec] of Object.entries(table)) {
      const result = cargoSpec(key, spec, dev, marker, inherited);
      if (!result) continue;
      const name = result.skip ?? result.dep.name;
      if (seen.has(name)) continue;
      seen.add(name);
      if (result.skip) skipped.push(name);
      else deps.set(name, result.dep);
    }
  };
  for (const [key, dev] of TABLES) read(doc[key], dev, null);
  if (isTable(doc.target)) {
    for (const [cfg, target] of Object.entries(doc.target)) {
      if (isTable(target)) for (const [key, dev] of TABLES) read(target[key], dev, cfg);
    }
  }
  return { name: typeof pkg?.name === "string" ? pkg.name : null, deps: [...deps.values()], skipped };
}

// One item of a lock entry's `dependencies`: "name", "name version" (when several
// versions of that crate are locked), or "name version (source)" in v1/v2 locks.
export function parseLockDependency(text) {
  if (typeof text !== "string") return null;
  const [name, version] = text.trim().split(/\s+/);
  if (!name) return null;
  return version ? { name, version } : { name };
}

// Cargo.lock's [[package]] entries with a name and version, in file order. `source`
// is null for the workspace's own crates and path dependencies.
export function cargoPackages(toml) {
  const list = Array.isArray(toml?.package) ? toml.package : [];
  return list.filter((p) => isTable(p) && typeof p.name === "string" && typeof p.version === "string").map((p) => ({
    name: p.name,
    version: p.version,
    source: typeof p.source === "string" ? p.source : null,
    dependencies: strings(p.dependencies).map(parseLockDependency).filter(Boolean),
  }));
}

const NO_PACKAGES = "no [[package]] entries with a name and version";

// Cargo.lock → { resolve, direct? }. For a package manifest, the project's own lock
// entry (sourceless, same name) says which version of a twice-locked crate it uses,
// so the manifest's directs take that version. For a virtual manifest, the directs
// are the lock's sourceless packages: the workspace's crates.
export function cargoResolver(text, project) {
  if (typeof text !== "string") return { error: "the lockfile is not text" };
  const parsed = parseToml(text);
  if (parsed.error) return { error: parsed.error };
  const packages = cargoPackages(parsed.value);
  if (!packages.length) return { error: NO_PACKAGES };
  const { resolve } = graphResolver(packages);
  const locals = packages.filter((p) => p.source === null);
  if (project?.workspace) {
    if (!locals.length) return { resolve };
    return { resolve, direct: locals.map((p) => ({ name: p.name, version: p.version, constraint: null, dev: false })) };
  }
  const root = locals.find((p) => p.name === project?.name);
  if (!root) return { resolve };
  const versions = new Map(root.dependencies.filter((e) => e.version).map((e) => [e.name, e.version]));
  const deps = project?.deps ?? [];
  return { resolve, direct: deps.map((dep) => (versions.has(dep.name) ? { ...dep, version: versions.get(dep.name) } : dep)) };
}

export const CARGO_LOCKFILES = [{ file: "Cargo.lock", resolver: cargoResolver }];

export const CARGO_NOTE = "No Cargo.lock beside the manifest, so only direct dependencies are shown.";
