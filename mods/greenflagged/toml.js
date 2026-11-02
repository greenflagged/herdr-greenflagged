// A small TOML reader for pyproject.toml, uv.lock, poetry.lock, Cargo.toml and
// Cargo.lock. Plain data in and out, with no Herdr imports, so `npm test` can
// run it under Node without the app.
//
// Issue #7 reports that Herdr's JS runs about 1000× slower than V8 and
// interrupts a synchronous step after about a second, skipping `finally`; those
// figures come from the issue, not from a measurement here. So this is one
// forward pass over charCodeAt with no regex and no `finally`, and input longer
// than MAX_TOML_LENGTH is refused before the pass starts. The cap bounds the
// worst case; it does not keep a parse inside that budget. If the 1000× figure
// holds, input well under the cap could already take longer than a second there.
//
// The subset is TOML 1.0.0 plus four 1.1.0 additions that lockfile writers may
// emit: inline tables spanning lines (with comments and a trailing comma), the
// \e and \xHH escapes, and times that leave out their seconds.
// Floats, date-times, inf/nan and integers beyond 2^53 come back as their raw
// text. A bare value that is not a boolean or an integer must have a float's,
// inf/nan's or date-time's shape, or it is an error (12abc, 1-2, 1.); only the
// shape is checked, not ranges, so 1979-13-45 comes back as text. A duplicate
// key, a table defined twice (including an implicit table that a dotted key has
// since extended), or a header or dotted key reaching into an inline table or a
// static array is an error.

export const MAX_TOML_LENGTH = 1 << 20; // characters; about six 5,000-line Cargo.locks
const MAX_DEPTH = 64; // nested arrays and inline tables, so deep input can't overflow the stack

const TAB = 9, LF = 10, CR = 13, SPACE = 32, QUOTE = 34, HASH = 35, APOS = 39, PLUS = 43, COMMA = 44,
  DASH = 45, DOT = 46, ZERO = 48, NINE = 57, EQUALS = 61, UPPER_A = 65, UPPER_F = 70, UPPER_U = 85,
  UPPER_Z = 90, LBRACKET = 91, BACKSLASH = 92, RBRACKET = 93, UNDERSCORE = 95, LOWER_A = 97,
  LOWER_B = 98, LOWER_E = 101, LOWER_F = 102, LOWER_N = 110, LOWER_O = 111, LOWER_R = 114,
  LOWER_T = 116, LOWER_U = 117, LOWER_X = 120, LOWER_Z = 122, LBRACE = 123, RBRACE = 125, COLON = 58,
  UPPER_T = 84;

// Parses `text` into { value } or reports { error: "line N: …", line: N }. Never throws.
// Tables are null-prototype objects, so a key like `__proto__` is just a key.
export function parseToml(text, options) {
  const maxLength = options?.maxLength ?? MAX_TOML_LENGTH;
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
// Whether raw has the shape of a TOML float, inf/nan, or date-time. One left-to-right scan, no
// regex. It checks characters and their order (digits, separators, underscores between digits),
// not ranges: 1979-13-45 has a date's shape and passes.
function isFloatOrDateTime(raw) {
  const c = raw.charCodeAt(0);
  if (c === PLUS || c === DASH) return isFloatBody(raw, 1);
  return isFloatBody(raw, 0) || isDateTime(raw);
}

// [+-]inf, [+-]nan, or int-part then .digits and/or e[+-]digits, from index i.
function isFloatBody(raw, i) {
  const rest = i === 0 ? raw : raw.slice(i);
  if (rest === "inf" || rest === "nan") return true;
  if (raw.charCodeAt(i) === ZERO) i++; // a zero int part, which must stand alone
  else if (isDigit(raw.charCodeAt(i))) i = digitRun(raw, i);
  else return false;
  let fracOrExp = false;
  if (raw.charCodeAt(i) === DOT) {
    if (!isDigit(raw.charCodeAt(i + 1))) return false;
    i = digitRun(raw, i + 1);
    fracOrExp = true;
  }
  if ((raw.charCodeAt(i) | 0x20) === LOWER_E) {
    i++;
    if (raw.charCodeAt(i) === PLUS || raw.charCodeAt(i) === DASH) i++;
    if (!isDigit(raw.charCodeAt(i))) return false;
    i = digitRun(raw, i);
    fracOrExp = true;
  }
  return fracOrExp && i === raw.length;
}

// From a digit at i, past digits with single underscores between them. Returns where the run
// stops, or -1 when an underscore is not followed by a digit (so the caller's end check fails).
function digitRun(raw, i) {
  for (i++; ; i++) {
    const c = raw.charCodeAt(i);
    if (c === UNDERSCORE) {
      if (!isDigit(raw.charCodeAt(i + 1))) return -1;
    } else if (!isDigit(c)) return i;
  }
}

// n digits at i.
function digitsAt(raw, i, n) {
  for (let k = 0; k < n; k++) if (!isDigit(raw.charCodeAt(i + k))) return false;
  return true;
}

// A local date (dddd-dd-dd), a local time, or a date, T/t/space, time and optional Z or ±hh:mm.
function isDateTime(raw) {
  if (digitsAt(raw, 0, 2) && raw.charCodeAt(2) === COLON) return timeEnd(raw, 0) === raw.length;
  if (!(digitsAt(raw, 0, 4) && raw.charCodeAt(4) === DASH && digitsAt(raw, 5, 2) && raw.charCodeAt(7) === DASH
    && digitsAt(raw, 8, 2))) return false;
  if (raw.length === 10) return true;
  const sep = raw.charCodeAt(10);
  if (sep !== UPPER_T && sep !== LOWER_T && sep !== SPACE) return false;
  let i = timeEnd(raw, 11);
  if (i === -1) return false;
  const z = raw.charCodeAt(i);
  if (z === UPPER_Z || z === LOWER_Z) i++;
  else if (z === PLUS || z === DASH) {
    if (!(digitsAt(raw, i + 1, 2) && raw.charCodeAt(i + 3) === COLON && digitsAt(raw, i + 4, 2))) return false;
    i += 6;
  }
  return i === raw.length;
}

// hh:mm, with :ss and .fraction optional (TOML 1.1 allows leaving out seconds), from i.
// Returns the index after it, or -1.
function timeEnd(raw, i) {
  if (!(digitsAt(raw, i, 2) && raw.charCodeAt(i + 2) === COLON && digitsAt(raw, i + 3, 2))) return -1;
  i += 5;
  if (raw.charCodeAt(i) !== COLON) return i;
  if (!digitsAt(raw, i + 1, 2)) return -1;
  i += 3;
  if (raw.charCodeAt(i) === DOT) {
    if (!isDigit(raw.charCodeAt(i + 1))) return -1;
    for (i++; isDigit(raw.charCodeAt(i)); i++);
  }
  return i;
}
const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isWs = (c) => c === SPACE || c === TAB;
const isDigit = (c) => c >= ZERO && c <= NINE;
// TOML 1.1 allows a set of Unicode letters in bare keys; any non-ASCII character is close enough here.
const isBare = (c) => (c >= LOWER_A && c <= LOWER_Z) || (c >= UPPER_A && c <= UPPER_Z) || isDigit(c)
  || c === UNDERSCORE || c === DASH || c >= 0x80;
// Where a bare value (integer, boolean, float, date-time) ends. NaN is past the end of input.
// Brackets, braces, quotes and = also end it, so `1[2` is an error rather than the text "1[2".
const isValueEnd = (c) => c !== c || isWs(c) || c === LF || c === CR || c === COMMA || c === RBRACKET
  || c === RBRACE || c === HASH || c === LBRACKET || c === LBRACE || c === QUOTE || c === APOS
  || c === EQUALS;

const digitValue = (c) => {
  if (isDigit(c)) return c - ZERO;
  if (c >= LOWER_A && c <= LOWER_F) return c - LOWER_A + 10;
  if (c >= UPPER_A && c <= UPPER_F) return c - UPPER_A + 10;
  return 99;
};

const NOT_INTEGER = Symbol("not an integer"), BAD_INTEGER = Symbol("malformed integer");

// Whether raw has an integer's shape: [+-]0x, 0o or 0b (either case) followed by anything, or
// [+-] then only digits and _. Anything else (a float, a date-time) is not this function's business.
function looksInteger(raw) {
  let i = raw.charCodeAt(0) === PLUS || raw.charCodeAt(0) === DASH ? 1 : 0;
  const p = raw.charCodeAt(i + 1) | 0x20; // lower-cased
  if (raw.charCodeAt(i) === ZERO && (p === LOWER_X || p === LOWER_O || p === LOWER_B)) return true;
  if (i >= raw.length) return false;
  for (; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c !== UNDERSCORE && !isDigit(c)) return false;
  }
  return true;
}

// A TOML integer as a Number; the raw text when it is a valid integer beyond 2^53;
// BAD_INTEGER when raw has an integer's shape but breaks a rule (007, 1__2, +0x1);
// NOT_INTEGER when it is something else.
function integer(raw) {
  if (!looksInteger(raw)) return NOT_INTEGER;
  const n = integerValue(raw);
  return n === undefined ? BAD_INTEGER : n;
}

// The value of an integer-shaped raw: a Number, the raw text past 2^53, or undefined when malformed.
function integerValue(raw) {
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
    else return undefined; // a leading zero
    if (i === 1) return undefined; // prefixed integers take no sign
    i += 2;
  }
  let n = 0, prevDigit = false, big = false;
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
    if (n > Number.MAX_SAFE_INTEGER) big = true;
    prevDigit = true;
  }
  if (!prevDigit) return undefined;
  if (big) return raw;
  return n === 0 ? 0 : sign * n;
}

class Parser {
  constructor(s) {
    this.s = s;
    this.pos = s.charCodeAt(0) === 0xfeff ? 1 : 0; // a UTF-8 byte-order mark
    this.depth = 0;
    // How each table came to exist, for TOML's no-redefinition rules. A table in none of
    // these was created implicitly by a header ([a] in [a.b]) and may still be defined once.
    this.headed = new WeakSet(); // defined by a [header] or as a [[header]] element
    this.dotted = new WeakSet(); // created by a dotted key; no header may define it
    this.inline = new WeakSet(); // an inline table: complete as written
    this.aot = new WeakSet(); // arrays made by [[header]]; any other array is static
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
  // Either fails if it would redefine a table or reach into a value.
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
    const last = keys.length - 1;
    for (let i = 0; i < last; i++) t = this.descend(t, keys[i], start, false);
    const name = keys[last], existing = t[name];
    if (many) {
      const fresh = table();
      this.headed.add(fresh);
      if (existing === undefined) {
        const list = [fresh];
        this.aot.add(list);
        t[name] = list;
      } else if (Array.isArray(existing) && this.aot.has(existing)) existing.push(fresh);
      else this.fail(`key "${name}" is not an array of tables`, start);
      return fresh;
    }
    if (existing === undefined) {
      const fresh = (t[name] = table());
      this.headed.add(fresh);
      return fresh;
    }
    if (!isTable(existing)) this.fail(`key "${name}" is not a table`, start);
    if (this.headed.has(existing) || this.dotted.has(existing) || this.inline.has(existing)) {
      this.fail(`table "${keys.join(".")}" is defined more than once`, start);
    }
    this.headed.add(existing);
    return existing;
  }

  // The table under t[name] on the way to a header's or dotted key's last part, creating it if
  // missing. A header may pass through a [[name]] array (meaning its last element) and through
  // any table except an inline one; a dotted key may pass only through tables that dotted keys or
  // an implicit header path created.
  descend(t, name, pos, byDottedKey) {
    const v = t[name];
    if (v === undefined) {
      const fresh = (t[name] = table());
      if (byDottedKey) this.dotted.add(fresh);
      return fresh;
    }
    if (isTable(v)) {
      if (this.inline.has(v)) this.fail(`key "${name}" is an inline table, which cannot be extended`, pos);
      if (byDottedKey) {
        if (this.headed.has(v)) this.fail(`table "${name}" is already defined by a header`, pos);
        // A dotted key defines the implicit tables it passes through, so no header may define them later.
        this.dotted.add(v);
      }
      return v;
    }
    if (!byDottedKey && Array.isArray(v) && this.aot.has(v)) return v[v.length - 1];
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
    for (let i = 0; i < keys.length - 1; i++) t = this.descend(t, keys[i], start, true);
    const name = keys[keys.length - 1];
    if (t[name] !== undefined) this.fail(`duplicate key "${name}"`, start);
    t[name] = value;
  }

  value() {
    const c = this.code();
    if (c === QUOTE) return this.code(1) === QUOTE && this.code(2) === QUOTE ? this.multiBasic() : this.basicString();
    if (c === APOS) return this.code(1) === APOS && this.code(2) === APOS ? this.multiLiteral() : this.literalString();
    if (c === LBRACKET) return this.array();
    if (c === LBRACE) return this.inlineTable();
    return this.bareValue();
  }

  // Integers and booleans are typed; floats, inf/nan and date-times are returned as text.
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
    if (n === BAD_INTEGER) this.fail(`invalid integer ${raw}`, start);
    if (n !== NOT_INTEGER) return n;
    if (!isFloatOrDateTime(raw)) this.fail(`invalid value ${raw}`, start);
    return raw;
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
    this.inline.add(t);
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
