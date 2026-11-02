import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_TOML_LENGTH, parseToml } from "../mods/greenflagged/toml.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (...parts) => readFileSync(join(fixtures, ...parts), "utf8");
const sample = (name) => {
  const result = parseToml(read("samples", name));
  assert.equal(result.error, undefined, result.error);
  return result.value;
};

// --- toml-test conformance (valid cases only) ---------------------------------
//
// test/fixtures/toml-test/ is an unmodified copy of toml-lang/toml-test v2.2.0
// (see SOURCE.md). We run every valid case in its TOML 1.1.0 list. Cases whose
// expected values stay inside the reader's subset (strings, integers and
// booleans) must match exactly.
//
// Checked only in part (the structure must match, but the values below need only
// come back as strings, since the reader returns them as raw text):
// - whole directories, below;
// - any case whose expected JSON holds a float, date-time, local date, local
//   time or local date-time anywhere ("mixed");
// - the named cases in SKIPPED_CASES.
const SKIPPED_DIRS = {
  "valid/datetime/": "date-times come back as raw strings",
  "valid/float/": "floats come back as raw strings",
};
const SKIPPED_CASES = {
  "valid/integer/long.toml": "int64 extremes are beyond 2^53; they come back as raw strings",
};
const SUBSET = new Set(["string", "integer", "bool"]);
const CASE_COUNT = 214; // valid/*.toml lines in files-toml-1.1.0

const isLeaf = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === 2 && typeof v.type === "string" && typeof v.value === "string";
const leafTypes = (v, out = new Set()) => {
  if (isLeaf(v)) out.add(v.type);
  else if (v !== null && typeof v === "object") for (const child of Object.values(v)) leafTypes(child, out);
  return out;
};
// Out-of-subset leaves of `expected`, swapped for the parsed leaf when that came back as a string
// (or, for an integer beyond 2^53, as its exact text), so deepEqual checks everything else.
const loosen = (expected, actual) => {
  if (isLeaf(expected)) {
    const raw = isLeaf(actual) && actual.type === "string";
    if (raw && !SUBSET.has(expected.type)) return actual;
    if (raw && expected.type === "integer" && actual.value === expected.value) return actual;
    return expected;
  }
  if (Array.isArray(expected)) return expected.map((v, i) => loosen(v, actual?.[i]));
  if (expected === null || typeof expected !== "object") return expected;
  return Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, loosen(v, actual?.[k])]));
};
// The parsed value in toml-test's tagged-JSON shape.
const tag = (v) => {
  if (typeof v === "string") return { type: "string", value: v };
  if (typeof v === "number") return { type: "integer", value: String(v) };
  if (typeof v === "boolean") return { type: "bool", value: String(v) };
  if (Array.isArray(v)) return v.map(tag);
  return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, tag(child)]));
};

const cases = read("toml-test", "files-toml-1.1.0").split("\n")
  .filter((line) => line.startsWith("valid/") && line.endsWith(".toml"));
let exact = 0, partial = 0;
for (const path of cases) {
  const expected = JSON.parse(read("toml-test", path.slice(0, -".toml".length) + ".json"));
  const dir = Object.keys(SKIPPED_DIRS).find((prefix) => path.startsWith(prefix));
  const outside = [...leafTypes(expected)].filter((type) => !SUBSET.has(type));
  const skip = dir ? SKIPPED_DIRS[dir]
    : SKIPPED_CASES[path] ?? (outside.length ? `mixed: contains ${outside.join(", ")}` : false);
  if (skip) partial++;
  else exact++;
  test(`toml-test ${path}${skip ? ` (in part: ${skip})` : ""}`, () => {
    const result = parseToml(read("toml-test", path));
    assert.equal(result.error, undefined, result.error);
    const actual = tag(result.value);
    assert.deepEqual(actual, skip ? loosen(expected, actual) : expected);
  });
}

test("toml-test lists 214 valid cases and most are checked exactly", () => {
  assert.equal(cases.length, CASE_COUNT);
  assert.ok(exact >= 170, `only ${exact} toml-test cases were checked exactly`);
});

// --- real-world samples, trimmed -----------------------------------------------

test("reads a uv.lock", () => {
  const lock = sample("uv.lock");
  assert.equal(lock.version, 1);
  assert.deepEqual(lock["resolution-markers"], ["python_full_version >= '3.13'", "python_full_version < '3.13'"]);
  assert.equal(lock.options["exclude-newer"], "2025-06-01T00:00:00Z");
  assert.equal(lock.manifest.constraints[0].hashes.length, 3);
  assert.deepEqual(lock.package.map((p) => p.name), ["anyio", "demo", "idna"]);
  assert.equal(lock.package[0].source.registry, "https://pypi.org/simple");
  assert.equal(lock.package[0].dependencies[1].marker, "python_full_version < '3.13'");
  assert.equal(lock.package[0].sdist.size, 190949);
  assert.equal(lock.package[0].wheels[0].size, 100916);
  assert.equal(lock.package[1].metadata["requires-dist"][0].specifier, ">=4.0");
});

test("reads a poetry.lock and attaches [package.dependencies] to the last package", () => {
  const lock = sample("poetry.lock");
  assert.equal(lock.package.length, 2);
  assert.equal(lock.package[0].optional, false);
  assert.deepEqual(lock.package[0].groups, ["main"]);
  assert.equal(lock.package[0].files[1].file, "certifi-2025.4.26.tar.gz");
  assert.equal(lock.package[0].dependencies, undefined);
  assert.equal(lock.package[1].dependencies["pydantic-core"], "2.33.2");
  assert.equal(lock.package[1].dependencies["typing-extensions"].markers, "python_version < \"3.13\"");
  assert.deepEqual(lock.package[1].extras.email, ["email-validator (>=2.0.0)"]);
  assert.equal(lock.metadata["lock-version"], "2.1");
});

test("reads a Cargo.lock", () => {
  const lock = sample("Cargo.lock");
  assert.equal(lock.version, 4);
  assert.equal(lock.package.length, 5);
  assert.deepEqual(lock.package[0].dependencies, ["serde", "tokio"]);
  assert.equal(lock.package[1].source, "registry+https://github.com/rust-lang/crates.io-index");
  assert.equal(lock.package[2].checksum, "72b64191b275b66ffe2469e8af2c1cfe3bafa67b529ead792a6d0160888b4237");
  assert.deepEqual(lock.package[4].dependencies, ["pin-project-lite", "syn 2.0.101"]);
});

test("reads a Cargo.toml with quoted table keys", () => {
  const manifest = sample("Cargo.toml");
  assert.equal(manifest.package.edition, "2021");
  assert.equal(manifest.package.description, "A demo crate for the TOML reader's tests.\n");
  assert.deepEqual(manifest.dependencies.serde.features, ["derive"]);
  assert.equal(manifest.dependencies.tokio.optional, true);
  assert.equal(manifest["dev-dependencies"].proptest, "1.6");
  assert.equal(manifest.target["cfg(unix)"].dependencies.libc, "0.2");
  assert.equal(manifest.target["cfg(windows)"].dependencies["windows-sys"].version, "0.59");
  assert.equal(manifest.profile.release["opt-level"], 3);
  assert.equal(manifest.profile.release.lto, true);
  assert.deepEqual(manifest.workspace.members, ["crates/core", "crates/cli"]);
});

test("reads a pyproject.toml and returns a float as its raw text", () => {
  const project = sample("pyproject.toml");
  assert.equal(project["build-system"]["build-backend"], "hatchling.build");
  assert.deepEqual(project.project.dependencies, ["httpx>=0.27", "pydantic>=2,<3"]);
  assert.equal(project.project.license.text, "MIT");
  assert.deepEqual(project.project["optional-dependencies"].cli, ["rich>=13"]);
  assert.equal(project.project.scripts.demo, "demo.cli:main");
  assert.deepEqual(project.tool.ruff.lint.select, ["E", "F", "I"]);
  assert.equal(project.tool.ruff["line-length"], 100);
  assert.equal(project.tool.coverage.report.fail_under, "90.5");
  assert.deepEqual(project["dependency-groups"].dev, ["pytest>=8", "ruff"]);
  assert.equal(project.tool.poetry.source[0].priority, "supplemental");
});

// --- out-of-subset values and safety ---------------------------------------------

test("returns floats, date-times and big integers as raw strings", () => {
  const { value } = parseToml([
    "f = 6.626e-34", "inf = -inf", "dt = 1979-05-27 07:32:00Z", "d = 1979-05-27", "big = 9007199254740993",
    "list = [1.5, 2024-01-01T00:00:00, 3]",
  ].join("\n"));
  assert.equal(value.f, "6.626e-34");
  assert.equal(value.inf, "-inf");
  assert.equal(value.dt, "1979-05-27 07:32:00Z");
  assert.equal(value.d, "1979-05-27");
  assert.equal(value.big, "9007199254740993");
  assert.deepEqual(value.list, ["1.5", "2024-01-01T00:00:00", 3]);
});

test("a __proto__ key stays an ordinary key", () => {
  const { value } = parseToml("[__proto__]\npolluted = true\n");
  assert.equal(value.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
});

test("deeply nested arrays are an error, not a stack overflow", () => {
  const result = parseToml(`a = ${"[".repeat(10000)}`);
  assert.match(result.error, /^line 1: .*nested too deeply/);
});

// --- malformed input -------------------------------------------------------------

const MALFORMED = [
  ["a missing =", "name", /expected = after the key/],
  ["an unterminated basic string", "name = \"demo", /unterminated string/],
  ["an unterminated literal string", "name = 'demo", /unterminated string/],
  ["an unterminated multi-line string", "name = \"\"\"demo\nmore", /unterminated multi-line string/],
  ["an unclosed array at the end of input", "deps = [\n  \"a\",\n  \"b\",", /unclosed array/],
  ["an unclosed inline table", "dep = { version = \"1\"", /unclosed inline table/],
  ["an unclosed table header", "[unclosed", /expected \] to close the table header/],
  ["an unclosed array-of-tables header", "[[package]", /expected \]\] to close/],
  ["a key with no value", "name = ", /expected a value/],
  ["a bad escape", "name = \"\\q\"", /invalid escape \\q/],
  ["a short unicode escape", "name = \"\\u12\"", /expected 4 hex digits/],
  ["text after a value", "name = \"demo\" junk", /unexpected text before the end of the line/],
  ["text after a header", "[package] name = \"x\"", /unexpected text before the end of the line/],
  ["a stray comma in an array", "deps = [\"a\",, \"b\"]", /expected a value/],
  ["a table header over a value", "dep = 1\n[dep]", /key "dep" is not a table/],
  ["a dotted key through a value", "dep = 1\ndep.version = \"1\"", /key "dep" is not a table/],
  ["an array-of-tables header over a table", "[dep]\n[[dep]]", /key "dep" is not an array of tables/],
  ["a duplicate key", "name = \"a\"\nname = \"b\"", /duplicate key "name"/],
  ["a duplicate key in an inline table", "dep = { v = 1, v = 2 }", /duplicate key "v"/],
  ["a dotted key over a value", "dep.v = 1\ndep.v = 2", /duplicate key "v"/],
  ["a table defined twice", "[dep]\na = 1\n[dep]", /table "dep" is defined more than once/],
  ["a subtable defined twice", "[a.b]\n[a]\n[a.b]", /table "a.b" is defined more than once/],
  ["a header over a dotted-key table", "[a]\nb.c = 1\n[a.b]", /table "a.b" is defined more than once/],
  ["a header over an implicit table a dotted key extended", "[a.b.c]\n[a]\nb.d = 1\n[a.b]",
    /table "a.b" is defined more than once/],
  ["a header over an inline table", "dep = { v = 1 }\n[dep]", /table "dep" is defined more than once/],
  ["a header into an inline table", "dep = { v = 1 }\n[dep.x]", /"dep" is an inline table/],
  ["a dotted key into an inline table", "dep = { v = 1 }\ndep.x = 2", /"dep" is an inline table/],
  ["a dotted key into a header table", "[a.b]\nz = 1\n[a]\nb.y = 2", /table "b" is already defined by a header/],
  ["a table header over an array of tables", "[[dep]]\n[dep]", /key "dep" is not a table/],
  ["an array-of-tables header over a static array", "dep = []\n[[dep]]", /key "dep" is not an array of tables/],
  ["a header into a static array of tables", "dep = [{ v = 1 }]\n[dep.x]", /key "dep" is not a table/],
  ["a misspelt boolean", "flag = tru", /invalid value tru/],
  ["a bare word", "name = demo", /invalid value demo/],
  ["text glued to a value", "n = 1[2", /unexpected text before the end of the line/],
  ["an integer with a leading zero", "n = 007", /invalid integer 007/],
  ["an integer with a doubled underscore", "n = 1__2", /invalid integer 1__2/],
  ["a signed hex integer", "n = +0x1", /invalid integer \+0x1/],
  ["a bad hex digit", "n = 0xaafz", /invalid integer 0xaafz/],
  // Digit-led junk: neither an integer, a float nor a date-time.
  ["digits then letters", "n = 12abc", /invalid value 12abc/],
  ["a digit then a symbol", "n = 0@", /invalid value 0@/],
  ["a trailing minus", "n = 1-", /invalid value 1-/],
  ["a minus between digits", "n = 1-2", /invalid value 1-2/],
  ["a float with no fraction digits", "n = 1.", /invalid value 1\./],
  ["a float with no leading digit", "n = .5", /invalid value \.5/],
  ["a float with no exponent digits", "n = 1e", /invalid value 1e/],
  ["a float with a leading zero", "n = 01.5", /invalid value 01\.5/],
  ["a float with an underscore before the dot", "n = 1_.5", /invalid value 1_\.5/],
  ["a date with nothing after the T", "d = 1979-05-27T", /invalid value 1979-05-27T/],
  ["a signed date", "d = +1979-05-27", /invalid value \+1979-05-27/],
  ["an offset with no colon", "d = 1979-05-27T07:32:00+0700", /invalid value 1979-05-27T07:32:00\+0700/],
  ["inf with text after it", "n = infx", /invalid value infx/],
];

for (const [what, bad, message] of MALFORMED) {
  test(`reports ${what} with its line number`, () => {
    // Two good lines first, so the reported line has to be counted, not assumed.
    const lead = "# lockfile\nversion = 1\n";
    const badLine = 3 + bad.split("\n").length - 1; // the last line of `bad`
    const result = parseToml(lead + bad);
    assert.equal(result.value, undefined);
    assert.match(result.error, message);
    // Errors that close something report the line it opened on.
    const expectedLine = /unclosed array|unterminated multi-line/.test(String(message)) ? 3 : badLine;
    assert.equal(result.line, expectedLine);
    assert.ok(result.error.startsWith(`line ${expectedLine}: `), result.error);
  });
}

test("never throws on any prefix of a real lockfile", () => {
  const text = read("samples", "uv.lock");
  for (let i = 0; i <= text.length; i++) {
    const result = parseToml(text.slice(0, i));
    assert.equal(typeof result, "object");
    assert.equal(("value" in result) + ("error" in result), 1, `prefix of length ${i}`);
  }
});

test("never throws on input that is not a string, or on null options", () => {
  assert.deepEqual(parseToml(undefined), { error: "TOML input is not a string", line: 0 });
  assert.deepEqual(parseToml("a = 1", null).value, { __proto__: null, a: 1 });
});

test("floats, inf/nan and date-times of every valid shape come back as their text", () => {
  const shapes = ["1.5", "-0.0", "+1e10", "6.626e-34", "5E+22", "0e0", "1_000.000_1", "inf", "+inf", "-nan",
    "1979-05-27", "07:32:00", "07:32", "07:32:00.999", "1979-05-27T07:32:00Z", "1979-05-27t07:32z",
    "1979-05-27T07:32", "1979-05-27T00:32:00.999999-07:00", "1979-05-27 07:32:00"];
  for (const raw of shapes) {
    const { value, error } = parseToml(`v = ${raw}`);
    assert.equal(error, undefined, `${raw}: ${error}`);
    assert.equal(value.v, raw);
  }
});

test("dotted keys and headers may still add to tables that are not yet defined", () => {
  const { value, error } = parseToml([
    "[fruit]", "apple.color = \"red\"", "apple.taste.sweet = true", "[fruit.apple.texture]", "smooth = true",
    "[x.y.z]", "[x]", "w = 1", "[[p]]", "[p.q]", "r = 1", "[[p]]", "[p.q]", "r = 2",
  ].join("\n"));
  assert.equal(error, undefined, error);
  assert.equal(value.fruit.apple.taste.sweet, true);
  assert.equal(value.fruit.apple.texture.smooth, true);
  assert.equal(value.x.w, 1);
  assert.deepEqual(value.p.map((e) => e.q.r), [1, 2]);
});

// --- input cap and speed -----------------------------------------------------------

test("refuses input over the cap before reading it", () => {
  assert.equal(MAX_TOML_LENGTH, 1048576);
  const over = parseToml("a".repeat(MAX_TOML_LENGTH + 1));
  assert.equal(over.line, 0);
  assert.match(over.error, /1048576-character cap/);
  assert.deepEqual(parseToml("a = 1", { maxLength: 3 }), { error: "TOML input is longer than the 3-character cap", line: 0 });
  assert.deepEqual(parseToml("a = 1", { maxLength: 5 }).value, { __proto__: null, a: 1 });
});

test("parses a 5,000-line Cargo.lock in under 50 ms", () => {
  const blocks = ["# This file is automatically @generated by Cargo.", "version = 4", ""];
  for (let i = 0; blocks.length < 5000; i++) {
    blocks.push(
      "[[package]]",
      `name = "crate-${i}"`,
      `version = "1.${i}.0"`,
      "source = \"registry+https://github.com/rust-lang/crates.io-index\"",
      `checksum = "${(i * 2654435761 % 4294967296).toString(16).padStart(8, "0").repeat(8)}"`,
      `dependencies = [ "crate-${i + 1}", "serde 1.0.219", ]`,
      "",
    );
  }
  const text = blocks.join("\n");
  assert.ok(text.split("\n").length >= 5000);
  const first = parseToml(text);
  assert.equal(first.error, undefined, first.error);
  assert.ok(first.value.package.length > 700);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    parseToml(text);
    best = Math.min(best, performance.now() - start);
  }
  assert.ok(best < 50, `best of three took ${best.toFixed(1)} ms`);
});
