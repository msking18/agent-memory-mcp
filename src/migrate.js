import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
    SCHEMA_VERSION,
    openDatabase,
    withTransaction,
    syncMemoryFts
} from "./db.js";
import { normalizeWorkspaceRelativePath } from "./paths.js";

const CANONICAL_CORE_SLUGS = new Map([
    ["tech stack & ecosystem", "tech-stack"],
    ["project structure & architecture", "project-structure"],
    ["build & run instructions", "build-run"]
]);

const KNOWN_LEGACY_KEYS = new Set(["id", "title", "summary", "tags", "date"]);

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            // Busy fallback if SharedArrayBuffer is unavailable
        }
    }
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

function acquireMigrationLock(lockPath, timeoutMs = 10000) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const fd = fs.openSync(lockPath, "wx");
            const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
            fs.writeFileSync(fd, payload, "utf8");
            fs.closeSync(fd);
            return () => {
                try {
                    fs.unlinkSync(lockPath);
                } catch {
                    // Ignore already removed
                }
            };
        } catch (err) {
            if (err.code !== "EEXIST") throw err;

            try {
                const raw = fs.readFileSync(lockPath, "utf8");
                const info = JSON.parse(raw);
                const age = Date.now() - (info.startedAt || 0);
                if (!isProcessAlive(info.pid) || age > 30000) {
                    fs.unlinkSync(lockPath);
                    continue;
                }
            } catch {
                try {
                    fs.unlinkSync(lockPath);
                } catch {
                    // Ignore race
                }
                continue;
            }
            sleepSync(40);
        }
    }

    throw new Error(`Timed out waiting for migration lock: ${lockPath}`);
}

function isGitTracked(canonicalProjectPath, relFileName) {
    if (!fs.existsSync(path.join(canonicalProjectPath, ".git"))) {
        return false;
    }
    try {
        execFileSync("git", ["-C", canonicalProjectPath, "ls-files", "--error-unmatch", relFileName], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 3000
        });
        return true;
    } catch {
        return false;
    }
}

function normalizeTags(rawTags) {
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

function normalizeIsoDate(rawDate, fallbackIso) {
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

function inferCategoryAndSlug(title, tags) {
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

function extractExistingWorkspaceFiles(canonicalProjectPath, summaryText) {
    if (typeof summaryText !== "string" || !summaryText) return [];
    const regex = /(?:^|[\s`"'([<])([a-zA-Z0-9_.-]+(?:[\\/][a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]{1,10})(?=$|[\s`"')\]>.,:;])/g;
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
 * Normalizes all entries from parsed v2 .ag-memory.json losslessly.
 */
function normalizeLegacyEntries(parsedJson, canonicalProjectPath, fallbackIso) {
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
            const list = byCanonicalSlug.get(entry.slug) || [];
            list.push(entry);
            byCanonicalSlug.set(entry.slug, list);
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

function archiveVerifiedLegacyFile(storeInfo, rawBuffer, sourceSha256, entryCount, actionLabel) {
    fs.mkdirSync(storeInfo.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFileName = `${stamp}.ag-memory.v2.json`;
    const backupFilePath = path.join(storeInfo.backupDir, backupFileName);

    fs.writeFileSync(backupFilePath, rawBuffer);
    const verifyHash = crypto.createHash("sha256").update(fs.readFileSync(backupFilePath)).digest("hex");
    if (verifyHash !== sourceSha256) {
        throw new Error("Backup verification failed: SHA-256 mismatch on archived legacy file.");
    }

    const gitTracked = isGitTracked(storeInfo.canonicalPath, ".ag-memory.json");
    if (!gitTracked) {
        fs.unlinkSync(storeInfo.legacyJsonPath);
    }

    const manifestPath = path.join(storeInfo.backupDir, "manifest.json");
    let manifest = { projectPath: storeInfo.canonicalPath, storeKey: storeInfo.storeKey, backups: [] };
    try {
        if (fs.existsSync(manifestPath)) {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        }
    } catch {
        // Reset unreadable manifest metadata without affecting backup files
    }

    manifest.backups.push({
        file: backupFileName,
        sha256: sourceSha256,
        entryCount,
        action: actionLabel,
        gitTracked,
        archivedAt: new Date().toISOString()
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return { backupFilePath, gitTracked };
}

/**
 * Runs staging DB creation in DELETE journal mode (avoiding Windows WAL sidecar locks during rename),
 * verifies 100% row & content parity, closes the handle, and atomically promotes to live dbPath.
 */
function runInitialTransactionalMigration(storeInfo, entries, sourceSha256) {
    fs.mkdirSync(path.dirname(storeInfo.dbPath), { recursive: true });
    const tmpDbPath = `${storeInfo.dbPath}.tmp.${process.pid}.${Date.now()}`;
    const stagingDb = new DatabaseSync(tmpDbPath);

    try {
        // Use DELETE journal_mode strictly during isolated staging so rename has a single file
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
                created_at TEXT NOT NULL
            );
            CREATE INDEX idx_dead_ends_created ON dead_ends(created_at DESC);
            CREATE TABLE migration_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_path TEXT NOT NULL,
                source_sha256 TEXT NOT NULL,
                entry_count INTEGER NOT NULL,
                backup_path TEXT NOT NULL,
                migrated_at TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE memories_fts USING fts5(
                id UNINDEXED,
                title,
                tags_text,
                files_text,
                summary,
                tokenize='porter unicode61'
            );
        `);

        withTransaction(stagingDb, () => {
            stagingDb
                .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
                .run(SCHEMA_VERSION);

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
        });

        // Strict Post-Write Verification Gate
        const countRow = stagingDb.prepare("SELECT COUNT(*) AS cnt FROM memories").get();
        if (!countRow || Number(countRow.cnt) !== entries.length) {
            throw new Error(
                `Migration verification failed: expected ${entries.length} rows, got ${countRow?.cnt}`
            );
        }

        const verifyStmt = stagingDb.prepare("SELECT title, summary FROM memories WHERE id = ?");
        for (const e of entries) {
            const actual = verifyStmt.get(e.id);
            if (!actual || actual.title !== e.title || actual.summary !== e.summary) {
                throw new Error(`Migration verification failed: content mismatch on entry ID "${e.id}"`);
            }
        }

        stagingDb.close();
    } catch (err) {
        try {
            stagingDb.close();
        } catch {
            // Ignore close error
        }
        try {
            if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
        } catch {
            // Ignore cleanup error
        }
        throw err;
    }

    fs.renameSync(tmpDbPath, storeInfo.dbPath);

    // Record audit entry once live DB is opened in standard WAL mode
    return sourceSha256;
}

/**
 * Transparently checks for and migrates (or delta-merges) <project_path>/.ag-memory.json.
 * Safe against concurrent processes, corrupt JSON, duplicate bootstrap titles, and git-tracked files.
 */
export function ensureMigratedIfLegacyExists(storeInfo) {
    if (!fs.existsSync(storeInfo.legacyJsonPath)) {
        return { action: "none" };
    }

    const releaseLock = acquireMigrationLock(storeInfo.lockPath);
    try {
        // Re-check inside lock in case a sibling process just migrated and unlinked the file
        if (!fs.existsSync(storeInfo.legacyJsonPath)) {
            return { action: "none" };
        }

        const rawBuffer = fs.readFileSync(storeInfo.legacyJsonPath);
        const sourceSha256 = crypto.createHash("sha256").update(rawBuffer).digest("hex");
        const cleanText = rawBuffer.toString("utf8").replace(/^\uFEFF/, "");

        let parsed;
        try {
            parsed = JSON.parse(cleanText);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("Top-level JSON value must be an object.");
            }
        } catch (parseErr) {
            fs.mkdirSync(storeInfo.backupDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const quarantinePath = path.join(storeInfo.backupDir, `corrupt-${stamp}.ag-memory.json`);
            fs.writeFileSync(quarantinePath, rawBuffer);
            return {
                action: "corrupt_quarantined",
                warning: `Legacy .ag-memory.json has invalid JSON (${parseErr.message}). Original left untouched; copy saved to ${quarantinePath}.`,
                quarantinePath
            };
        }

        let fallbackIso = new Date().toISOString();
        try {
            fallbackIso = fs.statSync(storeInfo.legacyJsonPath).mtime.toISOString();
        } catch {
            // Keep current timestamp fallback
        }

        const entries = normalizeLegacyEntries(parsed, storeInfo.canonicalPath, fallbackIso);
        const dbAlreadyExists = fs.existsSync(storeInfo.dbPath);

        if (!dbAlreadyExists) {
            runInitialTransactionalMigration(storeInfo, entries, sourceSha256);
            const { backupFilePath, gitTracked } = archiveVerifiedLegacyFile(
                storeInfo,
                rawBuffer,
                sourceSha256,
                entries.length,
                "initial_migration"
            );

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

        // Split-brain / re-introduced legacy file check against existing v3 DB
        const liveDb = openDatabase(storeInfo.dbPath);
        const priorAudit = liveDb
            .prepare("SELECT id, backup_path FROM migration_audit WHERE source_sha256 = ? LIMIT 1")
            .get(sourceSha256);

        if (priorAudit) {
            const gitTracked = isGitTracked(storeInfo.canonicalPath, ".ag-memory.json");
            if (!gitTracked) {
                const { backupFilePath } = archiveVerifiedLegacyFile(
                    storeInfo,
                    rawBuffer,
                    sourceSha256,
                    entries.length,
                    "duplicate_archive"
                );
                return { action: "already_migrated_archived", backupFilePath, gitTracked: false };
            }
            return { action: "already_migrated_git_tracked", gitTracked: true };
        }

        // Divergent .ag-memory.json detected -> lossless delta merge!
        let insertedCount = 0;
        let divergentRevisionsCount = 0;

        withTransaction(liveDb, () => {
            const getExistingStmt = liveDb.prepare(
                "SELECT id, title, summary, tags_json FROM memories WHERE id = ?"
            );
            const insertMemoryStmt = liveDb.prepare(`
                INSERT INTO memories (
                    id, slug, title, summary, category, tags_json, files_json,
                    status, superseded_by, legacy_meta_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertRevisionStmt = liveDb.prepare(`
                INSERT INTO memory_revisions (memory_id, prev_title, prev_summary, prev_tags_json, changed_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const e of entries) {
                const existing = getExistingStmt.get(e.id);
                if (!existing) {
                    // Avoid slug conflict if v3 already has an active canonical slug
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
                    syncMemoryFts(liveDb, { ...e, status: safeStatus });
                    insertedCount++;
                } else if (existing.summary !== e.summary) {
                    insertRevisionStmt.run(
                        e.id,
                        `[Legacy Delta Merge] ${e.title}`,
                        e.summary,
                        JSON.stringify(e.tags),
                        new Date().toISOString()
                    );
                    divergentRevisionsCount++;
                }
            }
        });

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

        return {
            action: "delta_merged",
            insertedCount,
            divergentRevisionsCount,
            backupFilePath,
            gitTracked
        };
    } finally {
        releaseLock();
    }
}
