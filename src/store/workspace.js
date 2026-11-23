/**
 * @file src/store/workspace.js
 * @description Store-layer workspace policy & project identity controller.
 * Provides `resolveStoreLinkedFolders` (across primary canonical paths, worktrees, and aliases)
 * and `configureWorkspace` (`set_folder_policy`, `link_project_identity`, `inspect`).
 */

import {
    readProjectsIndex,
    setWorkspaceFolderPolicy,
    linkProjectIdentity,
    inspectWorkspace,
    isRemoteUri,
    isWslUncPath,
    getWslEquivalentKeys,
    normalizeForIndexCompare
} from "../paths.js";

function expandPolicyLookupKeys(rawKey) {
    const variants = new Set([rawKey]);
    const directNorm = normalizeForIndexCompare(rawKey, isRemoteUri(rawKey));
    if (directNorm) variants.add(directNorm);
    for (const eq of getWslEquivalentKeys(rawKey)) {
        const normEq = normalizeForIndexCompare(eq, isRemoteUri(eq));
        if (normEq) variants.add(normEq);
    }
    return variants;
}

/**
 * Resolves all active `linked` secondary folders configured for a store across
 * the caller's normalized path and the store's registered `canonicalPath` + `aliases[]`.
 *
 * @param {Object|null|undefined} storeInfo - Resolved project StoreInfo.
 * @returns {Array<{ folderSlug: string, canonicalPath: string, normalizedKey: string, isRemote: boolean }>}
 */
export function resolveStoreLinkedFolders(storeInfo) {
    if (!storeInfo || typeof storeInfo !== "object") return [];

    const index = readProjectsIndex();
    const entry = storeInfo.storeKey ? index.projects?.[storeInfo.storeKey] : null;

    const rawCandidates = [
        storeInfo.normalizedForHash,
        storeInfo.canonicalPath,
        entry?.canonicalPath,
        ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
    ];

    const seenPrimaryKeys = new Set();
    const candidateKeys = [];
    for (const raw of rawCandidates) {
        if (typeof raw !== "string" || !raw.trim()) continue;
        const norm = normalizeForIndexCompare(raw, isRemoteUri(raw));
        if (!norm || seenPrimaryKeys.has(norm)) continue;
        seenPrimaryKeys.add(norm);
        candidateKeys.push(norm);
    }

    const workspacePolicies =
        index.workspacePolicies && typeof index.workspacePolicies === "object"
            ? index.workspacePolicies
            : {};

    const policyLookup = Object.entries(workspacePolicies).map(([policyKey, bucket]) => ({
        bucket,
        keyVariants: expandPolicyLookupKeys(policyKey)
    }));

    const linked = [];
    const seenSlugs = new Set();
    const seenFolderKeys = new Set();

    for (const primaryKey of candidateKeys) {
        let policies = workspacePolicies[primaryKey];
        if (!policies) {
            const primaryVariants = expandPolicyLookupKeys(primaryKey);
            for (const item of policyLookup) {
                if (!item.bucket || typeof item.bucket !== "object") continue;
                for (const pv of primaryVariants) {
                    if (item.keyVariants.has(pv)) {
                        policies = item.bucket;
                        break;
                    }
                }
                if (policies) break;
            }
        }
        if (!policies || typeof policies !== "object") continue;

        for (const [secKey, policy] of Object.entries(policies)) {
            if (!policy || policy.mode !== "linked" || typeof policy.folderSlug !== "string") continue;
            const folderSlug = policy.folderSlug.trim();
            if (!folderSlug) continue;

            const slugLower = folderSlug.toLowerCase();
            const isRemote = isRemoteUri(secKey) || isWslUncPath(secKey);
            const normalizedKey = normalizeForIndexCompare(secKey, isRemote);
            if (!normalizedKey) continue;

            if (seenSlugs.has(slugLower) || seenFolderKeys.has(normalizedKey)) continue;
            seenSlugs.add(slugLower);
            seenFolderKeys.add(normalizedKey);

            linked.push({
                folderSlug,
                canonicalPath: secKey,
                normalizedKey,
                isRemote
            });
        }
    }

    return linked;
}

function handleSetFolderPolicy({ primary_path, folder_path, mode, folder_slug }) {
    if (
        typeof primary_path !== "string" ||
        !primary_path.trim() ||
        typeof folder_path !== "string" ||
        !folder_path.trim() ||
        typeof mode !== "string" ||
        !mode.trim()
    ) {
        return {
            isError: true,
            text: "Error: configure_workspace action 'set_folder_policy' requires primary_path, folder_path, and mode ('independent' | 'linked' | 'ignored')."
        };
    }

    const res = setWorkspaceFolderPolicy({
        primaryPath: primary_path,
        folderPath: folder_path,
        mode,
        folderSlug: folder_slug
    });

    let detail;
    if (res.mode === "linked") {
        detail = `Configured workspace folder policy: "${res.folderPath}" is LINKED to primary "${res.primaryPath}" (store: ${res.primaryStoreKey}, anchor prefix: "@${res.folderSlug}/"). Always pass primary project_path "${res.primaryPath}" when reading or saving memories for this folder.`;
    } else if (res.mode === "independent") {
        detail = `Configured workspace folder policy: "${res.folderPath}" is INDEPENDENT under primary "${res.primaryPath}" (separate project store).`;
    } else {
        detail = `Configured workspace folder policy: "${res.folderPath}" is IGNORED under primary "${res.primaryPath}" (excluded from auto-hydration and multi-folder prompts in this workspace).`;
    }

    return {
        isError: false,
        ...res,
        text: detail
    };
}

function handleLinkProjectIdentity({
    project_path,
    source_project_path,
    target_store_key,
    git_remote,
    isolate
}) {
    if (typeof project_path !== "string" || !project_path.trim()) {
        return {
            isError: true,
            text: "Error: configure_workspace action 'link_project_identity' requires project_path."
        };
    }

    const res = linkProjectIdentity({
        projectPath: project_path,
        sourceProjectPath: source_project_path,
        targetStoreKey: target_store_key,
        gitRemote: git_remote,
        isolate: isolate === true
    });

    const lines = [
        `Project identity updated (${res.action}):`,
        `- Store Key: ${res.storeKey}`,
        `- Git Identity: ${res.gitIdentity || "none"}`,
        res.isolatedGitIdentity ? `- Isolated Git Identity: ${res.isolatedGitIdentity}` : null,
        `- Store Initialized: ${res.initialized ? "yes" : "no"}`,
        `- DB Path: ${res.dbPath}`
    ].filter(Boolean);

    if (res.gitIdentityConflict) {
        lines.push(
            `\n[CONFLICT] Git identity "${res.gitIdentityConflict.gitIdentity}" is already owned by store "${res.gitIdentityConflict.conflictingStoreKey}". Current workspace remains bound to "${res.storeKey}".`
        );
    }

    return {
        isError: false,
        ...res,
        text: lines.join("\n")
    };
}

function handleInspect({ project_path, workspace_paths }) {
    if (typeof project_path !== "string" || !project_path.trim()) {
        return {
            isError: true,
            text: "Error: configure_workspace action 'inspect' requires project_path."
        };
    }

    const res = inspectWorkspace({
        projectPath: project_path,
        workspacePaths: workspace_paths
    });
    const { storeInfo } = res;

    const lines = [
        `Workspace Inspection for "${storeInfo.canonicalPath}":`,
        `- Store Key: ${storeInfo.storeKey} (${res.initialized ? "initialized" : "uninitialized"})`,
        `- Resolved Via: ${storeInfo.resolvedVia}`,
        `- Remote Mode: ${storeInfo.isRemote ? `yes (${storeInfo.remoteScheme})` : "no (local)"}`,
        `- Git Identity: ${storeInfo.gitIdentity || "none"}`,
        storeInfo.gitCommonDir ? `- Git Common Dir: ${storeInfo.gitCommonDir}` : null,
        `- DB Path: ${storeInfo.dbPath}`
    ].filter(Boolean);

    if (res.gitIdentityConflict) {
        lines.push(
            `\n[CONFLICT] Git identity "${res.gitIdentityConflict.gitIdentity}" is already owned by store "${res.gitIdentityConflict.conflictingStoreKey}".`
        );
    }

    if (res.duplicateCloneCandidate) {
        lines.push(
            `\n[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED] Simultaneous live clone detected at "${res.duplicateCloneCandidate.existingPath}" (store: ${res.duplicateCloneCandidate.existingStoreKey}, gitIdentity: ${res.duplicateCloneCandidate.gitIdentity}).`
        );
    }

    if (res.reverseLinkedPrimary) {
        lines.push(
            `\n[LINKED FOLDER] Configured as linked ("@${res.reverseLinkedPrimary.folderSlug}/") under primary "${res.reverseLinkedPrimary.primaryKey}" (store: ${res.reverseLinkedPrimary.targetStoreKey}).`
        );
    }

    const policyEntries = Object.entries(res.workspacePolicies || {});
    if (policyEntries.length > 0) {
        lines.push("\nConfigured Workspace Policies:");
        for (const [secKey, pol] of policyEntries) {
            const slugPart = pol.folderSlug ? ` (@${pol.folderSlug}/)` : "";
            lines.push(`  - ${secKey}: ${pol.mode}${slugPart}`);
        }
    } else {
        lines.push("\nConfigured Workspace Policies: none");
    }

    if (Array.isArray(res.workspaceFolders) && res.workspaceFolders.length > 0) {
        lines.push("\nWorkspace Folders:");
        for (const f of res.workspaceFolders) {
            if (f.error) {
                lines.push(`  - ${f.input}: ERROR (${f.error})`);
            } else {
                const polText = f.policy ? `, policy: ${f.policy.mode}` : "";
                lines.push(
                    `  - ${f.canonicalPath}: store=${f.storeKey} (${f.initialized ? "initialized" : "uninitialized"}${polText})`
                );
            }
        }
    }

    return {
        isError: false,
        ...res,
        text: lines.join("\n")
    };
}

/**
 * Configures multi-folder workspace policies, links/isolates project store identities,
 * or inspects resolved workspace metadata without mutating files in user repositories.
 *
 * @param {Object} [args]
 * @returns {{ isError: boolean, text: string, [key: string]: any }}
 */
export function configureWorkspace(args = {}) {
    const action = typeof args?.action === "string" ? args.action.trim() : "";
    try {
        if (action === "set_folder_policy") {
            return handleSetFolderPolicy(args);
        }
        if (action === "link_project_identity") {
            return handleLinkProjectIdentity(args);
        }
        if (action === "inspect") {
            return handleInspect(args);
        }
        return {
            isError: true,
            text: `Error: Unknown configure_workspace action "${action}". Expected "set_folder_policy", "link_project_identity", or "inspect".`
        };
    } catch (err) {
        return {
            isError: true,
            text: `Error: ${err.message}`
        };
    }
}
