import type {
  CaptionSegment,
  RawCaptions,
  ParseCaptions,
  SegmentsToText,
} from "../types.js";

/** One json3 event as YouTube's timedtext endpoint emits it. */
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}
interface Json3Doc {
  events?: Json3Event[];
}

/**
 * Boundary parse of a yt-dlp subtitle file into segments.
 * Format is dictated by `raw.format` (the fetch layer resolved it).
 */
export const parseCaptions: ParseCaptions = (raw: RawCaptions): CaptionSegment[] => {
  if (raw.format === "json3") return parseJson3(raw.content);
  if (raw.format === "vtt") return parseVtt(raw.content);
  // RawCaptions.format is typed as a 2-member union; reaching here means the
  // boundary lied about its own shape. That is a real boundary violation, not an
  // internal invariant — surface it as an honest error.
  throw new Error(`unknown captions format: ${String((raw as RawCaptions).format)}`);
};

function parseJson3(content: string): CaptionSegment[] {
  let doc: Json3Doc;
  try {
    doc = JSON.parse(content) as Json3Doc;
  } catch {
    throw new Error("unparseable json3 captions");
  }
  // A valid-but-empty timedtext doc is `{}` or `{ events: [] }` — that is "no
  // captions", not malformed. Only a non-object or a non-array `events` is broken.
  if (doc === null || typeof doc !== "object") {
    throw new Error("unparseable json3 captions: not an object");
  }
  const events = doc.events ?? [];
  if (!Array.isArray(events)) {
    throw new Error("unparseable json3 captions: events is not an array");
  }

  const segments: CaptionSegment[] = [];
  for (const ev of events) {
    // Events with no `segs` are formatting / window-append markers — skip them.
    if (!ev || !Array.isArray(ev.segs)) continue;
    const text = ev.segs
      .map((s) => (s && typeof s.utf8 === "string" ? s.utf8 : ""))
      .join("")
      .trim();
    if (text === "") continue; // drop empty-text segments
    segments.push({
      start: (ev.tStartMs ?? 0) / 1000,
      dur: (ev.dDurationMs ?? 0) / 1000,
      text,
    });
  }
  return segments;
}

// A WebVTT timestamp: HH:MM:SS.mmm (hours optional in the wild, but yt-dlp emits
// full HH). We accept 1-2 hour digits, 2 min/sec digits, 3 ms digits.
const VTT_CUE_TIMING =
  /^(\d{1,3}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{1,3}):(\d{2}):(\d{2})\.(\d{3})/;

function vttTimeToSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function parseVtt(content: string): CaptionSegment[] {
  // Split into lines, tolerant of \r\n and lone \r.
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const segments: CaptionSegment[] = [];

  let i = 0;
  // Skip the optional "WEBVTT" header and any header block up to first blank line.
  if (lines[0]?.startsWith("WEBVTT")) {
    while (i < lines.length && lines[i].trim() !== "") i++;
  }

  while (i < lines.length) {
    const line = lines[i];
    const timing = VTT_CUE_TIMING.exec(line);
    if (!timing) {
      i++;
      continue;
    }
    const start = vttTimeToSeconds(timing[1], timing[2], timing[3], timing[4]);
    const end = vttTimeToSeconds(timing[5], timing[6], timing[7], timing[8]);
    i++;

    // Collect text lines until a blank line or the next cue timing.
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !VTT_CUE_TIMING.test(lines[i])) {
      textLines.push(lines[i]);
      i++;
    }
    const text = stripVttInline(textLines.join("\n")).trim();
    if (text !== "") {
      // end >= start for well-formed cues; clamp to 0 rather than emit negative dur.
      segments.push({ start, dur: Math.max(0, end - start), text });
    }
  }
  return segments;
}

/** Strip inline `<...>` tags (e.g. `<00:00:01.000>`, `<c>`) from cue text. */
function stripVttInline(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

/**
 * Join segments into readable prose, collapsing consecutive duplicate lines.
 * YouTube auto-captions emit a rolling window: each phrase repeats as it scrolls,
 * so consecutive segments are frequently identical (or one is a prefix of the
 * next). We drop a segment whose text equals the previously KEPT line.
 */
export const segmentsToText: SegmentsToText = (
  segs: CaptionSegment[],
  opts?: { timestamps?: boolean },
): string => {
  if (segs.length === 0) return "";

  const wantTs = opts?.timestamps === true;
  const out: string[] = [];
  let lastKept: string | null = null;

  for (const seg of segs) {
    const t = seg.text.trim();
    if (t === "") continue;
    if (t === lastKept) continue; // collapse consecutive exact duplicate
    lastKept = t;
    out.push(wantTs ? `[${formatTimestamp(seg.start)}] ${t}` : t);
  }
  return out.join("\n");
};

/** Format seconds as `mm:ss` (zero-padded), minutes uncapped (e.g. `127:04`). */
function formatTimestamp(seconds: number): string {
  // start is non-negative for any real caption; a negative would be a parse bug.
  const total = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
