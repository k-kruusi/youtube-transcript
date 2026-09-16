/**
 * YoutubeTranscriptPanel — entry point.
 *
 * Runs inside a sandboxed <iframe> in the AgentRuntime dashboard. Communicates via
 * the postMessage fetch bridge (no direct network access). The dashboard's
 * panel-runtime creates <div id="panel-root"> in the srcdoc; we fall back to "root"
 * (standalone dev) then document.body.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { YoutubeTranscriptPanel } from "./YoutubeTranscriptPanel.js";

const root = document.getElementById("panel-root") || document.getElementById("root") || document.body;
createRoot(root).render(<YoutubeTranscriptPanel />);
