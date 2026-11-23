/**
 * @file src/paths/registry.js
 * @description Locked `projects_index.json` v4 registry, 4-step deterministic store resolution,
 * monotonic git identity upgrade lifecycle, collision & clone disambiguation guards,
 * workspace folder policies, and project identity linking.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { detectGitIdentity, normalizeGitRemoteUrl } from "./git.js";
import {
    isRemoteUri,
    validateOrParseProjectPath,
    getWslEquivalentKeys,
    normalizeForIndexCompare
} from "./remote.js";

const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_AGE_MS = 30000;
const MAX_RENAME_RETRIES = 3;
const MAX_ALIASES = 32;
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

function sha256Hex12(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function extractHashKeyFromStoreKey(storeKey) {
    const match = typeof storeKey === "string" ? storeKey.match(/-([0-9a-f]{12})$/i) : null;
    return match ? match[1].toLowerCase() : sha256Hex12(String(storeKey || ""));
}

function sanitizeSlugPart(raw) {
    return String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            // Busy fallback if SharedArrayBuffer is unavailable
        }
    }
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err && err.code === "EPERM";
    }
}

function tryUnlink(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // Ignore cleanup races
    }
}

function acquireIndexLock(lockPath, timeoutMs = LOCK_TIMEOUT_MS) {
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
                if (!isProcessAlive(info.pid) || age > STALE_LOCK_AGE_MS) {
                    tryUnlink(lockPath);
                    continue;
                }
            } catch {
                tryUnlink(lockPath);
                continue;
            }
            sleepSync(40);
        }
    }

    throw new Error(`Timed out waiting for projects index lock: ${lockPath}`);
}

function renameWithRetry(tmpPath, destPath) {
    for (let attempt = 0; attempt <= MAX_RENAME_RETRIES; attempt++) {
        try {
            fs.renameSync(tmpPath, destPath);
            return;
        } catch (err) {
            const retryable = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
            if (!retryable || attempt === MAX_RENAME_RETRIES) {
                tryUnlink(tmpPath);
                throw err;
            }
            sleepSync(25 * (attempt + 1));
        }
    }
}

function buildLookupKeys(rawPath, isRemote) {
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

function setsIntersect(a, b) {
    for (const item of a) {
        if (b.has(item)) return true;
    }
    return false;
}

function normalizeStoredEntry(key, rawEntry, fallbackNow) {
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
            return { version: 4, projects: {}, workspacePolicies: {} };
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
            version: typeof parsed.version === "number" ? parsed.version : 4,
            projects,
            workspacePolicies
        };
    } catch {
        return { version: 4, projects: {}, workspacePolicies: {} };
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
        current.version = 4;
        if (!current.projects || typeof current.projects !== "object") current.projects = {};
        if (!current.workspacePolicies || typeof current.workspacePolicies !== "object") current.workspacePolicies = {};

        const result = mutatorFn(current);
        current.version = 4;

        tempWriteCounter = (tempWriteCounter + 1) % 1000000;
        const tmpPath = `${indexPath}.tmp.${process.pid}.${Date.now()}.${tempWriteCounter}`;
        fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), "utf8");
        renameWithRetry(tmpPath, indexPath);

        return result;
    } finally {
        releaseLock();
    }
}

function getGitIdentityTier(gitIdentity) {
    if (!gitIdentity || typeof gitIdentity !== "string") return 0;
    if (gitIdentity.startsWith("local-git:")) return 1;
    if (gitIdentity.startsWith("local-git-root:")) return 2;
    return 3;
}

function normalizeGitRemoteWithSubpath(gitRemote, fallbackSubpath = "") {
    if (typeof gitRemote !== "string" || !gitRemote.trim()) {
        return { provided: false, gitIdentity: null };
    }
    const trimmed = gitRemote.trim();
    const hashIdx = trimmed.indexOf("#");
    const rawUrl = (hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed).trim();
    const explicitSub =
        hashIdx >= 0 ? trimmed.slice(hashIdx + 1).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
    const normalizedBase = normalizeGitRemoteUrl(rawUrl);
    if (!normalizedBase) {
        return { provided: true, gitIdentity: null };
    }
    const subpath = explicitSub || fallbackSubpath || "";
    return {
        provided: true,
        gitIdentity: subpath ? `${normalizedBase}#${subpath}` : normalizedBase
    };
}

function findConflictingGitOwner(projects, gitIdentity, selfStoreKey) {
    if (!gitIdentity) return null;
    for (const entry of Object.values(projects)) {
        if (!entry || entry.storeKey === selfStoreKey) continue;
        if (entry.isolatedGitIdentity && entry.isolatedGitIdentity === gitIdentity) continue;
        const ownsDirect = entry.gitIdentity === gitIdentity;
        const ownsAlias = Array.isArray(entry.gitIdentityAliases) && entry.gitIdentityAliases.includes(gitIdentity);
        if (ownsDirect || ownsAlias) {
            return {
                gitIdentity,
                conflictingStoreKey: entry.storeKey
            };
        }
    }
    return null;
}

function buildStoreInfo({
    parsed,
    storeKey,
    hashKey,
    storesDir,
    backupsRoot,
    gitIdentity,
    gitCommonDir,
    resolvedVia,
    duplicateCloneCandidate = null,
    gitIdentityConflict = null
}) {
    return {
        canonicalPath: parsed.canonicalPath,
        normalizedForHash: parsed.normalizedForHash,
        hashKey,
        slug: parsed.slug,
        storeKey,
        dbFileName: `${storeKey}.db`,
        dbPath: path.join(storesDir, `${storeKey}.db`),
        lockPath: path.join(storesDir, `${storeKey}.migrate.lock`),
        backupDir: path.join(backupsRoot, storeKey),
        legacyJsonPath: parsed.isRemote ? null : path.join(parsed.canonicalPath, ".ag-memory.json"),
        isRemote: parsed.isRemote,
        remoteScheme: parsed.remoteScheme,
        gitIdentity: gitIdentity || null,
        gitCommonDir: gitCommonDir || null,
        resolvedVia,
        duplicateCloneCandidate,
        gitIdentityConflict
    };
}

function findEntryByPathInIndex(projects, callerKeys) {
    for (const entry of Object.values(projects)) {
        if (!entry) continue;
        const entryKeys = new Set();
        for (const k of buildLookupKeys(entry.canonicalPath, entry.isRemote)) {
            entryKeys.add(k);
        }
        if (Array.isArray(entry.aliases)) {
            for (const alias of entry.aliases) {
                for (const k of buildLookupKeys(alias, isRemoteUri(alias))) {
                    entryKeys.add(k);
                }
            }
        }
        if (setsIntersect(callerKeys, entryKeys)) {
            return entry;
        }
    }
    return null;
}

function findExistingLegacyPathDb(parsed, storesDir) {
    const candidates = [{ storeKey: `${parsed.slug}-${sha256Hex12(parsed.normalizedForHash)}` }];
    for (const equiv of getWslEquivalentKeys(parsed.normalizedForHash)) {
        const normEq = normalizeForIndexCompare(equiv, isRemoteUri(equiv));
        if (!normEq) continue;
        const key = `${parsed.slug}-${sha256Hex12(normEq)}`;
        if (!candidates.some((c) => c.storeKey === key)) {
            candidates.push({ storeKey: key });
        }
    }

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(storesDir, `${candidate.storeKey}.db`))) {
            return candidate.storeKey;
        }
    }
    return null;
}

function resolveMatchedEntryConflict(entry, storeKey, liveGitIdentity, allProjects) {
    const effectiveGitIdentity = liveGitIdentity || entry?.gitIdentity || null;
    const optedOut = Boolean(
        entry?.isolatedGitIdentity && entry.isolatedGitIdentity === effectiveGitIdentity
    );
    const gitIdentityConflict = optedOut
        ? null
        : findConflictingGitOwner(allProjects, effectiveGitIdentity, storeKey);
    return { effectiveGitIdentity, gitIdentityConflict };
}

/**
 * Resolves deterministic storage & metadata for a local workspace directory or remote workspace URI
 * using the 4-step resolution order: index alias -> legacy path DB -> git identity (with clone guard) -> new store.
 *
 * @param {string} rawPath
 * @param {{ gitRemote?: string }} [options]
 * @returns {Object} StoreInfo
 */
export function getProjectStoreInfo(rawPath, options = {}) {
    const parsed = validateOrParseProjectPath(rawPath);
    const detected = parsed.isRemote ? null : detectGitIdentity(parsed.canonicalPath);
    const explicitRemote = normalizeGitRemoteWithSubpath(options?.gitRemote, detected?.repoSubpath || "");

    const gitIdentity = explicitRemote.gitIdentity || detected?.gitIdentity || null;
    const gitCommonDir = detected?.gitCommonDir || null;
    const normGitCommonDir = gitCommonDir ? normalizeForIndexCompare(gitCommonDir, false) : null;

    const index = readProjectsIndex();
    const storesDir = getStoresDir();
    const backupsRoot = getBackupsDir();

    // Step 1: Exact canonicalPath, aliases[], or WSL-equivalent match in projects_index.json
    const callerKeys = buildLookupKeys(parsed.normalizedForHash, parsed.isRemote);
    for (const k of buildLookupKeys(parsed.canonicalPath, parsed.isRemote)) {
        callerKeys.add(k);
    }

    const indexMatch = findEntryByPathInIndex(index.projects, callerKeys);
    if (indexMatch) {
        const { effectiveGitIdentity, gitIdentityConflict } = resolveMatchedEntryConflict(
            indexMatch,
            indexMatch.storeKey,
            gitIdentity,
            index.projects
        );
        return buildStoreInfo({
            parsed,
            storeKey: indexMatch.storeKey,
            hashKey: extractHashKeyFromStoreKey(indexMatch.storeKey),
            storesDir,
            backupsRoot,
            gitIdentity: effectiveGitIdentity,
            gitCommonDir,
            resolvedVia: "index_alias",
            gitIdentityConflict
        });
    }

    // Step 2: Existing legacy v3.0-v3.2 path-hash .db on disk (plus WSL equivalents)
    const legacyStoreKey = findExistingLegacyPathDb(parsed, storesDir);
    if (legacyStoreKey) {
        const legacyEntry = index.projects[legacyStoreKey];
        const { effectiveGitIdentity, gitIdentityConflict } = resolveMatchedEntryConflict(
            legacyEntry,
            legacyStoreKey,
            gitIdentity,
            index.projects
        );
        return buildStoreInfo({
            parsed,
            storeKey: legacyStoreKey,
            hashKey: extractHashKeyFromStoreKey(legacyStoreKey),
            storesDir,
            backupsRoot,
            gitIdentity: effectiveGitIdentity,
            gitCommonDir,
            resolvedVia: "legacy_path_db",
            gitIdentityConflict
        });
    }

    // Step 3: Git identity match in projects_index.json (with starter-template clone guard)
    if (gitIdentity) {
        const gitMatches = [];
        for (const entry of Object.values(index.projects)) {
            if (!entry) continue;
            const entryNormCommon = entry.gitCommonDir ? normalizeForIndexCompare(entry.gitCommonDir, false) : null;
            const sameCommonDir = Boolean(normGitCommonDir && entryNormCommon && normGitCommonDir === entryNormCommon);

            if (entry.isolatedGitIdentity && entry.isolatedGitIdentity === gitIdentity) {
                if (sameCommonDir) {
                    gitMatches.push({ entry, sameCommonDir: true });
                }
                continue;
            }

            const directMatch = entry.gitIdentity === gitIdentity;
            const aliasMatch = Array.isArray(entry.gitIdentityAliases) && entry.gitIdentityAliases.includes(gitIdentity);
            if (directMatch || aliasMatch) {
                gitMatches.push({ entry, sameCommonDir });
            }
        }

        if (gitMatches.length > 0) {
            const autoShareMatch = gitMatches.find(({ entry, sameCommonDir }) => {
                if (parsed.isRemote || entry.isRemote) return true;
                if (sameCommonDir) return true;
                if (entry.canonicalPath && !fs.existsSync(entry.canonicalPath)) return true;
                return false;
            });

            if (autoShareMatch) {
                const matched = autoShareMatch.entry;
                return buildStoreInfo({
                    parsed,
                    storeKey: matched.storeKey,
                    hashKey: extractHashKeyFromStoreKey(matched.storeKey),
                    storesDir,
                    backupsRoot,
                    gitIdentity,
                    gitCommonDir,
                    resolvedVia: "git_identity"
                });
            }

            // Simultaneous independent local clones on disk with different gitCommonDirs
            const candidate = gitMatches[0].entry;
            const pathHash = sha256Hex12(parsed.normalizedForHash);
            const provisionalKey = `${parsed.slug}-${pathHash}`;
            return buildStoreInfo({
                parsed,
                storeKey: provisionalKey,
                hashKey: pathHash,
                storesDir,
                backupsRoot,
                gitIdentity,
                gitCommonDir,
                resolvedVia: "new_path_hash",
                duplicateCloneCandidate: {
                    existingStoreKey: candidate.storeKey,
                    existingPath: candidate.canonicalPath,
                    gitIdentity
                }
            });
        }
    }

    // Step 4: New store allocation
    if (gitIdentity) {
        const gitHash = sha256Hex12(`git:${gitIdentity}`);
        return buildStoreInfo({
            parsed,
            storeKey: `${parsed.slug}-${gitHash}`,
            hashKey: gitHash,
            storesDir,
            backupsRoot,
            gitIdentity,
            gitCommonDir,
            resolvedVia: "new_git_identity"
        });
    }

    const pathHash = sha256Hex12(parsed.normalizedForHash);
    return buildStoreInfo({
        parsed,
        storeKey: `${parsed.slug}-${pathHash}`,
        hashKey: pathHash,
        storesDir,
        backupsRoot,
        gitIdentity: null,
        gitCommonDir: null,
        resolvedVia: "new_path_hash"
    });
}

function dedupeAliases(candidates, keptCanonicalPath, keptIsRemote) {
    const keptNorm = normalizeForIndexCompare(keptCanonicalPath, keptIsRemote);
    const seen = new Set(keptNorm ? [keptNorm] : []);
    const out = [];
    for (const raw of candidates) {
        if (typeof raw !== "string" || !raw.trim()) continue;
        const norm = normalizeForIndexCompare(raw, isRemoteUri(raw));
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        out.push(raw);
        if (out.length >= MAX_ALIASES) break;
    }
    return out;
}

function applyGitIdentityUpgradeToEntry(entry, newGitIdentity, allProjects, selfStoreKey) {
    if (!newGitIdentity) return null;
    if (entry.isolatedGitIdentity && entry.isolatedGitIdentity === newGitIdentity) {
        return null;
    }

    const conflict = findConflictingGitOwner(allProjects, newGitIdentity, selfStoreKey);
    if (conflict) {
        return conflict;
    }

    const existingId = entry.gitIdentity || null;
    const existingTier = getGitIdentityTier(existingId);
    const newTier = getGitIdentityTier(newGitIdentity);

    if (newTier > existingTier) {
        entry.gitIdentity = newGitIdentity;
    } else if (newTier === 3 && existingTier === 3 && existingId !== newGitIdentity) {
        const prevAliases = Array.isArray(entry.gitIdentityAliases) ? entry.gitIdentityAliases : [];
        const merged = [existingId, ...prevAliases].filter((val) => val && val !== newGitIdentity);
        entry.gitIdentityAliases = [...new Set(merged)].slice(0, MAX_ALIASES);
        entry.gitIdentity = newGitIdentity;
    }

    return null;
}

/**
 * Atomically registers or updates a project store entry in `projects_index.json` v4,
 * preserving existing canonical paths, tracking aliases, upgrading gitIdentity monotonically,
 * and guarding against duplicate gitIdentity ownership collisions.
 *
 * @param {Object} storeInfo
 * @returns {Object} Updated index entry (plus transient `gitIdentityConflict` if applicable).
 */
export function registerProjectInIndex(storeInfo) {
    return updateProjectsIndex((index) => {
        const now = new Date().toISOString();
        const existing = index.projects[storeInfo.storeKey] || null;

        let canonicalPath;
        let isRemote;
        const aliasCandidates = existing && Array.isArray(existing.aliases) ? [...existing.aliases] : [];

        if (!existing) {
            canonicalPath = storeInfo.canonicalPath;
            isRemote = Boolean(storeInfo.isRemote);
        } else {
            const prevCanonical = existing.canonicalPath;
            const prevMissingLocal = Boolean(prevCanonical) && !existing.isRemote && !fs.existsSync(prevCanonical);

            if (prevMissingLocal) {
                canonicalPath = storeInfo.canonicalPath;
                isRemote = Boolean(storeInfo.isRemote);
                aliasCandidates.push(normalizeForIndexCompare(prevCanonical, false));
            } else {
                canonicalPath = prevCanonical || storeInfo.canonicalPath;
                isRemote = prevCanonical
                    ? Boolean(existing.isRemote) && Boolean(storeInfo.isRemote)
                    : Boolean(storeInfo.isRemote);
            }
        }

        const keptNorm = normalizeForIndexCompare(canonicalPath, isRemote);
        const callerNorm = normalizeForIndexCompare(storeInfo.normalizedForHash, storeInfo.isRemote);
        if (callerNorm && callerNorm !== keptNorm) {
            aliasCandidates.push(storeInfo.normalizedForHash);
        }

        const entry = {
            storeKey: storeInfo.storeKey,
            canonicalPath,
            aliases: dedupeAliases(aliasCandidates, canonicalPath, isRemote),
            gitIdentity: existing ? existing.gitIdentity : null,
            gitIdentityAliases: existing && Array.isArray(existing.gitIdentityAliases) ? [...existing.gitIdentityAliases] : [],
            gitCommonDir: existing?.gitCommonDir || null,
            isolatedGitIdentity: existing?.isolatedGitIdentity ?? storeInfo.isolatedGitIdentity ?? null,
            isRemote,
            dbFile: storeInfo.dbFileName,
            firstSeenAt: existing?.firstSeenAt || now,
            lastAccessedAt: now
        };

        const conflict = applyGitIdentityUpgradeToEntry(
            entry,
            storeInfo.gitIdentity,
            index.projects,
            storeInfo.storeKey
        );

        if (!conflict && storeInfo.gitCommonDir && !(entry.isolatedGitIdentity && entry.isolatedGitIdentity === storeInfo.gitIdentity)) {
            entry.gitCommonDir = normalizeForIndexCompare(storeInfo.gitCommonDir, false);
        }

        index.projects[storeInfo.storeKey] = entry;
        return conflict ? { ...entry, gitIdentityConflict: conflict } : entry;
    });
}

function getParentSlugForDisambiguation(parsed) {
    const forward = parsed.normalizedForHash.replace(/\\/g, "/");
    let dirPart = path.posix.dirname(forward);
    if (parsed.isRemote) {
        const match = forward.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+(.*)$/);
        if (match) {
            dirPart = path.posix.dirname(match[1] || "/");
        }
    }
    const parentBase = path.posix.basename(dirPart);
    if (!parentBase || parentBase === "/" || parentBase === "." || /^[a-zA-Z]:$/.test(parentBase)) {
        return "";
    }
    return sanitizeSlugPart(parentBase);
}

function resolveUniqueLinkedFolderSlug(existingPolicies, secondaryNorm, secondaryParsed, explicitSlug) {
    const usedSlugs = new Set();
    for (const [otherKey, policy] of Object.entries(existingPolicies)) {
        if (otherKey === secondaryNorm || !policy || policy.mode !== "linked" || !policy.folderSlug) continue;
        usedSlugs.add(policy.folderSlug.toLowerCase());
    }

    if (typeof explicitSlug === "string" && explicitSlug.trim()) {
        const cleaned = sanitizeSlugPart(explicitSlug) || "folder";
        if (usedSlugs.has(cleaned)) {
            throw new Error(
                `Duplicate folder_slug "${cleaned}": another linked folder under this primary workspace already uses "@${cleaned}/".`
            );
        }
        return cleaned;
    }

    const baseSlug = secondaryParsed.slug || "folder";
    if (!usedSlugs.has(baseSlug)) {
        return baseSlug;
    }

    const parentSlug = getParentSlugForDisambiguation(secondaryParsed);
    const parentJoined = parentSlug
        ? `${parentSlug}-${baseSlug}`.slice(0, 40).replace(/-+$/, "")
        : baseSlug;

    if (parentSlug && !usedSlugs.has(parentJoined)) {
        return parentJoined;
    }

    for (let suffix = 2; suffix < 1000; suffix++) {
        const suffixStr = `-${suffix}`;
        const candidate = `${parentJoined.slice(0, 40 - suffixStr.length).replace(/-+$/, "")}${suffixStr}`;
        if (!usedSlugs.has(candidate)) {
            return candidate;
        }
    }

    throw new Error(`Unable to allocate unique folder_slug for "${secondaryParsed.canonicalPath}".`);
}

/**
 * Sets a workspace folder policy (`independent`, `linked`, or `ignored`) for a secondary folder
 * under a primary workspace, enforcing unique `@folderSlug` prefixes for `linked` folders.
 *
 * @param {{ primaryPath: string, folderPath: string, mode: "independent" | "linked" | "ignored", folderSlug?: string }} params
 * @returns {Object}
 */
export function setWorkspaceFolderPolicy({ primaryPath, folderPath, mode, folderSlug }) {
    if (!["independent", "linked", "ignored"].includes(mode)) {
        throw new Error(`Invalid workspace folder policy mode "${mode}": expected "independent", "linked", or "ignored".`);
    }

    const primaryInfo = getProjectStoreInfo(primaryPath);
    const secondaryParsed = validateOrParseProjectPath(folderPath);
    const primaryNorm = primaryInfo.normalizedForHash;
    const secondaryNorm = secondaryParsed.normalizedForHash;

    if (primaryNorm === secondaryNorm) {
        throw new Error(`Invalid folder policy: folder_path "${secondaryParsed.canonicalPath}" cannot equal primary_path.`);
    }

    return updateProjectsIndex((index) => {
        const now = new Date().toISOString();

        // Ensure primary store has an index entry (without creating an empty .db file on disk)
        if (!index.projects[primaryInfo.storeKey]) {
            index.projects[primaryInfo.storeKey] = {
                storeKey: primaryInfo.storeKey,
                canonicalPath: primaryInfo.canonicalPath,
                aliases: primaryInfo.normalizedForHash !== primaryInfo.canonicalPath ? [primaryInfo.normalizedForHash] : [],
                gitIdentity: null,
                gitIdentityAliases: [],
                gitCommonDir: primaryInfo.gitCommonDir ? normalizeForIndexCompare(primaryInfo.gitCommonDir, false) : null,
                isolatedGitIdentity: null,
                isRemote: primaryInfo.isRemote,
                dbFile: primaryInfo.dbFileName,
                firstSeenAt: now,
                lastAccessedAt: now
            };
            applyGitIdentityUpgradeToEntry(
                index.projects[primaryInfo.storeKey],
                primaryInfo.gitIdentity,
                index.projects,
                primaryInfo.storeKey
            );
        }

        if (!index.workspacePolicies[primaryNorm] || typeof index.workspacePolicies[primaryNorm] !== "object") {
            index.workspacePolicies[primaryNorm] = {};
        }

        const primaryPolicies = index.workspacePolicies[primaryNorm];
        const resolvedSlug =
            mode === "linked"
                ? resolveUniqueLinkedFolderSlug(primaryPolicies, secondaryNorm, secondaryParsed, folderSlug)
                : null;
        const targetStoreKey = mode === "linked" ? primaryInfo.storeKey : null;

        const policyRecord = {
            mode,
            targetStoreKey,
            folderSlug: resolvedSlug,
            updatedAt: now
        };
        primaryPolicies[secondaryNorm] = policyRecord;

        return {
            primaryKey: primaryNorm,
            folderKey: secondaryNorm,
            primaryPath: primaryInfo.canonicalPath,
            folderPath: secondaryParsed.canonicalPath,
            primaryStoreKey: primaryInfo.storeKey,
            mode,
            folderSlug: resolvedSlug,
            targetStoreKey,
            policy: policyRecord
        };
    });
}

function findPolicyBucketForPrimary(workspacePolicies, primaryNormalizedKey) {
    if (!primaryNormalizedKey || !workspacePolicies || typeof workspacePolicies !== "object") {
        return null;
    }
    if (workspacePolicies[primaryNormalizedKey]) {
        return { key: primaryNormalizedKey, bucket: workspacePolicies[primaryNormalizedKey] };
    }
    const lookupKeys = buildLookupKeys(primaryNormalizedKey, isRemoteUri(primaryNormalizedKey));
    for (const [candidateKey, bucket] of Object.entries(workspacePolicies)) {
        const candidateSet = buildLookupKeys(candidateKey, isRemoteUri(candidateKey));
        if (setsIntersect(lookupKeys, candidateSet)) {
            return { key: candidateKey, bucket };
        }
    }
    return null;
}

/**
 * Returns the configured secondary folder policy map for a primary workspace key.
 *
 * @param {string} primaryNormalizedKey
 * @returns {Record<string, Object>}
 */
export function getWorkspacePoliciesForPrimary(primaryNormalizedKey) {
    const index = readProjectsIndex();
    const matched = findPolicyBucketForPrimary(index.workspacePolicies, primaryNormalizedKey);
    return matched && matched.bucket ? { ...matched.bucket } : {};
}

/**
 * Checks whether `targetNormalizedKey` is configured as `linked` under any other currently open workspace root.
 *
 * @param {string} targetNormalizedKey
 * @param {string[]} openNormalizedKeys
 * @returns {{ primaryKey: string, folderSlug: string, targetStoreKey: string } | null}
 */
export function findReverseLinkedPrimary(targetNormalizedKey, openNormalizedKeys = []) {
    if (typeof targetNormalizedKey !== "string" || !targetNormalizedKey.trim() || !Array.isArray(openNormalizedKeys)) {
        return null;
    }

    const index = readProjectsIndex();
    const targetKeys = buildLookupKeys(targetNormalizedKey, isRemoteUri(targetNormalizedKey));

    for (const openKey of openNormalizedKeys) {
        if (typeof openKey !== "string" || !openKey.trim()) continue;
        const openKeys = buildLookupKeys(openKey, isRemoteUri(openKey));
        if (setsIntersect(targetKeys, openKeys)) continue;

        const matchedPrimary = findPolicyBucketForPrimary(index.workspacePolicies, openKey);
        if (!matchedPrimary || !matchedPrimary.bucket) continue;

        for (const [secKey, policy] of Object.entries(matchedPrimary.bucket)) {
            if (!policy || policy.mode !== "linked") continue;
            const secKeys = buildLookupKeys(secKey, isRemoteUri(secKey));
            if (setsIntersect(targetKeys, secKeys)) {
                return {
                    primaryKey: matchedPrimary.key,
                    folderSlug: policy.folderSlug,
                    targetStoreKey: policy.targetStoreKey
                };
            }
        }
    }

    return null;
}

function normalizeUncheckedSourcePath(rawSourcePath) {
    if (typeof rawSourcePath !== "string" || !rawSourcePath.trim()) {
        throw new Error("Invalid source_project_path: must be a non-empty path or remote URI.");
    }
    let cleaned = rawSourcePath.trim();
    if (/^file:\/\//i.test(cleaned)) {
        try {
            cleaned = fileURLToPath(cleaned);
            if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(cleaned)) {
                cleaned = cleaned.slice(1);
            }
        } catch {
            throw new Error(`Invalid file URI for source_project_path: ${rawSourcePath}`);
        }
    } else if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(cleaned)) {
        cleaned = cleaned.slice(1);
    }
    return cleaned;
}

/**
 * Links a workspace to an existing project store (`sourceProjectPath`, `targetStoreKey`, `gitRemote`),
 * pre-registers a brand-new remote git repository without creating an empty `.db`,
 * or marks a simultaneous clone as isolated (`isolate: true`).
 *
 * @param {{ projectPath: string, sourceProjectPath?: string, targetStoreKey?: string, gitRemote?: string, isolate?: boolean }} params
 * @returns {Object}
 */
export function linkProjectIdentity({ projectPath, sourceProjectPath, targetStoreKey, gitRemote, isolate = false }) {
    const targetParsed = validateOrParseProjectPath(projectPath);
    const detectedGit = targetParsed.isRemote ? null : detectGitIdentity(targetParsed.canonicalPath);
    const remoteSpec = normalizeGitRemoteWithSubpath(gitRemote, detectedGit?.repoSubpath || "");

    if (remoteSpec.provided && !remoteSpec.gitIdentity) {
        throw new Error(`Invalid git_remote "${gitRemote}": unable to parse git remote URL.`);
    }

    if (!isolate && !sourceProjectPath && !targetStoreKey && !remoteSpec.gitIdentity) {
        throw new Error("linkProjectIdentity requires isolate: true or one of sourceProjectPath, targetStoreKey, or gitRemote.");
    }

    const storesDir = getStoresDir();
    const desiredGitIdentity = remoteSpec.gitIdentity || detectedGit?.gitIdentity || null;

    const mutationResult = updateProjectsIndex((index) => {
        const now = new Date().toISOString();

        if (isolate) {
            const callerKeys = buildLookupKeys(targetParsed.normalizedForHash, targetParsed.isRemote);
            const existingSelf = findEntryByPathInIndex(index.projects, callerKeys);
            const pathHash = sha256Hex12(targetParsed.normalizedForHash);
            const storeKey = existingSelf ? existingSelf.storeKey : `${targetParsed.slug}-${pathHash}`;
            const isolatedId = desiredGitIdentity || existingSelf?.isolatedGitIdentity || null;

            const entry = {
                storeKey,
                canonicalPath: existingSelf?.canonicalPath || targetParsed.canonicalPath,
                aliases: dedupeAliases(
                    [
                        ...(existingSelf?.aliases || []),
                        targetParsed.normalizedForHash
                    ],
                    existingSelf?.canonicalPath || targetParsed.canonicalPath,
                    existingSelf ? Boolean(existingSelf.isRemote) && targetParsed.isRemote : targetParsed.isRemote
                ),
                gitIdentity: null,
                gitIdentityAliases: existingSelf?.gitIdentityAliases || [],
                gitCommonDir: detectedGit?.gitCommonDir
                    ? normalizeForIndexCompare(detectedGit.gitCommonDir, false)
                    : existingSelf?.gitCommonDir || null,
                isolatedGitIdentity: isolatedId,
                isRemote: existingSelf ? Boolean(existingSelf.isRemote) && targetParsed.isRemote : targetParsed.isRemote,
                dbFile: `${storeKey}.db`,
                firstSeenAt: existingSelf?.firstSeenAt || now,
                lastAccessedAt: now
            };
            index.projects[storeKey] = entry;
            return { action: "isolated", storeKey, conflict: null };
        }

        let targetEntry = null;
        let action = "linked_existing";

        if (sourceProjectPath) {
            const sourceUnchecked = normalizeUncheckedSourcePath(sourceProjectPath);
            const sourceKeys = buildLookupKeys(sourceUnchecked, isRemoteUri(sourceUnchecked));
            targetEntry = findEntryByPathInIndex(index.projects, sourceKeys);
            if (!targetEntry) {
                throw new Error(`No tracked project store found in projects_index.json for source_project_path "${sourceProjectPath}".`);
            }
        } else if (targetStoreKey) {
            targetEntry = index.projects[targetStoreKey] || null;
            if (!targetEntry) {
                throw new Error(`Target store "${targetStoreKey}" was not found in projects_index.json.`);
            }
        } else if (remoteSpec.gitIdentity) {
            for (const entry of Object.values(index.projects)) {
                if (!entry) continue;
                if (entry.isolatedGitIdentity && entry.isolatedGitIdentity === remoteSpec.gitIdentity) continue;
                if (
                    entry.gitIdentity === remoteSpec.gitIdentity ||
                    (Array.isArray(entry.gitIdentityAliases) && entry.gitIdentityAliases.includes(remoteSpec.gitIdentity))
                ) {
                    targetEntry = entry;
                    break;
                }
            }

            if (!targetEntry) {
                // Check if projectPath itself already had a registered entry we should upgrade
                const callerKeys = buildLookupKeys(targetParsed.normalizedForHash, targetParsed.isRemote);
                const selfEntry = findEntryByPathInIndex(index.projects, callerKeys);
                if (selfEntry) {
                    targetEntry = selfEntry;
                    action = "bound_remote";
                } else {
                    const gitHash = sha256Hex12(`git:${remoteSpec.gitIdentity}`);
                    const newKey = `${targetParsed.slug}-${gitHash}`;
                    index.projects[newKey] = {
                        storeKey: newKey,
                        canonicalPath: targetParsed.canonicalPath,
                        aliases: dedupeAliases([targetParsed.normalizedForHash], targetParsed.canonicalPath, targetParsed.isRemote),
                        gitIdentity: remoteSpec.gitIdentity,
                        gitIdentityAliases: [],
                        gitCommonDir: detectedGit?.gitCommonDir ? normalizeForIndexCompare(detectedGit.gitCommonDir, false) : null,
                        isolatedGitIdentity: null,
                        isRemote: targetParsed.isRemote,
                        dbFile: `${newKey}.db`,
                        firstSeenAt: now,
                        lastAccessedAt: now
                    };
                    return { action: "registered_remote", storeKey: newKey, conflict: null };
                }
            }
        }

        const keptCanonical = targetEntry.canonicalPath || targetParsed.canonicalPath;
        const keptRemote = targetEntry.canonicalPath
            ? Boolean(targetEntry.isRemote) && targetParsed.isRemote
            : targetParsed.isRemote;

        targetEntry.isRemote = keptRemote;
        targetEntry.aliases = dedupeAliases(
            [...(targetEntry.aliases || []), targetParsed.normalizedForHash],
            keptCanonical,
            keptRemote
        );
        if (!targetEntry.gitCommonDir && detectedGit?.gitCommonDir) {
            targetEntry.gitCommonDir = normalizeForIndexCompare(detectedGit.gitCommonDir, false);
        }
        targetEntry.lastAccessedAt = now;

        // If projectPath previously appeared as an alias on a different entry, clean it up so Step 1 is unambiguous
        const callerNorm = normalizeForIndexCompare(targetParsed.normalizedForHash, targetParsed.isRemote);
        for (const other of Object.values(index.projects)) {
            if (!other || other.storeKey === targetEntry.storeKey || !Array.isArray(other.aliases)) continue;
            other.aliases = other.aliases.filter(
                (a) => normalizeForIndexCompare(a, isRemoteUri(a)) !== callerNorm
            );
        }

        const conflict = applyGitIdentityUpgradeToEntry(
            targetEntry,
            desiredGitIdentity,
            index.projects,
            targetEntry.storeKey
        );

        return { action, storeKey: targetEntry.storeKey, conflict };
    });

    const storeInfo = getProjectStoreInfo(projectPath, remoteSpec.gitIdentity ? { gitRemote } : undefined);
    const dbPath = path.join(storesDir, `${mutationResult.storeKey}.db`);

    return {
        action: mutationResult.action,
        storeKey: mutationResult.storeKey,
        gitIdentity: storeInfo.gitIdentity,
        isolatedGitIdentity: readProjectsIndex().projects[mutationResult.storeKey]?.isolatedGitIdentity || null,
        initialized: fs.existsSync(dbPath),
        dbPath,
        gitIdentityConflict: mutationResult.conflict || storeInfo.gitIdentityConflict,
        duplicateCloneCandidate: storeInfo.duplicateCloneCandidate,
        storeInfo
    };
}

function findPolicyEntryForFolder(workspacePolicies, folderNormalizedKey) {
    if (!workspacePolicies || !folderNormalizedKey) return null;
    if (workspacePolicies[folderNormalizedKey]) return workspacePolicies[folderNormalizedKey];
    const targetKeys = buildLookupKeys(folderNormalizedKey, isRemoteUri(folderNormalizedKey));
    for (const [candidateKey, policy] of Object.entries(workspacePolicies)) {
        const candidateKeys = buildLookupKeys(candidateKey, isRemoteUri(candidateKey));
        if (setsIntersect(targetKeys, candidateKeys)) {
            return policy;
        }
    }
    return null;
}

/**
 * Performs a non-mutating inspection of a workspace's resolved store, git conflicts,
 * clone disambiguation status, and configured workspace folder policies.
 *
 * @param {{ projectPath: string, workspacePaths?: string[] }} params
 * @returns {Object}
 */
export function inspectWorkspace({ projectPath, workspacePaths = [] }) {
    const storeInfo = getProjectStoreInfo(projectPath);
    const index = readProjectsIndex();
    const indexEntry = index.projects[storeInfo.storeKey] || null;
    const initialized = fs.existsSync(storeInfo.dbPath);
    const workspacePolicies = getWorkspacePoliciesForPrimary(storeInfo.normalizedForHash);

    const openNormalizedKeys = [];
    const workspaceFolders = [];

    if (Array.isArray(workspacePaths)) {
        for (const rawFolder of workspacePaths) {
            if (typeof rawFolder !== "string" || !rawFolder.trim()) continue;
            try {
                const folderInfo = getProjectStoreInfo(rawFolder);
                openNormalizedKeys.push(folderInfo.normalizedForHash);
                workspaceFolders.push({
                    input: rawFolder,
                    canonicalPath: folderInfo.canonicalPath,
                    normalizedForHash: folderInfo.normalizedForHash,
                    storeKey: folderInfo.storeKey,
                    isRemote: folderInfo.isRemote,
                    gitIdentity: folderInfo.gitIdentity,
                    resolvedVia: folderInfo.resolvedVia,
                    initialized: fs.existsSync(folderInfo.dbPath),
                    policy: findPolicyEntryForFolder(workspacePolicies, folderInfo.normalizedForHash),
                    error: null
                });
            } catch (err) {
                workspaceFolders.push({
                    input: rawFolder,
                    canonicalPath: null,
                    normalizedForHash: null,
                    storeKey: null,
                    isRemote: isRemoteUri(rawFolder),
                    gitIdentity: null,
                    resolvedVia: null,
                    initialized: false,
                    policy: null,
                    error: err.message
                });
            }
        }
    }

    const reverseLinkedPrimary = findReverseLinkedPrimary(storeInfo.normalizedForHash, openNormalizedKeys);

    return {
        storeInfo,
        initialized,
        indexEntry,
        gitIdentityConflict: storeInfo.gitIdentityConflict,
        duplicateCloneCandidate: storeInfo.duplicateCloneCandidate,
        workspacePolicies,
        reverseLinkedPrimary,
        workspaceFolders
    };
}
