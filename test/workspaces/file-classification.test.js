import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    updateProjectsIndex,
    getProjectStoreInfo,
    registerProjectInIndex,
    setWorkspaceFolderPolicy
} from "../../src/paths/registry.js";
import { normalizeWorkspaceRelativePath } from "../../src/paths/files.js";
import { classifyWorkspaceFiles } from "../../src/paths/classifier.js";
import * as pathsFacade from "../../src/paths.js";
import { createTempVaultEnv, cleanupTempVaultEnv } from "../helpers/env.js";

describe("Workspace File Classification, Symlink/file:// Resolution, & Remote/Linked Normalization", () => {
    let tempRoot;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, prevDataDir } = createTempVaultEnv("ag-mem-files-test-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("4.1 Normalizes remote URI and POSIX paths in normalizeWorkspaceRelativePath without Windows C:\\ corruption", (t) => {
        assert.equal(pathsFacade.normalizeWorkspaceRelativePath, normalizeWorkspaceRelativePath);
        assert.equal(pathsFacade.classifyWorkspaceFiles, classifyWorkspaceFiles);

        const realpathSpy = t.mock.method(fs, "realpathSync");
        const statSpy = t.mock.method(fs, "statSync");

        const canonicalRemote = "ssh://dev/workspaces/app";
        assert.equal(
            normalizeWorkspaceRelativePath(canonicalRemote, "ssh://dev/workspaces/app/src/index.ts"),
            "src/index.ts"
        );
        assert.equal(
            normalizeWorkspaceRelativePath(canonicalRemote, "/workspaces/app/src/index.ts"),
            "src/index.ts"
        );
        assert.equal(
            normalizeWorkspaceRelativePath(canonicalRemote, "./src/lib/db.ts", { isRemote: true }),
            "src/lib/db.ts"
        );
        assert.equal(normalizeWorkspaceRelativePath(canonicalRemote, "ssh://dev/workspaces/app"), null);

        // Remote classification must never touch fs.realpathSync or fs.statSync
        const remoteStore = getProjectStoreInfo(canonicalRemote);
        const classified = classifyWorkspaceFiles(remoteStore, [
            "ssh://dev/workspaces/app/src/index.ts",
            "/workspaces/app/src/routes.ts",
            "./src/lib/db.ts",
            "\\\\wsl.localhost\\Ubuntu\\home\\dev\\other.ts"
        ]);
        assert.deepEqual(classified.inWorkspace, ["src/index.ts", "src/routes.ts", "src/lib/db.ts"]);
        assert.equal(classified.externalFiles.length, 1);
        assert.equal(classified.externalFiles[0].ownerCandidate, null);
        assert.equal(realpathSpy.mock.callCount(), 0);
        assert.equal(statSpy.mock.callCount(), 0);
    });

    it("4.2 Unwraps file:// URIs and resolves symlinks/junctions inside workspace without flagging external", () => {
        const realWs = path.join(tempRoot, "real-ws");
        const realSrc = path.join(realWs, "src");
        fs.mkdirSync(realSrc, { recursive: true });
        fs.writeFileSync(path.join(realSrc, "index.ts"), "export const x = 1;\n", "utf8");

        const storeInfo = getProjectStoreInfo(realWs);

        const inputs = [
            pathToFileURL(path.join(realSrc, "index.ts")).href,
            pathToFileURL(path.join(realWs, "nonexistent", "new-file.ts")).href
        ];

        const linkWs = path.join(tempRoot, "link-ws");
        let symlinkCreated = false;
        try {
            fs.symlinkSync(realWs, linkWs, process.platform === "win32" ? "junction" : "dir");
            symlinkCreated = true;
        } catch {
            // OS policy forbade symlink/junction creation; file:// + ancestor checks still run
        }

        if (symlinkCreated) {
            inputs.push(path.join(linkWs, "src", "index.ts"));
            inputs.push(path.join(linkWs, "new-dir", "new-file.ts"));
            inputs.push(pathToFileURL(path.join(linkWs, "via-uri", "created-later.ts")).href);
        }

        const result = classifyWorkspaceFiles(storeInfo, inputs);
        assert.equal(result.externalFiles.length, 0);
        assert.ok(result.inWorkspace.includes("src/index.ts"));
        assert.ok(result.inWorkspace.includes("nonexistent/new-file.ts"));
        if (symlinkCreated) {
            assert.ok(result.inWorkspace.includes("new-dir/new-file.ts"));
            assert.ok(result.inWorkspace.includes("via-uri/created-later.ts"));
        }
    });

    it("4.3 Auto-prefixes linked folder files to @<folderSlug>/<relPath> and preserves explicit @<folderSlug>/ anchors", () => {
        const projA = path.join(tempRoot, "proj-a");
        const toolB = path.join(tempRoot, "tool-b");
        fs.mkdirSync(path.join(projA, "src"), { recursive: true });
        fs.mkdirSync(path.join(toolB, "src"), { recursive: true });

        const infoA = getProjectStoreInfo(projA);
        setWorkspaceFolderPolicy({ primaryPath: projA, folderPath: toolB, mode: "linked", folderSlug: "tool-b" });

        // Test both automatic policy loading and explicit linkedFolders option
        const autoRes = classifyWorkspaceFiles(infoA, [
            path.join(toolB, "src", "helper.js"),
            pathToFileURL(path.join(toolB, "lib", "util.js")).href,
            "@tool-b/src/x.js",
            "./src/main.ts"
        ]);

        assert.deepEqual(autoRes.inWorkspace, ["src/main.ts"]);
        assert.deepEqual(autoRes.linkedNormalized, [
            "@tool-b/src/helper.js",
            "@tool-b/lib/util.js",
            "@tool-b/src/x.js"
        ]);
        assert.equal(autoRes.externalFiles.length, 0);
        assert.deepEqual(autoRes.allNormalized, [
            "@tool-b/src/helper.js",
            "@tool-b/lib/util.js",
            "@tool-b/src/x.js",
            "src/main.ts"
        ]);
    });

    it("4.4 Detects external files with deepest matching ownerCandidate from projects_index.json", () => {
        const projA = path.join(tempRoot, "owner-a");
        const projB = path.join(tempRoot, "owner-b");
        const projBSub = path.join(projB, "sub");
        const untracked = path.join(tempRoot, "untracked");
        fs.mkdirSync(projA, { recursive: true });
        fs.mkdirSync(projBSub, { recursive: true });
        fs.mkdirSync(untracked, { recursive: true });

        const infoA = getProjectStoreInfo(projA);
        const infoB = getProjectStoreInfo(projB);
        const infoBSub = getProjectStoreInfo(projBSub);
        registerProjectInIndex(infoA);
        registerProjectInIndex(infoB);
        registerProjectInIndex(infoBSub);

        const res = classifyWorkspaceFiles(infoA, [
            path.join(projBSub, "file.ts"),
            path.join(projB, "top.ts"),
            path.join(untracked, "orphan.ts")
        ]);

        assert.equal(res.inWorkspace.length, 0);
        assert.equal(res.linkedNormalized.length, 0);
        assert.equal(res.externalFiles.length, 3);

        assert.ok(res.externalFiles[0].ownerCandidate);
        assert.equal(res.externalFiles[0].ownerCandidate.storeKey, infoBSub.storeKey);
        assert.equal(res.externalFiles[0].ownerCandidate.canonicalPath, infoBSub.canonicalPath);

        assert.ok(res.externalFiles[1].ownerCandidate);
        assert.equal(res.externalFiles[1].ownerCandidate.storeKey, infoB.storeKey);
        assert.equal(res.externalFiles[1].ownerCandidate.canonicalPath, infoB.canonicalPath);

        assert.equal(res.externalFiles[2].ownerCandidate, null);
    });

    it("4.5 Review Focus #4: Flags Windows cross-drive paths as external while keeping node_modules/@types/node/index.d.ts inWorkspace", () => {
        const projA = path.join(tempRoot, "focus-a");
        const toolB = path.join(tempRoot, "focus-b");
        fs.mkdirSync(projA, { recursive: true });
        fs.mkdirSync(toolB, { recursive: true });

        const infoA = getProjectStoreInfo(projA);
        const infoB = getProjectStoreInfo(toolB);
        const linkedFolders = [
            {
                folderSlug: "tool-b",
                canonicalPath: infoB.canonicalPath,
                normalizedKey: infoB.normalizedForHash,
                isRemote: false
            }
        ];

        const altDrive =
            process.platform === "win32"
                ? (infoA.canonicalPath[0].toUpperCase() === "D" ? "E:/Other/file.ts" : "D:/Other/file.ts")
                : "/outside-root/Other/file.ts";

        const res = classifyWorkspaceFiles(
            infoA,
            [
                "node_modules/@types/node/index.d.ts",
                "@types/node/index.d.ts",
                "../outside/file.ts",
                altDrive
            ],
            { linkedFolders }
        );

        assert.deepEqual(res.inWorkspace, [
            "node_modules/@types/node/index.d.ts",
            "@types/node/index.d.ts"
        ]);
        assert.equal(res.linkedNormalized.length, 0);
        assert.equal(res.externalFiles.length, 2);
        assert.equal(res.externalFiles[0].input, "../outside/file.ts");
        assert.equal(res.externalFiles[1].input, altDrive);

        // Also explicitly verify synthetic Windows C:\ vs D:\ cross-drive classification on all platforms
        const winStoreInfo = {
            canonicalPath: "C:\\Primary\\app",
            normalizedForHash: "c:/primary/app",
            isRemote: false,
            storeKey: "app-001122334455"
        };
        if (process.platform === "win32") {
            const winRes = classifyWorkspaceFiles(
                winStoreInfo,
                ["node_modules/@types/node/index.d.ts", "D:\\Other\\file.ts"],
                { linkedFolders: [] }
            );
            assert.deepEqual(winRes.inWorkspace, ["node_modules/@types/node/index.d.ts"]);
            assert.equal(winRes.externalFiles.length, 1);
            assert.equal(winRes.externalFiles[0].input, "D:\\Other\\file.ts");
        }
    });

    it("4.6 Classifies Windows drive-letter paths without cwd/root mangling across platforms", () => {
        const localRoot = path.join(tempRoot, "posix-or-local");
        fs.mkdirSync(localRoot, { recursive: true });
        const localStore = getProjectStoreInfo(localRoot);
        const remoteStore = getProjectStoreInfo("ssh://dev/workspaces/app");

        updateProjectsIndex((idx) => {
            idx.projects["win-other-001122334455"] = {
                storeKey: "win-other-001122334455",
                canonicalPath: "D:\\Other",
                aliases: [],
                isRemote: false,
                dbFile: "win-other-001122334455.db",
                firstSeenAt: new Date().toISOString(),
                lastAccessedAt: new Date().toISOString()
            };
        });

        for (const store of [localStore, remoteStore]) {
            const res = classifyWorkspaceFiles(store, ["D:\\Other\\..\\Other\\file.ts"]);
            assert.equal(res.externalFiles.length, 1);
            assert.equal(res.externalFiles[0].resolvedPath.includes(process.cwd()), false);
            assert.equal(res.externalFiles[0].resolvedPath.includes(localStore.canonicalPath), false);
            assert.ok(res.externalFiles[0].ownerCandidate);
            assert.equal(res.externalFiles[0].ownerCandidate.storeKey, "win-other-001122334455");
            if (process.platform !== "win32") {
                assert.equal(res.externalFiles[0].resolvedPath, "D:/Other/file.ts");
            }
        }
    });
});
