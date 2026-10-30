import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, home, readTextFile, shared, setShared, watchFolder, theme } from "herdr";
import {
  ECOSYSTEMS, MCP_URL, MAX_ENTRIES, auditRequest, cachedAudit, packageUrl, parentFolders, parseToolResponse, rememberRequest, requestCall, rows,
  storeAudit, summarize, tokenFromNpmrc, withRequests,
} from "./audit.js";

const RECHECK_MS = 15 * 60 * 1000; // reviews finish on the registry's time, not ours
const TOKEN_URL = "greenflagged.dev/account/tokens";
const REQUESTED = "greenflagged.requested"; // in shared state, so it outlives a restart

// The terminal in focus, or null when focus is on something with no folder, such
// as this panel: clicking here must not change which project it shows.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) return null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || space?.folder;
  return cwd ? { cwd, on } : null;
}

// The app may run on one machine and the project on another, and `npm login` could
// have been run on either, so try both, this machine first.
async function readToken(on) {
  for (const machine of on ? [null, on] : [null]) {
    const env = async (name) => {
      const result = await exec("printenv", [name], { on: machine }).catch(() => null);
      return result?.code === 0 ? result.stdout.trim() : null;
    };
    const direct = await env("GREENFLAGGED_TOKEN");
    if (direct) return direct;
    const folder = machine ? await env("HOME") : home();
    const text = await readTextFile(`${folder}/.npmrc`, { on: machine }).catch(() => null);
    const value = tokenFromNpmrc(text, (name) => name);
    const token = value && text.includes(`\${${value}}`) ? await env(value) : value;
    if (token) return token;
  }
  return null;
}

// The browser is on the machine running the window, so this never takes `on`.
function openUrl(url) {
  exec("xdg-open", [url]).catch(() => exec("open", [url]).catch(() => {}));
}

function post(token, body) {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function findManifest({ cwd, on }, stop) {
  for (const folder of parentFolders(cwd, stop)) {
    for (const ecosystem of ECOSYSTEMS) {
      const path = `${folder}/${ecosystem.file}`;
      const text = await readTextFile(path, { on }).catch(() => null);
      if (text !== null) return { folder, path, ecosystem, ...ecosystem.parse(text) };
    }
  }
  return null;
}

export default class Greenflagged extends View {
  init(_props, cx) {
    this.state = "idle"; // idle | none | loading | ready | no-token | error
    this.showOk = false;
    this.requesting = new Set(); // in flight, so a second click can't send a second request
    this.requestErrors = new Map();
    this.audits = new Map();
    this.frozen = false;
    this.refresh(cx);
    cx.timer.every(RECHECK_MS, (cx) => this.refresh(cx, { force: true }));
  }

  // Each folder change restarts this; `watched` is what ends the old loop.
  watch(project, on, cx) {
    if (on) { this.watched = null; return; } // watchFolder is local only
    if (this.watched === project.folder) return;
    const { folder, ecosystem } = project;
    this.watched = folder;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === folder) {
          const changed = await watchFolder(folder);
          if (this.watched === folder && changed.some((p) => p.endsWith(`/${ecosystem.file}`))) this.refresh(cx);
        }
      } catch { if (this.watched === folder) this.watched = null; }
    });
  }

  refresh(cx, { force = false } = {}) {
    const here = (this.frozen ? null : location()) ?? this.here;
    if (!here) return;
    this.here = here;
    const context = JSON.stringify(here);
    if (context !== this.context) { this.context = context; this.showOk = false; }
    const run = (this.run ?? 0) + 1;
    this.run = run;
    cx.spawn(async (cx) => {
      const settle = (state, message) => {
        if (run !== this.run) return;
        this.state = state; this.message = message ?? null;
        cx.notify();
      };
      try {
        const project = await findManifest(here, home());
        if (run !== this.run) return;
        if (!project) { this.project = null; this.list = null; this.watched = null; return settle("none"); }
        if (project.error) { this.project = project; this.list = null; return settle("error", project.error); }
        this.watch(project, here.on, cx);
        // Saving package.json without touching its dependencies costs no request.
        const signature = JSON.stringify([here.on, project.path, project.deps]);
        const cached = force ? null : cachedAudit(this.audits, signature, Date.now());
        if (cached) { this.project = project; this.list = cached; return settle("ready"); }
        const changedProject = project.path !== this.project?.path;
        this.project = project;
        if (changedProject) { this.list = null; settle("loading"); }
        if (!project.deps.length) { this.list = []; return settle("ready"); }
        this.token ??= await readToken(here.on);
        if (!this.token) return settle("no-token");
        const response = await post(this.token, auditRequest(project.deps));
        if (response.status === 401 || response.status === 403) {
          this.token = null;
          return settle("no-token", "Greenflagged refused the token.");
        }
        if (response.status !== 200) return settle("error", `Greenflagged answered ${response.status}.`);
        const list = rows(project.deps, parseToolResponse(await response.text()));
        if (run !== this.run) return;
        storeAudit(this.audits, signature, list, Date.now());
        this.list = list;
        settle("ready");
      } catch (error) {
        settle("error", String(error?.message ?? error));
      }
    });
  }

  request(item, cx) {
    if (!item.requestable || this.requesting.has(item.name)) return;
    this.requesting.add(item.name);
    this.requestErrors.delete(item.name);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.token ??= await readToken(this.here?.on);
        if (!this.token) throw new Error("Sign in to request packages.");
        const response = await post(this.token, requestCall(item.name, item.constraint));
        if (response.status === 401 || response.status === 403) this.token = null;
        if (response.status !== 200) throw new Error(`Greenflagged answered ${response.status}.`);
        const { status } = parseToolResponse(await response.text());
        if (rememberRequest(status)) setShared(REQUESTED, { ...(shared(REQUESTED) ?? {}), [item.name]: status });
        else this.refresh(cx, { force: true });
      } catch (error) {
        this.requestErrors.set(item.name, String(error?.message ?? error));
      }
      this.requesting.delete(item.name);
      cx.notify();
    });
  }

  status(item, color, t) {
    const busy = this.requesting.has(item.name);
    if (busy) return div().text_color(t.dim).text_size(11).child("Requesting…");
    if (!item.requestable || this.hovered !== item.name) return div().text_color(color).text_size(11).child(item.label);
    return div().id(`request-${item.name}`).px(6).rounded(4).text_size(11).bg(t.solid).text_color(t.solid_foreground)
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); this.request(item, cx); }).child("Request");
  }

  row(item, t) {
    const color = { blocked: t.ansi1, attention: t.ansi3, ok: t.ansi2 }[item.level];
    const wanted = item.version && item.version !== item.constraint ? ` → ${item.version}` : "";
    const failure = this.requestErrors.get(item.name);
    return v_flex().id(`dep-${item.name}`).px(10).py(3).gap(1).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { openUrl(packageUrl(item.name)); })
      .when(Boolean(item.requestable), (el) => el.on_hover((on, cx) => {
        this.hovered = on ? item.name : this.hovered === item.name ? null : this.hovered;
        cx.notify();
      }))
      .child(h_flex().gap(6).items_center()
        .child(div().w(7).h(7).rounded(4).bg(color))
        .child(div().flex_1().truncate().text_color(t.foreground).child(item.name))
        .when(item.dev, (el) => el.child(div().text_color(t.dim).text_size(11).child("dev")))
        .child(this.status(item, color, t)))
      .child(div().pl(13).truncate().text_color(t.dim).text_size(11).child(`${item.constraint}${wanted}`))
      .when(Boolean(item.detail), (el) => el.child(div().pl(13).text_color(t.muted).text_size(11).child(item.detail)))
      .when(Boolean(failure), (el) => el.child(div().pl(13).text_color(t.ansi1).text_size(11).child(failure)));
  }

  body(t, list) {
    const note = (text) => div().p(10).text_color(t.muted).text_size(12).child(text);
    if (this.state === "none") return note("No package.json in this folder or above it.");
    if (this.state === "no-token") {
      return v_flex().p(10).gap(6).text_size(12).text_color(t.muted)
        .when(Boolean(this.message), (el) => el.child(div().text_color(t.ansi1).child(this.message)))
        .child(div().child("Sign in from a terminal, then click ↻:"))
        .child(div().text_color(t.foreground).child("npm login --registry=https://greenflagged.dev/npm/"))
        .child(div().child(`Or mint a token at ${TOKEN_URL} and export it as GREENFLAGGED_TOKEN.`));
    }
    if (this.state === "error" && !list) return div().p(10).text_color(t.ansi1).text_size(12).child(this.message);
    if (!list) return note("Checking…");
    if (!list.length) return note("This project has no registry dependencies.");
    const flagged = list.filter((r) => r.level !== "ok"), ok = list.filter((r) => r.level === "ok");
    const items = flagged.map((r) => this.row(r, t));
    if (ok.length) {
      items.push(div().id("toggle-ok").px(10).py(5).text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.showOk = !this.showOk; cx.notify(); })
        .child(`${this.showOk ? "▾" : "▸"} ${ok.length} greenflagged`));
    }
    if (this.showOk) items.push(...ok.map((r) => this.row(r, t)));
    return v_flex().id("deps").flex_1().min_h(0).text_size(13).overflow_y_scrollbar().children(items);
  }

  render(cx) {
    const t = theme(), here = this.frozen ? null : location();
    if (here && JSON.stringify(here) !== this.context) this.refresh(cx);
    const list = this.list ? withRequests(this.list, shared(REQUESTED) ?? {}) : null;
    const counts = list ? summarize(list) : null;
    const pill = (count, color, text) => div().text_size(12).text_color(color).child(`${count} ${text}`);
    return v_flex().size_full().bg(t.surface).child(
      v_flex().px(10).py(8).gap(3).border_b(1).border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground)
            .child(this.project?.name ?? "Dependencies"))
          .child(h_flex().flex_none().gap(6).items_center()
            .when(Boolean(this.project), (el) => el.child(
              div().id("freeze").px(4).text_size(11).cursor_pointer()
                .text_color(this.frozen ? t.accent : t.muted).hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => { this.frozen = !this.frozen; cx.notify(); })
                .child(this.frozen ? "Frozen" : "Freeze")))
            .child(div().id("refresh").px(4).text_size(12).cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => { this.token = null; this.refresh(cx, { force: true }); })
              .child("↻"))))
        .when(Boolean(counts), (el) => el.child(h_flex().gap(10)
          .child(pill(counts.ok, t.ansi2, "ok"))
          .child(pill(counts.attention, t.ansi3, "attention"))
          .child(pill(counts.blocked, t.ansi1, "blocked"))))
        .when(this.project?.deps?.length > MAX_ENTRIES, (el) => el.child(
          div().text_size(11).text_color(t.ansi3).child(`Showing the first ${MAX_ENTRIES} dependencies.`)))
        .when(this.project?.skipped?.length > 0, (el) => el.child(
          div().text_size(11).text_color(t.dim).child(`${this.project.skipped.length} local or git dependencies not checked.`)))
        .when(this.state === "error" && Boolean(this.list), (el) => el.child(
          div().text_size(11).text_color(t.ansi1).child(this.message))),
    ).child(this.body(t, list));
  }
}
