# Greenflagged for Herdr

A [Herdr](https://herdr.dev) panel that follows the terminal you're working in, finds its
`package.json`, and shows each direct dependency's [Greenflagged](https://greenflagged.dev) status.
The problems come first, and the greenflagged packages fold away behind a count.

What it does depends on the project's language:

| Language | What the panel shows | Read from |
|---|---|---|
| JavaScript (npm) | Each direct dependency's Greenflagged verdict | `package.json` |
| Python | A plain dependency tree, not checked | `pyproject.toml` or `requirements.txt`, with `uv.lock` or `poetry.lock` |
| Rust | A plain dependency tree, not checked | `Cargo.toml` and `Cargo.lock` |
| Go | Its direct modules, then its indirect ones in a group, each opening into the modules it needs, not checked | `go.mod`, plus Go's module cache |
| Java and Kotlin | Its direct dependencies, not checked | `pom.xml` or the Gradle build file, with `gradle.lockfile` when there is one |

Only npm gets verdicts. For the other languages the panel sends nothing: there are no dots, the
header says "no Greenflagged checks yet", and you get the tree to browse. A Cargo workspace shows as
the workspace with its crates under it, and a crate's folder inside one shows that crate with its
sibling crates as expandable `(project)` rows, read from the workspace's `Cargo.lock`. Maven and
Gradle are read without running either. Python verdicts follow once Greenflagged's PyPI audit is
live.

A Go module row opens into the modules its own `go.mod` requires. The panel reads those from Go's
module cache on the machine that holds the project, at the versions your `go.mod` selects, and never
runs `go` or downloads anything. A module that isn't in the cache shows as a leaf tagged
`not downloaded`. When no module cache is found, the Go tree stays flat, with a note saying so. The
files it reads there are listed under [What it does on your machine](#what-it-does-on-your-machine).

## What it looks like

The panel opens on a project with one blocked dependency and suggests a replacement for it:

![link-shortener project with 7 ok, 3 attention and 1 blocked; request is rejected, with @cypress/request suggested instead](docs/1-before.webp)

Swapping `request` for `@cypress/request` clears the block, and the panel updates by itself:

![Diff replacing request with @cypress/request; the panel updates to 8 ok, 3 attention, 0 blocked](docs/2-swap-request.webp)

Moving the other three to the suggested versions greenflags every dependency:

![Diff updating chalk, colors and debug to the suggested versions; the panel shows all 11 dependencies greenflagged](docs/3-all-green.webp)

In a language Greenflagged doesn't check yet, the panel shows the dependency tree instead. Here, in
one crate of a Rust workspace, two sibling crates are open:

![Panel for crab-daemon reading "Rust: no Greenflagged checks yet" and "26 direct, 416 total", with its dependencies as plain rows and the crab-notifier and crab-risk sibling crates expanded to their own dependencies, some tagged dev](docs/4-tree.webp)

## Install

Ask your agent to add `github.com/greenflagged/herdr-greenflagged`, or copy the folder yourself:

```sh
git clone https://github.com/greenflagged/herdr-greenflagged
cp -R herdr-greenflagged/mods/greenflagged ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/greenflagged
```

It docks on the right the first time Herdr sees it. Install it on the machine that runs the Herdr
window, even if your projects are on another one.

## Update

Herdr doesn't update mods. To update this one, pull the repo and replace the folder:

```sh
git -C herdr-greenflagged pull
rm -rf ~/.config/herdr-app/mods/greenflagged
cp -R herdr-greenflagged/mods/greenflagged ~/.config/herdr-app/mods/
```

## Sign in

New to Greenflagged? Create a free account at <https://greenflagged.dev/login>, or use the link in
the panel. `npm login` opens the same page, so you can also sign up as part of signing in.

The panel needs a Greenflagged token. The quickest way is the **Sign in with npm** button, which opens a
tab running `npm login` and picks up the token when you finish. Or run it yourself, then click ↻:

```sh
npm login --registry=https://greenflagged.dev/npm/
```

This saves the token in `~/.npmrc`. It doesn't change where npm installs from.

You can also mint a token at <https://greenflagged.dev/account/tokens> and export it from your shell
profile. `GREENFLAGGED_TOKEN` wins over `~/.npmrc`:

```sh
export GREENFLAGGED_TOKEN=gflag_...
```

If the focused terminal is on another machine, the panel looks for a token on the machine running
Herdr first, then on that one, so you only need to sign in on one of them.

## What it does on your machine

- **Network:** it sends the name and version range of each direct dependency to
  `https://greenflagged.dev/mcp`, with your token. That includes the names of private packages.
  It sends nothing else from your project. For Python, Rust, Go, Java and Kotlin it sends nothing
  at all: the tree is built from the files below, on your machine.
- **Requests:** hovering a `not imported` package shows a Request button. Clicking it asks Greenflagged
  to import and review that package, under your token. Nothing is requested unless you click.
- **Files:** it reads `package.json` from your terminal's folder and the folders above it, looks for
  `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle.kts` and
  `build.gradle` there too, `uv.lock` and `poetry.lock` beside a Python manifest, `Cargo.lock` at the
  root of a Rust project's workspace (beside the manifest for a crate outside any), and
  `gradle.lockfile` beside a Gradle build file. In a Rust workspace it also reads the root's
  `Cargo.toml` and every member crate's, up to 256. A member path may point outside the project
  (`../x` or an absolute path), as Cargo allows, and that `Cargo.toml` is still read. For a Gradle
  build it also looks for `settings.gradle.kts` or `settings.gradle` in the build file's folder and
  the folders above it, stopping before your home folder (home is checked only when the build file
  itself is there), and reads `gradle/libs.versions.toml`, `build.gradle.kts` and `build.gradle` from
  the first folder that has one. At that root it also reads `build.gradle.kts` or `build.gradle` from
  each module folder the settings file includes (up to 100), only plain folder names under the root,
  never `..`. For a Go project it also reads from Go's module cache: `GOMODCACHE`, else the first
  `GOPATH` folder plus `/pkg/mod`, else `~/go/pkg/mod`, on the machine that holds the project. It
  reads only `cache/lock` and `.mod` files under `cache/download/`, and nothing when it finds no
  cache folder. Each time it builds the tree it reads `cache/lock`, to tell whether there is a
  cache; if that file is missing, it reads the first module's `.mod` instead. It reads a module's
  `.mod` for each row that is open: when you open it, and when a refresh re-opens the rows that were
  open. For the session it keeps the contents of up to 2,000 `.mod` files of 16 Ki chars or less,
  dropping the one kept longest when there are more. A kept file isn't read from disk again; a
  dropped, missing or longer one is read again the next time it's needed. It reads `~/.npmrc`. It
  writes nothing to your project. Requests are remembered in Herdr's `shared.json`.
- **Programs:** it runs `printenv` to read your token, `xdg-open` or `open` when you click a row,
  `find` to list a Cargo workspace's member folders, and `npm login` when you click Sign in. For a Go
  project `printenv` also reads `GOMODCACHE` and `GOPATH` on the machine that holds the project, to
  find the module cache, and `HOME` there too when that machine is a remote one (a local project uses
  Herdr's own home folder).

## When it checks

It checks when you focus a different project, when the dependencies in `package.json` change, and
every 15 minutes while it's open. Going back to a project within 5 minutes reuses its last result, and ↻
always checks again.

Click **›** to collapse the panel to a narrow rail showing its counts, and **‹** to expand it. Click **↗**
to detach it into a floating window you can drag anywhere, and **↙** to dock it again.

Click **Freeze** to keep the panel on the current project while you work in another tab. It keeps
updating for that project. Click **Frozen** to follow the focused terminal again. Transitive dependencies aren't checked. Dependencies that come
from a path or a git URL aren't checked either, and the panel counts them.

## Credits

The rail's label in `label.svg` is drawn from outlines of [Geist](https://github.com/vercel/geist-font),
under the SIL Open Font License 1.1.

## Develop

```sh
npm test
```

`audit.js` holds the logic and imports nothing from Herdr, so the tests run under plain Node. So do
`tree.js` (the plain dependency tree), `cache.js` (finding a language's package cache and reading
only the files it declares), `python.js` (Python's manifests and lockfiles), `cargo.js` (Rust's),
`go.js` (Go's `go.mod` and module cache), `maven.js` (Maven's `pom.xml`), `gradle.js` (Gradle build
files, settings, version catalogs and `gradle.lockfile`), `xml.js`, the XML reader, and `toml.js`,
the TOML reader, whose tests use a vendored copy of the
[toml-test](https://github.com/toml-lang/toml-test) suite in `test/fixtures/toml-test/`.
