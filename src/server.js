/**
 * @file src/server.js
 * @description MCP stdio JSON-RPC server bootstrap for agent-memory-mcp.
 * Registers the 16 MCP tools, exposes the memory://projects resource, and handles
 * graceful process lifecycle shutdown.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readProjectsIndex } from "./paths.js";
import { closeAllDatabases } from "./db.js";
import { registerAllTools } from "./tools.js";

const SERVER_INSTRUCTIONS = `agent-memory-mcp (v3.3) provides persistent per-project memory, centralized global knowledge graph (global.db), dead-end taxonomy, multi-folder workspace policies, remote/git-aware project identity, and machine-wide token budget guardrails.
- Pass an absolute workspace directory path or remote workspace URI (vscode-remote://, ssh://, wsl://, devcontainer://, remote://, or \\\\wsl.localhost\\...) as project_path (never "./").
- Skip memory tool calls when no active project workspace is open.
- check_memory_status hydrates status, core architecture index, dead-end warnings, and recent timeline in a single call. For uninitialized remote workspaces ([AGENT-MEMORY REMOTE WORKSPACE]), inspect git origin and re-run check_memory_status with git_remote before bootstrapping.
- Multi-folder workspaces: never silently bootstrap or guess secondary folder roles. Ask the user to choose 'independent', 'linked', or 'ignored' and persist via configure_workspace(action: "set_folder_policy", ...). For 'linked' folders, always pass the primary workspace path as project_path.
- Cross-folder & clone guardrails: when save_project_memory, update_memory_node, or record_dead_end hits the cross-folder write guardrail, or when SessionStart/check_memory_status flags [AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED], ask the user before passing allow_external_files: true, force_isolate: true, or calling configure_workspace.
- Before modifying shared utilities or hooks, call get_file_memories for those paths.
- Before retrying a compiler/test error, call check_dead_ends; record failed fixes via record_dead_end (error_loop or architectural).
- Search cross-project patterns via search_global_knowledge, promote reusable solutions via promote_to_global.`;

/**
 * Creates a configured McpServer instance with all 16 v3.3 tools and resources.
 */
export function createMcpServer() {
    const server = new McpServer(
        { name: "agent-memory-mcp", version: "3.3.0" },
        { instructions: SERVER_INSTRUCTIONS }
    );

    // MCP Resource: Central index of tracked projects
    server.registerResource(
        "projects",
        "memory://projects",
        {
            title: "Tracked Project Memory Stores",
            description: "JSON v4 registry of all workspaces and multi-folder policies managed by agent-memory-mcp v3.3",
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

    // Register all 16 tools
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
    console.error("agent-memory-mcp v3.3.0 (SQLite + FTS5) running on stdio");
    return server;
}
