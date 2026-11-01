// A small TOML reader for pyproject.toml, uv.lock, poetry.lock, Cargo.toml and
// Cargo.lock. Plain data in and out, with no Herdr imports, so `npm test` can
// run it under Node without the app.
//
// Herdr's JS runs about 1000× slower than V8 and interrupts a synchronous step
// after about a second, skipping `finally`. So this is one forward pass over
// charCodeAt with no regex and no `finally`, and input longer than
// MAX_TOML_LENGTH is refused before the pass starts.
//
// The subset is TOML 1.0.0 plus three 1.1.0 additions that lockfile writers may
// emit: inline tables spanning lines (with comments and a trailing comma), and
// the \e and \xHH escapes. Floats, date-times, inf/nan and integers beyond
// 2^53 come back as their raw text. Validation is lenient: this reads
// machine-written files, so redefined tables merge and duplicate keys overwrite.

export const MAX_TOML_LENGTH = 1 << 20; // characters; about six 5,000-line Cargo.locks
const MAX_DEPTH = 64; // nested arrays and inline tables, so deep input can't overflow the stack

const TAB = 9, LF = 10, CR = 13, SPACE = 32, QUOTE = 34, HASH = 35, APOS = 39, PLUS = 43, COMMA = 44,
  DASH = 45, DOT = 46, ZERO = 48, NINE = 57, EQUALS = 61, UPPER_A = 65, UPPER_F = 70, UPPER_U = 85,
  UPPER_Z = 90, LBRACKET = 91, BACKSLASH = 92, RBRACKET = 93, UNDERSCORE = 95, LOWER_A = 97,
  LOWER_B = 98, LOWER_E = 101, LOWER_F = 102, LOWER_N = 110, LOWER_O = 111, LOWER_R = 114,
  LOWER_T = 116, LOWER_U = 117, LOWER_X = 120, LOWER_Z = 122, LBRACE = 123, RBRACE = 125;

// Parses `text` into { value } or reports { error: "line N: …", line: N }. Never throws.
// Tables are null-prototype objects, so a key like `__proto__` is just a key.
export function parseToml(text, { maxLength = MAX_TOML_LENGTH } = {}) {
  if (typeof text !== "string") return { error: "TOML input is not a string", line: 0 };
  if (text.length > maxLength) return { error: `TOML input is longer than the ${maxLength}-character cap`, line: 0 };
  try {
    return { value: new Parser(text).document() };
  } catch (e) {
    if (e instanceof TomlError) {
      const line = lineAt(text, e.pos);
      return { error: `line ${line}: ${e.message}`, line };
    }
    return { error: `TOML reader failed: ${e?.message ?? e}`, line: 0 };
  }
}

// Not an Error subclass: there is no stack worth capturing, and it is always caught above.
class TomlError {
  constructor(pos, message) {
    this.pos = pos;
    this.message = message;
  }
}

const lineAt = (text, pos) => {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < pos; i = text.indexOf("\n", i + 1)) line++;
  return line;
};

const table = () => Object.create(null);
const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isWs = (c) => c === SPACE || c === TAB;
const isDigit = (c) => c >= ZERO && c <= NINE;
// TOML 1.1 allows a set of Unicode letters in bare keys; any non-ASCII character is close enough here.
const isBare = (c) => (c >= LOWER_A && c <= LOWER_Z) || (c >= UPPER_A && c <= UPPER_Z) || isDigit(c)
  || c === UNDERSCORE || c === DASH || c >= 0x80;
// Where a bare value (integer, boolean, float, date-time) ends. NaN is past the end of input.
const isValueEnd = (c) => c !== c || isWs(c) || c === LF || c === CR || c === COMMA || c === RBRACKET
  || c === RBRACE || c === HASH;

const digitValue = (c) => {
  if (isDigit(c)) return c - ZERO;
  if (c >= LOWER_A && c <= LOWER_F) return c - LOWER_A + 10;
  if (c >= UPPER_A && c <= UPPER_F) return c - UPPER_A + 10;
  return 99;
};

// A TOML integer as a Number, or undefined when `raw` isn't one or isn't a safe integer.
function integer(raw) {
  let i = 0, sign = 1, radix = 10;
  const first = raw.charCodeAt(0);
  if (first === PLUS || first === DASH) {
    i = 1;
    if (first === DASH) sign = -1;
  }
  if (raw.charCodeAt(i) === ZERO && i + 1 < raw.length) {
    const p = raw.charCodeAt(i + 1);
    if (p === LOWER_X) radix = 16;
    else if (p === LOWER_O) radix = 8;
    else if (p === LOWER_B) radix = 2;
    else return undefined; // a leading zero: not a TOML integer
    if (i === 1) return undefined; // prefixed integers take no sign
    i += 2;
  }
  let n = 0, prevDigit = false;
  for (; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === UNDERSCORE) {
      if (!prevDigit) return undefined;
      prevDigit = false;
      continue;
    }
    const d = digitValue(c);
    if (d >= radix) return undefined;
    n = n * radix + d;
    if (n > Number.MAX_SAFE_INTEGER) return undefined;
    prevDigit = true;
  }
  if (!prevDigit) return undefined;
  return n === 0 ? 0 : sign * n;
}

class Parser {
  constructor(s) {
    this.s = s;
    this.pos = s.charCodeAt(0) === 0xfeff ? 1 : 0; // a UTF-8 byte-order mark
    this.depth = 0;
  }

  fail(message, pos = this.pos) {
    throw new TomlError(pos, message);
  }

  code(offset = 0) {
    return this.s.charCodeAt(this.pos + offset);
  }

  document() {
    const root = table();
    let current = root;
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.s.length) return root;
      if (this.code() === LBRACKET) current = this.header(root);
      else this.keyval(current);
      this.endLine();
    }
  }

  skipWs() {
    while (isWs(this.code())) this.pos++;
  }

  skipComment() {
    if (this.code() !== HASH) return;
    const end = this.s.indexOf("\n", this.pos);
    this.pos = end === -1 ? this.s.length : end;
    if (this.s.charCodeAt(this.pos - 1) === CR) this.pos--; // leave CRLF for newline()
  }

  newline() {
    const c = this.code();
    if (c === LF) this.pos++;
    else if (c === CR && this.code(1) === LF) this.pos += 2;
    else return false;
    return true;
  }

  // Whitespace, comments and newlines between statements, array items and inline-table entries.
  skipBlank() {
    do {
      this.skipWs();
      this.skipComment();
    } while (this.newline());
  }

  endLine() {
    this.skipWs();
    this.skipComment();
    if (this.pos < this.s.length && !this.newline()) this.fail("unexpected text before the end of the line");
  }

  // [a.b] returns that table; [[a.b]] appends a table to the array a.b and returns it.
  header(root) {
    const start = this.pos;
    const many = this.code(1) === LBRACKET;
    this.pos += many ? 2 : 1;
    this.skipWs();
    const keys = this.key();
    this.skipWs();
    if (this.code() !== RBRACKET || (many && this.code(1) !== RBRACKET)) {
      this.fail(many ? "expected ]] to close the table header" : "expected ] to close the table header");
    }
    this.pos += many ? 2 : 1;
    let t = root;
    const last = many ? keys.length - 1 : keys.length;
    for (let i = 0; i < last; i++) t = this.descend(t, keys[i], start);
    if (!many) return t;
    const name = keys[last], existing = t[name], fresh = table();
    if (existing === undefined) t[name] = [fresh];
    else if (Array.isArray(existing)) existing.push(fresh);
    else this.fail(`key "${name}" is not an array of tables`, start);
    return fresh;
  }

  // The table under t[name], creating it if missing. A header after [[name]] means its last element.
  descend(t, name, pos) {
    const v = t[name];
    if (v === undefined) return (t[name] = table());
    if (isTable(v)) return v;
    if (Array.isArray(v) && isTable(v[v.length - 1])) return v[v.length - 1];
    return this.fail(`key "${name}" is not a table`, pos);
  }

  // A dotted key, as its parts.
  key() {
    const keys = [];
    for (;;) {
      keys.push(this.simpleKey());
      this.skipWs();
      if (this.code() !== DOT) return keys;
      this.pos++;
      this.skipWs();
    }
  }

  simpleKey() {
    const c = this.code();
    if (c === QUOTE) return this.basicString();
    if (c === APOS) return this.literalString();
    const start = this.pos;
    while (isBare(this.code())) this.pos++;
    if (this.pos === start) this.fail("expected a key");
    return this.s.slice(start, this.pos);
  }

  keyval(t) {
    const start = this.pos;
    const keys = this.key();
    this.skipWs();
    if (this.code() !== EQUALS) this.fail("expected = after the key");
    this.pos++;
    this.skipWs();
    const value = this.value();
    for (let i = 0; i < keys.length - 1; i++) t = this.descend(t, keys[i], start);
    t[keys[keys.length - 1]] = value;
  }

  value() {
    const c = this.code();
    if (c === QUOTE) return this.code(1) === QUOTE && this.code(2) === QUOTE ? this.multiBasic() : this.basicString();
    if (c === APOS) return this.code(1) === APOS && this.code(2) === APOS ? this.multiLiteral() : this.literalString();
    if (c === LBRACKET) return this.array();
    if (c === LBRACE) return this.inlineTable();
    return this.bareValue();
  }

  // Integers and booleans are typed; anything else bare (floats, date-times) is returned as text.
  bareValue() {
    const s = this.s, start = this.pos;
    while (!isValueEnd(this.code())) this.pos++;
    // A date-time may separate date and time with a space: 1979-05-27 07:32:00.
    if (this.pos - start === 10 && s.charCodeAt(start + 4) === DASH && s.charCodeAt(start + 7) === DASH
      && this.code() === SPACE && isDigit(this.code(1))) {
      this.pos++;
      while (!isValueEnd(this.code())) this.pos++;
    }
    if (this.pos === start) this.fail("expected a value");
    const raw = s.slice(start, this.pos);
    if (raw === "true") return true;
    if (raw === "false") return false;
    const n = integer(raw);
    return n === undefined ? raw : n;
  }

  enter(pos) {
    if (++this.depth > MAX_DEPTH) this.fail("arrays or inline tables are nested too deeply", pos);
  }

  array() {
    const open = this.pos, out = [];
    this.enter(open);
    this.pos++;
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.s.length) this.fail("unclosed array", open);
      if (this.code() === RBRACKET) break;
      out.push(this.value());
      this.skipBlank();
      const c = this.code();
      if (c === COMMA) this.pos++;
      else if (c === RBRACKET) break;
      else if (this.pos >= this.s.length) this.fail("unclosed array", open);
      else this.fail("expected , or ] in the array");
    }
    this.pos++;
    this.depth--;
    return out;
  }

  // TOML 1.1 form: newlines, comments and a trailing comma are allowed inside the braces.
  inlineTable() {
    const open = this.pos, t = table();
    this.enter(open);
    this.pos++;
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.s.length) this.fail("unclosed inline table", open);
      if (this.code() === RBRACE) break;
      this.keyval(t);
      this.skipBlank();
      const c = this.code();
      if (c === COMMA) this.pos++;
      else if (c === RBRACE) break;
      else if (this.pos >= this.s.length) this.fail("unclosed inline table", open);
      else this.fail("expected , or } in the inline table");
    }
    this.pos++;
    this.depth--;
    return t;
  }

  basicString() {
    const s = this.s, open = this.pos;
    let i = open + 1, from = i, out = "";
    for (;;) {
      const c = s.charCodeAt(i);
      if (c === QUOTE) {
        this.pos = i + 1;
        return out + s.slice(from, i);
      }
      if (c === BACKSLASH) {
        out += s.slice(from, i) + this.escape(i);
        i = from = this.pos;
        continue;
      }
      if (c !== c || c === LF || c === CR) this.fail("unterminated string", open);
      i++;
    }
  }

  literalString() {
    const s = this.s, open = this.pos;
    for (let i = open + 1; ; i++) {
      const c = s.charCodeAt(i);
      if (c === APOS) {
        this.pos = i + 1;
        return s.slice(open + 1, i);
      }
      if (c !== c || c === LF || c === CR) this.fail("unterminated string", open);
    }
  }

  // Index just past the newline that may directly follow an opening """ or '''.
  afterOpening(i) {
    const s = this.s;
    if (s.charCodeAt(i) === LF) return i + 1;
    if (s.charCodeAt(i) === CR && s.charCodeAt(i + 1) === LF) return i + 2;
    return i;
  }

  // At i, three closing quotes plus up to two more that belong to the content ("""a""""" is a"").
  closeMulti(i, quote) {
    const s = this.s;
    let end = i + 3;
    if (s.charCodeAt(end) === quote) end++;
    if (s.charCodeAt(end) === quote) end++;
    this.pos = end;
    return end - 3;
  }

  multiBasic() {
    const s = this.s, open = this.pos;
    let i = this.afterOpening(open + 3), from = i, out = "";
    for (;;) {
      const c = s.charCodeAt(i);
      if (c !== c) this.fail("unterminated multi-line string", open);
      if (c === QUOTE && s.charCodeAt(i + 1) === QUOTE && s.charCodeAt(i + 2) === QUOTE) {
        return out + s.slice(from, this.closeMulti(i, QUOTE));
      }
      if (c === BACKSLASH) {
        out += s.slice(from, i);
        let j = i + 1;
        while (isWs(s.charCodeAt(j))) j++;
        const next = s.charCodeAt(j);
        if (next === LF || (next === CR && s.charCodeAt(j + 1) === LF)) {
          // A line-ending backslash trims the newline and all whitespace after it.
          for (let w = s.charCodeAt(j); isWs(w) || w === LF || w === CR; w = s.charCodeAt(++j));
          i = from = j;
          continue;
        }
        out += this.escape(i);
        i = from = this.pos;
        continue;
      }
      i++;
    }
  }

  multiLiteral() {
    const s = this.s, open = this.pos;
    const from = this.afterOpening(open + 3);
    for (let i = from; ; i++) {
      const c = s.charCodeAt(i);
      if (c !== c) this.fail("unterminated multi-line string", open);
      if (c === APOS && s.charCodeAt(i + 1) === APOS && s.charCodeAt(i + 2) === APOS) {
        return s.slice(from, this.closeMulti(i, APOS));
      }
    }
  }

  // The escape whose backslash is at i; leaves pos just past it.
  escape(i) {
    const c = this.s.charCodeAt(i + 1);
    this.pos = i + 2;
    switch (c) {
      case LOWER_B: return "\b";
      case LOWER_T: return "\t";
      case LOWER_N: return "\n";
      case LOWER_F: return "\f";
      case LOWER_R: return "\r";
      case LOWER_E: return "\x1b";
      case QUOTE: return "\"";
      case BACKSLASH: return "\\";
      case LOWER_X: return this.hexEscape(i, 2);
      case LOWER_U: return this.hexEscape(i, 4);
      case UPPER_U: return this.hexEscape(i, 8);
    }
    return this.fail(`invalid escape \\${this.s.slice(i + 1, i + 2)}`, i);
  }

  hexEscape(i, digits) {
    let cp = 0;
    for (let k = 0; k < digits; k++) {
      const d = digitValue(this.s.charCodeAt(i + 2 + k));
      if (d > 15) this.fail(`invalid escape \\${this.s.slice(i + 1, i + 2)}: expected ${digits} hex digits`, i);
      cp = cp * 16 + d;
    }
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail("escape is not a Unicode scalar value", i);
    this.pos = i + 2 + digits;
    return String.fromCodePoint(cp);
  }
}
