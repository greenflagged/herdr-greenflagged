// Everything here is plain data in and out, with no Herdr imports, so `npm test`
// can run it under Node without the app.

export const MCP_URL = "https://greenflagged.dev/mcp";
export const MAX_ENTRIES = 500; // audit_manifest's own cap
const MAX_PARENTS = 12;

// A row's level, worst first. `pending` and `not_imported` are not bad news about
// the package: nobody has finished reviewing it.
const LEVELS = {
  rejected: "blocked",
  uninstallable: "blocked",
  not_in_upstream: "blocked",
  greenflagged_with_overrides: "attention",
  pending: "attention",
  not_imported: "attention",
  greenflagged: "ok",
};
export const LEVEL_ORDER = ["blocked", "attention", "ok"];

const LABELS = {
  rejected: "rejected",
  uninstallable: "uninstallable",
  not_in_upstream: "not on npm",
  greenflagged_with_overrides: "needs overrides",
  pending: "in review",
  not_imported: "not imported",
  greenflagged: "greenflagged",
};

// The manifest names to look for, in order. Each entry reads one file into the
// rows shape below, so another ecosystem is another entry here.
export const ECOSYSTEMS = [{ id: "npm", file: "package.json", parse: parsePackageJson }];

// Folders to try from `cwd` upward, stopping after `home` when it is an ancestor.
export function parentFolders(cwd, home) {
  const folders = [];
  let dir = cwd.replace(/\/+$/, "") || "/";
  for (let i = 0; i < MAX_PARENTS; i++) {
    folders.push(dir);
    if (dir === "/" || dir === home) break;
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
  }
  return folders;
}

// Specs that never reach a registry, so a verdict on them would mean nothing.
const LOCAL_SPEC = /^(workspace|file|link|portal|catalog|git|git\+\w+|github|https?):|^\.{0,2}\/|^~\/|^[\w.-]+\/[\w.-]+(#.*)?$/;

export function parsePackageJson(text) {
  let json;
  try { json = JSON.parse(text); } catch { return { error: "package.json is not valid JSON" }; }
  const deps = new Map(), skipped = [];
  const add = (block, dev) => {
    for (const [name, spec] of Object.entries(block ?? {})) {
      if (deps.has(name) || typeof spec !== "string") continue;
      const alias = /^npm:(@?[^@]+)(?:@(.*))?$/.exec(spec);
      if (alias) deps.set(name, { name: alias[1], constraint: alias[2] || "*", dev });
      else if (LOCAL_SPEC.test(spec)) skipped.push(name);
      else deps.set(name, { name, constraint: spec, dev });
    }
  };
  add(json.dependencies, false);
  add(json.optionalDependencies, false);
  add(json.devDependencies, true);
  return { name: typeof json.name === "string" ? json.name : null, deps: [...deps.values()], skipped };
}

export function auditRequest(deps) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "audit_manifest",
      arguments: { manifest: Object.fromEntries(deps.slice(0, MAX_ENTRIES).map((d) => [d.name, d.constraint])) },
    },
  };
}

// The server answers as JSON or as one SSE event, depending on the transport.
export function parseAuditResponse(body) {
  const data = body.trimStart().startsWith("{")
    ? body
    : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
  if (!data) throw new Error("Greenflagged sent an empty answer");
  const reply = JSON.parse(data);
  if (reply.error) throw new Error(reply.error.message ?? "Greenflagged refused the audit");
  const text = reply.result?.content?.find((c) => c.type === "text")?.text;
  if (reply.result?.isError) throw new Error(text ?? "Greenflagged refused the audit");
  if (!text) throw new Error("Greenflagged sent no audit result");
  return JSON.parse(text);
}

export function rows(deps, audit) {
  return deps.slice(0, MAX_ENTRIES).map((dep) => {
    const entry = audit[dep.name];
    const status = entry?.status ?? "not_imported";
    const deprecated = status === "greenflagged" && !entry?.version;
    const upgrade = status === "greenflagged" && Boolean(entry?.proposed_constraint);
    return {
      name: dep.name,
      dev: dep.dev,
      constraint: dep.constraint,
      status,
      level: deprecated || upgrade ? "attention" : LEVELS[status] ?? "attention",
      label: deprecated ? "deprecated" : upgrade ? "needs upgrade" : LABELS[status] ?? status,
      version: entry?.version ?? null,
      latest: entry?.latest_greenflagged ?? null,
      detail: deprecated ? "Every greenflagged version is deprecated upstream."
        : upgrade ? `No greenflagged version in range. Try ${entry.proposed_constraint}.`
        : entry?.reason?.detail ?? null,
    };
  }).sort((a, b) =>
    LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.name.localeCompare(b.name));
}

export function summarize(list) {
  const counts = { blocked: 0, attention: 0, ok: 0 };
  for (const row of list) counts[row.level]++;
  return counts;
}

// The token as ~/.npmrc holds it: a literal, or `${VAR}` for `env` to resolve.
// `npm login` writes it under whichever of the registry's two hosts it was given.
export function tokenFromNpmrc(text, env = () => null) {
  const line = /^\s*\/\/(?:greenflagged\.dev\/npm|npm\.greenflagged\.dev)\/:_authToken\s*=\s*(\S+)\s*$/m.exec(text ?? "");
  if (!line) return null;
  const variable = /^\$\{(\w+)\}$/.exec(line[1]);
  return variable ? env(variable[1]) : line[1];
}
