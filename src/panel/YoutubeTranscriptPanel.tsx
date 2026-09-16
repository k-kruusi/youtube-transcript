/**
 * YoutubeTranscriptPanel — the URL→player→transcript boundary, rendered for Kevin.
 *
 * This panel IS the boundary (quarantine-boundary-and-panels.md): the untrusted
 * transcript enters HERE, not the chat. The human pastes a YouTube URL, clicks Fetch,
 * the cartridge pulls captions directly via yt-dlp, sanitizes + fences them, and only
 * the CLEAN fenced transcript is ever sent to chat. The agent receives clean text and
 * never sees the raw captions.
 *
 * Data flow:
 *   Fetch  → POST {parent}/api/emit-event {tag:"@agentruntime/youtube-transcript:fetch", …}
 *            (rides the supervisor bus → the cartridge's EventSubscriber → fetchTranscript)
 *   poll   → panelFetch("state/results/<cid>.json")  (relative; bridged to the cartridge)
 *   Send   → POST {parent}/api/send  {message: fenced}  (clean text → the conversation)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { panelFetch } from "./utils.js";
import { newCorrelationId, interpretResult, summarizeFlags, extractVideoId, type PanelOutcome } from "./poll.js";
import type { TranscriptFlags } from "../lib/fetch-transcript.js";

const PARENT_ORIGIN = (globalThis as any).__PARENT_ORIGIN__ as string | undefined;
const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000; // a cold yt-dlp fetch (two passes + title) can take a while

// ── clipboard (sandbox-safe, mirrors QuarantinePanel) ────────────────────────
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

// ── flags badge ──────────────────────────────────────────────────────────────
function FlagsLine({ flags }: { flags: TranscriptFlags }) {
  const dirty = flags.forgeries > 0 || flags.sanitizedRemoved > 0 || flags.auto;
  return (
    <div
      style={{
        marginTop: "10px",
        fontSize: "11px",
        color: dirty ? "#fbbf24" : "#52525b",
        lineHeight: 1.5,
      }}
    >
      {dirty ? "⚠ " : "✓ "}
      {summarizeFlags(flags)}
    </div>
  );
}

const btnBase: React.CSSProperties = {
  fontSize: "12px",
  padding: "7px 14px",
  borderRadius: "6px",
  cursor: "pointer",
  border: "1px solid #3f3f46",
  background: "transparent",
  color: "#d4d4d8",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

export function YoutubeTranscriptPanel() {
  const [url, setUrl] = useState("");
  const [lang, setLang] = useState("");
  const [timestamps, setTimestamps] = useState(false);
  const [phase, setPhase] = useState<"idle" | "fetching" | "done" | "error">("idle");
  const [outcome, setOutcome] = useState<PanelOutcome | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  // Abort an in-flight poll loop if the user starts a new fetch / unmounts.
  const pollAbort = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => { if (pollAbort.current) pollAbort.current.cancelled = true; }, []);

  const canBridge = !!PARENT_ORIGIN;

  const fenced = outcome?.kind === "done" ? outcome.fenced : "";

  // Live preview of the player as soon as a valid id is present in the URL field.
  const videoId = useMemo(() => extractVideoId(url), [url]);

  const startFetch = useCallback(async () => {
    if (!url.trim()) {
      setNotice("Paste a YouTube URL first.");
      return;
    }
    if (!canBridge) {
      setNotice("No dashboard bridge — open this panel inside the AgentRuntime dashboard to fetch.");
      return;
    }
    // Reset any prior run.
    if (pollAbort.current) pollAbort.current.cancelled = true;
    const token = { cancelled: false };
    pollAbort.current = token;
    setNotice("");
    setCopied(false);
    setSent(false);
    setOutcome(null);
    setPhase("fetching");

    const cid = newCorrelationId();

    // 1. Fire the fetch request onto the bus via the supervisor.
    try {
      await panelFetch(`${PARENT_ORIGIN}/api/emit-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag: "@agentruntime/youtube-transcript:fetch",
          caller: "youtube-transcript-panel",
          payload: {
            url: url.trim(),
            lang: lang.trim() || undefined,
            timestamps: timestamps || undefined,
            _correlationId: cid,
          },
        }),
      });
    } catch (err) {
      if (token.cancelled) return;
      setPhase("error");
      setOutcome({ kind: "error", error: `Could not submit to the bus: ${(err as Error).message}` });
      return;
    }

    // 2. Poll the results file the cartridge writes for this cid.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (!token.cancelled) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (token.cancelled) return;

      let raw: unknown = null;
      try {
        const res = await panelFetch(`state/results/${cid}.json`);
        if (res.ok) {
          raw = await res.json();
        } else if (res.status !== 404) {
          raw = null; // non-404 error worth surfacing, but keep polling (transient)
        }
      } catch {
        raw = null; // transient bridge hiccup — keep polling
      }

      const next = interpretResult(raw);
      if (next.kind === "running") {
        if (Date.now() > deadline) {
          setPhase("error");
          setOutcome({ kind: "error", error: "Timed out waiting for the transcript (>2 min). yt-dlp may still be running; check the cartridge logs." });
          return;
        }
        continue; // keep polling
      }
      // Terminal: done / error / malformed.
      setOutcome(next);
      setPhase(next.kind === "done" ? "done" : "error");
      return;
    }
  }, [url, lang, timestamps, canBridge]);

  const onCopy = useCallback(async () => {
    const ok = await copyToClipboard(fenced);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1600);
    else setNotice("Couldn't write to the clipboard.");
  }, [fenced]);

  const onSend = useCallback(async () => {
    if (!canBridge) {
      setNotice("No dashboard bridge — can't send to chat from a standalone panel.");
      return;
    }
    try {
      const res = await panelFetch(`${PARENT_ORIGIN}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: fenced }),
      });
      if (!res.ok) {
        setNotice(`Send failed: HTTP ${res.status}`);
        return;
      }
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    } catch (err) {
      setNotice(`Send failed: ${(err as Error).message}`);
    }
  }, [fenced, canBridge]);

  return (
    <div
      style={{
        padding: "16px",
        maxWidth: "760px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#e4e4e7",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
        <span style={{ fontSize: "18px" }}>{"\u{1F4FA}"}</span>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: "14px", fontWeight: 600, color: "#f4f4f5", margin: 0 }}>YouTube Transcript</h2>
          <p style={{ fontSize: "11px", color: "#52525b", margin: "2px 0 0" }}>
            Paste a YouTube URL → captions fetched directly via yt-dlp, sanitized + fenced → send only the clean text to chat.
          </p>
        </div>
      </div>

      {!canBridge && (
        <div
          style={{
            fontSize: "11px",
            color: "#fca5a5",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "6px",
            padding: "8px 10px",
            marginBottom: "12px",
          }}
        >
          No dashboard bridge detected — Fetch / Send are disabled. Open this panel inside the AgentRuntime dashboard.
        </div>
      )}

      {/* URL input */}
      <label style={{ display: "block", fontSize: "11px", color: "#71717a", marginBottom: "5px" }}>
        YouTube URL
      </label>
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=…  (or youtu.be/…, /shorts/…)"
        spellCheck={false}
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "12px",
          color: "#e4e4e7",
          background: "#09090b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "10px 12px",
        }}
      />

      {/* Player preview (appears as soon as a valid id is in the URL) */}
      {videoId && (
        <div style={{ marginTop: "12px", position: "relative", paddingBottom: "56.25%", height: 0, overflow: "hidden", borderRadius: "8px", border: "1px solid #27272a" }}>
          <iframe
            title="YouTube player"
            src={`https://www.youtube-nocookie.com/embed/${videoId}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: 0 }}
          />
        </div>
      )}

      {/* Options row */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "10px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <label style={{ fontSize: "11px", color: "#71717a", marginBottom: "4px" }}>
            Language <span style={{ color: "#3f3f46" }}>(optional)</span>
          </label>
          <input
            type="text"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            placeholder="en"
            spellCheck={false}
            style={{
              width: "80px",
              boxSizing: "border-box",
              fontFamily: "ui-monospace, monospace",
              fontSize: "12px",
              color: "#e4e4e7",
              background: "#09090b",
              border: "1px solid #27272a",
              borderRadius: "6px",
              padding: "6px 8px",
            }}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#a1a1aa", marginTop: "16px", cursor: "pointer" }}>
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          Timestamps
        </label>
      </div>

      {/* Fetch button */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
        <button
          onClick={startFetch}
          disabled={phase === "fetching" || !canBridge}
          title={!canBridge ? "Open in the dashboard to fetch" : "Fetch + sanitize + fence the transcript"}
          style={{
            ...btnBase,
            border: `1px solid ${phase === "fetching" ? "#3f3f46" : "rgba(16,185,129,0.5)"}`,
            background: phase === "fetching" ? "transparent" : "rgba(16,185,129,0.12)",
            color: phase === "fetching" ? "#71717a" : "#34d399",
            cursor: phase === "fetching" || !canBridge ? "not-allowed" : "pointer",
            opacity: !canBridge ? 0.6 : 1,
          }}
        >
          {phase === "fetching" ? "Fetching…" : "Fetch transcript"}
        </button>
        {phase === "fetching" && (
          <span style={{ fontSize: "11px", color: "#71717a" }}>
            Pulling captions via yt-dlp…
          </span>
        )}
      </div>

      {/* Notice (non-fatal) */}
      {notice && (
        <div style={{ marginTop: "10px", fontSize: "11px", color: "#fca5a5" }}>{notice}</div>
      )}

      {/* Result */}
      {outcome?.kind === "error" && (
        <div
          style={{
            marginTop: "14px",
            fontSize: "12px",
            color: "#fca5a5",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "8px",
            padding: "10px 12px",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {outcome.error}
        </div>
      )}

      {outcome?.kind === "malformed" && (
        <div style={{ marginTop: "14px", fontSize: "12px", color: "#fca5a5" }}>
          The result file was unreadable: {outcome.detail}
        </div>
      )}

      {outcome?.kind === "done" && (
        <div style={{ marginTop: "16px" }}>
          <div
            style={{
              fontSize: "10px",
              color: "#52525b",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: "6px",
            }}
          >
            Transcript (fenced, untrusted-data)
          </div>
          <pre
            style={{
              margin: 0,
              maxHeight: "320px",
              overflow: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "11.5px",
              lineHeight: 1.55,
              color: "#d4d4d8",
              background: "#09090b",
              border: "1px solid #27272a",
              borderRadius: "8px",
              padding: "12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {outcome.fenced}
          </pre>

          <FlagsLine flags={outcome.flags} />

          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
            <button
              onClick={onCopy}
              style={{
                ...btnBase,
                border: `1px solid ${copied ? "rgba(16,185,129,0.5)" : "#3f3f46"}`,
                color: copied ? "#34d399" : "#d4d4d8",
              }}
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
            <button
              onClick={onSend}
              disabled={!canBridge}
              title={canBridge ? "Inject the clean fenced transcript into the active conversation" : "Open in the dashboard to send to chat"}
              style={{
                ...btnBase,
                border: `1px solid ${sent ? "rgba(16,185,129,0.5)" : "rgba(59,130,246,0.5)"}`,
                background: sent ? "rgba(16,185,129,0.12)" : "rgba(59,130,246,0.12)",
                color: sent ? "#34d399" : "#93c5fd",
                cursor: canBridge ? "pointer" : "not-allowed",
                opacity: canBridge ? 1 : 0.6,
              }}
            >
              {sent ? "✓ Sent to chat" : "Send to chat"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default YoutubeTranscriptPanel;
