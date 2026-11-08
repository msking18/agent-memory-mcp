import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { closeAllDatabases, openDatabase, openGlobalDatabase, logTokenAudit, queryTokenMetrics } from "../src/db.js";
import { validateProjectPath, getProjectStoreInfo, getGlobalDbPath, getConfigPath, loadConfig } from "../src/paths.js";
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
    estimateTokens,
    applyTokenBudget,
    getTokenMetrics,
    saveGlobalKnowledge,
    searchGlobalKnowledge,
    promoteToGlobal,
    reopenDeadEnd
} from "../src/store.js";
import { runSessionStartPayload } from "../src/session-start-hook.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_JS = path.join(REPO_ROOT, "index.js");
const HOOK_JS = path.join(REPO_ROOT, "src", "session-start-hook.js");

describe("agent-memory-mcp v3.0 Comprehensive Test Suite", () => {
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

    it("1. Rejects relative paths ('./') and handles platform casing/store keys", () => {
        assert.throws(() => validateProjectPath("./"), /relative paths/i);
        assert.throws(() => validateProjectPath("relative/folder"), /relative paths/i);
        assert.throws(
            () => validateProjectPath(path.join(tempRoot, "non-existent-folder")),
            /does not exist/i
        );

        if (process.platform === "win32") {
            // Windows NTFS is case-insensitive; ensure uppercase and lowercase resolve to identical store key
            const infoUpper = getProjectStoreInfo(projectDir.toUpperCase());
            const infoLower = getProjectStoreInfo(projectDir.toLowerCase());
            assert.equal(infoUpper.storeKey, infoLower.storeKey);
        } else {
            // Linux/POSIX filesystems are case-sensitive; verify store key generation
            const info = getProjectStoreInfo(projectDir);
            assert.ok(info.storeKey);
            assert.match(info.storeKey, /^sampleapp-/);
        }
    });

    it("2. Performs lossless JIT migration, deduplicates bootstrap titles, archives backup, and handles delta merges", () => {
        const legacyFile = path.join(projectDir, ".ag-memory.json");
        const legacyPayload = {
            entries: {
                oldstack: {
                    id: "oldstack",
                    title: "Tech Stack & Ecosystem",
                    summary: "Old v1 stack: Express + Mongo",
                    tags: ["architecture"],
                    date: "2026-01-10T10:00:00.000Z"
                },
                newstack: {
                    id: "newstack",
                    title: "Tech Stack & Ecosystem",
                    summary: "Upgraded stack: Fastify + @google/genai + src/lib/auth.ts",
                    tags: "architecture, core",
                    date: "2026-05-01T12:00:00.000Z",
                    customExtraField: "preserved-value"
                },
                sess0001: {
                    title: "Session Log: Auth Refactor",
                    summary: "Refactored token validation inside src/lib/auth.ts",
                    tags: ["changelog", "session"]
                    // Intentionally omit 'id' and 'date' to test normalization
                }
            }
        };

        // Prepend UTF-8 BOM to test BOM stripping
        fs.writeFileSync(legacyFile, "\uFEFF" + JSON.stringify(legacyPayload, null, 2), "utf8");

        const status = checkMemoryStatus(projectDir);
        assert.equal(status.initialized, true);
        assert.equal(status.migration.action, "migrated");
        assert.equal(status.migration.migratedCount, 3);
        assert.equal(status.migration.supersededDuplicates, 1);

        // Untracked legacy file moved out of repo into central backups/
        assert.equal(fs.existsSync(legacyFile), false);
        assert.equal(fs.existsSync(status.migration.backupFilePath), true);

        // Newest 'Tech Stack & Ecosystem' is active with slug 'tech-stack'; older is superseded but still readable!
        const activeRead = readMemoryNode(projectDir, { id: "tech-stack" });
        assert.equal(activeRead.isError, false);
        assert.match(activeRead.text, /Upgraded stack: Fastify/);
        assert.match(activeRead.text, /src\/lib\/auth\.ts/);

        const supersededRead = readMemoryNode(projectDir, { id: "oldstack" });
        assert.equal(supersededRead.isError, false);
        assert.match(supersededRead.text, /Old v1 stack: Express/);
        assert.match(supersededRead.text, /superseded \(by newstack\)/i);

        // Split-brain delta merge: re-introduce a diverged .ag-memory.json with a new entry
        const divergedPayload = {
            entries: {
                ...legacyPayload.entries,
                branch99: {
                    id: "branch99",
                    title: "Session Log: Old Branch Hotfix",
                    summary: "Fixed legacy webhook retry timeout",
                    tags: ["session"],
                    date: "2026-04-20T08:00:00.000Z"
                }
            }
        };
        fs.writeFileSync(legacyFile, JSON.stringify(divergedPayload), "utf8");

        const afterMerge = checkMemoryStatus(projectDir);
        assert.equal(afterMerge.migration.action, "delta_merged");
        assert.equal(afterMerge.migration.insertedCount, 1);
        assert.equal(fs.existsSync(legacyFile), false);

        const branchRead = readMemoryNode(projectDir, { id: "branch99" });
        assert.equal(branchRead.isError, false);
        assert.match(branchRead.text, /webhook retry timeout/);
    });

    it("3. Quarantines corrupt .ag-memory.json safely without deleting original", () => {
        const corruptProject = path.join(tempRoot, "CorruptApp");
        fs.mkdirSync(corruptProject, { recursive: true });
        const corruptFile = path.join(corruptProject, ".ag-memory.json");
        fs.writeFileSync(corruptFile, "{ invalid json truncated...", "utf8");

        const res = checkMemoryStatus(corruptProject);
        assert.equal(res.initialized, false);
        assert.equal(res.migration.action, "corrupt_quarantined");
        assert.equal(fs.existsSync(corruptFile), true);
        assert.equal(fs.existsSync(res.migration.quarantinePath), true);
        assert.match(res.text, /WARNING/i);
    });

    it("4. Supports atomic batch saves, slug upserts, FTS5 summary/special-char search, and OR fallback", async () => {
        // Batch bootstrap 3 foundational nodes + parallel concurrent saves
        await Promise.all([
            Promise.resolve().then(() =>
                saveProjectMemory(projectDir, {
                    entries: [
                        {
                            title: "Tech Stack & Ecosystem",
                            summary: "Uses Next.js 15, Zustand slices, Neon Postgres, and @google/genai SDK.",
                            tags: ["architecture", "stack"]
                        },
                        {
                            title: "Project Structure & Architecture",
                            summary: "Auth logic lives in src/lib/auth.ts; API routes under app/api.",
                            tags: ["architecture"],
                            files: ["src/lib/auth.ts"]
                        },
                        {
                            title: "Build & Run Instructions",
                            summary: "Run pnpm dev on port 3000; tests via vitest.",
                            tags: ["architecture", "build"]
                        }
                    ]
                })
            ),
            Promise.resolve().then(() =>
                saveProjectMemory(projectDir, {
                    title: "Session Log: Initial Setup",
                    summary: "Configured Neon connection pooling.",
                    tags: ["session", "changelog"]
                })
            )
        ]);

        const status = checkMemoryStatus(projectDir);
        assert.equal(status.totalActive, 4);

        // Search inside summary (which failed in v2!) and with special chars '@google/genai'
        const sdkHits = searchProjectMemory(projectDir, { query: "@google/genai Zustand" });
        assert.equal(sdkHits.matches.length, 1);
        assert.equal(sdkHits.matches[0].slug, "tech-stack");

        // Multi-word OR fallback when one word isn't present
        const orHits = searchProjectMemory(projectDir, { query: "vitest nonexistentwordxyz" });
        assert.ok(orHits.matches.length >= 1);
        assert.equal(orHits.matches[0].slug, "build-run");

        // Idempotent upsert on 'Tech Stack & Ecosystem' updates in-place instead of creating a duplicate!
        saveProjectMemory(projectDir, {
            title: "Tech Stack & Ecosystem",
            summary: "Uses Next.js 15, Zustand, Drizzle ORM, and @google/genai SDK.",
            tags: ["architecture", "stack"]
        });

        const statusAfterUpsert = checkMemoryStatus(projectDir);
        assert.equal(statusAfterUpsert.totalActive, 4);

        const withRevs = readMemoryNode(projectDir, { id: "tech-stack", include_revisions: true });
        assert.match(withRevs.text, /Drizzle ORM/);
        assert.match(withRevs.text, /Prior Revisions/);
        assert.match(withRevs.text, /Neon Postgres/);
    });

    it("5. Supports CRUD, file staleness warnings, dead-end registry, and get_file_memories", () => {
        const saved = saveProjectMemory(projectDir, {
            title: "Auth Token Invariant",
            summary: "Refresh tokens must rotate on every call.",
            category: "decision",
            tags: ["security"],
            files: ["src/lib/auth.ts"]
        });
        const nodeId = saved.results[0].id;

        // Modify src/lib/auth.ts mtime into the future to trigger staleness warning
        const authPath = path.join(projectDir, "src", "lib", "auth.ts");
        const futureTime = new Date(Date.now() + 10000);
        fs.utimesSync(authPath, futureTime, futureTime);

        const readRes = readMemoryNode(projectDir, { id: nodeId });
        assert.match(readRes.text, /\[STALE WARNING\]/);

        // Record & check anti-loop dead-end
        const de = recordDeadEnd(projectDir, {
            error_pattern: "EPERM: operation not permitted, mkdir",
            attempted_solution: "Downgrading Node version",
            root_cause: "Transient Windows sandbox lock; retry command instead",
            files: ["src/lib/auth.ts"]
        });
        assert.match(de.id, /^de-/);

        const deHits = checkDeadEnds(projectDir, { query: "EPERM mkdir" });
        assert.equal(deHits.matches.length, 1);
        assert.match(deHits.text, /DO NOT REPEAT: Downgrading Node version/);

        // File-anchored lookup returns BOTH the decision memory and the dead-end!
        const fileCtx = getFileMemories(projectDir, { file_paths: ["src/lib/auth.ts"] });
        assert.equal(fileCtx.memories.length, 1);
        assert.equal(fileCtx.deadEnds.length, 1);

        // Update & soft-delete
        const upd = updateMemoryNode(projectDir, {
            id: nodeId,
            summary: "Refresh tokens rotate with 30s reuse grace window."
        });
        assert.equal(upd.isError, false);

        const timelineAll = getSessionTimeline(projectDir, { category: "all", limit: 10 });
        assert.equal(timelineAll.entries.length, 1);

        const del = deleteMemoryNode(projectDir, { id: nodeId, hard_delete: false });
        assert.equal(del.isError, false);
        assert.equal(searchProjectMemory(projectDir, { query: "Refresh tokens" }).matches.length, 0);
    });

    it("6. Validates SessionStart hook contract (empty workspace vs active workspace CLI execution)", () => {
        // Empty workspacePaths -> silent {}
        assert.deepEqual(runSessionStartPayload({ workspacePaths: [] }), {});
        assert.deepEqual(runSessionStartPayload({}), {});

        // Seed memory and run hook via real child process stdin/stdout
        saveProjectMemory(projectDir, {
            title: "Tech Stack & Ecosystem",
            summary: "TypeScript + Node 24 SQLite",
            tags: ["architecture"]
        });
        closeAllDatabases();

        const child = spawnSync(
            process.execPath,
            ["--no-warnings", HOOK_JS],
            {
                input: JSON.stringify({
                    conversationId: "test-conv",
                    workspacePaths: [projectDir]
                }),
                encoding: "utf8",
                env: { ...process.env, AG_MEMORY_DATA_DIR: dataDir }
            }
        );

        assert.equal(child.status, 0);
        const parsedOut = JSON.parse(child.stdout.trim());
        assert.ok(Array.isArray(parsedOut.injectSteps));
        assert.match(
            parsedOut.injectSteps[0].systemMessage.systemMessage,
            /AGENT-MEMORY AUTO-HYDRATED/
        );
    });

    it("7. Verifies full MCP Stdio JSON-RPC protocol: 15 tools, readOnlyHint annotations, calls & resources", async () => {
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
            assert.equal(tools.length, 15);

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
