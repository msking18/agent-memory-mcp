/**
 * @file src/store/dead-ends.js
 * @description Two-tier dead-end registry and anti-loop circuit breaker.
 * Implements recording, matching, constraint tracking, and reopening for both
 * code/test debugging errors (`error_loop`) and deliberate architectural trade-offs (`architectural`).
 */

import { normalizeWorkspaceRelativePath } from "../paths.js";
import {
    cleanFiles,
    formatMigrationBanner,
    generateUniqueId,
    prepareStore
} from "./helpers.js";

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
 * Records a failed debugging attempt or intentional architectural constraint in the dead-end registry.
 *
 * @param {string} projectPath - Target workspace root directory.
 * @param {Object} args - Arguments.
 * @param {string} args.error_pattern - Compiler error, test failure, or symptom.
 * @param {string} args.attempted_solution - What was tried and failed.
 * @param {string} args.root_cause - Why it failed or constraint discovered.
 * @param {Array<string>} [args.files=[]] - Workspace-relative files involved.
 * @param {"error_loop"|"architectural"} [args.kind="error_loop"] - Taxonomy classification.
 * @param {Array<string>} [args.constraints=[]] - Active invariants or constraints forbidding this approach.
 * @returns {{ id: string, kind: string, text: string }} Confirmation record.
 */
export function recordDeadEnd(
    projectPath,
    {
        error_pattern,
        attempted_solution,
        root_cause,
        files = [],
        kind = "error_loop",
        constraints = []
    } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: true });
    const banner = formatMigrationBanner(migration);

    if (!error_pattern?.trim() || !attempted_solution?.trim() || !root_cause?.trim()) {
        throw new Error(
            "record_dead_end requires non-empty error_pattern, attempted_solution, and root_cause."
        );
    }

    const cleanedFiles = cleanFiles(storeInfo.canonicalPath, files);
    const validKind = kind === "architectural" ? "architectural" : "error_loop";
    const cleanConstraints = Array.isArray(constraints)
        ? constraints.map((c) => String(c ?? "").trim()).filter(Boolean)
        : [];
    const now = new Date().toISOString();
    let id;

    withTransaction(db, () => {
        id = generateUniqueId(db, "dead_ends", "de-");
        db.prepare(`
            INSERT INTO dead_ends (
                id, error_pattern, attempted_solution, root_cause, files_json,
                created_at, kind, constraints_json, status, reopened_reason, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)
        `).run(
            id,
            error_pattern.trim(),
            attempted_solution.trim(),
            root_cause.trim(),
            JSON.stringify(cleanedFiles),
            now,
            validKind,
            JSON.stringify(cleanConstraints),
            now
        );
    });

    const isArch = validKind === "architectural";
    const kindHeader = isArch ? "ARCHITECTURAL CONSTRAINT RECORDED" : "ANTI-LOOP DEAD-END RECORDED";
    const constraintLines =
        cleanConstraints.length > 0
            ? `\nActive Constraints: ${cleanConstraints.join(", ")}`
            : "";

    return {
        id,
        kind: validKind,
        text:
            banner +
            `[${kindHeader}] [ID: ${id}]\n` +
            (isArch ? `Recorded active architectural constraint for workspace.\n` : "") +
            `Pattern: ${error_pattern.trim()}\n` +
            `Attempted Fix: ${attempted_solution.trim()}\n` +
            `Root Cause / Reason: ${root_cause.trim()}` +
            constraintLines +
            (cleanedFiles.length > 0 ? `\nFiles: ${cleanedFiles.join(", ")}` : "") +
            `\nFuture turns will check this registry to prevent repeating this failure.`
    };
}

/**
 * Checks the anti-loop dead-end registry by error text, keyword, or file path before attempting fixes.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} [args] - Search arguments.
 * @param {string} [args.query] - Error message or keyword to match.
 * @param {string} [args.file_path] - Workspace-relative or absolute file path to check.
 * @param {number} [args.limit=10] - Maximum records to return.
 * @param {"all"|"error_loop"|"architectural"} [args.kind="all"] - Taxonomy filter.
 * @returns {{ matches: Array<Object>, text: string }} Matching dead-end records.
 */
export function checkDeadEnds(projectPath, { query, file_path, limit = 10, kind = "all" } = {}) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return {
            matches: [],
            text: banner + "Project memory is uninitialized. No anti-loop dead-ends recorded."
        };
    }

    let sql = "SELECT * FROM dead_ends WHERE status = 'active'";
    const params = [];

    if (kind && kind !== "all") {
        sql += " AND kind = ?";
        params.push(kind);
    }

    sql += " ORDER BY created_at DESC LIMIT 100";
    const allRows = db.prepare(sql).all(...params);

    const queryTerms = typeof query === "string" && query.trim()
        ? query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
        : [];
    const normalizedTargetFile = file_path
        ? normalizeWorkspaceRelativePath(storeInfo.canonicalPath, file_path)
        : null;

    const matches = [];

    for (const row of allRows) {
        const rowFiles = safeJsonArray(row.files_json);
        const rowConstraints = safeJsonArray(row.constraints_json);

        let matchesFile = false;
        if (normalizedTargetFile) {
            matchesFile = rowFiles.some((f) => {
                const fNorm = f.replace(/\\/g, "/").toLowerCase();
                const targetNorm = normalizedTargetFile.replace(/\\/g, "/").toLowerCase();
                return fNorm === targetNorm || targetNorm.endsWith(fNorm) || fNorm.endsWith(targetNorm);
            });
        }

        let matchesQuery = false;
        if (queryTerms.length > 0) {
            const haystack = `${row.error_pattern} ${row.attempted_solution} ${row.root_cause} ${rowConstraints.join(" ")}`.toLowerCase();
            matchesQuery = queryTerms.some((t) => haystack.includes(t));
        }

        if (
            (!queryTerms.length && !normalizedTargetFile) ||
            matchesFile ||
            matchesQuery
        ) {
            matches.push({
                id: row.id,
                error_pattern: row.error_pattern,
                attempted_solution: row.attempted_solution,
                root_cause: row.root_cause,
                files: rowFiles,
                kind: row.kind || "error_loop",
                constraints: rowConstraints,
                created_at: row.created_at
            });
            if (matches.length >= limit) break;
        }
    }

    if (matches.length === 0) {
        return {
            matches: [],
            text: banner + "No matching anti-loop dead-ends or architectural constraints found."
        };
    }

    const lines = matches.map((de) => {
        const filesLine = de.files?.length ? `\n  Files: ${de.files.join(", ")}` : "";
        const constrLine = de.constraints?.length ? `\n  Active Constraints: ${de.constraints.join(", ")}` : "";
        if (de.kind === "architectural") {
            return `[ARCHITECTURAL CONSTRAINT / TRADE-OFF] [ID: ${de.id}] (${de.created_at.slice(0, 10)}) Topic: ${de.error_pattern}\n  Rejected Approach: ${de.attempted_solution}\n  Rationale: ${de.root_cause}${constrLine}${filesLine}`;
        }
        return `[DEAD-END ERROR LOOP] [ID: ${de.id}] (${de.created_at.slice(0, 10)}) Error: ${de.error_pattern}\n  DO NOT REPEAT: ${de.attempted_solution}\n  Root Cause: ${de.root_cause}${filesLine}`;
    });

    return {
        matches,
        text: banner + `Recorded Active Anti-Loop Dead-Ends (${matches.length}):\n\n` + lines.join("\n\n")
    };
}

/**
 * Reopens a previously recorded dead-end with a justification when external constraints change.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} args - Arguments.
 * @param {string} args.id - Dead-end ID to reopen.
 * @param {string} args.reason - Justification explaining why this approach is viable now.
 * @returns {{ isError: boolean, id?: string, text: string }} Status result.
 */
export function reopenDeadEnd(projectPath, { id, reason } = {}) {
    if (!id || typeof id !== "string" || !id.trim()) {
        return { isError: true, text: "Error: 'id' is required to reopen a dead-end." };
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
        return { isError: true, text: "Error: 'reason' is required to reopen a dead-end." };
    }

    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { isError: true, text: banner + "Error: Project memory is uninitialized." };
    }

    const cleanId = id.trim();
    const cleanReason = reason.trim();
    const existing = db.prepare("SELECT * FROM dead_ends WHERE id = ?").get(cleanId);

    if (!existing) {
        return { isError: true, text: banner + `Error: Dead-end "${cleanId}" not found.` };
    }

    const now = new Date().toISOString();
    db.prepare(`
        UPDATE dead_ends
        SET status = 'reopened', reopened_reason = ?, updated_at = ?
        WHERE id = ?
    `).run(cleanReason, now, cleanId);

    return {
        isError: false,
        id: cleanId,
        text:
            banner +
            `Reopened dead-end [${cleanId}] ("${existing.error_pattern}"). Reason: "${cleanReason}". It will no longer block future attempts.`
    };
}
