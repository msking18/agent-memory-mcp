import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { getProjectStoreInfo } from "../../src/paths/registry.js";
import {
    configureWorkspace,
    resolveStoreLinkedFolders,
    checkEntryFileStaleness,
    checkMemoryStatus,
    saveProjectMemory,
    readMemoryNode,
    updateMemoryNode,
    recordDeadEnd,
    checkDeadEnds
} from "../../src/store/index.js";
import * as storeFacade from "../../src/store.js";
import { createTempVaultEnv, cleanupTempVaultEnv } from "../helpers/env.js";

describe("Store Guardrails, Remote-Safe Prep/Staleness, & Cross-Folder Writes", () => {
    let tempRoot;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, prevDataDir } = createTempVaultEnv("ag-mem-store-guard-test-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("5.1 Remote store skips legacy migration and returns skippedRemote: true from staleness check", () => {
        assert.equal(storeFacade.configureWorkspace, configureWorkspace);
        assert.equal(storeFacade.resolveStoreLinkedFolders, resolveStoreLinkedFolders);

        const remotePath = "ssh://dev/home/app";
        const remoteUrl = "https://github.com/org/app.git";

        // Calling checkMemoryStatus with git_remote persists remote URI -> gitIdentity binding without creating empty .db
        const initialStatus = checkMemoryStatus(remotePath, { git_remote: remoteUrl });
        assert.equal(initialStatus.initialized, false);
        assert.equal(initialStatus.storeInfo.isRemote, true);
        assert.equal(initialStatus.storeInfo.gitIdentity, "github.com/org/app");
        assert.equal(fs.existsSync(initialStatus.storeInfo.dbPath), false);

        const resolvedLater = getProjectStoreInfo(remotePath);
        assert.equal(resolvedLater.storeKey, initialStatus.storeInfo.storeKey);
        assert.equal(resolvedLater.gitIdentity, "github.com/org/app");

        // Saving and reading on remote URI skips legacy .ag-memory.json migration and sets skippedRemote: true
        const saved = saveProjectMemory(remotePath, {
            title: "Remote App Architecture",
            summary: "Deployed via SSH container.",
            category: "architecture",
            files: ["ssh://dev/home/app/src/index.ts", "/home/app/src/routes.ts"],
            git_remote: remoteUrl
        });
        assert.equal(saved.isError, false);
        assert.deepEqual(saved.results[0].files, ["src/index.ts", "src/routes.ts"]);

        const readRes = readMemoryNode(remotePath, { id: saved.results[0].id });
        assert.equal(readRes.isError, false);
        assert.equal(readRes.nodes.length, 1);
        assert.deepEqual(readRes.nodes[0].staleFiles, []);
        assert.deepEqual(readRes.nodes[0].missingFiles, []);
        assert.equal(readRes.nodes[0].skippedRemote, true);

        const directStale = checkEntryFileStaleness(
            remotePath,
            ["src/index.ts"],
            new Date(0).toISOString(),
            { isRemote: true }
        );
        assert.deepEqual(directStale, { staleFiles: [], missingFiles: [], skippedRemote: true });
    });

    it("5.2 Staleness check stats linked @<slug>/ files on disk and skips unlinked/unknown @<slug>/ anchors", () => {
        const projA = path.join(tempRoot, "proj-a-stale");
        const toolB = path.join(tempRoot, "tool-b-stale");
        const removedC = path.join(tempRoot, "removed-c-stale");
        fs.mkdirSync(path.join(projA, ".git"), { recursive: true });
        fs.mkdirSync(path.join(toolB, "src"), { recursive: true });
        fs.mkdirSync(removedC, { recursive: true });

        fs.writeFileSync(
            path.join(projA, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/proj-a-stale.git\n',
            "utf8"
        );
        const toolBFile = path.join(toolB, "src", "b.ts");
        const removedFile = path.join(removedC, "old.ts");
        fs.writeFileSync(toolBFile, "export const b = 1;\n", "utf8");
        fs.writeFileSync(removedFile, "export const old = 1;\n", "utf8");

        const policyB = configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: toolB,
            mode: "linked",
            folder_slug: "tool-b"
        });
        assert.equal(policyB.isError, false);
        assert.equal(policyB.folderSlug, "tool-b");

        const policyC = configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: removedC,
            mode: "linked",
            folder_slug: "removed-slug"
        });
        assert.equal(policyC.isError, false);

        const saved = saveProjectMemory(projA, {
            title: "Linked Tool Dependencies",
            summary: "Uses tool-b and legacy removed-slug helper.",
            files: [toolBFile, removedFile]
        });
        assert.equal(saved.isError, false);
        assert.deepEqual(saved.results[0].files, ["@tool-b/src/b.ts", "@removed-slug/old.ts"]);

        // Unlink removedC so @removed-slug/ is no longer an active linked folder
        const unlinkC = configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: removedC,
            mode: "ignored"
        });
        assert.equal(unlinkC.isError, false);

        // Touch B/src/b.ts into the future -> @tool-b/src/b.ts flagged stale, @removed-slug/old.ts skipped cleanly
        const futureTime = new Date(Date.now() + 10000);
        fs.utimesSync(toolBFile, futureTime, futureTime);

        const readRes = readMemoryNode(projA, { id: saved.results[0].id });
        assert.equal(readRes.isError, false);
        assert.deepEqual(readRes.nodes[0].staleFiles, ["@tool-b/src/b.ts"]);
        assert.deepEqual(readRes.nodes[0].missingFiles, []);
        assert.match(readRes.text, /\[STALE WARNING\].*@tool-b\/src\/b\.ts/);
        assert.ok(!readRes.text.includes("no longer exist on disk"));

        // Worktree of projA also resolves linked folders via canonicalPath/aliases of projects[storeKey]
        const wtMeta = path.join(projA, ".git", "worktrees", "wt-stale");
        const wtDir = path.join(tempRoot, "proj-a-wt-stale");
        fs.mkdirSync(wtMeta, { recursive: true });
        fs.mkdirSync(wtDir, { recursive: true });
        fs.writeFileSync(path.join(wtMeta, "commondir"), "../..\n", "utf8");
        fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${wtMeta}\n`, "utf8");

        const wtRead = readMemoryNode(wtDir, { id: saved.results[0].id });
        assert.equal(wtRead.isError, false);
        assert.deepEqual(wtRead.nodes[0].staleFiles, ["@tool-b/src/b.ts"]);
        assert.deepEqual(wtRead.nodes[0].missingFiles, []);
    });

    it("5.3 Cross-folder write guardrail aborts single save, batch entries[] atomically, updateMemoryNode, and recordDeadEnd; allow_external_files: true overrides", () => {
        const projA = path.join(tempRoot, "guard-proj-a");
        const projB = path.join(tempRoot, "guard-proj-b");
        fs.mkdirSync(path.join(projA, "src"), { recursive: true });
        fs.mkdirSync(path.join(projB, "src"), { recursive: true });

        const fileA = path.join(projA, "src", "a.ts");
        const fileB = path.join(projB, "src", "b.ts");
        fs.writeFileSync(fileA, "export const a = 1;\n", "utf8");
        fs.writeFileSync(fileB, "export const b = 2;\n", "utf8");

        // Initialize B so B owns fileB in projects_index.json
        const savedB = saveProjectMemory(projB, {
            title: "Project B Core",
            summary: "Project B module.",
            files: ["src/b.ts"]
        });
        assert.equal(savedB.isError, false);
        const infoB = getProjectStoreInfo(projB);

        // 1) Single saveProjectMemory on A referencing B's file -> blocked with B named as owner
        const singleBlocked = saveProjectMemory(projA, {
            title: "Cross-Folder Single",
            summary: "References B.",
            files: [fileB]
        });
        assert.equal(singleBlocked.isError, true);
        assert.ok(singleBlocked.text.includes(infoB.canonicalPath));
        assert.equal(checkMemoryStatus(projA).initialized, false);

        // 2) Batch entries[] [validEntry, externalBFileEntry] -> atomic abort, zero rows written to A
        const batchBlocked = saveProjectMemory(projA, {
            entries: [
                {
                    title: "Tech Stack & Ecosystem",
                    summary: "Valid entry in A.",
                    tags: ["architecture"],
                    files: ["src/a.ts"]
                },
                {
                    title: "Project Structure & Architecture",
                    summary: "Invalid external ref to B.",
                    tags: ["architecture"],
                    files: [fileB]
                }
            ]
        });
        assert.equal(batchBlocked.isError, true);
        assert.ok(batchBlocked.text.includes(infoB.canonicalPath));
        const statusAfterAbort = checkMemoryStatus(projA);
        assert.equal(statusAfterAbort.initialized, false);
        assert.equal(fs.existsSync(statusAfterAbort.storeInfo.dbPath), false);

        // Retry batch with allow_external_files: true -> succeeds atomically
        const batchAllowed = saveProjectMemory(projA, {
            entries: [
                {
                    title: "Tech Stack & Ecosystem",
                    summary: "Valid entry in A.",
                    tags: ["architecture"],
                    files: ["src/a.ts"]
                },
                {
                    title: "External Bridge Note",
                    summary: "Explicitly allowed external ref to B.",
                    files: [fileB]
                }
            ],
            allow_external_files: true
        });
        assert.equal(batchAllowed.isError, false);
        assert.equal(batchAllowed.results.length, 2);
        const targetNodeId = batchAllowed.results[0].id;

        // 3) updateMemoryNode referencing B's file -> blocked until allow_external_files: true
        const updateBlocked = updateMemoryNode(projA, {
            id: targetNodeId,
            files: [fileB]
        });
        assert.equal(updateBlocked.isError, true);
        assert.ok(updateBlocked.text.includes(infoB.canonicalPath));
        assert.deepEqual(readMemoryNode(projA, { id: targetNodeId }).nodes[0].files, ["src/a.ts"]);

        const updateAllowed = updateMemoryNode(projA, {
            id: targetNodeId,
            files: [fileB],
            allow_external_files: true
        });
        assert.equal(updateAllowed.isError, false);

        // 4) recordDeadEnd referencing B's file -> blocked until allow_external_files: true
        const deBlocked = recordDeadEnd(projA, {
            error_pattern: "Cross-folder failure",
            attempted_solution: "Edited B from A",
            root_cause: "B has strict validation",
            files: [fileB]
        });
        assert.equal(deBlocked.isError, true);
        assert.ok(deBlocked.text.includes(infoB.canonicalPath));
        assert.equal(checkDeadEnds(projA).matches.length, 0);

        const deAllowed = recordDeadEnd(projA, {
            error_pattern: "Cross-folder failure",
            attempted_solution: "Edited B from A",
            root_cause: "B has strict validation",
            files: [fileB],
            allow_external_files: true
        });
        assert.equal(deAllowed.isError, false);
        assert.equal(checkDeadEnds(projA).matches.length, 1);
    });
});
