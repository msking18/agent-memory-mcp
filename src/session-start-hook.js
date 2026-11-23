#!/usr/bin/env node

/**
 * @file src/session-start-hook.js
 * @description Google Antigravity SessionStart lifecycle hook.
 * Inspects open workspace directories (single, multi-folder, and remote URIs) on editor startup
 * and injects pre-hydrated memory context, session timelines, and prompt-first workspace notices
 * directly into the initial system prompt.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMemoryStatus, formatCloneDisambiguationNotice } from "./store.js";
import {
    getProjectStoreInfo,
    getWorkspacePoliciesForPrimary,
    findReverseLinkedPrimary,
    isRemoteUri,
    getWslEquivalentKeys,
    normalizeForIndexCompare
} from "./paths.js";
import { closeAllDatabases } from "./db.js";

const MAX_HYDRATED_SECONDARIES = 4;

function normalizeCommonDir(gitCommonDir) {
    return gitCommonDir ? normalizeForIndexCompare(gitCommonDir, false) : null;
}

function isNestedInside(childInfo, parentInfo) {
    if (!childInfo || !parentInfo || childInfo.isRemote !== parentInfo.isRemote) {
        return false;
    }
    const parentNorm = parentInfo.normalizedForHash;
    const childNorm = childInfo.normalizedForHash;
    if (!parentNorm || !childNorm || childNorm === parentNorm) {
        return false;
    }
    const prefix = parentNorm.endsWith("/") ? parentNorm : `${parentNorm}/`;
    return childNorm.startsWith(prefix);
}

function findPolicyForFolder(policies, folderInfo) {
    if (!policies || !folderInfo) return null;
    if (policies[folderInfo.normalizedForHash]) {
        return policies[folderInfo.normalizedForHash];
    }

    const folderKeys = new Set([
        folderInfo.normalizedForHash,
        ...getWslEquivalentKeys(folderInfo.canonicalPath).map((k) =>
            normalizeForIndexCompare(k, isRemoteUri(k))
        )
    ]);

    for (const [policyKey, policy] of Object.entries(policies)) {
        const normKey = normalizeForIndexCompare(policyKey, isRemoteUri(policyKey));
        if (folderKeys.has(normKey)) {
            return policy;
        }
        for (const eq of getWslEquivalentKeys(policyKey)) {
            if (folderKeys.has(normalizeForIndexCompare(eq, isRemoteUri(eq)))) {
                return policy;
            }
        }
    }

    return null;
}

function formatRemoteWorkspaceNotice(storeInfo) {
    return [
        `[AGENT-MEMORY REMOTE WORKSPACE]`,
        `Workspace "${storeInfo.canonicalPath}" is an uninitialized remote/virtual URI (${storeInfo.remoteScheme}) with no bound git identity yet.`,
        `Before bootstrapping a new store, check if this remote workspace is a git repository (e.g., inspect its origin remote URL) and re-run:`,
        `  check_memory_status(project_path: "${storeInfo.canonicalPath}", git_remote: "<origin-url>")`,
        `or link it explicitly with:`,
        `  configure_workspace(action: "link_project_identity", project_path: "${storeInfo.canonicalPath}", git_remote: "<origin-url>")`
    ].join("\n");
}

function formatLinkedOrderNotice(targetPath, ownerPath, reverseMatch) {
    return [
        `[AGENT-MEMORY LINKED-ORDER NOTICE]`,
        `Workspace "${targetPath}" is already configured as a linked secondary folder ("@${reverseMatch.folderSlug}/") under "${ownerPath}" (store: ${reverseMatch.targetStoreKey}), which is also open in this workspace.`,
        `Use project_path: "${ownerPath}" with "@${reverseMatch.folderSlug}/" file anchors instead of bootstrapping a separate store for "${targetPath}".`
    ].join("\n");
}

function resolveOpenCanonicalPath(targetNormKey, keptFolders) {
    const targetKeys = new Set([
        normalizeForIndexCompare(targetNormKey, isRemoteUri(targetNormKey)),
        ...getWslEquivalentKeys(targetNormKey).map((k) => normalizeForIndexCompare(k, isRemoteUri(k)))
    ]);
    for (const folder of keptFolders) {
        if (targetKeys.has(folder.storeInfo.normalizedForHash)) {
            return folder.storeInfo.canonicalPath;
        }
    }
    return targetNormKey;
}

function resolveAndDedupeRoots(rawPaths) {
    const resolved = [];
    const unavailable = [];
    const seen = new Set();

    for (let i = 0; i < rawPaths.length; i++) {
        const rawPath = rawPaths[i];
        try {
            const storeInfo = getProjectStoreInfo(rawPath);
            if (seen.has(storeInfo.normalizedForHash)) {
                continue;
            }
            seen.add(storeInfo.normalizedForHash);
            resolved.push({
                rawPath,
                storeInfo,
                normGitCommonDir: normalizeCommonDir(storeInfo.gitCommonDir),
                isPrimary: i === 0
            });
        } catch {
            if (i === 0) {
                return { primaryFailed: true, resolved: [], unavailable: [] };
            }
            unavailable.push(rawPath);
        }
    }

    return { primaryFailed: false, resolved, unavailable };
}

function collapseNestedSubfolders(resolvedFolders) {
    if (resolvedFolders.length <= 1) {
        return resolvedFolders;
    }

    const kept = [resolvedFolders[0]];
    for (let i = 1; i < resolvedFolders.length; i++) {
        const candidate = resolvedFolders[i];
        const enclosingParents = kept.filter((parent) => isNestedInside(candidate.storeInfo, parent.storeInfo));

        if (enclosingParents.length === 0) {
            kept.push(candidate);
            continue;
        }

        const hasDistinctGitRepo =
            candidate.normGitCommonDir !== null &&
            enclosingParents.every((parent) => candidate.normGitCommonDir !== parent.normGitCommonDir);

        if (hasDistinctGitRepo) {
            kept.push(candidate);
            continue;
        }

        let hasInitializedOwnStore = false;
        const distinctStoreKey = enclosingParents.every(
            (parent) => candidate.storeInfo.storeKey !== parent.storeInfo.storeKey
        );
        if (distinctStoreKey) {
            try {
                const hasStoreArtifact =
                    fs.existsSync(candidate.storeInfo.dbPath) ||
                    (!candidate.storeInfo.isRemote &&
                        Boolean(candidate.storeInfo.legacyJsonPath) &&
                        fs.existsSync(candidate.storeInfo.legacyJsonPath));

                if (hasStoreArtifact) {
                    const status = checkMemoryStatus(candidate.rawPath, {
                        include_timeline: true,
                        timeline_limit: 3
                    });
                    if (status.initialized) {
                        candidate.cachedStatus = status;
                        hasInitializedOwnStore = true;
                    }
                }
            } catch {
                // Keep fail-safe isolation if probing subfolder store fails
            }
        }

        if (hasInitializedOwnStore) {
            kept.push(candidate);
        }
    }

    return kept;
}

/**
 * Processes an Antigravity SessionStart hook JSON payload and returns
 * the hook stdout response object (never throws).
 *
 * @param {Object} payload - SessionStart hook payload containing `workspacePaths`.
 * @returns {Object} Hook response with optional `injectSteps` systemMessage.
 */
export function runSessionStartPayload(payload) {
    try {
        if (!payload || typeof payload !== "object") {
            return {};
        }

        const rawPaths = Array.isArray(payload.workspacePaths)
            ? payload.workspacePaths
                  .filter((p) => typeof p === "string" && p.trim().length > 0)
                  .map((p) => p.trim())
            : [];

        // No active workspace -> silent no-op (zero friction in scratch / general chats)
        if (rawPaths.length === 0) {
            return {};
        }

        const { primaryFailed, resolved, unavailable } = resolveAndDedupeRoots(rawPaths);
        if (primaryFailed || resolved.length === 0) {
            return {};
        }

        const keptFolders = collapseNestedSubfolders(resolved);
        const openNormalizedKeys = keptFolders.map((f) => f.storeInfo.normalizedForHash);
        const primaryFolder = keptFolders[0];

        let primaryStatus;
        try {
            primaryStatus = checkMemoryStatus(primaryFolder.rawPath, {
                include_timeline: true,
                timeline_limit: 5
            });
        } catch {
            return {};
        }

        const primaryCanonical = primaryStatus.storeInfo.canonicalPath;
        const primaryHeader = primaryStatus.initialized
            ? `[AGENT-MEMORY AUTO-HYDRATED] Startup memory check & session timeline are already loaded below for "${primaryCanonical}" (no need to re-run check_memory_status or get_session_timeline):`
            : `[AGENT-MEMORY STATUS] Workspace "${primaryCanonical}" is UNINITIALIZED:`;

        const outputBlocks = [`${primaryHeader}\n\n${primaryStatus.text}`];

        if (!primaryStatus.initialized) {
            const reversePrimary = findReverseLinkedPrimary(
                primaryStatus.storeInfo.normalizedForHash,
                openNormalizedKeys
            );
            if (reversePrimary) {
                const ownerPath = resolveOpenCanonicalPath(reversePrimary.primaryKey, keptFolders);
                outputBlocks.push(formatLinkedOrderNotice(primaryCanonical, ownerPath, reversePrimary));
            }

            if (
                primaryStatus.storeInfo.isRemote === true &&
                primaryStatus.storeInfo.resolvedVia === "new_path_hash"
            ) {
                outputBlocks.push(formatRemoteWorkspaceNotice(primaryStatus.storeInfo));
            }
        }

        const policies = getWorkspacePoliciesForPrimary(primaryStatus.storeInfo.normalizedForHash);
        let hydratedCount = 0;
        const secondarySections = [];
        const secondaryNotices = [];
        const onDemandSecondaries = [];
        const linkedNotes = [];
        const unconfiguredSecondaries = [];
        const ignoredPaths = [];

        for (const sec of keptFolders.slice(1)) {
            try {
                const policy = findPolicyForFolder(policies, sec.storeInfo);

                if (policy?.mode === "ignored") {
                    ignoredPaths.push(sec.storeInfo.canonicalPath);
                    continue;
                }

                if (policy?.mode === "linked") {
                    const targetStore = policy.targetStoreKey || primaryStatus.storeInfo.storeKey;
                    linkedNotes.push(
                        `- "${sec.storeInfo.canonicalPath}" -> linked to primary "${primaryCanonical}" (store: ${targetStore}, anchor prefix: "@${policy.folderSlug}/"; always pass primary project_path "${primaryCanonical}")`
                    );
                    continue;
                }

                const secStatus =
                    sec.cachedStatus ||
                    checkMemoryStatus(sec.rawPath, {
                        include_timeline: hydratedCount < MAX_HYDRATED_SECONDARIES,
                        timeline_limit: 3
                    });

                if (secStatus.initialized) {
                    if (hydratedCount < MAX_HYDRATED_SECONDARIES) {
                        hydratedCount++;
                        secondarySections.push(
                            `=== Secondary Workspace "${secStatus.storeInfo.canonicalPath}" ===\n${secStatus.text}`
                        );
                    } else {
                        onDemandSecondaries.push(secStatus.storeInfo.canonicalPath);
                    }
                    continue;
                }

                const reverseSec = findReverseLinkedPrimary(
                    secStatus.storeInfo.normalizedForHash,
                    openNormalizedKeys
                );
                if (reverseSec) {
                    const ownerPath = resolveOpenCanonicalPath(reverseSec.primaryKey, keptFolders);
                    secondaryNotices.push(
                        formatLinkedOrderNotice(secStatus.storeInfo.canonicalPath, ownerPath, reverseSec)
                    );
                    continue;
                }

                if (secStatus.duplicateCloneCandidate && policy?.mode !== "independent") {
                    secondaryNotices.push(formatCloneDisambiguationNotice(secStatus.storeInfo));
                }

                if (
                    secStatus.storeInfo.isRemote === true &&
                    secStatus.storeInfo.resolvedVia === "new_path_hash"
                ) {
                    secondaryNotices.push(formatRemoteWorkspaceNotice(secStatus.storeInfo));
                }

                if (policy?.mode === "independent") {
                    secondarySections.push(
                        `=== Secondary Workspace "${secStatus.storeInfo.canonicalPath}" (independent) ===\n${secStatus.text}`
                    );
                } else {
                    unconfiguredSecondaries.push(secStatus.storeInfo.canonicalPath);
                }
            } catch {
                unavailable.push(sec.rawPath);
            }
        }

        if (secondarySections.length > 0) {
            outputBlocks.push(...secondarySections);
        }
        if (secondaryNotices.length > 0) {
            outputBlocks.push(...secondaryNotices);
        }
        if (onDemandSecondaries.length > 0) {
            outputBlocks.push(
                [
                    `Additional Initialized Secondary Workspaces (on-demand; auto-hydration capped at ${MAX_HYDRATED_SECONDARIES}):`,
                    ...onDemandSecondaries.map(
                        (p) => `- "${p}" — call check_memory_status(project_path: "${p}") if needed`
                    )
                ].join("\n")
            );
        }
        if (linkedNotes.length > 0) {
            outputBlocks.push(["Linked Secondary Folders (using primary store):", ...linkedNotes].join("\n"));
        }
        if (unconfiguredSecondaries.length > 0) {
            outputBlocks.push(
                [
                    `[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]`,
                    `The following secondary workspace folder(s) under primary "${primaryCanonical}" are uninitialized and have no configured folder policy:`,
                    ...unconfiguredSecondaries.map((p) => `- "${p}"`),
                    `Ask the user how to handle each folder before saving or bootstrapping memory for it:`,
                    `1. independent — create and bootstrap its own separate project memory store`,
                    `2. linked — store its memories and file anchors in the primary workspace's store (prefixed with "@<folderSlug>/")`,
                    `3. ignored — reference-only; skip project memory and auto-hydration in this workspace`,
                    `Persist the user's choice with: configure_workspace(action: "set_folder_policy", primary_path: "${primaryCanonical}", folder_path: "<folderPath>", mode: "independent" | "linked" | "ignored")`
                ].join("\n")
            );
        }

        const footerLines = [];
        if (ignoredPaths.length > 0) {
            footerLines.push(`Ignored secondary folder(s): ${ignoredPaths.join(", ")}`);
        }
        if (unavailable.length > 0) {
            footerLines.push(`Skipped unavailable secondary folder(s): ${unavailable.join(", ")}`);
        }
        if (footerLines.length > 0) {
            outputBlocks.push(footerLines.join("\n"));
        }

        return {
            injectSteps: [
                {
                    systemMessage: {
                        systemMessage: outputBlocks.join("\n\n")
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
