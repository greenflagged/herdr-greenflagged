// Gradle's build.gradle.kts and build.gradle for the plain dependency tree. Plain data
// in and out, with no Herdr imports, so `npm test` can run it under Node without the
// app. Nothing here throws, whatever the input, and nothing is run: no `gradle`, no
// `~/.gradle/caches`, no network. A build script is a program, so it is never
// evaluated: it is cut into tokens in one pass and the tokens are matched against a
// few common shapes. A crafted build file can only change which rows are shown.
//
// Files read, all static names on the ECOSYSTEMS entry (audit.js): the build file, and
// from the build root `settings.gradle.kts` or `settings.gradle`,
// `gradle/libs.versions.toml` (the version catalog, read with toml.js) and the root's own
// `build.gradle.kts` or `build.gradle`; then `gradle.lockfile` beside the build file, as
// the lockfile. At the root, also each included module's `build.gradle.kts` or
// `build.gradle` (GRADLE_MODULES, below).
//
// Performance: the tokenizer is one forward pass over charCodeAt with no regex over the
// input and a 1 MiB cap (MAX_GRADLE_LENGTH); the matcher reads each token once, keeps
// the enclosing block names as a stack, and nests calls at most 16 deep before
// skipping. Measured 2026-11-01 under Node 22.17 (best of five): a synthetic 0.98 MB
// build file of 16,000 `implementation("g:a:v") { exclude(…) }` lines inside a KMP
// source set parses in 17 ms (test/gradle.test.js guards that this stays linear). That
// is a Node number. At issue #7's estimate of ~1000× for Herdr it is ~17 s, so the cap
// is a bound against hostile input, not a promise that a parse fits Herdr's ~1 s budget.
// Real build files are 1-5 KB, 200-1000× under the cap.
//
// Gradle edge cases, so RECIPE.md can point here instead of growing:
// - The build root is the nearest folder, from the build file's own upward, holding
//   `settings.gradle.kts` or `settings.gradle`, as Gradle itself looks for it. The walk
//   never reads home or `/`, so a stray `~/settings.gradle.kts` is ignored; an
//   unrelated settings file in a folder between the project and home is taken as the
//   root, as Gradle would. With no settings file, the build file's folder is the root.
//   The catalog is read from `<root>/gradle/libs.versions.toml` only, so an included
//   build that imports another folder's catalog shows its `libs.*` rows as written.
// - Name: `rootProject.name` from settings when the build file is the root's, else the
//   build file's folder name (Gradle's own default).
// - Only `dependencies { }` blocks are read, at any depth except inside `buildscript`;
//   blocks named `if`, `else`, `for`, `while`, `forEach`, `let`, `run`, `also`, `with`
//   and `try` are see-through. `constraints { }` and `dependencyManagement { }` give no
//   rows; they pin versions (below).
// - Inside `subprojects { }` or `allprojects { }` a row is tagged `every module` (after a
//   `BOM` tag when it has one). A module's build file also takes those rows from the root
//   build file, after its own, so a `g:a` the module declares keeps the module's row. An
//   unreadable root build file adds nothing. `configure(subprojects…) { }` isn't read.
// - Version pins: a coordinate with a version given to a configuration inside
//   `constraints { }` or `dependencyManagement { }`, or to Spring's `dependency(…)`
//   inside any `dependencies { }` (as `the<DependencyManagementExtension>().apply { }`
//   writes it), fills in a `managed` row of the same `g:a`. A file's own pins come first,
//   then the root's pins inside `subprojects { }` / `allprojects { }`. A BOM
//   (`mavenBom(…)`, `platform(…)`) is never opened, so the versions it manages stay
//   `managed`.
// - Configurations: `implementation`, `api`, `compileOnly`, `runtimeOnly`, `kapt`, `ksp`,
//   `annotationProcessor`, and the same names with a lower-case prefix
//   (`testImplementation`, `debugApi`, `jvmMainImplementation`) or an upper-case suffix
//   (`kaptTest`, `kspAndroid`). Anything else (`classpath`, `detekt`, a quoted
//   `"customConf"(…)`) is not read.
// - `dev`: a configuration starting `test` or `androidTest` before a capital, or holding
//   `Test` before a capital or at its end; or a block named `test` or ending `Test` around
//   the `dependencies { }` (a KMP `commonTest`, `jvmTest`, `androidUnitTest`).
// - KMP source sets: `commonMain.dependencies { }`, `commonMain { dependencies { } }`,
//   `val commonTest by getting { dependencies { } }`, `named("jvmTest") { … }`,
//   `getByName("x")`, `create("x")`, `sourceSets["x"].dependencies { }`.
// - Coordinates, after the configuration, in parentheses or (Groovy) without:
//   - `"g:a:v"` or `'g:a:v'`; `"g:a"` is `managed`. A classifier or `@ext` is dropped.
//     Several in one Groovy call are several rows.
//   - The map form `group: 'g', name: 'a', version: 'v'` and Kotlin's
//     `group = "g", name = "a", version = "v"`; no version is `managed`.
//   - `kotlin("x")` is `org.jetbrains.kotlin:kotlin-x`, `managed` unless a second
//     argument or `version =` gives the version.
//   - `libs.a.b` from the catalog's `[libraries]` (alias `-` and `_` read as `.`);
//     `libs.bundles.x` is one row per library in the bundle.
//   - `platform(…)` and `enforcedPlatform(…)` around any of these are tagged `BOM` and
//     `enforced BOM`.
//   - `project(":x")`, `projects.x`, `files(…)` and `fileTree(…)` are counted on the
//     "not checked" line.
//   - Anything that names a value instead (`libs.x` with no catalog entry, no catalog,
//     `Deps.coroutines`, `deps.okhttp`) is a row named as written, with no version. With
//     a gradle.lockfile, the lock's own `g:a` for it is a second row under "resolved":
//     linking the two would mean running the script.
//   - A version built from a variable (`"g:a:$v"`, `"g:a:${v}"`, `version = v`) is
//     shown as written, never resolved; so is a coordinate whose group or name is one.
//   - Any other argument (a call such as `npm(…)`, string concatenation, an expression)
//     is left out without saying so.
//   - A closure after a coordinate (`{ exclude(…) }`, `{ version { strictly(…) } }`) adds
//     nothing.
// - A duplicate `g:a` keeps its first row.
// - The root's build file lists the `include(…)` projects from settings as rows tagged
//   `subproject`, after its own rows (one per string, `include(":a", ":b")` or Groovy
//   `include ':a', ':b'`; `includeBuild` is not read). findManifest then opens up to
//   MAX_GRADLE_MODULES of them: `:a:b` is read from `<root>/a/b/build.gradle.kts` (or
//   `.gradle`), and the row becomes a heading over that module's rows, `dev` moved into
//   the tag, plus its `project(…)` links as `subproject` leaves. A heading isn't counted as
//   a direct; what's under it counts toward the total. A module whose folder isn't plain
//   (see gradleModuleFolder), whose build file is missing or unreadable, or past the cap
//   stays a plain row, counted as a direct. A `projectDir` set in settings isn't read, and
//   a module's own gradle.lockfile isn't either.
// - Kotlin: the language is "Kotlin" when `plugins { }` holds `kotlin("…")`, an `id`
//   starting `org.jetbrains.kotlin.` (or `kotlin`, `kotlin-android`, `kotlin-kapt`), or
//   `alias(libs.plugins.x)` whose catalog id starts `org.jetbrains.kotlin.`; or when
//   `apply plugin:` (or `apply(plugin = …)`) names one. `apply false` still counts, so a
//   mixed build's root reads "Kotlin".
// - Groovy slashy strings (`/…/`) aren't read as strings; one holding a quote can make
//   the file unreadable, and the panel then says so.
// - gradle.lockfile: `group:artifact:version=configurations` lines; `#` comments, blank
//   lines and the `empty=` line are skipped, anything else is refused with its line
//   number. A declared `g:a` takes the locked version and keeps its own `dev` and tag;
//   locked at two versions it is two rows. Locked entries the build file doesn't
//   declare go under one collapsed "resolved" row, like Go's "indirect". The legacy
//   `gradle/dependency-locks/` folder is not read.

import { mergeDirect } from "./tree.js";
import { parseToml } from "./toml.js";

export const MAX_GRADLE_LENGTH = 1 << 20; // characters
const MAX_NESTING = 16; // calls inside calls before the rest is skipped
export const GRADLE_RESOLVED_GROUP = "resolved";
export const EVERY_MODULE = "every module"; // the tag on a `subprojects { }` or `allprojects { }` row

export const GRADLE_COMPANIONS = {
  root: ["settings.gradle.kts", "settings.gradle"],
  files: ["gradle/libs.versions.toml", "build.gradle.kts", "build.gradle"],
};

export const GRADLE_NOTE = "Versions as declared. The resolved tree needs `gradle dependencies`, which this panel doesn't run.";

const TAB = 9, LF = 10, CR = 13, SPACE = 32, QUOTE = 34, DOLLAR = 36, APOS = 39, STAR = 42, SLASH = 47,
  ZERO = 48, NINE = 57, UPPER_A = 65, UPPER_Z = 90, BACKSLASH = 92, UNDERSCORE = 95,
  BACKTICK = 96, LOWER_A = 97, LOWER_Z = 122, LBRACE = 123, RBRACE = 125;

// --- tokens ------------------------------------------------------------------------

// A token is { t, v, nl, s, e }: t is "id", "str", "num" or "p" (one punctuation
// character); v its text (a string's contents, unquoted, escapes kept as written); nl
// whether a line break comes before it; s and e its source offsets. A string also has
// `interp` when it holds a `$`.
class GradleError {
  constructor(pos, message) {
    this.pos = pos;
    this.message = message;
  }
}

const isIdentStart = (c) => (c >= LOWER_A && c <= LOWER_Z) || (c >= UPPER_A && c <= UPPER_Z) || c === UNDERSCORE || c === DOLLAR || c > 127;
const isIdentChar = (c) => isIdentStart(c) || (c >= ZERO && c <= NINE);

function tokenize(text) {
  const n = text.length, tokens = [];
  let pos = 0, nl = false;
  const push = (t, v, s, extra) => {
    tokens.push({ t, v, nl, s, e: pos, ...extra });
    nl = false;
  };
  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c === LF) { nl = true; pos++; continue; }
    if (c === SPACE || c === TAB || c === CR || c === 0xfeff) { pos++; continue; }
    if (c === SLASH && text.charCodeAt(pos + 1) === SLASH) {
      const end = text.indexOf("\n", pos);
      pos = end === -1 ? n : end;
      continue;
    }
    if (c === SLASH && text.charCodeAt(pos + 1) === STAR) {
      const end = text.indexOf("*/", pos + 2);
      if (end === -1) { pos = n; continue; }
      for (let i = pos; i < end; i++) if (text.charCodeAt(i) === LF) { nl = true; break; }
      pos = end + 2;
      continue;
    }
    const s = pos;
    if (isIdentStart(c)) {
      while (pos < n && isIdentChar(text.charCodeAt(pos))) pos++;
      push("id", text.slice(s, pos), s);
      continue;
    }
    if (c === BACKTICK) {
      const end = text.indexOf("`", pos + 1);
      const line = text.indexOf("\n", pos + 1);
      if (end === -1 || (line !== -1 && line < end)) throw new GradleError(s, "a backtick name is never closed");
      pos = end + 1;
      push("id", text.slice(s + 1, end), s);
      continue;
    }
    if (c >= ZERO && c <= NINE) {
      while (pos < n && (isIdentChar(text.charCodeAt(pos)) || text.charCodeAt(pos) === 46)) pos++;
      push("num", text.slice(s, pos), s);
      continue;
    }
    if (c === QUOTE || c === APOS) {
      if (text.charCodeAt(pos + 1) === c && text.charCodeAt(pos + 2) === c) {
        const fence = c === QUOTE ? '"""' : "'''";
        const end = text.indexOf(fence, pos + 3);
        if (end === -1) throw new GradleError(s, `a ${fence} string is never closed`);
        const v = text.slice(pos + 3, end);
        pos = end + 3;
        push("str", v, s, { interp: c === QUOTE && v.indexOf("$") !== -1 });
        continue;
      }
      pos++;
      let braces = 0, interp = false;
      for (;;) {
        if (pos >= n) throw new GradleError(s, "a string is never closed");
        const d = text.charCodeAt(pos);
        if (d === BACKSLASH) { pos += 2; continue; }
        if (braces > 0) {
          if (d === LBRACE) braces++;
          else if (d === RBRACE) braces--;
          pos++;
          continue;
        }
        if (d === LF) throw new GradleError(s, "a string is never closed");
        if (d === c) break;
        if (d === DOLLAR && c === QUOTE) {
          interp = true;
          if (text.charCodeAt(pos + 1) === LBRACE) { braces = 1; pos += 2; continue; }
        }
        pos++;
      }
      const v = text.slice(s + 1, pos);
      pos++;
      push("str", v, s, { interp });
      continue;
    }
    pos++;
    push("p", text[s], s);
  }
  return tokens;
}

const lineAt = (text, pos) => {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === LF) line++;
  return line;
};

function tokensOf(text, file) {
  if (typeof text !== "string") return { error: `${file} is not text` };
  if (text.length > MAX_GRADLE_LENGTH) return { error: `${file} is longer than the ${MAX_GRADLE_LENGTH}-character cap` };
  try {
    return { tokens: tokenize(text) };
  } catch (e) {
    if (e instanceof GradleError) return { error: `${file} line ${lineAt(text, e.pos)}: ${e.message}` };
    return { error: `${file} could not be read: ${e?.message ?? e}` };
  }
}

// --- expressions -------------------------------------------------------------------

// A small reader over the token list. `p` only moves forward, so every token is read
// once. Expression nodes:
//   { k: "str", v, interp }  { k: "path", parts, text }  { k: "call", fn, args, text }
//   { k: "named", key, value }  { k: "other", text }
class Reader {
  constructor(tokens, text) {
    this.tokens = tokens;
    this.text = text;
    this.p = 0;
  }

  peek(o = 0) { return this.tokens[this.p + o]; }
  is(o, t, v) {
    const tok = this.tokens[this.p + o];
    return Boolean(tok) && tok.t === t && (v === undefined || tok.v === v);
  }
  source(from, to) { return from < to ? this.text.slice(this.tokens[from].s, this.tokens[to - 1].e) : ""; }

  // Skips to the next `,` or unmatched closer at depth 0 (and, when `bare`, to a token
  // starting a new line, `;` or a `{`), without reading what it passes.
  skip(bare) {
    let depth = 0;
    for (;;) {
      const tok = this.peek();
      if (!tok) return;
      if (tok.t === "p") {
        if (depth === 0) {
          if (tok.v === "," || tok.v === ")" || tok.v === "]" || tok.v === "}") return;
          if (bare && (tok.v === ";" || tok.v === "{")) return;
        }
        if (tok.v === "(" || tok.v === "[" || tok.v === "{") depth++;
        else if (tok.v === ")" || tok.v === "]" || tok.v === "}") depth--;
      }
      if (bare && depth === 0 && tok.nl && this.p > 0) return;
      this.p++;
    }
  }

  // `a.b["c"].d` → ["a", "b", "c", "d"], from an identifier.
  path() {
    const parts = [this.peek().v];
    this.p++;
    for (;;) {
      if (this.is(0, "p", ".") && this.is(1, "id")) { parts.push(this.peek(1).v); this.p += 2; continue; }
      if (this.is(0, "p", "[") && this.is(1, "str") && this.is(2, "p", "]")) { parts.push(this.peek(1).v); this.p += 3; continue; }
      return parts;
    }
  }

  // `( … )` → [node], reading from the `(`.
  args(depth) {
    this.p++; // (
    const list = [];
    if (depth > MAX_NESTING) { this.skipTo(")"); return list; }
    for (;;) {
      const tok = this.peek();
      if (!tok) return list;
      if (tok.t === "p" && tok.v === ")") { this.p++; return list; }
      if (tok.t === "p" && tok.v === ",") { this.p++; continue; }
      list.push(this.arg(depth, false));
      const after = this.peek();
      if (after && !(after.t === "p" && (after.v === "," || after.v === ")"))) {
        list[list.length - 1] = { k: "other", text: "" };
        this.skip(false);
        // A stray closer of another kind would stop `skip` without moving.
        if (this.peek()?.t === "p" && (this.peek().v === "]" || this.peek().v === "}")) { this.p++; return list; }
      }
    }
  }

  // Groovy's `conf a, b` with no parentheses: arguments to the end of the line.
  bareArgs() {
    const list = [];
    for (;;) {
      list.push(this.arg(1, true));
      const after = this.peek();
      if (after && after.t === "p" && after.v === ",") { this.p++; continue; }
      if (after && !(after.nl || (after.t === "p" && (after.v === ";" || after.v === "}" || after.v === "{")))) {
        // A word after the argument is an infix call (`id 'x' version '1'`), which leaves
        // the argument as it is; an operator (`'a' + v`) makes it something else.
        if (after.t !== "id") list[list.length - 1] = { k: "other", text: "" };
        this.skip(true);
      }
      return list;
    }
  }

  skipTo(closer) {
    let depth = 0;
    while (this.peek()) {
      const tok = this.peek();
      this.p++;
      if (tok.t !== "p") continue;
      if (tok.v === "(" || tok.v === "[" || tok.v === "{") depth++;
      else if (tok.v === ")" || tok.v === "]" || tok.v === "}") {
        if (depth === 0 && tok.v === closer) return;
        depth--;
      }
    }
  }

  // One argument: a named one (`key: value`, `key = value`) or an expression.
  arg(depth, bare) {
    if (this.is(0, "id") && (this.is(1, "p", ":") || (!bare && this.is(1, "p", "=")))) {
      const key = this.peek().v;
      this.p += 2;
      return { k: "named", key, value: this.expr(depth, bare) };
    }
    return this.expr(depth, bare);
  }

  expr(depth, bare) {
    const from = this.p, tok = this.peek();
    // A closer belongs to whoever opened it.
    if (!tok || (tok.t === "p" && (tok.v === ")" || tok.v === "]" || tok.v === "}"))) return { k: "other", text: "" };
    let node;
    if (tok.t === "str") {
      this.p++;
      node = { k: "str", v: tok.v, interp: Boolean(tok.interp) };
    } else if (tok.t === "id") {
      const parts = this.path();
      if (this.is(0, "p", "(") && !(bare && this.peek().nl)) {
        node = { k: "call", fn: parts.join("."), args: this.args(depth + 1) };
        // `.get()` and the like after a call make it something else.
        if (this.is(0, "p", ".")) node = { k: "other" };
      } else {
        node = { k: "path", parts };
      }
    } else if (tok.t === "p" && (tok.v === "(" || tok.v === "[" || tok.v === "{")) {
      this.p++;
      this.skipTo(tok.v === "(" ? ")" : tok.v === "[" ? "]" : "}");
      node = { k: "other" };
    } else {
      this.p++;
      node = { k: "other" };
    }
    node.text = this.source(from, this.p);
    return node;
  }
}

// --- the walk ----------------------------------------------------------------------

const SEE_THROUGH = new Set(["if", "else", "for", "while", "forEach", "let", "run", "also", "with", "try"]);
const LABEL_CALLS = new Set(["named", "getByName", "create", "register", "maybeCreate", "getting", "creating"]);
const CONFIGURATIONS = ["implementation", "api", "compileOnly", "runtimeOnly", "kapt", "ksp", "annotationProcessor"];
const CAPITALIZED = CONFIGURATIONS.map((c) => c[0].toUpperCase() + c.slice(1));
const isUpper = (c) => c >= UPPER_A && c <= UPPER_Z;
const isLower = (c) => c >= LOWER_A && c <= LOWER_Z;

export function isConfiguration(name) {
  for (let i = 0; i < CONFIGURATIONS.length; i++) {
    const base = CONFIGURATIONS[i], cap = CAPITALIZED[i];
    if (name === base) return true;
    if (name.length > base.length && name.endsWith(cap) && isLower(name.charCodeAt(0))) return true;
    if (name.length > base.length && name.startsWith(base) && isUpper(name.charCodeAt(base.length))) return true;
  }
  return false;
}

const DEV_CONFIGURATION = /^(test|androidTest)[A-Z]|Test[A-Z]|Test$/; // one identifier at a time
const isTestLabel = (label) => label === "test" || label.endsWith("Test");
const SHARED_BLOCKS = new Set(["subprojects", "allprojects"]);
const PINNING_BLOCKS = new Set(["dependencyManagement", "constraints"]);

// Walks the tokens once with a stack of block names, and reports what the matchers
// need: dependency statements, plugin evidence, settings lines.
function walk(tokens, text) {
  const r = new Reader(tokens, text);
  // One frame per open `{`. Each frame carries what the matcher asks about it, worked
  // out once on push, so no question scans the stack: `block` is the nearest enclosing
  // labels that aren't see-through, `buildscript` and `test` whether any enclosing block
  // is one, `shared` whether one is `subprojects` or `allprojects`, and `pinning` whether
  // one is `dependencyManagement` or `constraints`.
  const stack = [];
  const push = (labels) => {
    const parent = stack.at(-1);
    const seeThrough = labels.length === 1 && SEE_THROUGH.has(labels[0]);
    stack.push({
      block: seeThrough ? parent?.block ?? null : labels,
      buildscript: Boolean(parent?.buildscript) || labels.includes("buildscript"),
      test: Boolean(parent?.test) || labels.some((l) => l !== "dependencies" && isTestLabel(l)),
      shared: Boolean(parent?.shared) || labels.some((l) => SHARED_BLOCKS.has(l)),
      pinning: Boolean(parent?.pinning) || labels.some((l) => PINNING_BLOCKS.has(l)),
    });
  };
  const statements = [], pins = [], plugins = [], includes = [];
  let rootName = null;

  const block = () => stack.at(-1)?.block?.at(-1);
  const inDependencies = () => block() === "dependencies" && !stack.at(-1).buildscript && !stack.at(-1).pinning;
  const inPinning = () => Boolean(stack.at(-1)?.pinning) && !stack.at(-1).buildscript;
  const inTest = () => Boolean(stack.at(-1)?.test);
  const inShared = () => Boolean(stack.at(-1)?.shared);
  const bareFollows = () => {
    const tok = r.peek();
    return Boolean(tok) && !tok.nl && (tok.t === "str" || tok.t === "id" || tok.t === "num");
  };

  while (r.p < tokens.length) {
    const tok = r.peek();
    if (tok.t === "p") {
      r.p++;
      if (tok.v === "{") push([]);
      else if (tok.v === "}") stack.pop();
      continue;
    }
    if (tok.t !== "id") { r.p++; continue; }

    // `val commonTest by getting {`
    if ((tok.v === "val" || tok.v === "var") && r.is(1, "id") && r.is(2, "id", "by")) {
      const name = r.peek(1).v;
      r.p += 3;
      if (r.is(0, "id")) {
        r.path();
        if (r.is(0, "p", "(")) r.args(1);
      }
      if (r.is(0, "p", "{")) { r.p++; push([name]); }
      continue;
    }

    // A chain: `a.b(…).c["d"](…)`, with the block names a `{` after it would give.
    // Only a chain of one name, called or not, can be a statement this reads.
    const labels = [];
    let call = null, simple = true;
    for (;;) {
      const parts = r.path();
      if (parts.length > 1 || call) simple = false;
      labels.push(...parts);
      if (r.is(0, "p", "(") && !r.peek().nl) {
        const args = r.args(1);
        call = { fn: parts.join("."), args };
        const first = args[0];
        if (LABEL_CALLS.has(parts.at(-1)) && first?.k === "str") labels[labels.length - 1] = first.v;
      }
      if (r.is(0, "p", ".") && r.is(1, "id")) { r.p++; simple = false; continue; }
      break;
    }
    const name = labels.join(".");

    if (simple) {
      const fn = labels[0];
      const wants = inDependencies() || inPinning() || fn === "id" || fn === "apply" || fn === "include";
      const args = call ? call.args : wants && bareFollows() ? r.bareArgs() : null;
      if (args) {
        if (inDependencies() && isConfiguration(fn)) {
          statements.push({ conf: fn, args, dev: DEV_CONFIGURATION.test(fn) || inTest(), shared: inShared() });
        } else if ((inPinning() && isConfiguration(fn)) || (fn === "dependency" && (inPinning() || inDependencies()))) {
          pins.push({ args, shared: inShared() });
        } else if (block() === "plugins") {
          if (fn === "kotlin" || fn === "id" || fn === "alias") plugins.push({ fn, args });
        } else if (fn === "apply") {
          plugins.push({ fn, args });
        } else if (fn === "include" && stack.length === 0) {
          for (const a of args) if (a.k === "str" && !a.interp) includes.push(a.v);
        }
      }
    }
    if (name === "rootProject.name" && stack.length === 0 && r.is(0, "p", "=") && r.is(1, "str")) {
      rootName ??= r.peek(1).v;
      r.p += 2;
    }
    if (r.is(0, "p", "{")) { r.p++; push(labels); }
  }
  return { statements, pins, plugins, includes, rootName };
}

// --- the catalog -------------------------------------------------------------------

const alias = (text) => text.replace(/[-_]/g, "."); // one alias at a time

const richVersion = (v) => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    for (const key of ["strictly", "require", "prefer"]) if (typeof v[key] === "string") return v[key];
  }
  return null;
};

// gradle/libs.versions.toml → { libraries: Map, bundles: Map, plugins: Map }, or null when
// the text is missing or isn't TOML. Aliases are keyed with `-` and `_` read as `.`.
// A library is { name: "g:a", constraint } with `managed` for no version.
export function readVersionCatalog(text) {
  if (typeof text !== "string") return null;
  const parsed = parseToml(text);
  if (parsed.error || !parsed.value) return null;
  const doc = parsed.value;
  const table = (key) => (doc[key] && typeof doc[key] === "object" && !Array.isArray(doc[key]) ? doc[key] : {});
  const versions = table("versions");
  const versionOf = (spec) => {
    if (spec === undefined) return null;
    if (typeof spec === "string") return spec;
    if (spec && typeof spec === "object" && typeof spec.ref === "string") return richVersion(versions[spec.ref]);
    return richVersion(spec);
  };
  const libraries = new Map(), bundles = new Map(), plugins = new Map();
  for (const [key, spec] of Object.entries(table("libraries"))) {
    let name = null, version = null;
    if (typeof spec === "string") {
      const parts = spec.split(":");
      if (parts.length >= 2) { name = `${parts[0]}:${parts[1]}`; version = parts[2] || null; }
    } else if (spec && typeof spec === "object") {
      if (typeof spec.module === "string") name = spec.module;
      else if (typeof spec.group === "string" && typeof spec.name === "string") name = `${spec.group}:${spec.name}`;
      version = versionOf(spec.version);
    }
    if (name) libraries.set(alias(key), { name, constraint: version ?? "managed" });
  }
  for (const [key, list] of Object.entries(table("bundles"))) {
    if (Array.isArray(list)) bundles.set(alias(key), list.filter((x) => typeof x === "string").map(alias));
  }
  for (const [key, spec] of Object.entries(table("plugins"))) {
    const id = typeof spec === "string" ? spec.split(":")[0] : typeof spec?.id === "string" ? spec.id : null;
    if (id) plugins.set(alias(key), id);
  }
  return { libraries, bundles, plugins };
}

// --- settings ----------------------------------------------------------------------

// settings.gradle(.kts) → { name, includes } or null when it is missing or unreadable.
export function readSettings(text) {
  if (typeof text !== "string") return null;
  const read = tokensOf(text, "settings");
  if (read.error) return null;
  const { includes, rootName } = walk(read.tokens, text);
  return { name: rootName, includes: [...new Set(includes)] };
}

// --- the build file ----------------------------------------------------------------

const KOTLIN_IDS = new Set(["kotlin", "kotlin-android", "kotlin-kapt"]);
const isKotlinId = (id) => typeof id === "string" && (id.startsWith("org.jetbrains.kotlin.") || KOTLIN_IDS.has(id));

function appliesKotlin(plugins, catalog) {
  for (const { fn, args } of plugins) {
    const first = args[0];
    if (fn === "kotlin") return true;
    if (fn === "id" && first?.k === "str" && isKotlinId(first.v)) return true;
    if (fn === "alias" && first?.k === "path" && first.parts[0] === "libs" && first.parts[1] === "plugins"
      && isKotlinId(catalog?.plugins.get(alias(first.parts.slice(2).join("."))))) return true;
    if (fn === "apply") {
      for (const a of args) if (a.k === "named" && a.key === "plugin" && a.value.k === "str" && isKotlinId(a.value.v)) return true;
    }
  }
  return false;
}

const textOfValue = (node) => (node?.k === "str" ? node.v : node?.text || null);

// One coordinate string → { name, constraint } or null when it isn't `g:a[:v]`.
function coordinate(node) {
  const parts = node.v.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  if (node.interp && (parts[0].indexOf("$") !== -1 || parts[1].indexOf("$") !== -1)) return { name: node.v, constraint: null };
  let version = parts[2] || "managed";
  const at = version.indexOf("@");
  if (at > 0) version = version.slice(0, at);
  return { name: `${parts[0]}:${parts[1]}`, constraint: version };
}

// A statement's arguments → rows and skipped names.
function readStatement({ args, dev }, catalog, add, skip) {
  const named = new Map();
  const one = (node, marker) => {
    if (node.k === "str") {
      const c = coordinate(node);
      if (c) add({ ...c, dev, ...(marker ? { marker } : {}) });
      return;
    }
    if (node.k === "call") {
      const first = node.args[0];
      if ((node.fn === "platform" || node.fn === "enforcedPlatform") && first && !marker) {
        one(first, node.fn === "platform" ? "BOM" : "enforced BOM");
      } else if (node.fn === "project" || node.fn === "files" || node.fn === "fileTree") {
        skip(first?.k === "str" ? first.v : node.text);
      } else if (node.fn === "kotlin" && first?.k === "str") {
        const version = node.args.find((a, i) => i > 0 && a.k !== "named") ?? node.args.find((a) => a.k === "named" && a.key === "version")?.value;
        add({ name: `org.jetbrains.kotlin:kotlin-${first.v}`, constraint: textOfValue(version) ?? "managed", dev, ...(marker ? { marker } : {}) });
      }
      return;
    }
    if (node.k === "path") {
      const [head, second] = node.parts;
      if (head === "projects" && node.parts.length > 1) { skip(node.text); return; }
      if (head === "libs" && catalog) {
        if (second === "bundles") {
          const bundle = catalog.bundles.get(alias(node.parts.slice(2).join(".")));
          if (bundle) {
            for (const key of bundle) {
              const lib = catalog.libraries.get(key);
              if (lib) add({ ...lib, dev, ...(marker ? { marker } : {}) });
            }
            return;
          }
        } else {
          const lib = catalog.libraries.get(alias(node.parts.slice(1).join(".")));
          if (lib) { add({ ...lib, dev, ...(marker ? { marker } : {}) }); return; }
        }
      }
      add({ name: node.text, constraint: null, dev, ...(marker ? { marker } : {}) });
    }
  };
  for (const node of args) {
    if (node.k === "named") { if (!named.has(node.key)) named.set(node.key, node.value); } else one(node, null);
  }
  const name = named.get("name");
  if (name) {
    const group = named.get("group");
    const g = group ? textOfValue(group) : null, a = textOfValue(name);
    if (a) add({ name: g ? `${g}:${a}` : a, constraint: textOfValue(named.get("version")) ?? "managed", dev });
  }
}

const lastSegment = (folder) => {
  const trimmed = folder.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || null;
};

// build.gradle(.kts) → { name, deps, skipped, language? } or { error }. `context` is what
// findManifest hands over: { files, root, folder }, `files` holding the companions'
// texts (null when missing). It may be left out.
export function parseGradle(text, context, file = "build.gradle") {
  const read = tokensOf(text, file);
  if (read.error) return { error: read.error };
  const files = context?.files ?? {};
  const root = context?.root ?? null, folder = context?.folder ?? null;
  const catalog = readVersionCatalog(files["gradle/libs.versions.toml"]);
  const settings = readSettings(files["settings.gradle.kts"] ?? files["settings.gradle"] ?? null);
  const { statements, pins, plugins } = walk(read.tokens, text);
  const isRoot = folder !== null && root === folder;

  // A module also takes what the root build file declares for every module.
  let inherited = { statements: [], pins: [] };
  if (!isRoot && root !== null) {
    const rootText = files["build.gradle.kts"] ?? files["build.gradle"] ?? null;
    const rootRead = typeof rootText === "string" ? tokensOf(rootText, "root build file") : null;
    if (rootRead && !rootRead.error) {
      const r = walk(rootRead.tokens, rootText);
      inherited = { statements: r.statements.filter((s) => s.shared), pins: r.pins.filter((p) => p.shared) };
    }
  }

  const deps = new Map(), skipped = [];
  const add = (dep) => { if (!deps.has(dep.name)) deps.set(dep.name, dep); };
  const addShared = (dep) => add({ ...dep, marker: dep.marker ? `${dep.marker} · ${EVERY_MODULE}` : EVERY_MODULE });
  const skip = (name) => { if (!skipped.includes(name)) skipped.push(name); };
  for (const statement of [...statements, ...inherited.statements]) {
    readStatement(statement, catalog, statement.shared ? addShared : add, skip);
  }

  // `managed` rows take a version pinned in the same build: this file's own pins, then
  // the root's for every module.
  const pinned = new Map();
  for (const pin of [...pins, ...inherited.pins]) {
    readStatement({ args: pin.args, dev: false }, catalog, (dep) => {
      if (dep.constraint && dep.constraint !== "managed" && !pinned.has(dep.name)) pinned.set(dep.name, dep.constraint);
    }, () => {});
  }
  let rows = [...deps.values()].map((dep) => (dep.constraint === "managed" && pinned.has(dep.name) ? { ...dep, constraint: pinned.get(dep.name) } : dep));
  if (isRoot && settings?.includes.length) {
    const own = new Set(rows.map((d) => d.name));
    for (const name of settings.includes) if (!own.has(name)) rows.push({ name, constraint: null, dev: false, marker: "subproject" });
  }
  const name = folder === null ? null : (isRoot && settings?.name) || lastSegment(folder);
  const result = { name, deps: rows, skipped };
  if (appliesKotlin(plugins, catalog)) result.language = "Kotlin";
  return result;
}

export const parseGradleKts = (text, context) => parseGradle(text, context, "build.gradle.kts");
export const parseGradleGroovy = (text, context) => parseGradle(text, context, "build.gradle");

// --- the lockfile ------------------------------------------------------------------

const LOCK_LINE = /^([^:=\s]+):([^:=\s]+):([^:=\s]+)=([\w,-]*)$/; // one line at a time

// gradle.lockfile → [{ name, version }] or { error }.
export function readGradleLock(text) {
  if (typeof text !== "string") return { error: "gradle.lockfile is not text" };
  const entries = [], seen = new Set();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith("empty=")) continue;
    const m = LOCK_LINE.exec(line);
    if (!m) return { error: `gradle.lockfile line ${i + 1}: expected group:artifact:version=configurations` };
    const key = `${m[1]}:${m[2]}@${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name: `${m[1]}:${m[2]}`, version: m[3] });
  }
  return { entries };
}

// gradle.lockfile → { resolve, direct }. A declared `g:a` takes the locked version and
// keeps the build file's `dev` and tag; the rest go under one "resolved" group row.
export function gradleLockResolver(text, project) {
  const read = readGradleLock(text);
  if (read.error) return { error: read.error };
  const declared = new Map();
  for (const dep of project?.deps ?? []) if (!declared.has(dep.name)) declared.set(dep.name, dep);
  const rows = [], children = [];
  for (const { name, version } of read.entries) {
    const dep = declared.get(name);
    if (dep) rows.push({ name, version, dev: dep.dev, marker: dep.marker });
    else children.push({ name, version });
  }
  const direct = mergeDirect(project?.deps ?? [], rows);
  if (children.length) direct.push({ name: GRADLE_RESOLVED_GROUP, version: null, constraint: null, dev: false, group: true });
  const resolve = (edge) => (edge.group === true && edge.name === GRADLE_RESOLVED_GROUP ? { version: null, children } : null);
  return { resolve, direct };
}

export const GRADLE_LOCKFILES = [{ file: "gradle.lockfile", resolver: gradleLockResolver }];

// --- modules -----------------------------------------------------------------------

export const MAX_GRADLE_MODULES = 100; // modules opened at the root; the rest stay plain rows

// A settings include (`:a:b`, `app`) → its folder under the build root (`a/b`), or null
// when a segment is anything but letters, digits, `.`, `_` and `-`, or is `.` or `..`.
// Gradle's default project folder; a `projectDir` set in settings isn't read.
export function gradleModuleFolder(include) {
  if (typeof include !== "string") return null;
  const segments = include.replace(/^:/, "").split(":");
  for (const s of segments) if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") return null;
  return segments.join("/");
}

// What findManifest needs to open a root's modules (see ECOSYSTEMS in audit.js).
// `list` names the subproject rows to open and their folders; `parse` turns one module's
// build file into the edges under its heading row, or null when it has none.
export const GRADLE_MODULES = {
  files: ["build.gradle.kts", "build.gradle"],
  list(project) {
    const modules = [];
    for (const dep of project.deps ?? []) {
      if (dep.marker !== "subproject" || modules.length >= MAX_GRADLE_MODULES) continue;
      const folder = gradleModuleFolder(dep.name);
      if (folder) modules.push({ name: dep.name, folder });
    }
    return modules;
  },
  parse(text, file, context) {
    const result = parseGradle(text, context, file);
    if (result.error) return null;
    const edges = result.deps.map(({ name, constraint, dev, marker }) => {
      const tag = [marker, dev ? "dev" : null].filter(Boolean).join(" · ");
      return { name, constraint, ...(tag ? { marker: tag } : {}) };
    });
    // Links to other modules, as `project(":x")` or `projects.x`, show as leaves.
    for (const name of result.skipped) if (name.startsWith(":") || name.startsWith("projects.")) edges.push({ name, marker: "subproject" });
    return edges;
  },
};
