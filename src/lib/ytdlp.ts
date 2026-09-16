import { resolve, dirname, join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RawCaptions, UrlCheck, YtdlpPath, ValidateYoutubeUrl, FetchCaptions } from "../types.js";

/**
 * The agentruntime monorepo root. Mirrors packages/tools/src/utils.ts: the root
 * is where .tools-bin/ lives, and a cartridge's process.cwd() may be its own
 * instance dir — so we resolve from a marker file (agentruntime.json), not cwd.
 *
 * Resolution order:
 *   1. $AGENTRUNTIME_ROOT verified by an agentruntime.json marker
 *   2. walk up from this module's dir, then from process.cwd()
 *   3. process.cwd() as a last resort (logged, never silent)
 * Memoized — the root does not change over a process lifetime.
 */
let cachedRoot: string | null = null;

export function agentruntimeRoot(): string {
  if (cachedRoot) return cachedRoot;

  const env = process.env.AGENTRUNTIME_ROOT;
  if (env && existsSync(join(env, "agentruntime.json"))) {
    cachedRoot = resolve(env);
    return cachedRoot;
  }

  // Walk up from this module's own location first (robust to cwd), then cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [here, process.cwd()]) {
    let dir = start;
    for (let i = 0; i < 40; i++) {
      if (existsSync(join(dir, "agentruntime.json"))) {
        cachedRoot = dir;
        return cachedRoot;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  console.warn(
    `[youtube-transcript] Could not locate agentruntime.json (AGENTRUNTIME_ROOT=${env ?? "unset"}); ` +
      `falling back to process.cwd()=${process.cwd()}.`,
  );
  cachedRoot = process.cwd();
  return cachedRoot;
}

/**
 * Resolve the yt-dlp binary. Prefer the repo-bundled binary in .tools-bin/ —
 * PATH-independent, same rationale as .tools-bin/rg.exe (the shared cartridge
 * process inherits the supervisor's PATH captured at startup, so a system yt-dlp
 * install may not be visible). Falls back to "yt-dlp" if it resolves on PATH;
 * else null so the caller can fail honestly.
 * Run scripts/fetch-ytdlp.sh to populate .tools-bin on a new machine.
 */
export const ytdlpPath: YtdlpPath = () => {
  const bundled = join(
    agentruntimeRoot(),
    ".tools-bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
  if (existsSync(bundled)) return bundled;

  // Is yt-dlp on PATH? `where` (win) / `which` (posix) resolve it without running it.
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, ["yt-dlp"], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  if (r.status === 0) return "yt-dlp";

  return null;
};

// YouTube video ids are exactly 11 chars from the URL-safe base64 alphabet.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Allow-list of YouTube hosts. www./m. variants permitted; everything else rejected.
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/**
 * Boundary validation on the incoming URL — the SSRF/abuse seam. Accepts only
 * YouTube watch / youtu.be / shorts URLs whose video id is exactly 11 chars of
 * [A-Za-z0-9_-]. Rejects every other host or shape with an actionable reason.
 * This is defensive-at-the-boundary by design (NSP §"Boundary Validation Stays
 * Defensive"): `url` is untrusted, so we never assert — we check and report.
 */
export const validateYoutubeUrl: ValidateYoutubeUrl = (url: string): UrlCheck => {
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, reason: "empty url" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: `not a valid URL: ${url}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme '${parsed.protocol}' — only http(s) YouTube URLs allowed` };
  }

  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return { ok: false, reason: `not a YouTube host: '${host}'` };
  }

  // youtu.be/<id>  — id is the first path segment.
  if (host === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!VIDEO_ID.test(id)) {
      return { ok: false, reason: `youtu.be link has no valid 11-char video id (got '${id}')` };
    }
    return { ok: true, videoId: id };
  }

  // youtube.com/shorts/<id>
  const shorts = parsed.pathname.match(/^\/shorts\/([^/]+)/);
  if (shorts) {
    const id = shorts[1];
    if (!VIDEO_ID.test(id)) {
      return { ok: false, reason: `shorts link has no valid 11-char video id (got '${id}')` };
    }
    return { ok: true, videoId: id };
  }

  // youtube.com/watch?v=<id>
  if (parsed.pathname === "/watch") {
    const id = parsed.searchParams.get("v") ?? "";
    if (!VIDEO_ID.test(id)) {
      return { ok: false, reason: `watch link has no valid 11-char video id (got '${id}')` };
    }
    return { ok: true, videoId: id };
  }

  // youtube.com/embed/<id> and /v/<id> — common share shapes, same id rule.
  const embed = parsed.pathname.match(/^\/(?:embed|v)\/([^/]+)/);
  if (embed) {
    const id = embed[1];
    if (!VIDEO_ID.test(id)) {
      return { ok: false, reason: `embed link has no valid 11-char video id (got '${id}')` };
    }
    return { ok: true, videoId: id };
  }

  return { ok: false, reason: `unrecognized YouTube URL shape: '${parsed.pathname}'` };
};

const FETCH_TIMEOUT_MS = 60_000;

/** Base yt-dlp args shared by both passes — no video download, single video, json3 subs. */
function baseArgs(lang: string, outTemplate: string, url: string): string[] {
  return [
    "--sub-langs",
    lang,
    "--sub-format",
    "json3",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "-o",
    outTemplate,
    url,
  ];
}

/** Find the produced <id>.<lang>.json3 file in a dir, or null if none was written. */
function findJson3(dir: string): string | null {
  const hit = readdirSync(dir).find((f) => f.endsWith(".json3"));
  return hit ? join(dir, hit) : null;
}

/** Pull a lang code out of a yt-dlp subtitle filename: <id>.<lang>.json3 → <lang>. */
function langFromFilename(file: string, fallback: string): string {
  const m = file.match(/\.([A-Za-z0-9-]+)\.json3$/);
  return m ? m[1] : fallback;
}

/**
 * Classify a yt-dlp stderr blob into an actionable, honest error message. yt-dlp
 * does not use stable exit codes per failure-kind, so we pattern-match its stderr
 * to distinguish "private/unavailable video" from "no captions" from a generic
 * failure. This is the Honest-Response Principle at the subprocess boundary:
 * the agent must learn WHY, never get a blank.
 */
function classifyFailure(stderr: string, videoId: string): string {
  const s = stderr.toLowerCase();
  if (/private video|sign in to confirm|members-only|join this channel/.test(s)) {
    return `video ${videoId} is private or members-only — captions cannot be fetched`;
  }
  if (/video unavailable|has been removed|account associated.*has been terminated|not available/.test(s)) {
    return `video ${videoId} is unavailable (removed, region-blocked, or terminated)`;
  }
  if (/unable to download|getaddrinfo|network|connection|timed out|temporary failure/.test(s)) {
    return `network error fetching captions for ${videoId} — try again`;
  }
  if (/no subtitles|requested format is not available|there are no subtitles/.test(s)) {
    return `no captions available for video ${videoId}`;
  }
  const firstLine = stderr.split(/\r?\n/).find((l) => /error/i.test(l))?.trim();
  return firstLine
    ? `yt-dlp failed for ${videoId}: ${firstLine}`
    : `yt-dlp produced no captions for ${videoId} and gave no specific reason`;
}

/**
 * Fetch a video's captions directly from YouTube via vendored yt-dlp, WITHOUT
 * downloading the video. Two-pass for honest auto-vs-authored detection:
 *   pass 1 — manual/creator subs only (--write-subs, NO auto). A hit ⇒ auto:false.
 *   pass 2 — auto-generated subs (--write-auto-subs).         A hit ⇒ auto:true.
 * Each pass writes json3 into a throwaway temp dir, which we always clean up.
 *
 * Assumes `url` already passed validateYoutubeUrl (caller's job — the tool handler
 * validates first). We still derive videoId here for error messages and provenance.
 *
 * Throws an honest Error on: yt-dlp missing, no captions in either pass, video
 * unavailable/private, or network failure — distinguished where yt-dlp's stderr
 * allows. Never resolves with empty/ambiguous content.
 */
export const fetchCaptions: FetchCaptions = async (
  url: string,
  opts?: { lang?: string },
): Promise<RawCaptions> => {
  const bin = ytdlpPath();
  if (bin === null) {
    throw new Error("yt-dlp not installed — run scripts/fetch-ytdlp.sh");
  }

  const check = validateYoutubeUrl(url);
  if (!check.ok) {
    // Defensive: fetchCaptions may be called directly (tests, other consumers).
    throw new Error(`invalid_youtube_url: ${check.reason}`);
  }
  const videoId = check.videoId;
  const lang = opts?.lang && opts.lang.trim() !== "" ? opts.lang.trim() : "en";

  const tmp = mkdtempSync(join(tmpdir(), "yt-captions-"));
  try {
    const outTemplate = join(tmp, "%(id)s.%(ext)s");

    // Pass 1: manual/creator subtitles only.
    const manual = spawnSync(
      bin,
      ["--write-subs", ...baseArgs(lang, outTemplate, url)],
      { encoding: "utf-8", timeout: FETCH_TIMEOUT_MS, windowsHide: true },
    );
    if (manual.error && (manual.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(`timed out fetching captions for ${videoId} (>${FETCH_TIMEOUT_MS / 1000}s)`);
    }

    let file = findJson3(tmp);
    let auto = false;

    // Pass 2: fall back to auto-generated subtitles.
    if (!file) {
      const autoRun = spawnSync(
        bin,
        ["--write-auto-subs", ...baseArgs(lang, outTemplate, url)],
        { encoding: "utf-8", timeout: FETCH_TIMEOUT_MS, windowsHide: true },
      );
      if (autoRun.error && (autoRun.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        throw new Error(`timed out fetching captions for ${videoId} (>${FETCH_TIMEOUT_MS / 1000}s)`);
      }
      file = findJson3(tmp);
      auto = true;

      if (!file) {
        // Neither pass produced captions — classify why from the richer stderr.
        const stderr = `${manual.stderr ?? ""}\n${autoRun.stderr ?? ""}`;
        throw new Error(classifyFailure(stderr, videoId));
      }
    }

    const content = readFileSync(file, "utf-8");
    const resolvedLang = langFromFilename(file, lang);
    const title = fetchTitle(bin, url);

    return {
      format: "json3",
      content,
      lang: resolvedLang,
      auto,
      videoId,
      ...(title ? { title } : {}),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/**
 * Best-effort video title via `yt-dlp --print title`. Title is optional in the
 * contract (RawCaptions.title?), so a failure here is non-fatal — we return
 * undefined and the provenance header simply omits the title. This is the one
 * genuinely-optional field, hence a swallow-with-undefined rather than a throw.
 */
function fetchTitle(bin: string, url: string): string | undefined {
  try {
    const out = execFileSync(
      bin,
      ["--skip-download", "--no-playlist", "--no-warnings", "--print", "title", url],
      { encoding: "utf-8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const t = out.split(/\r?\n/)[0]?.trim();
    return t && t !== "" ? t : undefined;
  } catch {
    // Title is non-essential provenance — never let it sink a successful fetch.
    return undefined;
  }
}
