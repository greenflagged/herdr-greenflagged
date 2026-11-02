// A language's local package cache, read through a reader confined to what the
// lockfile entry declares. Plain data in and out, with no Herdr imports, so `npm test`
// can run it under Node without the app. It knows no language: Go declares its module
// cache today (go.js), and a Maven or Gradle cache can declare its own the same way.
//
// The declaration, on a lockfile entry as `cache`:
//   locate: [step]   where the cache folder is, tried in order; the first step that
//                    gives an absolute path wins
//     { env, first?, join? }   the variable's value; `first: true` takes the first entry
//                              of a `:`-separated list; `join` appends `/<join>`
//     { home }                 `<home folder>/<home>`
//   probe:  string   a file relative to the cache folder whose presence means "there is a
//                    cache here"; always read fresh, never memoized
//   under:  string   the one folder, relative to the cache folder, whose files may be read
//   suffix: string   the one file ending allowed under `under`
//
// The README's **Files** bullet names each `probe` and `under`, and its **Programs**
// bullet each `env` (and HOME for a `{ home }` step); test/audit.test.js keeps them in
// step, so the list of files read stays complete by construction.
//
// Two gates stand between a third-party file and a read. The resolver builds a relative
// path from module data and checks it against its own allowlist (go.js goModCacheFile).
// Then `openCache` checks every relative path again (`allowedRelative`): only the probe,
// or a file under `under` ending in `suffix`, made of a fixed set of characters, with no
// empty, `.` or `..` segment. A refused path resolves null without any read.
//
// Edge cases:
// - A variable that is empty or not absolute is skipped, as if unset. Go errors on a
//   relative GOMODCACHE or GOPATH; skipping it is a deliberate, minor divergence.
// - Read failures (a rejection) pass through unchanged, so tree.js can tell "absent"
//   (null) from "couldn't read" and retry the second.
// - The session memo keeps only non-null texts of files under `under`, which are
//   immutable per version. A text longer than `maxChars` is returned but not kept, and
//   the memo holds at most `max` texts, evicting the oldest.

const RELATIVE_CHARS = /^[A-Za-z0-9._~/!+@-]+$/;

// The cache folder for `spec`, or null when no step gives one. `env(name)` and `home()`
// may be async; `env` answers null when the variable is unset.
export async function locateCache(spec, { env, home }) {
  for (const step of spec?.locate ?? []) {
    let value = null;
    if (step.env) {
      value = await env(step.env);
      if (typeof value === "string" && step.first) value = value.split(":")[0];
      if (typeof value === "string" && value && step.join) value = `${value.replace(/\/+$/, "")}/${step.join}`;
    } else if (step.home) {
      const folder = await home();
      value = typeof folder === "string" && folder ? `${folder.replace(/\/+$/, "")}/${step.home}` : null;
    }
    if (typeof value === "string" && value.startsWith("/")) return value.replace(/(.)\/+$/, "$1");
  }
  return null;
}

// True when `rel` is the probe, or a file under `under` ending in `suffix` with nothing
// that could climb out of it.
export function allowedRelative(spec, rel) {
  if (typeof rel !== "string" || !spec) return false;
  if (rel === spec.probe) return true;
  if (!rel.startsWith(spec.under) || !rel.endsWith(spec.suffix)) return false;
  if (!RELATIVE_CHARS.test(rel) || rel.startsWith("/")) return false;
  return rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// A reader confined to `spec` inside `dir`. `read(path)` is the raw file reader and
// `memo(path)` the session memo over it (sessionReader). `{ fresh: true }` reads around
// the memo, and doesn't fill it either.
export function openCache(spec, dir, read, memo) {
  return {
    read(rel, { fresh = false } = {}) {
      if (!allowedRelative(spec, rel)) return Promise.resolve(null);
      const path = `${dir}/${rel}`;
      if (rel === spec.probe || fresh) return read(path);
      return memo(path);
    },
  };
}

// Memoizes `read` per absolute path for the session: non-null texts of at most
// `maxChars` characters, `max` of them, oldest out first. Nulls and rejections are not
// kept, so the next call reads again.
export function sessionReader(read, max = 2000, maxChars = 16384) {
  const texts = new Map();
  const reader = async (path) => {
    if (texts.has(path)) return texts.get(path);
    const text = await read(path);
    if (typeof text === "string" && text.length <= maxChars) {
      texts.set(path, text);
      while (texts.size > max) texts.delete(texts.keys().next().value);
    }
    return text;
  };
  reader.size = () => texts.size;
  return reader;
}
