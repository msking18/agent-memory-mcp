import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { closeAllDatabases } from "../../src/db.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const INDEX_JS = path.join(REPO_ROOT, "index.js");
export const HOOK_JS = path.join(REPO_ROOT, "src", "session-start-hook.js");

export function createTempVaultEnv(prefix = "ag-mem-test-") {
    const prevDataDir = process.env.AG_MEMORY_DATA_DIR;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const dataDir = path.join(tempRoot, "data-vault");
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.AG_MEMORY_DATA_DIR = dataDir;
    return { tempRoot, dataDir, prevDataDir };
}

export function cleanupTempVaultEnv({ tempRoot, prevDataDir } = {}) {
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
}

export function initLocalGitRepo(repoDir, remoteUrl = null) {
    const gitDir = path.join(repoDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    const content = remoteUrl
        ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remoteUrl}\n`
        : "[core]\n\tbare = false\n";
    fs.writeFileSync(path.join(gitDir, "config"), content, "utf8");
    return gitDir;
}

export async function withMcpClient(dataDir, fn, extraEnv = {}) {
    closeAllDatabases();
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--no-warnings", INDEX_JS],
        env: { ...process.env, AG_MEMORY_DATA_DIR: dataDir, ...extraEnv },
        stderr: "pipe"
    });
    const client = new Client({ name: "ag-memory-test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}
