// A small XML reader for Maven's pom.xml. Plain data in and out, with no Herdr imports,
// so `npm test` can run it under Node without the app. Nothing is fetched and nothing
// is run.
//
// A POM comes from the project and can be hostile, so the reader is deliberately
// small. It reads elements, text, comments, CDATA and processing instructions (which
// it skips, `<?xml …?>` among them). It refuses any other `<!…>` markup outright, so
// `<!DOCTYPE` and `<!ENTITY` are errors: no DTD is ever fetched, and no entity is ever
// declared or expanded. Only the five predefined entities (`&lt;` `&gt;` `&amp;`
// `&quot;` `&apos;`) and numeric references (`&#60;`, `&#x3C;`) are decoded; any other
// `&name;` is an error. Attributes are read only to step over them, then dropped,
// since a POM keeps everything it means in elements. Namespace prefixes stay in the
// element name.
//
// Like toml.js it is one forward pass over charCodeAt with no regex over the input,
// no `finally`, and a 1 MiB cap (MAX_XML_LENGTH) checked before the pass starts.
// Measured 2026-11-01 under Node 22.17 (best of five): a synthetic 0.98 MB POM of 13,000
// dependencies parses in 4 ms, and maven.js reads it in 6 ms (test/xml.test.js guards
// that this stays linear). That is a Node number. At issue #7's estimate of ~1000× for
// Herdr it is 4-6 s, past Herdr's ~1 s budget, so the cap is a bound against hostile
// input, not a promise that a parse fits. Real POMs are 5-50 KB, 20-200× under the cap.
//
// Result: { root } where an element is { name, children: [element], text }, `text`
// being its own text and CDATA joined and trimmed; or { error: "line N: …", line }.
// Never throws.

export const MAX_XML_LENGTH = 1 << 20; // characters
const MAX_DEPTH = 64; // nested elements

const TAB = 9, LF = 10, CR = 13, SPACE = 32, BANG = 33, QUOTE = 34, HASH = 35, AMP = 38, APOS = 39,
  SLASH = 47, LT = 60, EQUALS = 61, GT = 62, QUESTION = 63, LOWER_X = 120;

const PREDEFINED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

// Not an Error subclass: there is no stack worth capturing, and it is always caught.
class XmlError {
  constructor(pos, message) {
    this.pos = pos;
    this.message = message;
  }
}

const lineAt = (text, pos) => {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === LF) line++;
  return line;
};

const isSpace = (c) => c === SPACE || c === TAB || c === LF || c === CR;
// Anything that can't end a name: XML names allow letters, digits, `-`, `.`, `_`, `:`
// and non-ASCII; this accepts a little more, which costs nothing here.
const isNameChar = (c) => !Number.isNaN(c) && !isSpace(c) && c !== SLASH && c !== GT && c !== LT && c !== EQUALS
  && c !== QUOTE && c !== APOS && c !== AMP && c !== BANG && c !== QUESTION;

export function parseXml(text, options) {
  const maxLength = options?.maxLength ?? MAX_XML_LENGTH;
  if (typeof text !== "string") return { error: "XML input is not a string", line: 0 };
  if (text.length > maxLength) return { error: `XML input is longer than the ${maxLength}-character cap`, line: 0 };
  try {
    return { root: read(text) };
  } catch (e) {
    if (e instanceof XmlError) {
      const line = lineAt(text, e.pos);
      return { error: `line ${line}: ${e.message}`, line };
    }
    return { error: `XML reader failed: ${e?.message ?? e}`, line: 0 };
  }
}

// Decodes the entity references in `raw`, which starts at `start` in the input.
function decode(raw, start) {
  let at = raw.indexOf("&");
  if (at === -1) return raw;
  let out = "", from = 0;
  while (at !== -1) {
    const end = raw.indexOf(";", at);
    if (end === -1 || end - at > 12) throw new XmlError(start + at, "an `&` that doesn't start an entity reference");
    const name = raw.slice(at + 1, end);
    let value;
    if (name.charCodeAt(0) === HASH) {
      const hex = name.charCodeAt(1) === LOWER_X;
      const digits = name.slice(hex ? 2 : 1);
      const code = digits.length && /^[0-9a-fA-F]+$/.test(digits) && (hex || /^[0-9]+$/.test(digits))
        ? parseInt(digits, hex ? 16 : 10) : NaN;
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
        throw new XmlError(start + at, `\`&${name};\` isn't a character`);
      }
      value = String.fromCodePoint(code);
    } else if (Object.hasOwn(PREDEFINED, name)) {
      value = PREDEFINED[name];
    } else {
      throw new XmlError(start + at, `entity \`&${name};\` isn't read; only the five predefined ones and numeric references are`);
    }
    out += raw.slice(from, at) + value;
    from = end + 1;
    at = raw.indexOf("&", from);
  }
  return out + raw.slice(from);
}

function read(text) {
  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let root = null, done = false;
  const stack = []; // { el, parts, at }

  const readName = () => {
    const start = pos;
    while (pos < n && isNameChar(text.charCodeAt(pos))) pos++;
    if (pos === start) throw new XmlError(start, "a tag with no name");
    return text.slice(start, pos);
  };
  const skipSpace = () => { while (pos < n && isSpace(text.charCodeAt(pos))) pos++; };
  const closeAt = (marker, from, what) => {
    const end = text.indexOf(marker, from);
    if (end === -1) throw new XmlError(from, `${what} is never closed`);
    return end;
  };

  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c !== LT) {
      let end = text.indexOf("<", pos);
      if (end === -1) end = n;
      const raw = text.slice(pos, end);
      if (stack.length) {
        stack[stack.length - 1].parts.push(decode(raw, pos));
      } else {
        for (let i = 0; i < raw.length; i++) {
          if (!isSpace(raw.charCodeAt(i))) throw new XmlError(pos + i, done ? "text after the root element" : "text before the root element");
        }
      }
      pos = end;
      continue;
    }
    const next = text.charCodeAt(pos + 1);
    if (next === QUESTION) {
      pos = closeAt("?>", pos + 2, "a `<?` processing instruction") + 2;
      continue;
    }
    if (next === BANG) {
      if (text.startsWith("<!--", pos)) {
        pos = closeAt("-->", pos + 4, "a comment") + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", pos)) {
        if (!stack.length) throw new XmlError(pos, "CDATA outside the root element");
        const end = closeAt("]]>", pos + 9, "a CDATA section");
        stack[stack.length - 1].parts.push(text.slice(pos + 9, end));
        pos = end + 3;
        continue;
      }
      throw new XmlError(pos, "DOCTYPE and entity declarations aren't read");
    }
    if (next === SLASH) {
      pos += 2;
      const name = readName();
      skipSpace();
      if (text.charCodeAt(pos) !== GT) throw new XmlError(pos, `\`</${name}\` has no \`>\``);
      pos++;
      const open = stack.pop();
      if (!open) throw new XmlError(pos, `\`</${name}>\` closes nothing`);
      if (open.el.name !== name) throw new XmlError(pos, `\`</${name}>\` closes \`<${open.el.name}>\` from line ${lineAt(text, open.at)}`);
      open.el.text = open.parts.join("").trim();
      if (!stack.length) done = true;
      continue;
    }
    // An opening or empty tag.
    const at = pos;
    pos++;
    const name = readName();
    if (!stack.length && done) throw new XmlError(at, "a second root element");
    if (stack.length >= MAX_DEPTH) throw new XmlError(at, `elements nested deeper than ${MAX_DEPTH}`);
    let empty = false;
    for (;;) {
      skipSpace();
      if (pos >= n) throw new XmlError(at, `\`<${name}\` is never closed`);
      const d = text.charCodeAt(pos);
      if (d === GT) { pos++; break; }
      if (d === SLASH) {
        if (text.charCodeAt(pos + 1) !== GT) throw new XmlError(pos, `a stray \`/\` in \`<${name}\``);
        pos += 2;
        empty = true;
        break;
      }
      readName();
      skipSpace();
      if (text.charCodeAt(pos) !== EQUALS) throw new XmlError(pos, `an attribute in \`<${name}\` with no value`);
      pos++;
      skipSpace();
      const q = text.charCodeAt(pos);
      if (q !== QUOTE && q !== APOS) throw new XmlError(pos, `an unquoted attribute value in \`<${name}\``);
      const end = closeAt(q === QUOTE ? '"' : "'", pos + 1, "an attribute value");
      const value = text.slice(pos + 1, end);
      if (value.indexOf("<") !== -1) throw new XmlError(pos, "a `<` in an attribute value");
      decode(value, pos + 1); // checked, then dropped
      pos = end + 1;
    }
    const el = { name, children: [], text: "" };
    if (stack.length) stack[stack.length - 1].el.children.push(el);
    else root = el;
    if (empty) {
      if (!stack.length) done = true;
    } else {
      stack.push({ el, parts: [], at });
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    throw new XmlError(open.at, `\`<${open.el.name}>\` is never closed`);
  }
  if (!root) throw new XmlError(n, "no root element");
  return root;
}

// The first child element named `name`, or null.
export const child = (el, name) => el?.children.find((c) => c.name === name) ?? null;
// Every child element named `name`.
export const children = (el, name) => el?.children.filter((c) => c.name === name) ?? [];
// The text of the first child named `name`, or null when there is no such child.
export const textOf = (el, name) => child(el, name)?.text ?? null;
