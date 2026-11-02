// Everything here is plain data in and out, with no Herdr imports, so `npm test`
// can run it under Node without the app.

import { GO_LOCKFILES, GO_NOTE, parseGoMod } from "./go.js";
import { GRADLE_COMPANIONS, GRADLE_LOCKFILES, GRADLE_MODULES, GRADLE_NOTE, parseGradleGroovy, parseGradleKts } from "./gradle.js";
import { MAVEN_NOTE, parsePom } from "./maven.js";
import { PYTHON_LOCKFILES, PYTHON_NOTE, parsePyproject, parseRequirements } from "./python.js";

export const MCP_URL = "https://greenflagged.dev/mcp";
export const packageUrl = (name) => `https://greenflagged.dev/packages/npm/${name}`;
export const MAX_ENTRIES = 500; // audit_manifest's own cap
export const AUDIT_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_AUDITS = 20;
export const SIGN_IN_COMMAND = ["npm", "login", "--registry=https://greenflagged.dev/npm/"];
const MAX_PARENTS = 12;

// A row's level, worst first. `pending` and `not_imported` are not bad news about
// the package: nobody has finished reviewing it.
const LEVELS = {
  rejected: "blocked",
  uninstallable: "blocked",
  not_in_upstream: "blocked",
  greenflagged_with_overrides: "attention",
  pending: "attention",
  not_imported: "attention",
  greenflagged: "ok",
};
export const LEVEL_ORDER = ["blocked", "attention", "ok"];

const LABELS = {
  rejected: "rejected",
  uninstallable: "uninstallable",
  not_in_upstream: "not on npm",
  greenflagged_with_overrides: "needs overrides",
  pending: "in review",
  not_imported: "not imported",
  greenflagged: "greenflagged",
};

// The manifest names to look for. An audited entry reads its file into the rows
// shape below. An unaudited one only names the language, so the panel can say it
// can't check it rather than that there is nothing to check. PyPI checks are still
// off on the registry, so Python is unaudited for now.
//
// An unaudited entry gains a dependency tree by carrying these optional fields,
// each exported from one module per language (python.js, go.js, maven.js, gradle.js),
// so this list stays the only registry:
//   parse(text, { files, root, folder })
//                -> { name, deps: [{ name, constraint, dev, extras?, marker? }], skipped?, undeclared?, language? }
//                   | { error }; `undeclared: true` means the file has no dependency tables
//                   at all, and findManifest then tries a later manifest of the same id.
//                   `language` names the language when the file says more than the entry
//                   (Gradle and Maven answer "Kotlin"); it lands on the project, and the
//                   panel shows it instead of `name`. `files`, `root` and `folder` are
//                   the companions below; parsers that need none ignore them. A result
//                   must never carry `root`, `folder`, `path` or `ecosystem`: it is spread
//                   into the project and would overwrite them.
//   lockfiles    -> [{ file, resolver(text, project) -> { resolve, count?, direct? } | { error } }], tried
//                   in order in the manifest's folder; `resolve` is the contract in tree.js, and
//                   `direct` replaces the manifest's directs when the lock records the project
//                   (and may add a `group: true` heading row, as Go's "indirect" row does).
//                   A manifest may be its own lockfile (Go lists go.mod), and is then read
//                   twice. A resolver gets only the lock's text and the project: no file
//                   reader and no machine, so it can't read further files today.
//   companions   -> { root: [names], files: [relative paths] }, files the parser needs from
//                   the build's root folder. From the manifest's folder upward, findManifest
//                   reads the `root` names in each folder; the first folder holding any of
//                   them is the build root, and the `files` are read from that one folder.
//                   The walk visits the manifest's folder and then only ancestors strictly
//                   below home, so home and `/` are read for a root marker only when the
//                   manifest itself is there; with no marker anywhere, the manifest's
//                   folder is the root. Every name lands in
//                   `parse`'s `files` (null when missing), and the root becomes
//                   `project.root`, which the panel watches. A project from an entry
//                   without companions has `root` equal to `folder`.
//   note         -> shown instead of the no-lockfile sentence
//   modules      -> { files: [names], list(project) -> [{ name, folder }], parse(text, file, context) -> edges | null },
//                   a multi-module build's members, opened only when the manifest is the
//                   build root's. `list` picks dep rows and a folder relative to the root
//                   for each; findManifest reads the first of `files` there and turns the
//                   row into a `group: true` heading whose `members` are `parse`'s edges.
//                   A module with no build file, or one `parse` refuses, stays a plain row.
// Parsers never get a file reader: every file the panel can read is a static name on an
// entry (`file`, `lockfiles`, `companions`, `modules.files`), so the README's list of
// files read is complete by construction. The one folder a manifest chooses is a
// module's, and gradleModuleFolder (gradle.js) keeps it under the build root: plain
// folder names only, never `..`, at most MAX_GRADLE_MODULES of them.
// Both Python entries share one base, so their lockfiles and note can't drift apart, and
// so do the three Java/Kotlin entries.
const PYTHON = { id: "pypi", name: "Python", audited: false, lockfiles: PYTHON_LOCKFILES, note: PYTHON_NOTE };
const MAVEN = { id: "maven", name: "Java/Kotlin", audited: false };
const GRADLE = { ...MAVEN, lockfiles: GRADLE_LOCKFILES, companions: GRADLE_COMPANIONS, modules: GRADLE_MODULES, note: GRADLE_NOTE };
export const ECOSYSTEMS = [
  { id: "npm", name: "npm", file: "package.json", audited: true, parse: parsePackageJson },
  { ...PYTHON, file: "pyproject.toml", parse: parsePyproject },
  { ...PYTHON, file: "requirements.txt", parse: parseRequirements },
  { id: "cargo", name: "Rust", file: "Cargo.toml", audited: false },
  { id: "go", name: "Go", file: "go.mod", audited: false, parse: parseGoMod, lockfiles: GO_LOCKFILES, note: GO_NOTE },
  { ...MAVEN, file: "pom.xml", parse: parsePom, note: MAVEN_NOTE },
  { ...GRADLE, file: "build.gradle.kts", parse: parseGradleKts },
  { ...GRADLE, file: "build.gradle", parse: parseGradleGroovy },
];

// Files whose change means the panel should look again: manifests, lockfiles and companions.
export const WATCHED_FILES = [...new Set(ECOSYSTEMS.flatMap((e) => [
  e.file, ...(e.lockfiles ?? []).map((l) => l.file), ...(e.companions?.root ?? []), ...(e.companions?.files ?? []),
]))];

// Folders to try from `cwd` upward, stopping after `home` when it is an ancestor.
export function parentFolders(cwd, home) {
  const folders = [];
  let dir = cwd.replace(/\/+$/, "") || "/";
  for (let i = 0; i < MAX_PARENTS; i++) {
    folders.push(dir);
    if (dir === "/" || dir === home) break;
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
  }
  return folders;
}

// The nearest folder with any manifest wins. Within it, an audited manifest beats
// an unaudited one, then list order decides. `read` answers a path's text, or null.
// The audited files are read first and the rest only when none of them is there,
// so a folder with a package.json costs one read.
export async function findManifest(cwd, home, read) {
  const tiers = [ECOSYSTEMS.filter((e) => e.audited), ECOSYSTEMS.filter((e) => !e.audited)];
  for (const folder of parentFolders(cwd, home)) {
    for (const tier of tiers) {
      const texts = await Promise.all(tier.map((e) => read(`${folder}/${e.file}`)));
      const i = texts.findIndex((text) => text !== null);
      if (i === -1) continue;
      const ecosystem = tier[i], path = `${folder}/${ecosystem.file}`;
      const { root, files } = await readCompanions(ecosystem.companions, folder, home, read);
      const project = { folder, path, root, ecosystem, ...parseSafely(ecosystem, texts[i], { files, root, folder }) };
      if (ecosystem.modules && root === folder && Array.isArray(project.deps)) {
        project.deps = await openModules(ecosystem.modules, project, files, read);
      }
      // A pyproject.toml with no dependency tables declares them elsewhere; a
      // requirements.txt beside it is the next best source, under the pyproject's name.
      const j = project.undeclared ? tier.findIndex((e, k) => k > i && e.id === ecosystem.id && texts[k] !== null) : -1;
      if (j === -1) return project;
      const fallback = { folder, path: `${folder}/${tier[j].file}`, root: folder, ecosystem: tier[j], ...parseSafely(tier[j], texts[j], { files: {}, root: folder, folder }) };
      return { ...fallback, name: fallback.name ?? project.name ?? null };
    }
  }
  return null;
}

// A root's module rows → heading rows over each module's own dependencies (see
// `modules` on ECOSYSTEMS). Modules are read in parallel; within one, the first of
// `files` that exists wins. A parser that throws leaves the row as it was.
async function openModules(modules, project, files, read) {
  const opened = new Map(await Promise.all(modules.list(project).map(async ({ name, folder }) => {
    const moduleFolder = `${project.root}/${folder}`;
    for (const file of modules.files) {
      const text = await read(`${moduleFolder}/${file}`);
      if (text === null) continue;
      let edges = null;
      try { edges = modules.parse(text, file, { files, root: project.root, folder: moduleFolder }); } catch { edges = null; }
      return [name, edges];
    }
    return [name, null];
  })));
  return project.deps.map((dep) => {
    const edges = opened.get(dep.name);
    return edges ? { name: dep.name, version: null, constraint: null, dev: false, group: true, members: edges } : dep;
  });
}

// An entry's companions (see ECOSYSTEMS) → { root, files }. Without companions the
// root is the manifest's folder and nothing is read.
async function readCompanions(companions, folder, home, read) {
  if (!companions) return { root: folder, files: {} };
  const markers = companions.root ?? [], names = companions.files ?? [];
  const candidates = parentFolders(folder, home).filter((f, i) => i === 0 || (f !== home && f !== "/"));
  const files = {};
  let root = folder;
  for (const candidate of candidates) {
    const texts = await Promise.all(markers.map((m) => read(`${candidate}/${m}`)));
    if (texts.some((t) => t !== null)) {
      root = candidate;
      markers.forEach((m, k) => { files[m] = texts[k]; });
      break;
    }
  }
  for (const m of markers) if (!(m in files)) files[m] = null;
  const texts = await Promise.all(names.map((name) => read(`${root}/${name}`)));
  names.forEach((name, k) => { files[name] = texts[k]; });
  return { root, files };
}

// Returns the last valid project for the same file on the same machine as `failed`, or
// null when there is none (a different file, another machine, or no valid read yet). A
// manifest being edited is often malformed for a moment, so on a parse error the panel
// keeps showing that last valid project, dimmed and marked stale. A project's machine is
// its `on` field: null means this machine, and the panel sets it after findManifest. The
// panel holds the last valid project in memory only; it is lost when the project changes
// or the panel closes.
export function lastValidProject(previous, failed) {
  if (!previous || previous.error || !failed) return null;
  return previous.path === failed.path && (previous.on ?? null) === (failed.on ?? null) ? previous : null;
}
export const staleNote = (error) => `${error} · showing the last valid version`;

// A parser should answer { error } on bad input; one that throws gets the same
// { error } result, so findManifest still returns the project and its message names
// the manifest file.
function parseSafely(ecosystem, text, companions) {
  if (!ecosystem.parse) return {};
  try {
    return ecosystem.parse(text, companions) ?? {};
  } catch (error) {
    return { error: `${ecosystem.file} could not be read: ${String(error?.message ?? error)}` };
  }
}

// Specs that never reach a registry, so a verdict on them would mean nothing.
const LOCAL_SPEC = /^(workspace|file|link|portal|catalog|git|git\+\w+|github|https?):|^\.{0,2}\/|^~\/|^[\w.-]+\/[\w.-]+(#.*)?$/;

export function parsePackageJson(text) {
  let json;
  try { json = JSON.parse(text); } catch { return { error: "package.json is not valid JSON" }; }
  const deps = new Map(), skipped = [];
  const add = (block, dev) => {
    for (const [name, spec] of Object.entries(block ?? {})) {
      if (deps.has(name) || typeof spec !== "string") continue;
      const alias = /^npm:(@?[^@]+)(?:@(.*))?$/.exec(spec);
      if (alias) deps.set(name, { name: alias[1], constraint: alias[2] || "*", dev });
      else if (LOCAL_SPEC.test(spec)) skipped.push(name);
      else deps.set(name, { name, constraint: spec, dev });
    }
  };
  add(json.dependencies, false);
  add(json.optionalDependencies, false);
  add(json.devDependencies, true);
  return { name: typeof json.name === "string" ? json.name : null, deps: [...deps.values()], skipped };
}

export function auditRequest(deps) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "audit_manifest",
      arguments: { manifest: Object.fromEntries(deps.slice(0, MAX_ENTRIES).map((d) => [d.name, d.constraint])) },
    },
  };
}

// `version` only when the manifest pins one: a range has no single version to
// queue, and the registry takes no version to mean latest.
export function requestCall(name, constraint) {
  const pinned = /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(constraint);
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "request_package", arguments: pinned ? { name, version: constraint } : { name } },
  };
}

// The server answers as JSON or as one SSE event, depending on the transport.
export function parseToolResponse(body) {
  const data = body.trimStart().startsWith("{")
    ? body
    : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
  if (!data) throw new Error("Greenflagged sent an empty answer");
  const reply = JSON.parse(data);
  if (reply.error) throw new Error(reply.error.message ?? "Greenflagged refused the audit");
  const text = reply.result?.content?.find((c) => c.type === "text")?.text;
  if (reply.result?.isError) throw new Error(text ?? "Greenflagged refused the call");
  if (!text) throw new Error("Greenflagged sent no result");
  return JSON.parse(text);
}

const numbers = (text) => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number) ?? null;

function isOlder(version, constraint) {
  const a = numbers(version), b = numbers(constraint);
  if (!a || !b) return false;
  const i = a.findIndex((n, index) => n !== b[index]);
  return i !== -1 && a[i] < b[i];
}

// The first remediation is the registry's recommendation.
function remedy(entry) {
  const best = entry?.remediation?.[0];
  if (best?.relation === "fixed_by") return best.nearest_greenflagged_version ? `Fixed in ${best.nearest_greenflagged_version}.` : null;
  return best?.target ? `Use ${best.target} instead.` : null;
}

export function rows(deps, audit) {
  return deps.slice(0, MAX_ENTRIES).map((dep) => {
    const entry = audit[dep.name];
    const status = entry?.status ?? "not_imported";
    const deprecated = status === "greenflagged" && !entry?.version;
    const changed = status === "greenflagged" && Boolean(entry?.proposed_constraint);
    const older = changed && isOlder(entry.version, dep.constraint);
    // A dist-tag such as `next`: the registry can't read it, which says nothing about the package.
    const unread = status === "rejected" && entry?.reason?.detail === "unparseable constraint";
    return {
      name: dep.name,
      dev: dep.dev,
      constraint: dep.constraint,
      status,
      level: deprecated || changed || unread ? "attention" : LEVELS[status] ?? "attention",
      label: deprecated ? "deprecated" : older ? "older version only" : changed ? "needs upgrade"
        : unread ? "can't check" : LABELS[status] ?? status,
      version: entry?.version ?? null,
      latest: entry?.latest_greenflagged ?? null,
      detail: deprecated ? "Every greenflagged version is deprecated upstream."
        // Exact, because a caret could reach the very versions that aren't approved.
        : older ? `Only older versions are greenflagged. Pin ${entry.version}.`
        : changed ? `No greenflagged version in range. Try ${entry.proposed_constraint}.`
        : unread ? `The registry can't read "${dep.constraint}". Use a version range.`
        : [entry?.reason?.detail, remedy(entry)].filter(Boolean).join(" ") || null,
    };
  }).sort((a, b) =>
    LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.name.localeCompare(b.name));
}

// What a finished request means for its row. Repeat requests are pointless for all
// of these, so each is remembered. already_greenflagged isn't: the next audit shows it.
const REQUEST_OUTCOMES = {
  queued: { level: "attention", label: "requested", detail: "Queued for import and review." },
  already_queued: { level: "attention", label: "requested", detail: "Queued for import and review." },
  rejected: { level: "blocked", label: "rejected", detail: "The registry has already rejected this." },
  not_in_upstream: { level: "blocked", label: "not on npm", detail: "npm has no such package or version." },
};

export const rememberRequest = (status) => status in REQUEST_OUTCOMES;

// Only `not_imported` rows take a remembered outcome, so an audit that has moved on
// wins. The rest stay requestable.
export function withRequests(list, requested) {
  const next = list.map((row) => {
    if (row.status !== "not_imported") return row;
    const outcome = REQUEST_OUTCOMES[requested[row.name]];
    return outcome ? { ...row, ...outcome } : { ...row, requestable: true };
  });
  return next.sort((a, b) =>
    LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.name.localeCompare(b.name));
}

// Audits by project, so flipping between projects doesn't re-audit each time.
export function cachedAudit(cache, key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at < AUDIT_TTL_MS) return hit.list;
  cache.delete(key);
  return null;
}

export function storeAudit(cache, key, list, now) {
  cache.delete(key); // re-adding keeps the oldest first in the Map
  cache.set(key, { list, at: now });
  if (cache.size > MAX_CACHED_AUDITS) cache.delete(cache.keys().next().value);
}

// The layout block showing `mod`, or null when it isn't docked: a mod pane or an
// overlay has no block to resize or hide.
export function findBlock(node, mod) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === mod && node.id) return node.id;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const id = findBlock(child, mod);
    if (id) return id;
  }
  return null;
}

export function summarize(list) {
  const counts = { blocked: 0, attention: 0, ok: 0 };
  for (const row of list) counts[row.level]++;
  return counts;
}

// The token as ~/.npmrc holds it: a literal, or `${VAR}` for `env` to resolve.
// `npm login` writes it under whichever of the registry's two hosts it was given.
export function tokenFromNpmrc(text, env = () => null) {
  const line = /^\s*\/\/(?:greenflagged\.dev\/npm|npm\.greenflagged\.dev)\/:_authToken\s*=\s*(\S+)\s*$/m.exec(text ?? "");
  if (!line) return null;
  const variable = /^\$\{(\w+)\}$/.exec(line[1]);
  return variable ? env(variable[1]) : line[1];
}
