/**
 * @file src/tools/project.js
 * @description Project-scoped memory MCP tool registrations (Tools 1–7, 10).
 * Registers context status, timeline, atomic memory saves, FTS5 search, CRUD,
 * and file-anchored memories.
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
    getFileMemories
} from "../store/index.js";
import {
    executeTool,
    wrapHandler,
    READ_ONLY_ANNOTATIONS,
    WRITE_ANNOTATIONS,
    CategoryEnum,
    BatchEntrySchema
} from "./common.js";

/**
 * Registers project-scoped memory tools (1–7, 10) on an McpServer instance.
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
                "Check if project memory is initialized and retrieve core architecture index, dead-end count, and recent session timeline in one call. Auto-migrates legacy .ag-memory.json if present on local workspaces.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe(
                        "Absolute path to the project workspace root directory (or primary workspace for linked folders) or remote URI (ssh://, vscode-remote://, wsl://, devcontainer://, remote://)"
                    ),
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
                    .describe("Number of recent session logs to include (default 5)"),
                git_remote: z
                    .string()
                    .optional()
                    .describe(
                        "Optional git remote URL (e.g., origin remote) to bind/resolve a remote workspace URI to its git identity store"
                    )
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args) => {
            return executeTool("check_memory_status", args, () =>
                checkMemoryStatus(args.project_path, {
                    include_timeline: args.include_timeline,
                    timeline_limit: args.timeline_limit,
                    git_remote: args.git_remote
                })
            );
        }
    );

    // 2. get_session_timeline
    server.registerTool(
        "get_session_timeline",
        {
            title: "Get Session Timeline Feed",
            description:
                "Retrieve a chronological feed of past work sessions, decisions, and architectural notes for this project workspace.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe("Absolute path to the project workspace root or remote workspace URI"),
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
        async (args) => {
            return executeTool("get_session_timeline", args, () =>
                getSessionTimeline(args.project_path, {
                    category: args.category,
                    tag: args.tag,
                    since: args.since,
                    limit: args.limit
                })
            );
        }
    );

    // 3. save_project_memory
    server.registerTool(
        "save_project_memory",
        {
            title: "Save or Batch-Upsert Project Memory",
            description:
                "Save a single memory note, session log, or atomic batch of foundational architecture nodes (via entries array). Automatically updates existing nodes matching slug or id, preserving revisions in SQLite, and enforces cross-folder and clone-disambiguation guardrails.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe(
                        "Absolute path to the project workspace root (pass primary workspace for linked folders) or remote workspace URI"
                    ),
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
                    .describe("Workspace-relative file paths or '@<folderSlug>/' linked-folder anchors"),
                slug: z
                    .string()
                    .optional()
                    .describe("Canonical slug (e.g. 'tech-stack', 'project-structure', 'build-run')"),
                id: z.string().optional().describe("Optional existing ID to update in-place"),
                entries: z
                    .array(BatchEntrySchema)
                    .optional()
                    .describe("Atomic batch of memory entries to save together in one transaction"),
                git_remote: z
                    .string()
                    .optional()
                    .describe("Optional git remote URL for remote/virtual workspace identity binding"),
                allow_external_files: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Explicit user-approved override allowing file paths outside project_path (cross-folder write guardrail)"
                    ),
                force_isolate: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Explicit user-approved override isolating a simultaneous clone into its own independent store before writing"
                    )
            },
            annotations: WRITE_ANNOTATIONS
        },
        async (args) => {
            return executeTool("save_project_memory", args, () =>
                saveProjectMemory(args.project_path, args)
            );
        }
    );

    // 4. search_project_memory
    server.registerTool(
        "search_project_memory",
        {
            title: "Search Project Memory with FTS5 BM25 Ranking",
            description:
                "Full-text search across project titles, tags, summaries, anchored files, and active anti-loop dead-ends with contextual match snippets.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe("Absolute path to the project workspace root or remote workspace URI"),
                query: z.string().min(1).describe("Search keywords or error messages"),
                category: z
                    .string()
                    .optional()
                    .describe("Filter by category ('architecture', 'decision', 'session', 'dead_end', 'note')"),
                limit: z.number().int().min(1).max(30).optional().default(10)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args) => {
            return executeTool("search_project_memory", args, () =>
                searchProjectMemory(args.project_path, {
                    query: args.query,
                    category: args.category,
                    limit: args.limit
                })
            );
        }
    );

    // 5. read_memory_node
    server.registerTool(
        "read_memory_node",
        {
            title: "Read Memory Node(s) with Staleness Detection & Global Routing",
            description:
                "Read full markdown content of single or multiple memory nodes by id/slug (or global ID 'g-...'). Warns if referenced local workspace files were modified on disk after memory was saved (skipped on remote URIs).",
            inputSchema: {
                project_path: z
                    .string()
                    .optional()
                    .describe(
                        "Absolute path to the project workspace root or remote URI (optional for global 'g-' IDs)"
                    ),
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
        async (args) => {
            return executeTool("read_memory_node", args, () =>
                readMemoryNode(args.project_path, {
                    id: args.id,
                    ids: args.ids,
                    include_revisions: args.include_revisions,
                    full_content: args.full_content
                })
            );
        }
    );

    // 6. update_memory_node
    server.registerTool(
        "update_memory_node",
        {
            title: "Update Memory Node In-Place",
            description:
                "Update title, summary, tags, category, or files of an existing memory node. Automatically saves prior version to revisions history.",
            inputSchema: {
                project_path: z
                    .string()
                    .optional()
                    .describe("Absolute path to the project workspace root or remote workspace URI"),
                id: z.string().min(1).describe("Memory ID to update (or 'g-...' global ID)"),
                title: z.string().optional().describe("Updated title"),
                summary: z.string().optional().describe("Updated full markdown context"),
                category: CategoryEnum.optional().describe("Updated category"),
                tags: z.array(z.string()).optional().describe("Updated keyword tags"),
                files: z
                    .array(z.string())
                    .optional()
                    .describe("Updated workspace-relative file paths or '@<folderSlug>/' linked-folder anchors"),
                tech_stack: z.string().optional().describe("Updated tech stack (for global nodes)"),
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
            return executeTool("update_memory_node", args, () =>
                updateMemoryNode(args.project_path, args)
            );
        }
    );

    // 7. delete_memory_node
    server.registerTool(
        "delete_memory_node",
        {
            title: "Archive or Delete Memory Node",
            description:
                "Soft-archives a memory node (default, preserves history) or permanently deletes it along with its revisions.",
            inputSchema: {
                project_path: z
                    .string()
                    .optional()
                    .describe("Absolute path to the project workspace root or remote workspace URI"),
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
        async (args) => {
            return executeTool("delete_memory_node", args, () =>
                deleteMemoryNode(args.project_path, args)
            );
        }
    );

    // 10. get_file_memories
    server.registerTool(
        "get_file_memories",
        {
            title: "Get File-Anchored Memories",
            description:
                "Retrieve all architectural invariants, past gotchas, and dead-ends anchored to specific workspace or linked-folder file/directory paths.",
            inputSchema: {
                project_path: z
                    .string()
                    .describe("Absolute path to the project workspace root or remote workspace URI"),
                file_paths: z
                    .array(z.string())
                    .min(1)
                    .describe("Workspace-relative, linked-folder, or absolute paths of files/directories about to be modified"),
                include_dead_ends: z.boolean().optional().default(true)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args) => {
            return executeTool("get_file_memories", args, () =>
                getFileMemories(args.project_path, args)
            );
        }
    );
}
