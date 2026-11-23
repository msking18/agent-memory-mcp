import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { closeAllDatabases, openDatabase, openGlobalDatabase, logTokenAudit, queryTokenMetrics } from "../../src/db.js";
import { getProjectStoreInfo, getGlobalDbPath, getConfigPath, loadConfig } from "../../src/paths.js";
import {
    saveProjectMemory,
    readMemoryNode,
    updateMemoryNode,
    deleteMemoryNode,
    recordDeadEnd,
    checkDeadEnds,
    estimateTokens,
    applyTokenBudget,
    getTokenMetrics,
    saveGlobalKnowledge,
    searchGlobalKnowledge,
    promoteToGlobal,
    reopenDeadEnd
} from "../../src/store.js";
import { INDEX_JS } from "../helpers/env.js";

describe("agent-memory-mcp v3.1+ MCP Protocol, Global Knowledge & Token Budget Suite", () => {
    let tempRoot;
    let dataDir;
    let projectDir;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mem-v3-test-"));
        dataDir = path.join(tempRoot, "data-vault");
        projectDir = path.join(tempRoot, "SampleApp");
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(path.join(projectDir, "src", "lib"), { recursive: true });
        fs.writeFileSync(path.join(projectDir, "src", "lib", "auth.ts"), "export const auth = true;\n");
        process.env.AG_MEMORY_DATA_DIR = dataDir;

        assert.equal(getGlobalDbPath(), path.join(dataDir, "global.db"));
        assert.equal(getConfigPath(), path.join(dataDir, "config.json"));

        const defaultConfig = loadConfig();
        assert.equal(defaultConfig.max_response_tokens, 1000);
        assert.equal(defaultConfig.enable_audit_logging, true);
        assert.equal(defaultConfig.max_audit_log_entries, 2000);
    });

    afterEach(() => {
        closeAllDatabases();
        delete process.env.AG_MEMORY_DATA_DIR;
        try {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch {
            // Ignore transient Windows temp cleanup delay
        }
    });

    it("7. Verifies full MCP Stdio JSON-RPC protocol: 16 tools, readOnlyHint annotations, calls & resources", async () => {
        closeAllDatabases();
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ["--no-warnings", INDEX_JS],
            env: { ...process.env, AG_MEMORY_DATA_DIR: dataDir },
            stderr: "pipe"
        });
        const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

        await client.connect(transport);
        try {
            const { tools } = await client.listTools();
            assert.equal(tools.length, 16);
            assert.ok(tools.some((t) => t.name === "configure_workspace"));

            const statusTool = tools.find((t) => t.name === "check_memory_status");
            assert.equal(statusTool?.annotations?.readOnlyHint, true);

            const statusRes = await client.callTool({
                name: "check_memory_status",
                arguments: { project_path: projectDir }
            });
            assert.ok(!statusRes.isError);

            const saveRes = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projectDir,
                    title: "Tech Stack & Ecosystem",
                    summary: "Hono + Cloudflare Workers",
                    tags: ["architecture"],
                    files: ["src/lib/auth.ts"]
                }
            });
            assert.ok(!saveRes.isError);
            assert.match(saveRes.content[0].text, /tech-stack/);

            const searchRes = await client.callTool({
                name: "search_project_memory",
                arguments: {
                    project_path: projectDir,
                    query: "Cloudflare"
                }
            });
            assert.ok(!searchRes.isError);
            assert.match(searchRes.content[0].text, /Hono/);

            const readRes = await client.callTool({
                name: "read_memory_node",
                arguments: {
                    project_path: projectDir,
                    id: "tech-stack"
                }
            });
            assert.ok(!readRes.isError);
            assert.match(readRes.content[0].text, /Hono \+ Cloudflare Workers/);

            const timelineRes = await client.callTool({
                name: "get_session_timeline",
                arguments: {
                    project_path: projectDir,
                    category: "all"
                }
            });
            assert.ok(!timelineRes.isError);
            assert.match(timelineRes.content[0].text, /Tech Stack & Ecosystem/);

            const updateRes = await client.callTool({
                name: "update_memory_node",
                arguments: {
                    project_path: projectDir,
                    id: "tech-stack",
                    summary: "Hono + Cloudflare Workers + SQLite"
                }
            });
            assert.ok(!updateRes.isError);

            const deadEndRes = await client.callTool({
                name: "record_dead_end",
                arguments: {
                    project_path: projectDir,
                    error_pattern: "Fetch API timeout",
                    attempted_solution: "Set timeout to 0",
                    root_cause: "Never finishes; must use AbortController",
                    files: ["src/lib/auth.ts"],
                    kind: "error_loop"
                }
            });
            assert.ok(!deadEndRes.isError);
            const deIdMatch = deadEndRes.content[0].text.match(/ID: (de-[a-f0-9]+)/);
            assert.ok(deIdMatch);
            const testDeId = deIdMatch[1];

            const checkDeRes = await client.callTool({
                name: "check_dead_ends",
                arguments: {
                    project_path: projectDir,
                    query: "timeout"
                }
            });
            assert.ok(!checkDeRes.isError);
            assert.match(checkDeRes.content[0].text, /Fetch API timeout/);

            const fileMemRes = await client.callTool({
                name: "get_file_memories",
                arguments: {
                    project_path: projectDir,
                    file_paths: ["src/lib/auth.ts"]
                }
            });
            assert.ok(!fileMemRes.isError);
            assert.match(fileMemRes.content[0].text, /File-Anchored Architectural Memories/);

            const reopenRes = await client.callTool({
                name: "reopen_dead_end",
                arguments: {
                    project_path: projectDir,
                    id: testDeId,
                    reason: "Platform added native timeout option"
                }
            });
            assert.ok(!reopenRes.isError);

            const deleteRes = await client.callTool({
                name: "delete_memory_node",
                arguments: {
                    project_path: projectDir,
                    id: testDeId,
                    hard_delete: false
                }
            });
            assert.ok(!deleteRes.isError);

            const saveGlobRes = await client.callTool({
                name: "save_global_knowledge",
                arguments: {
                    title: "Node.js 22 SQLite In-Memory Flag",
                    summary: "Use :memory: with DatabaseSync for ephemeral in-memory databases.",
                    tech_stack: "nodejs"
                }
            });
            assert.ok(!saveGlobRes.isError);
            assert.match(saveGlobRes.content[0].text, /g-/);

            const searchGlobRes = await client.callTool({
                name: "search_global_knowledge",
                arguments: { query: "ephemeral in-memory" }
            });
            assert.ok(!searchGlobRes.isError);
            assert.match(searchGlobRes.content[0].text, /Node\.js 22 SQLite/);

            const promoteRes = await client.callTool({
                name: "promote_to_global",
                arguments: {
                    project_path: projectDir,
                    memory_id: "tech-stack",
                    tech_stack: "hono"
                }
            });
            assert.ok(!promoteRes.isError);
            assert.match(promoteRes.content[0].text, /Promoted memory/);

            const metricsRes = await client.callTool({
                name: "get_token_metrics",
                arguments: { timeframe_hours: 1 }
            });
            assert.ok(!metricsRes.isError);

            const { resources } = await client.listResources();
            assert.ok(resources.some((r) => r.uri === "memory://projects"));

            const resContent = await client.readResource({ uri: "memory://projects" });
            const indexJson = JSON.parse(resContent.contents[0].text);
            assert.equal(Object.keys(indexJson.projects).length, 1);
        } finally {
            await client.close();
        }
    });

    it("8. Verifies global.db schema, dead_ends migration, and token audit logging", () => {
        const globalDb = openGlobalDatabase();
        const tables = globalDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name);
        assert.ok(tables.includes("global_memories"));
        assert.ok(tables.includes("global_memories_fts"));
        assert.ok(tables.includes("token_audit_log"));

        const info = getProjectStoreInfo(projectDir);
        const projDb = openDatabase(info.dbPath);
        const deadEndCols = projDb
            .prepare("PRAGMA table_info(dead_ends)")
            .all()
            .map((c) => c.name);
        assert.ok(deadEndCols.includes("kind"));
        assert.ok(deadEndCols.includes("constraints_json"));
        assert.ok(deadEndCols.includes("status"));
        assert.ok(deadEndCols.includes("reopened_reason"));
        assert.ok(deadEndCols.includes("updated_at"));

        for (let i = 0; i < 5; i++) {
            logTokenAudit(
                globalDb,
                {
                    timestamp: new Date().toISOString(),
                    tool_name: "test_tool",
                    project_path: projectDir,
                    input_tokens: 10,
                    output_tokens_raw: 200,
                    output_tokens_budgeted: 150,
                    truncated: 1
                },
                3 // maxEntries = 3
            );
        }

        const metrics = queryTokenMetrics(globalDb, { timeframeHours: 1, limit: 10 });
        assert.equal(metrics.recent_logs.length, 3);
        assert.equal(metrics.total_calls, 3);
    });

    it("9. Verifies token estimation, sentence-boundary budget trimming, and getTokenMetrics", () => {
        assert.equal(estimateTokens(""), 0);
        assert.equal(estimateTokens("1234"), 2); // 4 / 3.8 = 1.05 -> ceil = 2

        const shortText = "Short response within budget.";
        const budgetUnder = applyTokenBudget(shortText, "check_status", projectDir, { maxTokens: 100 });
        assert.equal(budgetUnder.truncated, false);
        assert.equal(budgetUnder.text, shortText);

        const longText = "First sentence. " + "Middle sentence. ".repeat(30) + "Final sentence.";
        const budgetOver = applyTokenBudget(longText, "search_memory", projectDir, { maxTokens: 20 });
        assert.equal(budgetOver.truncated, true);
        assert.match(budgetOver.text, /\[TRUNCATED: Output exceeded token budget/);

        const metrics = getTokenMetrics({ timeframe_hours: 1, limit: 10 });
        assert.ok(metrics.total_calls >= 2);
        assert.ok(metrics.tool_breakdown.some((b) => b.tool_name === "search_memory"));
    });

    it("10. Verifies global knowledge CRUD, FTS search, promote_to_global, and g- prefix routing", () => {
        const saved = saveGlobalKnowledge({
            title: "Prisma Neon Connection Pool Architecture",
            summary: "Use PrismaPg adapter with Neon Serverless driver to prevent connection exhaustion.",
            category: "pattern",
            tags: ["database", "prisma", "neon"],
            tech_stack: "nodejs"
        });
        assert.ok(saved.id.startsWith("g-"));

        const searchRes = searchGlobalKnowledge({ query: "adapter neon pool" });
        assert.ok(searchRes.results.length > 0);
        assert.equal(searchRes.results[0].id, saved.id);

        const readG = readMemoryNode(null, { id: saved.id, full_content: true });
        assert.equal(readG.isError, false);
        assert.match(readG.text, /Prisma Neon Connection Pool/);

        const updateRes = updateMemoryNode(null, {
            id: saved.id,
            title: "Updated Prisma Neon Pool"
        });
        assert.equal(updateRes.isError, false);

        const projSaved = saveProjectMemory(projectDir, {
            title: "Docker Multi-Stage NextJS Pattern",
            summary: "Use standalone output in next.config.js for minimal runner image size.",
            tags: ["docker", "nextjs"]
        });
        const projNodeId = projSaved.results[0].id;

        const promoted = promoteToGlobal(projectDir, {
            memory_id: projNodeId,
            tech_stack: "nextjs"
        });
        assert.equal(promoted.isError, false);
        assert.ok(promoted.promoted_id.startsWith("g-"));

        const searchPromoted = searchGlobalKnowledge({ query: "standalone runner" });
        assert.ok(searchPromoted.results.some((r) => r.id === promoted.promoted_id));

        const delRes = deleteMemoryNode(null, { id: saved.id });
        assert.equal(delRes.isError, false);
        const searchAfterDel = searchGlobalKnowledge({ query: "adapter neon pool" });
        assert.equal(searchAfterDel.results.length, 0);
    });

    it("11. Verifies dead-end taxonomy, constraints, and reopen_dead_end", () => {
        const de1 = recordDeadEnd(projectDir, {
            error_pattern: "SyntaxError: Unexpected token in JSON at position 0",
            attempted_solution: "Wrapped with try/catch and swallowed error",
            root_cause: "File was UTF-8 with BOM; needed stripBom",
            files: ["src/migrate.js"],
            kind: "error_loop"
        });
        assert.equal(de1.kind, "error_loop");

        const de2 = recordDeadEnd(projectDir, {
            error_pattern: "High read latency on shared global table",
            attempted_solution: "Add Redis caching cluster",
            root_cause: "Forbidden by single-binary zero-external-dependency requirement",
            files: ["src/store.js"],
            kind: "architectural",
            constraints: ["Single binary constraint", "Zero external daemon dependencies"]
        });
        assert.equal(de2.kind, "architectural");

        const allHits = checkDeadEnds(projectDir, { kind: "all" });
        assert.ok(allHits.matches.some((m) => m.id === de1.id));
        assert.ok(allHits.matches.some((m) => m.id === de2.id));
        assert.match(allHits.text, /\[DEAD-END ERROR LOOP\]/);
        assert.match(allHits.text, /\[ARCHITECTURAL CONSTRAINT \/ TRADE-OFF\]/);

        const loopHits = checkDeadEnds(projectDir, { kind: "error_loop" });
        assert.ok(loopHits.matches.every((m) => m.kind === "error_loop"));

        const archHits = checkDeadEnds(projectDir, { kind: "architectural" });
        assert.ok(archHits.matches.every((m) => m.kind === "architectural"));
        assert.match(archHits.text, /Single binary constraint/);

        const reopenRes = reopenDeadEnd(projectDir, {
            id: de2.id,
            reason: "Client environment explicitly allows local Redis container now"
        });
        assert.equal(reopenRes.isError, false);

        const hitsAfterReopen = checkDeadEnds(projectDir, { kind: "architectural" });
        assert.ok(!hitsAfterReopen.matches.some((m) => m.id === de2.id));
    });

    it("12. Verifies token budget capping middleware, full_content bypass, and reopen_dead_end via MCP client", async () => {
        closeAllDatabases();
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ["--no-warnings", INDEX_JS],
            env: {
                ...process.env,
                AG_MEMORY_DATA_DIR: dataDir,
                AG_MEMORY_MAX_RESPONSE_TOKENS: "30"
            },
            stderr: "pipe"
        });
        const client = new Client({ name: "test-client-budget", version: "1.0.0" }, { capabilities: {} });

        await client.connect(transport);
        try {
            const longText = "Important concept. ".repeat(40);
            await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projectDir,
                    slug: "long-architecture-spec",
                    title: "Long Architecture Spec",
                    summary: longText,
                    category: "architecture"
                }
            });

            const readCapped = await client.callTool({
                name: "read_memory_node",
                arguments: {
                    project_path: projectDir,
                    id: "long-architecture-spec",
                    full_content: false
                }
            });
            assert.ok(!readCapped.isError);
            assert.match(readCapped.content[0].text, /\[TRUNCATED: Output exceeded token budget/);

            const readFull = await client.callTool({
                name: "read_memory_node",
                arguments: {
                    project_path: projectDir,
                    id: "long-architecture-spec",
                    full_content: true
                }
            });
            assert.ok(!readFull.isError);
            assert.ok(!readFull.content[0].text.includes("[TRUNCATED: Output exceeded token budget"));

            const recDeRes = await client.callTool({
                name: "record_dead_end",
                arguments: {
                    project_path: projectDir,
                    error_pattern: "OOM on large CSV import",
                    attempted_solution: "Load entire 10GB file into V8 buffer",
                    root_cause: "V8 heap exhausted; must use streaming pipeline",
                    kind: "architectural",
                    constraints: ["Max memory 512MB"]
                }
            });
            assert.ok(!recDeRes.isError);
            assert.match(recDeRes.content[0].text, /architectural constraint/);

            const deIdMatch = recDeRes.content[0].text.match(/ID: (de-[a-f0-9]+)/);
            assert.ok(deIdMatch);
            const deId = deIdMatch[1];

            const reopenRes = await client.callTool({
                name: "reopen_dead_end",
                arguments: {
                    project_path: projectDir,
                    id: deId,
                    reason: "Switched to 64-bit high-memory runner machine"
                }
            });
            assert.ok(!reopenRes.isError);
            assert.match(reopenRes.content[0].text, /Reopened dead-end/);
        } finally {
            await client.close();
        }
    });
});
