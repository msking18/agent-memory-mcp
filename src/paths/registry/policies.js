/**
 * @file src/paths/registry/policies.js
 * @description Multi-folder workspace policies (`independent`, `linked`, `ignored`),
 * unique `@folderSlug` disambiguation, and reverse-link lookups.
 */

import path from "node:path";

import {
    isRemoteUri,
    validateOrParseProjectPath,
    normalizeForIndexCompare
} from "../remote.js";
import {
    sanitizeSlugPart,
    buildLookupKeys,
    setsIntersect,
    readProjectsIndex,
    updateProjectsIndex
} from "./storage.js";
import { getProjectStoreInfo } from "./resolution.js";
import { applyGitIdentityUpgradeToEntry } from "./registration.js";

export function getParentSlugForDisambiguation(parsed) {
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

export function resolveUniqueLinkedFolderSlug(existingPolicies, secondaryNorm, secondaryParsed, explicitSlug) {
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

export function findPolicyBucketForPrimary(workspacePolicies, primaryNormalizedKey) {
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

export function findPolicyEntryForFolder(workspacePolicies, folderNormalizedKey) {
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
