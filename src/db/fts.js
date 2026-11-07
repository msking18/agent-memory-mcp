/**
 * @file src/db/fts.js
 * @description Full-Text Search (FTS5) queries, synchronization, and ranking.
 * Implements weighted BM25 full-text indexing, multi-term AND/OR queries,
 * snippet extraction, and Porter stemming across project and global SQLite databases.
 */

/**
 * Sanitizes user search input into valid SQLite FTS5 query tokens.
 * Strips syntax characters that break FTS5 grammar and creates prefix search tokens.
 *
 * @param {string} query - Raw search query string.
 * @returns {string} Sanitized query string safe for FTS5 MATCH clause.
 */
export function sanitizeFtsQuery(query) {
    if (!query || typeof query !== "string") return "";
    const cleaned = query
        .replace(/['"*:^(){}[\]+-]/g, " ")
        .trim();
    if (!cleaned) return "";

    const tokens = cleaned
        .split(/\s+/)
        .filter((t) => t.length > 0 && !["AND", "OR", "NOT"].includes(t.toUpperCase()))
        .map((t) => `"${t}"*`);

    return tokens.join(" ");
}

/**
 * Synchronizes a project memory node into the `memories_fts` index.
 * Weights tags 4x by duplicating them in the indexed document.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Active SQLite database connection.
 * @param {Object} memory - Project memory record.
 * @param {string} memory.id - Unique ID.
 * @param {string} memory.title - Memory title.
 * @param {string} memory.summary - Memory content summary.
 * @param {string} [memory.tags_json] - JSON-serialized tags array.
 * @param {string} [memory.files_json] - JSON-serialized file paths array.
 */
export function syncMemoryFts(db, memory) {
    let tagsStr = "";
    let filesStr = "";
    try {
        const tags = Array.isArray(memory.tags) ? memory.tags : JSON.parse(memory.tags_json || "[]");
        tagsStr = Array.isArray(tags) ? tags.join(" ") : "";
    } catch {
        tagsStr = "";
    }
    try {
        const files = Array.isArray(memory.files) ? memory.files : JSON.parse(memory.files_json || "[]");
        filesStr = Array.isArray(files) ? files.join(" ") : "";
    } catch {
        filesStr = "";
    }

    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(memory.id);
    if (memory.status === "archived") return;

    db.prepare(`
        INSERT INTO memories_fts (id, title, tags_text, files_text, summary)
        VALUES (?, ?, ?, ?, ?)
    `).run(memory.id, memory.title || "", tagsStr, filesStr, memory.summary || "");
}

/**
 * Removes a memory node from the `memories_fts` index.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Active SQLite database connection.
 * @param {string} id - Memory ID to remove.
 */
export function removeMemoryFts(db, id) {
    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id);
}

/**
 * Performs BM25 ranked full-text search against project memories.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Active SQLite database connection.
 * @param {string} query - Raw search query string.
 * @param {Object} [options] - Search options.
 * @param {string} [options.category] - Optional category filter.
 * @param {number} [options.limit=10] - Maximum results to return.
 * @returns {Array<Object>} Ranked search result records with snippets.
 */
export function searchFts(db, query, { category, limit = 10 } = {}) {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    let sql = `
        SELECT
            m.id,
            m.slug,
            m.title,
            m.summary,
            m.category,
            m.tags_json,
            m.files_json,
            m.status,
            m.created_at,
            m.updated_at,
            bm25(memories_fts, 0.0, 5.0, 4.0, 3.0, 1.0) AS score,
            snippet(memories_fts, 4, '[', ']', '...', 24) AS match_snippet
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.id
        WHERE memories_fts MATCH ?
          AND m.status = 'active'
    `;
    const params = [ftsQuery];

    if (category && category !== "all") {
        sql += ` AND m.category = ?`;
        params.push(category);
    }

    sql += ` ORDER BY score ASC LIMIT ?`;
    params.push(limit);

    try {
        let rows = db.prepare(sql).all(...params);
        if (rows.length === 0 && ftsQuery.includes(" ")) {
            const orQuery = ftsQuery.split(/\s+/).join(" OR ");
            params[0] = orQuery;
            rows = db.prepare(sql).all(...params);
        }
        return rows;
    } catch {
        return [];
    }
}

/**
 * Synchronizes a global memory note into `global_memories_fts`.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Global SQLite database connection.
 * @param {Object} memory - Global memory record.
 * @param {string} memory.id - Global ID (prefixed with `g-`).
 * @param {string} memory.title - Pattern or quirk title.
 * @param {string} memory.summary - Detailed description and code.
 * @param {string} [memory.tags_json] - JSON-serialized tags.
 * @param {string} [memory.tech_stack] - Target tech stack (e.g. 'nodejs', 'react').
 */
export function syncGlobalMemoryFts(db, memory) {
    let tagsStr = "";
    try {
        const tags = JSON.parse(memory.tags_json || "[]");
        tagsStr = Array.isArray(tags) ? tags.join(" ") : "";
    } catch {
        tagsStr = "";
    }

    try {
        const ftsCols = db.prepare(`PRAGMA table_info(global_memories_fts)`).all();
        const colNames = new Set(ftsCols.map((c) => c.name));
        if (!colNames.has("tags")) {
            db.exec(`DROP TABLE IF EXISTS global_memories_fts;`);
            db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS global_memories_fts USING fts5(
                id UNINDEXED,
                title,
                tags,
                tech_stack,
                summary,
                tokenize='porter unicode61'
            );`);
        }
    } catch {}

    db.prepare(`DELETE FROM global_memories_fts WHERE id = ?`).run(memory.id);
    db.prepare(`
        INSERT INTO global_memories_fts (id, title, summary, tags, tech_stack)
        VALUES (?, ?, ?, ?, ?)
    `).run(memory.id, memory.title, memory.summary, tagsStr, memory.tech_stack || "general");
}

/**
 * Removes a global memory note from `global_memories_fts`.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Global SQLite database connection.
 * @param {string} id - Global ID to remove.
 */
export function removeGlobalMemoryFts(db, id) {
    db.prepare(`DELETE FROM global_memories_fts WHERE id = ?`).run(id);
}

/**
 * Performs BM25 ranked full-text search against cross-project global memories.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Global SQLite database connection.
 * @param {string} query - Raw search query string.
 * @param {Object} [options] - Search options.
 * @param {string} [options.category] - Optional category filter.
 * @param {string} [options.tech_stack] - Optional tech stack filter.
 * @param {number} [options.limit=10] - Maximum results to return.
 * @returns {Array<Object>} Ranked global search results with snippets.
 */
export function searchGlobalFts(db, query, { category, tech_stack, limit = 10 } = {}) {
    const ftsQuery = sanitizeFtsQuery(query);

    let sql = `
        SELECT
            g.id,
            g.title,
            g.summary,
            g.category,
            g.tags_json,
            g.tech_stack,
            g.source_project,
            g.created_at,
            g.updated_at,
            bm25(global_memories_fts, 5.0, 1.0, 3.0, 2.0) AS score,
            snippet(global_memories_fts, 2, '<b>', '</b>', '...', 32) AS match_snippet
        FROM global_memories_fts fts
        JOIN global_memories g ON g.id = fts.id
        WHERE 1=1
    `;
    const params = [];

    if (ftsQuery) {
        sql += ` AND global_memories_fts MATCH ?`;
        params.push(ftsQuery);
    }
    if (category && category !== "all") {
        sql += ` AND g.category = ?`;
        params.push(category);
    }
    if (tech_stack && tech_stack !== "all") {
        sql += ` AND g.tech_stack = ?`;
        params.push(tech_stack);
    }

    sql += ftsQuery ? ` ORDER BY score ASC LIMIT ?` : ` ORDER BY g.updated_at DESC LIMIT ?`;
    params.push(limit);

    try {
        let rows = db.prepare(sql).all(...params);
        if (rows.length === 0 && ftsQuery && ftsQuery.includes(" ")) {
            const orQuery = ftsQuery.split(/\s+/).join(" OR ");
            params[0] = orQuery;
            rows = db.prepare(sql).all(...params);
        }
        return rows;
    } catch {
        return [];
    }
}
