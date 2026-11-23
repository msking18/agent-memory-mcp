/**
 * @file src/paths/classifier.js
 * @description Multi-folder workspace file classification, `@<folderSlug>/` linked-folder
 * mapping, and external file owner detection against `projects_index.json`.
 */

import path from "node:path";

import {
    isRemoteUri,
    isWslUncPath,
    getWslEquivalentKeys,
    normalizeForIndexCompare
} from "./remote.js";
import {
    readProjectsIndex,
    getWorkspacePoliciesForPrimary
} from "./registry/index.js";
import {
    unwrapFileUri,
    wslUncToUri,
    parseRemoteParts,
    resolveRemoteCandidate,
    isOutsideRelative,
    realpathSyncSafe
} from "./files.js";

export function buildLinkedFoldersList(storeInfo, explicitLinkedFolders) {
    let rawList = explicitLinkedFolders;
    if (!Array.isArray(rawList)) {
        rawList = [];
        if (storeInfo?.normalizedForHash) {
            const policies = getWorkspacePoliciesForPrimary(storeInfo.normalizedForHash);
            for (const [secKey, policy] of Object.entries(policies)) {
                if (!policy || policy.mode !== "linked" || !policy.folderSlug) continue;
                const remote = isRemoteUri(secKey) || isWslUncPath(secKey);
                rawList.push({
                    folderSlug: policy.folderSlug,
                    canonicalPath: secKey,
                    normalizedKey: normalizeForIndexCompare(secKey, remote),
                    isRemote: remote
                });
            }
        }
    }

    return rawList
        .filter((item) => item && typeof item.folderSlug === "string" && item.folderSlug.trim())
        .map((item) => {
            const rawRoot = item.canonicalPath || item.normalizedKey || "";
            const isWsl = isWslUncPath(rawRoot);
            const canonical = isWsl ? wslUncToUri(rawRoot) : rawRoot;
            const isRemote = Boolean(item.isRemote) || isRemoteUri(canonical);
            const remoteParts = isRemote ? parseRemoteParts(canonical) : null;
            const isWinDrive = !isRemote && process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(canonical);
            const localReal = !isRemote && canonical
                ? (isWinDrive ? path.win32.resolve(canonical).replace(/\\/g, "/") : realpathSyncSafe(path.resolve(canonical)))
                : null;
            return {
                folderSlug: item.folderSlug.trim(),
                canonicalPath: canonical,
                normalizedKey: item.normalizedKey || normalizeForIndexCompare(canonical, isRemote),
                isRemote,
                isWinDrive,
                remoteParts,
                localReal
            };
        });
}

export function findDeepestLinkedMatch(resolvedTarget, targetIsRemote, linkedEntries) {
    let best = null;
    let bestDepth = -1;

    const targetParts = targetIsRemote ? parseRemoteParts(resolvedTarget) : null;
    const targetIsWinDrive = !targetIsRemote && process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(resolvedTarget);

    for (const folder of linkedEntries) {
        if (folder.isRemote !== targetIsRemote) continue;

        if (targetIsRemote) {
            if (!folder.remoteParts || !targetParts) continue;
            if (folder.remoteParts.prefix !== targetParts.prefix) continue;
            const rel = path.posix.relative(folder.remoteParts.posixPath, targetParts.posixPath);
            if (!rel || rel === "." || isOutsideRelative(rel, true)) continue;
            const depth = folder.remoteParts.posixPath.length;
            if (depth > bestDepth) {
                bestDepth = depth;
                best = { folderSlug: folder.folderSlug, relPath: rel };
            }
        } else {
            if (!folder.localReal) continue;
            if (process.platform !== "win32" && Boolean(folder.isWinDrive) !== targetIsWinDrive) continue;
            const rel = targetIsWinDrive
                ? path.win32.relative(folder.localReal, resolvedTarget).replace(/\\/g, "/")
                : path.relative(folder.localReal, resolvedTarget).replace(/\\/g, "/");
            if (!rel || rel === "." || isOutsideRelative(rel, false)) continue;
            const depth = folder.localReal.length;
            if (depth > bestDepth) {
                bestDepth = depth;
                best = { folderSlug: folder.folderSlug, relPath: rel };
            }
        }
    }

    return best ? `@${best.folderSlug}/${best.relPath}` : null;
}

export function findDeepestOwnerCandidate(resolvedTarget, targetIsRemote, indexProjects, selfStoreKey) {
    const targetNorms = new Set();
    const mainNorm = normalizeForIndexCompare(resolvedTarget, targetIsRemote);
    if (mainNorm) targetNorms.add(mainNorm);
    for (const eq of getWslEquivalentKeys(resolvedTarget)) {
        const eqNorm = normalizeForIndexCompare(eq, isRemoteUri(eq));
        if (eqNorm) targetNorms.add(eqNorm);
    }

    let bestCandidate = null;
    let bestLength = -1;

    for (const entry of Object.values(indexProjects || {})) {
        if (!entry || !entry.storeKey || entry.storeKey === selfStoreKey) continue;
        const rootCandidates = [entry.canonicalPath, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];

        for (const rawRoot of rootCandidates) {
            if (typeof rawRoot !== "string" || !rawRoot.trim()) continue;
            const candidateVariants = new Set([rawRoot, ...getWslEquivalentKeys(rawRoot)]);

            for (const variant of candidateVariants) {
                const variantRemote = isRemoteUri(variant);
                const normRoot = normalizeForIndexCompare(variant, variantRemote);
                if (!normRoot) continue;
                const prefixBoundary = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;

                for (const normTarget of targetNorms) {
                    if (normTarget === normRoot || normTarget.startsWith(prefixBoundary)) {
                        if (normRoot.length > bestLength) {
                            bestLength = normRoot.length;
                            bestCandidate = {
                                storeKey: entry.storeKey,
                                canonicalPath: entry.canonicalPath
                            };
                        }
                    }
                }
            }
        }
    }

    return bestCandidate;
}

export function pushUnique(arr, seenSet, value) {
    const dedupeKey = process.platform === "win32" ? value.toLowerCase() : value;
    if (!seenSet.has(dedupeKey)) {
        seenSet.add(dedupeKey);
        arr.push(value);
    }
}

/**
 * Classifies workspace files into:
 * - `inWorkspace`: normalized paths inside `storeInfo.canonicalPath`
 * - `linkedNormalized`: `@<folderSlug>/<relPath>` anchors for configured `linked` folders
 * - `externalFiles`: files outside the workspace and not in any linked folder, with deepest `ownerCandidate`
 * - `allNormalized`: deduplicated union of `inWorkspace` and `linkedNormalized`
 *
 * @param {Object} storeInfo
 * @param {string[]} files
 * @param {{ linkedFolders?: Array<{ folderSlug: string, canonicalPath: string, normalizedKey: string, isRemote?: boolean }> }} [options]
 * @returns {{
 *   inWorkspace: string[],
 *   linkedNormalized: string[],
 *   externalFiles: Array<{ input: string, resolvedPath: string, ownerCandidate: { storeKey: string, canonicalPath: string } | null }>,
 *   allNormalized: string[]
 * }}
 */
export function classifyWorkspaceFiles(storeInfo, files, options = {}) {
    const inWorkspace = [];
    const linkedNormalized = [];
    const externalFiles = [];
    const allNormalized = [];

    if (!Array.isArray(files) || files.length === 0) {
        return { inWorkspace, linkedNormalized, externalFiles, allNormalized };
    }

    const seenIn = new Set();
    const seenLinked = new Set();
    const seenAll = new Set();

    const linkedEntries = buildLinkedFoldersList(storeInfo, options?.linkedFolders);
    const linkedBySlug = new Map();
    for (const entry of linkedEntries) {
        linkedBySlug.set(entry.folderSlug.toLowerCase(), entry);
    }

    const rawCanonical = storeInfo?.canonicalPath || "";
    const rootIsWsl = isWslUncPath(rawCanonical);
    const rootCanonical = rootIsWsl ? wslUncToUri(rawCanonical) : rawCanonical;
    const isRemoteRoot = Boolean(storeInfo?.isRemote) || isRemoteUri(rootCanonical);
    const rootRemoteParts = isRemoteRoot ? parseRemoteParts(rootCanonical) : null;
    const rootLocalReal = !isRemoteRoot && rootCanonical ? realpathSyncSafe(path.resolve(rootCanonical)) : "";

    let cachedIndex = null;
    const getIndex = () => {
        if (!cachedIndex) {
            cachedIndex = readProjectsIndex();
        }
        return cachedIndex;
    };

    for (const rawInput of files) {
        if (typeof rawInput !== "string" || !rawInput.trim()) continue;
        const trimmed = rawInput.trim();
        const slashNorm = trimmed.replace(/\\/g, "/");

        // 1. Explicit @<slug>/<rest> anchor matching an active linked folder
        let explicitHandled = false;
        const anchorMatch = slashNorm.match(/^@([^/]+)\/(.+)$/);
        if (anchorMatch) {
            const matchedFolder = linkedBySlug.get(anchorMatch[1].toLowerCase());
            if (matchedFolder) {
                const normRest = path.posix.normalize(anchorMatch[2]).replace(/^\/+/, "");
                if (normRest && normRest !== "." && !isOutsideRelative(normRest, true)) {
                    const anchor = `@${matchedFolder.folderSlug}/${normRest}`;
                    pushUnique(linkedNormalized, seenLinked, anchor);
                    pushUnique(allNormalized, seenAll, anchor);
                    explicitHandled = true;
                }
            }
        }
        if (explicitHandled) continue;

        // 2. Unwrap file:// URI and canonicalize WSL UNC without touching fs
        let unwrapped = unwrapFileUri(trimmed);
        if (isWslUncPath(unwrapped)) {
            unwrapped = wslUncToUri(unwrapped);
        }
        const targetIsRemote = isRemoteUri(unwrapped);

        let resolvedTarget = null;
        let resolvedTargetIsRemote = targetIsRemote;

        // 3. Check if inside primary workspace
        if (isRemoteRoot) {
            const remoteRes = resolveRemoteCandidate(rootCanonical, rootRemoteParts, unwrapped);
            if (remoteRes.isRootSelf) continue;
            if (remoteRes.inWorkspaceRel) {
                pushUnique(inWorkspace, seenIn, remoteRes.inWorkspaceRel);
                pushUnique(allNormalized, seenAll, remoteRes.inWorkspaceRel);
                continue;
            }
            resolvedTarget = remoteRes.resolvedTarget;
            resolvedTargetIsRemote = remoteRes.resolvedTargetIsRemote;
        } else if (targetIsRemote) {
            const targetParts = parseRemoteParts(unwrapped);
            resolvedTarget = targetParts ? `${targetParts.prefix}${targetParts.posixPath}` : unwrapped;
            resolvedTargetIsRemote = true;
        } else if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(unwrapped)) {
            resolvedTarget = path.win32.resolve(unwrapped).replace(/\\/g, "/");
            resolvedTargetIsRemote = false;
        } else {
            const cleanedForward = unwrapped.replace(/\\/g, "/").replace(/^\.\//, "");
            const candidateAbs = path.isAbsolute(unwrapped)
                ? path.resolve(unwrapped)
                : path.resolve(rootCanonical, cleanedForward);

            const directRel = path.relative(rootCanonical, candidateAbs).replace(/\\/g, "/");
            if (!directRel || directRel === ".") continue;
            if (!isOutsideRelative(directRel, false)) {
                pushUnique(inWorkspace, seenIn, directRel);
                pushUnique(allNormalized, seenAll, directRel);
                continue;
            }

            const resolvedAbs = realpathSyncSafe(candidateAbs);
            const realRel = path.relative(rootLocalReal, resolvedAbs).replace(/\\/g, "/");
            if (!realRel || realRel === ".") continue;
            if (!isOutsideRelative(realRel, false)) {
                pushUnique(inWorkspace, seenIn, realRel);
                pushUnique(allNormalized, seenAll, realRel);
                continue;
            }

            resolvedTarget = resolvedAbs;
            resolvedTargetIsRemote = false;
        }

        // 4. Check linked folders
        const linkedAnchor = findDeepestLinkedMatch(resolvedTarget, resolvedTargetIsRemote, linkedEntries);
        if (linkedAnchor) {
            pushUnique(linkedNormalized, seenLinked, linkedAnchor);
            pushUnique(allNormalized, seenAll, linkedAnchor);
            continue;
        }

        // 5. Flag as external with deepest ownerCandidate from projects_index.json
        const index = getIndex();
        const ownerCandidate = findDeepestOwnerCandidate(
            resolvedTarget,
            resolvedTargetIsRemote,
            index.projects,
            storeInfo?.storeKey
        );
        externalFiles.push({
            input: rawInput,
            resolvedPath: resolvedTarget,
            ownerCandidate
        });
    }

    return {
        inWorkspace,
        linkedNormalized,
        externalFiles,
        allNormalized
    };
}
