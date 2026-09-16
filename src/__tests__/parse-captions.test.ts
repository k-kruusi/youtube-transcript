import { describe, it, expect } from "vitest";
import { parseCaptions, segmentsToText } from "../lib/parse-captions.js";
import type { RawCaptions } from "../types.js";

function json3(content: string, over: Partial<RawCaptions> = {}): RawCaptions {
  return {
    format: "json3",
    content,
    lang: "en",
    auto: false,
    videoId: "vid123",
    ...over,
  };
}
function vtt(content: string, over: Partial<RawCaptions> = {}): RawCaptions {
  return {
    format: "vtt",
    content,
    lang: "en",
    auto: false,
    videoId: "vid123",
    ...over,
  };
}

describe("parseCaptions — json3", () => {
  it("parses events into segments with correct count, text, and timing", () => {
    const doc = JSON.stringify({
      events: [
        // formatting marker — no segs — must be skipped
        { tStartMs: 0, aAppend: 1 },
        {
          tStartMs: 1000,
          dDurationMs: 2000,
          segs: [{ utf8: "Hello " }, { utf8: "world" }],
        },
        {
          tStartMs: 3500,
          dDurationMs: 1500,
          segs: [{ utf8: "second line" }],
        },
        // empty-text segment — must be dropped
        { tStartMs: 5000, dDurationMs: 500, segs: [{ utf8: "   " }] },
      ],
    });
    const segs = parseCaptions(json3(doc));
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 1, dur: 2, text: "Hello world" });
    expect(segs[1]).toEqual({ start: 3.5, dur: 1.5, text: "second line" });
  });

  it("defaults dDurationMs to 0 when absent", () => {
    const doc = JSON.stringify({
      events: [{ tStartMs: 2000, segs: [{ utf8: "no dur" }] }],
    });
    const segs = parseCaptions(json3(doc));
    expect(segs[0]).toEqual({ start: 2, dur: 0, text: "no dur" });
  });

  it("returns [] for a valid-but-empty doc", () => {
    expect(parseCaptions(json3("{}"))).toEqual([]);
    expect(parseCaptions(json3(JSON.stringify({ events: [] })))).toEqual([]);
  });

  it("throws on malformed json3", () => {
    expect(() => parseCaptions(json3("{not json"))).toThrow(/unparseable json3/);
  });

  it("throws when events is not an array", () => {
    expect(() => parseCaptions(json3(JSON.stringify({ events: "nope" })))).toThrow(
      /unparseable json3/,
    );
  });
});

describe("parseCaptions — vtt", () => {
  it("parses cue blocks with correct timing and strips inline tags", () => {
    const content = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:01.000 --> 00:00:03.000 align:start position:0%",
      "Hello <00:00:01.500><c> world</c>",
      "",
      "00:00:03.500 --> 00:00:05.000",
      "second line",
      "",
    ].join("\n");
    const segs = parseCaptions(vtt(content));
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 1, dur: 2, text: "Hello  world" });
    expect(segs[1]).toEqual({ start: 3.5, dur: 1.5, text: "second line" });
  });

  it("handles \\r\\n line endings", () => {
    const content =
      "WEBVTT\r\n\r\n00:00:00.000 --> 00:00:02.000\r\nhi there\r\n";
    const segs = parseCaptions(vtt(content));
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ start: 0, dur: 2, text: "hi there" });
  });

  it("returns [] for header-only vtt", () => {
    expect(parseCaptions(vtt("WEBVTT\n\n"))).toEqual([]);
  });
});

describe("parseCaptions — format guard", () => {
  it("throws on an unknown format", () => {
    const bad = { format: "srt", content: "", lang: "en", auto: false, videoId: "x" };
    // deliberately bypass the type to exercise the boundary guard
    expect(() => parseCaptions(bad as unknown as RawCaptions)).toThrow(/unknown captions format/);
  });
});

describe("segmentsToText", () => {
  const s = (start: number, text: string) => ({ start, dur: 1, text });

  it("returns '' for []", () => {
    expect(segmentsToText([])).toBe("");
  });

  it("collapses consecutive duplicate rolling lines", () => {
    const segs = [
      s(0, "the quick brown"),
      s(1, "the quick brown"), // rolling repeat
      s(2, "the quick brown fox"),
      s(3, "the quick brown fox"), // repeat
      s(4, "jumps over"),
    ];
    expect(segmentsToText(segs)).toBe(
      ["the quick brown", "the quick brown fox", "jumps over"].join("\n"),
    );
  });

  it("does NOT collapse a non-consecutive duplicate", () => {
    const segs = [s(0, "a"), s(1, "b"), s(2, "a")];
    expect(segmentsToText(segs)).toBe("a\nb\na");
  });

  it("prefixes [mm:ss] when timestamps option is set", () => {
    const segs = [s(5, "first"), s(125, "later")];
    expect(segmentsToText(segs, { timestamps: true })).toBe(
      "[00:05] first\n[02:05] later",
    );
  });

  it("skips empty/whitespace-only segment text", () => {
    const segs = [s(0, "real"), s(1, "   "), s(2, "more")];
    expect(segmentsToText(segs)).toBe("real\nmore");
  });
});
