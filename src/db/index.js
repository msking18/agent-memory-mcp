/**
 * @file src/db/index.js
 * @description SQLite database connection manager and schema migrator.
 * Manages cached WAL-mode connections to per-project SQLite stores and the
 * centralized machine-wide global database (`global.db`) using native Node.js `node:sqlite`.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCHEMA_SQL, GLOBAL_SCHEMA_SQL } from "./schema.js";
import { getGlobalDbPath } from "../paths.js";

export * from "./schema.js";
export * from "./fts.js";

/** @type {Map<string, import("node:sqlite").DatabaseSync>} */
const dbConnections = new Map();

/**
 * Idempotently migrates the `dead_ends` table in a project database to ensure
 * taxonomy columns (`kind`, `constraints_json`, `status`, `reopened_reason`, `updated_at`) exist.
 *
 * @param {import("node:sqlite").DatabaseSync} db - Active database connection.
 */
function migrateDeadEndsTable(db) {
    try {
        const columns = db.prepare(`PRAGMA table_info(dead_ends)`).all();
        const colNames = new Set(columns.map((c) => c.name));

        if (!colNames.has("kind")) {
            db.exec(`ALTER TABLE dead_ends ADD COLUMN kind TEXT NOT NULL DEFAULT 'error_loop'`);
        }
        if (!colNames.has("constraints_json")) {
            db.exec(`ALTER TABLE dead_ends ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]'`);
        }
        if (!colNames.has("status")) {
            db.exec(`ALTER TABLE dead_ends ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
        }
        if (!colNames.has("reopened_reason")) {
            db.exec(`ALTER TABLE dead_ends ADD COLUMN reopened_reason TEXT`);
        }
        if (!colNames.has("updated_at")) {
            db.exec(`ALTER TABLE dead_ends ADD COLUMN updated_at TEXT`);
            db.exec(`UPDATE dead_ends SET updated_at = created_at WHERE updated_at IS NULL`);
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_dead_ends_kind ON dead_ends(kind)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_dead_ends_status ON dead_ends(status)`);

        const memCols = db.prepare(`PRAGMA table_info(memories)`).all();
        const memColNames = new Set(memCols.map((c) => c.name));
        if (!memColNames.has("superseded_by")) {
            db.exec(`ALTER TABLE memories ADD COLUMN superseded_by TEXT`);
        }
    } catch {
        // Table might not exist yet; SCHEMA_SQL creates it with the complete definition.
    }
}

/**
 * Opens or retrieves a cached SQLite database connection for a project store.
 * Automatically runs DDL schema migrations, enables WAL mode, and verifies table structure.
 *
 * @param {string} dbFilePath - Absolute file path to the project `.db` file.
 * @returns {import("node:sqlite").DatabaseSync} Active SQLite database connection.
 */
export function openDatabase(dbFilePath) {
    const normalizedPath = path.resolve(dbFilePath);
    if (dbConnections.has(normalizedPath)) {
        return dbConnections.get(normalizedPath);
    }

    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });

    const db = new DatabaseSync(normalizedPath);
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`PRAGMA synchronous = NORMAL;`);
    db.exec(`PRAGMA foreign_keys = ON;`);
    db.exec(SCHEMA_SQL);
    migrateDeadEndsTable(db);

    dbConnections.set(normalizedPath, db);
    return db;
}

/**
 * Opens or retrieves the cached SQLite connection for the centralized global knowledge graph (`global.db`).
 *
 * @returns {import("node:sqlite").DatabaseSync} Active SQLite database connection to `global.db`.
 */
export function openGlobalDatabase() {
    const globalDbPath = getGlobalDbPath();
    if (dbConnections.has(globalDbPath)) {
        return dbConnections.get(globalDbPath);
    }

    fs.mkdirSync(path.dirname(globalDbPath), { recursive: true });

    const db = new DatabaseSync(globalDbPath);
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`PRAGMA synchronous = NORMAL;`);
    db.exec(GLOBAL_SCHEMA_SQL);

    dbConnections.set(globalDbPath, db);
    return db;
}

/**
 * Closes all open SQLite database connections and clears the connection pool.
 * Typically invoked during test suite teardown and process exit.
 */
export function closeAllDatabases() {
    for (const [filePath, db] of dbConnections.entries()) {
        try {
            db.close();
        } catch {
            // Ignore close errors during process teardown
        }
    }
    dbConnections.clear();
}

/**
 * Records an entry in the centralized `token_audit_log` table in `global.db`.
 * Supports both direct (db, entry, maxEntries) and ({ tool_name, ... }) signatures.
 *
 * @param {import("node:sqlite").DatabaseSync|Object} dbOrEntry - Database connection or entry object.
 * @param {Object} [entry] - Audit log entry if db is provided.
 * @param {number} [maxEntries=2000] - Maximum audit records to retain.
 */
export function logTokenAudit(dbOrEntry, entry, maxEntries = 2000) {
    try {
        let db;
        let data;
        let max = maxEntries;

        if (dbOrEntry && typeof dbOrEntry.prepare === "function") {
            db = dbOrEntry;
            data = entry || {};
        } else {
            db = openGlobalDatabase();
            data = dbOrEntry || {};
            if (typeof entry === "number") max = entry;
        }

        db.prepare(`
            INSERT INTO token_audit_log (timestamp, tool_name, project_path, input_tokens, output_tokens_raw, output_tokens_budgeted, truncated)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.timestamp || new Date().toISOString(),
            data.tool_name || data.toolName,
            data.project_path || data.projectPath || null,
            data.input_tokens || data.inputTokens || 0,
            data.output_tokens_raw || data.rawTokens || 0,
            data.output_tokens_budgeted || data.cappedTokens || 0,
            data.truncated ? 1 : 0
        );

        const countRow = db.prepare("SELECT COUNT(*) AS total FROM token_audit_log").get();
        if (countRow && countRow.total > max) {
            const excess = countRow.total - max;
            db.prepare(`
                DELETE FROM token_audit_log
                WHERE id IN (
                    SELECT id FROM token_audit_log ORDER BY id ASC LIMIT ?
                )
            `).run(excess);
        }
    } catch {
        // Logging should never crash tool execution
    }
}

/**
 * Queries aggregate token savings and recent audit log events from `global.db`.
 * Supports both (db, options) and (options) signatures.
 *
 * @param {import("node:sqlite").DatabaseSync|Object} [dbOrOptions] - Database connection or options.
 * @param {Object} [options] - Query options.
 * @returns {Object} Token metrics and breakdown.
 */
export function queryTokenMetrics(dbOrOptions, options = {}) {
    let db;
    let opts;
    if (dbOrOptions && typeof dbOrOptions.prepare === "function") {
        db = dbOrOptions;
        opts = options || {};
    } else {
        db = openGlobalDatabase();
        opts = dbOrOptions || {};
    }

    const timeframeHours = typeof opts.timeframeHours === "number" ? opts.timeframeHours : (opts.timeframe_hours || 24);
    const limit = typeof opts.limit === "number" ? opts.limit : 50;
    const cutoff = new Date(Date.now() - timeframeHours * 3600 * 1000).toISOString();

    const statsRow = db.prepare(`
        SELECT
            COUNT(*) AS total_calls,
            COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(output_tokens_raw), 0) AS total_output_tokens_raw,
            COALESCE(SUM(output_tokens_budgeted), 0) AS total_output_tokens_budgeted,
            COALESCE(SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END), 0) AS truncated_calls
        FROM token_audit_log
        WHERE timestamp >= ?
    `).get(cutoff) || {};

    const toolBreakdown = db.prepare(`
        SELECT
            tool_name,
            COUNT(*) AS call_count,
            COALESCE(SUM(output_tokens_budgeted), 0) AS tokens_consumed,
            COALESCE(SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END), 0) AS truncated_count
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
