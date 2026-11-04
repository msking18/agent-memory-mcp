/**
 * @file src/tools/project.js
 * @description Project-scoped MCP tool registrations (Tools 1–10).
 * Registers context status, timeline, atomic memory saves, FTS5 search, CRUD,
 * file-anchored memories, and two-tier anti-loop dead-ends.
 */

import { z } from "zod";
import {
    checkMemoryStatus,
    getSessionTimeline,
    saveProjectMemory,
    searchProjectMemory,
    readMemoryNode,
    updateMemoryNode,
    deleteMemoryNode,
    recordDeadEnd,
    checkDeadEnds,
    getFileMemories
} from "../store/index.js";
import {
    wrapHandler,
    READ_ONLY_ANNOTATIONS,
    WRITE_ANNOTATIONS,
    CategoryEnum,
    BatchEntrySchema
} from "./common.js";

/**
 * Registers all project-scoped tools (1–10) on an McpServer instance.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server - McpServer instance.
 */
export function registerProjectTools(server) {
    // 1. check_memory_status
    server.registerTool(
        "check_memory_status",
        {
            title: "Check Memory Status & Hydrate Context",
            description:
                "Check if project memory is initialized and retrieve core architecture index, dead-end count, and recent session timeline in one call. Auto-migrates legacy .ag-memory.json if present.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe("Absolute path to the project workspace root directory"),
                include_timeline: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Include recent session logs in the response (default true)"),
                timeline_limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(25)
                    .optional()
                    .default(5)
                    .describe("Number of recent session logs to include (default 5)")
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler(
            (args) =>
                checkMemoryStatus(args.project_path, {
                    include_timeline: args.include_timeline,
                    timeline_limit: args.timeline_limit
                }),
            "check_memory_status"
        )
    );

    // 2. get_session_timeline
    server.registerTool(
        "get_session_timeline",
        {
            title: "Get Session Timeline Feed",
            description:
                "Retrieve a chronological feed of past work sessions, decisions, and architectural notes for this project workspace.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                category: z
                    .enum(["all", "session", "architecture", "decision", "note"])
                    .optional()
                    .default("all")
                    .describe("Filter entries by category (default 'all')"),
                tag: z.string().optional().describe("Filter entries containing a specific tag"),
                since: z.string().optional().describe("ISO-8601 date cutoff (e.g. '2026-01-01')"),
                limit: z.number().int().min(1).max(50).optional().default(15)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler(
            (args) =>
                getSessionTimeline(args.project_path, {
                    category: args.category,
                    tag: args.tag,
                    since: args.since,
                    limit: args.limit
                }),
            "get_session_timeline"
        )
    );

    // 3. save_project_memory
    server.registerTool(
        "save_project_memory",
        {
            title: "Save or Batch-Upsert Project Memory",
            description:
                "Save a single memory note, session log, or atomic batch of foundational architecture nodes (via entries array). Automatically updates existing nodes matching slug or id, preserving revisions in SQLite.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                title: z
                    .string()
                    .optional()
                    .describe("Title of memory (required if entries array is omitted)"),
                summary: z
                    .string()
                    .optional()
                    .describe("Markdown context or session log (required if entries array is omitted)"),
                category: CategoryEnum.optional().describe(
                    "Category ('architecture', 'decision', 'session', 'note'); auto-inferred if omitted"
                ),
                tags: z.array(z.string()).optional().default([]).describe("Keyword tags for search indexing"),
                files: z
                    .array(z.string())
                    .optional()
                    .default([])
                    .describe("Workspace-relative file paths linked to this memory"),
                slug: z
                    .string()
                    .optional()
                    .describe("Canonical slug (e.g. 'tech-stack', 'project-structure', 'build-run')"),
                id: z.string().optional().describe("Optional existing ID to update in-place"),
                entries: z
                    .array(BatchEntrySchema)
                    .optional()
                    .describe("Atomic batch of memory entries to save together in one transaction")
            },
            annotations: WRITE_ANNOTATIONS
        },
        wrapHandler((args) => saveProjectMemory(args.project_path, args), "save_project_memory")
    );

    // 4. search_project_memory
    server.registerTool(
        "search_project_memory",
        {
            title: "Search Project Memory with FTS5 BM25 Ranking",
            description:
                "Full-text search across project titles, tags, summaries, anchored files, and active anti-loop dead-ends with contextual match snippets.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                query: z.string().min(1).describe("Search keywords or error messages"),
                category: z
                    .string()
                    .optional()
                    .describe("Filter by category ('architecture', 'decision', 'session', 'dead_end', 'note')"),
                limit: z.number().int().min(1).max(30).optional().default(10)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler(
            (args) =>
                searchProjectMemory(args.project_path, {
                    query: args.query,
                    category: args.category,
                    limit: args.limit
                }),
            "search_project_memory"
        )
    );

    // 5. read_memory_node
    server.registerTool(
        "read_memory_node",
        {
            title: "Read Memory Node(s) with Staleness Detection & Global Routing",
            description:
                "Read full markdown content of single or multiple memory nodes by id/slug (or global ID 'g-...'). Warns if referenced workspace files were modified on disk after memory was saved.",
            inputSchema: {
                project_path: z.string().optional().describe("Absolute path to the project workspace root (optional for global 'g-' IDs)"),
                id: z.string().optional().describe("Memory ID, slug, or global ID (e.g., 'tech-stack', 'm-123', 'g-abc')"),
                ids: z.array(z.string()).optional().describe("Batch array of IDs or slugs to retrieve in one call"),
                include_revisions: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include historical previous revisions if available"),
                full_content: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Bypass token budget truncation to return complete untruncated content")
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler(
            (args) =>
                readMemoryNode(args.project_path, {
                    id: args.id,
                    ids: args.ids,
                    include_revisions: args.include_revisions,
                    full_content: args.full_content
                }),
            "read_memory_node"
        )
    );

    // 6. update_memory_node
    server.registerTool(
        "update_memory_node",
        {
            title: "Update Memory Node In-Place",
            description:
                "Update title, summary, tags, category, or files of an existing memory node. Automatically saves prior version to revisions history.",
            inputSchema: {
                project_path: z.string().optional().describe("Absolute path to the project workspace root"),
                id: z.string().min(1).describe("Memory ID to update (or 'g-...' global ID)"),
                title: z.string().optional().describe("Updated title"),
                summary: z.string().optional().describe("Updated full markdown context"),
                category: CategoryEnum.optional().describe("Updated category"),
                tags: z.array(z.string()).optional().describe("Updated keyword tags"),
                files: z.array(z.string()).optional().describe("Updated workspace-relative file paths"),
                tech_stack: z.string().optional().describe("Updated tech stack (for global nodes)")
            },
            annotations: WRITE_ANNOTATIONS
        },
        wrapHandler((args) => updateMemoryNode(args.project_path, args), "update_memory_node")
    );

    // 7. delete_memory_node
    server.registerTool(
        "delete_memory_node",
        {
            title: "Archive or Delete Memory Node",
            description:
                "Soft-archives a memory node (default, preserves history) or permanently deletes it along with its revisions.",
            inputSchema: {
                project_path: z.string().optional().describe("Absolute path to the project workspace root"),
                id: z.string().min(1).describe("Memory ID or dead-end ID to archive or delete"),
                hard_delete: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("If true, permanently drops node from database; if false, soft-archives")
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        wrapHandler((args) => deleteMemoryNode(args.project_path, args), "delete_memory_node")
    );

    // 8. record_dead_end
    server.registerTool(
        "record_dead_end",
        {
            title: "Record Anti-Loop Dead-End or Architectural Constraint",
            description:
                "Record a failed debugging attempt or intentional architectural constraint so future turns and sessions never repeat the same dead-end.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
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
                    .describe("Workspace-relative file paths involved"),
                kind: z
                    .enum(["error_loop", "architectural"])
                    .optional()
                    .default("error_loop")
                    .describe("Taxonomy kind: 'error_loop' for code/test bug, 'architectural' for intentional trade-off / rejected approach"),
                constraints: z
                    .array(z.string())
                    .optional()
                    .default([])
                    .describe("Active constraints or invariants that forbid this approach")
            },
            annotations: WRITE_ANNOTATIONS
        },
        wrapHandler((args) => recordDeadEnd(args.project_path, args), "record_dead_end")
    );

    // 9. check_dead_ends
    server.registerTool(
        "check_dead_ends",
        {
            title: "Check Recorded Dead-Ends",
            description:
                "Check the anti-loop dead-end registry by error text, keyword, or file path before attempting fixes.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                query: z
                    .string()
                    .optional()
                    .describe("Error message, symptom, or keyword to match"),
                file_path: z.string().optional().describe("Optional workspace file path to match"),
                limit: z.number().int().min(1).max(25).optional().default(10),
                kind: z
                    .enum(["all", "error_loop", "architectural"])
                    .optional()
                    .default("all")
                    .describe("Filter by dead-end kind ('all', 'error_loop', 'architectural')")
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler((args) => checkDeadEnds(args.project_path, args), "check_dead_ends")
    );

    // 10. get_file_memories
    server.registerTool(
        "get_file_memories",
        {
            title: "Get File-Anchored Memories",
            description:
                "Retrieve all architectural invariants, past gotchas, and dead-ends anchored to specific workspace file or directory paths.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                file_paths: z
                    .array(z.string())
                    .min(1)
                    .describe("Workspace-relative or absolute paths of files/directories about to be modified"),
                include_dead_ends: z.boolean().optional().default(true)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler((args) => getFileMemories(args.project_path, args), "get_file_memories")
    );
}
