import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { validateProjectPath } from "../../src/paths/remote.js";
import { getProjectStoreInfo } from "../../src/paths/registry.js";
import { closeAllDatabases } from "../../src/db.js";
import { runSessionStartPayload } from "../../src/session-start-hook.js";
import { configureWorkspace, saveProjectMemory } from "../../src/store/index.js";
import { createTempVaultEnv, cleanupTempVaultEnv } from "../helpers/env.js";

describe("Multi-Folder & Remote-Aware SessionStart Hook", () => {
    let tempRoot;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, prevDataDir } = createTempVaultEnv("ag-mem-hook-test-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("6.1 Hydrates initialized primary + secondary folders and prompts on uninitialized secondary", () => {
        const projA = path.join(tempRoot, "hook-a");
        const projB = path.join(tempRoot, "hook-b");
        const projC = path.join(tempRoot, "hook-c");
        fs.mkdirSync(projA, { recursive: true });
        fs.mkdirSync(projB, { recursive: true });
        fs.mkdirSync(projC, { recursive: true });

        saveProjectMemory(projA, {
            title: "Tech Stack & Ecosystem",
            summary: "Primary Node 22 service.",
            tags: ["architecture"]
        });
        saveProjectMemory(projB, {
            title: "Secondary API Gateway",
            summary: "Secondary Express gateway memory.",
            tags: ["architecture"]
        });
        closeAllDatabases();

        const res = runSessionStartPayload({ workspacePaths: [projA, projB, projC] });
        const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        const canonA = validateProjectPath(projA);
        const canonB = validateProjectPath(projB);
        const canonC = validateProjectPath(projC);

        assert.match(msg, /\[AGENT-MEMORY AUTO-HYDRATED\]/);
        assert.ok(msg.includes(canonA));
        assert.ok(msg.includes("Primary Node 22 service."));

        assert.match(msg, /Secondary Workspace/);
        assert.ok(msg.includes(canonB));
        assert.ok(msg.includes("Secondary API Gateway"));

        assert.match(msg, /\[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED\]/);
        assert.ok(msg.includes(canonC));
        assert.match(msg, /\bindependent\b/);
        assert.match(msg, /\blinked\b/);
        assert.match(msg, /\bignored\b/);
        assert.match(msg, /configure_workspace/);

        assert.equal(fs.existsSync(getProjectStoreInfo(projC).dbPath), false);
    });

    it("6.2 Collapses plain nested subfolder, preserves initialized subfolder store, and preserves git submodule with distinct gitCommonDir", () => {
        const parent = path.join(tempRoot, "mono-parent");
        const plainSub = path.join(parent, "plain-sub");
        const initSub = path.join(parent, "init-sub");
        const submodule = path.join(parent, "submod");
        const submoduleGitStore = path.join(parent, ".git", "modules", "submod");

        fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
        fs.mkdirSync(plainSub, { recursive: true });
        fs.mkdirSync(initSub, { recursive: true });
        fs.mkdirSync(submodule, { recursive: true });
        fs.mkdirSync(submoduleGitStore, { recursive: true });

        fs.writeFileSync(
            path.join(parent, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/mono-parent.git\n',
            "utf8"
        );
        fs.writeFileSync(
            path.join(submoduleGitStore, "config"),
            '[remote "origin"]\n\turl = https://github.com/org/nested-submodule.git\n',
            "utf8"
        );
        fs.writeFileSync(path.join(submodule, ".git"), "gitdir: ../.git/modules/submod\n", "utf8");

        saveProjectMemory(parent, {
            title: "Tech Stack & Ecosystem",
            summary: "Monorepo parent memory.",
            tags: ["architecture"]
        });
        saveProjectMemory(initSub, {
            title: "Init Sub Service",
            summary: "Initialized subfolder store memory.",
            tags: ["architecture"]
        });
        closeAllDatabases();

        const res = runSessionStartPayload({
            workspacePaths: [parent, plainSub, initSub, submodule]
        });
        const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        const canonPlainSub = validateProjectPath(plainSub);
        const canonInitSub = validateProjectPath(initSub);
        const canonSubmodule = validateProjectPath(submodule);

        assert.match(msg, /\[AGENT-MEMORY AUTO-HYDRATED\]/);
        assert.equal(msg.includes(canonPlainSub), false, "plain nested subfolder should be collapsed");

        assert.match(msg, /Secondary Workspace/);
        assert.ok(msg.includes(canonInitSub), "initialized subfolder store must be preserved");
        assert.ok(msg.includes("Initialized subfolder store memory."));

        assert.match(msg, /\[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED\]/);
        assert.ok(msg.includes(canonSubmodule), "git submodule with distinct gitCommonDir must be preserved");
    });

    it("6.3 Respects ignored and linked policies on secondary without suppressing standalone primary open", () => {
        const projA = path.join(tempRoot, "pol-a");
        const projB = path.join(tempRoot, "pol-b");
        const projC = path.join(tempRoot, "pol-c");
        fs.mkdirSync(projA, { recursive: true });
        fs.mkdirSync(projB, { recursive: true });
        fs.mkdirSync(projC, { recursive: true });

        saveProjectMemory(projA, {
            title: "Alpha Primary Memory",
            summary: "Primary workspace A.",
            tags: ["architecture"]
        });
        saveProjectMemory(projB, {
            title: "Bravo Standalone Memory",
            summary: "Standalone workspace B.",
            tags: ["architecture"]
        });
        closeAllDatabases();

        configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: projB,
            mode: "ignored"
        });
        configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: projC,
            mode: "linked",
            folder_slug: "charlie"
        });

        const multiRes = runSessionStartPayload({ workspacePaths: [projA, projB, projC] });
        const multiMsg = multiRes?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        const canonB = validateProjectPath(projB);
        const canonC = validateProjectPath(projC);

        assert.match(multiMsg, /\[AGENT-MEMORY AUTO-HYDRATED\]/);
        assert.ok(multiMsg.includes("Alpha Primary Memory"));
        assert.equal(multiMsg.includes("Bravo Standalone Memory"), false, "ignored secondary must not hydrate");
        assert.match(multiMsg, /Ignored secondary/i);
        assert.ok(multiMsg.includes(canonB));
        assert.ok(multiMsg.includes(canonC));
        assert.ok(multiMsg.includes("@charlie/"));
        assert.equal(multiMsg.includes("[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]"), false);

        // Standalone open of B must still hydrate normally
        const standaloneRes = runSessionStartPayload({ workspacePaths: [projB] });
        const standaloneMsg = standaloneRes?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        assert.match(standaloneMsg, /\[AGENT-MEMORY AUTO-HYDRATED\]/);
        assert.ok(standaloneMsg.includes(canonB));
        assert.ok(standaloneMsg.includes("Bravo Standalone Memory"));
    });

    it("6.4 Emits LINKED-ORDER NOTICE on reordered [B, A], REMOTE WORKSPACE on uninitialized remote URI, and CLONE DISAMBIGUATION on duplicate live clone", () => {
        // 1) Reordered [B, A]
        const projA = path.join(tempRoot, "order-a");
        const projB = path.join(tempRoot, "order-b");
        fs.mkdirSync(projA, { recursive: true });
        fs.mkdirSync(projB, { recursive: true });

        saveProjectMemory(projA, {
            title: "Primary A Store",
            summary: "Main store for A and linked B.",
            tags: ["architecture"]
        });
        configureWorkspace({
            action: "set_folder_policy",
            primary_path: projA,
            folder_path: projB,
            mode: "linked",
            folder_slug: "lib-b"
        });
        closeAllDatabases();

        const reorderedRes = runSessionStartPayload({ workspacePaths: [projB, projA] });
        const reorderedMsg = reorderedRes?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        assert.match(reorderedMsg, /\[AGENT-MEMORY LINKED-ORDER NOTICE\]/);
        assert.ok(reorderedMsg.includes("@lib-b/"));
        assert.ok(reorderedMsg.includes(validateProjectPath(projA)));
        assert.match(reorderedMsg, /Secondary Workspace/);
        assert.ok(reorderedMsg.includes("Primary A Store"));

        // 2) Uninitialized remote URI
        const remoteUri = "ssh://dev.box/srv/remote-app";
        const remoteRes = runSessionStartPayload({ workspacePaths: [remoteUri] });
        const remoteMsg = remoteRes?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        assert.match(remoteMsg, /\[AGENT-MEMORY REMOTE WORKSPACE\]/);
        assert.match(remoteMsg, /git_remote/);
        assert.match(remoteMsg, /check_memory_status/);
        assert.equal(fs.existsSync(getProjectStoreInfo(remoteUri).dbPath), false);

        // 3) Duplicate live clone
        const clone1 = path.join(tempRoot, "hook-clone-1");
        const clone2 = path.join(tempRoot, "hook-clone-2");
        for (const dir of [clone1, clone2]) {
            fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
            fs.writeFileSync(
                path.join(dir, ".git", "config"),
                '[remote "origin"]\n\turl = https://github.com/org/dup-hook-repo.git\n',
                "utf8"
            );
        }
        saveProjectMemory(clone1, {
            title: "Clone 1 Arch",
            summary: "Original clone.",
            tags: ["architecture"]
        });
        closeAllDatabases();

        const cloneRes = runSessionStartPayload({ workspacePaths: [clone2] });
        const cloneMsg = cloneRes?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        assert.match(cloneMsg, /\[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED\]/);
        assert.ok(cloneMsg.includes(validateProjectPath(clone1)));
    });

    it("6.5 Review Focus #5: Isolates invalid/missing secondary path and caps secondary hydration at 4 folders", () => {
        const primary = path.join(tempRoot, "cap-primary");
        const missingDir = path.join(tempRoot, "does-not-exist-secondary");
        const secondaries = [];
        for (let i = 1; i <= 6; i++) {
            const dir = path.join(tempRoot, `cap-sec-${i}`);
            fs.mkdirSync(dir, { recursive: true });
            secondaries.push(dir);
            saveProjectMemory(dir, {
                title: `Secondary ${i} Arch`,
                summary: `Hydrated body for secondary folder ${i}.`,
                tags: ["architecture"]
            });
        }
        fs.mkdirSync(primary, { recursive: true });
        saveProjectMemory(primary, {
            title: "Primary Cap Arch",
            summary: "Primary workspace body.",
            tags: ["architecture"]
        });
        closeAllDatabases();

        const res = runSessionStartPayload({
            workspacePaths: [primary, missingDir, secondaries[0] + path.sep, ...secondaries]
        });
        const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage || "";

        assert.match(msg, /\[AGENT-MEMORY AUTO-HYDRATED\]/);
        assert.ok(msg.includes("Primary workspace body."));

        // First 4 valid secondaries hydrate
        for (let i = 1; i <= 4; i++) {
            assert.ok(msg.includes(validateProjectPath(secondaries[i - 1])), `s${i} should be present`);
            assert.ok(msg.includes(`Hydrated body for secondary folder ${i}.`), `s${i} should hydrate`);
        }

        // 5th & 6th secondaries are capped and listed as on-demand without hydrating their bodies
        for (let i = 5; i <= 6; i++) {
            const canonOverflow = validateProjectPath(secondaries[i - 1]);
            assert.ok(msg.includes(canonOverflow), `s${i} should be listed on-demand`);
            assert.equal(msg.includes(`Hydrated body for secondary folder ${i}.`), false, `s${i} body must not hydrate`);
        }
        assert.match(msg, /on-demand/i);
        assert.match(msg, /check_memory_status/);

        const secondaryHeaderMatches = msg.match(/=== Secondary Workspace /g) || [];
        assert.equal(secondaryHeaderMatches.length, 4, "must cap secondary hydration at exactly 4");
    });

    it("6.6 Emits clone disambiguation banner only once for uninitialized independent secondary clone", () => {
        const primary = path.join(tempRoot, "ind-dup-primary");
        const clone1 = path.join(tempRoot, "ind-dup-clone1");
        const clone2 = path.join(tempRoot, "ind-dup-clone2");
        fs.mkdirSync(primary, { recursive: true });
        for (const dir of [clone1, clone2]) {
            fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
            fs.writeFileSync(
                path.join(dir, ".git", "config"),
                '[remote "origin"]\n\turl = https://github.com/org/ind-dup-repo.git\n',
                "utf8"
            );
        }

        saveProjectMemory(primary, { title: "Primary App", summary: "Primary body." });
        saveProjectMemory(clone1, { title: "Clone 1 App", summary: "Clone 1 body." });
        configureWorkspace({
            action: "set_folder_policy",
            primary_path: primary,
            folder_path: clone2,
            mode: "independent"
        });
        closeAllDatabases();

        const res = runSessionStartPayload({ workspacePaths: [primary, clone2] });
        const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        const bannerMatches = msg.match(/\[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED\]/g) || [];
        assert.equal(bannerMatches.length, 1);
        assert.match(msg, /Secondary Workspace .* \(independent\)/);
    });
});
