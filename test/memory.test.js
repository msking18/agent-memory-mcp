import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { closeAllDatabases } from "../src/db.js";
import { validateProjectPath, getProjectStoreInfo } from "../src/paths.js";
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

    it("1. Rejects relative paths ('./') and normalizes Windows casing to identical store keys", () => {
        assert.throws(() => validateProjectPath("./"), /relative paths/i);
        assert.throws(() => validateProjectPath("relative/folder"), /relative paths/i);
        assert.throws(
            () => validateProjectPath(path.join(tempRoot, "non-existent-folder")),
            /does not exist/i
        );

        const infoUpper = getProjectStoreInfo(projectDir.toUpperCase());
        const infoLower = getProjectStoreInfo(projectDir.toLowerCase());
        assert.equal(infoUpper.storeKey, infoLower.storeKey);
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

    it("7. Verifies full MCP Stdio JSON-RPC protocol: 10 tools, readOnlyHint annotations, calls & resources", async () => {
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
            assert.equal(tools.length, 10);

            const statusTool = tools.find((t) => t.name === "check_memory_status");
            assert.equal(statusTool?.annotations?.readOnlyHint, true);

            const saveRes = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projectDir,
                    title: "Tech Stack & Ecosystem",
                    summary: "Hono + Cloudflare Workers",
                    tags: ["architecture"]
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

            const { resources } = await client.listResources();
            assert.ok(resources.some((r) => r.uri === "memory://projects"));

            const resContent = await client.readResource({ uri: "memory://projects" });
            const indexJson = JSON.parse(resContent.contents[0].text);
            assert.equal(Object.keys(indexJson.projects).length, 1);
        } finally {
            await client.close();
        }
    });
});
