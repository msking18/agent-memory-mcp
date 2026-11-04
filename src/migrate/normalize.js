/**
 * @file src/migrate/normalize.js
 * @description Lossless data normalization and canonical slug inference for legacy `.ag-memory.json` entries.
 * Maps legacy arbitrary schemas into validated v3.1 memory nodes, extracts workspace file links,
 * and resolves duplicate bootstrap titles into active/superseded revisions.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeWorkspaceRelativePath } from "../paths.js";

/** Canonical slugs mapped from known foundational memory titles. */
export const CANONICAL_CORE_SLUGS = new Map([
    ["tech stack & ecosystem", "tech-stack"],
    ["project structure & architecture", "project-structure"],
    ["build & run instructions", "build-run"]
]);

/** Known v2 JSON property names; any other properties are preserved under `legacy_meta_json`. */
export const KNOWN_LEGACY_KEYS = new Set(["id", "title", "summary", "tags", "date"]);

/**
 * Normalizes tags from an array, comma-separated string, or nullish value into a unique list of strings.
 *
 * @param {Array<string>|string|null|undefined} rawTags - Raw tags.
 * @returns {Array<string>} Normalized unique tag list.
 */
export function normalizeTags(rawTags) {
    if (!rawTags) return [];
    const list = Array.isArray(rawTags)
        ? rawTags
        : typeof rawTags === "string"
          ? rawTags.split(",")
          : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const trimmed = String(item ?? "").trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            out.push(trimmed);
        }
    }
    return out;
}

/**
 * Parses and normalizes date values into valid ISO-8601 UTC strings.
 *
 * @param {string|number|null|undefined} rawDate - Raw date string or millisecond timestamp.
 * @param {string} fallbackIso - Fallback ISO date string if rawDate cannot be parsed.
 * @returns {string} Normalized ISO-8601 date string.
 */
export function normalizeIsoDate(rawDate, fallbackIso) {
    if (typeof rawDate === "string" && rawDate.trim()) {
        const ms = Date.parse(rawDate);
        if (!Number.isNaN(ms)) {
            return new Date(ms).toISOString();
        }
    } else if (typeof rawDate === "number" && Number.isFinite(rawDate)) {
        return new Date(rawDate).toISOString();
    }
    return fallbackIso;
}

/**
 * Infers an architectural or session category and canonical slug from title and tags.
 *
 * @param {string} title - Memory title.
 * @param {Array<string>} tags - Normalized tags.
 * @returns {{ category: string, slug: string|null }}
 */
export function inferCategoryAndSlug(title, tags) {
    const lowerTitle = title.trim().toLowerCase();
    const lowerTags = tags.map((t) => t.toLowerCase());

    if (CANONICAL_CORE_SLUGS.has(lowerTitle)) {
        return { category: "architecture", slug: CANONICAL_CORE_SLUGS.get(lowerTitle) };
    }
    if (
        lowerTitle.startsWith("session log") ||
        lowerTags.includes("session") ||
        lowerTags.includes("changelog")
    ) {
        return { category: "session", slug: null };
    }
    if (
        lowerTags.includes("architecture") ||
        lowerTags.includes("stack") ||
        lowerTags.includes("bootstrap") ||
        lowerTags.includes("core")
    ) {
        return { category: "architecture", slug: null };
    }
    if (lowerTags.includes("decision") || lowerTags.includes("adr")) {
        return { category: "decision", slug: null };
    }
    return { category: "note", slug: null };
}

/**
 * Scans markdown text for mentioned workspace file paths that actually exist on disk.
 *
 * @param {string} canonicalProjectPath - Workspace root directory.
 * @param {string} summaryText - Markdown text content to scan.
 * @returns {Array<string>} Array of verified workspace-relative file paths.
 */
export function extractExistingWorkspaceFiles(canonicalProjectPath, summaryText) {
    if (typeof summaryText !== "string" || !summaryText) return [];
    const regex =
        /(?:^|[\s`"'([<])([a-zA-Z0-9_.-]+(?:[\\/][a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]{1,10})(?=$|[\s`"')\]>.,:;])/g;
    const found = new Set();
    let match;
    while ((match = regex.exec(summaryText)) !== null) {
        const candidateRel = normalizeWorkspaceRelativePath(canonicalProjectPath, match[1]);
        if (!candidateRel || candidateRel.startsWith("..")) continue;
        const fullPath = path.join(canonicalProjectPath, candidateRel);
        try {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                found.add(candidateRel);
                if (found.size >= 25) break;
            }
        } catch {
            // Ignore inaccessible paths
        }
    }
    return [...found];
}

/**
 * Normalizes all entries from parsed legacy `.ag-memory.json` data into validated v3 nodes.
 *
 * @param {Object} parsedJson - Parsed JSON object from legacy file.
 * @param {string} canonicalProjectPath - Workspace root directory.
 * @param {string} fallbackIso - ISO timestamp for missing dates.
 * @returns {Array<Object>} Normalized memory entry records.
 */
export function normalizeLegacyEntries(parsedJson, canonicalProjectPath, fallbackIso) {
    const rawContainer = parsedJson.entries ?? {};
    const pairs = Array.isArray(rawContainer)
        ? rawContainer.map((item, idx) => [item?.id || `legacy-${idx}`, item])
        : Object.entries(rawContainer);

    const usedIds = new Set();
    const normalized = [];

    for (const [dictKey, rawEntry] of pairs) {
        if (!rawEntry || typeof rawEntry !== "object") continue;

        let baseId = String(rawEntry.id || dictKey || crypto.randomUUID().slice(0, 8)).trim();
        if (!baseId) baseId = crypto.randomUUID().slice(0, 8);
        let id = baseId;
        let suffix = 1;
        while (usedIds.has(id)) {
            id = `${baseId}-${suffix++}`;
        }
        usedIds.add(id);

        const title =
            typeof rawEntry.title === "string" && rawEntry.title.trim()
                ? rawEntry.title.trim()
                : `Untitled Legacy Entry (${id})`;
        const summary =
            typeof rawEntry.summary === "string"
                ? rawEntry.summary
                : rawEntry.summary != null
                  ? String(rawEntry.summary)
                  : "";
        const tags = normalizeTags(rawEntry.tags);
        const isoDate = normalizeIsoDate(rawEntry.date, fallbackIso);
        const { category, slug } = inferCategoryAndSlug(title, tags);
        const files = extractExistingWorkspaceFiles(canonicalProjectPath, summary);

        const extraMeta = {};
        for (const [k, v] of Object.entries(rawEntry)) {
            if (!KNOWN_LEGACY_KEYS.has(k)) {
                extraMeta[k] = v;
            }
        }
        if (dictKey && rawEntry.id && String(rawEntry.id) !== String(dictKey)) {
            extraMeta._legacyDictKey = dictKey;
        }

        normalized.push({
            id,
            slug,
            title,
            summary,
            category,
            tags,
            files,
            status: "active",
            superseded_by: null,
            legacy_meta_json: Object.keys(extraMeta).length > 0 ? JSON.stringify(extraMeta) : null,
            created_at: isoDate,
            updated_at: isoDate
        });
    }

    // Deduplicate canonical architectural titles losslessly: keep newest active, mark older superseded
    const byCanonicalSlug = new Map();
    for (const entry of normalized) {
        if (entry.slug) {
            if (!byCanonicalSlug.has(entry.slug)) {
                byCanonicalSlug.set(entry.slug, []);
            }
            byCanonicalSlug.get(entry.slug).push(entry);
        }
    }

    for (const [, group] of byCanonicalSlug.entries()) {
        if (group.length <= 1) continue;
        group.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        const newest = group[0];
        for (let i = 1; i < group.length; i++) {
            group[i].status = "superseded";
            group[i].slug = null;
            group[i].superseded_by = newest.id;
        }
    }

    return normalized;
}
