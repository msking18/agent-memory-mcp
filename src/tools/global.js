/**
 * @file src/tools/global.js
 * @description Global knowledge, dead-end reopening, and token audit MCP tool registrations (Tools 11–15).
 * Registers `save_global_knowledge`, `search_global_knowledge`, `promote_to_global`,
 * `reopen_dead_end`, and `get_token_metrics`.
 */

import { z } from "zod";
import {
    saveGlobalKnowledge,
    searchGlobalKnowledge,
    promoteToGlobal,
    reopenDeadEnd,
    getTokenMetrics
} from "../store/index.js";
import { executeTool, wrapHandler, READ_ONLY_ANNOTATIONS, WRITE_ANNOTATIONS } from "./common.js";

/**
 * Registers all global knowledge, dead-end reopening, and audit metrics tools (11–15) on an McpServer instance.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server - McpServer instance.
 */
export function registerGlobalTools(server) {
    // 11. save_global_knowledge
    server.registerTool(
        "save_global_knowledge",
        {
            title: "Save Global Architecture Pattern or Library Quirk",
            description:
                "Save or update a cross-project architecture pattern or library quirk into the centralized ~/.ag-memory-mcp/global.db.",
            inputSchema: {
                id: z.string().optional().describe("Optional ID (auto-prefixed with 'g-' if omitted)"),
                title: z.string().min(1).describe("Short descriptive title of pattern or quirk"),
                summary: z.string().min(1).describe("Detailed context, code snippet, or workaround"),
                category: z
                    .string()
                    .optional()
                    .default("pattern")
                    .describe("Category ('pattern', 'quirk', 'architecture', 'convention')"),
                tags: z.array(z.string()).optional().default([]).describe("Keyword tags"),
                tech_stack: z
                    .string()
                    .optional()
                    .default("general")
                    .describe("Tech stack identifier (e.g. 'nodejs', 'react', 'go', 'docker')"),
                source_project: z.string().optional().describe("Optional project where this pattern was validated")
            },
            annotations: WRITE_ANNOTATIONS
        },
        async (args) => {
            return executeTool("save_global_knowledge", args, () =>
                saveGlobalKnowledge(args)
            );
        }
    );

    // 12. search_global_knowledge
    server.registerTool(
        "search_global_knowledge",
        {
            title: "Search Global Knowledge Graph",
            description:
                "Search machine-wide patterns, library quirks, and cross-project invariants in ~/.ag-memory-mcp/global.db using BM25 ranking.",
            inputSchema: {
                query: z.string().optional().default("").describe("Keywords, library names, or error patterns"),
                category: z.string().optional().describe("Optional category filter"),
                tech_stack: z.string().optional().describe("Optional tech stack filter (e.g. 'nodejs', 'general')"),
                limit: z.number().int().min(1).max(30).optional().default(10)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args) => {
            return executeTool("search_global_knowledge", args, () =>
                searchGlobalKnowledge(args)
            );
        }
    );

    // 13. promote_to_global
    server.registerTool(
        "promote_to_global",
        {
            title: "Promote Project Memory to Global Graph",
            description:
                "Promote a proven project-specific memory node to the machine-wide global knowledge graph in ~/.ag-memory-mcp/global.db.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                memory_id: z.string().min(1).describe("Project memory node ID to promote"),
                tech_stack: z.string().optional().default("general").describe("Tech stack identifier (e.g. 'nextjs', 'fastapi')"),
                category: z.string().optional().describe("Optional category override (defaults to memory node category)")
            },
            annotations: WRITE_ANNOTATIONS
        },
        async (args) => {
            return executeTool("promote_to_global", args, () =>
                promoteToGlobal(args.project_path, args)
            );
        }
    );

    // 14. reopen_dead_end
    server.registerTool(
        "reopen_dead_end",
        {
            title: "Reopen Dead-End Record",
            description:
                "Reopen a previously recorded dead-end when external constraints, dependencies, or requirements change.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                id: z.string().min(1).describe("ID of the dead-end record to reopen"),
                reason: z.string().min(1).describe("Why this approach is now viable again")
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async (args) => {
            return executeTool("reopen_dead_end", args, () =>
                reopenDeadEnd(args.project_path, args)
            );
        }
    );

    // 15. get_token_metrics
    server.registerTool(
        "get_token_metrics",
        {
            title: "Get Token Efficiency & Audit Metrics",
            description:
                "Query machine-wide token savings, budgeting statistics, and audit logs from ~/.ag-memory-mcp/global.db.",
            inputSchema: {
                timeframe_hours: z
                    .number()
                    .int()
                    .min(1)
                    .max(720)
                    .optional()
                    .default(24)
                    .describe("Time window in hours (default 24)"),
                limit: z.number().int().min(1).max(100).optional().default(50).describe("Maximum recent audit logs to retrieve")
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args) => {
            return executeTool("get_token_metrics", args, () =>
                getTokenMetrics(args)
            );
        }
    );
}
