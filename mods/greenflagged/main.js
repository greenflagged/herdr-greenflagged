import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, home, readTextFile, watchFolder, theme } from "herdr";
import {
  ECOSYSTEMS, MCP_URL, MAX_ENTRIES, auditRequest, parentFolders, parseAuditResponse, rows, summarize, tokenFromNpmrc,
} from "./audit.js";

const RECHECK_MS = 15 * 60 * 1000; // reviews finish on the registry's time, not ours
const TOKEN_URL = "greenflagged.dev/account/tokens";

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
    const here = location() ?? this.here;
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
        if (!project) { this.project = null; this.list = null; this.signature = null; this.watched = null; return settle("none"); }
        if (project.error) { this.project = project; this.list = null; this.signature = null; return settle("error", project.error); }
        this.watch(project, here.on, cx);
        // Saving package.json without touching its dependencies costs no request.
        const signature = JSON.stringify([project.path, project.deps]);
        if (!force && signature === this.signature && this.state === "ready") return;
        const changedProject = project.path !== this.project?.path;
        this.project = project;
        if (changedProject) { this.list = null; settle("loading"); }
        if (!project.deps.length) { this.signature = signature; this.list = []; return settle("ready"); }
        this.token ??= await readToken(here.on);
        if (!this.token) return settle("no-token");
        const response = await fetch(MCP_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(auditRequest(project.deps)),
        });
        if (response.status === 401 || response.status === 403) {
          this.token = null;
          return settle("no-token", "Greenflagged refused the token.");
        }
        if (response.status !== 200) return settle("error", `Greenflagged answered ${response.status}.`);
        const list = rows(project.deps, parseAuditResponse(await response.text()));
        if (run !== this.run) return;
        this.list = list; this.signature = signature; this.checkedAt = Date.now();
        settle("ready");
      } catch (error) {
        settle("error", String(error?.message ?? error));
      }
    });
  }

  row(item, t) {
    const color = { blocked: t.ansi1, attention: t.ansi3, ok: t.ansi2 }[item.level];
    const wanted = item.version && item.version !== item.constraint ? ` → ${item.version}` : "";
    return v_flex().id(`dep-${item.name}`).px(10).py(3).gap(1)
      .child(h_flex().gap(6).items_center()
        .child(div().w(7).h(7).rounded(4).bg(color))
        .child(div().flex_1().truncate().text_color(t.foreground).child(item.name))
        .when(item.dev, (el) => el.child(div().text_color(t.dim).text_size(11).child("dev")))
        .child(div().text_color(color).text_size(11).child(item.label)))
      .child(div().pl(13).truncate().text_color(t.dim).text_size(11).child(`${item.constraint}${wanted}`))
      .when(Boolean(item.detail), (el) => el.child(div().pl(13).text_color(t.muted).text_size(11).child(item.detail)));
  }

  body(t) {
    const note = (text) => div().p(10).text_color(t.muted).text_size(12).child(text);
    if (this.state === "none") return note("No package.json in this folder or above it.");
    if (this.state === "no-token") {
      return v_flex().p(10).gap(6).text_size(12).text_color(t.muted)
        .when(Boolean(this.message), (el) => el.child(div().text_color(t.ansi1).child(this.message)))
        .child(div().child("Sign in from a terminal, then click ↻:"))
        .child(div().text_color(t.foreground).child("npm login --registry=https://greenflagged.dev/npm/"))
        .child(div().child(`Or mint a token at ${TOKEN_URL} and export it as GREENFLAGGED_TOKEN.`));
    }
    if (this.state === "error" && !this.list) return div().p(10).text_color(t.ansi1).text_size(12).child(this.message);
    if (!this.list) return note("Checking…");
    if (!this.list.length) return note("This project has no registry dependencies.");
    const flagged = this.list.filter((r) => r.level !== "ok"), ok = this.list.filter((r) => r.level === "ok");
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
    const t = theme(), here = location();
    if (here && JSON.stringify(here) !== this.context) this.refresh(cx);
    const counts = this.list ? summarize(this.list) : null;
    const pill = (count, color, text) => div().text_size(12).text_color(color).child(`${count} ${text}`);
    return v_flex().size_full().bg(t.surface).child(
      v_flex().px(10).py(8).gap(3).border_b(1).border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground)
            .child(this.project?.name ?? "Dependencies"))
          .child(div().id("refresh").px(4).text_size(12).text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.token = null; this.refresh(cx, { force: true }); })
            .child("↻")))
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
    ).child(this.body(t));
  }
}
