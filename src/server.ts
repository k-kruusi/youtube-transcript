import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetTranscript } from "./tools/get-transcript.js";

export function registerTools(server: McpServer): void {
  registerGetTranscript(server);
}
