/**
 * @file src/store/timeline.js
 * @description Context status hydrator and chronological session timeline feed.
 * Implements `check_memory_status` (1-shot architecture status, dead-end count, and recent logs)
 * and `get_session_timeline` (filtered chronological feed).
 */

import { prepareStore, formatMigrationBanner, smartPreview } from "./helpers.js";

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
 * Checks if project memory is initialized and retrieves the architecture index,
 * active dead-end count, and recent session timeline in a single call.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} [options] - Options.
 * @param {boolean} [options.include_timeline=true] - Whether to include recent session entries.
 * @param {number} [options.timeline_limit=5] - Maximum recent session entries to include.
 * @returns {Object} Hydrated status object with formatted summary text.
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

    const deadEndRow = db
        .prepare("SELECT COUNT(*) AS cnt FROM dead_ends WHERE status = 'active' OR status IS NULL")
        .get();
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

    const archRows = db
        .prepare(
            "SELECT id, slug, title, summary, updated_at FROM memories WHERE category = 'architecture' AND status = 'active' ORDER BY updated_at DESC LIMIT 10"
        )
        .all();

    const sections = [
        banner + `Memory Status for "${storeInfo.canonicalPath}":`,
        `- Active Memories: ${totalActive} (` +
            Object.entries(countsByCategory)
                .map(([cat, n]) => `${cat}: ${n}`)
                .join(", ") +
            `)`,
        `- Active Anti-Loop Dead-Ends: ${deadEndCount}`
    ];

    if (archRows.length > 0) {
        sections.push(
            "\nCore Architecture Index:",
            ...archRows.map(
                (r) =>
                    `  * [${r.slug || r.id}] ${r.title} (${r.updated_at.slice(0, 10)}): ${smartPreview(r.summary, 120)}`
            )
        );
    }

    let timelineEntries = [];
    if (include_timeline) {
        const tRows = db
            .prepare(
                "SELECT id, title, category, tags_json, files_json, summary, updated_at FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?"
            )
            .all(timeline_limit);

        timelineEntries = tRows.map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            tags: safeJsonArray(r.tags_json),
            files: safeJsonArray(r.files_json),
            summary: r.summary,
            updated_at: r.updated_at
        }));

        if (timelineEntries.length > 0) {
            sections.push(
                `\nRecent Session Timeline (Top ${timelineEntries.length}):`,
                ...timelineEntries.map(
                    (e) =>
                        `  * [${e.category}] ${e.title} (${e.updated_at.slice(0, 10)}): ${smartPreview(e.summary, 140)}`
                )
            );
        }
    }

    return {
        initialized: true,
        storeInfo,
        migration,
        totalActive,
        countsByCategory,
        deadEndCount,
        architectureIndex: archRows,
        recentTimeline: timelineEntries,
        text: sections.join("\n")
    };
}

/**
 * Retrieves a chronological feed of project memories filterable by category, tags, and date.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} [options] - Filter options.
 * @param {string} [options.category="all"] - Category filter ('all', 'session', 'architecture', etc.).
 * @param {string} [options.tag] - Tag keyword filter.
 * @param {string} [options.since] - ISO date string to filter entries updated after this date.
 * @param {number} [options.limit=15] - Maximum entries to retrieve.
 * @returns {{ entries: Array<Object>, text: string }} Filtered timeline entries and formatted markdown feed.
 */
export function getSessionTimeline(
    projectPath,
    { category = "all", tag, since, limit = 15 } = {}
) {
    const { storeInfo, migration, db } = prepareStore(projectPath, { createIfMissing: false });
    const banner = formatMigrationBanner(migration);

    if (!db) {
        return { entries: [], text: banner + "No timeline found (project memory uninitialized)." };
    }

    let sql = "SELECT * FROM memories WHERE status = 'active'";
    const params = [];

    if (category && category !== "all") {
        sql += " AND category = ?";
        params.push(category);
    }
    if (since) {
        sql += " AND updated_at >= ?";
        params.push(since);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(Math.min(limit * 3, 100)); // overfetch for tag filter

    const rows = db.prepare(sql).all(...params);
    const parsed = rows.map((r) => ({
        ...r,
        tags: safeJsonArray(r.tags_json),
        files: safeJsonArray(r.files_json)
    }));

    const filtered = tag
        ? parsed.filter((r) => r.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
        : parsed;

    const trimmed = filtered.slice(0, limit);

    if (trimmed.length === 0) {
        return { entries: [], text: banner + "No timeline entries matched the specified criteria." };
    }

    const feed = trimmed.map((e) => {
        const fileStr = e.files.length ? `\n  Files: ${e.files.join(", ")}` : "";
        const tagStr = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
        return `### [${e.category.toUpperCase()}] ${e.title} (${e.updated_at.slice(0, 10)})${tagStr}\n${e.summary}${fileStr}`;
    });

    return {
        entries: trimmed.map((e) => ({
            id: e.id,
            slug: e.slug,
            title: e.title,
            category: e.category,
            tags: e.tags,
            files: e.files,
            updated_at: e.updated_at
        })),
        text: banner + feed.join("\n\n---\n\n")
    };
}
