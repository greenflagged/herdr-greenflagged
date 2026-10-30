// Everything here is plain data in and out, with no Herdr imports, so `npm test`
// can run it under Node without the app.

export const MCP_URL = "https://greenflagged.dev/mcp";
export const packageUrl = (name) => `https://greenflagged.dev/packages/npm/${name}`;
export const MAX_ENTRIES = 500; // audit_manifest's own cap
export const AUDIT_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_AUDITS = 20;
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

// `version` only when the manifest pins one: a range has no single version to
// queue, and the registry takes no version to mean latest.
export function requestCall(name, constraint) {
  const pinned = /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(constraint);
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "request_package", arguments: pinned ? { name, version: constraint } : { name } },
  };
}

// The server answers as JSON or as one SSE event, depending on the transport.
export function parseToolResponse(body) {
  const data = body.trimStart().startsWith("{")
    ? body
    : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
  if (!data) throw new Error("Greenflagged sent an empty answer");
  const reply = JSON.parse(data);
  if (reply.error) throw new Error(reply.error.message ?? "Greenflagged refused the audit");
  const text = reply.result?.content?.find((c) => c.type === "text")?.text;
  if (reply.result?.isError) throw new Error(text ?? "Greenflagged refused the call");
  if (!text) throw new Error("Greenflagged sent no result");
  return JSON.parse(text);
}

const numbers = (text) => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number) ?? null;

function isOlder(version, constraint) {
  const a = numbers(version), b = numbers(constraint);
  if (!a || !b) return false;
  const i = a.findIndex((n, index) => n !== b[index]);
  return i !== -1 && a[i] < b[i];
}

// The first remediation is the registry's recommendation.
function remedy(entry) {
  const best = entry?.remediation?.[0];
  if (best?.relation === "fixed_by") return best.nearest_greenflagged_version ? `Fixed in ${best.nearest_greenflagged_version}.` : null;
  return best?.target ? `Use ${best.target} instead.` : null;
}

export function rows(deps, audit) {
  return deps.slice(0, MAX_ENTRIES).map((dep) => {
    const entry = audit[dep.name];
    const status = entry?.status ?? "not_imported";
    const deprecated = status === "greenflagged" && !entry?.version;
    const changed = status === "greenflagged" && Boolean(entry?.proposed_constraint);
    const older = changed && isOlder(entry.version, dep.constraint);
    // A dist-tag such as `next`: the registry can't read it, which says nothing about the package.
    const unread = status === "rejected" && entry?.reason?.detail === "unparseable constraint";
    return {
      name: dep.name,
      dev: dep.dev,
      constraint: dep.constraint,
      status,
      level: deprecated || changed || unread ? "attention" : LEVELS[status] ?? "attention",
      label: deprecated ? "deprecated" : older ? "older version only" : changed ? "needs upgrade"
        : unread ? "can't check" : LABELS[status] ?? status,
      version: entry?.version ?? null,
      latest: entry?.latest_greenflagged ?? null,
      detail: deprecated ? "Every greenflagged version is deprecated upstream."
        // Exact, because a caret could reach the very versions that aren't approved.
        : older ? `Only older versions are greenflagged. Pin ${entry.version}.`
        : changed ? `No greenflagged version in range. Try ${entry.proposed_constraint}.`
        : unread ? `The registry can't read "${dep.constraint}". Use a version range.`
        : [entry?.reason?.detail, remedy(entry)].filter(Boolean).join(" ") || null,
    };
  }).sort((a, b) =>
    LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.name.localeCompare(b.name));
}

// What a finished request means for its row. Repeat requests are pointless for all
// of these, so each is remembered. already_greenflagged isn't: the next audit shows it.
const REQUEST_OUTCOMES = {
  queued: { level: "attention", label: "requested", detail: "Queued for import and review." },
  already_queued: { level: "attention", label: "requested", detail: "Queued for import and review." },
  rejected: { level: "blocked", label: "rejected", detail: "The registry has already rejected this." },
  not_in_upstream: { level: "blocked", label: "not on npm", detail: "npm has no such package or version." },
};

export const rememberRequest = (status) => status in REQUEST_OUTCOMES;

// Only `not_imported` rows take a remembered outcome, so an audit that has moved on
// wins. The rest stay requestable.
export function withRequests(list, requested) {
  const next = list.map((row) => {
    if (row.status !== "not_imported") return row;
    const outcome = REQUEST_OUTCOMES[requested[row.name]];
    return outcome ? { ...row, ...outcome } : { ...row, requestable: true };
  });
  return next.sort((a, b) =>
    LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.name.localeCompare(b.name));
}

// Audits by project, so flipping between projects doesn't re-audit each time.
export function cachedAudit(cache, key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at < AUDIT_TTL_MS) return hit.list;
  cache.delete(key);
  return null;
}

export function storeAudit(cache, key, list, now) {
  cache.delete(key); // re-adding keeps the oldest first in the Map
  cache.set(key, { list, at: now });
  if (cache.size > MAX_CACHED_AUDITS) cache.delete(cache.keys().next().value);
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
