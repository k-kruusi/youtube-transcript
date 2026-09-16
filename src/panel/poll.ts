//
// Pure helpers for the boundary panel, kept DOM-free so they run in the node test env.
// The panel POSTs :fetch then polls state/results/<cid>.json; this module owns (a)
// minting the correlationId, (b) turning whatever the poll returns into a render decision
// (defensively — a transient 404 / half-written / schema-drifted file degrades to a clear
// outcome, not a crash), and (c) deriving the embeddable videoId from a YouTube URL.

import type { TranscriptFlags } from "../lib/fetch-transcript.js";

/** What the panel should show, derived from a polled results file (or its absence). */
export type PanelOutcome =
  | { kind: "running" }
  | { kind: "done"; text: string; fenced: string; flags: TranscriptFlags }
  | { kind: "error"; error: string }
  | { kind: "malformed"; detail: string };

/**
 * Mint a correlationId for one fetch request. Uses crypto.randomUUID when available
 * (browser + node), else a timestamp+random fallback. Stripped to the [A-Za-z0-9_-]
 * the results store keeps, so the cid the panel polls == the filename stem on disk.
 */
export function newCorrelationId(): string {
  const g = globalThis as any;
  let raw: string;
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    raw = g.crypto.randomUUID();
  } else {
    raw = `yt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

/** Human-readable one-liner from the flags, e.g. "auto-captions (en) · 2 hidden chars stripped". */
export function summarizeFlags(flags: TranscriptFlags): string {
  const parts: string[] = [];
  parts.push(flags.auto ? `auto-captions (${flags.lang}, machine ASR — may be lossy)` : `creator captions (${flags.lang})`);
  if (flags.forgeries > 0) {
    parts.push(`${flags.forgeries} boundary-forgery attempt${flags.forgeries === 1 ? "" : "s"} neutralized`);
  }
  if (flags.sanitizedRemoved > 0) {
    const kinds = flags.sanitizedKinds.length ? ` (${flags.sanitizedKinds.join(", ")})` : "";
    parts.push(`${flags.sanitizedRemoved} hidden character${flags.sanitizedRemoved === 1 ? "" : "s"} stripped${kinds}`);
  }
  if (flags.truncated) parts.push("truncated (exceeded max length)");
  return parts.join(" · ");
}

/**
 * Interpret a polled results file into a render decision. `raw` is the parsed JSON
 * (or null/undefined if the fetch 404'd or didn't parse). Unknown/partial shapes
 * become a clear "malformed" outcome rather than throwing in the render path.
 */
export function interpretResult(raw: unknown): PanelOutcome {
  if (raw == null || typeof raw !== "object") {
    // No file yet (pre-first-write 404) — treat as still running so the panel keeps polling.
    return { kind: "running" };
  }
  const obj = raw as Record<string, unknown>;
  const status = obj.status;

  if (status === "running") return { kind: "running" };

  if (status === "error") {
    const error = typeof obj.error === "string" && obj.error.trim() ? obj.error : "transcript fetch failed (no detail provided)";
    return { kind: "error", error };
  }

  if (status === "done") {
    if (typeof obj.fenced !== "string") {
      return { kind: "malformed", detail: "results file marked done but has no fenced output" };
    }
    const text = typeof obj.text === "string" ? obj.text : obj.fenced;
    const f = (obj.flags ?? {}) as Record<string, unknown>;
    const flags: TranscriptFlags = {
      lang: typeof f.lang === "string" ? f.lang : "?",
      auto: f.auto === true,
      ...(typeof f.title === "string" && f.title ? { title: f.title } : {}),
      sanitizedRemoved: typeof f.sanitizedRemoved === "number" ? f.sanitizedRemoved : 0,
      sanitizedKinds: Array.isArray(f.sanitizedKinds) ? (f.sanitizedKinds as string[]) : [],
      forgeries: typeof f.forgeries === "number" ? f.forgeries : 0,
      truncated: f.truncated === true,
    };
    return { kind: "done", text, fenced: obj.fenced, flags };
  }

  return { kind: "malformed", detail: `unknown results status ${JSON.stringify(status)}` };
}

// YouTube video ids are exactly 11 chars from the URL-safe base64 alphabet.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Best-effort extraction of an 11-char YouTube video id from a watch / youtu.be /
 * shorts / embed URL — used to build the player <iframe> src. Returns null for any URL
 * that doesn't yield a valid id (the panel just hides the player then; the cartridge's
 * validateYoutubeUrl is the real boundary, this is presentation only).
 */
export function extractVideoId(url: string): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\.|^m\./, "");

  if (host === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return VIDEO_ID.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "music.youtube.com") {
    if (parsed.pathname === "/watch") {
      const id = parsed.searchParams.get("v") ?? "";
      return VIDEO_ID.test(id) ? id : null;
    }
    const m = parsed.pathname.match(/^\/(?:shorts|embed|v)\/([^/]+)/);
    if (m && VIDEO_ID.test(m[1])) return m[1];
  }
  return null;
}
