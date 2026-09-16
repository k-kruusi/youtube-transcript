import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { safeCid, resultPath, writeRunning, writeDone, writeError } from "../lib/results.js";
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

describe("results store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-results-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("safeCid keeps only [A-Za-z0-9_-] and falls back to 'unknown'", () => {
    expect(safeCid("abc-123_XYZ")).toBe("abc-123_XYZ");
    expect(safeCid("../../etc/passwd")).toBe("etcpasswd");
    expect(safeCid("!!!")).toBe("unknown");
  });

  it("resultPath stays under resultsDir even for a hostile cid", () => {
    const p = resultPath(dir, "../../escape");
    const root = dir.endsWith(sep) ? dir : dir + sep;
    expect(p.startsWith(root)).toBe(true);
    expect(p).toBe(resolve(dir, "escape.json"));
  });

  it("writeRunning lands {status:running}", () => {
    const p = writeRunning(dir, "cid1", "https://youtu.be/dQw4w9WgXcQ");
    const obj = JSON.parse(readFileSync(p, "utf-8"));
    expect(obj.status).toBe("running");
    expect(obj.correlationId).toBe("cid1");
    expect(obj.url).toContain("youtu.be");
    expect(typeof obj.startedAt).toBe("number");
  });

  it("writeDone lands {status:done} with text, fenced, and flags", () => {
    const p = writeDone(dir, "cid2", "raw text", "<fenced>", flags({ auto: true, forgeries: 2 }));
    const obj = JSON.parse(readFileSync(p, "utf-8"));
    expect(obj.status).toBe("done");
    expect(obj.text).toBe("raw text");
    expect(obj.fenced).toBe("<fenced>");
    expect(obj.flags.auto).toBe(true);
    expect(obj.flags.forgeries).toBe(2);
  });

  it("writeError lands {status:error} with the message (never blank)", () => {
    const p = writeError(dir, "cid3", "no captions available");
    const obj = JSON.parse(readFileSync(p, "utf-8"));
    expect(obj.status).toBe("error");
    expect(obj.error).toBe("no captions available");
  });

  it("creates resultsDir if missing", () => {
    const nested = join(dir, "deep", "results");
    expect(existsSync(nested)).toBe(false);
    writeRunning(nested, "cid4");
    expect(existsSync(nested)).toBe(true);
  });
});
