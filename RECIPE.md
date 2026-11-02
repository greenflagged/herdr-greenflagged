# Greenflagged

Spot rejected and unreviewed npm dependencies as your agent works, and see what to use instead. [Greenflagged](https://greenflagged.dev) is a private npm registry that scans and reviews every package it serves. It is free for personal use.

![Greenflagged panel for link-shortener: 7 ok, 3 attention and 1 blocked; request is rejected, with @cypress/request suggested instead](preview.png)

## What you see

Top to bottom, 320 px wide, on theme `surface`:

- **Header**, 10 px side padding, 1 px `border` line below: the project's `name` from `package.json`
  (13 px semibold `foreground`, or "Dependencies" with no project) and a ↻ at the right (12 px `dim`).
- **Counts**, 12 px: `N ok` in `ansi2`, `N attention` in `ansi3`, `N blocked` in `ansi1`.
- **Notes**, 11 px, only when they apply: dependencies past the 500 cap, the number of local or git
  dependencies with no registry check, and the last error while older results stay on screen. A manifest can
  fail to parse while you edit it. When that happens, the panel keeps showing the last valid list or
  tree. That view must be of the same file on the same machine. The counts and rows are drawn in
  `dim`, so an old "all clear" can't read as current. The error shows in `ansi1` below the counts
  and above the rows, with " · showing the last valid version" appended. If there was no earlier
  valid read, or you have moved to another project or machine, the error shows alone. This state is
  held in memory only. For a local project the panel watches the folder whether or not the manifest
  parses, so saving the fixed file refreshes the panel.
- **Rows**, scrolling. Each has a 7 px dot in its level's color, the package name, a `dev` tag for dev
  dependencies and a status label; below that, the constraint and `→ version`; below that, a reason if
  there is one.
- **`▸ N greenflagged`**: a row that unfolds the ok packages.

## How it behaves

Levels and labels come from the audit `status`:

| Level | Labels |
|---|---|
| blocked (`ansi1`) | `rejected`, `uninstallable`, `not on npm` |
| attention (`ansi3`) | `needs overrides`, `in review`, `not imported`, `deprecated`, `needs upgrade`, `older version only`, `can't check` |
| ok (`ansi2`) | `greenflagged` |

- `deprecated` is `greenflagged` with a null `version`. `needs upgrade` is `greenflagged` with a
  `proposed_constraint`, and `older version only` is the same when `version` is below the constraint.
- `can't check` is `rejected` with the detail `unparseable constraint`, as a dist-tag like `next` gets.
- A rejected row adds the first `remediation`: "Use X instead." or "Fixed in X."
- It follows the focused terminal. Focusing a mod pane, including this panel, keeps the last project.
- It looks for `package.json` in the terminal's folder and upward, stopping at home. It also looks for
  `pyproject.toml`, `requirements.txt` (Python), `Cargo.toml` (Rust) and `go.mod` (Go), which it can't
  audit yet. The nearest folder with any of them wins, and within one folder `package.json` wins.
  When the winner can't be audited, it sends no request. A Python or Rust project shows a plain tree of
  its dependencies, read from `uv.lock`, `poetry.lock` or `Cargo.lock` beside the manifest when there is
  one (for a Rust crate in a workspace, the workspace root's `Cargo.lock`). A Go project shows a plain tree read from `go.mod` alone (direct modules, an "indirect" group,
  `replace` applied; `go.js`'s header lists the edge cases). It also looks for `pom.xml`, then
  `build.gradle.kts`, then `build.gradle` (Java/Kotlin, after `go.mod`). A Maven project shows its
  POM's direct dependencies (`maven.js`'s header lists the edge cases) and a sentence saying the full
  tree needs `mvn dependency:tree`, which the panel doesn't run. A Gradle project shows the dependencies
  its build file declares, matched as text and never evaluated, with `libs.*` resolved from
  `gradle/libs.versions.toml`, read from the build root: the nearest folder holding
  `settings.gradle.kts` or `settings.gradle`, found from the build file's folder upward, stopping
  before home unless the build file is in home itself. With `gradle.lockfile` beside the build file, the locked versions fill the rows and the other
  locked entries sit under a collapsed "resolved" row; without one, a sentence says the full tree needs
  `gradle dependencies` (`gradle.js`'s header lists the edge cases). The header reads "Not checked:
  Kotlin" when the build applies a Kotlin plugin, else "Not checked: Java/Kotlin". A `pyproject.toml` with no dependency
  tables at all (`dynamic = ["dependencies"]`) gives way to a `requirements.txt` beside it.
- It audits on ↻, every 15 minutes, and when a project or its dependencies change, unless that exact
  project and dependency list was audited in the last 5 minutes. Saving with the same dependencies or
  flipping back to a recent project sends no request.
- `›` collapses the docked panel to a 40 px rail: `‹`, the blocked, attention and ok counts stacked in
  their colors, then "Dependencies" reading top to bottom in `muted`, which also expands it. Below 120 px wide it draws the rail however it got there, and `‹` restores the last width.
- `↗` detaches it into a 340×600 window: a key `greenflagged`, kept across restarts, that stays where dropped
  and keeps Freeze and its project. The docked block hides. `↙` in the window docks it again. Dragging
  anywhere but a control moves the window.
- Freeze, 11 px in the header left of ↻, keeps the panel on its project: focus changes are ignored, while
  audits, watching, links and Request carry on. It reads `Frozen` in `accent` until clicked again, and then
  the panel returns to the focused terminal. It lasts as long as the panel copy.
- Agent status doesn't change the panel; it reacts to focus, so it covers agent and plain terminals alike.
- Hovering a `not imported` row swaps its label for a Request button (`solid` on `solid_foreground`, 11 px).
  Clicking shows "Requesting…", then `requested` for good. A registry answer of `not_in_upstream` makes the
  row a red `not on npm`. A failed call shows its error in `ansi1` under the row and can be retried.
- Clicking any row opens `https://greenflagged.dev/packages/npm/<name>` in the browser; rows highlight with
  `hover`. Clicking Request doesn't open it.
- With no token, it sends no request and shows a sign-in screen, 14 px side padding: "Check your dependencies"
  (14 px semibold), one line of `muted` text, a full-width 32 px **Sign in with npm** button (`accent` on
  `accent_foreground`, centered), and "New here? Create a free account", centered. A 1 px `border` line
  follows, then a folded "▸ Other ways to sign in" holding the `npm login` command in a `raised` code block and
  a link to the tokens page. A 401 or 403 adds "Greenflagged refused the token." in `ansi1`.
- The account link opens `https://greenflagged.dev/login`, which both signs in and creates accounts.
- The button opens a tab named "Greenflagged sign in" running that command in the project's folder, and
  the button becomes a native `.frames` spinner with "Waiting for you to sign in…". It looks for a token every 3 seconds for up to 5 minutes,
  then audits by itself as soon as one appears.
- ↻ forgets the token, so a new sign-in takes effect without a restart.

## Built from

- `mod.json`: `{ "place": "right", "size": 320 }`. No layout, no keys. The block is found by walking `layout()`
  for `content.mod`; without one (a mod pane), `›`, `↗` and `↙` aren't drawn.
- Collapse is `layout.resize {id, px}`, detach is `openOverlay {kind: "window"}` plus `layout.hide {id}`, and
  reattach is `layout.show {id}` plus `closeOverlay`. Shared state holds `greenflagged.width` and
  `greenflagged.detached`.
- `audit.js`: pure logic with no Herdr imports. `ECOSYSTEMS` maps a manifest filename to a parser.
- `toml.js`: a small TOML reader, also pure logic, for the Python and Rust manifests and lockfiles. One linear
  pass with no regex and a 1 MiB input cap, because issue #7 reports that Herdr interrupts a synchronous step
  after about a second. The cap bounds the work but doesn't guarantee a parse fits that budget. Duplicate keys
  and redefined tables are errors. Floats and date-times come back as raw strings. A bare value that isn't
  shaped like a boolean, integer, float or date-time is an error; date and time ranges aren't checked. Its
  tests run the valid cases of `toml-test`, vendored in `test/fixtures/toml-test/`.
- `tree.js`: pure logic, the plain dependency tree for a language Greenflagged can't check. A language gets one
  by adding `parse` and `lockfiles` to its `ECOSYSTEMS` entry; Python's are the first. Rows are name and
  version in `muted` with no dots, expanded one level at a time, with an environment marker (or Rust's target cfg and `build`) as a small
  truncated `muted` tag when the lock has one. A shared package expands under each parent,
  a package already on its own path shows "(cycle)", and "N direct, M total" counts each package once. `dev`
  marks a package reachable only through dev dependencies. A resolver that skips the count walk
  (`count: false`) can't tell, so then `dev` marks only the direct dependencies the manifest lists as dev.
  Walks stop at a hard ceiling (`MAX_WALK_VISITS`, `MAX_WALK_POPS`). A lockfile over 16 MB isn't read, and
  a TOML lockfile is parsed without its wheel-hash lines, after which it must be under 1 MiB. It also
  exports `graphResolver` (a lock's package list to `resolve`) and `mergeDirect` (a lock's own record of
  the project's directs, joined with the manifest's) for each language to reuse. A row may carry a
  `kind`, drawn as a `(kind)` tag; a lone `(workspace)` root opens by itself and the counts then read
  "N projects, M total".
- `python.js`: pure logic, Python's half of the tree: `pyproject.toml` (PEP 621, dependency groups,
  poetry) and `requirements.txt` parsers, and `uv.lock` / `poetry.lock` read into package lists.
  Measured 2026-11-01 under Node 26.3.0 (mean of 20 runs, on a local `uv init` project that isn't in
  the repo): its 29-package `uv.lock` (118 KB, 9 KB once its wheel lines are dropped) takes 0.14 ms to
  strip and parse, against 0.47 ms to parse raw. A synthetic 290-package lock (that lock's packages
  copied ten times under new names, 1.18 MB raw and 91 KB stripped) takes 1.25 ms, against 5.0 ms raw.
  At #7's estimated ~1000× for Herdr that is ~0.1 s and ~1.3 s. Its header lists the Python edge
  cases.
- `cargo.js`: pure logic, Rust's half of the tree: a `Cargo.toml` parser (dependency, build and dev
  tables, target tables with their cfg as the marker, `build` as the marker of a build table's rows, `package` renames, `workspace = true` and
  `version.workspace = true`, virtual manifests) and `Cargo.lock` read into a package list. A v3 or v4
  lock edge names a version only when two versions of that crate are locked, and a crate's own lock entry
  says which one a direct means (without one, the highest locked version the direct's constraint
  allows). `cargoProject` is the ecosystem's `gather` hook: it finds the workspace root above a crate,
  reads every member's `Cargo.toml` with I/O main.js injects, and says where the lock is. The tree is then
  a `(workspace)` row over the crates, or a member's own rows, with sibling crates as `(project)` rows
  that expand to their manifests; `cargoUnlocked` gives that shape without a lock.
  Its header lists the Rust edge cases.
- `go.js`: pure logic, Go's half of the tree: `go.mod` read line by line into direct and indirect
  modules with `replace` applied. It runs nothing (no `go mod graph`) and reads no module cache, so
  modules are leaves. `go.mod` is also its lockfile. A malformed `go.mod` is refused with an error
  naming the line ("go.mod line 7: …"), never read in part. "Malformed" is a check on the file's
  shape only, and it can be wrong both ways: a `go.mod` that passes may be one Go rejects (`exclude
  a`), and one Go accepts may be refused (`tool v1.0.0` inside a `require` block). Its header lists
  the Go edge cases and the full definition.
- `xml.js`: pure logic, a small XML reader for `pom.xml`: elements, text, comments and CDATA, in one
  linear pass with a 1 MiB cap. It refuses `<!DOCTYPE`, `<!ENTITY` and any entity beyond the five
  predefined ones and numeric references, so it never fetches a DTD or expands an entity. Its header
  records its Node timing.
- `maven.js`: pure logic, Maven's half of the tree: a POM's `<dependencies>` with `${…}` filled from
  `<properties>`, scopes read as `dev` or a tag, and a version left to a parent or BOM shown as
  `managed`. It runs no `mvn` and reads no `~/.m2`. Its header lists the Maven edge cases.
- `gradle.js`: pure logic, Gradle's half of the tree: a build file cut into tokens and matched against
  the common dependency forms, never evaluated; `settings.gradle(.kts)` for the project name and
  subprojects; the version catalog through `toml.js`; and `gradle.lockfile` as the lockfile, with a
  "resolved" group like Go's "indirect". It runs no `gradle` and reads no `~/.gradle`. Its header lists
  the forms it matches and the Gradle edge cases, and records its Node timing.
- `workspace.js`: pure logic with no imports at all: expanding a workspace's member globs against folder
  listings, minus its excluded folders, capped at 256. Language-neutral, so uv, pnpm or go.work can reuse it.
- `main.js`: the `View`. From `herdr`: `spaces`, `panes`, `focused`, `exec`, `home`, `readTextFile`,
  `watchFolder`, `theme`. It runs `printenv`, `xdg-open` then `open` for links, `find` to list a
  workspace's member folders, and `npm login` through `run("tab.new", { name, argv, folder })`. All of
  its I/O goes through `herdr` with `on`, one path for local and remote spaces; it doesn't import Node's
  `fs`, which reads only under `$HOME` and whose failed import would stop the whole mod loading.
- The audit is one JSON-RPC `tools/call` of `audit_manifest` by `POST https://greenflagged.dev/mcp` with
  `Authorization: Bearer <token>`. The endpoint is stateless, so there is no `initialize`. The answer
  arrives as JSON or as one SSE event, and the result is JSON text in `result.content[0].text`, keyed by
  package name.
- Request is one `tools/call` of `request_package`, with `version` only when the manifest pins an exact one.
  Outcomes are kept per package name in shared state `greenflagged.requested`, and `already_greenflagged`
  isn't kept, it re-audits instead.
- The token comes from `GREENFLAGGED_TOKEN`, else the `_authToken` line of `~/.npmrc` for
  `//greenflagged.dev/npm/` or `//npm.greenflagged.dev/`, which may be a literal or `${VAR}`.
  `npm login --registry=https://greenflagged.dev/npm/` writes that line. It looks on the machine running
  the window first, then on the focused space's machine, using `exec` and `readTextFile` with `on`.

## Watch out

- A direct dependency uv splits by environment marker is one row per locked version, each counted as a
  direct (numpy behind four `python_full_version` markers is four rows).
- The Python edge cases (markers on merged rows, poetry's double locks, uv workspaces) are listed in
  `python.js`'s header.
- The Rust edge cases (workspace discovery, member globs, when a crate counts as standalone, dev tags
  under a crate, the no-lock shape, members outside the root folder that aren't watched) are listed in
  `cargo.js`'s header.
- A Rust crate in a workspace watches the workspace root, recursively, so `target/` is in the watched
  tree. Only manifest and lockfile names trigger a refresh; if a build makes the panel lag, drop paths
  containing `/target/` before that match.
- `fetch` in a mod returns `{ status, url, ok, text(), json() }` and no response headers.
- `audit_manifest` is capped at 500 entries and lists direct dependencies only.
- npm aliases (`"x": "npm:lodash@^4"`) must be audited under the real package name.
- A pattern for local paths must not match tilde ranges. `~1.2.3` is a registry range and `~/pkg` is a
  path. Getting this wrong hides most of an Angular project behind a clean result.
- `older version only` must recommend an exact pin, never `proposed_constraint`: `^1.5.1` allows the newer
  versions that weren't approved, and on public npm those can be the compromised ones.
- The Request button must call `cx.stop_propagation()`, or its click reaches the row and opens the browser.
- Poll for a sign-in only after the button is clicked, and never overlap polls. `watchFolder` can't see a
  remote machine, and `~/.npmrc` may be on one.
- Leave `folder` out of `tab.new` while frozen: the current space may be on another machine.
- Read `overlay` and the window's own props from `props()`. `init`'s first argument doesn't carry them, and
  without `overlay` the window takes itself for the docked copy.
- Every control in a detached window needs `.on_mouse_down("left", ...)` calling `cx.stop_propagation()`, or
  pressing it drags the window.
- A hidden block's copy stays alive with its timers running. Skip its audits while detached, or each project
  is polled twice. ↻ must still work there, so a stuck flag can be recovered.
- GPUI can't rotate text. The rail's label is `label.svg`, "Dependencies" in Geist at 12 px as outlines
  rotated 90° clockwise, 14 px wide. Its path names the mod folder, so a rename has to change it too.
- Guard a request twice: an in-flight set for double clicks, and shared state after it finishes. Only apply
  remembered outcomes to rows still `not_imported`, so the audit wins once the package is imported.
- `home()` is the window's machine. On a remote machine, ask for `HOME` there.
- Don't filter `watchFolder` events to one exact path, and don't re-audit on every event. `npm install`
  fires many, so compare the dependencies before sending anything.
- Key the audit cache on machine, path and dependencies together: the same path can exist on two machines.
- `watchFolder` is local only. On a remote space the panel still reads the manifest there, and picks up
  changes on the timer or ↻.
- Never put the token in `localStorage` or draw it.
- Never call `resolve_dep_tree` for this: it queues imports unless `autoRequest` is false.
- A Gradle subproject reads `settings.gradle(.kts)`, `gradle/libs.versions.toml` and the root's build
  file from its build root, above its own folder, so the panel watches the build root
  (`project.root`), not the subproject's folder. The walk to find that root reads home only when the
  build file is in home itself, which the panel already watches, so it never starts watching home
  for a project below it.
  An unrelated settings file between the project and home is taken as the root, as Gradle itself
  would.

## Done when

- `npm test` passes and `herdr-app check` passes.
- In a project with `request` at `^2.88.0`, focusing its terminal shows a red `rejected` row.
- In a project with `event-stream` at `3.3.6`, that package shows `needs upgrade`.
- A dependency at `~5.4.3` is audited, not counted as local.
- With the token only on the project's machine, the panel still signs in.
- Focusing a terminal in another project switches the panel, and clicking the panel doesn't.
- Adding a dependency to `package.json` adds a row after saving.
- In a `uv init` project with `httpx[http2]`, `numpy` and a dev `pytest`, locked with
  `requires-python >= 3.9`, the panel shows "7 direct, 28 total": `numpy` four times with its marker as
  a tag, both `pytest` rows tagged `dev`, and `httpx` expanding to `h2` with markers. With `uv.lock`
  deleted and ↻ clicked, it shows the no-lockfile note and the three manifest dependencies.
- In a Rust project with a `Cargo.lock`, the panel shows "N direct, M total", `[dev-dependencies]`
  tagged `dev` and `[target.'cfg(...)'.dependencies]` with their cfg as a tag. At a workspace root
  (crab-trade on 2026-11-01) it shows "13 projects, 465 total" under an open "crab-trade (workspace)" row; expanding
  `crab-daemon` shows `crab-core 0.1.0 (project)`, which expands to crab-core's own dependencies, and
  `crab-analysis` shows its `tokio` tagged `dev`. In `crates/daemon` it shows "26 direct, 416 total" with
  versions and the sibling crates as `(project)` rows, and no no-lockfile note. Saving a member's
  `Cargo.toml` rebuilds the tree. With `Cargo.lock` moved away and ↻ clicked, the workspace row and its
  crates still show, at manifest versions, with the no-lockfile note.
- Flipping between two projects inside 5 minutes sends one audit for each, not one per switch.
- `›` gives a rail with the right counts, and `‹` restores the width, including after a restart.
- `↗` opens a window that survives a restart, on the same project if frozen, and `↙` brings the panel back.
- With Freeze on, focusing another project changes nothing, and turning it off switches to that project.
- Requesting a `not imported` package leaves it `requested` after a restart, with no Request button.
- Clicking a row opens its package page, and clicking Request doesn't.
- The sign-up link opens the login page.
- With no token, the panel shows Sign in with npm and sends no request. Finishing the login in the tab it
  opens fills the panel in without clicking ↻.
- A folder with no `package.json` shows "No package.json in this folder or above it."
- A Go repo shows "Not checked: Go" in the header and sends no request. Its tree lists the direct modules
  from `go.mod` with versions, then a dim `▸ indirect` row that opens to the `// indirect` modules, with
  no yellow note: `github.com/brizzai/fleet` (11 direct, 28 indirect) reads "11 direct, 39 total", and
  the rail shows `11`.
- A Maven project shows "Not checked: Java/Kotlin" (or "Kotlin" with `kotlin-maven-plugin`), its direct
  dependencies with `dev`, `provided` and `runtime` tags, and the yellow Maven sentence. A Kotlin Gradle
  project shows "Not checked: Kotlin", its catalog dependencies resolved, the root project's name from
  the root folder and the subproject's folder name from a subproject folder, where the catalog still
  resolves. The root lists its subprojects after its own rows, each as a `▸` row that opens to that
  module's own dependencies (read from its build file) and its links to other modules, and the
  counts line adds what's under them to the total; a `subprojects { }` dependency is tagged
  `every module` at the root and shows in each module too, and a version pinned by
  `dependencyManagement { }` or `constraints { }` replaces `managed`.
- A repo with both `package.json` and `pyproject.toml` still gets the npm audit.
