import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Returns the root data directory (defaults to ~/.ag-memory-mcp,
 * overridable via AG_MEMORY_DATA_DIR for isolated testing or custom locations).
 */
export function getDataRoot() {
    if (process.env.AG_MEMORY_DATA_DIR && process.env.AG_MEMORY_DATA_DIR.trim()) {
        return path.resolve(process.env.AG_MEMORY_DATA_DIR.trim());
    }
    return path.join(os.homedir(), ".ag-memory-mcp");
}

export function getStoresDir() {
    const dir = path.join(getDataRoot(), "stores");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getBackupsDir() {
    const dir = path.join(getDataRoot(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getProjectsIndexPath() {
    return path.join(getStoresDir(), "projects_index.json");
}

/**
 * Cleans optional file:// URI wrappers while keeping relative paths un-resolved
 * so we can explicitly reject './' or relative strings.
 */
function normalizeInputPathString(rawPath) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw new Error("Invalid project_path: must be a non-empty absolute directory path.");
    }
    let cleaned = rawPath.trim();
    if (cleaned.startsWith("file://")) {
        try {
            cleaned = fileURLToPath(cleaned);
        } catch {
            throw new Error(`Invalid file URI for project_path: ${rawPath}`);
        }
    }
    // On POSIX/Windows mix, "/c:/foo" occasionally appears in URI conversions
    if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(cleaned)) {
        cleaned = cleaned.slice(1);
    }
    return cleaned;
}

/**
 * Validates that projectPath is an absolute path to an existing directory
 * and resolves its canonical OS path.
 */
export function validateProjectPath(rawPath) {
    const cleaned = normalizeInputPathString(rawPath);

    if (!path.isAbsolute(cleaned)) {
        throw new Error(
            `Invalid project_path "${rawPath}": relative paths (such as "./") are not allowed. Pass an absolute workspace directory path.`
        );
    }

    // On Windows, "/foo" without a drive letter is considered isAbsolute by path.posix,
    // and path.win32 treats "\foo" as drive-relative; ensure full root resolution check.
    const resolved = path.resolve(cleaned);
    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (err) {
        if (err.code === "ENOENT") {
            throw new Error(`Invalid project_path "${resolved}": directory does not exist.`);
        }
        throw new Error(`Cannot access project_path "${resolved}": ${err.message}`);
    }

    if (!stat.isDirectory()) {
        throw new Error(`Invalid project_path "${resolved}": path is a file, expected a directory.`);
    }

    try {
        return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

/**
 * Computes deterministic storage & backup paths for a validated project directory.
 */
export function getProjectStoreInfo(rawPath) {
    const canonicalPath = validateProjectPath(rawPath);
    const normalizedForHash =
        process.platform === "win32"
            ? canonicalPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
            : canonicalPath.replace(/\/+$/, "");

    const hashKey = crypto.createHash("sha256").update(normalizedForHash, "utf8").digest("hex").slice(0, 12);
    const baseName = path.basename(canonicalPath) || "root";
    const slug = baseName
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "project";

    const storeKey = `${slug}-${hashKey}`;
    const storesDir = getStoresDir();
    const backupsRoot = getBackupsDir();

    return {
        canonicalPath,
        normalizedForHash,
        hashKey,
        slug,
        storeKey,
        dbFileName: `${storeKey}.db`,
        dbPath: path.join(storesDir, `${storeKey}.db`),
        lockPath: path.join(storesDir, `${storeKey}.migrate.lock`),
        backupDir: path.join(backupsRoot, storeKey),
        legacyJsonPath: path.join(canonicalPath, ".ag-memory.json")
    };
}

/**
 * Reads the central projects_index.json mapping store keys to workspace paths.
 */
export function readProjectsIndex() {
    const indexPath = getProjectsIndexPath();
    try {
        const raw = fs.readFileSync(indexPath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.projects === "object" ? parsed : { version: 3, projects: {} };
    } catch {
        return { version: 3, projects: {} };
    }
}

/**
 * Atomically updates projects_index.json when a project store is accessed or created.
 */
export function registerProjectInIndex(storeInfo) {
    const indexPath = getProjectsIndexPath();
    const current = readProjectsIndex();
    const now = new Date().toISOString();
    const existing = current.projects[storeInfo.storeKey];

    current.projects[storeInfo.storeKey] = {
        storeKey: storeInfo.storeKey,
        canonicalPath: storeInfo.canonicalPath,
        dbFile: storeInfo.dbFileName,
        firstSeenAt: existing?.firstSeenAt || now,
        lastAccessedAt: now
    };

    const tmpPath = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), "utf8");
    fs.renameSync(tmpPath, indexPath);
}

/**
 * Normalizes any file path (absolute inside workspace or workspace-relative)
 * to a clean forward-slash relative path like "src/lib/auth.ts".
 */
export function normalizeWorkspaceRelativePath(canonicalProjectPath, targetFile) {
    if (typeof targetFile !== "string" || !targetFile.trim()) return null;
    let cleaned = targetFile.trim().replace(/\\/g, "/");
    if (cleaned.startsWith("./")) cleaned = cleaned.slice(2);

    const candidateAbs = path.isAbsolute(targetFile.trim())
        ? path.resolve(targetFile.trim())
        : path.resolve(canonicalProjectPath, cleaned);

    const rel = path.relative(canonicalProjectPath, candidateAbs).replace(/\\/g, "/");
    if (!rel || rel === ".") return null;
    // If path points outside workspace ("../..."), keep normalized string safely trimmed
    if (rel.startsWith("..")) {
        return cleaned.replace(/^\/+/, "");
    }
    return rel;
}
