import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
    getProjectStoreInfo,
    registerProjectInIndex,
    normalizeWorkspaceRelativePath
} from "./paths.js";
import {
    openDatabase,
    withTransaction,
    syncMemoryFts,
    removeMemoryFts,
    safeJsonArray,
    searchFts
} from "./db.js";
import { ensureMigratedIfLegacyExists } from "./migrate.js";

const CANONICAL_SLUG_BY_TITLE = new Map([
    ["tech stack & ecosystem", "tech-stack"],
    ["project structure & architecture", "project-structure"],
    ["build & run instructions", "build-run"]
]);

export const VALID_CATEGORIES = ["architecture", "decision", "session", "dead_end", "note"];

export function smartPreview(text, maxLen = 180) {
    if (typeof text !== "string") return "";
    const singleLine = text.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxLen) return singleLine;
    const cut = singleLine.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut) + "...";
}

function cleanTags(tags) {
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

function cleanFiles(canonicalProjectPath, files) {
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

function inferCategoryAndSlugForSave(item) {
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

function generateUniqueId(db, table = "memories", prefix = "") {
    const checkStmt = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
    for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        if (!checkStmt.get(candidate)) return candidate;
    }
    return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Prepares store info, runs transparent JIT migration if legacy .ag-memory.json exists,
 * and opens the SQLite database (or skips creating an empty DB on read-only checks).
 */
function prepareStore(projectPath, { createIfMissing = true } = {}) {
    const storeInfo = getProjectStoreInfo(projectPath);
    const migration = ensureMigratedIfLegacyExists(storeInfo);

    if (!createIfMissing && !fs.existsSync(storeInfo.dbPath)) {
        return { storeInfo, migration, db: null };
    }

    const db = openDatabase(storeInfo.dbPath);
    registerProjectInIndex(storeInfo);
    return { storeInfo, migration, db };
}

function formatMigrationBanner(migration) {
    if (!migration || migration.action === "none") return "";
    if (migration.action === "migrated") {
        return `[MIGRATED v2 -> v3] Imported ${migration.migratedCount} legacy entries into SQLite+FTS5 (backup archived at ${migration.backupFilePath}).\n\n`;
    }
    if (migration.action === "delta_merged") {
        return `[DELTA MERGED] Merged ${migration.insertedCount} new legacy entries (${migration.divergentRevisionsCount} revisions preserved; backup at ${migration.backupFilePath}).\n\n`;
    }
    if (migration.action === "corrupt_quarantined") {
        return `[WARNING] ${migration.warning}\n\n`;
    }
    return "";
}

function checkEntryFileStaleness(canonicalProjectPath, files, updatedAtIso) {
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

/**
 * 1. check_memory_status — 1-Shot Health & Context Hydrator
 */
export function checkMemoryStatus(
    projectPath,
    { include_timeline = true, timeline_limit = 5 } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return {
            initialized: false,
            storeInfo,
            migration,
            text:
                banner +
                `UNINITIALIZED: No project memory found for "${storeInfo.canonicalPath}". You must bootstrap the project memory by saving foundational nodes ("Tech Stack & Ecosystem", "Project Structure & Architecture", "Build & Run Instructions").`
        };
    }

    const categoryRows = db
        .prepare(
            "SELECT category, COUNT(*) AS cnt FROM memories WHERE status = 'active' GROUP BY category"
        )
        .all();
    const countsByCategory = {};
    let totalActive = 0;
    for (const r of categoryRows) {
        countsByCategory[r.category] = Number(r.cnt);
        totalActive += Number(r.cnt);
    }

    const deadEndRow = db.prepare("SELECT COUNT(*) AS cnt FROM dead_ends").get();
    const deadEndCount = Number(deadEndRow?.cnt || 0);

    if (totalActive === 0 && deadEndCount === 0) {
        return {
            initialized: false,
            storeInfo,
            migration,
            text:
                banner +
                `UNINITIALIZED: Memory store exists for "${storeInfo.canonicalPath}" but has 0 active entries. You must bootstrap the project memory.`
        };
    }

    const archNodes = db
        .prepare(`
            SELECT id, slug, title, updated_at
            FROM memories
            WHERE status = 'active' AND category IN ('architecture', 'decision')
            ORDER BY CASE category WHEN 'architecture' THEN 0 ELSE 1 END, updated_at DESC
            LIMIT 15
        `)
        .all();

    const lines = [];
    lines.push(
        `Memory Status: INITIALIZED (${totalActive} active memories, ${deadEndCount} recorded dead-ends)`
    );
    lines.push(`Project: ${storeInfo.canonicalPath}`);

    const catSummary = Object.entries(countsByCategory)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
    if (catSummary) lines.push(`Breakdown: ${catSummary}`);

    if (archNodes.length > 0) {
        lines.push("\nCore Architecture & Decisions Index:");
        for (const n of archNodes) {
            const slugTag = n.slug ? ` [slug: ${n.slug}]` : "";
            lines.push(`- [ID: ${n.id}]${slugTag} ${n.title}`);
        }
    }

    if (deadEndCount > 0) {
        const recentDeadEnds = db
            .prepare(
                "SELECT id, error_pattern, attempted_solution FROM dead_ends ORDER BY created_at DESC LIMIT 3"
            )
            .all();
        lines.push(`\nActive Anti-Loop Dead-Ends (${deadEndCount} total — call check_dead_ends before retrying errors):`);
        for (const de of recentDeadEnds) {
            lines.push(
                `- [ID: ${de.id}] Error: ${smartPreview(de.error_pattern, 80)} -> Avoid: ${smartPreview(de.attempted_solution, 80)}`
            );
        }
    }

    if (include_timeline) {
        const safeLimit = Math.max(1, Math.min(25, Number(timeline_limit) || 5));
        const timelineRows = db
            .prepare(`
                SELECT id, title, summary, category, tags_json, created_at
                FROM memories
                WHERE status = 'active' AND category = 'session'
                ORDER BY created_at DESC
                LIMIT ?
            `)
            .all(safeLimit);

        if (timelineRows.length > 0) {
            lines.push(`\nRecent Session Timeline (Newest ${timelineRows.length}):`);
            for (const row of timelineRows) {
                lines.push(
                    `- [${row.created_at.slice(0, 16).replace("T", " ")}] ${row.title} (ID: ${row.id})\n  Preview: ${smartPreview(row.summary, 150)}`
                );
            }
        } else {
            lines.push("\nRecent Session Timeline: No session logs recorded yet.");
        }
    }

    lines.push(
        "\nUse search_project_memory, get_file_memories, or read_memory_node for full details."
    );

    return {
        initialized: true,
        storeInfo,
        migration,
        totalActive,
        countsByCategory,
        deadEndCount,
        archNodes,
        text: banner + lines.join("\n")
    };
}

/**
 * 2. get_session_timeline — Filtered Chronological Feed
 */
export function getSessionTimeline(
    projectPath,
    { limit = 5, category = "session", tag = null, since = null } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { entries: [], text: banner + "No timeline history found (project memory uninitialized)." };
    }

    const safeLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 5)));
    const whereClauses = ["status = 'active'"];
    const params = [];

    if (category && category !== "all") {
        whereClauses.push("category = ?");
        params.push(category);
    }
    if (since && !Number.isNaN(Date.parse(since))) {
        whereClauses.push("created_at >= ?");
        params.push(new Date(Date.parse(since)).toISOString());
    }

    const fetchLimit = tag ? Math.max(safeLimit * 4, 40) : safeLimit;
    const rows = db
        .prepare(`
            SELECT id, title, summary, category, tags_json, files_json, created_at, updated_at
            FROM memories
            WHERE ${whereClauses.join(" AND ")}
            ORDER BY created_at DESC
            LIMIT ?
        `)
        .all(...params, fetchLimit)
        .map((r) => ({
            ...r,
            tags: safeJsonArray(r.tags_json),
            files: safeJsonArray(r.files_json)
        }));

    let filtered = rows;
    if (tag && String(tag).trim()) {
        const needle = String(tag).trim().toLowerCase();
        filtered = rows.filter((r) => r.tags.some((t) => t.toLowerCase() === needle));
    }
    filtered = filtered.slice(0, safeLimit);

    if (filtered.length === 0) {
        const fallbackHint =
            category === "session"
                ? ' (Tip: pass category="all" to include architecture and note entries.)'
                : "";
        return {
            entries: [],
            text: banner + `No timeline history found for filter [category=${category}].${fallbackHint}`
        };
    }

    const formatted = filtered.map((e) => {
        const tagBadge = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
        const filesBadge = e.files.length > 0 ? `\n  Files: ${e.files.slice(0, 5).join(", ")}` : "";
        return `[${e.created_at}] (${e.category}) ${e.title} (ID: ${e.id})${tagBadge}\n  Preview: ${smartPreview(e.summary, 160)}${filesBadge}`;
    });

    return {
        entries: filtered,
        storeInfo,
        text:
            banner +
            `Timeline (${category}, Newest First):\n\n` +
            formatted.join("\n\n") +
            "\n\nUse read_memory_node with id or ids[] to read full details."
    };
}

/**
 * 3. save_project_memory — Atomic Single or Batch Idempotent Upsert
 */
export function saveProjectMemory(projectPath, payload) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: true });
    const banner = formatMigrationBanner(migration);

    const rawItems = Array.isArray(payload.entries) && payload.entries.length > 0
        ? payload.entries
        : [payload];

    for (const item of rawItems) {
        if (!item || typeof item.title !== "string" || !item.title.trim()) {
            throw new Error("Each memory entry requires a non-empty 'title'.");
        }
        if (typeof item.summary !== "string" || !item.summary.trim()) {
            throw new Error(`Memory entry "${item.title}" requires a non-empty 'summary'.`);
        }
    }

    const savedResults = [];

    withTransaction(db, () => {
        const getByIdStmt = db.prepare("SELECT * FROM memories WHERE id = ?");
        const getBySlugStmt = db.prepare(
            "SELECT * FROM memories WHERE slug = ? AND status = 'active' LIMIT 1"
        );
        const insertRevStmt = db.prepare(`
            INSERT INTO memory_revisions (memory_id, prev_title, prev_summary, prev_tags_json, changed_at)
            VALUES (?, ?, ?, ?, ?)
        `);
        const updateStmt = db.prepare(`
            UPDATE memories
            SET slug = ?, title = ?, summary = ?, category = ?, tags_json = ?, files_json = ?, status = 'active', superseded_by = NULL, updated_at = ?
            WHERE id = ?
        `);
        const insertStmt = db.prepare(`
            INSERT INTO memories (
                id, slug, title, summary, category, tags_json, files_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `);

        for (const item of rawItems) {
            const now = new Date().toISOString();
            const title = item.title.trim();
            const summary = item.summary.trim();
            const tags = cleanTags(item.tags || []);
            const files = cleanFiles(storeInfo.canonicalPath, item.files || []);
            const { category, slug } = inferCategoryAndSlugForSave({ ...item, title, tags });

            let targetExisting = null;
            if (item.id && String(item.id).trim()) {
                targetExisting = getByIdStmt.get(String(item.id).trim());
            }
            if (!targetExisting && slug) {
                targetExisting = getBySlugStmt.get(slug);
            }

            if (targetExisting) {
                if (
                    targetExisting.summary !== summary ||
                    targetExisting.title !== title
                ) {
                    insertRevStmt.run(
                        targetExisting.id,
                        targetExisting.title,
                        targetExisting.summary,
                        targetExisting.tags_json,
                        now
                    );
                }

                const effectiveSlug = slug || targetExisting.slug || null;
                updateStmt.run(
                    effectiveSlug,
                    title,
                    summary,
                    category,
                    JSON.stringify(tags),
                    JSON.stringify(files),
                    now,
                    targetExisting.id
                );
                syncMemoryFts(db, {
                    id: targetExisting.id,
                    title,
                    summary,
                    tags,
                    files,
                    status: "active"
                });
                savedResults.push({
                    id: targetExisting.id,
                    slug: effectiveSlug,
                    title,
                    category,
                    action: "updated"
                });
            } else {
                const id =
                    item.id && String(item.id).trim()
                        ? String(item.id).trim()
                        : generateUniqueId(db, "memories");

                insertStmt.run(
                    id,
                    slug,
                    title,
                    summary,
                    category,
                    JSON.stringify(tags),
                    JSON.stringify(files),
                    now,
                    now
                );
                syncMemoryFts(db, { id, title, summary, tags, files, status: "active" });
                savedResults.push({ id, slug, title, category, action: "created" });
            }
        }
    });

    const summaryLines = savedResults.map(
        (r) =>
            `- [${r.action.toUpperCase()}] ID: ${r.id}${r.slug ? ` (slug: ${r.slug})` : ""} | (${r.category}) ${r.title}`
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
 * 4. search_project_memory — FTS5 BM25 Ranked Search + Dead-End Cross-Check
 */
export function searchProjectMemory(
    projectPath,
    { query, category = null, tags = null, include_superseded = false, limit = 10 } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { matches: [], deadEndMatches: [], text: banner + "No relevant memory found (project memory uninitialized)." };
    }

    const safeLimit = Math.max(1, Math.min(30, Math.trunc(Number(limit) || 10)));
    const matches =
        category === "dead_end"
            ? []
            : searchFts(db, query, {
                  category,
                  tags,
                  includeSuperseded: Boolean(include_superseded),
                  limit: safeLimit
              });

    let deadEndMatches = [];
    if (!category || category === "dead_end") {
        deadEndMatches = queryDeadEndsInternal(db, storeInfo.canonicalPath, {
            query,
            limit: 5
        });
    }

    if (matches.length === 0 && deadEndMatches.length === 0) {
        return { matches: [], deadEndMatches: [], text: banner + "No relevant memory found." };
    }

    const out = [];
    if (matches.length > 0) {
        out.push(`Memory Matches (${matches.length}):`);
        for (const m of matches) {
            const supLabel = m.status === "superseded" ? ` [SUPERSEDED by ${m.superseded_by}]` : "";
            const tagStr = m.tags.length > 0 ? ` | Tags: ${m.tags.join(", ")}` : "";
            const fileStr = m.files.length > 0 ? `\n  Files: ${m.files.join(", ")}` : "";
            const snippet = (m.match_snippet || smartPreview(m.summary, 140)).replace(/\s+/g, " ").trim();
            out.push(
                `- [ID: ${m.id}] (${m.category})${supLabel} ${m.title}${tagStr}\n  Snippet: ${snippet}${fileStr}`
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

/**
 * 5. read_memory_node — Single/Batch Reader with File Staleness Warnings & Optional Revisions
 */
export function readMemoryNode(
    projectPath,
    { id = null, ids = null, include_revisions = false } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return {
            isError: true,
            nodes: [],
            text: banner + "Error: Project memory is uninitialized."
        };
    }

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

    const getMemStmt = db.prepare("SELECT * FROM memories WHERE id = ?");
    const getBySlugStmt = db.prepare(
        "SELECT * FROM memories WHERE slug = ? AND status = 'active' LIMIT 1"
    );
    const getDeStmt = db.prepare("SELECT * FROM dead_ends WHERE id = ?");
    const getRevsStmt = db.prepare(
        "SELECT rev_id, prev_title, prev_summary, changed_at FROM memory_revisions WHERE memory_id = ? ORDER BY rev_id DESC LIMIT 5"
    );

    const blocks = [];
    const foundNodes = [];
    const missingIds = [];

    for (const targetId of uniqueIds) {
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
                        lines.push(`[${r.changed_at}] ${r.prev_title}: ${smartPreview(r.prev_summary, 200)}`);
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
 * 6. update_memory_node — In-Place Partial Update with Automatic Revision History
 */
export function updateMemoryNode(
    projectPath,
    { id, title, summary, tags, category, files }
) {
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
            db.prepare(`
                INSERT INTO memory_revisions (memory_id, prev_title, prev_summary, prev_tags_json, changed_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(existing.id, existing.title, existing.summary, existing.tags_json, now);
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
            tags: nextTags,
            files: nextFiles,
            status: "active"
        });
    });

    return {
        isError: false,
        id: existing.id,
        text: banner + `Updated memory node "${nextTitle}" (ID: ${existing.id}). Previous version archived in revisions.`
    };
}

/**
 * 7. delete_memory_node — Soft Archive (Default) or Hard Delete
 */
export function deleteMemoryNode(projectPath, { id, hard_delete = false }) {
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
                db.prepare("DELETE FROM memory_revisions WHERE memory_id = ?").run(mem.id);
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

/**
 * 8. record_dead_end — Structured Anti-Loop Guard Entry
 */
export function recordDeadEnd(
    projectPath,
    { error_pattern, attempted_solution, root_cause, files = [] }
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: true });
    const banner = formatMigrationBanner(migration);

    if (!error_pattern?.trim() || !attempted_solution?.trim() || !root_cause?.trim()) {
        throw new Error(
            "record_dead_end requires non-empty error_pattern, attempted_solution, and root_cause."
        );
    }

    const cleanedFiles = cleanFiles(storeInfo.canonicalPath, files);
    const now = new Date().toISOString();
    let id;

    withTransaction(db, () => {
        id = generateUniqueId(db, "dead_ends", "de-");
        db.prepare(`
            INSERT INTO dead_ends (id, error_pattern, attempted_solution, root_cause, files_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            id,
            error_pattern.trim(),
            attempted_solution.trim(),
            root_cause.trim(),
            JSON.stringify(cleanedFiles),
            now
        );
    });

    return {
        id,
        text:
            banner +
            `Recorded anti-loop dead-end (ID: ${id}) for "${storeInfo.canonicalPath}". Future error checks will warn against repeating this approach.`
    };
}

function queryDeadEndsInternal(
    db,
    canonicalProjectPath,
    { query = null, file_path = null, limit = 10 } = {}
) {
    const allRows = db
        .prepare("SELECT * FROM dead_ends ORDER BY created_at DESC")
        .all()
        .map((r) => ({ ...r, files: safeJsonArray(r.files_json) }));

    if (allRows.length === 0) return [];

    const targetRel = file_path ? normalizeWorkspaceRelativePath(canonicalProjectPath, file_path) : null;
    const targetLower = targetRel ? targetRel.toLowerCase() : null;
    const queryTokens =
        typeof query === "string" && query.trim()
            ? (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length >= 2)
            : [];

    if (!targetLower && queryTokens.length === 0) {
        return allRows.slice(0, limit);
    }

    const scored = [];
    for (const row of allRows) {
        let score = 0;

        if (targetLower) {
            for (const f of row.files) {
                const fl = f.toLowerCase();
                if (fl === targetLower) score += 8;
                else if (targetLower.startsWith(fl + "/") || fl.startsWith(targetLower + "/")) score += 4;
            }
        }

        if (queryTokens.length > 0) {
            const errLower = row.error_pattern.toLowerCase();
            const causeLower = row.root_cause.toLowerCase();
            const solLower = row.attempted_solution.toLowerCase();
            const rawLower = query.trim().toLowerCase();

            if (errLower.includes(rawLower)) score += 10;

            for (const tok of queryTokens) {
                if (errLower.includes(tok)) score += 3;
                if (causeLower.includes(tok)) score += 2;
                if (solLower.includes(tok)) score += 1;
            }
        }

        if (score > 0) {
            scored.push({ ...row, _score: score });
        }
    }

    scored.sort((a, b) => b._score - a._score || Date.parse(b.created_at) - Date.parse(a.created_at));
    return scored.slice(0, limit);
}

/**
 * 9. check_dead_ends — Fast Error / File Lookup Against Failed Approaches
 */
export function checkDeadEnds(
    projectPath,
    { query = null, file_path = null, limit = 10 } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { matches: [], text: banner + "No recorded dead-ends found (project memory uninitialized)." };
    }

    const safeLimit = Math.max(1, Math.min(25, Math.trunc(Number(limit) || 10)));
    const matches = queryDeadEndsInternal(db, storeInfo.canonicalPath, {
        query,
        file_path,
        limit: safeLimit
    });

    if (matches.length === 0) {
        return { matches: [], text: banner + "No matching dead-ends recorded." };
    }

    const lines = matches.map((de) => {
        const filesLine = de.files.length > 0 ? `\n  Files: ${de.files.join(", ")}` : "";
        return `[ID: ${de.id}] (${de.created_at.slice(0, 10)}) Error: ${de.error_pattern}\n  DO NOT REPEAT: ${de.attempted_solution}\n  Root Cause: ${de.root_cause}${filesLine}`;
    });

    return {
        matches,
        text: banner + `Recorded Anti-Loop Dead-Ends (${matches.length}):\n\n` + lines.join("\n\n")
    };
}

/**
 * 10. get_file_memories — File-Anchored Invariants, Gotchas & Dead-Ends
 */
export function getFileMemories(
    projectPath,
    { file_paths, include_dead_ends = true } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { memories: [], deadEnds: [], text: banner + "No file memories found (project memory uninitialized)." };
    }

    const normalizedTargets = cleanFiles(storeInfo.canonicalPath, file_paths || []);
    if (normalizedTargets.length === 0) {
        throw new Error("get_file_memories requires a non-empty file_paths array.");
    }

    const targetsLower = normalizedTargets.map((t) => t.toLowerCase());

    const pathMatches = (entryFiles) => {
        for (const ef of entryFiles) {
            const efl = ef.toLowerCase();
            for (const tl of targetsLower) {
                if (efl === tl || tl.startsWith(efl + "/") || efl.startsWith(tl + "/")) {
                    return true;
                }
            }
        }
        return false;
    };

    const allActive = db
        .prepare(
            "SELECT * FROM memories WHERE status = 'active' ORDER BY updated_at DESC"
        )
        .all()
        .map((r) => ({
            ...r,
            tags: safeJsonArray(r.tags_json),
            files: safeJsonArray(r.files_json)
        }));

    const matchedMemories = allActive.filter(
        (m) =>
            pathMatches(m.files) ||
            targetsLower.some((tl) => m.summary.toLowerCase().includes(tl))
    );

    let matchedDeadEnds = [];
    if (include_dead_ends) {
        const allDe = db
            .prepare("SELECT * FROM dead_ends ORDER BY created_at DESC")
            .all()
            .map((r) => ({ ...r, files: safeJsonArray(r.files_json) }));
        matchedDeadEnds = allDe.filter(
            (de) =>
                pathMatches(de.files) ||
                targetsLower.some(
                    (tl) =>
                        de.error_pattern.toLowerCase().includes(tl) ||
                        de.attempted_solution.toLowerCase().includes(tl)
                )
        );
    }

    if (matchedMemories.length === 0 && matchedDeadEnds.length === 0) {
        return {
            memories: [],
            deadEnds: [],
            text: banner + `No memories or dead-ends anchored to: ${normalizedTargets.join(", ")}`
        };
    }

    const out = [`Context for [${normalizedTargets.join(", ")}]:`];
    if (matchedMemories.length > 0) {
        out.push(`\nMemories (${matchedMemories.length}):`);
        for (const m of matchedMemories) {
            out.push(
                `- [ID: ${m.id}] (${m.category}) ${m.title}\n  ${smartPreview(m.summary, 240)}`
            );
        }
    }
    if (matchedDeadEnds.length > 0) {
        out.push(`\nDead-Ends (${matchedDeadEnds.length}):`);
        for (const de of matchedDeadEnds) {
            out.push(
                `- [ID: ${de.id}] Error: ${de.error_pattern}\n  Avoid: ${de.attempted_solution} (Cause: ${de.root_cause})`
            );
        }
    }

    return {
        memories: matchedMemories,
        deadEnds: matchedDeadEnds,
        text: banner + out.join("\n")
    };
}
