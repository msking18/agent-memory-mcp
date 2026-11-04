/**
 * @file src/store/crud.js
 * @description Core project memory persistence and FTS5 search handlers.
 * Implements `saveProjectMemory` (atomic single/batch upserts with canonical slug routing)
 * and `searchProjectMemory` (BM25 weighted full-text search with dead-end cross-checking).
 */

import crypto from "node:crypto";
import { openDatabase, syncMemoryFts, searchFts } from "../db/index.js";
import {
    cleanTags,
    cleanFiles,
    inferCategoryAndSlugForSave,
    generateUniqueId,
    prepareStore,
    formatMigrationBanner,
    smartPreview
} from "./helpers.js";
import { checkDeadEnds } from "./dead-ends.js";

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
 * Saves a single memory entry or atomic batch of entries to the project store.
 * Automatically handles canonical slugs, updates existing matching nodes in-place,
 * archives previous versions into the `revisions` table, and synchronizes FTS5 indexes.
 *
 * @param {string} projectPath - Target workspace root directory.
 * @param {Object} args - Arguments.
 * @param {string} [args.title] - Memory title.
 * @param {string} [args.summary] - Full memory markdown/text context.
 * @param {Array<string>} [args.tags] - Keyword tags.
 * @param {Array<string>} [args.files] - Referenced workspace-relative files.
 * @param {string} [args.category] - Category classification.
 * @param {string} [args.slug] - Canonical slug (e.g. 'tech-stack').
 * @param {string} [args.id] - Optional ID to update in-place.
 * @param {Array<Object>} [args.entries] - Batch of entries for atomic multi-entry save.
 * @returns {{ saved: Array<Object>, text: string }} Saved memory records.
 */
export function saveProjectMemory(
    projectPath,
    { title, summary, tags, files, category, slug, id, entries } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: true });
    const banner = formatMigrationBanner(migration);

    const itemsToSave = [];
    if (Array.isArray(entries) && entries.length > 0) {
        for (const e of entries) {
            if (e && typeof e === "object") itemsToSave.push(e);
        }
    } else {
        if (!title?.trim() || !summary?.trim()) {
            throw new Error(
                "save_project_memory requires either 'entries' array or 'title' + 'summary'."
            );
        }
        itemsToSave.push({ title, summary, tags, files, category, slug, id });
    }

    const savedResults = [];

    withTransaction(db, () => {
        const findBySlugStmt = db.prepare(
            "SELECT * FROM memories WHERE slug = ? AND status = 'active' LIMIT 1"
        );
        const findByIdStmt = db.prepare("SELECT * FROM memories WHERE id = ?");
        const insertRevStmt = db.prepare(`
            INSERT INTO revisions (id, memory_id, version, title, summary, category, tags_json, files_json, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const updateStmt = db.prepare(`
            UPDATE memories
            SET title = ?, summary = ?, category = ?, tags_json = ?, files_json = ?, slug = ?, updated_at = ?
            WHERE id = ?
        `);
        const insertStmt = db.prepare(`
            INSERT INTO memories (
                id, slug, title, summary, category, tags_json, files_json,
                source, status, metadata_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'active', '{}', ?, ?)
        `);

        for (const item of itemsToSave) {
            const cleanT = (item.title || "").trim();
            const cleanS = (item.summary || "").trim();
            const { category: finalCategory, slug: finalSlug } = inferCategoryAndSlugForSave(item);
            const cleanedTags = cleanTags(item.tags);
            const cleanedFiles = cleanFiles(storeInfo.canonicalPath, item.files);
            const now = new Date().toISOString();

            let targetRecord = null;
            if (item.id) {
                targetRecord = findByIdStmt.get(item.id);
            }
            if (!targetRecord && finalSlug) {
                targetRecord = findBySlugStmt.get(finalSlug);
            }

            let entryId;
            let action;

            if (targetRecord) {
                entryId = targetRecord.id;
                action = "updated";

                const revId = crypto.randomUUID();
                insertRevStmt.run(
                    revId,
                    targetRecord.id,
                    1,
                    targetRecord.title,
                    targetRecord.summary,
                    targetRecord.category,
                    targetRecord.tags_json,
                    targetRecord.files_json,
                    targetRecord.metadata_json || "{}",
                    targetRecord.updated_at
                );

                updateStmt.run(
                    cleanT,
                    cleanS,
                    finalCategory,
                    JSON.stringify(cleanedTags),
                    JSON.stringify(cleanedFiles),
                    finalSlug || targetRecord.slug,
                    now,
                    entryId
                );
            } else {
                entryId = item.id ? String(item.id).trim() : generateUniqueId(db, "memories", "m-");
                action = "created";

                insertStmt.run(
                    entryId,
                    finalSlug,
                    cleanT,
                    cleanS,
                    finalCategory,
                    JSON.stringify(cleanedTags),
                    JSON.stringify(cleanedFiles),
                    now,
                    now
                );
            }

            syncMemoryFts(db, {
                id: entryId,
                title: cleanT,
                summary: cleanS,
                tags_json: JSON.stringify(cleanedTags),
                files_json: JSON.stringify(cleanedFiles)
            });

            savedResults.push({
                id: entryId,
                slug: finalSlug,
                title: cleanT,
                category: finalCategory,
                action,
                tags: cleanedTags,
                files: cleanedFiles
            });
        }
    });

    const summaryLines = savedResults.map(
        (r) =>
            `- [${r.action.toUpperCase()}] [${r.slug || r.id}] (${r.category}) "${r.title}" (tags: ${r.tags.join(", ") || "none"})`
    );

    return {
        results: savedResults,
        storeInfo,
        text:
            banner +
            `Saved ${savedResults.length} memory ${savedResults.length === 1 ? "entry" : "entries"} for "${storeInfo.canonicalPath}":\n` +
            summaryLines.join("\n")
    };
}

/**
 * Searches project memory nodes and anti-loop dead-ends using FTS5 BM25 ranked search.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} [options] - Search options.
 * @param {string} options.query - Keywords or terms to search.
 * @param {string} [options.category=null] - Category filter.
 * @param {number} [options.limit=10] - Maximum records to return.
 * @returns {{ matches: Array<Object>, deadEndMatches: Array<Object>, text: string }} Search results.
 */
export function searchProjectMemory(
    projectPath,
    { query, category = null, limit = 10 } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { matches: [], deadEndMatches: [], text: banner + "No relevant memory found (project memory uninitialized)." };
    }

    const safeLimit = Math.max(1, Math.min(30, Math.trunc(Number(limit) || 10)));
    const rows =
        category === "dead_end"
            ? []
            : searchFts(db, query, {
                  category: category || undefined,
                  limit: safeLimit
              });

    const matches = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        category: r.category,
        tags: safeJsonArray(r.tags_json),
        files: safeJsonArray(r.files_json),
        summary: r.summary,
        status: r.status,
        match_snippet: r.match_snippet || null,
        created_at: r.created_at,
        updated_at: r.updated_at
    }));

    let deadEndMatches = [];
    if (!category || category === "dead_end") {
        const deadEndResult = checkDeadEnds(projectPath, { query, limit: 5 });
        deadEndMatches = deadEndResult.matches || [];
    }

    if (matches.length === 0 && deadEndMatches.length === 0) {
        return { matches: [], deadEndMatches: [], text: banner + "No relevant memory found." };
    }

    const out = [];
    if (matches.length > 0) {
        out.push(`Memory Matches (${matches.length}):`);
        for (const m of matches) {
            const tagStr = m.tags.length > 0 ? ` | Tags: ${m.tags.join(", ")}` : "";
            const fileStr = m.files.length > 0 ? `\n  Files: ${m.files.join(", ")}` : "";
            const snippet = (m.match_snippet || smartPreview(m.summary, 140)).replace(/\s+/g, " ").trim();
            out.push(
                `- [ID: ${m.slug || m.id}] (${m.category}) ${m.title}${tagStr}\n  Snippet: ${snippet}${fileStr}`
            );
        }
    }

    if (deadEndMatches.length > 0) {
        out.push(`\nMatching Anti-Loop Dead-Ends (${deadEndMatches.length}):`);
        for (const de of deadEndMatches) {
            out.push(
                `- [ID: ${de.id}] Error: ${de.error_pattern}\n  Failed Fix: ${de.attempted_solution}\n  Root Cause: ${de.root_cause}`
            );
        }
    }

    out.push("\nUse read_memory_node with id or ids[] for complete entry text.");

    return {
        matches,
        deadEndMatches,
        text: banner + out.join("\n")
    };
}
