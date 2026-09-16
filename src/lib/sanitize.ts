import type { SanitizeText, SanitizeReport } from "../types.js";

/** Human-readable kind labels, emitted (sorted, unique) in the report. */
type Kind =
  | "zero-width-space"
  | "bidi-override"
  | "format-char"
  | "tag-char"
  | "control-char";

// --- The classes we strip, by codepoint -----------------------------------
//
// We decide per-codepoint (not per-char), so astral chars (Tags block, U+E0000+)
// are handled correctly via for..of (which iterates code points).

// Zero-width / word-joiner / BOM family — invisible, no rendering width.
const ZERO_WIDTH = new Set<number>([
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x2060, // WORD JOINER
  0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
]);

/** Bidi formatting/override controls — can visually reorder hidden text. */
function isBidiControl(cp: number): boolean {
  // U+202A..U+202E: LRE, RLE, PDF, LRO, RLO
  // U+2066..U+2069: LRI, RLI, FSI, PDI
  return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

/** Unicode Tags block — invisible "tag" chars used in hidden-prompt attacks. */
function isTagChar(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

/**
 * C0 (U+0000..U+001F) and C1 (U+007F..U+009F) control characters, EXCEPT the
 * two whitespace controls we keep: \n (U+000A) and \t (U+0009). \r is handled
 * separately (normalized to \n before this runs), so it never reaches here.
 */
function isStrippedControl(cp: number): boolean {
  if (cp === 0x0a || cp === 0x09) return false; // keep newline + tab
  return (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * Remaining Unicode "Cf" (format) characters not already covered above —
 * e.g. soft hyphen (U+00AD), Arabic format chars, interlinear annotation
 * controls, variation-selector-style format chars in the supplementary plane,
 * etc. We use the engine's own Unicode property table via a regex test so we
 * don't have to hand-maintain the list. Already-covered codepoints are checked
 * first by the caller, so this only catches the long tail.
 */
const CF_FORMAT = /\p{Cf}/u;
function isOtherFormatChar(ch: string): boolean {
  return CF_FORMAT.test(ch);
}

/**
 * Boundary sanitizer. Input is an untrusted transcript string.
 * Returns the cleaned text plus an honest report of what was removed.
 */
export const sanitizeText: SanitizeText = (
  input: string,
): { text: string; report: SanitizeReport } => {
  // Normalize CRLF (and lone CR) to LF first, so \r never counts as a stripped
  // control and line endings are uniform downstream.
  const normalized = input.replace(/\r\n?/g, "\n");

  const kinds = new Set<Kind>();
  let removed = 0;
  let out = "";

  // for..of iterates by code point, so `ch` is a full character (1 or 2 UTF-16
  // units). `cp` is its scalar value — correct for astral Tags-block chars.
  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    // for..of always yields at least one code unit, so cp is defined here.
    if (cp === undefined) {
      throw new Error("unreachable: for..of yielded a code point with no value");
    }

    let kind: Kind | null = null;
    if (ZERO_WIDTH.has(cp)) {
      kind = "zero-width-space";
    } else if (isBidiControl(cp)) {
      kind = "bidi-override";
    } else if (isTagChar(cp)) {
      kind = "tag-char";
    } else if (isStrippedControl(cp)) {
      kind = "control-char";
    } else if (isOtherFormatChar(ch)) {
      // Long-tail Cf format chars not already classified above.
      kind = "format-char";
    }

    if (kind === null) {
      out += ch;
    } else {
      removed++;
      kinds.add(kind);
    }
  }

  return {
    text: out,
    report: {
      removed,
      kinds: [...kinds].sort(),
    },
  };
};
