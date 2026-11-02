// Rust's half of the plain dependency tree: Cargo.toml's dependency tables in,
// Cargo.lock's [[package]] entries read into the package list that tree.js's
// graphResolver walks. Plain data in and out, with no Herdr imports, so `npm test`
// can run it under Node without the app. Nothing here throws, whatever the input,
// text or not. No regex ever sees more than one lock dependency item.
//
// Rust edge cases, so RECIPE.md can point here instead of growing:
// - `[dependencies]` and `[build-dependencies]` are runtime rows, `[dev-dependencies]`
//   are `dev`. A `[build-dependencies]` row carries the marker `build`. The same three
//   tables under `[target.<cfg>]` carry the cfg string as the marker, after `build, `
//   for a target's build table. The first table that names a crate wins.
// - `alias = { package = "real" }` shows the real crate name, which is what the lock
//   records. A `path` or `git` dependency is skipped (not audited) even when it also
//   gives a version, but when the project's own lock entry lists it, it is still a row,
//   at the lock's version and with its subtree.
// - `workspace = true` inherits from `[workspace.dependencies]`: the manifest's own
//   table when it has one, else the workspace root's. The workspace entry's name wins:
//   like Cargo, a member's own `package` is ignored. With neither table (a member read
//   alone), the row shows the constraint `workspace`. `version.workspace = true` takes
//   `[workspace.package] version` the same way.
// - Without the crate's own lock entry (a stale lock, or a manifest with no name), a
//   twice-locked direct takes the highest locked version its constraint allows, and the
//   crate's path and git dependencies are rows too, at a sibling crate's own version or
//   as a bare name.
// - Workspace discovery (`cargoProject`): a manifest with `[workspace]` is its own root;
//   else `package.workspace = "<path>"` names the root; else the first ancestor
//   Cargo.toml with `[workspace]` is (over the same ancestors manifest discovery tries).
//   A crate with no root, one the root `exclude`s, or one the root's `members` don't
//   match is standalone: its own Cargo.lock beside it, as Cargo treats it. When the
//   member listing is incomplete (below), a crate it missed is taken as a member.
// - Members come from the root's `members` globs (workspace.js: `*` and `?` within one
//   segment, `**` as one level, `[...]` literal) minus `exclude`, at most MAX_MEMBERS.
//   When a folder can't be listed or the cap is reached, the lock's sourceless packages
//   fill in the crates the listing missed. `default-members` isn't read. A member
//   Cargo.toml that can't be read or parsed is left out, and the project's note says how
//   many there were. The note doesn't say the crate is missing: when the lock fills in
//   crates, it may still show, at the lock's version and with the lock's dependencies.
// - Member paths may climb out of the root (`../tools/x`) or be absolute, as in Cargo,
//   so the Cargo.toml files read can lie outside the project folder. They are only read.
// - At the workspace root the tree is one `(workspace)` row whose children are the
//   crates (the root package too, when there is one). In a member's folder the top level
//   is that crate's directs, with versions and subtrees from the root's Cargo.lock. Either
//   way a crate's children are its own manifest's rows, with the dev, build and target
//   tags it declares; a row naming a sibling crate is a `(project)` row that expands to
//   that crate's manifest rows. A row the lock entry lists but the manifest didn't name
//   declares nothing, so it is tagged dev by reachability, like the rows below it. The
//   crate never appears in its own tree: a back-edge to it reads `(cycle)`.
// - Without a lock, a workspace or member still shows that shape: crates and sibling
//   rows at their manifest versions, registry rows as bare names with their constraints.
// - A `[package]` with no version shows `0.0.0`, which is what Cargo records for it.
// - A member outside the root folder (`../tools/x`) is read but not watched: saving its
//   Cargo.toml shows on the next refresh.
// - parseLockDependency keeps a lock item's name and version and drops its source. So
//   two entries with the same name and version from different sources (say, a git fork
//   pinned to the registry's version) both resolve to the first, even though the lock
//   names the source for exactly this case.
// - Features aren't read: Cargo.lock lists optional dependencies whatever features
//   are on, so an `optional = true` crate is a normal row. `[patch]` and `[replace]`
//   aren't applied.

import { parseToml } from "./toml.js";
import { graphResolver, nodeKey } from "./tree.js";
import { MAX_MEMBERS, collapse, expandMembers } from "./workspace.js";

const isTable = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

// A direct dependency in parse's shape; `marker` only when there is one.
const direct = (name, constraint, dev, marker) => ({ name, constraint, dev, ...(marker ? { marker } : {}) });

// [table, dev, build]
const TABLES = [["dependencies", false, false], ["build-dependencies", false, true], ["dev-dependencies", true, false]];
// A row's marker: `build` for a build table, the target's cfg, or both ("build, cfg(windows)").
const markerOf = (build, cfg) => [build ? "build" : null, cfg].filter(Boolean).join(", ") || null;

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

// A manifest's `[workspace]` table as plain data, or null when it has none.
function workspaceRecord(workspace) {
  if (!workspace) return null;
  return {
    members: [...new Set(strings(workspace.members))],
    exclude: [...new Set(strings(workspace.exclude))],
    dependencies: isTable(workspace.dependencies) ? workspace.dependencies : null,
    package: isTable(workspace.package) ? workspace.package : null,
  };
}

// Cargo.toml → { name, version, deps, skipped, local, root, workspace? }. `local` holds a
// row per skipped path or git dependency, so the lock can still show it. `root` is
// `package.workspace` (the path to the workspace root) or null, and `workspace` is the
// manifest's own [workspace] record when it has one. `inherited` is the workspace root's
// record, for a member read with its root: its `dependencies` serve `workspace = true`
// and its `package.version` serves `version.workspace = true` when the manifest has no
// table of its own. A virtual manifest answers its `members` strings as plain rows (what
// the panel shows when neither the members nor a lock can be read), with
// `virtual: true` and `layout: "workspace"`.
export function parseCargoToml(text, inherited = null) {
  const parsed = parseToml(text);
  if (parsed.error) return { error: parsed.line ? `Cargo.toml ${parsed.error}` : `Cargo.toml: ${parsed.error}` };
  const doc = parsed.value;
  const pkg = isTable(doc.package) ? doc.package : null;
  const workspace = workspaceRecord(isTable(doc.workspace) ? doc.workspace : null);
  if (!pkg && workspace) {
    return {
      name: null, version: null, deps: workspace.members.map((m) => direct(m, null, false)), skipped: [], local: [],
      workspace, virtual: true, layout: "workspace",
    };
  }
  const table = workspace?.dependencies ?? (isTable(inherited?.dependencies) ? inherited.dependencies : null);
  const deps = new Map(), skipped = [], local = [], seen = new Set();
  const read = (section, dev, marker) => {
    if (!isTable(section)) return;
    for (const [key, spec] of Object.entries(section)) {
      const result = cargoSpec(key, spec, dev, marker, table);
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
  for (const [key, dev, build] of TABLES) read(doc[key], dev, markerOf(build, null));
  if (isTable(doc.target)) {
    for (const [cfg, target] of Object.entries(doc.target)) {
      if (isTable(target)) for (const [key, dev, build] of TABLES) read(target[key], dev, markerOf(build, cfg));
    }
  }
  return {
    name: typeof pkg?.name === "string" ? pkg.name : null,
    version: packageVersion(pkg, workspace, inherited),
    deps: [...deps.values()], skipped, local,
    root: typeof pkg?.workspace === "string" ? pkg.workspace : null,
    ...(workspace ? { workspace } : {}),
  };
}

// `package.version`, or for `version.workspace = true` the workspace's
// `[workspace.package] version`: the manifest's own, else the root's. Null otherwise.
function packageVersion(pkg, workspace, inherited) {
  const version = pkg?.version;
  if (typeof version === "string") return version;
  if (!isTable(version) || version.workspace !== true) return null;
  for (const record of [workspace, inherited]) {
    const value = isTable(record?.package) ? record.package.version : undefined;
    if (typeof value === "string") return value;
  }
  return null;
}

// One item of a lock entry's `dependencies`: "name", "name version" (when several
// versions of that crate are locked), or "name version (source)" (always in v1 locks,
// and in later ones when the name and version alone are ambiguous). The source is dropped.
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
// pre-release in a requirement without all three numbers, or with a wildcard, answers null.
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

// Cargo.lock → { resolve, direct, self } (see shapeResolver), or { error }.
export function cargoResolver(text, project) {
  if (typeof text !== "string") return { error: "the lockfile is not text" };
  const parsed = parseToml(text);
  if (parsed.error) return { error: parsed.error };
  const packages = cargoPackages(parsed.value);
  if (!packages.length) return { error: NO_PACKAGES };
  return shapeResolver(packages, project);
}

// The tree's shape without a lock, for a workspace or member that `cargoProject`
// gathered crates for: the same rows at manifest versions, registry rows as leaves.
// Null otherwise (a standalone crate, or a workspace whose members couldn't be read),
// so the tree is the plain directs.
export const cargoUnlocked = (project) => (project?.layout && project.crates?.length ? shapeResolver([], project) : null);

const list = (value) => (Array.isArray(value) ? value : []);

// The resolver for a project over a lock's packages (none without a lock). `crates` and
// `layout` come from `cargoProject`; a project without them is a single crate.
// - A crate's rows are its manifest's directs. Its own lock entry (sourceless, same name)
//   says which version of a twice-locked crate it uses, and the path and git
//   dependencies it lists are rows at the lock's version; a crate the entry lists that
//   the manifest didn't name is a row with no `dev` of its own. Without an entry, a
//   twice-locked direct takes the highest version its constraint allows, and the path
//   and git dependencies are appended as they are.
// - A row naming a workspace crate (at its version, or with none) is `kind: "project"`
//   and expands to that crate's rows; anything else resolves through the lock.
// - `direct` is one `kind: "workspace"` row for the workspace layout, whose children are
//   the crates; otherwise the project's own rows. `self` is the project's own key, so a
//   back-edge to it is a cycle, not a row.
function shapeResolver(packages, project) {
  const { resolve: lockResolve } = graphResolver(packages);
  const locked = new Map(), sourceless = new Map();
  for (const p of packages) {
    locked.set(p.name, [...(locked.get(p.name) ?? []), p.version]);
    if (p.source === null && !sourceless.has(p.name)) sourceless.set(p.name, p);
  }
  const crates = list(project?.crates).filter((c) => typeof c?.name === "string");
  const byName = new Map();
  for (const crate of crates) if (!byName.has(crate.name)) byName.set(crate.name, crate);
  const entryOf = (crate) => (typeof crate.name === "string" ? sourceless.get(crate.name) : undefined);
  // Cargo's own default for a [package] with no version, and what it writes in the lock.
  const versionOf = (crate) => entryOf(crate)?.version ?? crate.version ?? "0.0.0";
  const isProject = (edge) => {
    const crate = byName.get(edge.name);
    return Boolean(crate) && (!edge.version || edge.version === versionOf(crate));
  };
  const tagProject = (row) => (isProject(row) ? { ...row, kind: "project", version: row.version ?? versionOf(byName.get(row.name)) } : row);

  const rowsOf = (crate) => {
    const deps = list(crate.deps), local = list(crate.local), entry = entryOf(crate);
    const listed = new Set(deps.map((dep) => dep.name));
    let rows;
    if (entry) {
      const versions = new Map(entry.dependencies.filter((e) => e.version).map((e) => [e.name, e.version]));
      rows = deps.map((dep) => (versions.has(dep.name) ? { ...dep, version: versions.get(dep.name) } : dep));
      const byLocal = new Map(local.map((dep) => [dep.name, dep]));
      for (const edge of entry.dependencies) {
        if (listed.has(edge.name)) continue;
        listed.add(edge.name);
        const all = locked.get(edge.name) ?? [];
        const version = edge.version ?? (all.length === 1 ? all[0] : undefined);
        // A lock-only crate the manifest didn't name in a form read here declares nothing.
        const row = byLocal.get(edge.name) ?? { name: edge.name, constraint: null };
        rows.push(version ? { ...row, version } : row);
      }
    } else {
      rows = deps.map((dep) => {
        const versions = locked.get(dep.name) ?? [];
        const version = versions.length > 1 ? allowedVersion(versions, dep.constraint) : undefined;
        return version ? { ...dep, version } : dep;
      });
      for (const dep of local) {
        if (listed.has(dep.name)) continue;
        listed.add(dep.name);
        rows.push(dep);
      }
    }
    return rows.map(tagProject);
  };

  const crateEdges = crates.map((crate) => ({ name: crate.name, version: versionOf(crate), constraint: null, dev: false }));
  if (!crates.length || project?.membersIncomplete) {
    // The lock's own member list fills in whatever the folder listing missed.
    for (const p of sourceless.values()) {
      if (!byName.has(p.name)) crateEdges.push({ name: p.name, version: p.version, constraint: null, dev: false });
    }
  }

  const resolve = (edge) => {
    if (edge.kind === "workspace") return { version: null, children: crateEdges };
    if (isProject(edge)) {
      const crate = byName.get(edge.name);
      return { version: versionOf(crate), children: rowsOf(crate) };
    }
    const resolution = lockResolve(edge);
    return resolution?.children ? { ...resolution, children: resolution.children.map(tagProject) } : resolution;
  };

  if (project?.layout === "workspace") {
    return { resolve, direct: [{ name: project.name ?? "workspace", constraint: null, dev: false, kind: "workspace" }] };
  }
  const own = { name: project?.name, version: project?.version ?? null, deps: project?.deps, local: project?.local };
  return { resolve, direct: rowsOf(own), self: typeof own.name === "string" ? nodeKey(own.name, versionOf(own)) : null };
}

// --- workspace discovery ---------------------------------------------------------

const parentOf = (folder) => folder.slice(0, folder.lastIndexOf("/")) || "/";
const basename = (folder) => folder.slice(folder.lastIndexOf("/") + 1) || folder;
const under = (folder, base) => folder === base || folder.startsWith(base === "/" ? "/" : `${base}/`);

// `read` and `list` from main.js, wrapped so neither throwing nor rejecting reaches here.
const readSafely = (io, path) => {
  try { return Promise.resolve(io.read(path)).then((t) => (typeof t === "string" ? t : null), () => null); } catch { return Promise.resolve(null); }
};
const parseSafely = (text, inherited) => {
  if (text === null) return null;
  try { return parseCargoToml(text, inherited); } catch { return null; }
};

// The Rust project as `findManifest` found it, placed in its workspace. `io` is
// { read(path) -> text | null, list(dir) -> folder names | null, parents(folder) ->
// folders to try upward }. Answers the project unchanged for a standalone crate (see the
// header for when a crate is standalone), else the project with:
//   workspaceFolder  the root's folder: where the lock is read and watched
//   crates           [{ name, version, folder, path, deps, skipped, local }], one per
//                    member manifest read (the root package too), parsed with the root's
//                    [workspace] as `inherited`
//   layout           "workspace" at the root, "crate" in a member's folder
//   fingerprint      what in the member manifests changes the tree
//   membersIncomplete  when the folders couldn't all be listed, or MAX_MEMBERS cut them
//   note               says MAX_MEMBERS cut them, and how many member Cargo.toml files
//                      couldn't be read; null when neither happened
// Never rejects: anything that goes wrong answers the project unchanged.
export async function cargoProject(project, io) {
  try {
    if (!project || project.error || typeof project.folder !== "string") return project;
    let root = null;
    if (project.workspace) root = { folder: project.folder, manifest: project };
    else {
      const candidates = typeof project.root === "string"
        ? [collapse(project.folder, project.root)]
        : project.folder === "/" ? [] : list(io.parents(parentOf(project.folder)));
      const manifests = await Promise.all(candidates.map(async (folder) => ({ folder, manifest: parseSafely(await readSafely(io, `${folder}/Cargo.toml`), null) })));
      root = manifests.find((m) => m.manifest?.workspace) ?? null;
    }
    if (!root) return project;
    const { members, exclude } = root.manifest.workspace;
    // Cargo treats a crate its root excludes as its own root.
    if (project.folder !== root.folder && exclude.some((e) => under(project.folder, collapse(root.folder, e)))) return project;
    const expanded = await expandMembers(root.folder, members, exclude, io.list);
    const folders = [...new Set([...(root.manifest.virtual ? [] : [root.folder]), ...expanded.folders])];
    const membersIncomplete = expanded.unlisted || expanded.capped;
    if (project.folder !== root.folder && !folders.includes(project.folder)) {
      // Cargo refuses to build a crate its root's members don't name; its own lock is the
      // best guess. But a listing that came up short may simply have missed it.
      if (!membersIncomplete) return project;
      folders.push(project.folder);
    }
    const inherited = root.manifest.workspace;
    const parsed = await Promise.all(folders.map(async (folder) => {
      const path = `${folder}/Cargo.toml`;
      return { folder, path, manifest: parseSafely(await readSafely(io, path), inherited) };
    }));
    const unread = parsed.filter((c) => !c.manifest || c.manifest.error).length;
    const notes = [
      expanded.capped ? `Showing the first ${MAX_MEMBERS} workspace members.` : null,
      unread === 1 ? "1 member Cargo.toml couldn't be read." : null,
      unread > 1 ? `${unread} member Cargo.toml files couldn't be read.` : null,
    ].filter(Boolean);
    const crates = parsed.filter((c) => typeof c.manifest?.name === "string").map(({ folder, path, manifest }) => ({
      name: manifest.name, version: manifest.version, folder, path, deps: manifest.deps, skipped: manifest.skipped, local: manifest.local,
    }));
    const gathered = {
      workspaceFolder: root.folder,
      crates,
      fingerprint: crates.map((c) => [c.path, c.version, c.deps, c.local]),
      membersIncomplete,
      note: notes.length ? notes.join(" ") : null,
    };
    if (project.folder === root.folder) {
      return {
        ...project, ...gathered, layout: "workspace", name: project.name ?? basename(root.folder),
        skipped: [...new Set(crates.flatMap((c) => c.skipped))],
      };
    }
    const own = crates.find((c) => c.folder === project.folder);
    return {
      ...project, ...gathered, layout: "crate",
      ...(own ? { name: own.name, version: own.version, deps: own.deps, skipped: own.skipped, local: own.local } : {}),
    };
  } catch {
    return project;
  }
}

export const CARGO_LOCKFILES = [{ file: "Cargo.lock", resolver: cargoResolver }];

export const CARGO_NOTE = "No Cargo.lock, so only direct dependencies are shown.";
