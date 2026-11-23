import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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
    getWslEquivalentKeys,
    normalizeForIndexCompare,
    validateOrParseProjectPath,
    validateProjectPath
} from "../src/paths/remote.js";

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

    it("2.3 Handles Windows WSL UNC fallback and bidirectional getWslEquivalentKeys", () => {
        const wslLocalhost = validateOrParseProjectPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\app");
        assert.equal(wslLocalhost.isRemote, true);
        assert.equal(wslLocalhost.remoteScheme, "wsl");
        assert.equal(wslLocalhost.canonicalPath, "wsl://ubuntu/home/dev/app");
        assert.equal(wslLocalhost.slug, "app");

        const wslDollar = validateOrParseProjectPath("\\\\wsl$\\Ubuntu\\home\\dev\\app");
        assert.equal(wslDollar.isRemote, true);
        assert.equal(wslDollar.remoteScheme, "wsl");
        assert.equal(wslDollar.canonicalPath, "wsl://ubuntu/home/dev/app");
        assert.equal(wslDollar.slug, "app");

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
