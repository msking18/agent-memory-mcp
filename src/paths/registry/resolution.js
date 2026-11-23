/**
 * @file src/paths/registry/resolution.js
 * @description Level 1 deterministic 4-step project store resolution, git identity tiers,
 * conflict & clone disambiguation detection.
 */

import fs from "node:fs";
import path from "node:path";

import { detectGitIdentity, normalizeGitRemoteUrl } from "../git.js";
import {
    isRemoteUri,
    isWslUncPath,
    validateOrParseProjectPath,
    getWslEquivalentKeys,
    normalizeForIndexCompare
} from "../remote.js";
import {
    getStoresDir,
    getBackupsDir,
    sha256Hex12,
    extractHashKeyFromStoreKey,
    buildLookupKeys,
    setsIntersect,
    readProjectsIndex
} from "./storage.js";

export function getGitIdentityTier(gitIdentity) {
    if (!gitIdentity || typeof gitIdentity !== "string") return 0;
    if (gitIdentity.startsWith("local-git:")) return 1;
    if (gitIdentity.startsWith("local-git-root:")) return 2;
    return 3;
}

export function normalizeGitRemoteWithSubpath(gitRemote, fallbackSubpath = "") {
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

export function findConflictingGitOwner(projects, gitIdentity, selfStoreKey) {
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

export function buildStoreInfo({
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

export function findEntryByPathInIndex(projects, callerKeys) {
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

export function findExistingLegacyPathDb(parsed, storesDir) {
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

export function isEntryMissingFromDisk(canonicalPath, isRemoteFlag = false) {
    if (!canonicalPath || isRemoteFlag || isRemoteUri(canonicalPath) || isWslUncPath(canonicalPath)) {
        return false;
    }
    return !fs.existsSync(canonicalPath);
}

export function resolveMatchedEntryConflict(entry, storeKey, liveGitIdentity, allProjects) {
    const effectiveGitIdentity = liveGitIdentity || entry?.gitIdentity || null;
    const optedOut = Boolean(
        entry?.isolatedGitIdentity && entry.isolatedGitIdentity === effectiveGitIdentity
    );
    const gitIdentityConflict = optedOut
        ? null
        : findConflictingGitOwner(allProjects, effectiveGitIdentity, storeKey);
    return { effectiveGitIdentity, gitIdentityConflict };
}

export function allocateNewGitStoreKey(slug, gitIdentity, normalizedForHash, projects, storesDir) {
    const gitHash = sha256Hex12(`git:${gitIdentity}`);
    const gitStoreKey = `${slug}-${gitHash}`;
    const occupied =
        Boolean(projects[gitStoreKey]) ||
        fs.existsSync(path.join(storesDir, `${gitStoreKey}.db`));
    if (!occupied) {
        return { storeKey: gitStoreKey, hashKey: gitHash, resolvedVia: "new_git_identity" };
    }
    const pathHash = sha256Hex12(normalizedForHash);
    return { storeKey: `${slug}-${pathHash}`, hashKey: pathHash, resolvedVia: "new_path_hash" };
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
            const autoShareMatch =
                gitMatches.find(({ sameCommonDir }) => sameCommonDir) ||
                gitMatches.find(
                    ({ entry }) =>
                        parsed.isRemote ||
                        entry.isRemote ||
                        isRemoteUri(entry.canonicalPath) ||
                        isWslUncPath(entry.canonicalPath) ||
                        isEntryMissingFromDisk(entry.canonicalPath, entry.isRemote)
                );

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
        const allocated = allocateNewGitStoreKey(
            parsed.slug,
            gitIdentity,
            parsed.normalizedForHash,
            index.projects,
            storesDir
        );
        return buildStoreInfo({
            parsed,
            storeKey: allocated.storeKey,
            hashKey: allocated.hashKey,
            storesDir,
            backupsRoot,
            gitIdentity,
            gitCommonDir,
            resolvedVia: allocated.resolvedVia
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
