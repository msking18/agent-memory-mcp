import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getGlobalDbPath } from "./paths.js";

/** @type {Map<string, DatabaseSync>} */
const dbCache = new Map();

export const SCHEMA_VERSION = "3";

const GLOBAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS global_memories (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'pattern',
    tags_json TEXT NOT NULL DEFAULT '[]',
    tech_stack TEXT NOT NULL DEFAULT 'general',
    source_project TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_global_cat_stack_updated
    ON global_memories(category, tech_stack, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS global_memories_fts USING fts5(
    id UNINDEXED,
    title,
    tags_text,
    tech_stack,
    summary,
    tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS token_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    project_path TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens_raw INTEGER NOT NULL,
    output_tokens_budgeted INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_token_audit_time
    ON token_audit_log(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_token_audit_tool
    ON token_audit_log(tool_name, timestamp DESC);
`;

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

    // Idempotent migration for dead_ends taxonomy and status
    const existingCols = db.prepare("PRAGMA table_info(dead_ends)").all().map((c) => c.name);
    if (!existingCols.includes("kind")) {
        db.exec("ALTER TABLE dead_ends ADD COLUMN kind TEXT NOT NULL DEFAULT 'error_loop'");
    }
    if (!existingCols.includes("constraints_json")) {
        db.exec("ALTER TABLE dead_ends ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!existingCols.includes("status")) {
        db.exec("ALTER TABLE dead_ends ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
    if (!existingCols.includes("reopened_reason")) {
        db.exec("ALTER TABLE dead_ends ADD COLUMN reopened_reason TEXT");
    }
    if (!existingCols.includes("updated_at")) {
        db.exec("ALTER TABLE dead_ends ADD COLUMN updated_at TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_dead_ends_kind_status ON dead_ends(kind, status, created_at DESC)");
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
export function openGlobalDatabase({ cache = true } = {}) {
    const globalPath = path.resolve(getGlobalDbPath());
    if (cache && dbCache.has(globalPath)) {
        return dbCache.get(globalPath);
    }
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    const db = new DatabaseSync(globalPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
    `);
    db.exec(GLOBAL_SCHEMA_SQL);
    if (cache) {
        dbCache.set(globalPath, db);
    }
    return db;
}

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


export function syncGlobalMemoryFts(db, entry) {
    db.prepare("DELETE FROM global_memories_fts WHERE id = ?").run(entry.id);
    const tags = Array.isArray(entry.tags) ? entry.tags : safeJsonArray(entry.tags_json);
    db.prepare(`
        INSERT INTO global_memories_fts (id, title, tags_text, tech_stack, summary)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        entry.id,
        entry.title || "",
        tags.join(" "),
        entry.tech_stack || "general",
        entry.summary || ""
    );
}

export function removeGlobalMemoryFts(db, id) {
    db.prepare("DELETE FROM global_memories_fts WHERE id = ?").run(id);
}

export function searchGlobalFts(
    db,
    rawQuery,
    { category = null, tech_stack = null, limit = 10 } = {}
) {
    const { tokens, andQuery, orQuery } = buildFtsQueries(rawQuery);
    if (tokens.length === 0) {
        let sql = `SELECT * FROM global_memories WHERE 1=1`;
        const params = [];
        if (category) {
            sql += ` AND category = ?`;
            params.push(category);
        }
        if (tech_stack) {
            sql += ` AND (tech_stack = ? OR tech_stack = 'general')`;
            params.push(tech_stack);
        }
        sql += ` ORDER BY updated_at DESC LIMIT ?`;
        params.push(limit);
        return db.prepare(sql).all(...params).map((r) => ({
            ...r,
            tags: safeJsonArray(r.tags_json)
        }));
    }

    const runMatch = (matchExpr) => {
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
                bm25(global_memories_fts, 0.0, 5.0, 4.0, 2.0, 1.0) AS rank_score,
                snippet(global_memories_fts, 4, '[', ']', '...', 24) AS match_snippet
            FROM global_memories_fts
            JOIN global_memories g ON g.id = global_memories_fts.id
            WHERE global_memories_fts MATCH ?
        `;
        const params = [matchExpr];
        if (category) {
            sql += ` AND g.category = ?`;
            params.push(category);
        }
        if (tech_stack) {
            sql += ` AND (g.tech_stack = ? OR g.tech_stack = 'general')`;
            params.push(tech_stack);
        }
        sql += ` ORDER BY rank_score ASC, g.updated_at DESC LIMIT ?`;
        params.push(limit);

        return db.prepare(sql).all(...params).map((r) => ({
            ...r,
            tags: safeJsonArray(r.tags_json)
        }));
    };

    const andHits = runMatch(andQuery);
    if (andHits.length > 0 || tokens.length === 1) {
        return andHits;
    }
    return runMatch(orQuery);
}

export function logTokenAudit(db, entry, maxEntries = 2000) {
    db.prepare(`
        INSERT INTO token_audit_log (timestamp, tool_name, project_path, input_tokens, output_tokens_raw, output_tokens_budgeted, truncated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        entry.timestamp || new Date().toISOString(),
        entry.tool_name,
        entry.project_path || null,
        entry.input_tokens || 0,
        entry.output_tokens_raw || 0,
        entry.output_tokens_budgeted || 0,
        entry.truncated ? 1 : 0
    );

    const countRow = db.prepare("SELECT COUNT(*) AS total FROM token_audit_log").get();
    if (countRow && countRow.total > maxEntries) {
        const excess = countRow.total - maxEntries;
        db.prepare(`
            DELETE FROM token_audit_log
            WHERE id IN (
                SELECT id FROM token_audit_log ORDER BY id ASC LIMIT ?
            )
        `).run(excess);
    }
}

export function queryTokenMetrics(db, { timeframeHours = 24, limit = 50 } = {}) {
    const cutoff = new Date(Date.now() - timeframeHours * 3600 * 1000).toISOString();
    const statsRow = db.prepare(`
        SELECT
            COUNT(*) AS total_calls,
            SUM(input_tokens) AS total_input_tokens,
            SUM(output_tokens_raw) AS total_output_tokens_raw,
            SUM(output_tokens_budgeted) AS total_output_tokens_budgeted,
            SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END) AS truncated_calls
        FROM token_audit_log
        WHERE timestamp >= ?
    `).get(cutoff) || {};

    const toolBreakdown = db.prepare(`
        SELECT
            tool_name,
            COUNT(*) AS call_count,
            SUM(output_tokens_budgeted) AS tokens_consumed,
            SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END) AS truncated_count
        FROM token_audit_log
        WHERE timestamp >= ?
        GROUP BY tool_name
        ORDER BY tokens_consumed DESC
    `).all(cutoff);

    const recentLogs = db.prepare(`
        SELECT id, timestamp, tool_name, project_path, input_tokens, output_tokens_raw, output_tokens_budgeted, truncated
        FROM token_audit_log
        WHERE timestamp >= ?
        ORDER BY id DESC
        LIMIT ?
    `).all(cutoff, limit);

    const totalRaw = Number(statsRow.total_output_tokens_raw || 0);
    const totalBudgeted = Number(statsRow.total_output_tokens_budgeted || 0);
    const tokensSaved = Math.max(0, totalRaw - totalBudgeted);

    return {
        timeframe_hours: timeframeHours,
        total_calls: Number(statsRow.total_calls || 0),
        total_input_tokens: Number(statsRow.total_input_tokens || 0),
        total_output_tokens_raw: totalRaw,
        total_output_tokens_budgeted: totalBudgeted,
        tokens_saved: tokensSaved,
        truncated_calls: Number(statsRow.truncated_calls || 0),
        tool_breakdown: toolBreakdown.map((b) => ({
            tool_name: b.tool_name,
            call_count: Number(b.call_count),
            tokens_consumed: Number(b.tokens_consumed),
            truncated_count: Number(b.truncated_count)
        })),
        recent_logs: recentLogs
    };
}
