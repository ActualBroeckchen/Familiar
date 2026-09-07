// Tolerant parsing for the village registry's canonical JSON.
//
// The registry is pushed to Phylactery as a JSON.stringify'd fenced block —
// always well-formed on the way out. But the canonical copy round-trips
// through a markdown identity file, and a stray control character (a raw
// newline, tab, or bell) can survive inside a string value there — usually
// from a legacy write or an external edit. JSON.parse rejects a raw control
// character inside a string literal ("Bad control character in string
// literal"), which used to take out the ENTIRE canonical pull and silently
// drop village sync to mirror-only.
//
// This repairs exactly that class of corruption at the read boundary: it
// escapes raw control characters that appear *inside* string literals, so
// the data is recovered faithfully rather than lost. It never touches
// control chars outside strings (JSON's own insignificant whitespace) and
// never masks any other kind of malformed JSON — a genuinely broken blob
// still throws, so a real corruption stays visible instead of being papered
// over. The repaired object heals canonical on the next registry write
// (mutate() re-pushes a clean JSON.stringify).

// Short escapes JSON understands; anything else becomes a \uXXXX escape.
const CONTROL_ESCAPES = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
};

/**
 * Escape raw control characters (U+0000–U+001F) that appear inside JSON
 * string literals, leaving everything else — including insignificant
 * whitespace between tokens — untouched. Returns the input unchanged when
 * there is nothing to repair.
 */
export function sanitizeJsonControlChars(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (ch.charCodeAt(0) < 0x20) {
        out += CONTROL_ESCAPES[ch] ?? ('\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') { inString = true; }
      out += ch;
    }
  }
  return out;
}

/**
 * Parse the registry's canonical JSON, tolerating stray control characters
 * inside string literals. Returns { value, repaired }. A repair is attempted
 * only after a plain parse fails; if the sanitised text still doesn't parse
 * (corruption beyond stray control chars), the ORIGINAL parse error is
 * rethrown so the caller degrades exactly as it would have before.
 */
export function parseRegistryJson(text) {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch (err) {
    const fixed = sanitizeJsonControlChars(text);
    if (fixed !== text) {
      try {
        return { value: JSON.parse(fixed), repaired: true };
      } catch { /* fall through to the original error below */ }
    }
    throw err;
  }
}
