/**
 * @file src/paths/registry/linking.js
 * @description Level 3 project identity linking, clone isolation, and non-mutating workspace inspection.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectGitIdentity } from "../git.js";
import {
    isRemoteUri,
    isWslUncPath,
    validateOrParseProjectPath,
    normalizeForIndexCompare
} from "../remote.js";
import {
    getStoresDir,
    sha256Hex12,
    buildLookupKeys,
    setsIntersect,
    readProjectsIndex,
    updateProjectsIndex
} from "./storage.js";
import {
    normalizeGitRemoteWithSubpath,
    findEntryByPathInIndex,
    isEntryMissingFromDisk,
    allocateNewGitStoreKey,
    getProjectStoreInfo
} from "./resolution.js";
import {
    dedupeAliases,
    resolveCanonicalAndAliases,
    detachCallerFromOtherEntries,
    applyGitIdentityUpgradeToEntry
} from "./registration.js";
import {
    getWorkspacePoliciesForPrimary,
    findReverseLinkedPrimary,
    findPolicyEntryForFolder
} from "./policies.js";

export function normalizeUncheckedSourcePath(rawSourcePath) {
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
        const callerKeys = buildLookupKeys(targetParsed.normalizedForHash, targetParsed.isRemote);
        for (const k of buildLookupKeys(targetParsed.canonicalPath, targetParsed.isRemote)) {
            callerKeys.add(k);
        }

        if (isolate) {
            const existingSelf = findEntryByPathInIndex(index.projects, callerKeys);
            const pathHash = sha256Hex12(targetParsed.normalizedForHash);
            const canonicalMatchesCaller = Boolean(
                existingSelf?.canonicalPath &&
                setsIntersect(buildLookupKeys(existingSelf.canonicalPath, existingSelf.isRemote), callerKeys)
            );
            const splitFromLiveExisting = Boolean(
                existingSelf &&
                !canonicalMatchesCaller &&
                existingSelf.canonicalPath &&
                !isEntryMissingFromDisk(existingSelf.canonicalPath, existingSelf.isRemote)
            );

            let storeKey;
            let reuseExisting = existingSelf;
            if (splitFromLiveExisting) {
                reuseExisting = null;
                storeKey = `${targetParsed.slug}-${pathHash}`;
                if (
                    storeKey === existingSelf.storeKey ||
                    (index.projects[storeKey] &&
                        !setsIntersect(
                            buildLookupKeys(index.projects[storeKey].canonicalPath, index.projects[storeKey].isRemote),
                            callerKeys
                        ))
                ) {
                    storeKey = `${targetParsed.slug}-${sha256Hex12(`isolated:${targetParsed.normalizedForHash}`)}`;
                }
            } else {
                storeKey = existingSelf ? existingSelf.storeKey : `${targetParsed.slug}-${pathHash}`;
            }

            const existingTargetEntry = reuseExisting || index.projects[storeKey] || null;
            const isolatedId = desiredGitIdentity || existingTargetEntry?.isolatedGitIdentity || null;

            const entry = {
                storeKey,
                canonicalPath: reuseExisting?.canonicalPath || targetParsed.canonicalPath,
                aliases: dedupeAliases(
                    [
                        ...(reuseExisting?.aliases || []),
                        targetParsed.normalizedForHash
                    ],
                    reuseExisting?.canonicalPath || targetParsed.canonicalPath,
                    reuseExisting ? Boolean(reuseExisting.isRemote) && targetParsed.isRemote : targetParsed.isRemote
                ),
                gitIdentity: null,
                gitIdentityAliases: [],
                gitCommonDir: detectedGit?.gitCommonDir
                    ? normalizeForIndexCompare(detectedGit.gitCommonDir, false)
                    : existingTargetEntry?.gitCommonDir || null,
                isolatedGitIdentity: isolatedId,
                isRemote: reuseExisting ? Boolean(reuseExisting.isRemote) && targetParsed.isRemote : targetParsed.isRemote,
                dbFile: `${storeKey}.db`,
                firstSeenAt: existingTargetEntry?.firstSeenAt || now,
                lastAccessedAt: now
            };
            index.projects[storeKey] = entry;
            detachCallerFromOtherEntries(index.projects, storeKey, callerKeys);
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
                const selfEntry = findEntryByPathInIndex(index.projects, callerKeys);
                if (selfEntry) {
                    targetEntry = selfEntry;
                    action = "bound_remote";
                } else {
                    const allocated = allocateNewGitStoreKey(
                        targetParsed.slug,
                        remoteSpec.gitIdentity,
                        targetParsed.normalizedForHash,
                        index.projects,
                        storesDir
                    );
                    const newKey = allocated.storeKey;
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

        const resolvedCanonical = resolveCanonicalAndAliases(targetEntry, targetParsed);
        targetEntry.canonicalPath = resolvedCanonical.canonicalPath;
        targetEntry.isRemote = resolvedCanonical.isRemote;
        targetEntry.aliases = resolvedCanonical.aliases;
        if (!targetEntry.gitCommonDir && detectedGit?.gitCommonDir) {
            targetEntry.gitCommonDir = normalizeForIndexCompare(detectedGit.gitCommonDir, false);
        }
        targetEntry.lastAccessedAt = now;

        // Detach/retire any other entry whose canonicalPath or aliases[] previously matched projectPath
        detachCallerFromOtherEntries(index.projects, targetEntry.storeKey, callerKeys);

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
                    isRemote: isRemoteUri(rawFolder) || isWslUncPath(rawFolder),
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
