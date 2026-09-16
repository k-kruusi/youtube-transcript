import { describe, it, expect } from "vitest";
import { validateYoutubeUrl, ytdlpPath } from "../lib/ytdlp.js";

describe("validateYoutubeUrl — the SSRF/abuse boundary", () => {
  const ID = "dQw4w9WgXcQ"; // canonical 11-char id

  // ── Accept table ──────────────────────────────────────────
  const accept: Array<[string, string]> = [
    ["watch?v=", `https://www.youtube.com/watch?v=${ID}`],
    ["watch?v= no-www", `https://youtube.com/watch?v=${ID}`],
    ["watch?v= http", `http://www.youtube.com/watch?v=${ID}`],
    ["watch?v= with extra params", `https://www.youtube.com/watch?v=${ID}&t=42s&list=PLxyz`],
    ["youtu.be short link", `https://youtu.be/${ID}`],
    ["youtu.be with query", `https://youtu.be/${ID}?t=10`],
    ["shorts", `https://www.youtube.com/shorts/${ID}`],
    ["m.youtube watch", `https://m.youtube.com/watch?v=${ID}`],
    ["music.youtube watch", `https://music.youtube.com/watch?v=${ID}`],
    ["embed", `https://www.youtube.com/embed/${ID}`],
  ];

  for (const [label, url] of accept) {
    it(`accepts ${label}`, () => {
      const res = validateYoutubeUrl(url);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.videoId).toBe(ID);
    });
  }

  // ── Reject table ──────────────────────────────────────────
  const reject: Array<[string, string]> = [
    ["arbitrary host (SSRF)", "https://evil.com/watch?v=dQw4w9WgXcQ"],
    ["lookalike subdomain host", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"],
    ["youtube path on evil host", "https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ"],
    ["non-11-char id (too short)", "https://www.youtube.com/watch?v=abc"],
    ["non-11-char id (too long)", "https://www.youtube.com/watch?v=dQw4w9WgXcQEXTRA"],
    ["id with illegal char", "https://www.youtube.com/watch?v=dQw4w9WgX!Q"],
    ["watch with no v param", "https://www.youtube.com/watch"],
    ["youtu.be with no id", "https://youtu.be/"],
    ["file:// scheme", "file:///etc/passwd"],
    ["ftp scheme", "ftp://youtube.com/watch?v=dQw4w9WgXcQ"],
    ["not a url at all", "just some text"],
    ["empty string", ""],
    ["bare youtube host, no path", "https://www.youtube.com/"],
  ];

  for (const [label, url] of reject) {
    it(`rejects ${label}`, () => {
      const res = validateYoutubeUrl(url);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(typeof res.reason).toBe("string");
      if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
    });
  }
});

describe("ytdlpPath", () => {
  it("returns a string or null without throwing", () => {
    const p = ytdlpPath();
    expect(p === null || typeof p === "string").toBe(true);
  });
});
