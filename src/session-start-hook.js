#!/usr/bin/env node

/**
 * @file src/session-start-hook.js
 * @description Google Antigravity SessionStart lifecycle hook.
 * Inspects open workspace directories on editor startup and injects pre-hydrated
 * memory context and session timelines directly into the initial system prompt.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMemoryStatus } from "./store.js";
import { closeAllDatabases } from "./db.js";

/**
 * Processes an Antigravity SessionStart hook JSON payload and returns
 * the hook stdout response object (never throws).
 */
export function runSessionStartPayload(payload) {
    try {
        if (!payload || typeof payload !== "object") {
            return {};
        }

        const workspacePaths = Array.isArray(payload.workspacePaths)
            ? payload.workspacePaths.filter((p) => typeof p === "string" && p.trim().length > 0)
            : [];

        // No active workspace -> silent no-op (zero friction in scratch / general chats)
        if (workspacePaths.length === 0) {
            return {};
        }

        const primaryWorkspace = workspacePaths[0].trim();
        const status = checkMemoryStatus(primaryWorkspace, {
            include_timeline: true,
            timeline_limit: 5
        });

        const header = status.initialized
            ? `[AGENT-MEMORY AUTO-HYDRATED] Startup memory check & session timeline are already loaded below for "${status.storeInfo.canonicalPath}" (no need to re-run check_memory_status or get_session_timeline):`
            : `[AGENT-MEMORY STATUS] Workspace "${status.storeInfo.canonicalPath}" is UNINITIALIZED:`;

        return {
            injectSteps: [
                {
                    systemMessage: {
                        systemMessage: `${header}\n\n${status.text}`
                    }
                }
            ]
        };
    } catch {
        // Fail-safe: never block session startup on invalid workspace paths or unexpected errors
        return {};
    } finally {
        closeAllDatabases();
    }
}

async function readStdinText() {
    if (process.stdin.isTTY) return "";
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function main() {
    const safetyTimer = setTimeout(() => {
        try {
            closeAllDatabases();
        } catch {
            // Ignore
        }
        process.stdout.write("{}\n");
        process.exit(0);
    }, 3500);
    safetyTimer.unref();

    try {
        const raw = await readStdinText();
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        const output = runSessionStartPayload(parsed);
        process.stdout.write(JSON.stringify(output) + "\n");
    } catch {
        process.stdout.write("{}\n");
    } finally {
        clearTimeout(safetyTimer);
    }
}

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    await main();
}
