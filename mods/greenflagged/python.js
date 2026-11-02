// Python manifests and lockfiles for the plain dependency tree: pyproject.toml and
// requirements.txt in, uv.lock and poetry.lock read into the package list that
// tree.js's graphResolver walks. Plain data in and out, with no Herdr imports, so
// `npm test` can run it under Node without the app. Nothing here throws, and every
// pass over file-sized input is a single one: regexes only ever see one requirement
// string or one line.
//
// The package lists (`uvPackages`, `poetryPackages`) are the piece a future PyPI
// audit reuses: they are the locked name@version set, with names normalized the way
// PyPI compares them.
//
// Python edge cases, so RECIPE.md can point here instead of growing:
// - A direct dependency uv splits by environment marker (numpy at four versions behind
//   `python_full_version` markers) is one row per locked version, each with its marker,
//   and the counts line counts each row as a direct.
// - uv's `[package.dev-dependencies]` is the lock's name for `[dependency-groups]`; an
//   included group's rows appear under both groups, and merge into one row.
// - poetry can lock two versions of one package (per marker) with no root entry to
//   say which a direct means; the first in the file is shown and the other is not.
// - Rows merge on name@version, so two edges with different markers that meet on one
//   row show the first marker. poetry's array-form entries and a uv package listed
//   under both `dependencies` and a dev group at one version can both trigger this.
// - A uv workspace member has no lock beside its pyproject.toml (the lock is at the
//   workspace root), so it shows its directs with the no-lockfile note.
// - Markers are shown, never evaluated; requirements.txt's ${VAR} expansion isn't done.

import { parseToml } from "./toml.js";
import { graphResolver, mergeDirect } from "./tree.js";

const isTable = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const truncate = (text) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

// PEP 503: case and runs of `-`, `_`, `.` don't distinguish two names.
export function normalizeName(name) {
  if (typeof name !== "string") return null;
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*/;

// One PEP 508 requirement string, in the subset lockfiles and manifests use:
// name, [extras], a version constraint (optionally in parentheses), `; marker`, or
// `name @ url`. Answers { name, constraint, extras, marker } or { name, url: true,
// extras, marker }, or null when the string doesn't read as one.
export function parseRequirement(text) {
  if (typeof text !== "string") return null;
  let head = text.trim(), marker = null, quote = null;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
    else if (c === ";") { marker = head.slice(i + 1).trim() || null; head = head.slice(0, i).trim(); break; }
  }
  const named = NAME.exec(head);
  if (!named) return null;
  const name = normalizeName(named[1]);
  let rest = head.slice(named[0].length), extras = [];
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return null;
    extras = [...new Set(rest.slice(1, close).split(",").map((e) => normalizeName(e.trim())).filter(Boolean))];
    rest = rest.slice(close + 1).trim();
  }
  if (rest.startsWith("@")) return { name, url: true, extras, marker };
  if (rest.startsWith("(") && rest.endsWith(")")) rest = rest.slice(1, -1);
  const constraint = rest.trim() || "*";
  if (constraint !== "*" && !/^[<>=!~]/.test(constraint)) return null;
  return { name, constraint, extras, marker };
}

// A direct dependency in parse's shape; `extras` and `marker` only when there are some.
const direct = (name, constraint, dev, extras, marker) => ({
  name, constraint, dev, ...(extras?.length ? { extras } : {}), ...(marker ? { marker } : {}),
});

// One poetry dependency spec: "^1.0", { version, extras, markers }, { path | git | url | file },
// or an array of tables (one per marker). Answers a direct, "skip" for a local or VCS
// source, or null for a shape it doesn't know.
function poetrySpec(name, spec, dev) {
  if (typeof spec === "string") return direct(name, spec, dev);
  if (Array.isArray(spec)) {
    const versions = spec.filter(isTable).map((s) => s.version).filter((v) => typeof v === "string");
    return direct(name, versions.join(" || ") || "*", dev);
  }
  if (!isTable(spec)) return null;
  if (typeof spec.version !== "string" && ["path", "git", "url", "file"].some((k) => k in spec)) return "skip";
  const extras = strings(spec.extras).map(normalizeName);
  return direct(name, typeof spec.version === "string" ? spec.version : "*", dev, extras, typeof spec.markers === "string" ? spec.markers : null);
}

// pyproject.toml → { name, deps, skipped }, or { name, deps: [], skipped: [], undeclared: true }
// when no dependency table exists at all (a `dynamic = ["dependencies"]` project, or one
// with only [build-system]), so findManifest can try requirements.txt instead.
// The first section that names a package wins, in this order: [project].dependencies,
// [project.optional-dependencies], [dependency-groups], then poetry's main, group and
// legacy dev tables.
export function parsePyproject(text) {
  const parsed = parseToml(text);
  if (parsed.error) return { error: parsed.line ? `pyproject.toml ${parsed.error}` : `pyproject.toml: ${parsed.error}` };
  const doc = parsed.value, project = isTable(doc.project) ? doc.project : null;
  const poetry = isTable(doc.tool) && isTable(doc.tool.poetry) ? doc.tool.poetry : null;
  const deps = new Map(), skipped = [];
  let declared = false;
  const add = (dep) => { if (dep && !deps.has(dep.name)) deps.set(dep.name, dep); };
  const requirement = (text, dev) => {
    const req = parseRequirement(text);
    if (!req) return;
    if (req.url) skipped.push(req.name);
    else add(direct(req.name, req.constraint, dev, req.extras, req.marker));
  };

  if (project && Array.isArray(project.dependencies)) {
    declared = true;
    for (const text of strings(project.dependencies)) requirement(text, false);
  }
  if (project && isTable(project["optional-dependencies"])) {
    declared = true;
    for (const list of Object.values(project["optional-dependencies"])) for (const text of strings(list)) requirement(text, false);
  }
  if (isTable(doc["dependency-groups"])) {
    declared = true;
    const groups = doc["dependency-groups"], visited = new Set();
    const visit = (group) => {
      if (visited.has(group) || !Array.isArray(groups[group])) return;
      visited.add(group);
      for (const item of groups[group]) {
        if (typeof item === "string") requirement(item, true);
        else if (isTable(item) && typeof item["include-group"] === "string") visit(item["include-group"]);
      }
    };
    for (const group of Object.keys(groups)) visit(group);
  }
  const poetryTable = (table, dev) => {
    if (!isTable(table)) return;
    declared = true;
    for (const [key, spec] of Object.entries(table)) {
      if (key === "python") continue;
      const name = normalizeName(key), dep = poetrySpec(name, spec, dev);
      if (dep === "skip") skipped.push(name);
      else add(dep);
    }
  };
  if (poetry) {
    poetryTable(poetry.dependencies, false);
    if (isTable(poetry.group)) {
      for (const [group, table] of Object.entries(poetry.group)) if (isTable(table)) poetryTable(table.dependencies, group !== "main");
    }
    poetryTable(poetry["dev-dependencies"], true);
  }

  const name = typeof project?.name === "string" ? project.name : typeof poetry?.name === "string" ? poetry.name : null;
  if (!declared) return { name, deps: [], skipped: [], undeclared: true };
  return { name, deps: [...deps.values()], skipped };
}

const URL_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const isPath = (token) => token === "." || /^(\/|\.\/|\.\.\/|~)/.test(token) || /\.(whl|tar\.gz|zip)$/i.test(token);
const optionValue = (line, short, long) => {
  const m = new RegExp(`^(?:${short}\\s*|${long}(?:\\s+|=))(\\S.*)$`).exec(line);
  return m ? m[1].trim() : null;
};

// requirements.txt → { name: null, deps, skipped }. `skipped` holds what main.js counts
// as local or git: editable installs, `-r` includes (a file of dependencies this
// doesn't read), `name @ url`, bare URLs and paths. `-c` constraint files add no
// dependency, and other options and unreadable lines are left out silently.
export function parseRequirements(text) {
  const deps = new Map(), skipped = [];
  const lines = [];
  let pending = "";
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.endsWith("\\")) { pending += line.slice(0, -1); continue; }
    lines.push(pending + line);
    pending = "";
  }
  if (pending) lines.push(pending);
  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("-")) {
      const local = optionValue(line, "-e", "--editable") ?? optionValue(line, "-r", "--requirement");
      if (local) skipped.push(truncate(local));
      continue;
    }
    const requirement = line.split(" --")[0].trim();
    if (URL_START.test(requirement) || isPath(requirement)) { skipped.push(truncate(requirement)); continue; }
    const req = parseRequirement(requirement);
    if (!req) continue;
    if (req.url) { skipped.push(truncate(requirement)); continue; }
    if (!deps.has(req.name)) deps.set(req.name, direct(req.name, req.constraint, false, req.extras, req.marker));
  }
  return { name: null, deps: [...deps.values()], skipped };
}

// Drops what the tree never reads from a lockfile before it is parsed: the items of
// uv's `wheels = [` and poetry's `files = [` arrays, and uv's `sdist = ` key. Those are
// 92% of a real uv.lock. A block opens only on a line that is exactly `wheels = [` or
// `files = [` and closes on a line that is exactly `]`; both are kept, so the array
// stays valid and empty. A line that doesn't match exactly is kept, so a format change
// makes this strip less, never strip something else.
export function stripLockFiles(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (inBlock) {
      if (line === "]") { inBlock = false; out.push(raw); }
    } else if (line === "wheels = [" || line === "files = [") {
      inBlock = true;
      out.push(raw);
    } else if (!line.startsWith("sdist = ")) out.push(raw);
  }
  return out.join("\n");
}

// A uv dependency entry: { name, version?, marker?, extra? }.
function uvEdge(entry) {
  if (!isTable(entry) || typeof entry.name !== "string") return null;
  return {
    name: normalizeName(entry.name),
    version: typeof entry.version === "string" ? entry.version : null,
    marker: typeof entry.marker === "string" ? entry.marker : null,
    extras: strings(entry.extra).map(normalizeName),
  };
}

const uvEdges = (list) => (Array.isArray(list) ? list.map(uvEdge).filter(Boolean) : []);
const uvGroups = (table) => new Map(isTable(table) ? Object.entries(table).map(([k, list]) => [normalizeName(k), uvEdges(list)]) : []);

// uv.lock's [[package]] entries with a name and version, in file order.
export function uvPackages(toml) {
  const list = Array.isArray(toml?.package) ? toml.package : [];
  return list.filter((p) => isTable(p) && typeof p.name === "string" && typeof p.version === "string").map((p) => ({
    name: normalizeName(p.name),
    version: p.version,
    source: isTable(p.source) ? p.source : null,
    dependencies: uvEdges(p.dependencies),
    optionalDependencies: uvGroups(p["optional-dependencies"]),
    devDependencies: uvGroups(p["dev-dependencies"]),
  }));
}

// One poetry [package.dependencies] value as edges: "1.0", { version, markers, extras,
// optional }, or an array of those. Edges carry no version: poetry locks don't say
// which locked version a dependency means, so graphResolver takes the first.
function poetryEdges(name, spec) {
  if (typeof spec === "string") return [{ name, constraint: spec }];
  const tables = Array.isArray(spec) ? spec.filter(isTable) : isTable(spec) ? [spec] : [];
  return tables.map((t) => ({
    name,
    constraint: typeof t.version === "string" ? t.version : null,
    marker: typeof t.markers === "string" ? t.markers : null,
    extras: strings(t.extras).map(normalizeName),
    optional: t.optional === true,
  }));
}

// poetry.lock's [[package]] entries in uvPackages' shape. A dependency marked
// `optional = true` is left out of `dependencies`: it is installed only through an
// extra, and [package.extras] says which extra pulls in what.
export function poetryPackages(toml) {
  const list = Array.isArray(toml?.package) ? toml.package : [];
  return list.filter((p) => isTable(p) && typeof p.name === "string" && typeof p.version === "string").map((p) => {
    const dependencies = [];
    if (isTable(p.dependencies)) {
      for (const [key, spec] of Object.entries(p.dependencies)) {
        for (const { optional, ...edge } of poetryEdges(normalizeName(key), spec)) if (!optional) dependencies.push(edge);
      }
    }
    const optionalDependencies = new Map();
    if (isTable(p.extras)) {
      for (const [extra, reqs] of Object.entries(p.extras)) {
        const edges = strings(reqs).map(parseRequirement).filter((r) => r && !r.url)
          .map((r) => ({ name: r.name, constraint: r.constraint, marker: r.marker }));
        optionalDependencies.set(normalizeName(extra), edges);
      }
    }
    return { name: normalizeName(p.name), version: p.version, source: null, dependencies, optionalDependencies, devDependencies: new Map() };
  });
}

const NO_PACKAGES = "no [[package]] entries with a name and version";

function readLock(text, toPackages) {
  const parsed = parseToml(stripLockFiles(text));
  if (parsed.error) return { error: parsed.error };
  const packages = toPackages(parsed.value);
  return packages.length ? { packages } : { error: NO_PACKAGES };
}

const isProjectSource = (source) => Boolean(source) && ("editable" in source || "virtual" in source);

// uv.lock → { resolve, direct? }. The project itself is a package in the lock, with an
// editable or virtual source; when it can be found, its own dependency lists become the
// directs, so a split dependency shows each locked version with its marker.
export function uvResolver(text, project) {
  const read = readLock(text, uvPackages);
  if (read.error) return read;
  const { packages } = read, candidates = packages.filter((p) => isProjectSource(p.source));
  const want = normalizeName(project?.name);
  const root = (want && candidates.find((p) => p.name === want)) || (candidates.length === 1 ? candidates[0] : null);
  const { resolve } = graphResolver(packages);
  if (!root) return { resolve };
  const row = (dev) => (edge) => ({ ...edge, dev });
  const rows = [
    ...root.dependencies.map(row(false)),
    ...[...root.optionalDependencies.values()].flat().map(row(false)),
    ...[...root.devDependencies.values()].flat().map(row(true)),
  ];
  return { resolve, direct: mergeDirect(project?.deps ?? [], rows) };
}

// poetry.lock → { resolve }. poetry doesn't lock the project itself, so the directs
// are the manifest's and resolve by name.
export function poetryResolver(text, _project) {
  const read = readLock(text, poetryPackages);
  if (read.error) return read;
  return graphResolver(read.packages);
}

export const PYTHON_LOCKFILES = [
  { file: "uv.lock", resolver: uvResolver },
  { file: "poetry.lock", resolver: poetryResolver },
];

export const PYTHON_NOTE = "No uv.lock or poetry.lock beside the manifest, so only direct dependencies are shown.";
