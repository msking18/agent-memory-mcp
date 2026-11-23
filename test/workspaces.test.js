import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    MAX_GIT_FILE_BYTES,
    normalizeGitRemoteUrl,
    parseGitConfigRemoteUrl,
    detectGitIdentity
} from "../src/paths/git.js";
import {
    REMOTE_SCHEMES,
    isRemoteUri,
    isWslUncPath,
    getWslEquivalentKeys,
    normalizeForIndexCompare,
    validateOrParseProjectPath,
    validateProjectPath
} from "../src/paths/remote.js";
import {
    getDataRoot,
    getStoresDir,
    getProjectsIndexPath,
    readProjectsIndex,
    updateProjectsIndex,
    getProjectStoreInfo,
    registerProjectInIndex,
    setWorkspaceFolderPolicy,
    getWorkspacePoliciesForPrimary,
    findReverseLinkedPrimary,
    linkProjectIdentity,
    inspectWorkspace
} from "../src/paths/registry.js";
import {
    normalizeWorkspaceRelativePath,
    classifyWorkspaceFiles
} from "../src/paths/files.js";
import * as pathsFacade from "../src/paths.js";
import { closeAllDatabases } from "../src/db.js";
import { runSessionStartPayload } from "../src/session-start-hook.js";
import {
    configureWorkspace,
    resolveStoreLinkedFolders,
    checkEntryFileStaleness,
    checkMemoryStatus,
    saveProjectMemory,
    readMemoryNode,
    updateMemoryNode,
    recordDeadEnd,
    checkDeadEnds,
    getFileMemories
} from "../src/store/index.js";
import * as storeFacade from "../src/store.js";

describe("Zero-Process Git, Worktree, Bare-Repo & Root-Commit Identity", () => {
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mem-git-test-"));
    });

    afterEach(() => {
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it("1.1 Normalizes SCP, HTTPS, SSH, credentialed, custom-port, and SSH-alias git URLs", () => {
        assert.equal(MAX_GIT_FILE_BYTES, 262144);

        assert.equal(normalizeGitRemoteUrl("git@github.com:Owner/Repo.git"), "github.com/owner/repo");
        assert.equal(normalizeGitRemoteUrl("https://user:tok@github.com:443/Owner/Repo/"), "github.com/owner/repo");
        assert.equal(normalizeGitRemoteUrl("ssh://git@github.com:22/owner/repo.git"), "github.com/owner/repo");
        assert.equal(normalizeGitRemoteUrl("http://github.com:80/Owner/Repo.git"), "github.com/owner/repo");
        assert.equal(normalizeGitRemoteUrl("git://github.com/Owner/Repo.git"), "github.com/owner/repo");

        assert.equal(
            normalizeGitRemoteUrl("ssh://git@git.corp.local:2222/team/app.git"),
            "git.corp.local:2222/team/app"
        );
        assert.equal(normalizeGitRemoteUrl("git@github-work:Org/App.git"), "github-work/org/app");

        assert.equal(normalizeGitRemoteUrl(""), null);
        assert.equal(normalizeGitRemoteUrl(null), null);
        assert.equal(normalizeGitRemoteUrl("file:///tmp/local/repo.git"), null);
        assert.equal(normalizeGitRemoteUrl("C:\\repos\\local"), null);
    });

    it("1.2 Parses .git/config with tabs, inline comments, case-insensitive sections, and remote fallback", () => {
        const withOrigin = [
            "[core]",
            "\trepositoryformatversion = 0",
            '[remote "upstream"]',
            "\turl = https://github.com/other/upstream.git",
            '[remote "origin"]',
            "\turl = https://github.com/a/b.git # comment",
            "\tfetch = +refs/heads/*:refs/remotes/origin/*"
        ].join("\n");
        assert.equal(parseGitConfigRemoteUrl(withOrigin), "https://github.com/a/b.git");

        const upperOrigin = [
            '[REMOTE "ORIGIN"]',
            '\turl = git@github.com:Org/Upper.git ; semicolon comment'
        ].join("\n");
        assert.equal(parseGitConfigRemoteUrl(upperOrigin), "git@github.com:Org/Upper.git");

        const fallbackOnly = [
            '[remote "upstream"]',
            "\turl = https://github.com/first/fallback.git",
            '[remote "mirror"]',
            "\turl = https://github.com/second/mirror.git"
        ].join("\n");
        assert.equal(parseGitConfigRemoteUrl(fallbackOnly), "https://github.com/first/fallback.git");

        const noRemotes = "[core]\n\tbare = false\n";
        assert.equal(parseGitConfigRemoteUrl(noRemotes), null);
    });

    it("1.3 Detects normal repo, monorepo #subpath, standard worktree, and bare-repo sibling worktrees", () => {
        // 1) Normal repo + monorepo subpath
        const monoRoot = path.join(tempRoot, "mono");
        const monoGitDir = path.join(monoRoot, ".git");
        const apiSubdir = path.join(monoRoot, "packages", "api");
        fs.mkdirSync(monoGitDir, { recursive: true });
        fs.mkdirSync(apiSubdir, { recursive: true });
        fs.writeFileSync(
            path.join(monoGitDir, "config"),
            '[remote "origin"]\n\turl = https://github.com/Org/Mono.git\n',
            "utf8"
        );

        const rootId = detectGitIdentity(monoRoot);
        assert.ok(rootId);
        assert.equal(rootId.gitIdentity, "github.com/org/mono");
        assert.equal(rootId.isWorktree, false);
        assert.equal(rootId.repoSubpath, "");

        const subId = detectGitIdentity(apiSubdir);
        assert.ok(subId);
        assert.equal(subId.gitIdentity, "github.com/org/mono#packages/api");
        assert.equal(subId.isWorktree, false);
        assert.equal(subId.repoSubpath, "packages/api");
        assert.equal(subId.gitCommonDir, rootId.gitCommonDir);
        assert.equal(subId.gitWorkTreeRoot, rootId.gitWorkTreeRoot);

        // 2) Standard git worktree (.git pointer file + commondir)
        const stdWtMeta = path.join(monoGitDir, "worktrees", "feat-a");
        const stdWtDir = path.join(tempRoot, "mono-feat-a");
        fs.mkdirSync(stdWtMeta, { recursive: true });
        fs.mkdirSync(stdWtDir, { recursive: true });
        fs.writeFileSync(path.join(stdWtMeta, "commondir"), "../..\n", "utf8");
        fs.writeFileSync(path.join(stdWtDir, ".git"), `gitdir: ${stdWtMeta}\n`, "utf8");

        const stdWtId = detectGitIdentity(stdWtDir);
        assert.ok(stdWtId);
        assert.equal(stdWtId.gitCommonDir, rootId.gitCommonDir);
        assert.equal(stdWtId.gitIdentity, "github.com/org/mono");
        assert.equal(stdWtId.isWorktree, true);
        assert.equal(stdWtId.repoSubpath, "");

        // 3) Bare repo + two sibling worktrees
        const bareDir = path.join(tempRoot, "project.git");
        const bareWtMeta1 = path.join(bareDir, "worktrees", "wt-1");
        const bareWtMeta2 = path.join(bareDir, "worktrees", "wt-2");
        const sibling1 = path.join(tempRoot, "wt-1");
        const sibling2 = path.join(tempRoot, "wt-2");
        fs.mkdirSync(bareWtMeta1, { recursive: true });
        fs.mkdirSync(bareWtMeta2, { recursive: true });
        fs.mkdirSync(sibling1, { recursive: true });
        fs.mkdirSync(sibling2, { recursive: true });

        fs.writeFileSync(
            path.join(bareDir, "config"),
            '[core]\n\tbare = true\n[remote "origin"]\n\turl = git@github.com:Team/BareApp.git\n',
            "utf8"
        );
        fs.writeFileSync(path.join(bareWtMeta1, "commondir"), "../..\n", "utf8");
        fs.writeFileSync(path.join(bareWtMeta2, "commondir"), "../..\n", "utf8");
        fs.writeFileSync(path.join(sibling1, ".git"), `gitdir: ${bareWtMeta1}\n`, "utf8");
        fs.writeFileSync(path.join(sibling2, ".git"), `gitdir: ${bareWtMeta2}\n`, "utf8");

        const bareId1 = detectGitIdentity(sibling1);
        const bareId2 = detectGitIdentity(sibling2);
        assert.ok(bareId1);
        assert.ok(bareId2);
        assert.equal(bareId1.gitCommonDir, bareId2.gitCommonDir);
        assert.equal(bareId1.repoSubpath, "");
        assert.equal(bareId2.repoSubpath, "");
        assert.equal(bareId1.isWorktree, true);
        assert.equal(bareId2.isWorktree, true);
        assert.equal(bareId1.gitIdentity, "github.com/team/bareapp");
        assert.equal(bareId2.gitIdentity, "github.com/team/bareapp");
    });

    it("1.4 Falls back to root-commit SHA in logs/HEAD (surviving folder moves) and commonDir before first commit", () => {
        const rootSha = "abcdef1234567890abcdef1234567890abcdef12";
        const repoOld = path.join(tempRoot, "local-repo-old");
        const logsDir = path.join(repoOld, ".git", "logs");
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(path.join(repoOld, ".git", "config"), "[core]\n\tbare = false\n", "utf8");
        fs.writeFileSync(
            path.join(logsDir, "HEAD"),
            `0000000000000000000000000000000000000000 ${rootSha} Dev <dev@example.com> 1700000000 +0000\tcommit (initial): init\n`,
            "utf8"
        );

        const beforeMove = detectGitIdentity(repoOld);
        assert.ok(beforeMove);
        assert.equal(beforeMove.gitIdentity, `local-git-root:${rootSha}`);

        const repoMoved = path.join(tempRoot, "local-repo-moved");
        fs.renameSync(repoOld, repoMoved);

        const afterMove = detectGitIdentity(repoMoved);
        assert.ok(afterMove);
        assert.equal(afterMove.gitIdentity, `local-git-root:${rootSha}`);

        // Repo with no logs/HEAD (before first commit)
        const freshRepo = path.join(tempRoot, "fresh-repo");
        fs.mkdirSync(path.join(freshRepo, ".git"), { recursive: true });
        const freshId = detectGitIdentity(freshRepo);
        assert.ok(freshId);
        const normCommon = freshId.gitCommonDir.replace(/\\/g, "/").replace(/\/+$/, "");
        const expectedPrefix =
            process.platform === "win32" ? `local-git:${normCommon.toLowerCase()}` : `local-git:${normCommon}`;
        assert.equal(freshId.gitIdentity, expectedPrefix);
    });

    it("1.5 Review Focus #1: Returns null safely on corrupt .git pointer or oversized >256KB .git/config", () => {
        const corruptRepo = path.join(tempRoot, "corrupt-pointer");
        fs.mkdirSync(corruptRepo, { recursive: true });
        fs.writeFileSync(path.join(corruptRepo, ".git"), "not a valid gitdir pointer\n", "utf8");
        assert.equal(detectGitIdentity(corruptRepo), null);

        const oversizedRepo = path.join(tempRoot, "oversized-config");
        fs.mkdirSync(path.join(oversizedRepo, ".git"), { recursive: true });
        const bigConfig = "[core]\n\tbare = false\n" + "#".repeat(300 * 1024);
        fs.writeFileSync(path.join(oversizedRepo, ".git", "config"), bigConfig, "utf8");
        assert.equal(detectGitIdentity(oversizedRepo), null);
    });
});

describe("Remote URI Parsing, Validation, & Bidirectional WSL Aliasing", () => {
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mem-remote-test-"));
    });

    afterEach(() => {
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it("2.1 Parses and canonicalizes vscode-remote, ssh, wsl, devcontainer, and remote URIs", () => {
        assert.ok(REMOTE_SCHEMES instanceof Set);
        for (const scheme of ["vscode-remote:", "ssh:", "wsl:", "devcontainer:", "remote:"]) {
            assert.ok(REMOTE_SCHEMES.has(scheme));
        }

        assert.equal(isRemoteUri("vscode-remote://ssh-remote+dev/home/user/my-app"), true);
        assert.equal(isRemoteUri("  SSH://host/srv/app  "), true);
        assert.equal(isRemoteUri("file:///tmp/my-app"), false);
        assert.equal(isRemoteUri("/tmp/my-app"), false);

        const cases = [
            {
                input: "vscode-remote://SSH-Remote+Dev/home/user/my-app/",
                canonicalPath: "vscode-remote://ssh-remote+dev/home/user/my-app",
                remoteScheme: "vscode-remote",
                slug: "my-app"
            },
            {
                input: "SSH://User@Host.Example:22/srv/My-App///",
                canonicalPath: "ssh://user@host.example:22/srv/My-App",
                remoteScheme: "ssh",
                slug: "my-app"
            },
            {
                input: "wsl://Ubuntu/home/dev/my-app/",
                canonicalPath: "wsl://ubuntu/home/dev/my-app",
                remoteScheme: "wsl",
                slug: "my-app"
            },
            {
                input: "devcontainer://MyContainer/workspaces/my-app/",
                canonicalPath: "devcontainer://mycontainer/workspaces/my-app",
                remoteScheme: "devcontainer",
                slug: "my-app"
            },
            {
                input: "remote://Custom-Host/opt/my-app",
                canonicalPath: "remote://custom-host/opt/my-app",
                remoteScheme: "remote",
                slug: "my-app"
            }
        ];

        for (const tc of cases) {
            const parsed = validateOrParseProjectPath(tc.input);
            assert.equal(parsed.isRemote, true);
            assert.equal(parsed.remoteScheme, tc.remoteScheme);
            assert.equal(parsed.canonicalPath, tc.canonicalPath);
            assert.equal(parsed.slug, tc.slug);
            assert.equal(validateProjectPath(tc.input), tc.canonicalPath);
        }

        const rootUri = validateOrParseProjectPath("ssh://Host/");
        assert.equal(rootUri.isRemote, true);
        assert.equal(rootUri.remoteScheme, "ssh");
        assert.equal(rootUri.canonicalPath, "ssh://host/");
    });

    it("2.2 Review Focus #2: Allows valid percent-encoded spaces while rejecting null bytes, empty authority, raw '..', and encoded '%2e%2e' traversal", () => {
        const spaced = validateOrParseProjectPath("vscode-remote://ssh-remote+dev/home/user/My%20App/");
        assert.equal(spaced.isRemote, true);
        assert.equal(spaced.remoteScheme, "vscode-remote");
        assert.equal(spaced.canonicalPath, "vscode-remote://ssh-remote+dev/home/user/My%20App");
        assert.equal(spaced.slug, "my-app");

        const rejected = [
            "ssh://host/home/%2e%2e/etc",
            "ssh://host/home/%2e%2e%2fetc",
            "ssh://host/home/../etc",
            "ssh://host/home/./etc",
            "ssh://host/home/%2e/etc",
            "ssh://host/home/%ZZ/etc",
            "ssh:///home/app",
            "ssh://host/app\0",
            "ssh://host/app\x07"
        ];
        for (const bad of rejected) {
            assert.throws(() => validateOrParseProjectPath(bad), Error, `Expected rejection for: ${bad}`);
        }
    });

    it("2.3 Canonicalizes Windows WSL UNC paths directly to virtual wsl:// without fs.statSync probe and supports bidirectional getWslEquivalentKeys", (t) => {
        assert.equal(pathsFacade.isWslUncPath, isWslUncPath);

        for (const unc of [
            "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
            "//wsl.localhost/Ubuntu/home/dev/app",
            "\\\\wsl$\\Ubuntu-22.04\\home\\dev\\app",
            "//wsl$/Ubuntu/home/dev/app",
            "  \\\\WSL.LOCALHOST\\Ubuntu\\  "
        ]) {
            assert.equal(isWslUncPath(unc), true, `Expected isWslUncPath true for: ${unc}`);
        }
        for (const nonUnc of [
            "wsl://ubuntu/home/dev/app",
            "/tmp/local-project",
            "C:\\Users\\dev\\app",
            "\\\\server\\share\\folder",
            "",
            null,
            undefined
        ]) {
            assert.equal(isWslUncPath(nonUnc), false, `Expected isWslUncPath false for: ${nonUnc}`);
        }

        const statSpy = t.mock.method(fs, "statSync");

        for (const uncInput of [
            "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
            "//wsl.localhost/Ubuntu/home/dev/app",
            "\\\\wsl$\\Ubuntu\\home\\dev\\app",
            "//wsl$/Ubuntu/home/dev/app"
        ]) {
            const parsed = validateOrParseProjectPath(uncInput);
            assert.equal(parsed.isRemote, true);
            assert.equal(parsed.remoteScheme, "wsl");
            assert.equal(parsed.canonicalPath, "wsl://ubuntu/home/dev/app");
            assert.equal(parsed.normalizedForHash, "wsl://ubuntu/home/dev/app");
            assert.equal(parsed.slug, "app");
        }

        assert.equal(statSpy.mock.callCount(), 0, "fs.statSync must never be called for WSL UNC paths");

        const fromWsl = getWslEquivalentKeys("wsl://ubuntu/home/dev/app");
        assert.ok(fromWsl.includes("//wsl.localhost/ubuntu/home/dev/app"));
        assert.ok(fromWsl.includes("//wsl$/ubuntu/home/dev/app"));
        assert.ok(fromWsl.includes("wsl://ubuntu/home/dev/app"));

        const fromUnc = getWslEquivalentKeys("\\\\wsl.localhost\\Ubuntu\\home\\dev\\app");
        assert.ok(fromUnc.includes("wsl://ubuntu/home/dev/app"));
        assert.ok(fromUnc.includes("//wsl.localhost/ubuntu/home/dev/app"));
        assert.ok(fromUnc.includes("//wsl$/ubuntu/home/dev/app"));

        const fromDollar = getWslEquivalentKeys("//wsl$/Ubuntu/home/dev/app/");
        assert.ok(fromDollar.includes("wsl://ubuntu/home/dev/app"));
        assert.ok(fromDollar.includes("//wsl.localhost/ubuntu/home/dev/app"));
        assert.ok(fromDollar.includes("//wsl$/ubuntu/home/dev/app"));

        assert.deepEqual(getWslEquivalentKeys("/tmp/local-project"), ["/tmp/local-project"]);

        assert.equal(
            normalizeForIndexCompare("SSH://Host.Local/srv/MyApp/"),
            "ssh://host.local/srv/MyApp"
        );
        assert.equal(
            normalizeForIndexCompare("/tmp/MyApp/"),
            process.platform === "win32" ? "/tmp/myapp" : "/tmp/MyApp"
        );
    });

    it("2.4 Preserves strict local validation errors for relative and missing local paths", () => {
        assert.throws(() => validateOrParseProjectPath("./"), /relative paths/i);
        assert.throws(() => validateOrParseProjectPath("relative/dir"), /relative paths/i);

        const missingDir = path.join(tempRoot, "missing-workspace");
        assert.throws(
            () => validateOrParseProjectPath(missingDir),
            (err) => err instanceof Error && /does not exist/i.test(err.message) && /remote/i.test(err.message)
        );

        const realDir = path.join(tempRoot, "existing-app");
        fs.mkdirSync(realDir, { recursive: true });
        const parsedLocal = validateOrParseProjectPath(realDir);
        assert.equal(parsedLocal.isRemote, false);
        assert.equal(parsedLocal.remoteScheme, null);
        assert.equal(parsedLocal.slug, "existing-app");
        assert.equal(validateProjectPath(realDir), parsedLocal.canonicalPath);
        assert.equal(validateProjectPath(pathToFileURL(realDir).href), parsedLocal.canonicalPath);

        const filePath = path.join(tempRoot, "not-a-dir.txt");
        fs.writeFileSync(filePath, "hello", "utf8");
        assert.throws(() => validateOrParseProjectPath(filePath), /expected a directory/i);
    });
});

describe("Locked projects_index.json v4 Registry, 4-Step Resolution, Upgrade Lifecycle & Clone Disambiguation", () => {
    let tempRoot;
    let dataDir;
    let prevDataDir;

    beforeEach(() => {
        prevDataDir = process.env.AG_MEMORY_DATA_DIR;
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mem-registry-test-"));
        dataDir = path.join(tempRoot, "data-vault");
        fs.mkdirSync(dataDir, { recursive: true });
        process.env.AG_MEMORY_DATA_DIR = dataDir;
    });

    afterEach(() => {
        if (prevDataDir === undefined) {
            delete process.env.AG_MEMORY_DATA_DIR;
        } else {
            process.env.AG_MEMORY_DATA_DIR = prevDataDir;
        }
        if (tempRoot) {
            try {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            } catch {
                // Ignore transient temp cleanup delay
            }
        }
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
        // Add a WSL-equivalent alias onto a third entry E3 and an extra alias onto E2 in a sub-case
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
});

describe("Workspace File Classification, Symlink/file:// Resolution, & Remote/Linked Normalization", () => {
    let tempRoot;
    let dataDir;
    let prevDataDir;

    beforeEach(() => {
        prevDataDir = process.env.AG_MEMORY_DATA_DIR;
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mem-files-test-"));
        dataDir = path.join(tempRoot, "data-vault");
        fs.mkdirSync(dataDir, { recursive: true });
        process.env.AG_MEMORY_DATA_DIR = dataDir;
    });

    afterEach(() => {
        if (prevDataDir === undefined) {
            delete process.env.AG_MEMORY_DATA_DIR;
        } else {
            process.env.AG_MEMORY_DATA_DIR = prevDataDir;
        }
        if (tempRoot) {
            try {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            } catch {
                // Ignore transient temp cleanup delay
            }
        }
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
});

describe("Store Guardrails, Remote-Safe Prep/Staleness, & configureWorkspace Controller", () => {
    let tempRoot;
    let dataDir;
    let prevDataDir;

    beforeEach(() => {
        prevDataDir = process.env.AG_MEMORY_DATA_DIR;
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mem-store-guard-test-"));
        dataDir = path.join(tempRoot, "data-vault");
        fs.mkdirSync(dataDir, { recursive: true });
        process.env.AG_MEMORY_DATA_DIR = dataDir;
    });

    afterEach(() => {
        closeAllDatabases();
        if (prevDataDir === undefined) {
            delete process.env.AG_MEMORY_DATA_DIR;
        } else {
            process.env.AG_MEMORY_DATA_DIR = prevDataDir;
        }
        if (tempRoot) {
            try {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            } catch {
                // Ignore transient Windows temp cleanup delay
            }
        }
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
});

describe("Multi-Folder & Remote-Aware SessionStart Hook", () => {
    let tempRoot;
    let dataDir;
    let prevDataDir;

    beforeEach(() => {
        prevDataDir = process.env.AG_MEMORY_DATA_DIR;
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mem-hook-test-"));
        dataDir = path.join(tempRoot, "data-vault");
        fs.mkdirSync(dataDir, { recursive: true });
        process.env.AG_MEMORY_DATA_DIR = dataDir;
    });

    afterEach(() => {
        closeAllDatabases();
        if (prevDataDir === undefined) {
            delete process.env.AG_MEMORY_DATA_DIR;
        } else {
            process.env.AG_MEMORY_DATA_DIR = prevDataDir;
        }
        if (tempRoot) {
            try {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            } catch {
                // Ignore transient Windows temp cleanup delay
            }
        }
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
});
