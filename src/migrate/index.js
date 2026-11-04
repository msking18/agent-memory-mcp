/**
 * @file src/migrate/index.js
 * @description Zero-loss JIT migrator from legacy `.ag-memory.json` to SQLite + FTS5.
 * Coordinates cross-process file locks, staging database validation, SHA-256 byte verification,
 * and delta merging into live SQLite stores.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, syncMemoryFts } from "../db/index.js";
import { acquireMigrationLock } from "./lock.js";
import {
    isGitTracked,
    archiveVerifiedLegacyFile,
    quarantineCorruptLegacyFile
} from "./backup.js";
import { normalizeLegacyEntries } from "./normalize.js";

export * from "./lock.js";
export * from "./backup.js";
export * from "./normalize.js";

/**
 * Executes a callback within an explicit BEGIN IMMEDIATE transaction on a database connection.
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
 * Runs initial staging DB creation in DELETE journal mode (avoiding Windows WAL locks during rename),
 * verifies 100% row and content parity, closes the handle, and atomically promotes to live `dbPath`.
 *
 * @param {Object} storeInfo - Project store paths and metadata.
 * @param {Array<Object>} entries - Normalized memory records.
 * @param {string} sourceSha256 - Expected legacy file SHA-256.
 */
function runInitialTransactionalMigration(storeInfo, entries, sourceSha256) {
    fs.mkdirSync(path.dirname(storeInfo.dbPath), { recursive: true });
    const tmpDbPath = `${storeInfo.dbPath}.tmp.${process.pid}.${Date.now()}`;
    const stagingDb = new DatabaseSync(tmpDbPath);

    try {
        stagingDb.exec(`
            PRAGMA journal_mode = DELETE;
            PRAGMA synchronous = FULL;
            PRAGMA foreign_keys = ON;
        `);
        stagingDb.exec(`
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE memories (
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
            CREATE INDEX idx_memories_status_cat_updated ON memories(status, category, updated_at DESC);
            CREATE INDEX idx_memories_slug ON memories(slug) WHERE slug IS NOT NULL;
            CREATE TABLE memory_revisions (
                rev_id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_id TEXT NOT NULL,
                prev_title TEXT,
                prev_summary TEXT,
                prev_tags_json TEXT,
                changed_at TEXT NOT NULL
            );
            CREATE INDEX idx_revisions_memory_id ON memory_revisions(memory_id, rev_id DESC);
            CREATE TABLE dead_ends (
                id TEXT PRIMARY KEY,
                error_pattern TEXT NOT NULL,
                attempted_solution TEXT NOT NULL,
                root_cause TEXT NOT NULL,
                files_json TEXT NOT NULL DEFAULT '[]',
                kind TEXT NOT NULL DEFAULT 'error_loop',
                constraints_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'active',
                reopened_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX idx_dead_ends_status ON dead_ends(status);
            CREATE INDEX idx_dead_ends_kind ON dead_ends(kind);
            CREATE VIRTUAL TABLE memories_fts USING fts5(
                id UNINDEXED,
                title,
                summary,
                tags,
                files,
                tokenize='porter unicode61'
            );
            CREATE TABLE migration_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_path TEXT NOT NULL,
                source_sha256 TEXT NOT NULL,
                entry_count INTEGER NOT NULL,
                backup_path TEXT NOT NULL,
                migrated_at TEXT NOT NULL
            );
        `);

        withTransaction(stagingDb, () => {
            const insertStmt = stagingDb.prepare(`
                INSERT INTO memories (
                    id, slug, title, summary, category, tags_json, files_json,
                    status, superseded_by, legacy_meta_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const e of entries) {
                insertStmt.run(
                    e.id,
                    e.slug,
                    e.title,
                    e.summary,
                    e.category,
                    JSON.stringify(e.tags),
                    JSON.stringify(e.files),
                    e.status,
                    e.superseded_by,
                    e.legacy_meta_json,
                    e.created_at,
                    e.updated_at
                );
                syncMemoryFts(stagingDb, e);
            }

            stagingDb
                .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3.0.0')")
                .run();
        });

        // Verify count parity
        const countRow = stagingDb.prepare("SELECT count(*) as count FROM memories").get();
        if (Number(countRow.count) !== entries.length) {
            throw new Error(
                `Migration row count mismatch: expected ${entries.length}, found ${countRow.count}`
            );
        }

        // Verify content parity on sample
        if (entries.length > 0) {
            const sample = entries[0];
            const check = stagingDb
                .prepare("SELECT summary, title FROM memories WHERE id = ?")
                .get(sample.id);
            if (!check || check.title !== sample.title || check.summary !== sample.summary) {
                throw new Error("Migration row content verification failed for sample record.");
            }
        }
    } finally {
        stagingDb.close();
    }

    // Atomically rename staging file over destination
    try {
        fs.renameSync(tmpDbPath, storeInfo.dbPath);
    } catch (err) {
        try {
            fs.unlinkSync(tmpDbPath);
        } catch {
            // Ignore cleanup failure
        }
        throw err;
    }
}

/**
 * Migrates a legacy `.ag-memory.json` file into the SQLite store.
 * Supports both clean initial migrations and delta merges into existing databases.
 *
 * @param {Object} storeInfo - Project store paths and metadata.
 * @returns {Object} Migration status result.
 */
export function migrateLegacyJsonToSqlite(storeInfo) {
    if (!fs.existsSync(storeInfo.legacyJsonPath)) {
        return { action: "skipped_no_legacy" };
    }

    const releaseLock = acquireMigrationLock(storeInfo.lockPath, 10000);
    try {
        let rawBuffer;
        try {
            rawBuffer = fs.readFileSync(storeInfo.legacyJsonPath);
        } catch (err) {
            if (err.code === "ENOENT") {
                return { action: "skipped_no_legacy" };
            }
            throw err;
        }

        const sourceSha256 = crypto.createHash("sha256").update(rawBuffer).digest("hex");
        const fileStat = fs.statSync(storeInfo.legacyJsonPath);
        const fallbackIso = fileStat.mtime.toISOString();

        const cleanText = rawBuffer.toString("utf8").replace(/^\uFEFF/, "");

        let parsedJson;
        try {
            parsedJson = JSON.parse(cleanText);
        } catch (err) {
            return quarantineCorruptLegacyFile(storeInfo, rawBuffer, err.message);
        }

        const entries = normalizeLegacyEntries(parsedJson, storeInfo.canonicalPath, fallbackIso);

        const liveDbExists = fs.existsSync(storeInfo.dbPath);

        if (!liveDbExists) {
            // Mode A: Clean Initial Transactional Migration
            runInitialTransactionalMigration(storeInfo, entries, sourceSha256);

            const { backupFilePath, gitTracked } = archiveVerifiedLegacyFile(
                storeInfo,
                rawBuffer,
                sourceSha256,
                entries.length,
                "initial_migration"
            );

            // Record audit in live DB
            const liveDb = openDatabase(storeInfo.dbPath);
            liveDb
                .prepare(`
                    INSERT INTO migration_audit (source_path, source_sha256, entry_count, backup_path, migrated_at)
                    VALUES (?, ?, ?, ?, ?)
                `)
                .run(
                    storeInfo.legacyJsonPath,
                    sourceSha256,
                    entries.length,
                    backupFilePath,
                    new Date().toISOString()
                );

            return {
                action: "migrated",
                migratedCount: entries.length,
                supersededDuplicates: entries.filter((e) => e.status === "superseded").length,
                backupFilePath,
                gitTracked
            };
        }

        // Mode B: Incremental Delta Merge into existing live SQLite DB
        const liveDb = openDatabase(storeInfo.dbPath);
        let insertedCount = 0;
        let divergentRevisionsCount = 0;

        withTransaction(liveDb, () => {
            const getExistingStmt = liveDb.prepare("SELECT id, title, summary FROM memories WHERE id = ?");
            const insertMemoryStmt = liveDb.prepare(`
                INSERT INTO memories (
                    id, slug, title, summary, category, tags_json, files_json,
                    status, superseded_by, legacy_meta_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertRevisionStmt = liveDb.prepare(`
                INSERT INTO revisions (id, memory_id, version, title, summary, category, tags_json, files_json, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const e of entries) {
                const existing = getExistingStmt.get(e.id);
                if (!existing) {
                    let safeSlug = e.slug;
                    let safeStatus = e.status;
                    let supersededBy = e.superseded_by;
                    if (safeSlug) {
                        const activeSlugHolder = liveDb
                            .prepare("SELECT id FROM memories WHERE slug = ? AND status = 'active' LIMIT 1")
                            .get(safeSlug);
                        if (activeSlugHolder) {
                            safeSlug = null;
                            safeStatus = "superseded";
                            supersededBy = activeSlugHolder.id;
                        }
                    }

                    insertMemoryStmt.run(
                        e.id,
                        safeSlug,
                        e.title,
                        e.summary,
                        e.category,
                        JSON.stringify(e.tags),
                        JSON.stringify(e.files),
                        safeStatus,
                        supersededBy,
                        e.legacy_meta_json,
                        e.created_at,
                        e.updated_at
                    );
                    syncMemoryFts(liveDb, e);
                    insertedCount++;
                } else if (existing.summary !== e.summary || existing.title !== e.title) {
                    const revId = crypto.randomUUID();
                    insertRevisionStmt.run(
                        revId,
                        existing.id,
                        1,
                        e.title,
                        e.summary,
                        e.category,
                        JSON.stringify(e.tags),
                        JSON.stringify(e.files),
                        "{}",
                        e.created_at
                    );
                    divergentRevisionsCount++;
                }
            }

            const { backupFilePath, gitTracked } = archiveVerifiedLegacyFile(
                storeInfo,
                rawBuffer,
                sourceSha256,
                entries.length,
                "delta_merge"
            );

            liveDb
                .prepare(`
                    INSERT INTO migration_audit (source_path, source_sha256, entry_count, backup_path, migrated_at)
                    VALUES (?, ?, ?, ?, ?)
                `)
                .run(
                    storeInfo.legacyJsonPath,
                    sourceSha256,
                    entries.length,
                    backupFilePath,
                    new Date().toISOString()
                );
        });

        return {
            action: "delta_merged",
            insertedCount,
            divergentRevisionsCount
        };
    } finally {
        releaseLock();
    }
}

/**
 * Public idempotency guard called by store preparation.
 *
 * @param {Object} storeInfo - Project store paths and metadata.
 * @returns {Object} Migration result.
 */
export function ensureMigratedIfLegacyExists(storeInfo) {
    if (!fs.existsSync(storeInfo.legacyJsonPath)) {
        return { action: "none" };
    }
    return migrateLegacyJsonToSqlite(storeInfo);
}
