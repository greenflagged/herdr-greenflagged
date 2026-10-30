import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ENTRIES, auditRequest, parentFolders, parseAuditResponse, parsePackageJson, rows, summarize, tokenFromNpmrc,
} from "../mods/greenflagged/audit.js";

const toolReply = (result, extra = {}) => JSON.stringify({
  jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(result) }], ...extra },
});

test("parentFolders stops at home", () => {
  assert.deepEqual(parentFolders("/Users/a/code/app/", "/Users/a"), ["/Users/a/code/app", "/Users/a/code", "/Users/a"]);
});

test("parentFolders stops at the root outside home", () => {
  assert.deepEqual(parentFolders("/srv/app", "/Users/a"), ["/srv/app", "/srv", "/"]);
});

test("parsePackageJson keeps registry deps and marks dev ones", () => {
  const { name, deps, skipped } = parsePackageJson(JSON.stringify({
    name: "app",
    dependencies: { lodash: "^4.17.0", "@types/node": "20.x" },
    devDependencies: { vitest: "^2.0.0", lodash: "^3.0.0" },
    optionalDependencies: { fsevents: "2.3.3" },
  }));
  assert.equal(name, "app");
  assert.deepEqual(skipped, []);
  assert.deepEqual(deps, [
    { name: "lodash", constraint: "^4.17.0", dev: false },
    { name: "@types/node", constraint: "20.x", dev: false },
    { name: "fsevents", constraint: "2.3.3", dev: false },
    { name: "vitest", constraint: "^2.0.0", dev: true },
  ]);
});

test("parsePackageJson skips specs that never reach a registry", () => {
  const { deps, skipped } = parsePackageJson(JSON.stringify({
    dependencies: {
      a: "workspace:*", b: "file:../b", c: "link:../c", d: "github:o/r", e: "git+https://x.dev/r.git",
      f: "https://x.dev/f.tgz", g: "o/r", h: "../h", i: "catalog:", ok: "latest", range: ">=1 <2",
    },
  }));
  assert.deepEqual(skipped, ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  assert.deepEqual(deps.map((d) => d.name), ["ok", "range"]);
});

test("parsePackageJson audits version ranges, tilde included", () => {
  const { deps, skipped } = parsePackageJson(JSON.stringify({
    dependencies: { tilde: "~20.3.0", caret: "^1.0.0", exact: "1.2.3", any: "*", tag: "next", home: "~/pkg", dot: "./x" },
  }));
  assert.deepEqual(deps.map((d) => d.name), ["tilde", "caret", "exact", "any", "tag"]);
  assert.deepEqual(skipped, ["home", "dot"]);
});

test("parsePackageJson checks the real package behind an npm alias", () => {
  const { deps } = parsePackageJson(JSON.stringify({
    dependencies: { lodash4: "npm:lodash@^4.0.0", scoped: "npm:@a/b@1.0.0", bare: "npm:left-pad" },
  }));
  assert.deepEqual(deps.map((d) => [d.name, d.constraint]), [["lodash", "^4.0.0"], ["@a/b", "1.0.0"], ["left-pad", "*"]]);
});

test("parsePackageJson reports broken JSON", () => {
  assert.equal(parsePackageJson("{ nope").error, "package.json is not valid JSON");
});

test("auditRequest stays inside the tool's cap", () => {
  const deps = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ name: `p${i}`, constraint: "*" }));
  const manifest = auditRequest(deps).params.arguments.manifest;
  assert.equal(Object.keys(manifest).length, MAX_ENTRIES);
});

test("parseAuditResponse reads plain JSON", () => {
  assert.deepEqual(parseAuditResponse(toolReply({ a: { status: "pending" } })), { a: { status: "pending" } });
});

test("parseAuditResponse reads an SSE event", () => {
  const body = `event: message\ndata: ${toolReply({ a: { status: "rejected" } })}\n\n`;
  assert.deepEqual(parseAuditResponse(body), { a: { status: "rejected" } });
});

test("parseAuditResponse surfaces tool and protocol errors", () => {
  const toolError = JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "manifest too large" }] } });
  assert.throws(() => parseAuditResponse(toolError), /manifest too large/);
  assert.throws(() => parseAuditResponse(JSON.stringify({ error: { message: "bad call" } })), /bad call/);
  assert.throws(() => parseAuditResponse(""), /empty answer/);
});

test("rows sort worst first and name each status", () => {
  const deps = ["ok", "held", "bad", "gone", "new", "ovr", "stuck"].map((name) => ({ name, constraint: "^1.0.0", dev: false }));
  const list = rows(deps, {
    ok: { status: "greenflagged", version: "1.2.0" },
    held: { status: "pending", version: null },
    bad: { status: "rejected", version: null, reason: { kind: "cve", detail: "CVE-2026-1", scope: "version" } },
    gone: { status: "not_in_upstream" },
    new: { status: "not_imported" },
    ovr: { status: "greenflagged_with_overrides", version: "1.0.0" },
    stuck: { status: "uninstallable" },
  });
  assert.deepEqual(list.map((r) => r.name), ["bad", "gone", "stuck", "held", "new", "ovr", "ok"]);
  assert.equal(list[0].detail, "CVE-2026-1");
  assert.deepEqual(summarize(list), { blocked: 3, attention: 3, ok: 1 });
});

test("rows flag a package whose every greenflagged version is deprecated", () => {
  const [row] = rows([{ name: "old", constraint: "^1.0.0", dev: false }], { old: { status: "greenflagged", version: null } });
  assert.equal(row.level, "attention");
  assert.equal(row.label, "deprecated");
});

test("rows flag a constraint that misses every greenflagged version", () => {
  const [row] = rows([{ name: "lodash", constraint: "^3.0.0", dev: false }], {
    lodash: { status: "greenflagged", version: "4.17.21", proposed_constraint: "^4.17.21" },
  });
  assert.equal(row.level, "attention");
  assert.equal(row.label, "needs upgrade");
  assert.match(row.detail, /\^4\.17\.21/);
});

test("rows treat a package the audit omitted as not imported", () => {
  const [row] = rows([{ name: "x", constraint: "*", dev: true }], {});
  assert.equal(row.status, "not_imported");
  assert.equal(row.dev, true);
});

test("tokenFromNpmrc reads a literal or resolves a variable", () => {
  assert.equal(tokenFromNpmrc("//greenflagged.dev/npm/:_authToken=gflag_abc\n"), "gflag_abc");
  assert.equal(tokenFromNpmrc("//npm.greenflagged.dev/:_authToken=gflag_host\n"), "gflag_host");
  const env = (name) => (name === "GREENFLAGGED_TOKEN" ? "gflag_env" : null);
  assert.equal(tokenFromNpmrc("registry=x\n//greenflagged.dev/npm/:_authToken=${GREENFLAGGED_TOKEN}\n", env), "gflag_env");
  assert.equal(tokenFromNpmrc("//registry.npmjs.org/:_authToken=npm_x\n"), null);
  assert.equal(tokenFromNpmrc(null), null);
});
