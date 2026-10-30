import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** @type {Map<string, DatabaseSync>} */
const dbCache = new Map();

export const SCHEMA_VERSION = "3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    slug TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'note',
    tags_json TEXT NOT NULL DEFAULT '[]',
    files_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT,
    legacy_meta_json TEXT,
    embedding BLOB NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_status_cat_updated
    ON memories(status, category, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_slug
    ON memories(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_revisions (
    rev_id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    prev_title TEXT,
    prev_summary TEXT,
    prev_tags_json TEXT,
    changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revisions_memory_id
    ON memory_revisions(memory_id, rev_id DESC);

CREATE TABLE IF NOT EXISTS dead_ends (
    id TEXT PRIMARY KEY,
    error_pattern TEXT NOT NULL,
    attempted_solution TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    files_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_ends_created
    ON dead_ends(created_at DESC);

CREATE TABLE IF NOT EXISTS migration_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    entry_count INTEGER NOT NULL,
    backup_path TEXT NOT NULL,
    migrated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED,
    title,
    tags_text,
    files_text,
    summary,
    tokenize='porter unicode61'
);
`;

/**
 * Configures pragmas and ensures schema tables exist on a DatabaseSync instance.
 */
export function initializeDatabaseInstance(db) {
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
    `);
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    return db;
}

/**
 * Opens (or retrieves cached) SQLite database at dbPath.
 * Pass { cache: false } when working on temporary staging files during migration.
 */
export function openDatabase(dbPath, { cache = true } = {}) {
    const resolved = path.resolve(dbPath);
    if (cache && dbCache.has(resolved)) {
        return dbCache.get(resolved);
    }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new DatabaseSync(resolved);
    initializeDatabaseInstance(db);

    if (cache) {
        dbCache.set(resolved, db);
    }
    return db;
}

/**
 * Closes a specific cached database connection (useful before file operations or in tests).
 */
export function closeDatabase(dbPath) {
    const resolved = path.resolve(dbPath);
    const db = dbCache.get(resolved);
    if (db) {
        dbCache.delete(resolved);
        try {
            db.close();
        } catch {
            // Ignore already-closed errors
        }
    }
}

/**
 * Closes all open cached database connections.
 */
export function closeAllDatabases() {
    for (const [key, db] of dbCache.entries()) {
        dbCache.delete(key);
        try {
            db.close();
        } catch {
            // Ignore already-closed errors
        }
    }
}

/**
 * Runs a synchronous callback inside an ACID BEGIN IMMEDIATE transaction.
 */
export function withTransaction(db, fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    } catch (err) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Ignore rollback error if transaction already aborted
        }
        throw err;
    }
}

/**
 * Synchronizes a single memory record with the FTS5 index.
 * Archived entries are removed from FTS; active and superseded entries remain searchable.
 */
export function syncMemoryFts(db, entry) {
    db.prepare("DELETE FROM memories_fts WHERE id = ?").run(entry.id);
    if (entry.status === "archived") return;

    const tags = Array.isArray(entry.tags) ? entry.tags : safeJsonArray(entry.tags_json);
    const files = Array.isArray(entry.files) ? entry.files : safeJsonArray(entry.files_json);

    db.prepare(`
        INSERT INTO memories_fts (id, title, tags_text, files_text, summary)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        entry.id,
        entry.title || "",
        tags.join(" "),
        files.join(" "),
        entry.summary || ""
    );
}

export function removeMemoryFts(db, id) {
    db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
}

export function safeJsonArray(jsonStr) {
    if (!jsonStr) return [];
    try {
        const parsed = JSON.parse(jsonStr);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

/**
 * Sanitizes arbitrary user/agent search input (including @google/genai, C:\paths, stack traces)
 * into safe FTS5 prefix queries with AND primary and OR fallback.
 */
export function buildFtsQueries(rawQuery) {
    if (typeof rawQuery !== "string" || !rawQuery.trim()) {
        return { tokens: [], andQuery: "", orQuery: "" };
    }

    const matches = rawQuery.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
    const seen = new Set();
    const tokens = [];
    for (const tok of matches) {
        if (!seen.has(tok)) {
            seen.add(tok);
            tokens.push(tok);
            if (tokens.length >= 16) break;
        }
    }

    if (tokens.length === 0) {
        return { tokens: [], andQuery: "", orQuery: "" };
    }

    const formatToken = (t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`);
    return {
        tokens,
        andQuery: tokens.map(formatToken).join(" AND "),
        orQuery: tokens.map(formatToken).join(" OR ")
    };
}

/**
 * Executes weighted BM25 full-text search across title (5x), tags (4x), files (3x), and summary (1x),
 * automatically falling back from AND to OR on multi-word queries when AND yields 0 matches.
 */
export function searchFts(
    db,
    rawQuery,
    { category = null, tags = null, includeSuperseded = false, limit = 10 } = {}
) {
    const { tokens, andQuery, orQuery } = buildFtsQueries(rawQuery);
    if (tokens.length === 0) return [];

    const allowedStatuses = includeSuperseded ? ["active", "superseded"] : ["active"];
    const statusPlaceholders = allowedStatuses.map(() => "?").join(", ");

    const runMatch = (matchExpr) => {
        const sql = `
            SELECT
                m.id,
                m.slug,
                m.title,
                m.summary,
                m.category,
                m.tags_json,
                m.files_json,
                m.status,
                m.superseded_by,
                m.created_at,
                m.updated_at,
                bm25(memories_fts, 0.0, 5.0, 4.0, 3.0, 1.0) AS rank_score,
                snippet(memories_fts, 4, '[', ']', '...', 24) AS match_snippet
            FROM memories_fts
            JOIN memories m ON m.id = memories_fts.id
            WHERE memories_fts MATCH ?
              AND m.status IN (${statusPlaceholders})
              ${category ? "AND m.category = ?" : ""}
            ORDER BY rank_score ASC, m.updated_at DESC
            LIMIT ?
        `;
        const params = [matchExpr, ...allowedStatuses];
        if (category) params.push(category);
        // Fetch slightly more before JS-level tag filtering
        const fetchLimit = tags && tags.length > 0 ? Math.max(limit * 4, 40) : limit;
        params.push(fetchLimit);

        let rows = db.prepare(sql).all(...params).map((r) => ({
            ...r,
            tags: safeJsonArray(r.tags_json),
            files: safeJsonArray(r.files_json)
        }));

        if (Array.isArray(tags) && tags.length > 0) {
            const wanted = tags.map((t) => t.toLowerCase().trim()).filter(Boolean);
            rows = rows.filter((row) => {
                const rowTags = row.tags.map((t) => t.toLowerCase());
                return wanted.some((w) => rowTags.includes(w));
            });
        }

        return rows.slice(0, limit);
    };

    const andHits = runMatch(andQuery);
    if (andHits.length > 0 || tokens.length === 1) {
        return andHits;
    }
    return runMatch(orQuery);
}
