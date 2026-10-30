# Greenflagged for Herdr

A [Herdr](https://herdr.dev) panel that follows the terminal you're working in, finds its
`package.json`, and shows each direct dependency's [Greenflagged](https://greenflagged.dev) status.
The problems come first, and the greenflagged packages fold away behind a count.

npm only for now. Python follows once Greenflagged's PyPI audit is live.

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
  It sends nothing else from your project.
- **Requests:** hovering a `not imported` package shows a Request button. Clicking it asks Greenflagged
  to import and review that package, under your token. Nothing is requested unless you click.
- **Files:** it reads `package.json` from your terminal's folder and the folders above it, and
  `~/.npmrc`. It writes nothing to your project. Requests are remembered in Herdr's `shared.json`.
- **Programs:** it runs `printenv` to read your token, `xdg-open` or `open` when you click a row, and
  `npm login` when you click Sign in.

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

`audit.js` holds the logic and imports nothing from Herdr, so the tests run under plain Node.
