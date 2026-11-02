// Workspace member discovery, for any language whose workspace is "a root folder, a
// list of member globs, a list of excluded folders": Cargo's [workspace] now, and the
// same shape as uv's [tool.uv.workspace], pnpm's `packages:` and go.work's `use`. Plain
// data in and out, with no imports at all; listing a folder is injected, so `npm test`
// runs this under Node without the app. Nothing here throws or rejects.
//
// Glob support, per path segment: `*` matches any run of characters and `?` one
// character, within one segment. `**` is treated as `*` (one level, not any depth), and
// `[...]` classes are matched literally. `.` and `..` segments are collapsed. A pattern
// that names no wildcard is a literal folder and isn't listed.

export const MAX_MEMBERS = 256; // member folders in total; past it the rest aren't read

// `relative` resolved against the absolute folder `base`, with `.` and `..` collapsed
// (`..` never climbs above `/`). An absolute `relative` is collapsed as it is.
export function collapse(base, relative) {
  const text = String(relative ?? "");
  const start = text.startsWith("/") ? "" : String(base ?? "");
  const parts = [];
  for (const segment of `${start}/${text}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

const join = (dir, name) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parentOf = (dir) => dir.slice(0, dir.lastIndexOf("/")) || "/";
const isGlob = (segment) => segment.includes("*") || segment.includes("?");

// A regex for one glob segment, matched against one directory name.
function segmentRegex(segment) {
  const source = segment.replace(/\*+/g, "*").split("").map((c) => {
    if (c === "*") return "[^/]*";
    if (c === "?") return "[^/]";
    return c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return new RegExp(`^${source}$`);
}

// `list(dir)` answers the names of `dir`'s sub-folders, or null when it can't list it.
const listSafely = (list, dir) => {
  try { return Promise.resolve(list(dir)).then((names) => (Array.isArray(names) ? names : null), () => null); } catch { return Promise.resolve(null); }
};

// One pattern's folders, or null when a folder it needed couldn't be listed.
async function expandPattern(rootFolder, pattern, list) {
  let dirs = [pattern.startsWith("/") ? "/" : rootFolder];
  for (const segment of pattern.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { dirs = dirs.map(parentOf); continue; }
    if (!isGlob(segment)) { dirs = dirs.map((dir) => join(dir, segment)); continue; }
    const regex = segmentRegex(segment), next = [];
    for (const dir of dirs) {
      const names = await listSafely(list, dir);
      if (names === null) return null;
      for (const name of [...names].filter((n) => typeof n === "string" && regex.test(n)).sort()) next.push(join(dir, name));
    }
    dirs = next;
  }
  return [...new Set(dirs)];
}

// The member folders of the workspace at `rootFolder` (absolute), in pattern order,
// deduped, without the ones `exclude` names (a folder equal to an excluded one or under
// it). `unlisted` says some pattern's folder couldn't be listed, so its members are
// missing; `capped` says MAX_MEMBERS was reached and the rest weren't looked for.
export async function expandMembers(rootFolder, members, exclude, list) {
  const excluded = (Array.isArray(exclude) ? exclude : []).filter((e) => typeof e === "string").map((e) => collapse(rootFolder, e));
  const isExcluded = (folder) => excluded.some((e) => folder === e || folder.startsWith(e === "/" ? "/" : `${e}/`));
  const folders = [], seen = new Set();
  let unlisted = false, capped = false;
  for (const pattern of Array.isArray(members) ? members : []) {
    if (typeof pattern !== "string") continue;
    const found = await expandPattern(rootFolder, pattern, list);
    if (found === null) { unlisted = true; continue; }
    for (const folder of found) {
      if (seen.has(folder) || isExcluded(folder)) continue;
      if (folders.length >= MAX_MEMBERS) { capped = true; break; }
      seen.add(folder);
      folders.push(folder);
    }
    if (capped) break;
  }
  return { folders, unlisted, capped };
}
