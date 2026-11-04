/**
 * @file src/store/file-memories.js
 * @description File-anchored contextual memories, invariants, and dead-ends.
 * Retrieves all architectural decisions and past failure records linked directly to
 * workspace files about to be modified.
 */

import { prepareStore, formatMigrationBanner, cleanFiles, smartPreview } from "./helpers.js";

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
 * Retrieves all architectural invariants, past gotchas, and dead-ends anchored to specific workspace files.
 *
 * @param {string} projectPath - Workspace root directory.
 * @param {Object} args - Arguments.
 * @param {Array<string>} args.file_paths - File or directory paths about to be edited.
 * @param {boolean} [args.include_dead_ends=true] - Whether to include matching dead-ends.
 * @returns {{ memories: Array<Object>, deadEnds: Array<Object>, text: string }} Matched memories and formatted text.
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
        const allDeadEnds = db
            .prepare("SELECT * FROM dead_ends WHERE status = 'active' ORDER BY created_at DESC")
            .all()
            .map((r) => ({
                ...r,
                files: safeJsonArray(r.files_json),
                constraints: safeJsonArray(r.constraints_json)
            }));
        matchedDeadEnds = allDeadEnds.filter(
            (de) =>
                pathMatches(de.files) ||
                targetsLower.some(
                    (tl) =>
                        de.error_pattern.toLowerCase().includes(tl) ||
                        de.attempted_solution.toLowerCase().includes(tl) ||
                        de.root_cause.toLowerCase().includes(tl)
                )
        );
    }

    const parts = [];
    if (matchedMemories.length > 0) {
        parts.push(
            `### File-Anchored Architectural Memories (${matchedMemories.length}):\n` +
                matchedMemories
                    .map((m) => `- [${m.id}] ${m.title} (${m.category}): ${smartPreview(m.summary, 120)}`)
                    .join("\n")
        );
    }
    if (matchedDeadEnds.length > 0) {
        parts.push(
            `### File-Anchored Dead-Ends (${matchedDeadEnds.length}):\n` +
                matchedDeadEnds
                    .map((de) => `- [${de.id}] DO NOT: ${de.attempted_solution} (Root Cause: ${de.root_cause})`)
                    .join("\n")
        );
    }

    const text =
        parts.length > 0
            ? banner + parts.join("\n\n")
            : banner + `No past architectural memories or dead-ends anchored to: ${normalizedTargets.join(", ")}`;

    return {
        memories: matchedMemories.map((m) => ({
            id: m.id,
            title: m.title,
            category: m.category,
            files: m.files,
            summary: m.summary
        })),
        deadEnds: matchedDeadEnds.map((de) => ({
            id: de.id,
            error_pattern: de.error_pattern,
            attempted_solution: de.attempted_solution,
            root_cause: de.root_cause,
            files: de.files,
            kind: de.kind,
            constraints: de.constraints
        })),
        text
    };
}
