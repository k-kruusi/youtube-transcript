import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RawCaptions, UrlCheck } from "../types.js";

// ── Mock the yt-dlp boundary module ───────────────────────
// validateYoutubeUrl + ytdlpPath are cheap/pure enough to keep the real behavior,
// but fetchCaptions MUST be mocked so no network call happens.
const VIDEO_ID = "dQw4w9WgXcQ";

vi.mock("../lib/ytdlp.js", () => {
  return {
    ytdlpPath: () => "yt-dlp", // pretend the binary is present
    validateYoutubeUrl: (url: string): UrlCheck => {
      // minimal real-ish validator for the test: accept canonical watch URL,
      // reject anything else — exercises the handler's branch, not the regex.
      const m = url.match(/[?&]v=([A-Za-z0-9_-]{11})(?:$|[&])/);
      if (url.includes("youtube.com/watch") && m) return { ok: true, videoId: m[1] };
      return { ok: false, reason: `not a YouTube url: ${url}` };
    },
    fetchCaptions: vi.fn(),
  };
});

import { registerGetTranscript } from "../tools/get-transcript.js";
import { fetchCaptions } from "../lib/ytdlp.js";

// ── Mock MCP server that captures the handler ─────────────
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  return {
    server: server as unknown as McpServer,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}

// A minimal valid json3 timedtext doc with two cues.
function json3(text1: string, text2: string): string {
  return JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: text1 }] },
      { tStartMs: 1500, dDurationMs: 1500, segs: [{ utf8: text2 }] },
    ],
  });
}

const fetchMock = vi.mocked(fetchCaptions);

describe("get_transcript handler", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("valid url + mocked json3 → fenced output with untrusted header + videoId", async () => {
    const raw: RawCaptions = {
      format: "json3",
      content: json3("Never gonna give you up", "Never gonna let you down"),
      lang: "en",
      auto: false,
      videoId: VIDEO_ID,
      title: "Rick Astley - Never Gonna Give You Up",
    };
    fetchMock.mockResolvedValue(raw);

    const mock = makeMockServer();
    registerGetTranscript(mock.server);
    const res = await mock.call("get_transcript", {
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    // Untrusted-data fence header is present (SHARED nonce-keyed fence).
    expect(text).toContain("UNTRUSTED DATA");
    // Provenance carries the source (youtube:<id>) and the nonce-keyed delimiter.
    expect(text).toContain(`source: youtube:${VIDEO_ID}`);
    expect(text).toMatch(/<untrusted-[0-9a-f]{32}>/);
    expect(text).toMatch(/<\/untrusted-[0-9a-f]{32}>/);
    // The actual caption content survives the pipeline.
    expect(text).toContain("Never gonna give you up");
  });

  it("fence:false returns the RAW sanitized transcript with no fence", async () => {
    const raw: RawCaptions = {
      format: "json3",
      content: json3("Never gonna give you up", "Never gonna let you down"),
      lang: "en",
      auto: false,
      videoId: VIDEO_ID,
    };
    fetchMock.mockResolvedValue(raw);

    const mock = makeMockServer();
    registerGetTranscript(mock.server);
    const res = await mock.call("get_transcript", {
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      fence: false,
    });

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).not.toContain("UNTRUSTED DATA");
    expect(text).not.toMatch(/<untrusted-/);
    expect(text).toContain("Never gonna give you up");
  });

  it("bad url → isError, fetchCaptions never called", async () => {
    const mock = makeMockServer();
    registerGetTranscript(mock.server);
    const res = await mock.call("get_transcript", { url: "https://evil.com/watch?v=dQw4w9WgXcQ" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("invalid_youtube_url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchCaptions throws → isError carrying the thrown message", async () => {
    fetchMock.mockRejectedValue(new Error(`no captions available for video ${VIDEO_ID}`));

    const mock = makeMockServer();
    registerGetTranscript(mock.server);
    const res = await mock.call("get_transcript", {
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("no captions available");
  });

  it("captions parse to empty text → honest 'no readable text' isError", async () => {
    // Valid-but-empty json3 (no cues with text) → parseCaptions yields no segments.
    const raw: RawCaptions = {
      format: "json3",
      content: JSON.stringify({ events: [] }),
      lang: "en",
      auto: true,
      videoId: VIDEO_ID,
    };
    fetchMock.mockResolvedValue(raw);

    const mock = makeMockServer();
    registerGetTranscript(mock.server);
    const res = await mock.call("get_transcript", {
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("no readable text");
  });
});
