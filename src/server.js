/**
 * @file src/server.js
 * @description MCP stdio JSON-RPC server bootstrap for agent-memory-mcp.
 * Registers the 15 MCP tools, exposes the memory://projects resource, and handles
 * graceful process lifecycle shutdown.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readProjectsIndex } from "./paths.js";
import { closeAllDatabases } from "./db.js";
import { registerAllTools } from "./tools.js";

const SERVER_INSTRUCTIONS = `agent-memory-mcp (v3.1) provides persistent per-project memory, centralized global knowledge graph (global.db), dead-end taxonomy, and machine-wide token budget guardrails.
- Always pass an absolute workspace directory path as project_path (never "./").
- Skip memory tool calls when no active project workspace is open.
- check_memory_status hydrates status, core architecture index, dead-end warnings, and recent timeline in a single call.
- Before modifying shared utilities or hooks, call get_file_memories for those paths.
- Before retrying a compiler/test error, call check_dead_ends; record failed fixes via record_dead_end (error_loop or architectural).
- Search cross-project patterns via search_global_knowledge, promote reusable solutions via promote_to_global.`;

/**
 * Creates a configured McpServer instance with all 15 v3.1 tools and resources.
 */
export function createMcpServer() {
    const server = new McpServer(
        { name: "agent-memory-mcp", version: "3.1.0" },
        { instructions: SERVER_INSTRUCTIONS }
    );

    // MCP Resource: Central index of tracked projects
    server.registerResource(
        "projects",
        "memory://projects",
        {
            title: "Tracked Project Memory Stores",
            description: "JSON registry of all workspaces managed by agent-memory-mcp v3.1",
            mimeType: "application/json"
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    mimeType: "application/json",
                    text: JSON.stringify(readProjectsIndex(), null, 2)
                }
            ]
        })
    );

    // Register all 15 tools
    registerAllTools(server);

    return server;
}

export async function startStdioServer() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();

    const shutdown = async () => {
        closeAllDatabases();
        try {
            await server.close();
        } catch {
            // Ignore close errors during exit
        }
        process.exit(0);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("exit", () => closeAllDatabases());

    await server.connect(transport);
    console.error("agent-memory-mcp v3.1.0 (SQLite + FTS5) running on stdio");
    return server;
}
