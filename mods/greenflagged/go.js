// Go's go.mod for the plain dependency tree. Plain data in and out, with no Herdr
// imports, so `npm test` can run it under Node without the app. Nothing here throws,
// whatever the input, text or not, and nothing is run: no `go mod graph`, no Go
// toolchain, no module cache. The file is read one line at a time, and no regex ever
// sees more than one line.
//
// go.mod is both the manifest and the lockfile: it pins a version for every module it
// lists, but records no module-to-module edges. So the tree is flat: the direct modules,
// each a leaf, then one collapsed "indirect" row whose children are the `// indirect`
// modules. go.mod is registered as its own lockfile, so it is read twice per refresh:
// once as the manifest (the header and the rail) and once as the lock (the tree). A save
// between the two reads gives one refresh where they disagree; go.mod is a watched file,
// so the next refresh is consistent.
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
//   line. Malformed means a block with no `)` by the end of the file; a directive keyword
//   or a block opener inside a block; a `require` that isn't a path and a version; or a
//   `replace` with no `=>`, or whose right side is neither a local path alone nor a path
//   and a version. This is a check on the shape of the file only: a go.mod passing it may
//   still be one Go rejects.
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

// go.mod → { name, direct, indirect, skipped }, or { error } naming the first malformed
// line. `direct` and `indirect` are [{ name, version, constraint, dev: false, marker? }]
// after replaces; `skipped` holds the original paths of modules replaced by a local path.
export function readGoMod(text) {
  if (typeof text !== "string") return { name: null, direct: [], indirect: [], skipped: [] };
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

  // A direct line beats an indirect one; within a kind, the first line wins.
  const directs = new Map(), indirects = new Map();
  for (const r of requires) {
    const into = r.indirect ? indirects : directs;
    if (!into.has(r.path)) into.set(r.path, r.version);
  }
  for (const path of directs.keys()) indirects.delete(path);

  const skipped = new Set();
  const replaceFor = (path, version) =>
    replaces.find((r) => r.from === path && r.fromVersion === version) ?? replaces.find((r) => r.from === path && r.fromVersion === null);
  // Two required modules replaced by the same module@version share one row, its marker
  // naming every path it replaces. A direct row absorbs an indirect one, as a direct
  // line beats an indirect one above.
  const rows = new Map();
  const apply = (map) => {
    const out = [];
    for (const [path, version] of map) {
      const replace = replaceFor(path, version);
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
  const { direct, indirect } = read;
  const children = indirect.map(({ dev: _dev, ...edge }) => edge);
  const roots = indirect.length
    ? [...direct, { name: GO_INDIRECT_GROUP, version: null, constraint: null, dev: false, group: true }]
    : direct;
  const resolve = (edge) => (edge.group === true ? { version: null, children } : null);
  return { resolve, direct: roots };
}

export const GO_LOCKFILES = [{ file: "go.mod", resolver: goResolver }];

export const GO_NOTE = "go.mod couldn't be read again, so only direct modules are shown.";
