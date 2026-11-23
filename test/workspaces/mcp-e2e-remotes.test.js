import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { normalizeForIndexCompare, validateProjectPath } from "../../src/paths/remote.js";
import { getProjectStoreInfo } from "../../src/paths/registry.js";
import { runSessionStartPayload } from "../../src/session-start-hook.js";
import { createTempVaultEnv, cleanupTempVaultEnv, withMcpClient } from "../helpers/env.js";

describe("MCP Schema Validation, Remote URIs & End-to-End SessionStart Policy Lifecycle", () => {
    let tempRoot;
    let dataDir;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, dataDir, prevDataDir } = createTempVaultEnv("ag-mem-mcp-e2e-rem-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("7.4 MCP stdio verification of configure_workspace schema validation, duplicate folder_slug error, and inspect conflict reporting", async () => {
        const primary = path.join(tempRoot, "e2e-val-primary");
        const sec1 = path.join(tempRoot, "e2e-val-sec1");
        const sec2 = path.join(tempRoot, "e2e-val-sec2");
        const conflictA = path.join(tempRoot, "e2e-conflict-a");
        const conflictB = path.join(tempRoot, "e2e-conflict-b");
        for (const dir of [primary, sec1, sec2, conflictA]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.mkdirSync(path.join(conflictB, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(conflictB, ".git", "config"),
            '[remote "origin"]\n\turl = https://github.com/org/e2e-conflict.git\n',
            "utf8"
        );

        await withMcpClient(dataDir, async (client) => {
            // Invalid enum action rejected at MCP boundary
            const invalidAction = await client.callTool({
                name: "configure_workspace",
                arguments: { action: "bogus_action" }
            });
            assert.equal(invalidAction.isError, true);

            // Missing required params for set_folder_policy returns isError: true
            const missingParams = await client.callTool({
                name: "configure_workspace",
                arguments: { action: "set_folder_policy", primary_path: primary }
            });
            assert.equal(missingParams.isError, true);

            // Duplicate explicit folder_slug rejected cleanly
            const firstLink = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "set_folder_policy",
                    primary_path: primary,
                    folder_path: sec1,
                    mode: "linked",
                    folder_slug: "docs"
                }
            });
            assert.ok(!firstLink.isError);

            const dupSlug = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "set_folder_policy",
                    primary_path: primary,
                    folder_path: sec2,
                    mode: "linked",
                    folder_slug: "docs"
                }
            });
            assert.equal(dupSlug.isError, true);
            assert.match(dupSlug.content[0].text, /Duplicate folder_slug/i);

            // Git identity conflict surfaced by inspect
            await client.callTool({
                name: "save_project_memory",
                arguments: { project_path: conflictA, title: "A", summary: "Pre-git A." }
            });
            await client.callTool({
                name: "save_project_memory",
                arguments: { project_path: conflictB, title: "B", summary: "Git owner B." }
            });

            fs.mkdirSync(path.join(conflictA, ".git"), { recursive: true });
            fs.writeFileSync(
                path.join(conflictA, ".git", "config"),
                '[remote "origin"]\n\turl = https://github.com/org/e2e-conflict.git\n',
                "utf8"
            );

            const inspectConflict = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "inspect",
                    project_path: conflictA,
                    workspace_paths: [conflictA, conflictB]
                }
            });
            assert.ok(!inspectConflict.isError);
            assert.match(inspectConflict.content[0].text, /\[CONFLICT\]/);
        });
    });

    it("7.5 MCP stdio verification of remote URIs (vscode-remote, wsl, WSL UNC, devcontainer) without local fs probes or false staleness", async () => {
        const missingLocal = path.join(tempRoot, "definitely-missing-local-dir");

        await withMcpClient(dataDir, async (client) => {
            const vscodeUri = "vscode-remote://ssh-remote+devbox/workspaces/My%20App";
            const saveVs = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: vscodeUri,
                    title: "Tech Stack & Ecosystem",
                    summary: "VS Code SSH remote workspace.",
                    tags: ["architecture"],
                    files: ["/workspaces/My%20App/src/app.ts", "./src/lib.ts"],
                    git_remote: "https://github.com/org/vscode-my-app.git"
                }
            });
            assert.ok(!saveVs.isError);

            const readVs = await client.callTool({
                name: "read_memory_node",
                arguments: { project_path: vscodeUri, id: "tech-stack" }
            });
            assert.ok(!readVs.isError);
            assert.match(readVs.content[0].text, /src\/app\.ts/);
            assert.match(readVs.content[0].text, /src\/lib\.ts/);
            assert.equal(readVs.content[0].text.includes("[STALE WARNING]"), false);
            assert.equal(getProjectStoreInfo(vscodeUri).gitIdentity, "github.com/org/vscode-my-app");

            // Windows WSL UNC path and wsl:// URI map to the same virtual store cleanly
            const wslUnc = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\wsl-app";
            const wslUri = "wsl://ubuntu/home/dev/wsl-app";
            const saveWsl = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: wslUnc,
                    title: "Tech Stack & Ecosystem",
                    summary: "WSL Ubuntu service.",
                    tags: ["architecture"]
                }
            });
            assert.ok(!saveWsl.isError);

            const readWsl = await client.callTool({
                name: "read_memory_node",
                arguments: { project_path: wslUri, id: "tech-stack" }
            });
            assert.ok(!readWsl.isError);
            assert.match(readWsl.content[0].text, /WSL Ubuntu service/);

            // devcontainer:// URI works end-to-end
            const devUri = "devcontainer://local-container/workspaces/svc";
            const saveDev = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: devUri,
                    title: "Devcontainer Note",
                    summary: "Containerized toolchain."
                }
            });
            assert.ok(!saveDev.isError);

            // Missing local directory still fails loudly with /does not exist/i
            const badLocal = await client.callTool({
                name: "check_memory_status",
                arguments: { project_path: missingLocal }
            });
            assert.equal(badLocal.isError, true);
            assert.match(badLocal.content[0].text, /does not exist/i);
        });
    });

    it("7.6 End-to-end SessionStart -> configure_workspace -> SessionStart policy lifecycle and cross-folder workflow", async () => {
        const projA = path.join(tempRoot, "e2e-life-a");
        const projB = path.join(tempRoot, "e2e-life-b");
        const projC = path.join(tempRoot, "e2e-life-c");
        const projD = path.join(tempRoot, "e2e-life-d");
        for (const dir of [projA, projB, projC, projD]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(path.join(projC, "guide.md"), "# Guide\n", "utf8");

        // 1) Initial SessionStart prompts for unconfigured secondary folders B, C, D
        const initialHook = runSessionStartPayload({ workspacePaths: [projA, projB, projC, projD] });
        const initialMsg = initialHook?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        assert.match(initialMsg, /\[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED\]/);
        assert.ok(initialMsg.includes(validateProjectPath(projB)));
        assert.ok(initialMsg.includes(validateProjectPath(projC)));
        assert.ok(initialMsg.includes(validateProjectPath(projD)));

        // 2) Persist user choices via MCP stdio configure_workspace & bootstrap A, B, and linked @docs-c/
        await withMcpClient(dataDir, async (client) => {
            const pB = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "set_folder_policy",
                    primary_path: projA,
                    folder_path: projB,
                    mode: "independent"
                }
            });
            assert.ok(!pB.isError);

            const pC = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "set_folder_policy",
                    primary_path: projA,
                    folder_path: projC,
                    mode: "linked",
                    folder_slug: "docs-c"
                }
            });
            assert.ok(!pC.isError);

            const pD = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "set_folder_policy",
                    primary_path: projA,
                    folder_path: projD,
                    mode: "ignored"
                }
            });
            assert.ok(!pD.isError);

            const bootA = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projA,
                    entries: [
                        {
                            slug: "tech-stack",
                            title: "Tech Stack & Ecosystem",
                            category: "architecture",
                            tags: ["architecture"],
                            summary: "Primary lifecycle app A."
                        },
                        {
                            title: "Linked C Documentation",
                            category: "note",
                            files: [path.join(projC, "guide.md")],
                            summary: "Documented under primary A."
                        }
                    ]
                }
            });
            assert.ok(!bootA.isError);

            const bootB = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projB,
                    title: "Tech Stack & Ecosystem",
                    summary: "Independent companion service B.",
                    tags: ["architecture"]
                }
            });
            assert.ok(!bootB.isError);

            const resContent = await client.readResource({ uri: "memory://projects" });
            const indexJson = JSON.parse(resContent.contents[0].text);
            assert.equal(indexJson.version, 4);
            const normA = normalizeForIndexCompare(validateProjectPath(projA), false);
            assert.equal(Object.keys(indexJson.workspacePolicies[normA] || {}).length, 3);
        });

        // 3) Re-run SessionStart -> zero multi-folder prompts, A & B hydrated, C linked, D ignored
        const nextHook = runSessionStartPayload({ workspacePaths: [projA, projB, projC, projD] });
        const nextMsg = nextHook?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        assert.match(nextMsg, /\[AGENT-MEMORY AUTO-HYDRATED\]/);
        assert.ok(nextMsg.includes("Primary lifecycle app A."));
        assert.match(nextMsg, /Secondary Workspace/);
        assert.ok(nextMsg.includes("Independent companion service B."));
        assert.ok(nextMsg.includes("@docs-c/"));
        assert.match(nextMsg, /Ignored secondary/i);
        assert.ok(nextMsg.includes(validateProjectPath(projD)));
        assert.equal(nextMsg.includes("[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]"), false);
    });
});
