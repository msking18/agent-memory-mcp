/**
 * @file src/store/global.js
 * @description Centralized cross-project global knowledge graph operations.
 * Implements CRUD, FTS5 search, promotion of project memories, and `g-` prefixed
 * routing for the machine-wide `~/.ag-memory-mcp/global.db`.
 */

import crypto from "node:crypto";
import path from "node:path";
import {
    openGlobalDatabase,
    syncGlobalMemoryFts,
    removeGlobalMemoryFts,
    searchGlobalFts
} from "../db/index.js";
import { smartPreview, cleanTags, prepareStore } from "./helpers.js";

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
 * Saves or updates a cross-project pattern, convention, or library quirk in `global.db`.
 *
 * @param {Object} args - Arguments.
 * @param {string|null} [args.id=null] - Optional ID (auto-prefixed with 'g-').
 * @param {string} args.title - Pattern title.
 * @param {string} args.summary - Detailed description and code workaround.
 * @param {string} [args.category="pattern"] - Category classification.
 * @param {Array<string>} [args.tags=[]] - Keyword tags.
 * @param {string} [args.tech_stack="general"] - Associated tech stack.
 * @param {string|null} [args.source_project=null] - Validated project name/path.
 * @returns {{ isError: boolean, id?: string, text: string }} Result object.
 */
export function saveGlobalKnowledge({
    id = null,
    title,
    summary,
    category = "pattern",
    tags = [],
    tech_stack = "general",
    source_project = null
} = {}) {
    if (typeof title !== "string" || !title.trim()) {
        return { isError: true, text: "Error: 'title' is required for global memory." };
    }
    if (typeof summary !== "string" || !summary.trim()) {
        return { isError: true, text: "Error: 'summary' is required for global memory." };
    }

    const globalDb = openGlobalDatabase();
    const cleanT = title.trim();
    const cleanS = summary.trim();
    const cleanCat = typeof category === "string" && category.trim() ? category.trim() : "pattern";
    const cleanTagsArr = cleanTags(tags);
    const cleanStack = typeof tech_stack === "string" && tech_stack.trim() ? tech_stack.trim() : "general";
    const now = new Date().toISOString();

    let targetId = typeof id === "string" && id.trim() ? id.trim() : null;
    if (targetId && !targetId.startsWith("g-")) {
        targetId = `g-${targetId}`;
    }

    let existing = null;
    if (targetId) {
        existing = globalDb.prepare("SELECT * FROM global_memories WHERE id = ?").get(targetId);
    } else {
        targetId = `g-${crypto.randomBytes(4).toString("hex")}`;
    }

    const tagsJson = JSON.stringify(cleanTagsArr);

    if (existing) {
        globalDb.prepare(`
            UPDATE global_memories
            SET title = ?, summary = ?, category = ?, tags_json = ?, tech_stack = ?, source_project = ?, updated_at = ?
            WHERE id = ?
        `).run(cleanT, cleanS, cleanCat, tagsJson, cleanStack, source_project || existing.source_project, now, targetId);
    } else {
        globalDb.prepare(`
            INSERT INTO global_memories (id, title, summary, category, tags_json, tech_stack, source_project, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(targetId, cleanT, cleanS, cleanCat, tagsJson, cleanStack, source_project || null, now, now);
    }

    syncGlobalMemoryFts(globalDb, {
        id: targetId,
        title: cleanT,
        summary: cleanS,
        tags_json: tagsJson,
        tech_stack: cleanStack
    });

    const action = existing ? "Updated" : "Saved";
    return {
        isError: false,
        id: targetId,
        text:
            `[GLOBAL KNOWLEDGE GRAPH] ${action} node [${targetId}]: "${cleanT}"\n` +
            `- Category: ${cleanCat}\n` +
            `- Tech Stack: ${cleanStack}\n` +
            `- Tags: ${cleanTagsArr.join(", ") || "none"}\n` +
            (source_project ? `- Source Project: ${source_project}\n` : "") +
            `\n${cleanS}`
    };
}

/**
 * Searches machine-wide architectural patterns and library quirks in `global.db`.
 *
 * @param {Object} [args] - Search arguments.
 * @param {string} [args.query=""] - Keywords or error patterns.
 * @param {string} [args.category] - Optional category filter.
 * @param {string} [args.tech_stack] - Optional tech stack filter.
 * @param {number} [args.limit=10] - Maximum results to return.
 * @returns {{ isError: boolean, matches: Array<Object>, text: string }} Search results.
 */
export function searchGlobalKnowledge({ query = "", category, tech_stack, limit = 10 } = {}) {
    const globalDb = openGlobalDatabase();
    const cleanQ = typeof query === "string" ? query.trim() : "";
    const cleanCat = typeof category === "string" && category.trim() ? category.trim() : null;
    const cleanStack = typeof tech_stack === "string" && tech_stack.trim() ? tech_stack.trim() : null;

    const rows = searchGlobalFts(globalDb, cleanQ, {
        category: cleanCat,
        tech_stack: cleanStack,
        limit
    });

    if (rows.length === 0) {
        return {
            isError: false,
            results: [],
            matches: [],
            text: `[GLOBAL KNOWLEDGE GRAPH] No patterns or quirks matching "${cleanQ || "*"}" found in global.db.`
        };
    }

    const matches = rows.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        tech_stack: r.tech_stack,
        tags: safeJsonArray(r.tags_json),
        source_project: r.source_project,
        summary: r.summary,
        match_snippet: r.match_snippet || null,
        updated_at: r.updated_at
    }));

    const lines = matches.map((m) => {
        const snippet = m.match_snippet ? `\n  Match: ${m.match_snippet}` : `\n  ${smartPreview(m.summary, 140)}`;
        return `- [${m.id}] (${m.tech_stack}/${m.category}) "${m.title}" (tags: ${m.tags.join(", ") || "none"})${snippet}`;
    });

    return {
        isError: false,
        results: matches,
        matches,
        text:
            `[GLOBAL KNOWLEDGE GRAPH] Found ${matches.length} matching patterns in global.db:\n\n` +
            lines.join("\n\n")
    };
}

/**
 * Promotes a proven project-specific memory node to the machine-wide global knowledge graph in `global.db`.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} args - Arguments.
 * @param {string} args.memory_id - Project memory ID or slug to promote.
 * @param {string} [args.tech_stack="general"] - Associated tech stack.
 * @param {string} [args.category] - Optional category override.
 * @returns {{ isError: boolean, promoted_id?: string, global_id?: string, text: string }} Result record.
 */
export function promoteToGlobal(projectPath, { memory_id, tech_stack = "general", category } = {}) {
    if (!memory_id || typeof memory_id !== "string" || !memory_id.trim()) {
        return { isError: true, text: "Error: 'memory_id' is required for promote_to_global." };
    }

    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    if (!db) {
        return { isError: true, text: "Error: Project memory is uninitialized. Cannot promote memory node." };
    }

    const cleanId = memory_id.trim();
    const row = db
        .prepare("SELECT * FROM memories WHERE id = ? OR slug = ? LIMIT 1")
        .get(cleanId, cleanId);

    if (!row) {
        return { isError: true, text: `Error: Memory node "${cleanId}" not found in project workspace.` };
    }

    const targetCategory = category || row.category || "pattern";
    const projName = path.basename(storeInfo.canonicalPath);

    const res = saveGlobalKnowledge({
        id: `g-${row.id.startsWith("g-") ? row.id.slice(2) : row.id}`,
        title: row.title,
        summary: row.summary,
        category: targetCategory,
        tags: safeJsonArray(row.tags_json),
        tech_stack: tech_stack || "general",
        source_project: projName
    });

    return {
        isError: false,
        promoted_id: res.id,
        global_id: res.id,
        text: `Promoted memory [${row.id}] to global knowledge node [${res.id}]: "${row.title}" (stack: ${tech_stack}). Available across all projects via search_global_knowledge.`
    };
}


/**
 * Reads a global memory entry by ID from `global.db`.
 *
 * @param {string} targetId - Global node ID.
 * @returns {Object|null} Global memory record or null.
 */
export function readGlobalMemory(targetId) {
    const globalDb = openGlobalDatabase();
    return globalDb.prepare("SELECT * FROM global_memories WHERE id = ?").get(targetId);
}

/**
 * Updates a global memory node in place in `global.db`.
 *
 * @param {Object} args - Arguments.
 * @param {string} args.id - Global ID.
 * @param {string} [args.title] - Updated title.
 * @param {string} [args.summary] - Updated summary.
 * @param {string} [args.category] - Updated category.
 * @param {Array<string>} [args.tags] - Updated tags.
 * @param {string} [args.tech_stack] - Updated tech stack.
 * @returns {{ isError: boolean, id?: string, text: string }}
 */
export function updateGlobalMemory({ id, title, summary, category, tags, tech_stack }) {
    const globalDb = openGlobalDatabase();
    const existing = globalDb.prepare("SELECT * FROM global_memories WHERE id = ?").get(id);
    if (!existing) {
        return { isError: true, text: `Error: Global memory "${id}" not found.` };
    }
    const now = new Date().toISOString();
    const nextTitle = typeof title === "string" && title.trim() ? title.trim() : existing.title;
    const nextSummary = typeof summary === "string" && summary.trim() ? summary.trim() : existing.summary;
    const nextTags = Array.isArray(tags) ? cleanTags(tags) : safeJsonArray(existing.tags_json);
    const nextCategory = typeof category === "string" && category.trim() ? category.trim() : existing.category;
    const nextStack = typeof tech_stack === "string" && tech_stack.trim() ? tech_stack.trim() : existing.tech_stack;

    globalDb.prepare(`
        UPDATE global_memories
        SET title = ?, summary = ?, category = ?, tags_json = ?, tech_stack = ?, updated_at = ?
        WHERE id = ?
    `).run(nextTitle, nextSummary, nextCategory, JSON.stringify(nextTags), nextStack, now, existing.id);

    syncGlobalMemoryFts(globalDb, {
        id: existing.id,
        title: nextTitle,
        summary: nextSummary,
        tags: nextTags,
        tech_stack: nextStack
    });

    return {
        isError: false,
        id: existing.id,
        text: `Updated global memory node "${nextTitle}" (ID: ${existing.id}).`
    };
}

/**
 * Deletes a global memory node from `global.db`.
 *
 * @param {string} id - Global node ID.
 * @returns {{ isError: boolean, text: string }}
 */
export function deleteGlobalMemory(id) {
    const globalDb = openGlobalDatabase();
    const existing = globalDb.prepare("SELECT id, title FROM global_memories WHERE id = ?").get(id);
    if (!existing) {
        return { isError: true, text: `Error: Global memory "${id}" not found.` };
    }
    removeGlobalMemoryFts(globalDb, existing.id);
    globalDb.prepare("DELETE FROM global_memories WHERE id = ?").run(existing.id);
    return {
        isError: false,
        text: `Deleted global memory "${existing.title}" (ID: ${existing.id}).`
    };
}
