import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedRelative, locateCache, openCache, sessionReader } from "../mods/greenflagged/cache.js";
import { GO_MODULE_CACHE } from "../mods/greenflagged/go.js";

const spec = GO_MODULE_CACHE;
const envOf = (vars) => async (name) => vars[name] ?? null;
const locate = (vars, home = "/home/u") => locateCache(spec, { env: envOf(vars), home: async () => home });

// A fake file reader that records every path; `files` maps a path to text, null, or an Error to reject with.
const recorder = (files = {}) => {
  const seen = [];
  const read = async (path) => {
    seen.push(path);
    const value = files[path];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  return { seen, read, files };
};

// --- locate --------------------------------------------------------------------

test("GOMODCACHE wins over GOPATH and home", async () => {
  assert.equal(await locate({ GOMODCACHE: "/m/cache", GOPATH: "/g" }), "/m/cache");
});

test("the first GOPATH entry plus pkg/mod comes next", async () => {
  assert.equal(await locate({ GOPATH: "/a:/b" }), "/a/pkg/mod");
  assert.equal(await locate({ GOPATH: "/a/" }), "/a/pkg/mod");
});

test("an empty or relative GOMODCACHE or GOPATH is skipped, as if unset", async () => {
  assert.equal(await locate({ GOMODCACHE: "", GOPATH: "/g" }), "/g/pkg/mod");
  assert.equal(await locate({ GOMODCACHE: "rel/cache", GOPATH: "/g" }), "/g/pkg/mod");
  assert.equal(await locate({ GOPATH: "rel:/b" }), "/home/u/go/pkg/mod");
  assert.equal(await locate({ GOPATH: ":/b" }), "/home/u/go/pkg/mod");
});

test("home/go/pkg/mod is the fallback, and nothing set gives null", async () => {
  assert.equal(await locate({}), "/home/u/go/pkg/mod");
  assert.equal(await locate({}, null), null);
  assert.equal(await locate({}, ""), null);
  assert.equal(await locate({}, "relative"), null);
});

test("env and home are asked in order and only as far as needed", async () => {
  const asked = [];
  const env = async (name) => { asked.push(name); return name === "GOPATH" ? "/g" : null; };
  const dir = await locateCache(spec, { env, home: () => { asked.push("home"); return "/h"; } });
  assert.equal(dir, "/g/pkg/mod");
  assert.deepEqual(asked, ["GOMODCACHE", "GOPATH"]);
});

// --- confinement ---------------------------------------------------------------

const refused = [
  "../x",
  "cache/download/../../etc/passwd.mod",
  "/etc/passwd",
  "/cache/download/a/@v/v1.mod",
  "cache/download/a//b.mod",
  "cache/download/a/./b.mod",
  "cache/download/a/@v/v1.zip",
  "cache/download/a/@v/v1.info",
  "cache/vcs/a.mod",
  "pkg/a.mod",
  "cache/download/a\u0000/@v/v1.mod",
  "cache/download/a b/@v/v1.mod",
  "cache/download/%2e%2e/@v/v1.mod",
  "cache/download/a\\..\\b.mod",
  "",
  null,
  undefined,
  42,
];

test("openCache refuses anything but the probe and .mod files under cache/download/, without reading", async () => {
  const { seen, read } = recorder();
  const cache = openCache(spec, "/c", read, read);
  for (const rel of refused) {
    assert.equal(allowedRelative(spec, rel), false, String(rel));
    assert.equal(await cache.read(rel), null, String(rel));
    assert.equal(await cache.read(rel, { fresh: true }), null, String(rel));
  }
  assert.deepEqual(seen, []);
});

test("the probe and a well-formed .mod path are allowed", () => {
  assert.equal(allowedRelative(spec, "cache/lock"), true);
  assert.equal(allowedRelative(spec, "cache/download/github.com/!burnt!sushi/toml/@v/v1.4.0.mod"), true);
  assert.equal(allowedRelative(spec, "cache/download/a/@v/v2.0.0+incompatible.mod"), true);
});

// --- memo ----------------------------------------------------------------------

const MOD = "cache/download/a/@v/v1.0.0.mod";

test("the probe is always read, never memoized", async () => {
  const { seen, read } = recorder({ "/c/cache/lock": "" });
  const cache = openCache(spec, "/c", read, sessionReader(read));
  assert.equal(await cache.read("cache/lock"), "");
  assert.equal(await cache.read("cache/lock"), "");
  assert.deepEqual(seen, ["/c/cache/lock", "/c/cache/lock"]);
});

test("a .mod is read once, then served from the memo", async () => {
  const { seen, read } = recorder({ [`/c/${MOD}`]: "module a\n" });
  const cache = openCache(spec, "/c", read, sessionReader(read));
  assert.equal(await cache.read(MOD), "module a\n");
  assert.equal(await cache.read(MOD), "module a\n");
  assert.deepEqual(seen, [`/c/${MOD}`]);
});

test("a missing file (null) isn't memoized, so it is read again", async () => {
  const { seen, read, files } = recorder();
  const cache = openCache(spec, "/c", read, sessionReader(read));
  assert.equal(await cache.read(MOD), null);
  files[`/c/${MOD}`] = "module a\n";
  assert.equal(await cache.read(MOD), "module a\n");
  assert.equal(seen.length, 2);
});

test("a rejection passes through unchanged and isn't memoized", async () => {
  const failure = new Error("permission denied");
  const { seen, read, files } = recorder({ [`/c/${MOD}`]: failure });
  const cache = openCache(spec, "/c", read, sessionReader(read));
  await assert.rejects(cache.read(MOD), (error) => error === failure);
  files[`/c/${MOD}`] = "module a\n";
  assert.equal(await cache.read(MOD), "module a\n");
  assert.equal(seen.length, 2);
});

test("past `max` entries the oldest is evicted", async () => {
  const { seen, read } = recorder({ "/a": "a", "/b": "b", "/c": "c" });
  const memo = sessionReader(read, 2);
  await memo("/a"); await memo("/b"); await memo("/c");
  assert.equal(memo.size(), 2);
  await memo("/b"); await memo("/c"); // still held
  await memo("/a"); // evicted, read again
  assert.deepEqual(seen, ["/a", "/b", "/c", "/a"]);
});

test("a text longer than maxChars is returned but not kept", async () => {
  const big = "x".repeat(11);
  const { seen, read } = recorder({ "/big": big, "/small": "ok" });
  const memo = sessionReader(read, 10, 10);
  assert.equal(await memo("/big"), big);
  assert.equal(await memo("/big"), big);
  await memo("/small"); await memo("/small");
  assert.deepEqual(seen, ["/big", "/big", "/small"]);
  assert.equal(memo.size(), 1);
});

test("fresh reads around the memo, doesn't fill it, and is still confined", async () => {
  const { seen, read, files } = recorder({ [`/c/${MOD}`]: "old" });
  const cache = openCache(spec, "/c", read, sessionReader(read));
  assert.equal(await cache.read(MOD), "old");
  files[`/c/${MOD}`] = null;
  assert.equal(await cache.read(MOD, { fresh: true }), null);
  assert.equal(await cache.read(MOD), "old"); // the memo still holds the first text
  const NEW = "cache/download/b/@v/v1.0.0.mod";
  files[`/c/${NEW}`] = "new";
  assert.equal(await cache.read(NEW, { fresh: true }), "new");
  assert.equal(await cache.read(NEW), "new"); // not filled by the fresh read: read again
  assert.equal(await cache.read("../x.mod", { fresh: true }), null);
  assert.deepEqual(seen, [`/c/${MOD}`, `/c/${MOD}`, `/c/${NEW}`, `/c/${NEW}`]);
});
