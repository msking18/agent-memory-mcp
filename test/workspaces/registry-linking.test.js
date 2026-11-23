import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRemoteUri, isWslUncPath, validateProjectPath } from "../../src/paths/remote.js";
import {
    getStoresDir,
    readProjectsIndex,
    updateProjectsIndex,
    getProjectStoreInfo,
    registerProjectInIndex,
    setWorkspaceFolderPolicy,
    getWorkspacePoliciesForPrimary,
    findReverseLinkedPrimary,
    linkProjectIdentity,
    inspectWorkspace
} from "../../src/paths/registry.js";
import { createTempVaultEnv, cleanupTempVaultEnv } from "../helpers/env.js";

describe("Registry Linking, Multi-Folder Policies & Isolation Edge Cases", () => {
    let tempRoot;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, prevDataDir } = createTempVaultEnv("ag-mem-registry-link-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("3.6 Links deleted/moved source_project_path, pre-registers new remote git_remote without empty DB, matches WSL bidirectional aliases, and never probes legacy WSL UNC entries", (t) => {
        // 1) Deleted source_project_path linking
        const oldDir = path.join(tempRoot, "old-draft-app");
        const newDir = path.join(tempRoot, "new-draft-app");
        fs.mkdirSync(oldDir, { recursive: true });
        fs.mkdirSync(newDir, { recursive: true });

        const infoOld = getProjectStoreInfo(oldDir);
        registerProjectInIndex(infoOld);
        fs.rmSync(oldDir, { recursive: true, force: true });

        const linkDeleted = linkProjectIdentity({ projectPath: newDir, sourceProjectPath: oldDir });
        assert.equal(linkDeleted.storeKey, infoOld.storeKey);
        const resolvedNew = getProjectStoreInfo(newDir);
        assert.equal(resolvedNew.storeKey, infoOld.storeKey);
        assert.equal(resolvedNew.resolvedVia, "index_alias");

        // 2) Pre-register brand-new remote git_remote without creating an empty .db file
        const remoteRes = linkProjectIdentity({
            projectPath: "ssh://dev.host/srv/brand-new",
            gitRemote: "https://github.com/Team/BrandNew.git"
        });
        assert.equal(remoteRes.initialized, false);
        assert.equal(remoteRes.gitIdentity, "github.com/team/brandnew");
        assert.equal(fs.existsSync(remoteRes.dbPath), false);

        const resolvedRemote = getProjectStoreInfo("ssh://dev.host/srv/brand-new");
        assert.equal(resolvedRemote.storeKey, remoteRes.storeKey);
        assert.equal(resolvedRemote.resolvedVia, "index_alias");
        assert.equal(resolvedRemote.gitIdentity, "github.com/team/brandnew");

        const secondRemote = getProjectStoreInfo("devcontainer://box/workspaces/brand-new", {
            gitRemote: "git@github.com:Team/BrandNew.git"
        });
        assert.equal(secondRemote.storeKey, remoteRes.storeKey);
        assert.equal(secondRemote.resolvedVia, "git_identity");

        // 3) Bidirectional WSL index match across wsl:// <-> \\wsl.localhost\ <-> \\wsl$\
        const wslInfo = getProjectStoreInfo("wsl://ubuntu/home/dev/wsl-proj");
        registerProjectInIndex(wslInfo);

        const viaUnc = getProjectStoreInfo("\\\\wsl.localhost\\Ubuntu\\home\\dev\\wsl-proj");
        assert.equal(viaUnc.storeKey, wslInfo.storeKey);
        assert.equal(viaUnc.resolvedVia, "index_alias");

        const viaDollar = getProjectStoreInfo("\\\\wsl$\\Ubuntu\\home\\dev\\wsl-proj");
        assert.equal(viaDollar.storeKey, wslInfo.storeKey);
        assert.equal(viaDollar.resolvedVia, "index_alias");

        // 4) Legacy WSL UNC entry (isRemote: false) must never trigger fs.existsSync
        const legacyUncKey = "legacy-wsl-001122334455";
        updateProjectsIndex((idx) => {
            idx.projects[legacyUncKey] = {
                storeKey: legacyUncKey,
                canonicalPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\legacy-wsl",
                aliases: [],
                gitIdentity: "github.com/org/legacy-wsl",
                gitIdentityAliases: [],
                gitCommonDir: null,
                isolatedGitIdentity: null,
                isRemote: false,
                dbFile: `${legacyUncKey}.db`,
                firstSeenAt: "2026-11-23T00:00:00.000Z",
                lastAccessedAt: "2026-11-23T00:00:00.000Z"
            };
        });

        const localTwin = path.join(tempRoot, "legacy-wsl-twin");
        fs.mkdirSync(path.join(localTwin, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(localTwin, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/legacy-wsl.git\n',
            "utf8"
        );

        const existsSpy = t.mock.method(fs, "existsSync");
        const twinInfo = getProjectStoreInfo(localTwin);
        assert.equal(twinInfo.storeKey, legacyUncKey);
        assert.equal(twinInfo.resolvedVia, "git_identity");

        const linkedTwin = linkProjectIdentity({ projectPath: localTwin, targetStoreKey: legacyUncKey });
        assert.equal(linkedTwin.storeKey, legacyUncKey);

        const probedWslOrRemote = existsSpy.mock.calls.filter((call) => {
            const target = call.arguments[0];
            return isWslUncPath(target) || isRemoteUri(target);
        });
        assert.equal(probedWslOrRemote.length, 0, "fs.existsSync must never probe WSL UNC or remote URI paths");
    });

    it("3.7 Persists workspacePolicies with auto-disambiguated folderSlug and rejects duplicate explicit folderSlug", () => {
        const primary = path.join(tempRoot, "primary-app");
        const frontendDocs = path.join(tempRoot, "frontend", "docs");
        const backendDocs = path.join(tempRoot, "backend", "docs");
        const extraDocs = path.join(tempRoot, "extra", "docs");

        fs.mkdirSync(primary, { recursive: true });
        fs.mkdirSync(frontendDocs, { recursive: true });
        fs.mkdirSync(backendDocs, { recursive: true });
        fs.mkdirSync(extraDocs, { recursive: true });

        const primaryInfo = getProjectStoreInfo(primary);

        const p1 = setWorkspaceFolderPolicy({
            primaryPath: primary,
            folderPath: frontendDocs,
            mode: "linked"
        });
        assert.equal(p1.folderSlug, "docs");
        assert.equal(p1.targetStoreKey, primaryInfo.storeKey);

        const p2 = setWorkspaceFolderPolicy({
            primaryPath: primary,
            folderPath: backendDocs,
            mode: "linked"
        });
        assert.equal(p2.folderSlug, "backend-docs");
        assert.equal(p2.targetStoreKey, primaryInfo.storeKey);

        assert.throws(
            () =>
                setWorkspaceFolderPolicy({
                    primaryPath: primary,
                    folderPath: extraDocs,
                    mode: "linked",
                    folderSlug: "docs"
                }),
            /duplicate|already uses/i
        );

        const p3 = setWorkspaceFolderPolicy({
            primaryPath: primary,
            folderPath: extraDocs,
            mode: "ignored"
        });
        assert.equal(p3.mode, "ignored");

        const policies = getWorkspacePoliciesForPrimary(primaryInfo.normalizedForHash);
        assert.equal(Object.keys(policies).length, 3);

        const backendInfo = getProjectStoreInfo(backendDocs);
        const extraInfo = getProjectStoreInfo(extraDocs);
        const openKeys = [backendInfo.normalizedForHash, primaryInfo.normalizedForHash, extraInfo.normalizedForHash];

        const reverse = findReverseLinkedPrimary(backendInfo.normalizedForHash, openKeys);
        assert.deepEqual(reverse, {
            primaryKey: primaryInfo.normalizedForHash,
            folderSlug: "backend-docs",
            targetStoreKey: primaryInfo.storeKey
        });
        assert.equal(findReverseLinkedPrimary(extraInfo.normalizedForHash, openKeys), null);

        const inspected = inspectWorkspace({
            projectPath: primary,
            workspacePaths: [primary, frontendDocs, backendDocs, extraDocs]
        });
        assert.equal(inspected.storeInfo.storeKey, primaryInfo.storeKey);
        assert.equal(inspected.initialized, false);
        assert.equal(Object.keys(inspected.workspacePolicies).length, 3);
        assert.equal(inspected.workspaceFolders.length, 4);
    });

    it("3.8 linkProjectIdentity promotes missing canonicalPath on source_project_path and retires old self entry on relink", () => {
        // Part A: deleted source_project_path promotes live projectPath to canonicalPath immediately
        const oldClone = path.join(tempRoot, "old-clone-relink");
        const newClone = path.join(tempRoot, "new-clone-relink");
        const secondClone = path.join(tempRoot, "second-clone-relink");
        for (const dir of [oldClone, newClone, secondClone]) {
            fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
            fs.writeFileSync(
                path.join(dir, ".git", "config"),
                '[remote "origin"]\n\turl = https://github.com/org/relink-app.git\n',
                "utf8"
            );
        }

        const oldInfo = getProjectStoreInfo(oldClone);
        registerProjectInIndex(oldInfo);
        fs.rmSync(oldClone, { recursive: true, force: true });

        linkProjectIdentity({ projectPath: newClone, sourceProjectPath: oldClone });
        const afterRelink = readProjectsIndex().projects[oldInfo.storeKey];
        assert.equal(afterRelink.canonicalPath, validateProjectPath(newClone));
        assert.ok(afterRelink.aliases.includes(oldInfo.normalizedForHash));

        // Subsequent live clone must see duplicateCloneCandidate because newClone is live on disk
        const secondInfo = getProjectStoreInfo(secondClone);
        assert.notEqual(secondInfo.storeKey, oldInfo.storeKey);
        assert.ok(secondInfo.duplicateCloneCandidate);
        assert.equal(secondInfo.duplicateCloneCandidate.existingStoreKey, oldInfo.storeKey);
        assert.equal(secondInfo.duplicateCloneCandidate.existingPath, validateProjectPath(newClone));

        // Part B: relinking an already-indexed entry E2 (registered before target) clears/retires E2
        const relinkDir = path.join(tempRoot, "already-indexed-e2");
        const targetDir = path.join(tempRoot, "target-store-s");
        const siblingAliasDir = path.join(tempRoot, "sibling-alias-e3");
        fs.mkdirSync(relinkDir, { recursive: true });
        fs.mkdirSync(targetDir, { recursive: true });
        fs.mkdirSync(siblingAliasDir, { recursive: true });

        const e2Info = getProjectStoreInfo(relinkDir);
        registerProjectInIndex(e2Info);
        const sTargetInfo = getProjectStoreInfo(targetDir);
        registerProjectInIndex(sTargetInfo);

        const wslEntryInfo = getProjectStoreInfo("wsl://ubuntu/home/dev/wsl-relink-other");
        registerProjectInIndex(wslEntryInfo);
        updateProjectsIndex((idx) => {
            idx.projects[wslEntryInfo.storeKey].aliases.push("\\\\wsl.localhost\\Ubuntu\\home\\dev\\wsl-relink");
        });

        linkProjectIdentity({ projectPath: relinkDir, targetStoreKey: sTargetInfo.storeKey });
        const idxAfterB = readProjectsIndex();
        assert.equal(idxAfterB.projects[e2Info.storeKey], undefined);
        assert.equal(getProjectStoreInfo(relinkDir).storeKey, sTargetInfo.storeKey);

        // Relinking WSL UNC path cleans up WSL-equivalent alias on wslEntryInfo
        linkProjectIdentity({
            projectPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\wsl-relink",
            targetStoreKey: sTargetInfo.storeKey
        });
        const wslAfter = readProjectsIndex().projects[wslEntryInfo.storeKey];
        assert.equal(wslAfter.aliases.length, 0);
        assert.equal(
            getProjectStoreInfo("wsl://ubuntu/home/dev/wsl-relink").storeKey,
            sTargetInfo.storeKey
        );

        // Extra check: if E2 also had another alias (siblingAliasDir), E2 retires relinkDir and promotes siblingAliasDir
        const e2MultiInfo = getProjectStoreInfo(relinkDir);
        assert.equal(e2MultiInfo.storeKey, sTargetInfo.storeKey);
        const multiDir = path.join(tempRoot, "multi-canonical");
        fs.mkdirSync(multiDir, { recursive: true });
        const multiInfo = getProjectStoreInfo(multiDir);
        registerProjectInIndex(multiInfo);
        updateProjectsIndex((idx) => {
            idx.projects[multiInfo.storeKey].aliases.push(getProjectStoreInfo(siblingAliasDir).normalizedForHash);
        });
        linkProjectIdentity({ projectPath: multiDir, targetStoreKey: sTargetInfo.storeKey });
        const multiAfter = readProjectsIndex().projects[multiInfo.storeKey];
        assert.ok(multiAfter);
        assert.equal(multiAfter.canonicalPath, getProjectStoreInfo(siblingAliasDir).normalizedForHash);
        assert.equal(getProjectStoreInfo(multiDir).storeKey, sTargetInfo.storeKey);
    });

    it("3.9 Step 4 new_git_identity and registered_remote avoid colliding with isolated <slug>-<gitHash> store", () => {
        const origClone = path.join(tempRoot, "first", "my-app");
        const secondClone = path.join(tempRoot, "second", "my-app");
        fs.mkdirSync(path.join(origClone, ".git"), { recursive: true });
        fs.mkdirSync(path.join(secondClone, ".git"), { recursive: true });
        const remoteCfg = '[remote "origin"]\n\turl = https://github.com/org/isolated-seed.git\n';
        fs.writeFileSync(path.join(origClone, ".git", "config"), remoteCfg, "utf8");
        fs.writeFileSync(path.join(secondClone, ".git", "config"), remoteCfg, "utf8");

        const origInfo = getProjectStoreInfo(origClone);
        assert.equal(origInfo.resolvedVia, "new_git_identity");
        registerProjectInIndex(origInfo);
        fs.writeFileSync(origInfo.dbPath, "", "utf8");

        const isoOrig = linkProjectIdentity({ projectPath: origClone, isolate: true });
        assert.equal(isoOrig.storeKey, origInfo.storeKey);
        assert.equal(isoOrig.isolatedGitIdentity, "github.com/org/isolated-seed");

        // registered_remote with same slug + same remote must NOT overwrite isolated origInfo.storeKey
        const remoteRes = linkProjectIdentity({
            projectPath: "ssh://dev.host/srv/my-app",
            gitRemote: "https://github.com/org/isolated-seed.git"
        });
        assert.notEqual(remoteRes.storeKey, origInfo.storeKey);
        assert.equal(remoteRes.gitIdentity, "github.com/org/isolated-seed");

        const idxAfterRemote = readProjectsIndex();
        assert.equal(idxAfterRemote.projects[origInfo.storeKey].isolatedGitIdentity, "github.com/org/isolated-seed");
        assert.equal(idxAfterRemote.projects[origInfo.storeKey].gitIdentity, null);
        assert.equal(idxAfterRemote.projects[remoteRes.storeKey].gitIdentity, "github.com/org/isolated-seed");

        // Remove remote entry to test Step 4 directly against the isolated <slug>-<gitHash> entry
        updateProjectsIndex((idx) => {
            delete idx.projects[remoteRes.storeKey];
        });

        const secondInfo = getProjectStoreInfo(secondClone);
        assert.notEqual(secondInfo.storeKey, origInfo.storeKey);
        assert.notEqual(secondInfo.dbPath, origInfo.dbPath);
        assert.equal(secondInfo.resolvedVia, "new_path_hash");
        assert.equal(secondInfo.gitIdentity, "github.com/org/isolated-seed");
    });

    it("3.10 linkProjectIdentity isolate:true clears gitIdentityAliases and suppresses aliasMatch/conflicts for old remotes", () => {
        const cloneA = path.join(tempRoot, "clone-a-alias");
        const cloneB = path.join(tempRoot, "clone-b-old-remote");
        fs.mkdirSync(path.join(cloneA, ".git"), { recursive: true });
        fs.mkdirSync(path.join(cloneB, ".git"), { recursive: true });

        fs.writeFileSync(
            path.join(cloneA, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/old-name.git\n',
            "utf8"
        );
        const infoA1 = getProjectStoreInfo(cloneA);
        registerProjectInIndex(infoA1);

        // Rename remote on cloneA -> old-name moves to gitIdentityAliases
        fs.writeFileSync(
            path.join(cloneA, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/new-name.git\n',
            "utf8"
        );
        const infoA2 = getProjectStoreInfo(cloneA);
        registerProjectInIndex(infoA2);
        assert.ok(readProjectsIndex().projects[infoA1.storeKey].gitIdentityAliases.includes("github.com/org/old-name"));

        // Isolate cloneA -> gitIdentity and gitIdentityAliases must both be cleared
        linkProjectIdentity({ projectPath: cloneA, isolate: true });
        const isolatedEntry = readProjectsIndex().projects[infoA1.storeKey];
        assert.equal(isolatedEntry.gitIdentity, null);
        assert.deepEqual(isolatedEntry.gitIdentityAliases, []);

        // New clone using old-name must not share or conflict with isolated cloneA
        fs.writeFileSync(
            path.join(cloneB, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/old-name.git\n',
            "utf8"
        );
        const infoB = getProjectStoreInfo(cloneB);
        assert.notEqual(infoB.storeKey, infoA1.storeKey);
        assert.equal(infoB.resolvedVia, "new_git_identity");
        assert.equal(infoB.duplicateCloneCandidate, null);
        assert.equal(infoB.gitIdentityConflict, null);

        const regB = registerProjectInIndex(infoB);
        assert.equal(regB.gitIdentityConflict, undefined);
        assert.equal(readProjectsIndex().projects[infoB.storeKey].gitIdentity, "github.com/org/old-name");
    });

    it("3.11 Prefers sameCommonDir over missing clones, splits aliased live checkouts on isolate:true, clears isolatedGitIdentity on new remote, and cleans tmpPath on write error", (t) => {
        // 1) Step 3 prefers sameCommonDir ahead of isEntryMissingFromDisk
        const deletedClone = path.join(tempRoot, "deleted-clone");
        const liveRepo = path.join(tempRoot, "live-repo");
        const liveWt = path.join(tempRoot, "live-wt");
        const liveWtMeta = path.join(liveRepo, ".git", "worktrees", "wt-1");
        fs.mkdirSync(path.join(deletedClone, ".git"), { recursive: true });
        fs.mkdirSync(liveWtMeta, { recursive: true });
        fs.mkdirSync(liveWt, { recursive: true });
        const sharedCfg = '[remote "origin"]\n\turl = https://github.com/org/step3-order.git\n';
        fs.writeFileSync(path.join(deletedClone, ".git", "config"), sharedCfg, "utf8");
        fs.writeFileSync(path.join(liveRepo, ".git", "config"), sharedCfg, "utf8");
        fs.writeFileSync(path.join(liveWtMeta, "commondir"), "../..\n", "utf8");
        fs.writeFileSync(path.join(liveWt, ".git"), `gitdir: ${liveWtMeta}\n`, "utf8");

        const delInfo = getProjectStoreInfo(deletedClone);
        registerProjectInIndex(delInfo);
        fs.rmSync(deletedClone, { recursive: true, force: true });

        // Force a second live entry owning the same gitIdentity after deletedClone
        const liveInfo = getProjectStoreInfo(liveRepo);
        const liveStoreKey = `live-repo-${crypto.createHash("sha256").update("live-repo").digest("hex").slice(0, 12)}`;
        updateProjectsIndex((idx) => {
            idx.projects[liveStoreKey] = {
                storeKey: liveStoreKey,
                canonicalPath: liveInfo.canonicalPath,
                aliases: [],
                gitIdentity: "github.com/org/step3-order",
                gitIdentityAliases: [],
                gitCommonDir: liveInfo.gitCommonDir.replace(/\\/g, "/"),
                isolatedGitIdentity: null,
                isRemote: false,
                dbFile: `${liveStoreKey}.db`,
                firstSeenAt: new Date().toISOString(),
                lastAccessedAt: new Date().toISOString()
            };
        });

        const wtInfo = getProjectStoreInfo(liveWt);
        assert.equal(wtInfo.storeKey, liveStoreKey);
        assert.equal(wtInfo.resolvedVia, "git_identity");

        // 2) isolate:true on an alias whose canonicalPath is a live checkout detaches into its own storeKey without wiping owner's gitIdentity
        const checkoutA = path.join(tempRoot, "checkout-a");
        const checkoutB = path.join(tempRoot, "checkout-b");
        for (const d of [checkoutA, checkoutB]) {
            fs.mkdirSync(path.join(d, ".git"), { recursive: true });
            fs.writeFileSync(
                path.join(d, ".git", "config"),
                '[remote "origin"]\n\turl = https://github.com/org/split-alias.git\n',
                "utf8"
            );
        }
        const infoA = getProjectStoreInfo(checkoutA);
        registerProjectInIndex(infoA);
        linkProjectIdentity({ projectPath: checkoutB, targetStoreKey: infoA.storeKey });
        assert.ok(readProjectsIndex().projects[infoA.storeKey].aliases.includes(getProjectStoreInfo(checkoutB).normalizedForHash));

        const splitIso = linkProjectIdentity({ projectPath: checkoutB, isolate: true });
        assert.notEqual(splitIso.storeKey, infoA.storeKey);
        const idxAfterSplit = readProjectsIndex();
        assert.equal(idxAfterSplit.projects[infoA.storeKey].gitIdentity, "github.com/org/split-alias");
        assert.equal(idxAfterSplit.projects[infoA.storeKey].isolatedGitIdentity, null);
        assert.equal(idxAfterSplit.projects[infoA.storeKey].aliases.includes(getProjectStoreInfo(checkoutB).normalizedForHash), false);
        assert.equal(idxAfterSplit.projects[splitIso.storeKey].isolatedGitIdentity, "github.com/org/split-alias");
        assert.equal(getProjectStoreInfo(checkoutB).storeKey, splitIso.storeKey);

        // 3) Isolated store acquiring a new distinct gitIdentity clears isolatedGitIdentity so conflicts/sharing work again
        fs.writeFileSync(
            path.join(checkoutB, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/new-fork.git\n',
            "utf8"
        );
        const forkInfo = getProjectStoreInfo(checkoutB);
        registerProjectInIndex(forkInfo);
        const forkEntry = readProjectsIndex().projects[splitIso.storeKey];
        assert.equal(forkEntry.gitIdentity, "github.com/org/new-fork");
        assert.equal(forkEntry.isolatedGitIdentity, null);

        const conflictingClone = path.join(tempRoot, "fork-clone-conflict");
        fs.mkdirSync(path.join(conflictingClone, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(conflictingClone, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/new-fork.git\n',
            "utf8"
        );
        const forkDupInfo = getProjectStoreInfo(conflictingClone);
        assert.ok(forkDupInfo.duplicateCloneCandidate);
        assert.equal(forkDupInfo.duplicateCloneCandidate.existingStoreKey, splitIso.storeKey);

        // 4) updateProjectsIndex cleans up tmpPath when writeFileSync fails
        const storesDir = getStoresDir();
        const writeMock = t.mock.method(fs, "writeFileSync", (filePath, ...rest) => {
            if (typeof filePath === "string" && filePath.includes(".tmp.")) {
                fs.closeSync(fs.openSync(filePath, "w"));
                throw new Error("disk full");
            }
            return fs.writeFileSync.wrappedMethod
                ? fs.writeFileSync.wrappedMethod.call(fs, filePath, ...rest)
                : undefined;
        });
        assert.throws(() => updateProjectsIndex(() => {}), /disk full/);
        writeMock.mock.restore();
        const leftoverTmps = fs.readdirSync(storesDir).filter((f) => f.includes(".tmp."));
        assert.deepEqual(leftoverTmps, []);
    });
});
