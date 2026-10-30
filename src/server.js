import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readProjectsIndex } from "./paths.js";
import { closeAllDatabases } from "./db.js";
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
} from "./store.js";

const SERVER_INSTRUCTIONS = `agent-memory-mcp (v3.0) provides persistent per-project memory, FTS5 search, file-anchored notes, and an anti-loop dead-end registry.
- Always pass an absolute workspace directory path as project_path (never "./").
- Skip memory tool calls when no active project workspace is open.
- check_memory_status hydrates status, core architecture index, dead-end warnings, and recent timeline in a single call.
- Before modifying shared utilities or hooks, call get_file_memories for those paths.
- Before retrying a compiler/test error, call check_dead_ends; record failed fixes via record_dead_end.`;

const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

const CategoryEnum = z.enum(["architecture", "decision", "session", "dead_end", "note"]);

const BatchEntrySchema = z.object({
    id: z.string().optional().describe("Optional existing ID to update in-place"),
    slug: z
        .string()
        .optional()
        .describe("Optional canonical slug (e.g., 'tech-stack', 'project-structure', 'build-run')"),
    title: z.string().min(1).describe("Short descriptive title"),
    summary: z.string().min(1).describe("Full markdown/text context or session changelog"),
    category: CategoryEnum.optional().describe(
        "Category ('architecture', 'decision', 'session', 'note'); auto-inferred if omitted"
    ),
    tags: z.array(z.string()).optional().default([]).describe("Keyword tags"),
    files: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Optional workspace-relative file paths anchored to this memory")
});

function okText(text) {
    return { content: [{ type: "text", text }] };
}

function errText(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}

function wrapHandler(fn) {
    return async (args) => {
        try {
            const res = await fn(args);
            if (res?.isError) {
                return errText(res.text);
            }
            return okText(res.text);
        } catch (err) {
            return errText(`Error: ${err.message}`);
        }
    };
}

/**
 * Creates a configured McpServer instance with all 10 v3 tools and resources.
 */
export function createMcpServer() {
    const server = new McpServer(
        { name: "agent-memory-mcp", version: "3.0.0" },
        { instructions: SERVER_INSTRUCTIONS }
    );

    // MCP Resource: Central index of tracked projects
    server.registerResource(
        "projects",
        "memory://projects",
        {
            title: "Tracked Project Memory Stores",
            description: "JSON registry of all workspaces managed by agent-memory-mcp v3",
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
        wrapHandler((args) =>
            checkMemoryStatus(args.project_path, {
                include_timeline: args.include_timeline,
                timeline_limit: args.timeline_limit
            })
        )
    );

    // 2. get_session_timeline
    server.registerTool(
        "get_session_timeline",
        {
            title: "Get Session Timeline",
            description:
                "Retrieve a chronological newest-first feed of recent session logs (or filtered category/tag entries).",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .optional()
                    .default(5)
                    .describe("Number of entries to retrieve (default 5)"),
                category: z
                    .enum(["session", "architecture", "decision", "note", "all"])
                    .optional()
                    .default("session")
                    .describe("Entry category filter (default 'session'; pass 'all' for everything)"),
                tag: z.string().optional().describe("Optional tag filter"),
                since: z.string().optional().describe("Optional ISO 8601 timestamp lower bound")
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler((args) => getSessionTimeline(args.project_path, args))
    );

    // 3. save_project_memory
    server.registerTool(
        "save_project_memory",
        {
            title: "Save or Upsert Project Memory",
            description:
                "Save a single memory entry or an atomic batch of entries[]. Automatically upserts matching id or canonical slug (preserving prior versions in revision history).",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                id: z.string().optional().describe("Optional ID to update an existing entry"),
                slug: z
                    .string()
                    .optional()
                    .describe("Optional slug for idempotent upserts (e.g. 'tech-stack')"),
                title: z
                    .string()
                    .optional()
                    .describe("Short title (required when saving a single entry)"),
                summary: z
                    .string()
                    .optional()
                    .describe("Full context or session changelog (required for single entry)"),
                category: CategoryEnum.optional().describe(
                    "Optional category ('architecture', 'decision', 'session', 'note')"
                ),
                tags: z.array(z.string()).optional().describe("Keyword tags"),
                files: z
                    .array(z.string())
                    .optional()
                    .describe("Workspace-relative file paths anchored to this memory"),
                entries: z
                    .array(BatchEntrySchema)
                    .optional()
                    .describe("Optional batch array to save multiple entries in one atomic transaction")
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        wrapHandler((args) => saveProjectMemory(args.project_path, args))
    );

    // 4. search_project_memory
    server.registerTool(
        "search_project_memory",
        {
            title: "Search Project Memory (FTS5)",
            description:
                "Ranked SQLite FTS5 full-text search across title, tags, anchored files, and summary text (plus matching dead-ends), returning contextual snippets.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                query: z.string().min(1).describe("Keywords, code symbols, file paths, or error terms"),
                category: CategoryEnum.optional().describe("Optional category filter"),
                tags: z.array(z.string()).optional().describe("Optional tag filter list"),
                include_superseded: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include historical superseded entries"),
                limit: z.number().int().min(1).max(30).optional().default(10)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler((args) => searchProjectMemory(args.project_path, args))
    );

    // 5. read_memory_node
    server.registerTool(
        "read_memory_node",
        {
            title: "Read Memory Node(s)",
            description:
                "Read full text and metadata of one or more memory nodes (by ID or slug), including automatic file-staleness warnings and optional revision history.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                id: z.string().optional().describe("Single memory ID or canonical slug"),
                ids: z
                    .array(z.string())
                    .optional()
                    .describe("Batch list of memory IDs or slugs to read in one call"),
                include_revisions: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include prior revision history if updated")
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler((args) => readMemoryNode(args.project_path, args))
    );

    // 6. update_memory_node
    server.registerTool(
        "update_memory_node",
        {
            title: "Update Memory Node",
            description:
                "Partially update an existing memory node's title, summary, tags, category, or anchored files while preserving its prior content in revision history.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                id: z.string().min(1).describe("Target memory ID or canonical slug"),
                title: z.string().optional(),
                summary: z.string().optional(),
                category: CategoryEnum.optional(),
                tags: z.array(z.string()).optional(),
                files: z.array(z.string()).optional()
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        wrapHandler((args) => updateMemoryNode(args.project_path, args))
    );

    // 7. delete_memory_node
    server.registerTool(
        "delete_memory_node",
        {
            title: "Delete or Archive Memory Node",
            description:
                "Soft-archive an obsolete memory node (removing it from active search while keeping history) or permanently delete it when hard_delete is true.",
            inputSchema: {
                project_path: z.string().describe("Absolute path to the project workspace root"),
                id: z.string().min(1).describe("Memory or dead-end ID"),
                hard_delete: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Permanently erase from SQLite instead of archiving (default false)")
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        wrapHandler((args) => deleteMemoryNode(args.project_path, args))
    );

    // 8. record_dead_end
    server.registerTool(
        "record_dead_end",
        {
            title: "Record Anti-Loop Dead-End",
            description:
                "Record a failed debugging/implementation attempt so future turns and sessions never repeat the same dead-end.",
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
                    .describe("Workspace-relative file paths involved")
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        wrapHandler((args) => recordDeadEnd(args.project_path, args))
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
                limit: z.number().int().min(1).max(25).optional().default(10)
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        wrapHandler((args) => checkDeadEnds(args.project_path, args))
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
        wrapHandler((args) => getFileMemories(args.project_path, args))
    );

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
    console.error("agent-memory-mcp v3.0.0 (SQLite + FTS5) running on stdio");
    return server;
}
