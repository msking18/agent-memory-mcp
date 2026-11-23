import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
    getProjectsIndexPath,
    updateProjectsIndex,
    getProjectStoreInfo
} from "../../src/paths/registry.js";
import {
    configureWorkspace,
    resolveStoreLinkedFolders,
    checkEntryFileStaleness,
    checkMemoryStatus,
    saveProjectMemory,
    readMemoryNode,
    recordDeadEnd,
    checkDeadEnds,
    getFileMemories
} from "../../src/store/index.js";
import { createTempVaultEnv, cleanupTempVaultEnv } from "../helpers/env.js";

describe("Linked-Folder Reads, Clone Disambiguation Guardrail & configureWorkspace Controller", () => {
    let tempRoot;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, prevDataDir } = createTempVaultEnv("ag-mem-store-clones-test-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("5.4 Linked-folder read queries normalize B paths to @<folderSlug>/ in getFileMemories and checkDeadEnds", () => {
        const projA = path.join(tempRoot, "read-proj-a");
        const toolB = path.join(tempRoot, "read-tool-b");
        fs.mkdirSync(path.join(projA, "src"), { recursive: true });
        fs.mkdirSync(path.join(toolB, "src"), { recursive: true });

        const fileB = path.join(toolB, "src", "b.ts");
        const fileA = path.join(projA, "src", "b.ts");
        fs.writeFileSync(fileB, "export const b = true;\n", "utf8");
        fs.writeFileSync(fileA, "export const a = true;\n", "utf8");

        const policy = configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: toolB,
            mode: "linked",
            folder_slug: "tool-b"
        });
        assert.equal(policy.isError, false);

        const memB = saveProjectMemory(projA, {
            title: "Tool B Parser Invariant",
            summary: "Must preserve UTF-8 BOM.",
            category: "decision",
            files: [fileB]
        });
        assert.equal(memB.isError, false);
        assert.deepEqual(memB.results[0].files, ["@tool-b/src/b.ts"]);

        const deB = recordDeadEnd(projA, {
            error_pattern: "Parser strips trailing newline",
            attempted_solution: "Trimmed whole buffer",
            root_cause: "Corrupts lockfile hash",
            files: [fileB]
        });
        assert.equal(deB.isError, false);

        const fileMemRes = getFileMemories(projA, { file_paths: [fileB] });
        assert.equal(fileMemRes.memories.length, 1);
        assert.equal(fileMemRes.memories[0].id, memB.results[0].id);
        assert.equal(fileMemRes.deadEnds.length, 1);
        assert.equal(fileMemRes.deadEnds[0].id, deB.id);

        const deCheckB = checkDeadEnds(projA, { file_path: fileB });
        assert.equal(deCheckB.matches.length, 1);
        assert.equal(deCheckB.matches[0].id, deB.id);

        // Querying projA's own src/b.ts must not falsely match @tool-b/src/b.ts
        const deCheckA = checkDeadEnds(projA, { file_path: fileA });
        assert.equal(deCheckA.matches.length, 0);
    });

    it("5.5 Clone-disambiguation guardrail blocks accidental bootstrap unless force_isolate: true or configureWorkspace; checkMemoryStatus surfaces [CONFLICT]", () => {
        const clone1 = path.join(tempRoot, "live-clone-1");
        const clone2 = path.join(tempRoot, "live-clone-2");
        const clone3 = path.join(tempRoot, "live-clone-3");
        for (const dir of [clone1, clone2, clone3]) {
            fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
            fs.writeFileSync(
                path.join(dir, ".git", "config"),
                '[remote "origin"]\n\turl = https://github.com/org/starter-template.git\n',
                "utf8"
            );
        }

        const c1Saved = saveProjectMemory(clone1, {
            title: "Tech Stack & Ecosystem",
            summary: "Starter clone 1.",
            tags: ["architecture"]
        });
        assert.equal(c1Saved.isError, false);

        // Simultaneous live clone2 status surfaces CLONE DISAMBIGUATION REQUIRED
        const c2Status = checkMemoryStatus(clone2);
        assert.equal(c2Status.initialized, false);
        assert.ok(c2Status.duplicateCloneCandidate);
        assert.match(c2Status.text, /\[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED\]/);

        // Writing to clone2 without force_isolate or configureWorkspace is blocked before DB creation
        const c2SaveBlocked = saveProjectMemory(clone2, {
            title: "Tech Stack & Ecosystem",
            summary: "Accidental bootstrap."
        });
        assert.equal(c2SaveBlocked.isError, true);
        assert.match(c2SaveBlocked.text, /CLONE DISAMBIGUATION/i);
        assert.equal(fs.existsSync(getProjectStoreInfo(clone2).dbPath), false);

        const c2DeBlocked = recordDeadEnd(clone2, {
            error_pattern: "Clone error",
            attempted_solution: "Ignored warning",
            root_cause: "Needs disambiguation"
        });
        assert.equal(c2DeBlocked.isError, true);
        assert.equal(fs.existsSync(getProjectStoreInfo(clone2).dbPath), false);

        // Retrying saveProjectMemory with force_isolate: true isolates and succeeds
        const c2Forced = saveProjectMemory(clone2, {
            title: "Tech Stack & Ecosystem",
            summary: "Isolated clone 2.",
            tags: ["architecture"],
            force_isolate: true
        });
        assert.equal(c2Forced.isError, false);
        assert.notEqual(c2Forced.storeInfo.storeKey, c1Saved.storeInfo.storeKey);
        assert.equal(checkMemoryStatus(clone2).duplicateCloneCandidate, null);

        // Resolving clone3 via configureWorkspace({ action: "link_project_identity", isolate: true })
        const c3Link = configureWorkspace({
            action: "link_project_identity",
            project_path: clone3,
            isolate: true
        });
        assert.equal(c3Link.isError, false);
        assert.equal(c3Link.action, "isolated");

        const c3Save = saveProjectMemory(clone3, {
            title: "Tech Stack & Ecosystem",
            summary: "Isolated clone 3 via configureWorkspace.",
            tags: ["architecture"]
        });
        assert.equal(c3Save.isError, false);

        // Duplicate gitIdentity collision surfaces [CONFLICT] in checkMemoryStatus and configureWorkspace inspect
        const storeOne = path.join(tempRoot, "conflict-store-one");
        const storeTwo = path.join(tempRoot, "conflict-store-two");
        fs.mkdirSync(storeOne, { recursive: true });
        fs.mkdirSync(path.join(storeTwo, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(storeTwo, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/conflict-repo.git\n',
            "utf8"
        );

        saveProjectMemory(storeOne, { title: "One", summary: "Store one initialized." });
        const s2Save = saveProjectMemory(storeTwo, { title: "Two", summary: "Store two owns git." });

        fs.mkdirSync(path.join(storeOne, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(storeOne, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/conflict-repo.git\n',
            "utf8"
        );

        const conflictStatus = checkMemoryStatus(storeOne);
        assert.equal(conflictStatus.initialized, true);
        assert.ok(conflictStatus.gitIdentityConflict);
        assert.equal(conflictStatus.gitIdentityConflict.conflictingStoreKey, s2Save.storeInfo.storeKey);
        assert.match(conflictStatus.text, /\[CONFLICT\]/);

        const inspectRes = configureWorkspace({
            action: "inspect",
            project_path: storeOne,
            workspace_paths: [storeOne, storeTwo]
        });
        assert.equal(inspectRes.isError, false);
        assert.match(inspectRes.text, /\[CONFLICT\]/);

        // configureWorkspace returns structured { isError: true, text } on invalid action/args
        assert.equal(configureWorkspace({ action: "bogus" }).isError, true);
        assert.equal(configureWorkspace({ action: "set_folder_policy", primary_path: storeOne }).isError, true);
        assert.equal(configureWorkspace({ action: "inspect" }).isError, true);
        assert.equal(configureWorkspace({ action: "link_project_identity", project_path: storeOne }).isError, true);
    });

    it("5.6 Skips remote URIs and traversal '@slug/' anchors in staleness checks, reads index once in resolveStoreLinkedFolders, and requires strict isolate === true", (t) => {
        const projA = path.join(tempRoot, "guard-stale-a");
        const toolB = path.join(tempRoot, "guard-stale-b");
        fs.mkdirSync(path.join(projA, "src"), { recursive: true });
        fs.mkdirSync(path.join(toolB, "src"), { recursive: true });
        fs.writeFileSync(path.join(toolB, "src", "ok.ts"), "export const ok = 1;\n", "utf8");

        configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: toolB,
            mode: "linked",
            folder_slug: "tool-b"
        });

        const savedRemoteRef = saveProjectMemory(projA, {
            title: "Bridge With Remote Ref",
            summary: "Allowed remote URI + WSL UNC in local workspace.",
            files: ["ssh://dev/home/app/src/index.ts", "\\\\wsl.localhost\\Ubuntu\\home\\dev\\file.ts"],
            allow_external_files: true
        });
        assert.equal(savedRemoteRef.isError, false);

        const readRemoteRef = readMemoryNode(projA, { id: savedRemoteRef.results[0].id });
        assert.equal(readRemoteRef.isError, false);
        assert.deepEqual(readRemoteRef.nodes[0].missingFiles, []);
        assert.deepEqual(readRemoteRef.nodes[0].staleFiles, []);
        assert.equal(readRemoteRef.text.includes("[STALE WARNING]"), false);

        // Direct checkEntryFileStaleness: remote URIs, WSL UNC, and traversal @<slug>/ paths are skipped cleanly
        const outsideSecret = path.join(tempRoot, "outside-secret.txt");
        fs.writeFileSync(outsideSecret, "secret", "utf8");
        const futureTime = new Date(Date.now() + 60000);
        fs.utimesSync(outsideSecret, futureTime, futureTime);

        const infoA = getProjectStoreInfo(projA);
        const infoB = getProjectStoreInfo(toolB);
        const linkedMap = new Map([["tool-b", { folderSlug: "tool-b", canonicalPath: infoB.canonicalPath, isRemote: false }]]);
        const stalenessRes = checkEntryFileStaleness(
            infoA.canonicalPath,
            [
                "ssh://dev/home/app/src/index.ts",
                "\\\\wsl.localhost\\Ubuntu\\home\\dev\\file.ts",
                "@tool-b/../../etc/passwd",
                "@tool-b/../outside-secret.txt",
                "@tool-b/sub/../../etc/passwd",
                "@tool-b//etc/passwd",
                "@tool-b/C:/Windows/win.ini",
                "@tool-b/src/ok.ts"
            ],
            new Date(Date.now() + 1000).toISOString(),
            { linkedFoldersBySlug: linkedMap }
        );
        assert.deepEqual(stalenessRes.missingFiles, []);
        assert.deepEqual(stalenessRes.staleFiles, []);

        // resolveStoreLinkedFolders reads projects_index.json once even with multiple aliases
        updateProjectsIndex((idx) => {
            idx.projects[infoA.storeKey].aliases.push("/tmp/alias-1", "/tmp/alias-2", "/tmp/alias-3");
        });
        const indexPath = getProjectsIndexPath();
        let indexReadCount = 0;
        const origReadFileSync = fs.readFileSync;
        const readSpy = t.mock.method(fs, "readFileSync", (target, ...args) => {
            if (target === indexPath) indexReadCount++;
            return origReadFileSync.call(fs, target, ...args);
        });
        const linked = resolveStoreLinkedFolders(infoA);
        readSpy.mock.restore();
        assert.equal(linked.length, 1);
        assert.equal(indexReadCount, 1);

        // Non-boolean truthy isolate ("false") must NOT trigger isolate: true
        const nonBoolIso = configureWorkspace({
            action: "link_project_identity",
            project_path: projA,
            isolate: "false"
        });
        assert.equal(nonBoolIso.isError, true);
        assert.match(nonBoolIso.text, /requires isolate: true/i);
    });
});
