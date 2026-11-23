/**
 * @file src/paths/registry/registration.js
 * @description Level 2 project index registration, alias deduplication, caller detachment,
 * and monotonic git identity upgrades.
 */

import {
    isRemoteUri,
    normalizeForIndexCompare
} from "../remote.js";
import {
    MAX_ALIASES,
    MAX_GIT_ALIASES,
    buildLookupKeys,
    setsIntersect,
    updateProjectsIndex
} from "./storage.js";
import {
    getGitIdentityTier,
    findConflictingGitOwner,
    isEntryMissingFromDisk
} from "./resolution.js";

export function dedupeAliases(candidates, keptCanonicalPath, keptIsRemote) {
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

export function resolveCanonicalAndAliases(existing, callerParsed) {
    const aliasCandidates = existing && Array.isArray(existing.aliases) ? [...existing.aliases] : [];
    if (!existing) {
        return {
            canonicalPath: callerParsed.canonicalPath,
            isRemote: Boolean(callerParsed.isRemote),
            aliases: dedupeAliases([callerParsed.normalizedForHash], callerParsed.canonicalPath, Boolean(callerParsed.isRemote))
        };
    }

    const prevCanonical = existing.canonicalPath;
    const prevMissingLocal = isEntryMissingFromDisk(prevCanonical, existing.isRemote);

    let canonicalPath;
    let isRemote;
    if (prevMissingLocal) {
        canonicalPath = callerParsed.canonicalPath;
        isRemote = Boolean(callerParsed.isRemote);
        aliasCandidates.push(normalizeForIndexCompare(prevCanonical, false));
    } else {
        canonicalPath = prevCanonical || callerParsed.canonicalPath;
        isRemote = prevCanonical
            ? Boolean(existing.isRemote) && Boolean(callerParsed.isRemote)
            : Boolean(callerParsed.isRemote);
    }

    const keptNorm = normalizeForIndexCompare(canonicalPath, isRemote);
    const callerNorm = normalizeForIndexCompare(callerParsed.normalizedForHash, callerParsed.isRemote);
    if (callerNorm && callerNorm !== keptNorm) {
        aliasCandidates.push(callerParsed.normalizedForHash);
    }

    return {
        canonicalPath,
        isRemote,
        aliases: dedupeAliases(aliasCandidates, canonicalPath, isRemote)
    };
}

export function detachCallerFromOtherEntries(projects, selfStoreKey, callerKeys) {
    for (const [otherKey, other] of Object.entries(projects)) {
        if (!other || other.storeKey === selfStoreKey) continue;

        const filteredAliases = Array.isArray(other.aliases)
            ? other.aliases.filter((alias) => !setsIntersect(buildLookupKeys(alias, isRemoteUri(alias)), callerKeys))
            : [];
        other.aliases = filteredAliases;

        const canonicalMatchesCaller = Boolean(
            other.canonicalPath &&
            setsIntersect(buildLookupKeys(other.canonicalPath, other.isRemote), callerKeys)
        );

        if (canonicalMatchesCaller) {
            if (filteredAliases.length > 0) {
                const promoted = filteredAliases.shift();
                other.canonicalPath = promoted;
                other.isRemote = isRemoteUri(promoted);
                other.aliases = dedupeAliases(filteredAliases, promoted, other.isRemote);
            } else {
                delete projects[otherKey];
            }
        }
    }
}

export function applyGitIdentityUpgradeToEntry(entry, newGitIdentity, allProjects, selfStoreKey) {
    if (!newGitIdentity) return null;
    if (entry.isolatedGitIdentity && entry.isolatedGitIdentity === newGitIdentity) {
        return null;
    }

    const conflict = findConflictingGitOwner(allProjects, newGitIdentity, selfStoreKey);
    if (conflict) {
        return conflict;
    }

    if (entry.isolatedGitIdentity && entry.isolatedGitIdentity !== newGitIdentity) {
        entry.isolatedGitIdentity = null;
    }

    const existingId = entry.gitIdentity || null;
    const existingTier = getGitIdentityTier(existingId);
    const newTier = getGitIdentityTier(newGitIdentity);

    if (newTier > existingTier) {
        entry.gitIdentity = newGitIdentity;
    } else if (newTier === 3 && existingTier === 3 && existingId !== newGitIdentity) {
        const prevAliases = Array.isArray(entry.gitIdentityAliases) ? entry.gitIdentityAliases : [];
        const merged = [existingId, ...prevAliases].filter((val) => val && val !== newGitIdentity);
        entry.gitIdentityAliases = [...new Set(merged)].slice(0, MAX_GIT_ALIASES);
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
        const { canonicalPath, isRemote, aliases } = resolveCanonicalAndAliases(existing, storeInfo);

        const entry = {
            storeKey: storeInfo.storeKey,
            canonicalPath,
            aliases,
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
