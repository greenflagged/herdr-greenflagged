import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_XML_LENGTH, child, children, parseXml, textOf } from "../mods/greenflagged/xml.js";

const root = (text) => {
  const result = parseXml(text);
  assert.equal(result.error, undefined, result.error);
  return result.root;
};

test("reads nested elements and their text", () => {
  const doc = root("<a>\n  <b>one</b>\n  <c><d> two </d></c>\n  <b>three</b>\n</a>");
  assert.equal(doc.name, "a");
  assert.equal(textOf(doc, "b"), "one");
  assert.equal(textOf(child(doc, "c"), "d"), "two");
  assert.deepEqual(children(doc, "b").map((b) => b.text), ["one", "three"]);
  assert.equal(child(doc, "nope"), null);
  assert.equal(textOf(doc, "nope"), null);
  assert.deepEqual(children(null, "b"), []);
});

test("steps over attributes in both quote styles, `>` inside one included", () => {
  const doc = root(`<project xmlns="http://x" a='1 > 0' b = "it's"><v k="&amp;">1</v><e x="y"/></project>`);
  assert.equal(textOf(doc, "v"), "1");
  assert.deepEqual(doc.children.map((c) => c.name), ["v", "e"]);
  assert.equal(child(doc, "e").text, "");
});

test("skips comments, the XML declaration and processing instructions", () => {
  const doc = root('﻿<?xml version="1.0"?>\n<!-- top -->\n<a><!-- <b>not</b> --><?pi x?><b>yes</b></a>\n<!-- end -->\n');
  assert.deepEqual(doc.children.map((c) => c.text), ["yes"]);
});

test("keeps CDATA verbatim as text", () => {
  assert.equal(root("<a><![CDATA[1 < 2 && &nope;]]></a>").text, "1 < 2 && &nope;");
  assert.equal(root("<a>x<![CDATA[y]]>z</a>").text, "xyz");
});

test("decodes the predefined and numeric entities", () => {
  assert.equal(root("<a>&lt;&gt;&amp;&quot;&apos; &#65;&#x42;&#x1F600;</a>").text, `<>&"' AB\u{1F600}`);
});

test("refuses a DOCTYPE, naming its line", () => {
  const result = parseXml('<?xml version="1.0"?>\n<!DOCTYPE project [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>\n<project>&xxe;</project>');
  assert.equal(result.line, 2);
  assert.equal(result.error, "line 2: DOCTYPE and entity declarations aren't read");
});

test("refuses an entity it would have to expand, and an entity declaration", () => {
  assert.match(parseXml("<a>&xxe;</a>").error, /^line 1: entity `&xxe;` isn't read/);
  assert.match(parseXml('<a x="&ext;"/>').error, /entity `&ext;` isn't read/);
  assert.match(parseXml("<a>\n<!ENTITY x 'y'>\n</a>").error, /^line 2: DOCTYPE and entity declarations aren't read/);
  assert.match(parseXml("<a>& b</a>").error, /an `&` that doesn't start an entity reference/);
  assert.match(parseXml("<a>&#0;</a>").error, /isn't a character/);
  assert.match(parseXml("<a>&#xD800;</a>").error, /isn't a character/);
});

test("refuses unclosed, mismatched and doubled roots", () => {
  assert.match(parseXml("<a><b></a>").error, /^line 1: `<\/a>` closes `<b>` from line 1/);
  assert.match(parseXml("<a>\n<b>").error, /^line 2: `<b>` is never closed/);
  assert.match(parseXml("</a>").error, /closes nothing/);
  assert.match(parseXml("<a/><b/>").error, /a second root element/);
  assert.match(parseXml("<a></a>text").error, /text after the root element/);
  assert.match(parseXml("text<a/>").error, /text before the root element/);
  assert.match(parseXml("").error, /no root element/);
  assert.match(parseXml("<!-- only a comment -->").error, /no root element/);
  assert.match(parseXml("<a><!-- open").error, /a comment is never closed/);
  assert.match(parseXml("<a x=1/>").error, /an unquoted attribute value/);
  assert.match(parseXml("<a x/>").error, /with no value/);
  assert.match(parseXml("<>").error, /a tag with no name/);
});

test("refuses elements nested deeper than 64", () => {
  const ok = "<a>".repeat(64) + "</a>".repeat(64);
  assert.equal(parseXml(ok).error, undefined);
  const deep = "<a>".repeat(65) + "</a>".repeat(65);
  assert.match(parseXml(deep).error, /nested deeper than 64/);
});

test("refuses input over the cap, and input that isn't a string, without throwing", () => {
  assert.equal(MAX_XML_LENGTH, 1048576);
  assert.deepEqual(parseXml("<a/>", { maxLength: 3 }), { error: "XML input is longer than the 3-character cap", line: 0 });
  assert.equal(parseXml(" ".repeat(MAX_XML_LENGTH + 1)).line, 0);
  for (const input of [null, undefined, 42, {}, ["<a/>"]]) {
    assert.deepEqual(parseXml(input), { error: "XML input is not a string", line: 0 });
  }
});

test("hostile input never throws", () => {
  for (const input of ["<", "<a", "<a ", "<a b", "<a b=", '<a b="', "<a/", "<![CDATA[", "<a><![CDATA[x", "<?", "&", "<a>&amp", "\u0000<a/>", "<a></b", "<a>" + "<".repeat(1000)]) {
    const result = parseXml(input);
    assert.ok(result.error || result.root, JSON.stringify(input));
  }
});

// A linearity guard, not a Herdr budget: see xml.js's header.
test("parses a 13,000-dependency POM near the cap in under 100 ms", () => {
  const deps = [];
  for (let i = 0; i < 13000; i++) deps.push(`<dependency><groupId>g${i}</groupId><artifactId>a</artifactId></dependency>`);
  const text = `<project><dependencies>${deps.join("")}</dependencies></project>`;
  assert.ok(text.length > 900_000 && text.length <= MAX_XML_LENGTH);
  const first = parseXml(text);
  assert.equal(first.error, undefined, first.error);
  assert.equal(child(first.root, "dependencies").children.length, 13000);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    parseXml(text);
    best = Math.min(best, performance.now() - start);
  }
  assert.ok(best < 100, `best of three took ${best.toFixed(1)} ms`);
});
