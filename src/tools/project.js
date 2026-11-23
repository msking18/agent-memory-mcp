/**
 * @file src/tools/project.js
 * @description Project-scoped and workspace-configuration MCP tool registrations (Tools 1–10, 16).
 * Registers context status, timeline, atomic memory saves, FTS5 search, CRUD,
 * file-anchored memories, two-tier anti-loop dead-ends, and multi-folder/identity configuration.
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
    getFileMemories,
    configureWorkspace
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
 * Registers all project-scoped and workspace-configuration tools (1–10, 16) on an McpServer instance.
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

    // 16. configure_workspace
    server.registerTool(
        "configure_workspace",
        {
            title: "Configure Multi-Folder Workspace Policies & Project Identity",
            description:
                "Persist secondary folder policies ('independent', 'linked', 'ignored'), link or isolate project store identities across moved folders, worktrees, simultaneous clones, or remote URIs, or inspect resolved workspace store metadata without mutating user repositories.",
            inputSchema: {
                action: z
                    .enum(["set_folder_policy", "link_project_identity", "inspect"])
                    .describe("Configuration action: 'set_folder_policy', 'link_project_identity', or 'inspect'"),
                project_path: z
                    .string()
                    .optional()
                    .describe(
                        "Absolute workspace root path or remote URI (required for 'link_project_identity' and 'inspect')"
                    ),
                primary_path: z
                    .string()
                    .optional()
                    .describe("Primary workspace root path or remote URI (required for 'set_folder_policy')"),
                folder_path: z
                    .string()
                    .optional()
                    .describe("Secondary workspace folder path or remote URI (required for 'set_folder_policy')"),
                mode: z
                    .enum(["independent", "linked", "ignored"])
                    .optional()
                    .describe("Secondary folder policy mode (required for 'set_folder_policy')"),
                folder_slug: z
                    .string()
                    .optional()
                    .describe("Optional custom '@<slug>/' anchor prefix when mode is 'linked' (auto-disambiguated if omitted)"),
                source_project_path: z
                    .string()
                    .optional()
                    .describe(
                        "Previous/moved workspace path in projects_index.json to link from (does not require path to still exist on disk)"
                    ),
                git_remote: z
                    .string()
                    .optional()
                    .describe(
                        "Git remote URL (with optional '#subpath') to bind or share a project store across local/remote checkouts"
                    ),
                target_store_key: z
                    .string()
                    .optional()
                    .describe("Existing storeKey in projects_index.json to link this workspace to"),
                isolate: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true for 'link_project_identity', isolate a simultaneous clone into its own independent store"
                    ),
                workspace_paths: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "Optional list of open workspace root paths for 'inspect' to evaluate policies and reverse links"
                    )
            },
            annotations: WRITE_ANNOTATIONS
        },
        async (args) => {
            return executeTool("configure_workspace", args, () =>
                configureWorkspace(args)
            );
        }
    );
}
