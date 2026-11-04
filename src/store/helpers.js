/**
 * @file src/store/helpers.js
 * @description Pure helper utilities, tag/file cleaners, slug inference, and store preparation.
 * Provides validation routines, disk staleness checkers, and migration banner formatting.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
    getProjectStoreInfo,
    registerProjectInIndex,
    normalizeWorkspaceRelativePath
} from "../paths.js";
import { openDatabase } from "../db/index.js";
import { ensureMigratedIfLegacyExists } from "../migrate/index.js";

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
 * @returns {Array<string>} Normalized relative file paths.
 */
export function cleanFiles(canonicalProjectPath, files) {
    if (!Array.isArray(files)) return [];
    const seen = new Set();
    const out = [];
    for (const f of files) {
        const rel = normalizeWorkspaceRelativePath(canonicalProjectPath, f);
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
 * Prepares store info, runs transparent JIT migration if legacy `.ag-memory.json` exists,
 * and opens the SQLite database (or skips creating an empty DB on read-only checks).
 *
 * @param {string} projectPath - Target project directory path.
 * @param {Object} [options] - Options.
 * @param {boolean} [options.createIfMissing=true] - If false, does not create empty DB on disk.
 * @returns {{ storeInfo: Object, migration: Object, db: import("node:sqlite").DatabaseSync|null }}
 */
export function prepareStore(projectPath, { createIfMissing = true } = {}) {
    const storeInfo = getProjectStoreInfo(projectPath);
    const migration = ensureMigratedIfLegacyExists(storeInfo);

    if (!createIfMissing && !fs.existsSync(storeInfo.dbPath)) {
        return { storeInfo, migration, db: null };
    }

    const db = openDatabase(storeInfo.dbPath);
    registerProjectInIndex(storeInfo);
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
 * Inspects referenced workspace files on disk to detect whether files have been modified
 * after the memory note was saved (providing staleness warnings to the agent).
 *
 * @param {string} canonicalProjectPath - Workspace root directory.
 * @param {Array<string>} files - Relative file paths referenced by memory node.
 * @param {string} updatedAtIso - ISO-8601 timestamp of last memory update.
 * @returns {{ staleFiles: Array<string>, missingFiles: Array<string> }}
 */
export function checkEntryFileStaleness(canonicalProjectPath, files, updatedAtIso) {
    if (!Array.isArray(files) || files.length === 0) return { staleFiles: [], missingFiles: [] };
    const updatedMs = Date.parse(updatedAtIso) || 0;
    const staleFiles = [];
    const missingFiles = [];

    for (const rel of files) {
        if (rel.startsWith("..")) continue;
        const abs = path.join(canonicalProjectPath, rel);
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
    return { staleFiles, missingFiles };
}
