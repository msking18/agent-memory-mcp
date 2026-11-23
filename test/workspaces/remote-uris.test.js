import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    REMOTE_SCHEMES,
    isRemoteUri,
    isWslUncPath,
    getWslEquivalentKeys,
    normalizeForIndexCompare,
    validateOrParseProjectPath,
    validateProjectPath
} from "../../src/paths/remote.js";
import * as pathsFacade from "../../src/paths.js";

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
        const upperFileUri = pathToFileURL(realDir).href.replace(/^file:/, "FILE:");
        assert.equal(validateProjectPath(upperFileUri), parsedLocal.canonicalPath);
        assert.equal(
            normalizeForIndexCompare(upperFileUri, false),
            normalizeForIndexCompare(parsedLocal.canonicalPath, false)
        );

        const filePath = path.join(tempRoot, "not-a-dir.txt");
        fs.writeFileSync(filePath, "hello", "utf8");
        assert.throws(() => validateOrParseProjectPath(filePath), /expected a directory/i);
    });
});
