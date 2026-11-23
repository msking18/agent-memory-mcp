/**
 * @file src/paths/registry/storage.js
 * @description Level 0 registry storage primitives: data/stores/backups directory helpers,
 * file-locked atomic `projects_index.json` v4 persistence, and lookup key helpers.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    isRemoteUri,
    getWslEquivalentKeys,
    normalizeForIndexCompare
} from "../remote.js";

export const INDEX_VERSION = 4;
export const LOCK_TIMEOUT_MS = 10000;
export const LOCK_STALE_MS = 30000;
export const LOCK_RETRY_MS = 40;
export const RENAME_RETRY_COUNT = 3;
export const RENAME_RETRY_MS = 25;
export const MAX_ALIASES = 32;
export const MAX_GIT_ALIASES = 32;

let tempWriteCounter = 0;

/**
 * Returns the root data directory (defaults to ~/.ag-memory-mcp,
 * overridable via AG_MEMORY_DATA_DIR for isolated testing or custom locations).
 */
export function getDataRoot() {
    if (process.env.AG_MEMORY_DATA_DIR && process.env.AG_MEMORY_DATA_DIR.trim()) {
        return path.resolve(process.env.AG_MEMORY_DATA_DIR.trim());
    }
    return path.join(os.homedir(), ".ag-memory-mcp");
}

/**
 * Returns the stores directory path under data root, creating it if missing.
 */
export function getStoresDir() {
    const dir = path.join(getDataRoot(), "stores");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Returns the backups directory path under data root, creating it if missing.
 */
export function getBackupsDir() {
    const dir = path.join(getDataRoot(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Returns the full file path to `projects_index.json`.
 */
export function getProjectsIndexPath() {
    return path.join(getStoresDir(), "projects_index.json");
}

export function sha256Hex12(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function extractHashKeyFromStoreKey(storeKey) {
    const match = typeof storeKey === "string" ? storeKey.match(/-([0-9a-f]{12})$/i) : null;
    return match ? match[1].toLowerCase() : sha256Hex12(String(storeKey || ""));
}

export function sanitizeSlugPart(raw) {
    return String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
}

export function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            // Busy fallback if SharedArrayBuffer is unavailable
        }
    }
}

export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err && err.code === "EPERM";
    }
}

export function tryUnlink(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // Ignore cleanup races
    }
}

export function acquireIndexLock(lockPath, timeoutMs = LOCK_TIMEOUT_MS) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const fd = fs.openSync(lockPath, "wx");
            try {
                const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
                fs.writeSync(fd, payload, 0, "utf8");
            } finally {
                fs.closeSync(fd);
            }
            return () => tryUnlink(lockPath);
        } catch (err) {
            if (err.code !== "EEXIST") throw err;

            try {
                const raw = fs.readFileSync(lockPath, "utf8");
                if (!raw.trim()) {
                    const stat = fs.statSync(lockPath);
                    if (Date.now() - stat.mtimeMs < 250) {
                        sleepSync(20);
                        continue;
                    }
                    tryUnlink(lockPath);
                    continue;
                }
                const info = JSON.parse(raw);
                const age = Date.now() - (Number(info.startedAt) || 0);
                if (!isProcessAlive(info.pid) || age > LOCK_STALE_MS) {
                    tryUnlink(lockPath);
                    continue;
                }
            } catch {
                tryUnlink(lockPath);
                continue;
            }
            sleepSync(LOCK_RETRY_MS);
        }
    }

    throw new Error(`Timed out waiting for projects index lock: ${lockPath}`);
}

export function renameWithRetry(tmpPath, destPath) {
    for (let attempt = 0; attempt <= RENAME_RETRY_COUNT; attempt++) {
        try {
            fs.renameSync(tmpPath, destPath);
            return;
        } catch (err) {
            const retryable = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
            if (!retryable || attempt === RENAME_RETRY_COUNT) {
                tryUnlink(tmpPath);
                throw err;
            }
            sleepSync(RENAME_RETRY_MS * (attempt + 1));
        }
    }
}

export function buildLookupKeys(rawPath, isRemote) {
    const keys = new Set();
    if (typeof rawPath !== "string" || !rawPath.trim()) return keys;

    const addVariant = (candidate, remoteHint) => {
        if (typeof candidate !== "string" || !candidate.trim()) return;
        const norm = normalizeForIndexCompare(candidate, remoteHint);
        if (norm) keys.add(norm);
        const autoNorm = normalizeForIndexCompare(candidate);
        if (autoNorm) keys.add(autoNorm);
    };

    addVariant(rawPath, isRemote);
    for (const equiv of getWslEquivalentKeys(rawPath)) {
        keys.add(equiv);
        addVariant(equiv, isRemoteUri(equiv));
    }
    return keys;
}

export function setsIntersect(a, b) {
    for (const item of a) {
        if (b.has(item)) return true;
    }
    return false;
}

export function normalizeStoredEntry(key, rawEntry, fallbackNow) {
    const aliases = Array.isArray(rawEntry.aliases) ? rawEntry.aliases.filter((a) => typeof a === "string" && a.trim()) : [];
    const gitIdentityAliases = Array.isArray(rawEntry.gitIdentityAliases)
        ? rawEntry.gitIdentityAliases.filter((a) => typeof a === "string" && a.trim())
        : [];
    const storeKey = typeof rawEntry.storeKey === "string" && rawEntry.storeKey ? rawEntry.storeKey : key;

    return {
        ...rawEntry,
        storeKey,
        canonicalPath: rawEntry.canonicalPath || "",
        aliases,
        gitIdentity: typeof rawEntry.gitIdentity === "string" && rawEntry.gitIdentity ? rawEntry.gitIdentity : null,
        gitIdentityAliases,
        gitCommonDir: typeof rawEntry.gitCommonDir === "string" && rawEntry.gitCommonDir ? rawEntry.gitCommonDir : null,
        isolatedGitIdentity:
            typeof rawEntry.isolatedGitIdentity === "string" && rawEntry.isolatedGitIdentity
                ? rawEntry.isolatedGitIdentity
                : null,
        isRemote: Boolean(rawEntry.isRemote),
        dbFile: rawEntry.dbFile || `${storeKey}.db`,
        firstSeenAt: rawEntry.firstSeenAt || rawEntry.updatedAt || rawEntry.lastAccessedAt || fallbackNow,
        lastAccessedAt: rawEntry.lastAccessedAt || rawEntry.updatedAt || rawEntry.firstSeenAt || fallbackNow
    };
}

/**
 * Reads and normalizes `projects_index.json` (accepting v3 and v4 schemas and recovering safely on corrupt JSON).
 *
 * @returns {{ version: number, projects: Record<string, Object>, workspacePolicies: Record<string, Record<string, Object>> }}
 */
export function readProjectsIndex() {
    const indexPath = getProjectsIndexPath();
    try {
        const raw = fs.readFileSync(indexPath, "utf8");
        const parsed = JSON.parse(raw);
        if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !parsed.projects ||
            typeof parsed.projects !== "object" ||
            Array.isArray(parsed.projects)
        ) {
            return { version: INDEX_VERSION, projects: {}, workspacePolicies: {} };
        }

        const now = new Date().toISOString();
        const projects = {};
        for (const [key, entry] of Object.entries(parsed.projects)) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            projects[key] = normalizeStoredEntry(key, entry, now);
        }

        const rawPolicies =
            parsed.workspacePolicies && typeof parsed.workspacePolicies === "object" && !Array.isArray(parsed.workspacePolicies)
                ? parsed.workspacePolicies
                : {};
        const workspacePolicies = {};
        for (const [primaryKey, secondaryMap] of Object.entries(rawPolicies)) {
            if (secondaryMap && typeof secondaryMap === "object" && !Array.isArray(secondaryMap)) {
                workspacePolicies[primaryKey] = { ...secondaryMap };
            }
        }

        return {
            version: typeof parsed.version === "number" ? parsed.version : INDEX_VERSION,
            projects,
            workspacePolicies
        };
    } catch {
        return { version: INDEX_VERSION, projects: {}, workspacePolicies: {} };
    }
}

/**
 * Performs a locked, atomic read-modify-write update on `projects_index.json` (upgrading schema version to 4).
 *
 * @template T
 * @param {(index: { version: number, projects: Record<string, Object>, workspacePolicies: Record<string, Record<string, Object>> }) => T} mutatorFn
 * @returns {T}
 */
export function updateProjectsIndex(mutatorFn) {
    if (typeof mutatorFn !== "function") {
        throw new TypeError("updateProjectsIndex requires a mutator function.");
    }

    const indexPath = getProjectsIndexPath();
    const lockPath = `${indexPath}.lock`;
    const releaseLock = acquireIndexLock(lockPath, LOCK_TIMEOUT_MS);

    try {
        const current = readProjectsIndex();
        current.version = INDEX_VERSION;
        if (!current.projects || typeof current.projects !== "object") current.projects = {};
        if (!current.workspacePolicies || typeof current.workspacePolicies !== "object") current.workspacePolicies = {};

        const result = mutatorFn(current);
        current.version = INDEX_VERSION;

        tempWriteCounter = (tempWriteCounter + 1) % 1000000;
        const tmpPath = `${indexPath}.tmp.${process.pid}.${Date.now()}.${tempWriteCounter}`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), "utf8");
            renameWithRetry(tmpPath, indexPath);
        } catch (err) {
            tryUnlink(tmpPath);
            throw err;
        }

        return result;
    } finally {
        releaseLock();
    }
}
