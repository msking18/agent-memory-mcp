/**
 * @file src/paths/git.js
 * @description Zero-subprocess git metadata parser for repository, worktree,
 * bare-repo sibling worktree, and remote-less root-commit identity detection.
 */

import fs from "node:fs";
import path from "node:path";

export const MAX_GIT_FILE_BYTES = 262144;
const MAX_LOGS_HEAD_BYTES = 4096;
const MAX_WALK_LEVELS = 64;

function resolveRealPath(targetPath) {
    const resolved = path.resolve(targetPath);
    try {
        return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

function normalizeDirForIdentity(dirPath) {
    const forward = dirPath.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/**
 * Reads a UTF-8 file only if it is a regular file within maxBytes.
 * Distinguishes missing files from oversized or unreadable files.
 */
function readFileBounded(filePath, maxBytes = MAX_GIT_FILE_BYTES) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
            return { status: "missing", content: null };
        }
        return { status: "invalid", content: null };
    }

    if (!stat.isFile() || stat.size > maxBytes) {
        return { status: "invalid", content: null };
    }

    try {
        return { status: "ok", content: fs.readFileSync(filePath, "utf8") };
    } catch {
        return { status: "invalid", content: null };
    }
}

/**
 * Reads at most maxBytes from the beginning of a regular file.
 */
function readFileHead(filePath, maxBytes = MAX_LOGS_HEAD_BYTES) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return null;
    }
    if (!stat.isFile() || stat.size === 0) {
        return null;
    }

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    let fd;
    try {
        fd = fs.openSync(filePath, "r");
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
        return buffer.toString("utf8", 0, bytesRead);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch {
                // Ignore close failure
            }
        }
    }
}

function cleanRepoPath(rawPath) {
    return rawPath
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
}

/**
 * Normalizes a git remote URL (SCP, HTTPS, HTTP, SSH, GIT) into a canonical
 * host[:port]/owner/repo identifier without credentials, default ports, or .git suffix.
 *
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function normalizeGitRemoteUrl(rawUrl) {
    if (typeof rawUrl !== "string") return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    const schemeMatch = trimmed.match(/^(https?|ssh|git):\/\/(.+)$/i);
    if (schemeMatch) {
        const rest = schemeMatch[2].split(/[?#]/, 1)[0];
        const slashIdx = rest.indexOf("/");
        if (slashIdx <= 0) return null;

        const authority = rest.slice(0, slashIdx);
        const rawPath = rest.slice(slashIdx + 1);
        const atIdx = authority.lastIndexOf("@");
        const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
        if (!hostPort) return null;

        const hostPortMatch = hostPort.startsWith("[")
            ? hostPort.match(/^(\[[^\]]+\])(?::(\d+))?$/)
            : hostPort.match(/^([^:]+)(?::(\d+))?$/);
        if (!hostPortMatch) return null;

        const scheme = schemeMatch[1].toLowerCase();
        const defaultPorts = { ssh: "22", http: "80", https: "443" };
        const host = hostPortMatch[1].toLowerCase();
        const port = hostPortMatch[2] || "";
        const keepPort = port && port !== defaultPorts[scheme] ? port : "";

        const cleanedPath = cleanRepoPath(rawPath).toLowerCase();
        if (!cleanedPath) return null;

        return keepPort ? `${host}:${keepPort}/${cleanedPath}` : `${host}/${cleanedPath}`;
    }

    // Reject other URL schemes (e.g., file://) or local/Windows filesystem paths
    if (trimmed.includes("://") || /^[/.~]/.test(trimmed) || /^[a-zA-Z]:(?:[\\/]|$)/.test(trimmed)) {
        return null;
    }

    const scpMatch = trimmed.match(/^(?:([^@/\s]+)@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/);
    if (!scpMatch) return null;

    const [, user, host, rawPath] = scpMatch;
    if (!user && host.length === 1) return null;

    const cleanedPath = cleanRepoPath(rawPath).toLowerCase();
    if (!cleanedPath) return null;

    return `${host.toLowerCase()}/${cleanedPath}`;
}

function stripIniInlineComment(line) {
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "\\" && inQuotes && i + 1 < line.length) {
            i++;
            continue;
        }
        if (ch === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && (ch === "#" || ch === ";")) {
            return line.slice(0, i);
        }
    }
    return line;
}

function unquoteIniValue(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1").trim();
    }
    return trimmed;
}

/**
 * Parses .git/config text and extracts the remote URL, preferring [remote "origin"]
 * (case-insensitive) and falling back to the first declared remote.
 *
 * @param {string} configText
 * @returns {string | null}
 */
export function parseGitConfigRemoteUrl(configText) {
    if (typeof configText !== "string" || !configText) return null;

    let currentRemote = null;
    let originUrl = null;
    let firstRemoteUrl = null;

    for (const rawLine of configText.split(/\r?\n/)) {
        const line = stripIniInlineComment(rawLine).trim();
        if (!line) continue;

        if (line.startsWith("[") && line.endsWith("]")) {
            const header = line.slice(1, -1).trim();
            const quotedMatch = header.match(/^remote\s+"((?:\\.|[^"\\])*)"$/i);
            const unquotedMatch = !quotedMatch ? header.match(/^remote\s+(\S+)$/i) : null;
            const remoteName = quotedMatch
                ? quotedMatch[1].replace(/\\(["\\])/g, "$1")
                : unquotedMatch
                ? unquotedMatch[1]
                : null;
            currentRemote = remoteName !== null ? remoteName.toLowerCase() : null;
            continue;
        }

        if (currentRemote === null) continue;

        const kvMatch = line.match(/^([a-z0-9-]+)\s*=\s*(.+)$/i);
        if (!kvMatch || kvMatch[1].toLowerCase() !== "url") continue;

        const urlVal = unquoteIniValue(kvMatch[2]);
        if (!urlVal) continue;

        if (!firstRemoteUrl) firstRemoteUrl = urlVal;
        if (currentRemote === "origin" && !originUrl) originUrl = urlVal;
    }

    return originUrl ?? firstRemoteUrl ?? null;
}

function resolveGitDirs(foundGitPath, gitWorkTreeRoot) {
    let gitStat;
    try {
        gitStat = fs.statSync(foundGitPath);
    } catch {
        return null;
    }

    if (gitStat.isDirectory()) {
        return {
            gitCommonDir: resolveRealPath(foundGitPath),
            isWorktree: false
        };
    }

    if (!gitStat.isFile()) return null;

    const pointerRead = readFileBounded(foundGitPath, MAX_GIT_FILE_BYTES);
    if (pointerRead.status !== "ok") return null;

    const gitdirMatch = pointerRead.content.match(/^gitdir:\s*(.+)$/im);
    if (!gitdirMatch) return null;

    const rawGitDir = gitdirMatch[1].trim();
    if (!rawGitDir) return null;

    const resolvedGitDir = path.isAbsolute(rawGitDir)
        ? path.resolve(rawGitDir)
        : path.resolve(gitWorkTreeRoot, rawGitDir);

    let gitDirStat;
    try {
        gitDirStat = fs.statSync(resolvedGitDir);
    } catch {
        return null;
    }
    if (!gitDirStat.isDirectory()) return null;

    const commonDirFile = path.join(resolvedGitDir, "commondir");
    const commonRead = readFileBounded(commonDirFile, MAX_GIT_FILE_BYTES);
    if (commonRead.status === "invalid") return null;

    if (commonRead.status === "ok") {
        const commonRel = commonRead.content.trim();
        if (!commonRel) return null;
        const candidateCommonDir = path.isAbsolute(commonRel)
            ? path.resolve(commonRel)
            : path.resolve(resolvedGitDir, commonRel);

        let commonStat;
        try {
            commonStat = fs.statSync(candidateCommonDir);
        } catch {
            return null;
        }
        if (!commonStat.isDirectory()) return null;

        const gitCommonDir = resolveRealPath(candidateCommonDir);
        return {
            gitCommonDir,
            isWorktree: gitCommonDir !== resolveRealPath(resolvedGitDir)
        };
    }

    return {
        gitCommonDir: resolveRealPath(resolvedGitDir),
        isWorktree: false
    };
}

/**
 * Detects git repository identity for a canonical workspace directory without spawning git.
 * Supports normal repos, monorepo subpaths, standard worktrees, bare-repo sibling worktrees,
 * and remote-less repositories via root-commit SHA or normalized commonDir.
 *
 * @param {string} canonicalPath
 * @returns {{ gitIdentity: string, gitCommonDir: string, gitWorkTreeRoot: string, isWorktree: boolean, repoSubpath: string } | null}
 */
export function detectGitIdentity(canonicalPath) {
    if (typeof canonicalPath !== "string" || !canonicalPath.trim()) {
        return null;
    }

    try {
        const realCanonicalPath = resolveRealPath(canonicalPath);
        let dir = realCanonicalPath;
        let foundGitPath = null;
        let gitWorkTreeRoot = null;

        for (let level = 0; level < MAX_WALK_LEVELS; level++) {
            const candidate = path.join(dir, ".git");
            try {
                fs.statSync(candidate);
                foundGitPath = candidate;
                gitWorkTreeRoot = dir;
                break;
            } catch {
                // Continue walking up
            }

            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }

        if (!foundGitPath || !gitWorkTreeRoot) {
            return null;
        }

        const resolvedDirs = resolveGitDirs(foundGitPath, gitWorkTreeRoot);
        if (!resolvedDirs) {
            return null;
        }

        const { gitCommonDir, isWorktree } = resolvedDirs;
        const realWorkTreeRoot = resolveRealPath(gitWorkTreeRoot);

        let baseIdentity = null;
        const configRead = readFileBounded(path.join(gitCommonDir, "config"), MAX_GIT_FILE_BYTES);
        if (configRead.status === "invalid") {
            return null;
        }
        if (configRead.status === "ok") {
            const rawRemote = parseGitConfigRemoteUrl(configRead.content);
            if (rawRemote) {
                baseIdentity = normalizeGitRemoteUrl(rawRemote);
            }
        }

        if (!baseIdentity) {
            const headLog = readFileHead(path.join(gitCommonDir, "logs", "HEAD"), MAX_LOGS_HEAD_BYTES);
            if (headLog) {
                const rootMatch = headLog.trimStart().match(/^0{40}\s+([0-9a-f]{40})\b/i);
                if (rootMatch) {
                    baseIdentity = `local-git-root:${rootMatch[1].toLowerCase()}`;
                }
            }
        }

        if (!baseIdentity) {
            baseIdentity = `local-git:${normalizeDirForIdentity(gitCommonDir)}`;
        }

        let repoSubpath = path.relative(realWorkTreeRoot, realCanonicalPath).replace(/\\/g, "/");
        if (repoSubpath === "." || repoSubpath === ".." || repoSubpath.startsWith("../")) {
            repoSubpath = "";
        }
        if (process.platform === "win32") {
            repoSubpath = repoSubpath.toLowerCase();
        }

        const gitIdentity = repoSubpath ? `${baseIdentity}#${repoSubpath}` : baseIdentity;

        return {
            gitIdentity,
            gitCommonDir,
            gitWorkTreeRoot: realWorkTreeRoot,
            isWorktree,
            repoSubpath
        };
    } catch {
        return null;
    }
}
