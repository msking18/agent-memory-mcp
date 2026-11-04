/**
 * @file src/store/index.js
 * @description Central Store Facade and CRUD controller for agent-memory-mcp.
 * Implements `readMemoryNode`, `updateMemoryNode`, and `deleteMemoryNode` while
 * coordinating sub-modules for timeline, CRUD, dead-ends, file-memories, global knowledge,
 * and token budgeting.
 */

import {
    openDatabase,
    syncMemoryFts,
    removeMemoryFts
} from "../db/index.js";
import {
    CANONICAL_SLUG_BY_TITLE,
    VALID_CATEGORIES,
    smartPreview,
    cleanTags,
    cleanFiles,
    prepareStore,
    formatMigrationBanner,
    checkEntryFileStaleness
} from "./helpers.js";
import {
    saveGlobalKnowledge,
    searchGlobalKnowledge,
    promoteToGlobal,
    readGlobalMemory,
    updateGlobalMemory,
    deleteGlobalMemory
} from "./global.js";
import {
    recordDeadEnd,
    checkDeadEnds,
    reopenDeadEnd
} from "./dead-ends.js";
import {
    estimateTokens,
    trimToSentenceBoundary,
    applyTokenBudget,
    getTokenMetrics
} from "./token-budget.js";
import { checkMemoryStatus, getSessionTimeline } from "./timeline.js";
import { getFileMemories } from "./file-memories.js";
import { saveProjectMemory, searchProjectMemory } from "./crud.js";

// Re-export sub-module functions for backwards compatibility and clean access
export {
    CANONICAL_SLUG_BY_TITLE,
    VALID_CATEGORIES,
    smartPreview,
    cleanTags,
    cleanFiles,
    prepareStore,
    formatMigrationBanner,
    checkEntryFileStaleness,
    checkMemoryStatus,
    getSessionTimeline,
    saveProjectMemory,
    searchProjectMemory,
    getFileMemories,
    saveGlobalKnowledge,
    searchGlobalKnowledge,
    promoteToGlobal,
    recordDeadEnd,
    checkDeadEnds,
    reopenDeadEnd,
    estimateTokens,
    trimToSentenceBoundary,
    applyTokenBudget,
    getTokenMetrics
};

/**
 * Safely parses a JSON array string with fallback to empty array.
 *
 * @param {string|null|undefined} raw - Raw JSON string.
 * @returns {Array<any>} Parsed array.
 */
function safeJsonArray(raw) {
    if (!raw) return [];
    try {
        const val = JSON.parse(raw);
        return Array.isArray(val) ? val : [];
    } catch {
        return [];
    }
}

/**
 * Executes a callback within a BEGIN IMMEDIATE transaction on the database.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Active database connection.
 * @param {() => any} fn - Transactional callback.
 * @returns {any} Result of fn.
 */
function withTransaction(db, fn) {
    db.exec("BEGIN IMMEDIATE;");
    try {
        const result = fn();
        db.exec("COMMIT;");
        return result;
    } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
    }
}

/**
 * Reads a single or batch of memory nodes with disk staleness warnings, global `g-` routing, and optional revisions.
 *
 * @param {string} projectPath - Target workspace root directory.
 * @param {Object} args - Arguments.
 * @param {string|null} [args.id=null] - Single memory ID, slug, or global ID (`g-`).
 * @param {Array<string>|null} [args.ids=null] - Batch of memory IDs or slugs.
 * @param {boolean} [args.include_revisions=false] - Whether to include prior revisions.
 * @returns {{ isError: boolean, nodes: Array<Object>, text: string }}
 */
export function readMemoryNode(
    projectPath,
    { id = null, ids = null, include_revisions = false } = {}
) {
    const requestedIds = [];
    if (typeof id === "string" && id.trim()) requestedIds.push(id.trim());
    if (Array.isArray(ids)) {
        for (const item of ids) {
            if (typeof item === "string" && item.trim()) requestedIds.push(item.trim());
        }
    }
    const uniqueIds = [...new Set(requestedIds)];
    if (uniqueIds.length === 0) {
        return {
            isError: true,
            nodes: [],
            text: "Error: Provide 'id' or non-empty 'ids' array."
        };
    }

    let storeInfo = null;
    let migration = null;
    let db = null;
    let banner = "";

    const hasProjectIds = uniqueIds.some((x) => !x.startsWith("g-"));
    if (hasProjectIds || (projectPath && typeof projectPath === "string" && projectPath.trim())) {
        try {
            const prep = prepareStore(projectPath, { createIfMissing: false });
            storeInfo = prep.storeInfo;
            migration = prep.migration;
            db = prep.db;
            banner = formatMigrationBanner(migration);
        } catch (err) {
            if (hasProjectIds) {
                return {
                    isError: true,
                    nodes: [],
                    text: `Error: Project memory is uninitialized or invalid: ${err.message}`
                };
            }
        }
    }

    const getMemStmt = db ? db.prepare("SELECT * FROM memories WHERE id = ?") : null;
    const getBySlugStmt = db
        ? db.prepare("SELECT * FROM memories WHERE slug = ? AND status = 'active' LIMIT 1")
        : null;
    const getDeStmt = db ? db.prepare("SELECT * FROM dead_ends WHERE id = ?") : null;
    const getRevsStmt = db
        ? db.prepare(
              "SELECT id, memory_id, version, title, summary, category, tags_json, files_json, created_at FROM revisions WHERE memory_id = ? ORDER BY version DESC LIMIT 5"
          )
        : null;

    const blocks = [];
    const foundNodes = [];
    const missingIds = [];

    for (const targetId of uniqueIds) {
        if (targetId.startsWith("g-")) {
            const gmem = readGlobalMemory(targetId);
            if (gmem) {
                const tags = safeJsonArray(gmem.tags_json);
                const headerMeta = [
                    `ID: ${gmem.id}`,
                    `Category: ${gmem.category}`,
                    `Tech Stack: ${gmem.tech_stack}`,
                    gmem.source_project ? `Source: ${gmem.source_project}` : null,
                    `Updated: ${gmem.updated_at}`
                ]
                    .filter(Boolean)
                    .join(" | ");

                const lines = [`=== [GLOBAL] ${gmem.title} ===`, headerMeta];
                if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
                lines.push("", gmem.summary);

                foundNodes.push({ ...gmem, tags });
                blocks.push(lines.join("\n"));
                continue;
            }
            missingIds.push(targetId);
            continue;
        }

        if (!db) {
            missingIds.push(targetId);
            continue;
        }

        const mem = getMemStmt.get(targetId) || getBySlugStmt.get(targetId);
        if (mem) {
            const tags = safeJsonArray(mem.tags_json);
            const files = safeJsonArray(mem.files_json);
            const { staleFiles, missingFiles } = checkEntryFileStaleness(
                storeInfo.canonicalPath,
                files,
                mem.updated_at
            );

            const headerMeta = [
                `ID: ${mem.id}`,
                mem.slug ? `Slug: ${mem.slug}` : null,
                `Category: ${mem.category}`,
                `Status: ${mem.status}${mem.superseded_by ? ` (by ${mem.superseded_by})` : ""}`,
                `Updated: ${mem.updated_at}`
            ]
                .filter(Boolean)
                .join(" | ");

            const lines = [`=== ${mem.title} ===`, headerMeta];
            if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
            if (files.length > 0) lines.push(`Anchored Files: ${files.join(", ")}`);

            if (staleFiles.length > 0) {
                lines.push(
                    `[STALE WARNING] Referenced file(s) modified after this memory was saved: ${staleFiles.join(", ")}. Verify against current code.`
                );
            }
            if (missingFiles.length > 0) {
                lines.push(
                    `[STALE WARNING] Referenced file(s) no longer exist on disk: ${missingFiles.join(", ")}.`
                );
            }

            lines.push("", mem.summary);

            if (include_revisions) {
                const revs = getRevsStmt.all(mem.id);
                if (revs.length > 0) {
                    lines.push("\n--- Prior Revisions ---");
                    for (const r of revs) {
                        lines.push(`[${r.created_at}] ${r.title}: ${smartPreview(r.summary, 200)}`);
                    }
                }
            }

            foundNodes.push({ ...mem, tags, files, staleFiles, missingFiles });
            blocks.push(lines.join("\n"));
            continue;
        }

        const de = getDeStmt.get(targetId);
        if (de) {
            const files = safeJsonArray(de.files_json);
            const lines = [
                `=== [DEAD-END] ${de.error_pattern} ===`,
                `ID: ${de.id} | Recorded: ${de.created_at}`,
                files.length > 0 ? `Files: ${files.join(", ")}` : null,
                `\nAttempted Fix (FAILED):\n${de.attempted_solution}`,
                `\nRoot Cause:\n${de.root_cause}`
            ].filter((x) => x !== null);
            foundNodes.push({ ...de, category: "dead_end", files });
            blocks.push(lines.join("\n"));
            continue;
        }

        missingIds.push(targetId);
    }

    if (foundNodes.length === 0) {
        return {
            isError: true,
            nodes: [],
            text: banner + `Error: ID(s) not found: ${missingIds.join(", ")}`
        };
    }

    if (missingIds.length > 0) {
        blocks.push(`\n[Note: ID(s) not found: ${missingIds.join(", ")}]`);
    }

    return {
        isError: false,
        nodes: foundNodes,
        text: banner + blocks.join("\n\n----------------------------------------\n\n")
    };
}

/**
 * Updates a project memory node in place with automatic revision tracking (or routes to global database).
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} args - Arguments.
 * @param {string} args.id - Memory ID to update.
 * @param {string} [args.title] - Updated title.
 * @param {string} [args.summary] - Updated summary.
 * @param {Array<string>} [args.tags] - Updated tags.
 * @param {string} [args.category] - Updated category.
 * @param {Array<string>} [args.files] - Updated file paths.
 * @param {string} [args.tech_stack] - Tech stack for global notes.
 * @returns {{ isError: boolean, id?: string, text: string }}
 */
export function updateMemoryNode(
    projectPath,
    { id, title, summary, tags, category, files, tech_stack }
) {
    if (typeof id === "string" && id.startsWith("g-")) {
        return updateGlobalMemory({ id, title, summary, category, tags, tech_stack });
    }

    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { isError: true, text: banner + "Error: Project memory is uninitialized." };
    }

    const existing =
        db.prepare("SELECT * FROM memories WHERE id = ?").get(id) ||
        db.prepare("SELECT * FROM memories WHERE slug = ? AND status = 'active' LIMIT 1").get(id);

    if (!existing) {
        return { isError: true, text: banner + `Error: Memory ID "${id}" not found.` };
    }

    const now = new Date().toISOString();
    const nextTitle = typeof title === "string" && title.trim() ? title.trim() : existing.title;
    const nextSummary =
        typeof summary === "string" && summary.trim() ? summary.trim() : existing.summary;
    const nextTags = Array.isArray(tags) ? cleanTags(tags) : safeJsonArray(existing.tags_json);
    const nextFiles = Array.isArray(files)
        ? cleanFiles(storeInfo.canonicalPath, files)
        : safeJsonArray(existing.files_json);
    const nextCategory =
        category && VALID_CATEGORIES.includes(category) ? category : existing.category;

    withTransaction(db, () => {
        if (nextTitle !== existing.title || nextSummary !== existing.summary) {
            const revId = crypto.randomUUID();
            db.prepare(`
                INSERT INTO revisions (id, memory_id, version, title, summary, category, tags_json, files_json, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                revId,
                existing.id,
                1,
                existing.title,
                existing.summary,
                existing.category,
                existing.tags_json,
                existing.files_json,
                existing.metadata_json || "{}",
                existing.updated_at
            );
        }

        db.prepare(`
            UPDATE memories
            SET title = ?, summary = ?, category = ?, tags_json = ?, files_json = ?, status = 'active', updated_at = ?
            WHERE id = ?
        `).run(
            nextTitle,
            nextSummary,
            nextCategory,
            JSON.stringify(nextTags),
            JSON.stringify(nextFiles),
            now,
            existing.id
        );

        syncMemoryFts(db, {
            id: existing.id,
            title: nextTitle,
            summary: nextSummary,
            tags_json: JSON.stringify(nextTags),
            files_json: JSON.stringify(nextFiles)
        });
    });

    return {
        isError: false,
        id: existing.id,
        text: banner + `Updated memory node "${nextTitle}" (ID: ${existing.id}). Previous version archived in revisions.`
    };
}

/**
 * Soft-archives (default) or permanently deletes a memory node or dead-end record.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} args - Arguments.
 * @param {string} args.id - Memory ID or dead-end ID.
 * @param {boolean} [args.hard_delete=false] - If true, permanently deletes record.
 * @returns {{ isError: boolean, text: string }}
 */
export function deleteMemoryNode(projectPath, { id, hard_delete = false }) {
    if (typeof id === "string" && id.startsWith("g-")) {
        return deleteGlobalMemory(id);
    }

    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { isError: true, text: banner + "Error: Project memory is uninitialized." };
    }

    const mem = db.prepare("SELECT id, title FROM memories WHERE id = ?").get(id);
    if (mem) {
        withTransaction(db, () => {
            removeMemoryFts(db, mem.id);
            if (hard_delete) {
                db.prepare("DELETE FROM revisions WHERE memory_id = ?").run(mem.id);
                db.prepare("DELETE FROM memories WHERE id = ?").run(mem.id);
            } else {
                db.prepare(
                    "UPDATE memories SET status = 'archived', slug = NULL, updated_at = ? WHERE id = ?"
                ).run(new Date().toISOString(), mem.id);
            }
        });
        return {
            isError: false,
            text:
                banner +
                (hard_delete
                    ? `Permanently deleted memory "${mem.title}" (ID: ${mem.id}).`
                    : `Archived memory "${mem.title}" (ID: ${mem.id}). Removed from active search while preserving history.`)
        };
    }

    const de = db.prepare("SELECT id, error_pattern FROM dead_ends WHERE id = ?").get(id);
    if (de) {
        db.prepare("DELETE FROM dead_ends WHERE id = ?").run(de.id);
        return {
            isError: false,
            text: banner + `Deleted dead-end record "${de.error_pattern}" (ID: ${de.id}).`
        };
    }

    return { isError: true, text: banner + `Error: Entry ID "${id}" not found.` };
}
