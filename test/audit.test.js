import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AUDIT_TTL_MS, ECOSYSTEMS, MAX_ENTRIES, WATCHED_FILES, SIGN_IN_COMMAND, auditRequest, findBlock, findManifest, cachedAudit, storeAudit, packageUrl, rememberRequest, requestCall, withRequests, parentFolders, parseToolResponse, parsePackageJson, rows, summarize, tokenFromNpmrc, lastValidProject, staleNote,
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
  assert.deepEqual(WATCHED_FILES, [
    "package.json", "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt", "Cargo.toml", "Cargo.lock", "go.mod", "pom.xml",
    "build.gradle.kts", "gradle.lockfile", "settings.gradle.kts", "settings.gradle", "gradle/libs.versions.toml", "build.gradle",
  ]);
});

test("findManifest names each unaudited language", async () => {
  for (const [file, name] of [["pyproject.toml", "Python"], ["requirements.txt", "Python"], ["Cargo.toml", "Rust"], ["go.mod", "Go"],
    ["pom.xml", "Java/Kotlin"], ["build.gradle.kts", "Java/Kotlin"], ["build.gradle", "Java/Kotlin"]]) {
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
  const jvm = { "/r/pom.xml": "<project/>", "/r/build.gradle.kts": "", "/r/build.gradle": "" };
  assert.equal((await findManifest("/r", "/Users/a", files({ ...jvm, "/r/go.mod": "" }))).path, "/r/go.mod");
  assert.equal((await findManifest("/r", "/Users/a", files(jvm))).path, "/r/pom.xml");
  const { "/r/pom.xml": _m, ...gradle } = jvm;
  assert.equal((await findManifest("/r", "/Users/a", files(gradle))).path, "/r/build.gradle.kts");
  assert.equal((await findManifest("/r", "/Users/a", files({ "/r/build.gradle": "" }))).path, "/r/build.gradle");
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

test("lastValidProject keeps the last valid read of the same file only", async () => {
  const good = await findManifest("/r", "/Users/a", files({ "/r/package.json": '{"dependencies":{"a":"1"}}' }));
  const bad = await findManifest("/r", "/Users/a", files({ "/r/package.json": "{ nope" }));
  const other = await findManifest("/s", "/Users/a", files({ "/s/package.json": "{ nope" }));
  assert.ok(bad.error);
  assert.equal(lastValidProject(good, bad), good);
  assert.equal(lastValidProject(good, other), null); // another project: nothing carried over
  assert.equal(lastValidProject(bad, bad), null); // no valid read yet: the error alone
  assert.equal(lastValidProject(null, bad), null);
  assert.equal(lastValidProject(undefined, bad), null);
});

test("lastValidProject never carries a view across machines", async () => {
  const good = await findManifest("/r", "/Users/a", files({ "/r/package.json": '{"dependencies":{"a":"1"}}' }));
  const bad = await findManifest("/r", "/Users/a", files({ "/r/package.json": "{ nope" }));
  const on = (project, machine) => ({ ...project, on: machine });
  const boxGood = on(good, "box");
  assert.equal(lastValidProject(boxGood, on(bad, "box")), boxGood); // same path, same machine
  assert.equal(lastValidProject(boxGood, on(bad, "other")), null); // same path, another machine
  assert.equal(lastValidProject(boxGood, on(bad, null)), null); // remote, then this machine
  assert.equal(lastValidProject(boxGood, bad), null); // `on` missing counts as this machine
  const hereGood = on(good, null);
  assert.equal(lastValidProject(hereGood, bad), hereGood); // null and missing are both this machine
});

test("staleNote puts the parse error first and says the view is the last valid one", () => {
  assert.equal(staleNote("go.mod line 7: x"), "go.mod line 7: x · showing the last valid version");
});

// --- companions (Gradle's build root) ------------------------------------------------

const recording = (tree) => {
  const seen = [];
  return { seen, read: async (path) => { seen.push(path); return tree[path] ?? null; } };
};
const TIER_2 = ["pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle.kts", "build.gradle"];

test("a subproject's build root is the nearest folder with a settings file, and the catalog is read there", async () => {
  const { seen, read } = recording({
    "/home/u/r/app/build.gradle.kts": 'dependencies {\n implementation(libs.ktor)\n}',
    "/home/u/r/settings.gradle.kts": 'rootProject.name = "big"\ninclude(":app")',
    "/home/u/r/gradle/libs.versions.toml": '[libraries]\nktor = "io.ktor:ktor-server-core:2.3.11"',
  });
  const project = await findManifest("/home/u/r/app", "/home/u", read);
  assert.equal(project.path, "/home/u/r/app/build.gradle.kts");
  assert.equal(project.folder, "/home/u/r/app");
  assert.equal(project.root, "/home/u/r");
  assert.equal(project.name, "app");
  assert.deepEqual(project.deps, [{ name: "io.ktor:ktor-server-core", constraint: "2.3.11", dev: false }]);
  const manifestReads = ["/home/u/r/app/package.json", ...TIER_2.map((f) => `/home/u/r/app/${f}`)];
  assert.deepEqual(seen, [
    ...manifestReads,
    "/home/u/r/app/settings.gradle.kts", "/home/u/r/app/settings.gradle",
    "/home/u/r/settings.gradle.kts", "/home/u/r/settings.gradle",
    "/home/u/r/gradle/libs.versions.toml", "/home/u/r/build.gradle.kts", "/home/u/r/build.gradle",
  ]);
});

test("the walk for a build root never reads home", async () => {
  const { seen, read } = recording({
    "/home/u/r/app/build.gradle.kts": "",
    "/home/u/settings.gradle.kts": 'include(":everything")',
    "/home/u/r/app/gradle/libs.versions.toml": "",
  });
  const project = await findManifest("/home/u/r/app", "/home/u", read);
  assert.equal(project.root, "/home/u/r/app");
  const companionReads = seen.slice(1 + TIER_2.length);
  assert.ok(!companionReads.some((p) => p.startsWith("/home/u/settings")), companionReads.join(", "));
  assert.deepEqual(companionReads, [
    "/home/u/r/app/settings.gradle.kts", "/home/u/r/app/settings.gradle",
    "/home/u/r/settings.gradle.kts", "/home/u/r/settings.gradle",
    "/home/u/r/app/gradle/libs.versions.toml", "/home/u/r/app/build.gradle.kts", "/home/u/r/app/build.gradle",
  ]);
});

test("with no settings file anywhere, the build file's folder is the root", async () => {
  const { seen, read } = recording({ "/srv/p/build.gradle": "" });
  const project = await findManifest("/srv/p", "/Users/a", read);
  assert.equal(project.root, "/srv/p");
  assert.deepEqual(seen.slice(-3), ["/srv/p/gradle/libs.versions.toml", "/srv/p/build.gradle.kts", "/srv/p/build.gradle"]);
  assert.ok(!seen.includes("/settings.gradle.kts")); // `/` is never read for a root marker
});

test("a manifest directly in home may find its settings there", async () => {
  const project = await findManifest("/home/u", "/home/u", files({ "/home/u/build.gradle.kts": "", "/home/u/settings.gradle.kts": 'rootProject.name = "h"' }));
  assert.equal(project.root, "/home/u");
  assert.equal(project.name, "h");
});

test("a malformed build file still carries its build root", async () => {
  const project = await findManifest("/home/u/r/app", "/home/u", files({
    "/home/u/r/app/build.gradle.kts": 'dependencies { implementation("never closed }',
    "/home/u/r/settings.gradle.kts": "",
  }));
  assert.match(project.error, /^build\.gradle\.kts line 1: /);
  assert.equal(project.root, "/home/u/r");
});

test("companions are never read for go.mod", async () => {
  const { seen, read } = recording({ "/r/go.mod": "module r" });
  const project = await findManifest("/r", "/Users/a", read);
  assert.deepEqual(seen, ["/r/package.json", ...TIER_2.map((f) => `/r/${f}`)]);
  assert.equal(project.root, "/r");
});

test("an entry without companions, and the requirements.txt fallback, have root equal to folder", async () => {
  assert.equal((await findManifest("/r", "/Users/a", files({ "/r/package.json": "{}" }))).root, "/r");
  const fallback = await findManifest("/r", "/Users/a", files({ "/r/pyproject.toml": "[build-system]", "/r/requirements.txt": "x\n" }));
  assert.equal(fallback.path, "/r/requirements.txt");
  assert.equal(fallback.root, "/r");
});

test("parse gets every companion name, null when missing, and both folders", async () => {
  const gradle = ECOSYSTEMS.find((e) => e.file === "build.gradle.kts");
  const original = gradle.parse, calls = [];
  gradle.parse = (text, context) => { calls.push(context); return { name: null, deps: [], skipped: [] }; };
  try {
    await findManifest("/home/u/r/app", "/home/u", files({ "/home/u/r/app/build.gradle.kts": "", "/home/u/r/settings.gradle": "s" }));
  } finally { gradle.parse = original; }
  assert.deepEqual(calls, [{
    files: { "settings.gradle.kts": null, "settings.gradle": "s", "gradle/libs.versions.toml": null, "build.gradle.kts": null, "build.gradle": null },
    root: "/home/u/r",
    folder: "/home/u/r/app",
  }]);
});

test("a Kotlin Gradle build's language lands on the project; a Java one has none", async () => {
  const kotlin = await findManifest("/r", "/Users/a", files({ "/r/build.gradle.kts": 'plugins { kotlin("jvm") }' }));
  assert.equal(kotlin.language, "Kotlin");
  const java = await findManifest("/r", "/Users/a", files({ "/r/build.gradle": "plugins { id 'java' }" }));
  assert.equal("language" in java, false);
});

// Steward W3's number: every folder without a manifest costs one read per registered
// manifest. Act when the second tier passes ~10 names.
test("a 12-deep path with no manifest costs one read per manifest per folder", async () => {
  const { seen, read } = recording({});
  const deep = "/a/b/c/d/e/f/g/h/i/j/k/l";
  assert.equal(await findManifest(deep, "/home/u", read), null);
  assert.equal(ECOSYSTEMS.length, 8);
  assert.equal(seen.length, 12 * 8);
});

// README's list of files read is a privacy disclosure, so it must name every watched file.
test("README and RECIPE name every file the panel reads", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const recipe = readFileSync(new URL("../RECIPE.md", import.meta.url), "utf8");
  const files = readme.slice(readme.indexOf("**Files:**"), readme.indexOf("**Programs:**"));
  assert.ok(files.length > 0);
  for (const name of WATCHED_FILES) {
    assert.ok(files.includes(`\`${name}\``), `README's Files bullet lacks ${name}`);
    assert.ok(recipe.includes(`\`${name}\``), `RECIPE.md lacks ${name}`);
  }
});

test("the Rust entry places a crate in its workspace and shapes a tree without a lock", () => {
  const cargo = ECOSYSTEMS.find((e) => e.id === "cargo");
  assert.equal(typeof cargo.gather, "function");
  assert.equal(typeof cargo.unlocked, "function");
  assert.equal(ECOSYSTEMS.filter((e) => e.gather || e.unlocked).length, 1);
});
