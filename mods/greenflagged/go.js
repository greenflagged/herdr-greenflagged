// Go's go.mod for the plain dependency tree. Plain data in and out, with no Herdr
// imports, so `npm test` can run it under Node without the app. Nothing here throws,
// whatever the input, text or not, and nothing is run: no `go mod graph`, no Go
// toolchain, no network. The file is read one line at a time, and no regex ever sees
// more than one line.
//
// go.mod is both the manifest and the lockfile: it pins a version for every module it
// lists, but records no module-to-module edges. Those come from Go's module cache: every
// downloaded module's own go.mod sits at
// `<GOMODCACHE>/cache/download/<escaped path>/@v/<escaped version>.mod`. The lockfile
// entry declares that cache (GO_MODULE_CACHE); main.js and cache.js find it on the
// project's machine and hand goCacheResolver a reader confined to it. The tree shows the
// direct modules, then one collapsed "indirect" row whose children are the `// indirect`
// modules, and every module row opens into the modules its own `.mod` requires. go.mod
// is registered as its own lockfile, so it is read twice per refresh: once as the
// manifest (the header and the rail) and once as the lock (the tree). A save between the
// two reads gives one refresh where they disagree; go.mod is a watched file, so the next
// refresh is consistent.
//
// Module cache edge cases:
// - Outside the probe (below), a `.mod` file is read only when its row opens. cache.js keeps texts up to
//   16 Ki chars for the session, so such a `.mod` is read once; a longer one is read
//   again each time. A first build with nothing open reads only `cache/lock`, plus the
//   first module's `.mod` when `cache/lock` is missing (the probe fallback below).
// - Children show the version the project's go.mod selects for that path, not the one
//   the `.mod` asks for, which stays the row's constraint. Since Go 1.17 a tidy go.mod
//   lists every module in the build; a module it doesn't list shows the version asked
//   for (no MVS is computed).
// - The project's `replace` lines apply to children with the same precedence as to its
//   own requires; a child replaced by a local path is dropped, and so is a child naming
//   the project's own module. A dependency's own `replace` and `exclude` lines are
//   ignored, as Go ignores them outside the main module. All of a `.mod`'s requires,
//   `// indirect` or not, become children.
// - A module whose `.mod` isn't in the cache becomes, once opened, a leaf tagged
//   `not downloaded`; one whose path or version fails the allowlist (goModCacheFile), or
//   whose `.mod` is malformed, a leaf tagged `unreadable`. A read that fails (rejects)
//   leaves the row closed with the failure note, and the next click retries.
// - Paths and versions are third-party data. Each is escaped as Go does (an uppercase
//   letter becomes `!` and the lowercase letter) and checked against an allowlist before
//   any file path is built; cache.js checks the relative path again before reading.
// - The probe: `cache/lock`, and when that is missing, the first module's `.mod` (read
//   at build time, bypassing the memo). No cache folder, or one with neither file,
//   gives the flat view with GO_NO_CACHE_NOTE; a probe read that fails gives the flat
//   view with the reason. ↻ and the 15-minute timer rebuild either (tree.cacheBacked).
// - The folder comes from GOMODCACHE and GOPATH as `printenv` sees them on the
//   project's machine, then the home folder (Herdr's own for a local project, HOME
//   from `printenv` on a remote one). A GOMODCACHE set with `go env -w` (Go's own env file) isn't read;
//   if an old ~/go/pkg/mod still holds a `cache/lock`, that stale cache is read instead.
// - "M total" stays go.mod's module count: the cache view loads children lazily and
//   never walks the whole graph.
//
// Go edge cases, so RECIPE.md can point here instead of growing:
// - "M total" counts the modules go.mod lists (direct and `// indirect`), each once,
//   minus those replaced by a local path. For a tidy module with `go 1.17` or later that
//   is every module providing a package the build imports; an older or untidy go.mod
//   lists fewer, and none lists the whole pruned-out module graph.
// - A module required more than once: a direct line beats an `// indirect` one whatever
//   the order, and within the winning kind the first line's version is shown.
// - `replace` applies wherever it sits in the file, to direct and indirect modules alike.
//   `replace a v1 => …` applies only to a@v1, and beats a plain `replace a => …`.
//   A replacement by another module shows the replacement's path and version, with
//   `replaces <old path>` beside it; the version as required stays the row's constraint.
//   Modules replaced by the same module@version share one row, and its marker lists
//   every old path (`replaces a, b`), so "N direct" counts that row once.
// - A replacement by a local path (`./x`, `../x`, `/abs`, `C:\x`) drops the module from
//   the tree and counts it on the "not checked" line under its original path. A `replace`
//   of a module go.mod doesn't require is ignored.
// - `exclude`, `retract`, `go`, `toolchain`, `godebug`, `tool`, `ignore` and unknown
//   directives are ignored, single-line or in a `( … )` block.
// - A malformed go.mod is refused, not half-read: the result is { error } naming the
//   line. Malformed means any of these:
//     - a block with no `)` by the end of the file (the error names the line that opened it);
//     - a directive keyword or a block opener inside a block;
//     - a `require` that isn't exactly a path and a version;
//     - a stray `(` or `)` in a `require` or `replace`;
//     - a `replace` with no `=>`, with more than one `=>`, with nothing left of `=>`, or
//       with more than two tokens left of it;
//     - a `replace` whose right side is neither a local path alone nor a path and a version.
//   This checks the shape of the file only, and it can be wrong both ways. A go.mod that
//   passes may still be one Go rejects (`exclude a`, with no version). A go.mod Go accepts
//   may be refused: a block line whose path is a bare directive keyword, such as
//   `tool v1.0.0` inside `require ( … )`, counts as a directive inside a block.
// - The indirect row is a group (`group: true` on the direct, see tree.js), keyed so no
//   module path can collide with it. A hand-written go.mod requiring a module literally
//   named `indirect` shows two rows: the module, then the group.

export const GO_INDIRECT_GROUP = "indirect";

const LOCAL_PATH = /^(\.{1,2}[\\/]|\.{1,2}$|[\\/]|[A-Za-z]:[\\/])/;

// One line's tokens, comment stripped. `indirect` is true when the comment is Go's
// `// indirect` marker (`indirect` alone, or followed by `;`).
function lineTokens(line) {
  let text = line, indirect = false;
  const at = text.indexOf("//");
  if (at !== -1) {
    const comment = text.slice(at + 2).trim();
    indirect = comment === "indirect" || comment.startsWith("indirect;");
    text = text.slice(0, at);
  }
  const tokens = text.replace(/=>/g, " => ").trim().split(/\s+/).filter(Boolean).map(unquote);
  return { tokens, indirect };
}

function unquote(token) {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "`") && token[token.length - 1] === token[0]) return token.slice(1, -1);
  return token;
}

// [path] or [path, version] on the left of `=>`; on the right, a local path alone or a
// module path and version. Anything else is null.
function readReplace(args) {
  const arrow = args.indexOf("=>");
  if (arrow < 1 || args.indexOf("=>", arrow + 1) !== -1) return null;
  const left = args.slice(0, arrow), right = args.slice(arrow + 1);
  if (left.length > 2 || right.length < 1 || right.length > 2) return null;
  const local = LOCAL_PATH.test(right[0]);
  if (local !== (right.length === 1)) return null;
  return { from: left[0], fromVersion: left[1] ?? null, to: right[0], toVersion: right[1] ?? null, local };
}

// go.mod's directive keywords (https://go.dev/ref/mod#go-mod-file-grammar).
const DIRECTIVES = new Set(["module", "go", "toolchain", "godebug", "require", "replace", "exclude", "retract", "tool", "ignore"]);

// `<directive> (` or `<directive>(` → the directive, else null.
function blockOpener(tokens) {
  if (tokens.length === 2 && tokens[1] === "(") return tokens[0];
  if (tokens.length === 1 && tokens[0].length > 1 && tokens[0].endsWith("(")) return tokens[0].slice(0, -1);
  return null;
}

// go.mod's lines → { name, requires: [{ path, version, indirect }], replaces }, or
// { error } naming the first malformed line. Nothing is merged or applied here.
export function scanGoMod(text) {
  if (typeof text !== "string") return { name: null, requires: [], replaces: [] };
  let name = null, block = null, opened = 0;
  const requires = [], replaces = [];
  const lines = text.split(/\r?\n/);
  const fail = (n, why) => ({ error: `go.mod line ${n}: ${why}` });
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1, { tokens, indirect } = lineTokens(lines[i]);
    if (!tokens.length) continue;
    const opens = blockOpener(tokens);
    let directive, args;
    if (block !== null) {
      if (tokens[0] === ")") { block = null; continue; }
      if (opens !== null) return fail(n, `\`${opens} (\` inside the \`${block} (\` block opened on line ${opened}`);
      if (DIRECTIVES.has(tokens[0])) return fail(n, `\`${tokens[0]}\` inside the \`${block} (\` block opened on line ${opened}`);
      directive = block; args = tokens;
    } else {
      if (opens !== null) { block = opens; opened = n; continue; }
      directive = tokens[0]; args = tokens.slice(1);
    }
    if ((directive === "require" || directive === "replace") && args.some((a) => a === "(" || a === ")")) {
      return fail(n, `a stray \`(\` or \`)\` in a ${directive}`);
    }
    if (directive === "module" && args.length >= 1) name ??= args[0];
    else if (directive === "require") {
      if (args.length !== 2) return fail(n, "a require needs a module path and a version");
      requires.push({ path: args[0], version: args[1], indirect });
    } else if (directive === "replace") {
      const replace = readReplace(args);
      if (!replace) return fail(n, "a replace needs `path [version] => ./local/path` or `path [version] => path version`");
      replaces.push(replace);
    }
  }
  if (block !== null) return fail(opened, `the \`${block} (\` block is never closed`);
  return { name, requires, replaces };
}

// A direct line beats an indirect one; within a kind, the first line wins.
function mergeRequires(requires) {
  const directs = new Map(), indirects = new Map();
  for (const r of requires) {
    const into = r.indirect ? indirects : directs;
    if (!into.has(r.path)) into.set(r.path, r.version);
  }
  for (const path of directs.keys()) indirects.delete(path);
  return { directs, indirects };
}

// The version go.mod selects for each module path it lists, by the rule above.
export function selectedVersions(requires) {
  const { directs, indirects } = mergeRequires(requires);
  return new Map([...directs, ...indirects]);
}

// `replace a v1 => …` beats a plain `replace a => …`; null when neither applies.
export function replaceFor(replaces, path, version) {
  return replaces.find((r) => r.from === path && r.fromVersion === version) ?? replaces.find((r) => r.from === path && r.fromVersion === null) ?? null;
}

// go.mod → { name, direct, indirect, skipped }, or { error } naming the first malformed
// line. `direct` and `indirect` are [{ name, version, constraint, dev: false, marker? }]
// after replaces; `skipped` holds the original paths of modules replaced by a local path.
export function readGoMod(text) {
  if (typeof text !== "string") return { name: null, direct: [], indirect: [], skipped: [] };
  const scanned = scanGoMod(text);
  if (scanned.error) return { error: scanned.error };
  const { name, requires, replaces } = scanned;
  const { directs, indirects } = mergeRequires(requires);

  const skipped = new Set();
  // Two required modules replaced by the same module@version share one row, its marker
  // naming every path it replaces. A direct row absorbs an indirect one, as a direct
  // line beats an indirect one above.
  const rows = new Map();
  const apply = (map) => {
    const out = [];
    for (const [path, version] of map) {
      const replace = replaceFor(replaces, path, version);
      if (replace?.local) { skipped.add(path); continue; }
      const module = { name: path, version, constraint: version, dev: false };
      if (replace) {
        module.name = replace.to;
        module.version = replace.toVersion;
      }
      const replaced = module.name !== path ? [path] : [];
      const key = `${module.name}@${module.version}`;
      const row = rows.get(key);
      if (row) { row.replaced.push(...replaced); continue; }
      rows.set(key, { module, replaced });
      out.push(module);
    }
    return out;
  };
  const direct = apply(directs), indirectList = apply(indirects);
  for (const { module, replaced } of rows.values()) if (replaced.length) module.marker = `replaces ${replaced.join(", ")}`;
  return { name, direct, indirect: indirectList, skipped: [...skipped] };
}

// The `parse` contract (audit.js): the direct modules are the deps.
export function parseGoMod(text) {
  const read = readGoMod(text);
  if (read.error) return { error: read.error };
  const { name, direct, skipped } = read;
  return { name, deps: direct, skipped };
}

// go.mod read again as the lockfile → { resolve, direct }, or { error } if it is
// malformed (only when a save lands between the two reads). The directs are the direct
// modules plus, when there are indirect ones, the group row; the group resolves to the
// indirect modules and every module to null, which keeps the version its edge carries
// and makes it a leaf (tree.js).
export function goResolver(text, _project) {
  const read = readGoMod(text);
  if (read.error) return { error: read.error };
  const { children, roots } = flatParts(read);
  const resolve = (edge) => (edge.group === true ? { version: null, children } : null);
  return { resolve, direct: roots };
}

// --- the module cache ------------------------------------------------------------

// Where Go keeps downloaded modules, declared for cache.js: GOMODCACHE, else the first
// GOPATH entry plus /pkg/mod, else ~/go/pkg/mod. `cache/lock` is Go's side-lock file
// (empty), created on the first download; only `.mod` files under cache/download/ are
// ever read besides it.
export const GO_MODULE_CACHE = {
  locate: [{ env: "GOMODCACHE" }, { env: "GOPATH", first: true, join: "pkg/mod" }, { home: "go/pkg/mod" }],
  probe: "cache/lock",
  under: "cache/download/",
  suffix: ".mod",
};

export const GO_NO_CACHE_NOTE = "Go's module cache wasn't found, so modules show without their own dependencies.";
export const GO_NOT_DOWNLOADED = "not downloaded";
export const GO_UNREADABLE = "unreadable";

// Go's case escaping for the module cache: each uppercase letter becomes `!` and the
// lowercase letter. A `!` or a non-ASCII character gives null, as Go refuses them too.
function escapeCase(text) {
  if (typeof text !== "string") return null;
  let out = "";
  for (const ch of text) {
    if (ch === "!" || ch.codePointAt(0) > 0x7e) return null;
    out += ch >= "A" && ch <= "Z" ? `!${ch.toLowerCase()}` : ch;
  }
  return out;
}
export const escapeModulePath = escapeCase;
export const escapeVersion = escapeCase;

const CACHE_PATH_CHARS = /^[A-Za-z0-9._~/!-]+$/;
const CACHE_VERSION_CHARS = /^[A-Za-z0-9._~!+-]+$/;

// The `.mod` file of path@version, relative to the module cache, or null when either
// fails the allowlist once escaped: letters, digits and `-._~/!` in a path, with no
// leading or trailing `/` and no empty, `.` or `..` segment; letters, digits and
// `-._~!+` in a version, which is never `.` or `..`.
export function goModCacheFile(path, version) {
  const p = escapeModulePath(path), v = escapeVersion(version);
  if (!p || !v) return null;
  if (!CACHE_PATH_CHARS.test(p) || p.startsWith("/") || p.endsWith("/")) return null;
  if (p.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  if (!CACHE_VERSION_CHARS.test(v) || v === "." || v === "..") return null;
  return `${GO_MODULE_CACHE.under}${p}/@v/${v}${GO_MODULE_CACHE.suffix}`;
}

// The flat view's roots and group children, from readGoMod's result.
function flatParts({ direct, indirect }) {
  const children = indirect.map(({ dev: _dev, ...edge }) => edge);
  const roots = indirect.length
    ? [...direct, { name: GO_INDIRECT_GROUP, version: null, constraint: null, dev: false, group: true }]
    : direct;
  return { children, roots };
}

// go.mod read again as the lockfile, with each module's own go.mod read from Go's
// module cache when its row opens. `cache` is cache.js's confined reader, or null when
// no cache folder was found. Without a cache the result is goResolver's flat view plus
// GO_NO_CACHE_NOTE; with one, every module row is deferred, and `load` reads its `.mod`.
export async function goCacheResolver(text, _project, cache) {
  const read = readGoMod(text);
  if (read.error) return { error: read.error };
  const { children: groupChildren, roots } = flatParts(read);
  const flat = { resolve: (edge) => (edge.group === true ? { version: null, children: groupChildren } : null), direct: roots };
  if (!cache) return { ...flat, note: GO_NO_CACHE_NOTE };

  // Is there a cache at all? Go's `cache/lock`, else the first module's `.mod`, read
  // around the session memo so an emptied cache isn't hidden by what was read before.
  try {
    let found = (await cache.read(GO_MODULE_CACHE.probe)) !== null;
    const first = [...read.direct, ...read.indirect][0];
    const firstFile = first ? goModCacheFile(first.name, first.version) : null;
    if (!found && firstFile) found = (await cache.read(firstFile, { fresh: true })) !== null;
    if (!found) return { ...flat, note: GO_NO_CACHE_NOTE };
  } catch (error) {
    return { ...flat, note: `Go's module cache couldn't be read: ${String(error?.message ?? error)}` };
  }

  const { name: self, requires, replaces } = scanGoMod(text);
  const selected = selectedVersions(requires);
  const resolve = (edge) => (edge.group === true ? { version: null, children: groupChildren } : { version: edge.version ?? null, deferred: true });
  const load = async (edge) => {
    const file = goModCacheFile(edge.name, edge.version);
    if (!file) return { children: [], tag: GO_UNREADABLE };
    const modText = await cache.read(file);
    if (modText === null) return { children: [], tag: GO_NOT_DOWNLOADED };
    const dep = scanGoMod(modText);
    if (dep.error) return { children: [], tag: GO_UNREADABLE };
    const seen = new Set(), children = [];
    for (const r of dep.requires) {
      if (r.path === self) continue;
      const version = selected.get(r.path) ?? r.version;
      const replace = replaceFor(replaces, r.path, version);
      if (replace?.local) continue;
      const child = { name: r.path, version, constraint: r.version };
      if (replace) {
        child.name = replace.to;
        child.version = replace.toVersion;
        if (child.name !== r.path) child.marker = `replaces ${r.path}`;
      }
      if (child.name === self) continue;
      const key = `${child.name}@${child.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      children.push(child);
    }
    return { children };
  };
  return { resolve, load, direct: roots, count: false, total: read.direct.length + read.indirect.length };
}

export const GO_LOCKFILES = [{ file: "go.mod", resolver: goCacheResolver, cache: GO_MODULE_CACHE }];

export const GO_NOTE = "go.mod couldn't be read again, so only direct modules are shown.";
