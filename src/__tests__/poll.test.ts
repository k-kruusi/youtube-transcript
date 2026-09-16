import { describe, it, expect } from "vitest";
import { newCorrelationId, interpretResult, summarizeFlags, extractVideoId } from "../panel/poll.js";
import type { TranscriptFlags } from "../lib/fetch-transcript.js";

function flags(over: Partial<TranscriptFlags> = {}): TranscriptFlags {
  return {
    lang: "en",
    auto: false,
    sanitizedRemoved: 0,
    sanitizedKinds: [],
    forgeries: 0,
    truncated: false,
    ...over,
  };
}

describe("newCorrelationId", () => {
  it("is non-empty and contains only [A-Za-z0-9_-]", () => {
    const cid = newCorrelationId();
    expect(cid.length).toBeGreaterThan(0);
    expect(cid).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("interpretResult", () => {
  it("treats null / non-object (pre-write 404) as still running", () => {
    expect(interpretResult(null).kind).toBe("running");
    expect(interpretResult(undefined).kind).toBe("running");
    expect(interpretResult("not json").kind).toBe("running");
  });

  it("maps status:running", () => {
    expect(interpretResult({ status: "running" }).kind).toBe("running");
  });

  it("maps status:error with the message", () => {
    const r = interpretResult({ status: "error", error: "no captions available" });
    expect(r).toEqual({ kind: "error", error: "no captions available" });
  });

  it("maps status:done with text, fenced, and flags", () => {
    const r = interpretResult({
      status: "done",
      text: "raw",
      fenced: "<fenced>",
      flags: { lang: "en", auto: true, sanitizedRemoved: 1, sanitizedKinds: ["bidi-override"], forgeries: 0, truncated: false },
    });
    expect(r.kind).toBe("done");
    if (r.kind === "done") {
      expect(r.text).toBe("raw");
      expect(r.fenced).toBe("<fenced>");
      expect(r.flags.auto).toBe(true);
      expect(r.flags.sanitizedKinds).toContain("bidi-override");
    }
  });

  it("done without fenced is malformed (not a crash)", () => {
    expect(interpretResult({ status: "done" }).kind).toBe("malformed");
  });

  it("unknown status is malformed", () => {
    expect(interpretResult({ status: "weird" }).kind).toBe("malformed");
  });
});

describe("summarizeFlags", () => {
  it("flags auto-captions as lossy", () => {
    expect(summarizeFlags(flags({ auto: true }))).toMatch(/auto-captions/);
  });
  it("notes creator captions when not auto", () => {
    expect(summarizeFlags(flags({ auto: false }))).toMatch(/creator captions/);
  });
  it("surfaces forgeries and stripped chars", () => {
    const s = summarizeFlags(flags({ forgeries: 1, sanitizedRemoved: 2, sanitizedKinds: ["zero-width-space"] }));
    expect(s).toMatch(/1 boundary-forgery/);
    expect(s).toMatch(/2 hidden characters stripped/);
    expect(s).toContain("zero-width-space");
  });
});

describe("extractVideoId", () => {
  it("watch URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("youtu.be short link", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("shorts URL", () => {
    expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("embed URL", () => {
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("rejects a non-YouTube host", () => {
    expect(extractVideoId("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
  it("rejects a malformed id", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=tooshort")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(extractVideoId("not a url")).toBeNull();
    expect(extractVideoId("")).toBeNull();
  });
});
