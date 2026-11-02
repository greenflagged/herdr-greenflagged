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
// - A replacement by a local path (`./x`, `../x`, `/abs`, or anything with no version)
//   drops the module from the tree and counts it on the "not checked" line under its
//   original path. A `replace` of a module go.mod doesn't require is ignored.
// - `exclude`, `retract`, `go`, `toolchain`, `godebug`, `tool`, `ignore` and unknown
//   directives are ignored, single-line or in a `( … )` block. A block left open (no `)`)
//   ends at the next line starting with a directive keyword or a block opener.
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

// [path] or [path, version] on each side of `=>`, or null when the line isn't one.
function readReplace(args) {
  const arrow = args.indexOf("=>");
  if (arrow < 1) return null;
  const left = args.slice(0, arrow), right = args.slice(arrow + 1);
  if (left.length > 2 || right.length < 1 || right.length > 2) return null;
  return {
    from: left[0], fromVersion: left[1] ?? null,
    to: right[0], toVersion: right[1] ?? null,
    local: right.length === 1 || LOCAL_PATH.test(right[0]),
  };
}

// go.mod's directive keywords (https://go.dev/ref/mod#go-mod-file-grammar).
const DIRECTIVES = new Set(["module", "go", "toolchain", "godebug", "require", "replace", "exclude", "retract", "tool", "ignore"]);

// `<directive> (` or `<directive>(` → the directive, else null.
function blockOpener(tokens) {
  if (tokens.length === 2 && tokens[1] === "(") return tokens[0];
  if (tokens.length === 1 && tokens[0].length > 1 && tokens[0].endsWith("(")) return tokens[0].slice(0, -1);
  return null;
}

// go.mod → { name, direct, indirect, skipped }. `direct` and `indirect` are
// [{ name, version, constraint, dev: false, marker? }] after replaces; `skipped` holds
// the original paths of modules replaced by a local path.
export function readGoMod(text) {
  const empty = { name: null, direct: [], indirect: [], skipped: [] };
  if (typeof text !== "string") return empty;
  let name = null, block = null;
  const requires = [], replaces = [];
  const act = (directive, args, indirect) => {
    if (directive === "module" && args.length >= 1) name ??= args[0];
    else if (directive === "require" && args.length >= 2) requires.push({ path: args[0], version: args[1], indirect });
    else if (directive === "replace") {
      const replace = readReplace(args);
      if (replace) replaces.push(replace);
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const { tokens, indirect } = lineTokens(raw);
    if (!tokens.length) continue;
    // Inside a block, a line starting with a directive keyword, or any block opener,
    // closes the block (Go rejects both there) and is then read as a top-level line. So
    // a block missing its `)` can't swallow later directives or list a module named
    // `require`. The trade: a block line whose path is exactly a keyword is not listed.
    const opens = blockOpener(tokens);
    if (block !== null && tokens[0] !== ")" && opens === null && !DIRECTIVES.has(tokens[0])) {
      act(block, tokens, indirect);
      continue;
    }
    block = null;
    if (tokens[0] === ")") continue;
    if (opens !== null) { block = opens; continue; }
    act(tokens[0], tokens.slice(1), indirect);
  }

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
  // naming every path it replaces. That is a display choice: Go itself rejects a go.mod
  // that replaces two modules with the same module@version. A direct row absorbs
  // an indirect one, as a direct line beats an indirect one above.
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
  const { name, direct, skipped } = readGoMod(text);
  return { name, deps: direct, skipped };
}

// go.mod read again as the lockfile → { resolve, direct }. The directs are the direct
// modules plus, when there are indirect ones, the group row; the group resolves to the
// indirect modules and every module to null, which keeps the version its edge carries
// and makes it a leaf (tree.js).
export function goResolver(text, _project) {
  const { direct, indirect } = readGoMod(text);
  const children = indirect.map(({ dev: _dev, ...edge }) => edge);
  const roots = indirect.length
    ? [...direct, { name: GO_INDIRECT_GROUP, version: null, constraint: null, dev: false, group: true }]
    : direct;
  const resolve = (edge) => (edge.group === true ? { version: null, children } : null);
  return { resolve, direct: roots };
}

export const GO_LOCKFILES = [{ file: "go.mod", resolver: goResolver }];

export const GO_NOTE = "go.mod couldn't be read again, so only direct modules are shown.";
