/**
 * @file src/tools/dead-ends.js
 * @description Project-scoped anti-loop dead-end MCP tool registrations (Tools 8–9).
 * Registers `record_dead_end` and `check_dead_ends`.
 */

import { z } from "zod";
import {
    recordDeadEnd,
    checkDeadEnds
} from "../store/index.js";
import {
    executeTool,
    READ_ONLY_ANNOTATIONS,
    WRITE_ANNOTATIONS
} from "./common.js";

/**
 * Registers project-scoped anti-loop dead-end tools (8–9) on an McpServer instance.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server - McpServer instance.
 */
export function registerDeadEndTools(server) {
    // 8. record_dead_end
    server.registerTool(
        "record_dead_end",
        {
            title: "Record Anti-Loop Dead-End or Architectural Constraint",
            description:
                "Record a failed debugging attempt or intentional architectural constraint so future turns and sessions never repeat the same dead-end.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe("Absolute path to the project workspace root or remote workspace URI"),
                error_pattern: z
                    .string()
                    .min(1)
                    .describe("Compiler error, test failure, or symptom encountered"),
                attempted_solution: z
                    .string()
                    .min(1)
                    .describe("What fix or approach was tried and failed"),
                root_cause: z
                    .string()
                    .min(1)
                    .describe("Why the approach failed or constraint discovered"),
                files: z
                    .array(z.string())
                    .optional()
                    .default([])
                    .describe("Workspace-relative file paths or '@<folderSlug>/' linked-folder anchors involved"),
                kind: z
                    .enum(["error_loop", "architectural"])
                    .optional()
                    .default("error_loop")
                    .describe("Taxonomy kind: 'error_loop' for code/test bug, 'architectural' for intentional trade-off / rejected approach"),
                constraints: z
                    .array(z.string())
                    .optional()
                    .default([])
                    .describe("Active constraints or invariants that forbid this approach"),
                allow_external_files: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Explicit user-approved override allowing file paths outside project_path (cross-folder write guardrail)"
                    )
            },
            annotations: WRITE_ANNOTATIONS
        },
        async (args) => {
            return executeTool("record_dead_end", args, () =>
                recordDeadEnd(args.project_path, args)
            );
        }
    );

    // 9. check_dead_ends
    server.registerTool(
        "check_dead_ends",
        {
            title: "Check Recorded Dead-Ends",
            description:
                "Check the anti-loop dead-end registry by error text, keyword, or file path before attempting fixes.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe("Absolute path to the project workspace root or remote workspace URI"),
                query: z
                    .string()
                    .optional()
                    .describe("Error message, symptom, or keyword to match"),
                file_path: z.string().optional().describe("Optional workspace or linked-folder file path to match"),
                limit: z.number().int().min(1).max(25).optional().default(10),
                kind: z
                    .enum(["all", "error_loop", "architectural"])
                    .optional()
                    .default("all")
                    .describe("Filter by dead-end kind ('all', 'error_loop', 'architectural')")
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args) => {
            return executeTool("check_dead_ends", args, () =>
                checkDeadEnds(args.project_path, args)
            );
        }
    );
}
