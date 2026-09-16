//
// The single trusted-side pipeline. Both intake surfaces — the get_transcript MCP tool
// (the by-reference agent workflow node) and the @agentruntime/youtube-transcript:fetch
// bus handler (the human-facing boundary panel) — drive THIS function, so a transcript
// behaves identically no matter which door the URL comes through.
//
// Honest-Response: every failure is an { ok:false, error } with an actionable message —
// never an empty/ambiguous success. The captions are attacker-controllable third-party
// text, so the result is wrapped in the SHARED nonce-keyed untrusted-data fence (a token
// the uploader never saw) unless the caller explicitly opts out with fence:false.

import { validateYoutubeUrl, ytdlpPath, fetchCaptions } from "./ytdlp.js";
import { parseCaptions, segmentsToText } from "./parse-captions.js";
import { sanitizeText } from "./sanitize.js";
import { fenceContent } from "../fence-output.js";

// Hard cap on returned text. Captions for a long video can be huge; we truncate with an
// explicit, honest marker rather than silently dropping the tail or blowing the consumer's
// context. Override via MAX_OUTPUT env.
const MAX_OUTPUT = parseInt(process.env.MAX_OUTPUT || "100000", 10);

/** Structured flags the consumer (panel / agent) can render without re-parsing the fence. */
export interface TranscriptFlags {
  /** Resolved caption language code. */
  lang: string;
  /** true = auto-generated (machine ASR, lossy). */
  auto: boolean;
  /** Best-effort video title (may be empty). */
  title?: string;
  /** Count of hidden/suspicious chars stripped by mechanical sanitize. */
  sanitizedRemoved: number;
  /** Kind labels for the stripped chars (e.g. ["bidi-override"]). */
  sanitizedKinds: string[];
  /** Count of boundary-forgery attempts found + neutralized in the captions. */
  forgeries: number;
  /** true if the output was truncated to MAX_OUTPUT. */
  truncated: boolean;
}

/**
 * Discriminated result. `ok:true` carries BOTH the fenced envelope (the thing the
 * privileged agent should read) and the raw sanitized text, plus structured flags.
 * `ok:false` carries a clear, actionable error — never an empty/ambiguous success.
 */
export type TranscriptResult =
  | { ok: true; text: string; fenced: string; flags: TranscriptFlags }
  | { ok: false; error: string };

/** Options for one transcript fetch. */
export interface FetchTranscriptOptions {
  /** Preferred caption language code (default "en", falls back to best available). */
  lang?: string;
  /** If true, prefix each line with its start time. */
  timestamps?: boolean;
  /** Wrap the result in the untrusted-data fence (default true). false = raw sanitized text. */
  fence?: boolean;
}

/**
 * Run the full youtube-transcript pipeline over one `url`.
 *
 *   1. Boundary validation (the SSRF/abuse seam) — untrusted input stops here unless it
 *      is an allow-listed YouTube URL with a valid 11-char id.
 *   2. yt-dlp must be vendored/available — fail with the exact remedy.
 *   3. Fetch captions directly from YouTube (classified, honest errors).
 *   4. Parse json3/vtt -> segments -> text. Empty text is a failure, not a blank success.
 *   5. Mechanical sanitize (strip invisible/unicode tricks — counted, never silent).
 *   6. Wrap in the SHARED nonce-keyed untrusted-data fence (or raw if fence:false).
 *   7. Truncate to MAX_OUTPUT with an honest marker if exceeded.
 */
export async function fetchTranscript(
  url: string,
  opts: FetchTranscriptOptions = {},
): Promise<TranscriptResult> {
  const doFence = opts.fence !== false;

  // 1. Boundary validation.
  const check = validateYoutubeUrl(url);
  if (!check.ok) {
    return { ok: false, error: `invalid_youtube_url: ${check.reason}` };
  }
  const videoId = check.videoId;

  // 2. yt-dlp guard.
  if (ytdlpPath() === null) {
    return { ok: false, error: "yt-dlp not installed — run scripts/fetch-ytdlp.sh" };
  }

  // 3. Fetch captions directly from YouTube.
  const resolvedLang = opts.lang && opts.lang.trim() !== "" ? opts.lang.trim() : "en";
  let raw;
  try {
    raw = await fetchCaptions(url, { lang: resolvedLang });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 4. Parse -> segments -> text. Empty text is a failure (Honest-Response).
  const segs = parseCaptions(raw);
  const text = segmentsToText(segs, { timestamps: opts.timestamps === true });
  if (text.trim() === "") {
    return { ok: false, error: "captions fetched but contained no readable text" };
  }

  // 5. Mechanical sanitize.
  const sanitized = sanitizeText(text);

  // 6. Fence (SHARED nonce-keyed lib) or raw sanitized text.
  const fenceRes = doFence
    ? fenceContent(sanitized.text, `youtube:${videoId}`, "fetch youtube transcript", {
        lang: raw.lang,
        auto: raw.auto,
        sanitize: sanitized.report,
        ...(raw.title ? { title: raw.title } : {}),
      })
    : null;
  const fenced = fenceRes ? fenceRes.fenced : sanitized.text;

  // 7. Truncate to MAX_OUTPUT with an honest marker if exceeded.
  let out = fenced;
  let truncated = false;
  if (out.length > MAX_OUTPUT) {
    const marker = `\n\n[... transcript truncated: exceeded MAX_OUTPUT=${MAX_OUTPUT} chars ...]`;
    out = out.slice(0, Math.max(0, MAX_OUTPUT - marker.length)) + marker;
    truncated = true;
  }

  return {
    ok: true,
    text: sanitized.text,
    fenced: out,
    flags: {
      lang: raw.lang,
      auto: raw.auto,
      ...(raw.title ? { title: raw.title } : {}),
      sanitizedRemoved: sanitized.report.removed,
      sanitizedKinds: sanitized.report.kinds,
      forgeries: fenceRes ? fenceRes.forgeries : 0,
      truncated,
    },
  };
}
