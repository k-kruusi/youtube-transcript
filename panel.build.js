/**
 * Build the youtube-transcript boundary panel UI bundle.
 *
 * scent:
 *   - agent: opus-ytfence
 *     did: "copied quarantine's panel.build.js (shared runPanelBuild from dependencies/panel-build.js),
 *           swapped name/globalName for youtube-transcript. Produces dist/panel.js (IIFE, React
 *           bundled in) served by src/index.ts at /_panel. Cites packages/quarantine/panel.build.js."
 *     at: 2026-06-16T12:00:00-04:00
 *
 * Dual-environment architecture (see dependencies/panel-build.js):
 *   1. Node.js MCP server  (src/index.ts) — serves the panel bundle from dist/panel.js
 *   2. Browser panel       (src/panel/index.tsx) — sandboxed iframe, React 19, bundled inline
 *
 * Usage:
 *   node panel.build.js            # one-shot production build
 *   node panel.build.js --watch    # incremental watch mode (for dev)
 */
import esbuild from "esbuild";
import { runPanelBuild } from "../../dependencies/panel-build.js";

const watchMode = process.argv.includes("--watch");

await runPanelBuild(esbuild, watchMode, "youtube-transcript", {
  entryPoints: ["src/panel/index.tsx"],
  globalName: "__youtubeTranscriptPanel__",
  outfile: "dist/panel.js",
  banner: { js: "/* YoutubeTranscriptPanel — sandboxed iframe bundle */\n" },
});
