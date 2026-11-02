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
// - A replacement by a local path (`./x`, `../x`, `/abs`, or anything with no version)
//   drops the module from the tree and counts it on the "not checked" line under its
//   original path. A `replace` of a module go.mod doesn't require is ignored.
// - `exclude`, `retract`, `go`, `toolchain`, `godebug`, `tool` and unknown directives
//   are ignored, single-line or in a `( … )` block.
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
    if (block !== null) {
      if (tokens[0] === ")") block = null;
      else act(block, tokens, indirect);
      continue;
    }
    if (tokens.length === 2 && tokens[1] === "(") { block = tokens[0]; continue; }
    if (tokens.length === 1 && tokens[0].length > 1 && tokens[0].endsWith("(")) { block = tokens[0].slice(0, -1); continue; }
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
  const apply = (map) => {
    const out = [];
    for (const [path, version] of map) {
      const replace = replaceFor(path, version);
      if (replace?.local) { skipped.add(path); continue; }
      const module = { name: path, version, constraint: version, dev: false };
      if (replace) {
        module.name = replace.to;
        module.version = replace.toVersion;
        if (replace.to !== path) module.marker = `replaces ${path}`;
      }
      out.push(module);
    }
    return out;
  };
  const direct = apply(directs), indirectList = apply(indirects);
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
