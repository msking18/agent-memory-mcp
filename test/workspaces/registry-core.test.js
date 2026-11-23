import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateProjectPath } from "../../src/paths/remote.js";
import {
    getDataRoot,
    getStoresDir,
    getProjectsIndexPath,
    readProjectsIndex,
    updateProjectsIndex,
    getProjectStoreInfo,
    registerProjectInIndex,
    linkProjectIdentity
} from "../../src/paths/registry.js";
import * as pathsFacade from "../../src/paths.js";
import { createTempVaultEnv, cleanupTempVaultEnv } from "../helpers/env.js";

describe("Locked projects_index.json v4 Registry, 4-Step Resolution, Upgrade Lifecycle & Clone Disambiguation", () => {
    let tempRoot;
    let dataDir;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, dataDir, prevDataDir } = createTempVaultEnv("ag-mem-registry-core-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("3.1 Review Focus #3: Reads v3 legacy index, recovers from corrupt JSON, and evicts stale dead-PID lock", () => {
        assert.equal(getDataRoot(), path.resolve(dataDir));
        const storesDir = getStoresDir();
        const indexPath = getProjectsIndexPath();

        // Seed v3 index entry missing storeKey, firstSeenAt, aliases, and workspacePolicies
        const v3Seed = {
            version: 3,
            projects: {
                "legacy-app-1234567890ab": {
                    canonicalPath: "/tmp/legacy-app",
                    dbFile: "legacy-app-1234567890ab.db",
                    updatedAt: "2026-01-15T10:00:00.000Z"
                }
            }
        };
        fs.writeFileSync(indexPath, JSON.stringify(v3Seed, null, 2), "utf8");

        const readV3 = readProjectsIndex();
        assert.deepEqual(readV3.workspacePolicies, {});
        const seededEntry = readV3.projects["legacy-app-1234567890ab"];
        assert.ok(seededEntry);
        assert.equal(seededEntry.storeKey, "legacy-app-1234567890ab");
        assert.equal(seededEntry.canonicalPath, "/tmp/legacy-app");
        assert.equal(seededEntry.dbFile, "legacy-app-1234567890ab.db");
        assert.equal(seededEntry.firstSeenAt, "2026-01-15T10:00:00.000Z");
        assert.deepEqual(seededEntry.aliases, []);

        // Corrupt JSON -> safe recovery to empty v4 index
        fs.writeFileSync(indexPath, "{corrupt-not-valid-json", "utf8");
        const recovered = readProjectsIndex();
        assert.equal(recovered.version, 4);
        assert.deepEqual(recovered.projects, {});
        assert.deepEqual(recovered.workspacePolicies, {});

        // Stale dead-PID lock -> evicted cleanly by updateProjectsIndex
        const lockPath = `${indexPath}.lock`;
        fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }), "utf8");
        const res = updateProjectsIndex((idx) => {
            idx.projects["test-store-001122334455"] = {
                storeKey: "test-store-001122334455",
                canonicalPath: "/tmp/test-store",
                aliases: [],
                dbFile: "test-store-001122334455.db",
                firstSeenAt: "2026-11-23T00:00:00.000Z",
                lastAccessedAt: "2026-11-23T00:00:00.000Z"
            };
            return "updated";
        });

        assert.equal(res, "updated");
        assert.equal(fs.existsSync(lockPath), false);
        const afterUpdate = readProjectsIndex();
        assert.equal(afterUpdate.version, 4);
        assert.ok(afterUpdate.projects["test-store-001122334455"]);
        assert.equal(fs.readdirSync(storesDir).includes("projects_index.json"), true);

        // Mutator throwing leaves index intact and releases lock
        assert.throws(() => {
            updateProjectsIndex((idx) => {
                idx.projects["should-not-persist"] = { canonicalPath: "/tmp/nope" };
                throw new Error("boom");
            });
        }, /boom/);
        assert.equal(fs.existsSync(lockPath), false);
        assert.equal(readProjectsIndex().projects["should-not-persist"], undefined);

        // Verify src/paths.js barrel facade re-exports legacy and v4 registry symbols
        assert.equal(pathsFacade.readProjectsIndex, readProjectsIndex);
        assert.equal(pathsFacade.getProjectStoreInfo, getProjectStoreInfo);
        assert.equal(pathsFacade.linkProjectIdentity, linkProjectIdentity);
        assert.equal(typeof pathsFacade.normalizeWorkspaceRelativePath, "function");
        assert.equal(typeof pathsFacade.loadConfig, "function");
    });

    it("3.2 Reuses existing legacy v3.2 path-hash .db on disk even without index entry", () => {
        const legacyDir = path.join(tempRoot, "LegacyApp");
        fs.mkdirSync(path.join(legacyDir, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(legacyDir, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/legacy-app.git\n',
            "utf8"
        );

        const realDir = fs.realpathSync.native ? fs.realpathSync.native(legacyDir) : fs.realpathSync(legacyDir);
        const normalized =
            process.platform === "win32"
                ? realDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
                : realDir.replace(/\/+$/, "");
        const expectedHash = crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
        const expectedStoreKey = `legacyapp-${expectedHash}`;
        const expectedDbPath = path.join(getStoresDir(), `${expectedStoreKey}.db`);

        // Seed empty projects_index.json and an existing v3.2 path-hash DB file on disk
        fs.writeFileSync(getProjectsIndexPath(), JSON.stringify({ version: 4, projects: {}, workspacePolicies: {} }), "utf8");
        fs.writeFileSync(expectedDbPath, "", "utf8");

        const info = getProjectStoreInfo(legacyDir);
        assert.equal(info.resolvedVia, "legacy_path_db");
        assert.equal(info.storeKey, expectedStoreKey);
        assert.equal(info.dbPath, expectedDbPath);
        assert.equal(info.gitIdentity, "github.com/org/legacy-app");
    });

    it("3.3 Upgrades gitIdentity monotonically (null -> local-git -> local-git-root -> remote) and tracks gitIdentityAliases", () => {
        const repoDir = path.join(tempRoot, "EvolvingRepo");
        fs.mkdirSync(repoDir, { recursive: true });

        // Stage 0: pre-git (null)
        const info0 = getProjectStoreInfo(repoDir);
        assert.equal(info0.gitIdentity, null);
        assert.equal(info0.resolvedVia, "new_path_hash");
        registerProjectInIndex(info0);
        const stableStoreKey = info0.storeKey;
        assert.equal(readProjectsIndex().projects[stableStoreKey].gitIdentity, null);

        // Stage 1: .git initialized, before first commit (local-git:<commonDir>)
        const gitDir = path.join(repoDir, ".git");
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\tbare = false\n", "utf8");
        const info1 = getProjectStoreInfo(repoDir);
        assert.equal(info1.storeKey, stableStoreKey);
        assert.equal(info1.resolvedVia, "index_alias");
        assert.match(info1.gitIdentity, /^local-git:/);
        registerProjectInIndex(info1);
        assert.equal(readProjectsIndex().projects[stableStoreKey].gitIdentity, info1.gitIdentity);
        assert.deepEqual(readProjectsIndex().projects[stableStoreKey].gitIdentityAliases, []);

        // Stage 2: initial commit recorded in logs/HEAD (local-git-root:<sha>)
        const rootSha = "1122334455667788990011223344556677889900";
        fs.mkdirSync(path.join(gitDir, "logs"), { recursive: true });
        fs.writeFileSync(
            path.join(gitDir, "logs", "HEAD"),
            `0000000000000000000000000000000000000000 ${rootSha} Dev <d@example.com> 1700000000 +0000\tcommit (initial): init\n`,
            "utf8"
        );
        const info2 = getProjectStoreInfo(repoDir);
        assert.equal(info2.storeKey, stableStoreKey);
        assert.equal(info2.gitIdentity, `local-git-root:${rootSha}`);
        registerProjectInIndex(info2);
        assert.equal(readProjectsIndex().projects[stableStoreKey].gitIdentity, `local-git-root:${rootSha}`);
        assert.deepEqual(readProjectsIndex().projects[stableStoreKey].gitIdentityAliases, []);

        // Stage 3: remote origin added
        fs.writeFileSync(
            path.join(gitDir, "config"),
            '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/Org/First.git\n',
            "utf8"
        );
        const info3 = getProjectStoreInfo(repoDir);
        assert.equal(info3.storeKey, stableStoreKey);
        assert.equal(info3.gitIdentity, "github.com/org/first");
        registerProjectInIndex(info3);
        assert.equal(readProjectsIndex().projects[stableStoreKey].gitIdentity, "github.com/org/first");
        assert.deepEqual(readProjectsIndex().projects[stableStoreKey].gitIdentityAliases, []);

        // Stage 4: remote origin changed -> old remote moves to gitIdentityAliases
        fs.writeFileSync(
            path.join(gitDir, "config"),
            '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Org/Second.git\n',
            "utf8"
        );
        const info4 = getProjectStoreInfo(repoDir);
        assert.equal(info4.storeKey, stableStoreKey);
        assert.equal(info4.gitIdentity, "github.com/org/second");
        registerProjectInIndex(info4);
        const entryAfterRemoteChange = readProjectsIndex().projects[stableStoreKey];
        assert.equal(entryAfterRemoteChange.gitIdentity, "github.com/org/second");
        assert.ok(entryAfterRemoteChange.gitIdentityAliases.includes("github.com/org/first"));

        // Stage 5: remote temporarily removed -> monotonic guard refuses downgrade back to local-git-root
        fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\tbare = false\n", "utf8");
        const info5 = getProjectStoreInfo(repoDir);
        assert.equal(info5.gitIdentity, `local-git-root:${rootSha}`);
        registerProjectInIndex(info5);
        assert.equal(readProjectsIndex().projects[stableStoreKey].gitIdentity, "github.com/org/second");
    });

    it("3.4 Detects duplicate gitIdentity collision without overwriting existing store ownership", () => {
        const dir1 = path.join(tempRoot, "StoreOne");
        const dir2 = path.join(tempRoot, "StoreTwo");
        fs.mkdirSync(dir1, { recursive: true });
        fs.mkdirSync(path.join(dir2, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(dir2, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/app.git\n',
            "utf8"
        );

        const s1 = getProjectStoreInfo(dir1);
        registerProjectInIndex(s1);
        const s2 = getProjectStoreInfo(dir2);
        registerProjectInIndex(s2);
        assert.notEqual(s1.storeKey, s2.storeKey);

        // Attach the same remote to S1 -> S1 must keep its own DB and flag conflict against S2
        fs.mkdirSync(path.join(dir1, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(dir1, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/app.git\n',
            "utf8"
        );

        const s1After = getProjectStoreInfo(dir1);
        assert.equal(s1After.storeKey, s1.storeKey);
        assert.equal(s1After.dbPath, s1.dbPath);
        assert.ok(s1After.gitIdentityConflict);
        assert.equal(s1After.gitIdentityConflict.gitIdentity, "github.com/org/app");
        assert.equal(s1After.gitIdentityConflict.conflictingStoreKey, s2.storeKey);

        registerProjectInIndex(s1After);
        const idx = readProjectsIndex();
        assert.equal(idx.projects[s1.storeKey].gitIdentity, null);
        assert.equal(idx.projects[s2.storeKey].gitIdentity, "github.com/org/app");
    });

    it("3.5 Shares store silently for worktrees and moved folders, but flags duplicateCloneCandidate for two live clones; isolate:true resolves", () => {
        const clone1 = path.join(tempRoot, "starter-clone-1");
        const wt1 = path.join(tempRoot, "starter-wt-1");
        const clone2 = path.join(tempRoot, "starter-clone-2");
        const wtMeta = path.join(clone1, ".git", "worktrees", "wt-1");

        fs.mkdirSync(wtMeta, { recursive: true });
        fs.mkdirSync(wt1, { recursive: true });
        fs.mkdirSync(path.join(clone2, ".git"), { recursive: true });

        fs.writeFileSync(
            path.join(clone1, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/starter.git\n',
            "utf8"
        );
        fs.writeFileSync(path.join(wtMeta, "commondir"), "../..\n", "utf8");
        fs.writeFileSync(path.join(wt1, ".git"), `gitdir: ${wtMeta}\n`, "utf8");
        fs.writeFileSync(
            path.join(clone2, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/starter.git\n',
            "utf8"
        );

        const infoC1 = getProjectStoreInfo(clone1);
        assert.equal(infoC1.resolvedVia, "new_git_identity");
        registerProjectInIndex(infoC1);

        // Worktree shares silently via gitCommonDir match without overwriting canonicalPath
        const infoWt1 = getProjectStoreInfo(wt1);
        assert.equal(infoWt1.resolvedVia, "git_identity");
        assert.equal(infoWt1.storeKey, infoC1.storeKey);
        assert.equal(infoWt1.duplicateCloneCandidate, null);
        assert.equal(infoWt1.canonicalPath, validateProjectPath(wt1));
        registerProjectInIndex(infoWt1);
        const afterWtEntry = readProjectsIndex().projects[infoC1.storeKey];
        assert.equal(afterWtEntry.canonicalPath, infoC1.canonicalPath);
        assert.ok(afterWtEntry.aliases.includes(infoWt1.normalizedForHash));

        // Second live clone -> duplicateCloneCandidate flagged, resolves provisionally to path-hash store
        const infoC2 = getProjectStoreInfo(clone2);
        assert.notEqual(infoC2.storeKey, infoC1.storeKey);
        assert.equal(infoC2.resolvedVia, "new_path_hash");
        assert.ok(infoC2.duplicateCloneCandidate);
        assert.equal(infoC2.duplicateCloneCandidate.existingStoreKey, infoC1.storeKey);
        assert.equal(infoC2.duplicateCloneCandidate.existingPath, infoC1.canonicalPath);
        assert.equal(infoC2.duplicateCloneCandidate.gitIdentity, "github.com/org/starter");

        // Deleting clone1 turns clone2 into a moved folder -> auto-shares silently
        fs.rmSync(clone1, { recursive: true, force: true });
        const infoC2Moved = getProjectStoreInfo(clone2);
        assert.equal(infoC2Moved.resolvedVia, "git_identity");
        assert.equal(infoC2Moved.storeKey, infoC1.storeKey);
        assert.equal(infoC2Moved.duplicateCloneCandidate, null);

        // Restore clone1 on disk and resolve via isolate: true
        fs.mkdirSync(path.join(clone1, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(clone1, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/starter.git\n',
            "utf8"
        );
        assert.ok(getProjectStoreInfo(clone2).duplicateCloneCandidate);

        const isoRes = linkProjectIdentity({ projectPath: clone2, isolate: true });
        assert.equal(isoRes.storeKey, infoC2.storeKey);
        assert.equal(fs.existsSync(infoC2.dbPath), false);
        assert.equal(readProjectsIndex().projects[infoC2.storeKey].isolatedGitIdentity, "github.com/org/starter");

        const infoC2Isolated = getProjectStoreInfo(clone2);
        assert.equal(infoC2Isolated.storeKey, infoC2.storeKey);
        assert.equal(infoC2Isolated.duplicateCloneCandidate, null);
        assert.equal(infoC2Isolated.gitIdentityConflict, null);
    });
});
