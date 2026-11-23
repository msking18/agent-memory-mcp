import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { normalizeForIndexCompare, validateProjectPath } from "../../src/paths/remote.js";
import { getProjectStoreInfo } from "../../src/paths/registry.js";
import { createTempVaultEnv, cleanupTempVaultEnv, withMcpClient } from "../helpers/env.js";

describe("MCP Tool #16 Registration, Cross-Folder Guardrails & Clone Relinking", () => {
    let tempRoot;
    let dataDir;
    let prevDataDir;

    beforeEach(() => {
        ({ tempRoot, dataDir, prevDataDir } = createTempVaultEnv("ag-mem-mcp-e2e-pol-"));
    });

    afterEach(() => {
        cleanupTempVaultEnv({ tempRoot, prevDataDir });
    });

    it("7.1 End-to-end MCP stdio verification of configure_workspace, remote git_remote binding, cross-folder guardrail, and v4 memory://projects resource", async () => {
        const projA = path.join(tempRoot, "e2e-proj-a");
        const toolLib = path.join(tempRoot, "e2e-tool-lib");
        const projB = path.join(tempRoot, "e2e-proj-b");
        fs.mkdirSync(path.join(projA, "src"), { recursive: true });
        fs.mkdirSync(path.join(toolLib, "src"), { recursive: true });
        fs.mkdirSync(path.join(projB, "src"), { recursive: true });
        fs.writeFileSync(path.join(projA, "src", "app.ts"), "export const app = 1;\n", "utf8");
        fs.writeFileSync(path.join(toolLib, "src", "lib.ts"), "export const lib = 1;\n", "utf8");
        const fileB = path.join(projB, "src", "secret.ts");
        fs.writeFileSync(fileB, "export const secret = 1;\n", "utf8");

        await withMcpClient(dataDir, async (client) => {
            const { tools } = await client.listTools();
            assert.equal(tools.length, 16);
            const configTool = tools.find((t) => t.name === "configure_workspace");
            assert.ok(configTool, "configure_workspace must be registered");
            assert.equal(configTool.annotations?.readOnlyHint, false);

            // 1) configure_workspace: set_folder_policy, link_project_identity, inspect
            const policyRes = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "set_folder_policy",
                    primary_path: projA,
                    folder_path: toolLib,
                    mode: "linked",
                    folder_slug: "tool-lib"
                }
            });
            assert.ok(!policyRes.isError);
            assert.match(policyRes.content[0].text, /@tool-lib\//);

            const linkRemoteRes = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "link_project_identity",
                    project_path: "ssh://dev/home/linked-app",
                    git_remote: "https://github.com/org/linked-remote.git"
                }
            });
            assert.ok(!linkRemoteRes.isError);
            assert.match(linkRemoteRes.content[0].text, /registered_remote/);
            assert.match(linkRemoteRes.content[0].text, /github\.com\/org\/linked-remote/);

            const inspectRes = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "inspect",
                    project_path: projA,
                    workspace_paths: [projA, toolLib, projB]
                }
            });
            assert.ok(!inspectRes.isError);
            assert.match(inspectRes.content[0].text, /@tool-lib\//);
            assert.match(inspectRes.content[0].text, /Workspace Folders:/);

            // 2) check_memory_status + save_project_memory on "ssh://dev/home/app" with git_remote
            const remoteUri = "ssh://dev/home/app";
            const remoteStatus = await client.callTool({
                name: "check_memory_status",
                arguments: {
                    project_path: remoteUri,
                    git_remote: "https://github.com/org/ssh-app.git"
                }
            });
            assert.ok(!remoteStatus.isError);
            assert.match(remoteStatus.content[0].text, /UNINITIALIZED/);

            const remoteSave = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: remoteUri,
                    title: "Tech Stack & Ecosystem",
                    summary: "Remote SSH service.",
                    tags: ["architecture"],
                    files: ["ssh://dev/home/app/src/server.ts", "/home/app/src/routes.ts"],
                    git_remote: "https://github.com/org/ssh-app.git"
                }
            });
            assert.ok(!remoteSave.isError);
            assert.match(remoteSave.content[0].text, /tech-stack/);

            const remoteRead = await client.callTool({
                name: "read_memory_node",
                arguments: {
                    project_path: remoteUri,
                    id: "tech-stack"
                }
            });
            assert.ok(!remoteRead.isError);
            assert.match(remoteRead.content[0].text, /src\/server\.ts/);
            assert.equal(remoteRead.content[0].text.includes("[STALE WARNING]"), false);

            // 3) Cross-folder guardrail on A referencing B's file -> isError: true, then allow_external_files: true
            const saveB = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projB,
                    title: "Project B Core",
                    summary: "Owns secret.ts.",
                    files: ["src/secret.ts"]
                }
            });
            assert.ok(!saveB.isError);

            const blockedA = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projA,
                    title: "Cross-Folder Reference",
                    summary: "Touches B secret.",
                    files: [fileB]
                }
            });
            assert.equal(blockedA.isError, true);
            assert.match(blockedA.content[0].text, /Cross-folder write guardrail blocked/);
            assert.ok(blockedA.content[0].text.includes(validateProjectPath(projB)));

            const allowedA = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projA,
                    title: "Cross-Folder Reference",
                    summary: "Explicitly allowed external ref to B.",
                    files: [fileB],
                    allow_external_files: true
                }
            });
            assert.ok(!allowedA.isError);

            // 4) Read memory://projects resource -> version === 4 and workspacePolicies present
            const resContent = await client.readResource({ uri: "memory://projects" });
            const indexJson = JSON.parse(resContent.contents[0].text);
            assert.equal(indexJson.version, 4);
            assert.ok(indexJson.workspacePolicies && typeof indexJson.workspacePolicies === "object");
            const normA = normalizeForIndexCompare(validateProjectPath(projA), false);
            const normToolLib = normalizeForIndexCompare(validateProjectPath(toolLib), false);
            assert.equal(indexJson.workspacePolicies[normA]?.[normToolLib]?.mode, "linked");
            assert.equal(indexJson.workspacePolicies[normA]?.[normToolLib]?.folderSlug, "tool-lib");
            const sshEntry = Object.values(indexJson.projects).find((p) => p.canonicalPath === remoteUri);
            assert.equal(sshEntry?.gitIdentity, "github.com/org/ssh-app");
        });
    });

    it("7.2 MCP stdio verification of update_memory_node and record_dead_end allow_external_files guardrail and linked @<folderSlug>/ read queries", async () => {
        const projA = path.join(tempRoot, "e2e-72-a");
        const toolB = path.join(tempRoot, "e2e-72-tool-b");
        const externalC = path.join(tempRoot, "e2e-72-ext-c");
        fs.mkdirSync(path.join(projA, "src"), { recursive: true });
        fs.mkdirSync(path.join(toolB, "src"), { recursive: true });
        fs.mkdirSync(path.join(externalC, "src"), { recursive: true });

        const linkedFileB = path.join(toolB, "src", "util.ts");
        const extFileC = path.join(externalC, "src", "ext.ts");
        fs.writeFileSync(path.join(projA, "src", "main.ts"), "export const main = 1;\n", "utf8");
        fs.writeFileSync(linkedFileB, "export const util = 1;\n", "utf8");
        fs.writeFileSync(extFileC, "export const ext = 1;\n", "utf8");

        await withMcpClient(dataDir, async (client) => {
            const pol = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "set_folder_policy",
                    primary_path: projA,
                    folder_path: toolB,
                    mode: "linked",
                    folder_slug: "shared-lib"
                }
            });
            assert.ok(!pol.isError);

            await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: externalC,
                    title: "External C Core",
                    summary: "Owns ext.ts.",
                    files: ["src/ext.ts"]
                }
            });

            const savedA = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: projA,
                    title: "Primary Shared Utility Usage",
                    summary: "Uses linked shared-lib util.ts.",
                    files: [linkedFileB]
                }
            });
            assert.ok(!savedA.isError);
            const idMatch = savedA.content[0].text.match(/\[(m-[a-f0-9]+)\]/);
            assert.ok(idMatch);
            const nodeId = idMatch[1];

            // update_memory_node blocked on externalC without allow_external_files, succeeds with allow_external_files: true
            const updBlocked = await client.callTool({
                name: "update_memory_node",
                arguments: {
                    project_path: projA,
                    id: nodeId,
                    files: [linkedFileB, extFileC]
                }
            });
            assert.equal(updBlocked.isError, true);
            assert.match(updBlocked.content[0].text, /Cross-folder write guardrail blocked/);

            const updAllowed = await client.callTool({
                name: "update_memory_node",
                arguments: {
                    project_path: projA,
                    id: nodeId,
                    files: [linkedFileB, extFileC],
                    allow_external_files: true
                }
            });
            assert.ok(!updAllowed.isError);

            // record_dead_end blocked on externalC without allow_external_files, succeeds with allow_external_files: true
            const deBlocked = await client.callTool({
                name: "record_dead_end",
                arguments: {
                    project_path: projA,
                    error_pattern: "External C schema mismatch",
                    attempted_solution: "Edited C directly",
                    root_cause: "Needs migration script",
                    files: [extFileC]
                }
            });
            assert.equal(deBlocked.isError, true);

            const deAllowed = await client.callTool({
                name: "record_dead_end",
                arguments: {
                    project_path: projA,
                    error_pattern: "External C schema mismatch",
                    attempted_solution: "Edited C directly",
                    root_cause: "Needs migration script",
                    files: [extFileC],
                    allow_external_files: true
                }
            });
            assert.ok(!deAllowed.isError);

            // Linked dead-end + get_file_memories / check_dead_ends normalization via primary project_path
            const linkedDe = await client.callTool({
                name: "record_dead_end",
                arguments: {
                    project_path: projA,
                    error_pattern: "Shared-lib BOM failure",
                    attempted_solution: "Stripped first byte",
                    root_cause: "Broke UTF-8 header",
                    files: [linkedFileB]
                }
            });
            assert.ok(!linkedDe.isError);
            assert.match(linkedDe.content[0].text, /@shared-lib\/src\/util\.ts/);

            const fileMems = await client.callTool({
                name: "get_file_memories",
                arguments: {
                    project_path: projA,
                    file_paths: [linkedFileB]
                }
            });
            assert.ok(!fileMems.isError);
            assert.match(fileMems.content[0].text, /Primary Shared Utility Usage/);
            assert.match(fileMems.content[0].text, /Shared-lib BOM failure|Stripped first byte/);

            const deCheck = await client.callTool({
                name: "check_dead_ends",
                arguments: {
                    project_path: projA,
                    file_path: linkedFileB
                }
            });
            assert.ok(!deCheck.isError);
            assert.match(deCheck.content[0].text, /Shared-lib BOM failure/);
        });
    });

    it("7.3 MCP stdio verification of force_isolate and link_project_identity clone disambiguation and source_project_path relinking", async () => {
        const clone1 = path.join(tempRoot, "e2e-clone-1");
        const clone2 = path.join(tempRoot, "e2e-clone-2");
        const clone3 = path.join(tempRoot, "e2e-clone-3");
        const movedOld = path.join(tempRoot, "e2e-moved-old");
        const movedNew = path.join(tempRoot, "e2e-moved-new");

        for (const dir of [clone1, clone2, clone3]) {
            fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
            fs.writeFileSync(
                path.join(dir, ".git", "config"),
                '[remote "origin"]\n\turl = https://github.com/org/e2e-starter.git\n',
                "utf8"
            );
        }
        fs.mkdirSync(movedOld, { recursive: true });
        fs.mkdirSync(movedNew, { recursive: true });

        await withMcpClient(dataDir, async (client) => {
            const c1Save = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: clone1,
                    title: "Tech Stack & Ecosystem",
                    summary: "Clone 1 primary project.",
                    tags: ["architecture"]
                }
            });
            assert.ok(!c1Save.isError);
            const c1StoreKey = getProjectStoreInfo(clone1).storeKey;

            const c2Status = await client.callTool({
                name: "check_memory_status",
                arguments: { project_path: clone2 }
            });
            assert.ok(!c2Status.isError);
            assert.match(c2Status.content[0].text, /\[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED\]/);

            const c2Blocked = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: clone2,
                    title: "Tech Stack & Ecosystem",
                    summary: "Accidental overwrite."
                }
            });
            assert.equal(c2Blocked.isError, true);
            assert.match(c2Blocked.content[0].text, /CLONE DISAMBIGUATION/i);

            const c2Forced = await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: clone2,
                    title: "Tech Stack & Ecosystem",
                    summary: "Isolated clone 2 project.",
                    tags: ["architecture"],
                    force_isolate: true
                }
            });
            assert.ok(!c2Forced.isError);
            assert.notEqual(getProjectStoreInfo(clone2).storeKey, c1StoreKey);

            // Share clone1 store explicitly with clone3 via target_store_key
            const c3Link = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "link_project_identity",
                    project_path: clone3,
                    target_store_key: c1StoreKey
                }
            });
            assert.ok(!c3Link.isError);
            assert.ok(c3Link.content[0].text.includes(c1StoreKey));

            const c3Read = await client.callTool({
                name: "read_memory_node",
                arguments: { project_path: clone3, id: "tech-stack" }
            });
            assert.ok(!c3Read.isError);
            assert.match(c3Read.content[0].text, /Clone 1 primary project/);

            // Relink deleted movedOld -> movedNew via source_project_path
            await client.callTool({
                name: "save_project_memory",
                arguments: {
                    project_path: movedOld,
                    title: "Tech Stack & Ecosystem",
                    summary: "Moved folder memory preserved.",
                    tags: ["architecture"]
                }
            });
            fs.rmSync(movedOld, { recursive: true, force: true });

            const relinkMoved = await client.callTool({
                name: "configure_workspace",
                arguments: {
                    action: "link_project_identity",
                    project_path: movedNew,
                    source_project_path: movedOld
                }
            });
            assert.ok(!relinkMoved.isError);

            const movedRead = await client.callTool({
                name: "read_memory_node",
                arguments: { project_path: movedNew, id: "tech-stack" }
            });
            assert.ok(!movedRead.isError);
            assert.match(movedRead.content[0].text, /Moved folder memory preserved/);
        });
    });
});
