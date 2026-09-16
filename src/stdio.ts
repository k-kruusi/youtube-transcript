/**
 * stdio transport entry point.
 *
 * Instead of a shared SSE server that consumers connect to over HTTP, this runs
 * as a subprocess of a single consumer. Communication is over stdin/stdout pipes
 * via the standard MCP stdio (JSON-RPC) transport — no HTTP, no connection setup.
 *
 * Usage:
 *   npx tsx src/stdio.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./server.js";

const server = new McpServer({ name: "youtube-transcript", version: "0.1.0" });
registerTools(server);

const transport = new StdioServerTransport();

await server.connect(transport);

// Keep alive until the parent process closes the pipe
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
