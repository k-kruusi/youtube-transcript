import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchTranscript } from "../lib/fetch-transcript.js";

/** Shape every honest failure identically: one text block, isError true. */
function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerGetTranscript(server: McpServer): void {
  server.tool(
    "get_transcript",
    "Fetch a YouTube video's captions directly from YouTube (no third-party transcript site in your trust chain), strip invisible/unicode-trick characters, and return the transcript wrapped in an explicit untrusted-data fence with provenance (source, language, auto-generated flag, sanitize report). Returns a clear error if the URL is not YouTube, the video has no captions, or the captions cannot be parsed.",
    {
      url: z.string().describe("YouTube video URL or share link"),
      lang: z
        .string()
        .optional()
        .describe("Preferred caption language code (e.g. 'en'). Falls back to the best available."),
      timestamps: z.boolean().optional().describe("If true, prefix each line with its start time."),
      fence: z
        .boolean()
        .optional()
        .describe(
          "Wrap the untrusted transcript in an injection-defense fence (default: true). Set false to return the raw sanitized transcript with no fence.",
        ),
    },
    async ({ url, lang, timestamps, fence }) => {
      // Delegate to the single shared pipeline. fence is ON by default — the transcript is
      // attacker-controllable third-party text, framed as DATA unless the caller opts out.
      const result = await fetchTranscript(url, { lang, timestamps, fence });
      if (!result.ok) {
        return errorResult(result.error);
      }
      return { content: [{ type: "text" as const, text: result.fenced }] };
    },
  );
}
