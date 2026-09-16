/** One contiguous caption span. `start`/`dur` are seconds. */
export interface CaptionSegment {
  start: number;
  dur: number;
  text: string;
}

/** Raw subtitle file exactly as yt-dlp returned it, plus resolved provenance. */
export interface RawCaptions {
  format: "json3" | "vtt";
  content: string; // raw subtitle file content as returned by yt-dlp
  lang: string; // resolved caption language code
  auto: boolean; // true = auto-generated (lossy); false = creator-authored
  videoId: string;
  title?: string;
}

/** What the sanitizer stripped — surfaced to the agent, never silent. */
export interface SanitizeReport {
  removed: number; // count of suspicious chars stripped
  kinds: string[]; // e.g. ["zero-width-space", "bidi-override"]
}

/** Result of boundary validation on the incoming URL. */
export type UrlCheck = { ok: true; videoId: string } | { ok: false; reason: string };

// Implemented in lib/parse-captions.ts
export type ParseCaptions = (raw: RawCaptions) => CaptionSegment[];
export type SegmentsToText = (segs: CaptionSegment[], opts?: { timestamps?: boolean }) => string;
// Implemented in lib/sanitize.ts
export type SanitizeText = (input: string) => { text: string; report: SanitizeReport };
// The untrusted-data fence now lives in ../fence-output.ts (fenceContent), built on the
// SHARED @agentruntime/untrusted-fence lib — no local FenceUntrusted signature here.
// Implemented in lib/ytdlp.ts
export type YtdlpPath = () => string | null;
export type ValidateYoutubeUrl = (url: string) => UrlCheck;
export type FetchCaptions = (url: string, opts?: { lang?: string }) => Promise<RawCaptions>;
