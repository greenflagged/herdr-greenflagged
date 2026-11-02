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
//   records. A `path` or `git` dependency is skipped (not audited) even when it also
//   gives a version, but when the project's own lock entry lists it, it is still a row,
//   at the lock's version and with its subtree.
// - `workspace = true` inherits from `[workspace.dependencies]` in the same file, and
//   the workspace entry's name wins: like Cargo, a member's own `package` is ignored. A
//   member's manifest doesn't have that table, so its row shows the constraint
//   `workspace`, and the version from the lock when there is one.
// - Without the project's own lock entry (a stale lock, or a manifest with no name), a
//   twice-locked direct takes the highest locked version its constraint allows.
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
    // Cargo takes the crate (version, package, path, git) from the workspace entry; the
    // member may only add features and `optional`, which aren't read here.
    const base = inherited && has(inherited, key) ? inherited[key] : undefined;
    if (typeof base === "string") table = { version: base };
    else if (isTable(base)) table = base;
    else return { dep: direct(key, "workspace", dev, marker) };
  }
  const name = typeof table.package === "string" ? table.package : key;
  if (has(table, "path") || has(table, "git")) return { skip: name, dev };
  return { dep: direct(name, typeof table.version === "string" ? table.version : "*", dev, marker) };
}

// Cargo.toml → { name, deps, skipped, local }, or for a virtual manifest
// { name: null, deps: [member rows], skipped: [], workspace: true }. `local` holds a
// row per skipped path or git dependency, so the lock can still show it.
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
  const deps = new Map(), skipped = [], local = [], seen = new Set();
  const read = (table, dev, marker) => {
    if (!isTable(table)) return;
    for (const [key, spec] of Object.entries(table)) {
      const result = cargoSpec(key, spec, dev, marker, inherited);
      if (!result) continue;
      const name = result.skip ?? result.dep.name;
      if (seen.has(name)) continue;
      seen.add(name);
      if (result.skip) {
        skipped.push(name);
        local.push(direct(name, null, result.dev, marker));
      } else deps.set(name, result.dep);
    }
  };
  for (const [key, dev] of TABLES) read(doc[key], dev, null);
  if (isTable(doc.target)) {
    for (const [cfg, target] of Object.entries(doc.target)) {
      if (isTable(target)) for (const [key, dev] of TABLES) read(target[key], dev, cfg);
    }
  }
  return { name: typeof pkg?.name === "string" ? pkg.name : null, deps: [...deps.values()], skipped, local };
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

// A version or requirement operand split at its pre-release: "1.2.3-rc.1+build" →
// { core: "1.2.3", pre: ["rc", "1"] }, pre null for a release. Build metadata after "+"
// is dropped, on both sides, because Cargo ignores it when matching.
const splitVersion = (text) => {
  const noBuild = text.split("+")[0];
  const dash = noBuild.indexOf("-");
  return dash === -1 ? { core: noBuild, pre: null } : { core: noBuild.slice(0, dash), pre: noBuild.slice(dash + 1).split(".") };
};
const versionParts = (text) => splitVersion(text).core.split(".").map((n) => Number.parseInt(n, 10));
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
};
// Semver's pre-release order: a release sorts after any pre-release of the same core;
// numeric identifiers compare as numbers and sort before alphanumeric ones.
const comparePre = (a, b) => {
  if (!a || !b) return (a ? -1 : 0) - (b ? -1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) return Number(a[i]) - Number(b[i]);
    if (an !== bn) return an ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};
const compareVersions = (a, b) => compare(versionParts(a), versionParts(b)) || comparePre(splitVersion(a).pre, splitVersion(b).pre);

// Whether a locked version meets a Cargo requirement ("2", "^1.2", "~0.3", "=1.0.5",
// ">=1, <3", "1.*", "*"). Answers null when it can't read the requirement. Build metadata
// is ignored on both sides. As in Cargo, a pre-release version ("2.0.0-alpha") matches
// only when some part of the requirement names a pre-release of the same major.minor.patch
// ("^2.0.0-alpha"); pre-releases of one core are ordered by semver's rules, and a
// pre-release in a requirement needs all three numbers and no wildcard.
export function cargoAllows(version, requirement) {
  if (typeof version !== "string" || typeof requirement !== "string") return null;
  const { pre: havePre } = splitVersion(version);
  const have = versionParts(version);
  if (have.some(Number.isNaN)) return null;
  const parts = requirement.split(",").map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p)) return null;
  let preAllowed = !havePre;
  for (const part of parts) {
    const [, op = "", rest] = /^(\^|~|=|>=|<=|>|<)?\s*(\S+)$/.exec(part) ?? [];
    if (rest === undefined) return null;
    const { core, pre } = splitVersion(rest);
    if (pre && pre.some((id) => !/^[0-9A-Za-z-]+$/.test(id))) return null;
    const pieces = core.split(".");
    const given = [];
    for (const piece of pieces) {
      if (piece === "*" || piece === "x" || piece === "X") break;
      const n = Number.parseInt(piece, 10);
      if (Number.isNaN(n) || String(n) !== piece.replace(/^0+(?=\d)/, "")) return null;
      given.push(n);
    }
    if (given.length > 3) return null;
    const wildcard = given.length < pieces.length;
    if (pre && (wildcard || given.length < 3)) return null;
    if (!given.length) { if (wildcard && !op) continue; return null; }
    const low = [given[0], given[1] ?? 0, given[2] ?? 0];
    if (pre && compare(have, low) === 0) preAllowed = true;
    const bump = (i) => { const up = given.slice(0, i + 1); up[i] += 1; return [up[0], up[1] ?? 0, up[2] ?? 0]; };
    const c = compare(have, low) || comparePre(havePre, pre);
    let ok;
    if (op === ">") ok = c > 0;
    else if (op === ">=") ok = c >= 0;
    else if (op === "<") ok = c < 0;
    else if (op === "<=") ok = c <= 0;
    else if (op === "=" && pre) ok = c === 0;
    else {
      let high;
      if (op === "~") high = bump(given.length > 1 ? 1 : 0);
      else if (op === "=" || wildcard) high = bump(given.length - 1);
      else { const first = given.findIndex((n) => n !== 0); high = bump(first === -1 ? given.length - 1 : first); }
      ok = c >= 0 && compare(have, high) < 0;
    }
    if (!ok) return false;
  }
  return preAllowed;
}

// The highest of a crate's locked versions that the constraint allows, or undefined.
function allowedVersion(versions, constraint) {
  const allowed = versions.filter((v) => cargoAllows(v, constraint) === true);
  return allowed.sort((a, b) => compareVersions(b, a))[0];
}

// Cargo.lock → { resolve, direct? }. For a package manifest, the project's own lock
// entry (sourceless, same name) says which version of a twice-locked crate it uses,
// so the manifest's directs take that version, and the path and git dependencies it
// lists are added as rows. Without that entry, a twice-locked direct takes the highest
// version its constraint allows. For a virtual manifest, the directs are the lock's
// sourceless packages: the workspace's crates.
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
  const locked = new Map();
  for (const p of packages) locked.set(p.name, [...(locked.get(p.name) ?? []), p.version]);
  const deps = Array.isArray(project?.deps) ? project.deps : [];
  const root = typeof project?.name === "string" ? locals.find((p) => p.name === project.name) : undefined;
  if (!root) {
    return {
      resolve,
      direct: deps.map((dep) => {
        const versions = locked.get(dep.name) ?? [];
        const version = versions.length > 1 ? allowedVersion(versions, dep.constraint) : undefined;
        return version ? { ...dep, version } : dep;
      }),
    };
  }
  const versions = new Map(root.dependencies.filter((e) => e.version).map((e) => [e.name, e.version]));
  const rows = deps.map((dep) => (versions.has(dep.name) ? { ...dep, version: versions.get(dep.name) } : dep));
  const listed = new Set(deps.map((dep) => dep.name));
  const local = new Map((Array.isArray(project?.local) ? project.local : []).map((dep) => [dep.name, dep]));
  for (const edge of root.dependencies) {
    if (listed.has(edge.name)) continue;
    listed.add(edge.name);
    const all = locked.get(edge.name) ?? [];
    const version = edge.version ?? (all.length === 1 ? all[0] : undefined);
    // A lock-only crate the manifest didn't name in a form read here is a plain row.
    const row = local.get(edge.name) ?? direct(edge.name, null, false);
    rows.push(version ? { ...row, version } : row);
  }
  return { resolve, direct: rows };
}

export const CARGO_LOCKFILES = [{ file: "Cargo.lock", resolver: cargoResolver }];

export const CARGO_NOTE = "No Cargo.lock beside the manifest, so only direct dependencies are shown.";
