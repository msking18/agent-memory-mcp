/**
 * @file src/store/helpers.js
 * @description Pure helper utilities, tag/file cleaners, slug inference, store preparation,
 * cross-folder file guardrails, and remote/linked-folder staleness detection.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
    getProjectStoreInfo,
    registerProjectInIndex,
    normalizeWorkspaceRelativePath,
    classifyWorkspaceFiles,
    isRemoteUri,
    isWslUncPath
} from "../paths.js";
import { openDatabase } from "../db/index.js";
import { ensureMigratedIfLegacyExists } from "../migrate/index.js";
import { resolveStoreLinkedFolders } from "./workspace.js";

/** Map of canonical architectural memory titles to standard URL-safe slugs. */
export const CANONICAL_SLUG_BY_TITLE = new Map([
    ["tech stack & ecosystem", "tech-stack"],
    ["project structure & architecture", "project-structure"],
    ["build & run instructions", "build-run"]
]);

/** Valid categories supported by agent-memory-mcp. */
export const VALID_CATEGORIES = ["architecture", "decision", "session", "dead_end", "note", "pattern"];

/**
 * Generates a clean single-line preview of a multi-line text block, cut at word boundary.
 *
 * @param {string} text - Raw input text.
 * @param {number} [maxLen=180] - Maximum characters in preview.
 * @returns {string} Cleaned single-line preview string with ellipsis if truncated.
 */
export function smartPreview(text, maxLen = 180) {
    if (typeof text !== "string") return "";
    const singleLine = text.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxLen) return singleLine;
    const cut = singleLine.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut) + "...";
}

/**
 * Deduplicates and normalizes tags into a clean array of strings.
 *
 * @param {Array<string>|null|undefined} tags - Raw tag list.
 * @returns {Array<string>} Normalized tags.
 */
export function cleanTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of tags) {
        const t = String(raw ?? "").trim();
        if (!t) continue;
        const lower = t.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            out.push(t);
        }
    }
    return out;
}

/**
 * Normalizes, canonicalizes, and deduplicates workspace file paths.
 *
 * @param {string} canonicalProjectPath - Workspace root directory.
 * @param {Array<string>|null|undefined} files - Array of workspace file paths.
 * @param {{ isRemote?: boolean }} [options] - Normalization options.
 * @returns {Array<string>} Normalized relative file paths.
 */
export function cleanFiles(canonicalProjectPath, files, options = {}) {
    if (!Array.isArray(files)) return [];
    const seen = new Set();
    const out = [];
    for (const f of files) {
        const rel = normalizeWorkspaceRelativePath(canonicalProjectPath, f, options);
        if (!rel) continue;
        const key = process.platform === "win32" ? rel.toLowerCase() : rel;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(rel);
        }
    }
    return out;
}

/**
 * Infers an appropriate memory category and canonical slug for a save entry.
 *
 * @param {Object} item - Input memory entry.
 * @returns {{ category: string, slug: string|null }} Inferred category and slug.
 */
export function inferCategoryAndSlugForSave(item) {
    const lowerTitle = (item.title || "").trim().toLowerCase();
    const lowerTags = (item.tags || []).map((t) => String(t).toLowerCase());

    let slug = item.slug ? String(item.slug).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") : null;
    if (!slug && CANONICAL_SLUG_BY_TITLE.has(lowerTitle)) {
        slug = CANONICAL_SLUG_BY_TITLE.get(lowerTitle);
    }

    let category = item.category && VALID_CATEGORIES.includes(item.category) ? item.category : null;
    if (!category) {
        if (slug && [...CANONICAL_SLUG_BY_TITLE.values()].includes(slug)) {
            category = "architecture";
        } else if (
            lowerTitle.startsWith("session log") ||
            lowerTags.includes("session") ||
            lowerTags.includes("changelog")
        ) {
            category = "session";
        } else if (
            lowerTags.includes("architecture") ||
            lowerTags.includes("stack") ||
            lowerTags.includes("bootstrap") ||
            lowerTags.includes("core")
        ) {
            category = "architecture";
        } else if (lowerTags.includes("decision") || lowerTags.includes("adr")) {
            category = "decision";
        } else {
            category = "note";
        }
    }

    return { category, slug };
}

/**
 * Generates an 8-character unique hexadecimal ID that does not collide with existing rows.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Active database connection.
 * @param {string} [table="memories"] - Table name to check for collision.
 * @param {string} [prefix=""] - Optional ID prefix (e.g. 'g-').
 * @returns {string} Unique identifier string.
 */
export function generateUniqueId(db, table = "memories", prefix = "") {
    const checkStmt = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
    for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        if (!checkStmt.get(candidate)) return candidate;
    }
    return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Prepares store info, runs transparent JIT migration if legacy `.ag-memory.json` exists
 * (skipped for remote workspaces), and opens the SQLite database (or persists remote
 * `gitRemote` index bindings without creating an empty `.db` on read-only checks).
 *
 * @param {string} projectPath - Target project directory path or remote URI.
 * @param {Object} [options] - Options.
 * @param {boolean} [options.createIfMissing=true] - If false, does not create empty DB on disk.
 * @param {string} [options.gitRemote] - Optional git remote URL for remote/virtual binding.
 * @returns {{ storeInfo: Object, migration: Object, db: import("node:sqlite").DatabaseSync|null }}
 */
export function prepareStore(projectPath, { createIfMissing = true, gitRemote } = {}) {
    const cleanGitRemote = typeof gitRemote === "string" && gitRemote.trim() ? gitRemote.trim() : "";
    const storeInfo = getProjectStoreInfo(
        projectPath,
        cleanGitRemote ? { gitRemote: cleanGitRemote } : undefined
    );
    const migration = storeInfo.isRemote
        ? { action: "none" }
        : ensureMigratedIfLegacyExists(storeInfo);

    if (!createIfMissing && !fs.existsSync(storeInfo.dbPath)) {
        if (cleanGitRemote && storeInfo.gitIdentity && !storeInfo.duplicateCloneCandidate) {
            const reg = registerProjectInIndex(storeInfo);
            if (reg?.gitIdentityConflict && !storeInfo.gitIdentityConflict) {
                storeInfo.gitIdentityConflict = reg.gitIdentityConflict;
            }
        }
        return { storeInfo, migration, db: null };
    }

    const db = openDatabase(storeInfo.dbPath);
    const reg = registerProjectInIndex(storeInfo);
    if (reg?.gitIdentityConflict && !storeInfo.gitIdentityConflict) {
        storeInfo.gitIdentityConflict = reg.gitIdentityConflict;
    }
    return { storeInfo, migration, db };
}

/**
 * Formats a human-readable banner string if a JIT migration was performed during this invocation.
 *
 * @param {Object} migration - Migration result object.
 * @returns {string} Formatted banner string or empty string.
 */
export function formatMigrationBanner(migration) {
    if (!migration || migration.action === "none") return "";
    if (migration.action === "migrated_initial") {
        return `[MIGRATED v2 -> v3] Imported ${migration.entryCount} legacy entries into SQLite+FTS5 (backup archived at ${migration.backupFilePath}).\n\n`;
    }
    if (migration.action === "delta_merged") {
        return `[DELTA MERGED] Merged ${migration.insertedCount} new legacy entries (${migration.divergentRevisionsCount} revisions preserved; backup at ${migration.backupFilePath}).\n\n`;
    }
    if (migration.action === "corrupt_quarantined") {
        return `[WARNING] ${migration.warning}\n\n`;
    }
    return "";
}

/**
 * Formats a clone-disambiguation notice when simultaneous live clones share a gitIdentity.
 *
 * @param {Object} storeInfo
 * @returns {string}
 */
export function formatCloneDisambiguationNotice(storeInfo) {
    const dup = storeInfo?.duplicateCloneCandidate;
    if (!dup) return "";
    return [
        `[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED]`,
        `Workspace "${storeInfo.canonicalPath}" shares gitIdentity "${dup.gitIdentity}" with an existing live checkout at "${dup.existingPath}" (store: ${dup.existingStoreKey}).`,
        `Ask the user whether this checkout is a separate project (e.g., cloned from a starter template) or should share the existing store:`,
        `- Isolate as a new store: configure_workspace(action: "link_project_identity", project_path: "${storeInfo.canonicalPath}", isolate: true) or retry save_project_memory with force_isolate: true.`,
        `- Share the existing store: configure_workspace(action: "link_project_identity", project_path: "${storeInfo.canonicalPath}", target_store_key: "${dup.existingStoreKey}").`
    ].join("\n");
}

/**
 * Formats a git identity conflict warning when another store already owns the detected gitIdentity.
 *
 * @param {Object} storeInfo
 * @returns {string}
 */
export function formatGitConflictNotice(storeInfo) {
    const conflict = storeInfo?.gitIdentityConflict;
    if (!conflict) return "";
    return (
        `[CONFLICT] Git identity "${conflict.gitIdentity}" is already owned by store "${conflict.conflictingStoreKey}". ` +
        `Workspace "${storeInfo.canonicalPath}" remains bound to store "${storeInfo.storeKey}". ` +
        `Use configure_workspace(action: "link_project_identity", ...) to relink or isolate.`
    );
}

function lookupLinkedFolderBySlug(linkedFoldersBySlug, rawSlug) {
    if (!linkedFoldersBySlug || !rawSlug) return null;
    const key = rawSlug.toLowerCase();
    if (linkedFoldersBySlug instanceof Map) {
        return linkedFoldersBySlug.get(key) || linkedFoldersBySlug.get(rawSlug) || null;
    }
    if (typeof linkedFoldersBySlug === "object") {
        if (linkedFoldersBySlug[key]) return linkedFoldersBySlug[key];
        if (linkedFoldersBySlug[rawSlug]) return linkedFoldersBySlug[rawSlug];
        for (const [k, v] of Object.entries(linkedFoldersBySlug)) {
            if (k.toLowerCase() === key) return v;
        }
    }
    return null;
}

/**
 * Inspects referenced workspace files on disk to detect whether files have been modified
 * after the memory note was saved (skipping remote workspaces and unlinked/unavailable `@slug/` anchors).
 *
 * @param {string} canonicalProjectPath - Workspace root directory or remote URI.
 * @param {Array<string>} files - Relative file paths or `@<slug>/<rel>` anchors referenced by memory node.
 * @param {string} updatedAtIso - ISO-8601 timestamp of last memory update.
 * @param {Object} [options] - Staleness check options.
 * @param {boolean} [options.isRemote=false] - Whether workspace is remote/virtual.
 * @param {Map<string, Object>|Record<string, Object>|null} [options.linkedFoldersBySlug=null] - Active linked folders keyed by slug.
 * @returns {{ staleFiles: Array<string>, missingFiles: Array<string>, skippedRemote: boolean }}
 */
export function checkEntryFileStaleness(
    canonicalProjectPath,
    files,
    updatedAtIso,
    { isRemote = false, linkedFoldersBySlug = null } = {}
) {
    const remote =
        Boolean(isRemote) ||
        isRemoteUri(canonicalProjectPath) ||
        isWslUncPath(canonicalProjectPath);

    if (remote) {
        return { staleFiles: [], missingFiles: [], skippedRemote: true };
    }

    if (!Array.isArray(files) || files.length === 0) {
        return { staleFiles: [], missingFiles: [], skippedRemote: false };
    }

    const updatedMs = Date.parse(updatedAtIso) || 0;
    const staleFiles = [];
    const missingFiles = [];

    for (const rel of files) {
        if (typeof rel !== "string" || !rel.trim()) continue;
        const slashRel = rel.replace(/\\/g, "/");
        const anchorMatch = slashRel.match(/^@([^/]+)\/(.+)$/);

        let abs;
        if (anchorMatch) {
            const folder = lookupLinkedFolderBySlug(linkedFoldersBySlug, anchorMatch[1]);
            if (
                !folder ||
                folder.isRemote ||
                !folder.canonicalPath ||
                isRemoteUri(folder.canonicalPath) ||
                isWslUncPath(folder.canonicalPath) ||
                !fs.existsSync(folder.canonicalPath)
            ) {
                continue;
            }
            abs = path.join(folder.canonicalPath, anchorMatch[2]);
        } else {
            if (
                rel === ".." ||
                rel.startsWith("../") ||
                rel.startsWith("..\\") ||
                path.isAbsolute(rel) ||
                /^[a-zA-Z]:[\\/]/.test(rel)
            ) {
                continue;
            }
            abs = path.join(canonicalProjectPath, rel);
        }

        try {
            const stat = fs.statSync(abs);
            // Allow 1.5s grace window for files saved in the same turn as the memory log
            if (stat.mtimeMs > updatedMs + 1500) {
                staleFiles.push(rel);
            }
        } catch (err) {
            if (err.code === "ENOENT") {
                missingFiles.push(rel);
            }
        }
    }

    return { staleFiles, missingFiles, skippedRemote: false };
}

/**
 * Classifies and guards `files[]` against cross-folder writes before any SQLite transaction opens.
 * Normalizes in-workspace and linked `@<folderSlug>/` paths, and blocks external paths unless `allowExternal` is true.
 *
 * @param {Object} storeInfo - Resolved project StoreInfo.
 * @param {Array<string>|null|undefined} files - Input file paths.
 * @param {Object} [options]
 * @param {boolean} [options.allowExternal=false] - Override cross-folder write guardrail.
 * @param {Array<Object>|null} [options.linkedFolders=null] - Pre-resolved linked folders for storeInfo.
 * @returns {{ isError: boolean, files: Array<string>, classified: Object, text?: string }}
 */
export function resolveAndGuardFiles(
    storeInfo,
    files,
    { allowExternal = false, linkedFolders = null } = {}
) {
    if (!Array.isArray(files) || files.length === 0) {
        return {
            isError: false,
            files: [],
            classified: {
                inWorkspace: [],
                linkedNormalized: [],
                externalFiles: [],
                allNormalized: []
            }
        };
    }

    const activeLinked = Array.isArray(linkedFolders)
        ? linkedFolders
        : resolveStoreLinkedFolders(storeInfo);
    const classified = classifyWorkspaceFiles(storeInfo, files, { linkedFolders: activeLinked });

    if (classified.externalFiles.length > 0 && allowExternal !== true) {
        const lines = [
            `Cross-folder write guardrail blocked saving to "${storeInfo.canonicalPath}" because ${classified.externalFiles.length} file(s) fall outside this workspace:`
        ];
        for (const ext of classified.externalFiles) {
            const ownerInfo = ext.ownerCandidate
                ? ` -> owned by tracked project "${ext.ownerCandidate.canonicalPath}" (store: ${ext.ownerCandidate.storeKey})`
                : ` -> outside tracked workspaces (no owning store found in projects_index.json)`;
            lines.push(`- ${ext.input}${ownerInfo}`);
        }
        lines.push(
            "",
            `Ask the user where to save this memory/dead-end before retrying:`,
            `1. Save to the owning folder's project_path instead,`,
            `2. Save to "${storeInfo.canonicalPath}" anyway (retry with allow_external_files: true),`,
            `3. Save to both stores (or configure a linked policy via configure_workspace action "set_folder_policy" with mode "linked").`
        );
        return {
            isError: true,
            files: [],
            classified,
            text: lines.join("\n")
        };
    }

    const out = [];
    const seen = new Set();
    const pushDedup = (value) => {
        if (!value) return;
        const key = process.platform === "win32" ? value.toLowerCase() : value;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(value);
        }
    };

    for (const norm of classified.allNormalized) {
        pushDedup(norm);
    }
    for (const ext of classified.externalFiles) {
        const fallback =
            normalizeWorkspaceRelativePath(storeInfo.canonicalPath, ext.input, {
                isRemote: storeInfo.isRemote
            }) || ext.resolvedPath;
        pushDedup(fallback);
    }

    return {
        isError: false,
        files: out,
        classified
    };
}
