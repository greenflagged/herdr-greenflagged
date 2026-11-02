import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MEMBERS, collapse, expandMembers } from "../mods/greenflagged/workspace.js";

// A fake folder listing: { dir: [sub-folder names] }; a missing dir answers null.
const lister = (tree) => async (dir) => tree[dir] ?? null;

test("collapse resolves a relative path against its base", () => {
  assert.equal(collapse("/w", "crates/core"), "/w/crates/core");
  assert.equal(collapse("/w/crates/cli", "../.."), "/w");
  assert.equal(collapse("/w", "./a/./b/"), "/w/a/b");
  assert.equal(collapse("/w", "../../../.."), "/");
  assert.equal(collapse("/w", "/abs/./x/../y"), "/abs/y");
});

test("expandMembers expands a wildcard segment and drops excluded folders", async () => {
  const list = lister({ "/w/crates": ["old", "cli", "core"], "/w/crates/old": ["sub"] });
  const result = await expandMembers("/w", ["crates/*", "crates/old/sub", "tools/t"], ["crates/old"], list);
  assert.deepEqual(result, { folders: ["/w/crates/cli", "/w/crates/core", "/w/tools/t"], unlisted: false, capped: false });
});

test("expandMembers reads ?, ** as one level, .. and literal classes", async () => {
  const list = lister({ "/w": ["a1", "a22", "b"], "/w/a1": ["x"], "/w/a22": ["y"], "/": ["w", "sibling"] });
  assert.deepEqual((await expandMembers("/w", ["a?"], [], list)).folders, ["/w/a1"]);
  // A literal segment isn't listed: a folder that doesn't exist has no manifest to read.
  assert.deepEqual((await expandMembers("/w", ["**/x"], [], list)).folders, ["/w/a1/x", "/w/a22/x", "/w/b/x"]);
  assert.deepEqual((await expandMembers("/w", ["../sibling", "a[12]"], [], list)).folders, ["/sibling", "/w/a[12]"]);
  assert.deepEqual((await expandMembers("/w", ["a1", "./a1", "b/../a1"], [], list)).folders, ["/w/a1"]);
});

test("expandMembers marks a pattern it can't list, and still expands the others", async () => {
  const list = lister({ "/w/tools": ["t"] });
  assert.deepEqual(await expandMembers("/w", ["crates/*", "tools/*"], [], list), { folders: ["/w/tools/t"], unlisted: true, capped: false });
  const throwing = (dir) => { if (dir === "/w/crates") throw new Error("boom"); return dir === "/w/tools" ? ["t"] : null; };
  assert.deepEqual(await expandMembers("/w", ["crates/*", "tools/*"], [], throwing), { folders: ["/w/tools/t"], unlisted: true, capped: false });
  const rejecting = async () => { throw new Error("boom"); };
  assert.deepEqual(await expandMembers("/w", ["crates/*", "lit"], [], rejecting), { folders: ["/w/lit"], unlisted: true, capped: false });
});

test("expandMembers stops at MAX_MEMBERS folders", async () => {
  const names = Array.from({ length: MAX_MEMBERS + 5 }, (_, i) => `m${String(i).padStart(3, "0")}`);
  const result = await expandMembers("/w", ["c/*", "extra"], [], lister({ "/w/c": names }));
  assert.equal(result.folders.length, MAX_MEMBERS);
  assert.equal(result.capped, true);
  assert.equal(result.folders.includes("/w/extra"), false);
});
