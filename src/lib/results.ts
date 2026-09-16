//
// The panel is decoupled from the bus: it POSTs :fetch, then POLLS state/results/<cid>.json.
// This module is the ONLY writer of those files, so the file-status contract lives in one
// place. The contract (Honest-Response): the panel must always be able to tell
//   running  → still working, keep polling
//   done     → fenced transcript is ready
//   error    → it failed, here's why (NEVER a blank/missing file masquerading as either)
// so the bus handler writes a {running} marker before it starts and ALWAYS lands on
// {done} or {error}.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TranscriptFlags } from "./fetch-transcript.js";

/** The on-disk shape the panel reads. Discriminated by `status`. */
export type ResultFile =
  | { status: "running"; correlationId: string; url?: string; startedAt: number }
  | {
      status: "done";
      correlationId: string;
      text: string;
      fenced: string;
      flags: TranscriptFlags;
      finishedAt: number;
    }
  | { status: "error"; correlationId: string; error: string; finishedAt: number };

/**
 * Sanitize a correlationId into a safe filename stem. The id comes from the panel
 * (random) but also potentially the bus (any caller), so treat it as untrusted: keep
 * only [A-Za-z0-9_-], cap the length, and fall back to "unknown" if nothing survives.
 * This makes path traversal (../, absolute paths) structurally impossible.
 */
export function safeCid(correlationId: string): string {
  const cleaned = String(correlationId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Absolute path to the result file for a (sanitized) correlationId under resultsDir. */
export function resultPath(resultsDir: string, correlationId: string): string {
  return resolve(resultsDir, `${safeCid(correlationId)}.json`);
}

/** Ensure resultsDir exists, then write `body` as pretty JSON. */
function write(resultsDir: string, correlationId: string, body: ResultFile): string {
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const path = resultPath(resultsDir, correlationId);
  writeFileSync(path, JSON.stringify(body, null, 2), "utf-8");
  return path;
}

/** Write the {running} marker FIRST — the panel shows "fetching…" off this. */
export function writeRunning(resultsDir: string, correlationId: string, url?: string): string {
  return write(resultsDir, correlationId, {
    status: "running",
    correlationId: safeCid(correlationId),
    ...(url ? { url } : {}),
    startedAt: Date.now(),
  });
}

/** Write the terminal {done} file — the fenced envelope + raw text + structured flags. */
export function writeDone(
  resultsDir: string,
  correlationId: string,
  text: string,
  fenced: string,
  flags: TranscriptFlags,
): string {
  return write(resultsDir, correlationId, {
    status: "done",
    correlationId: safeCid(correlationId),
    text,
    fenced,
    flags,
    finishedAt: Date.now(),
  });
}

/** Write the terminal {error} file — Honest-Response, never a blank result. */
export function writeError(resultsDir: string, correlationId: string, error: string): string {
  return write(resultsDir, correlationId, {
    status: "error",
    correlationId: safeCid(correlationId),
    error,
    finishedAt: Date.now(),
  });
}
