#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// Helper to get the memory file path per project
function getMemoryFile(projectPath) {
    // This allows the agent to pass "./" or an absolute path like "C:/Projects/MyApp"
    return path.resolve(projectPath, ".ag-memory.json");
}

// Helper to read memory
async function loadMemory(projectPath) {
    const file = getMemoryFile(projectPath);
    try {
        const data = await fs.readFile(file, "utf-8");
        return JSON.parse(data);
    } catch (error) {
        if (error.code === "ENOENT") return { entries: {} };
        throw error;
    }
}

// Helper to save memory
async function saveMemory(projectPath, data) {
    const file = getMemoryFile(projectPath);
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

const server = new Server({ name: "antigravity-project-memory", version: "2.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools:[
        {
            name: "check_memory_status",
            description: "Check if a memory file exists for the current project. Run this when opening a new project.",
            inputSchema: {
                type: "object",
                properties: { project_path: { type: "string", description: "Path to the project root (e.g., './' or absolute path)" } },
                required: ["project_path"]
            }
        },
        {
            name: "get_session_timeline",
            description: "Get a chronological list of the most recent changes and session logs to understand what was recently accomplished or attempted.",
            inputSchema: {
                type: "object",
                properties: { 
                    project_path: { type: "string" },
                    limit: { type: "number", description: "Number of recent entries to retrieve (default 5)" }
                },
                required: ["project_path"]
            }
        },
        {
            name: "save_project_memory",
            description: "Save architectural context OR a session log to the specific project's memory.",
            inputSchema: {
                type: "object",
                properties: {
                    project_path: { type: "string", description: "Path to the project root" },
                    title: { type: "string", description: "Short title (e.g., 'Session Log: Fixed Auth Bug' or 'Tauri IPC Setup')" },
                    summary: { type: "string", description: "The full context, or a summary of what was added/removed/failed." },
                    tags: { type: "array", items: { type: "string" } }
                },
                required:["project_path", "title", "summary", "tags"]
            }
        },
        {
            name: "search_project_memory",
            description: "Search the specific project's memory by keyword.",
            inputSchema: {
                type: "object",
                properties: { 
                    project_path: { type: "string" }, 
                    query: { type: "string" } 
                },
                required:["project_path", "query"]
            }
        },
        {
            name: "read_memory_node",
            description: "Read full context of a memory node by ID.",
            inputSchema: {
                type: "object",
                properties: { 
                    project_path: { type: "string" }, 
                    id: { type: "string" } 
                },
                required:["project_path", "id"]
            }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const pPath = args.project_path;

    try {
        if (name === "check_memory_status") {
            try {
                await fs.access(getMemoryFile(pPath));
                return { content:[{ type: "text", text: "Memory file exists. You may proceed." }] };
            } catch {
                return { content:[{ type: "text", text: "UNINITIALIZED: No memory file found. You must bootstrap the project memory." }] };
            }
        }

        const memory = await loadMemory(pPath);

        if (name === "get_session_timeline") {
            const limit = args.limit || 5;
            // Sort by date descending (newest first)
            const entries = Object.values(memory.entries)
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, limit)
                .map(e => `[${new Date(e.date).toLocaleString()}] ${e.title} (ID: ${e.id})\nPreview: ${e.summary.substring(0, 150)}...`);
            
            if (entries.length === 0) return { content:[{ type: "text", text: "No timeline history found." }] };
            return { content:[{ type: "text", text: "Recent Session Timeline (Newest First):\n\n" + entries.join("\n\n") + "\n\nUse read_memory_node if you need to see the full details of an entry." }] };
        }

        if (name === "save_project_memory") {
            const id = crypto.randomUUID().substring(0, 8);
            memory.entries[id] = { id, title: args.title, summary: args.summary, tags: args.tags, date: new Date().toISOString() };
            await saveMemory(pPath, memory);
            return { content:[{ type: "text", text: `Saved to ${pPath}. ID: ${id}` }] };
        }

        if (name === "search_project_memory") {
            const q = args.query.toLowerCase();
            const results = Object.values(memory.entries).filter(entry => 
                entry.title.toLowerCase().includes(q) || entry.tags.some(tag => tag.toLowerCase().includes(q))
            ).map(e => `[ID: ${e.id}] ${e.title}`);
            
            if (results.length === 0) return { content:[{ type: "text", text: "No relevant memory found." }] };
            return { content:[{ type: "text", text: "Matches:\n" + results.join("\n") + "\nUse read_memory_node with the ID for details." }] };
        }

        if (name === "read_memory_node") {
            const entry = memory.entries[args.id];
            if (!entry) return { content:[{ type: "text", text: `Error: ID ${args.id} not found.` }], isError: true };
            return { content:[{ type: "text", text: `--- ${entry.title} ---\nDate: ${new Date(entry.date).toLocaleString()}\n\n${entry.summary}` }] };
        }

        throw new Error("Unknown tool");
    } catch (error) {
        return { content:[{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Project-aware Memory MCP Server running on stdio");