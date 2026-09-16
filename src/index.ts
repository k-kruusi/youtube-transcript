//
// SSE MCP server entry for the youtube-transcript cartridge + the human-facing boundary panel.
// Two intake doors, ONE pipeline (lib/fetch-transcript.ts):
//   - MCP tool get_transcript (by-reference / agent workflow node)        — server.ts
//   - bus event @agentruntime/youtube-transcript:fetch (the panel)        — here
// The panel POSTs :fetch via the supervisor /emit-event, then polls state/results/<cid>.json
// (served below). The agent only ever receives the CLEAN fenced transcript — never raw captions.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { EventSubscriber } from "@helmetfire-labs/cartridge-common";
import { registerTools } from "./server.js";
import { fetchTranscript } from "./lib/fetch-transcript.js";
import { writeRunning, writeDone, writeError } from "./lib/results.js";

const PORT = parseInt(process.env.PORT || "3096", 10);
const CARTRIDGE_DIR = process.cwd();
const STATE_DIR = resolve(CARTRIDGE_DIR, process.env.STATE_DIR || "state");
const RESULTS_DIR = resolve(STATE_DIR, "results");
const PANEL_PATH = resolve(CARTRIDGE_DIR, "dist/panel.js");

const sseTransports = new Map<string, SSEServerTransport>();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "youtube-transcript", version: "0.1.0" });
  registerTools(server);
  return server;
}

async function parseBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read the panel bundle fresh from disk each request — no stale in-memory cache. */
function readPanelBundle(): string | null {
  try {
    return existsSync(PANEL_PATH) ? readFileSync(PANEL_PATH, "utf-8") : null;
  } catch {
    return null;
  }
}

/**
 * Emit a structured bus line the supervisor's container.ts parser extracts into
 * eventData. key=value (NOT JSON) — a JSON payload parses to nothing (see quarantine's
 * emitSignal note). Carries only routing/status fields.
 */
function emitSignal(type: string, fields: Record<string, unknown>): void {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) =>
      typeof v === "number" || typeof v === "boolean" ? `${k}=${v}` : `${k}=${JSON.stringify(String(v))}`,
    )
    .join(", ");
  console.log(`[@agentruntime/youtube-transcript:${type}] ${kv}`);
}

/**
 * Handle one @agentruntime/youtube-transcript:fetch event end-to-end. Writes the {running}
 * marker first (so the panel shows progress), drives the shared fetchTranscript pipeline,
 * then writes {done}/{error} and emits a terminal :fetched. Catches its own errors so a
 * throw never leaves a dangling {running} the panel can't resolve (Honest-Response).
 */
async function handleFetch(event: Record<string, unknown>): Promise<void> {
  const correlationId = String(event._correlationId ?? "").trim();
  if (!correlationId) {
    // Without a correlationId we have nowhere to write the result the panel polls —
    // surface it loud rather than silently drop the request.
    console.warn("[youtube-transcript] ignoring youtube-transcript:fetch with no _correlationId");
    return;
  }

  const url = typeof event.url === "string" ? event.url : "";
  const lang = typeof event.lang === "string" && event.lang.trim() ? event.lang.trim() : undefined;
  const timestamps = event.timestamps === true || event.timestamps === "true";
  // Fence ON by default; an explicit false (or "false") opts out. The panel sends the
  // fenced text to chat, so it normally leaves fence at its default.
  const fence = !(event.fence === false || event.fence === "false");

  // Mark running BEFORE any heavy work so the panel can show "fetching…" immediately.
  try {
    writeRunning(RESULTS_DIR, correlationId, url || undefined);
  } catch (err) {
    // If we can't even write the marker, the panel will poll a 404 forever — log it.
    console.error(
      `[youtube-transcript] could not write running marker for ${correlationId}: ${(err as Error).message}`,
    );
  }
  emitSignal("progress", { _correlationId: correlationId, stage: "fetching" });

  // Empty url is a no-op error — refuse rather than spin yt-dlp on nothing.
  if (url.trim() === "") {
    const error = "invalid_youtube_url: empty url — nothing to fetch";
    try { writeError(RESULTS_DIR, correlationId, error); } catch { /* logged below */ }
    emitSignal("fetched", { _correlationId: correlationId, ok: false, error });
    return;
  }

  try {
    const result = await fetchTranscript(url, { lang, timestamps, fence });
    if (result.ok) {
      writeDone(RESULTS_DIR, correlationId, result.text, result.fenced, result.flags);
      emitSignal("fetched", {
        _correlationId: correlationId,
        ok: true,
        lang: result.flags.lang,
        auto: result.flags.auto,
        forgeries: result.flags.forgeries,
        sanitizedRemoved: result.flags.sanitizedRemoved,
      });
    } else {
      writeError(RESULTS_DIR, correlationId, result.error);
      emitSignal("fetched", { _correlationId: correlationId, ok: false, error: result.error });
    }
  } catch (err) {
    // fetchTranscript already catches its own errors, but guard the write/emit path too —
    // an fs failure here must still leave an {error} file, not a dangling {running}.
    const error = `transcript_failed: ${err instanceof Error ? err.message : String(err)}`;
    try { writeError(RESULTS_DIR, correlationId, error); } catch (e2) {
      console.error(`[youtube-transcript] failed to write error file for ${correlationId}: ${(e2 as Error).message}`);
    }
    emitSignal("fetched", { _correlationId: correlationId, ok: false, error });
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/mcp") {
      const mcpServer = createMcpServer();
      const transport = new SSEServerTransport("/mcp/messages", res);

      sseTransports.set(transport.sessionId, transport);
      console.log(`[mcp] SSE session connected: ${transport.sessionId}`);

      res.on("close", () => {
        sseTransports.delete(transport.sessionId);
        console.log(`[mcp] SSE session disconnected: ${transport.sessionId}`);
      });

      await mcpServer.connect(transport);
      return;
    }

    if (req.method === "POST" && path === "/mcp/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        json(res, 400, { error: "Missing sessionId" });
        return;
      }
      const transport = sseTransports.get(sessionId);
      if (!transport) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      const body = await parseBody(req);
      await transport.handlePostMessage(req, res, body);
      return;
    }

    // ── Panel bundle (the URL→player→transcript UI) ─────────────────────────
    if (req.method === "GET" && path === "/_panel") {
      const bundle = readPanelBundle();
      if (!bundle) {
        // Honest-Response: a clear, actionable error, not an empty 200.
        json(res, 503, { error: "Panel not built. Run: node panel.build.js" });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end(bundle);
      return;
    }

    // ── State files (the panel polls state/results/<cid>.json) ──────────────
    // Serve from STATE_DIR only; guard traversal — the resolved path must stay under it.
    if (req.method === "GET" && path.startsWith("/state/")) {
      const rel = path.slice("/state/".length);
      const abs = resolve(STATE_DIR, rel);
      const root = STATE_DIR.endsWith(sep) ? STATE_DIR : STATE_DIR + sep;
      if (abs !== STATE_DIR && !abs.startsWith(root)) {
        json(res, 403, { error: "Forbidden" });
        return;
      }
      if (!existsSync(abs)) {
        json(res, 404, { error: "Not found" });
        return;
      }
      const isJson = abs.endsWith(".json");
      res.writeHead(200, { "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8" });
      res.end(readFileSync(abs, "utf-8"));
      return;
    }

    if (req.method === "GET" && path === "/health") {
      json(res, 200, { status: "ok", sessions: sseTransports.size });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[server] Error handling request:", err);
    if (!res.headersSent) {
      json(res, 500, { error: "Internal server error" });
    }
  }
});

// ── Bus intake (the panel's fetch requests ride this) ─────────────────────────
// OBSERVES @agentruntime/youtube-transcript:fetch; its own outputs are :progress / :fetched
// (different tags), so there's no self-loop. Same pipeline (fetchTranscript) as the MCP tool.
const subscriber = new EventSubscriber({
  supervisorUrl: process.env.SUPERVISOR_URL || "http://127.0.0.1:39827",
  name: "youtube-transcript",
  observes: ["@agentruntime/youtube-transcript:fetch"],
});
// Serialize fetch jobs onto a chain: each yt-dlp run spawns a subprocess and two concurrent
// runs would contend; the panel is interactive (one job at a time in practice), so a simple
// queue is the honest behavior.
let fetchChain: Promise<void> = Promise.resolve();
subscriber.subscribe((event) => {
  const tag = event.cartridgeEvent as string | undefined;
  if (tag !== "@agentruntime/youtube-transcript:fetch") return;
  fetchChain = fetchChain.then(() => handleFetch(event as Record<string, unknown>));
});

server.listen(PORT, () => {
  console.log(`[youtube-transcript] MCP SSE server listening on port ${PORT}`);
  console.log(`[youtube-transcript] Panel: http://localhost:${PORT}/_panel`);
  console.log(`[youtube-transcript] Bus intake: observing @agentruntime/youtube-transcript:fetch`);
});

function shutdown() {
  console.log("[youtube-transcript] Shutting down...");
  subscriber.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
