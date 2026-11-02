import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUDIT_TTL_MS, ECOSYSTEMS, MAX_ENTRIES, WATCHED_FILES, SIGN_IN_COMMAND, auditRequest, findBlock, findManifest, cachedAudit, storeAudit, packageUrl, rememberRequest, requestCall, withRequests, parentFolders, parseToolResponse, parsePackageJson, rows, summarize, tokenFromNpmrc,
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

const files = (tree) => async (path) => tree[path] ?? null;

test("findManifest takes the nearest folder with a manifest", async () => {
  const read = files({ "/Users/a/code/package.json": "{}", "/Users/a/code/svc/go.mod": "module svc" });
  const project = await findManifest("/Users/a/code/svc/cmd", "/Users/a", read);
  assert.equal(project.path, "/Users/a/code/svc/go.mod");
  assert.equal(project.ecosystem.name, "Go");
  assert.equal(project.ecosystem.audited, false);
  assert.equal(project.name, "svc");
  assert.deepEqual(project.deps, []);
});

test("findManifest prefers an audited manifest within one folder", async () => {
  const read = files({ "/r/pyproject.toml": "", "/r/package.json": JSON.stringify({ name: "app", dependencies: { lodash: "^4.0.0" } }) });
  const project = await findManifest("/r", "/Users/a", read);
  assert.equal(project.path, "/r/package.json");
  assert.equal(project.ecosystem.audited, true);
  assert.equal(project.name, "app");
  assert.deepEqual(project.deps, [{ name: "lodash", constraint: "^4.0.0", dev: false }]);
});

test("WATCHED_FILES lists every manifest once", () => {
  assert.deepEqual(WATCHED_FILES, ["package.json", "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt", "Cargo.toml", "go.mod"]);
});

test("findManifest names each unaudited language", async () => {
  for (const [file, name] of [["pyproject.toml", "Python"], ["requirements.txt", "Python"], ["Cargo.toml", "Rust"], ["go.mod", "Go"]]) {
    const project = await findManifest("/r", "/Users/a", files({ [`/r/${file}`]: "" }));
    assert.equal(project.ecosystem.name, name, file);
  }
});

test("findManifest turns a parser that throws into the error state", async () => {
  const go = ECOSYSTEMS.find((e) => e.file === "go.mod");
  const original = go.parse;
  go.parse = () => { throw new Error("unexpected token"); };
  try {
    const project = await findManifest("/r", "/Users/a", files({ "/r/go.mod": "module x" }));
    assert.equal(project.path, "/r/go.mod");
    assert.equal(project.error, "go.mod could not be read: unexpected token");
  } finally { go.parse = original; }
});

test("the Go entry parses, declares go.mod as its own lockfile and carries a note", async () => {
  const go = ECOSYSTEMS.find((e) => e.file === "go.mod");
  assert.equal(go.audited, false);
  assert.deepEqual(go.lockfiles.map((l) => l.file), ["go.mod"]);
  assert.equal(typeof go.lockfiles[0].resolver, "function");
  assert.match(go.note, /go\.mod/);
  const text = "module example.com/svc\n\nrequire (\n\tgithub.com/a/b v1.2.0\n\tgithub.com/c/d v0.1.0 // indirect\n)\n";
  const project = await findManifest("/r", "/Users/a", files({ "/r/go.mod": text }));
  assert.equal(project.name, "example.com/svc");
  assert.deepEqual(project.deps, [{ name: "github.com/a/b", version: "v1.2.0", constraint: "v1.2.0", dev: false }]);
  assert.deepEqual(project.skipped, []);
});

test("findManifest stops at home", async () => {
  const read = files({ "/Users/package.json": "{}", "/package.json": "{}" });
  assert.equal(await findManifest("/Users/a/code", "/Users/a", read), null);
});

test("findManifest counts an empty manifest as found", async () => {
  const project = await findManifest("/r", "/Users/a", files({ "/r/requirements.txt": "" }));
  assert.equal(project.path, "/r/requirements.txt");
});

test("findManifest surfaces a package.json that is not valid JSON", async () => {
  const project = await findManifest("/r", "/Users/a", files({ "/r/package.json": "{ nope", "/r/go.mod": "module r" }));
  assert.equal(project.path, "/r/package.json");
  assert.equal(project.error, "package.json is not valid JSON");
});

test("findManifest surfaces a pyproject.toml that is not valid TOML as the error state", async () => {
  const project = await findManifest("/r", "/Users/a", files({ "/r/pyproject.toml": "[project\nname = 1", "/r/requirements.txt": "httpx" }));
  assert.equal(project.path, "/r/pyproject.toml");
  assert.match(project.error, /^pyproject\.toml line 1: /);
});

test("findManifest keeps list order among unaudited manifests in one folder", async () => {
  const all = { "/r/pyproject.toml": "[project]\ndependencies = []", "/r/requirements.txt": "", "/r/Cargo.toml": "", "/r/go.mod": "" };
  assert.equal((await findManifest("/r", "/Users/a", files(all))).path, "/r/pyproject.toml");
  const { "/r/pyproject.toml": _p, ...noPyproject } = all;
  assert.equal((await findManifest("/r", "/Users/a", files(noPyproject))).path, "/r/requirements.txt");
  assert.equal((await findManifest("/r", "/Users/a", files({ "/r/Cargo.toml": "", "/r/go.mod": "" }))).path, "/r/Cargo.toml");
});

test("findManifest reads requirements.txt when pyproject.toml declares no dependency tables", async () => {
  const read = files({
    "/r/pyproject.toml": '[project]\nname = "app"\ndynamic = ["dependencies"]',
    "/r/requirements.txt": "requests>=2\n",
  });
  const project = await findManifest("/r", "/Users/a", read);
  assert.equal(project.path, "/r/requirements.txt");
  assert.equal(project.ecosystem.file, "requirements.txt");
  assert.equal(project.name, "app");
  assert.equal(project.undeclared, undefined);
  assert.deepEqual(project.deps, [{ name: "requests", constraint: ">=2", dev: false }]);
});

test("findManifest keeps an undeclared pyproject.toml when nothing else is beside it", async () => {
  const read = files({ "/r/pyproject.toml": "[build-system]\nrequires = []", "/r/Cargo.toml": "" });
  const project = await findManifest("/r", "/Users/a", read);
  assert.equal(project.path, "/r/pyproject.toml");
  assert.deepEqual(project.deps, []);
  assert.equal(project.undeclared, true);
});

test("findManifest ignores requirements.txt beside a pyproject.toml that declares its dependencies", async () => {
  const read = files({ "/r/pyproject.toml": "[project]\ndependencies = []", "/r/requirements.txt": "requests\n" });
  const project = await findManifest("/r", "/Users/a", read);
  assert.equal(project.path, "/r/pyproject.toml");
  assert.deepEqual(project.deps, []);
  assert.equal(project.undeclared, undefined);
});

test("both Python entries parse, share their lockfiles and carry a note", () => {
  const python = ECOSYSTEMS.filter((e) => e.id === "pypi");
  assert.deepEqual(python.map((e) => e.file), ["pyproject.toml", "requirements.txt"]);
  for (const e of python) {
    assert.equal(typeof e.parse, "function", e.file);
    assert.deepEqual(e.lockfiles.map((l) => l.file), ["uv.lock", "poetry.lock"], e.file);
    assert.match(e.note, /uv\.lock or poetry\.lock/, e.file);
  }
  assert.equal(python[0].lockfiles, python[1].lockfiles);
});

test("findManifest reads only package.json in a folder that has one", async () => {
  const seen = [];
  const read = async (path) => { seen.push(path); return path === "/r/package.json" ? "{}" : null; };
  await findManifest("/r", "/Users/a", read);
  assert.deepEqual(seen, ["/r/package.json"]);
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

test("parseToolResponse reads plain JSON", () => {
  assert.deepEqual(parseToolResponse(toolReply({ a: { status: "pending" } })), { a: { status: "pending" } });
});

test("parseToolResponse reads an SSE event", () => {
  const body = `event: message\ndata: ${toolReply({ a: { status: "rejected" } })}\n\n`;
  assert.deepEqual(parseToolResponse(body), { a: { status: "rejected" } });
});

test("parseToolResponse surfaces tool and protocol errors", () => {
  const toolError = JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "manifest too large" }] } });
  assert.throws(() => parseToolResponse(toolError), /manifest too large/);
  assert.throws(() => parseToolResponse(JSON.stringify({ error: { message: "bad call" } })), /bad call/);
  assert.throws(() => parseToolResponse(""), /empty answer/);
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

test("rows pin exactly when only older versions are greenflagged", () => {
  const [row] = rows([{ name: "docs", constraint: "1.6.2", dev: false }], {
    docs: { status: "greenflagged", version: "1.5.1", proposed_constraint: "^1.5.1" },
  });
  assert.equal(row.label, "older version only");
  assert.equal(row.detail, "Only older versions are greenflagged. Pin 1.5.1.");
});

test("rows don't call a dist-tag rejected", () => {
  const [row] = rows([{ name: "semver", constraint: "next", dev: false }], {
    semver: { status: "rejected", version: null, reason: { kind: "governance", detail: "unparseable constraint", scope: "version" } },
  });
  assert.equal(row.level, "attention");
  assert.equal(row.label, "can't check");
});

test("rows carry the registry's recommended fix", () => {
  const entry = (remediation) => ({ status: "rejected", reason: { detail: "rejected by review" }, remediation });
  const [swap, bump] = rows(
    [{ name: "request", constraint: "^2.0.0", dev: false }, { name: "tar", constraint: "^4.0.0", dev: false }],
    {
      request: entry([{ relation: "replaced_by", target: "@cypress/request" }]),
      tar: entry([{ relation: "fixed_by", target: "tar", nearest_greenflagged_version: "4.4.18" }]),
    },
  );
  assert.equal(swap.detail, "rejected by review Use @cypress/request instead.");
  assert.equal(bump.detail, "rejected by review Fixed in 4.4.18.");
});

test("rows treat a package the audit omitted as not imported", () => {
  const [row] = rows([{ name: "x", constraint: "*", dev: true }], {});
  assert.equal(row.status, "not_imported");
  assert.equal(row.dev, true);
});

test("requestCall queues a pinned version and leaves a range to latest", () => {
  assert.deepEqual(requestCall("a", "1.2.3").params.arguments, { name: "a", version: "1.2.3" });
  assert.deepEqual(requestCall("a", "1.2.3-beta.1").params.arguments, { name: "a", version: "1.2.3-beta.1" });
  assert.deepEqual(requestCall("a", "^1.2.3").params.arguments, { name: "a" });
  assert.equal(requestCall("a", "*").params.name, "request_package");
});

test("only not imported rows can be requested", () => {
  const deps = [{ name: "new", constraint: "*" }, { name: "ok", constraint: "*" }, { name: "wait", constraint: "*" }];
  const list = withRequests(rows(deps, { ok: { status: "greenflagged", version: "1.0.0" }, wait: { status: "pending" } }), {});
  assert.deepEqual(list.filter((r) => r.requestable).map((r) => r.name), ["new"]);
});

test("a remembered request can't be sent again", () => {
  for (const status of ["queued", "already_queued"]) {
    const [row] = withRequests(rows([{ name: "new", constraint: "*" }], {}), { new: status });
    assert.equal(row.requestable, undefined);
    assert.equal(row.label, "requested");
  }
});

test("a request the registry refuses becomes blocked and stays that way", () => {
  const [row] = withRequests(rows([{ name: "ghost", constraint: "1.0.0" }], {}), { ghost: "not_in_upstream" });
  assert.equal(row.level, "blocked");
  assert.equal(row.label, "not on npm");
  assert.equal(row.requestable, undefined);
});

test("the audit wins once a requested package is imported", () => {
  const [row] = withRequests(rows([{ name: "new", constraint: "*" }], { new: { status: "pending" } }), { new: "queued" });
  assert.equal(row.label, "in review");
});

test("only outcomes that end the request are remembered", () => {
  assert.equal(rememberRequest("queued"), true);
  assert.equal(rememberRequest("not_in_upstream"), true);
  assert.equal(rememberRequest("already_greenflagged"), false);
});

test("packageUrl keeps a scoped name's slash", () => {
  assert.equal(packageUrl("lodash"), "https://greenflagged.dev/packages/npm/lodash");
  assert.equal(packageUrl("@types/node"), "https://greenflagged.dev/packages/npm/@types/node");
});

test("cachedAudit serves a project until its audit is too old", () => {
  const cache = new Map();
  storeAudit(cache, "a", ["row"], 1000);
  assert.deepEqual(cachedAudit(cache, "a", 1000 + AUDIT_TTL_MS - 1), ["row"]);
  assert.equal(cachedAudit(cache, "a", 1000 + AUDIT_TTL_MS), null);
  assert.equal(cache.size, 0);
  assert.equal(cachedAudit(cache, "b", 1000), null);
});

test("storeAudit drops the oldest project past its limit", () => {
  const cache = new Map();
  for (let i = 0; i < 21; i++) storeAudit(cache, `p${i}`, [], i);
  assert.equal(cache.size, 20);
  assert.equal(cache.has("p0"), false);
  storeAudit(cache, "p1", [], 99);
  storeAudit(cache, "new", [], 100);
  assert.equal(cache.has("p1"), true);
  assert.equal(cache.has("p2"), false);
});

test("the sign-in command writes the line tokenFromNpmrc reads", () => {
  assert.deepEqual(SIGN_IN_COMMAND, ["npm", "login", "--registry=https://greenflagged.dev/npm/"]);
  const host = new URL(SIGN_IN_COMMAND[2].split("=")[1]);
  assert.equal(tokenFromNpmrc(`//${host.host}${host.pathname}:_authToken=gflag_abc\n`), "gflag_abc");
});

test("findBlock finds the panel in a layout tree", () => {
  const tree = {
    id: "root", type: "row",
    children: [
      { id: "side", type: "column", children: [{ id: "x", type: "block", content: { mod: "agents" } }] },
      { id: "panel", type: "block", content: { mod: "greenflagged" } },
    ],
  };
  assert.equal(findBlock(tree, "greenflagged"), "panel");
  assert.equal(findBlock({ id: "r", floating: [{ id: "f", content: { mod: "greenflagged" } }] }, "greenflagged"), "f");
  assert.equal(findBlock(tree, "missing"), null);
  assert.equal(findBlock(undefined, "greenflagged"), null);
});

test("tokenFromNpmrc reads a literal or resolves a variable", () => {
  assert.equal(tokenFromNpmrc("//greenflagged.dev/npm/:_authToken=gflag_abc\n"), "gflag_abc");
  assert.equal(tokenFromNpmrc("//npm.greenflagged.dev/:_authToken=gflag_host\n"), "gflag_host");
  const env = (name) => (name === "GREENFLAGGED_TOKEN" ? "gflag_env" : null);
  assert.equal(tokenFromNpmrc("registry=x\n//greenflagged.dev/npm/:_authToken=${GREENFLAGGED_TOKEN}\n", env), "gflag_env");
  assert.equal(tokenFromNpmrc("//registry.npmjs.org/:_authToken=npm_x\n"), null);
  assert.equal(tokenFromNpmrc(null), null);
});
