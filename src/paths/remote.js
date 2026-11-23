/**
 * @file src/paths/remote.js
 * @description Remote workspace URI validation/canonicalization, non-probing Windows WSL UNC
 * canonicalization, bidirectional WSL aliasing, and strict local path validation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REMOTE_SCHEMES = new Set([
    "vscode-remote:",
    "ssh:",
    "wsl:",
    "devcontainer:",
    "remote:"
]);

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const WSL_UNC_PREFIX_RE = /^(\\\\|\/\/)wsl(\.localhost|\$)[\\/][^\\/]+/i;
const WSL_UNC_RE = /^(\\\\|\/\/)wsl(\.localhost|\$)[\\/]([^\\/]+)(.*)$/i;
const WSL_URI_RE = /^wsl:\/\/([^/]+)(.*)$/i;

function resolveRealPath(targetPath) {
    try {
        return fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
    } catch {
        return targetPath;
    }
}

function sanitizeSlug(rawName) {
    const slug = (rawName || "root")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return slug || "project";
}

function normalizeLocalForHash(canonicalPath) {
    const forward = canonicalPath.replace(/\\/g, "/");
    const stripped = forward.length > 1 ? forward.replace(/\/+$/, "") : forward;
    return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function normalizeRemotePathOnly(rawUriPath) {
    const collapsed = rawUriPath.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (!collapsed || collapsed === "/") {
        return "/";
    }
    return collapsed.replace(/\/+$/, "") || "/";
}

/**
 * Validates path segments both before and after percent-decoding to block
 * raw and encoded traversal (e.g. '..' and '%2e%2e') and malformed escapes.
 */
function validateRemotePathSegments(rawUriPath, rawInput) {
    const normalizedPath = normalizeRemotePathOnly(rawUriPath);
    const segments = normalizedPath.split("/").filter((s) => s.length > 0);

    for (const seg of segments) {
        if (seg === "." || seg === "..") {
            throw new Error(`Invalid project_path "${rawInput}": path traversal segment "${seg}" is not allowed.`);
        }
        let decoded;
        try {
            decoded = decodeURIComponent(seg);
        } catch {
            throw new Error(`Invalid project_path "${rawInput}": malformed percent-encoding in segment "${seg}".`);
        }
        if (CONTROL_CHAR_RE.test(decoded)) {
            throw new Error(`Invalid project_path "${rawInput}": control characters are not allowed.`);
        }
        if (decoded.split(/[/\\]/).some((part) => part === "." || part === "..")) {
            throw new Error(`Invalid project_path "${rawInput}": encoded path traversal is not allowed.`);
        }
    }

    return { normalizedPath, segments };
}

function decodeSlugSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function parseRemoteUri(cleaned, rawPath) {
    const match = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^/\\]*)(.*)$/);
    if (!match) {
        throw new Error(`Invalid remote project_path "${rawPath}": expected <scheme>//<authority>/<path>.`);
    }

    const scheme = match[1].toLowerCase();
    if (!REMOTE_SCHEMES.has(scheme)) {
        throw new Error(`Unsupported remote scheme "${scheme}" in project_path "${rawPath}".`);
    }

    const rawAuthority = match[2].trim();
    if (!rawAuthority || rawAuthority === "." || rawAuthority === ".." || /\s/.test(rawAuthority)) {
        throw new Error(`Invalid remote project_path "${rawPath}": remote authority must be non-empty.`);
    }
    let decodedAuthority;
    try {
        decodedAuthority = decodeURIComponent(rawAuthority);
    } catch {
        throw new Error(`Invalid remote project_path "${rawPath}": malformed percent-encoding in authority.`);
    }
    if (CONTROL_CHAR_RE.test(decodedAuthority) || /[/\\]/.test(decodedAuthority)) {
        throw new Error(`Invalid remote project_path "${rawPath}": invalid characters in authority.`);
    }
    const authority = rawAuthority.toLowerCase();

    const rest = (match[3] || "").replace(/\\/g, "/");
    if (!rest || !rest.startsWith("/")) {
        throw new Error(`Invalid remote project_path "${rawPath}": remote URI must include a path starting with '/'.`);
    }

    const { normalizedPath, segments } = validateRemotePathSegments(rest, rawPath);
    const canonicalPath = `${scheme}//${authority}${normalizedPath}`;
    const lastSeg = segments.length > 0 ? decodeSlugSegment(segments[segments.length - 1]) : "root";

    return {
        canonicalPath,
        normalizedForHash: canonicalPath,
        slug: sanitizeSlug(lastSeg),
        isRemote: true,
        remoteScheme: scheme.slice(0, -1)
    };
}

function parseWslUncOrFallback(rawPath, uncMatch) {
    const distro = uncMatch[3];
    const rest = uncMatch[4] || "";
    if (!distro || distro === "." || distro === "..") {
        throw new Error(`Invalid WSL UNC project_path "${rawPath}": invalid distribution name.`);
    }

    // Never probe Windows WSL UNC paths with fs.statSync/existsSync; on Windows 11
    // probing \\wsl.localhost\... triggers the built-in wsl.exe installer or VM boot.
    const rawPosix = rest ? (rest.startsWith("/") || rest.startsWith("\\") ? rest : `/${rest}`) : "/";
    const { normalizedPath, segments } = validateRemotePathSegments(rawPosix, rawPath);
    const canonicalPath = `wsl://${distro.toLowerCase()}${normalizedPath}`;
    const lastSeg = segments.length > 0 ? decodeSlugSegment(segments[segments.length - 1]) : "root";

    return {
        canonicalPath,
        normalizedForHash: canonicalPath,
        slug: sanitizeSlug(lastSeg),
        isRemote: true,
        remoteScheme: "wsl"
    };
}

/**
 * Checks whether rawPath is a Windows WSL UNC path (`\\wsl.localhost\<distro>\...`
 * or `\\wsl$\<distro>\...`, or forward-slash equivalents).
 */
export function isWslUncPath(rawPath) {
    if (typeof rawPath !== "string") return false;
    return WSL_UNC_PREFIX_RE.test(rawPath.trim());
}

/**
 * Checks whether rawPath begins with one of the supported remote workspace URI schemes.
 */
export function isRemoteUri(rawPath) {
    if (typeof rawPath !== "string") return false;
    const trimmed = rawPath.trim().toLowerCase();
    for (const scheme of REMOTE_SCHEMES) {
        if (trimmed.startsWith(scheme)) {
            return true;
        }
    }
    return false;
}

/**
 * Validates and canonicalizes either a remote workspace URI, a Windows WSL UNC path
 * (canonicalized directly to virtual `wsl://` without `fs.statSync`), or a strict local directory path.
 */
export function validateOrParseProjectPath(rawPath) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw new Error("Invalid project_path: must be a non-empty absolute directory path or remote URI.");
    }
    if (rawPath.includes("\0")) {
        throw new Error(`Invalid project_path "${rawPath}": null bytes are not allowed.`);
    }

    let cleaned = rawPath.trim();
    if (CONTROL_CHAR_RE.test(cleaned)) {
        throw new Error(`Invalid project_path "${rawPath}": control characters are not allowed.`);
    }

    if (isRemoteUri(cleaned)) {
        return parseRemoteUri(cleaned, rawPath);
    }

    const initialUncMatch = cleaned.match(WSL_UNC_RE);
    if (initialUncMatch) {
        return parseWslUncOrFallback(rawPath, initialUncMatch);
    }

    if (cleaned.startsWith("file://")) {
        try {
            cleaned = fileURLToPath(cleaned);
        } catch {
            throw new Error(`Invalid file URI for project_path: ${rawPath}`);
        }
        // On POSIX/Windows mix, "/c:/foo" occasionally appears in URI conversions
        if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(cleaned)) {
            cleaned = cleaned.slice(1);
        }
        if (CONTROL_CHAR_RE.test(cleaned)) {
            throw new Error(`Invalid project_path "${rawPath}": control characters are not allowed.`);
        }
        const unwrappedUncMatch = cleaned.match(WSL_UNC_RE);
        if (unwrappedUncMatch) {
            return parseWslUncOrFallback(rawPath, unwrappedUncMatch);
        }
    } else if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(cleaned)) {
        cleaned = cleaned.slice(1);
    }

    if (!path.isAbsolute(cleaned)) {
        throw new Error(
            `Invalid project_path "${rawPath}": relative paths (such as "./") are not allowed. Pass an absolute workspace directory path.`
        );
    }

    const resolved = path.resolve(cleaned);
    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (err) {
        if (err && err.code === "ENOENT") {
            throw new Error(
                `Invalid project_path "${resolved}": directory does not exist. For remote workspaces, pass a supported URI (e.g., vscode-remote://, ssh://, wsl://, devcontainer://, remote://).`
            );
        }
        throw new Error(`Cannot access project_path "${resolved}": ${err.message}`);
    }

    if (!stat.isDirectory()) {
        throw new Error(`Invalid project_path "${resolved}": path is a file, expected a directory.`);
    }

    const canonicalPath = resolveRealPath(resolved);
    return {
        canonicalPath,
        normalizedForHash: normalizeLocalForHash(canonicalPath),
        slug: sanitizeSlug(path.basename(canonicalPath) || "root"),
        isRemote: false,
        remoteScheme: null
    };
}

/**
 * Returns the canonical workspace path or canonical remote URI string.
 */
export function validateProjectPath(rawPath) {
    return validateOrParseProjectPath(rawPath).canonicalPath;
}

/**
 * Returns normalized bidirectional lookup keys across `wsl://`, `//wsl.localhost/`,
 * and `//wsl$/` forms for any WSL path or URI, or `[canonicalOrNormalized]` otherwise.
 */
export function getWslEquivalentKeys(canonicalOrNormalized) {
    if (typeof canonicalOrNormalized !== "string") {
        return [];
    }
    const trimmed = canonicalOrNormalized.trim();
    if (!trimmed) {
        return [canonicalOrNormalized];
    }

    let distro = null;
    let rawRest = "";

    const uriMatch = trimmed.replace(/\\/g, "/").match(WSL_URI_RE);
    if (uriMatch) {
        distro = uriMatch[1];
        rawRest = uriMatch[2] || "/";
    } else {
        const uncMatch = trimmed.match(WSL_UNC_RE);
        if (uncMatch) {
            distro = uncMatch[3];
            rawRest = uncMatch[4] || "/";
        }
    }

    if (!distro) {
        return [canonicalOrNormalized];
    }

    const distroLower = distro.toLowerCase();
    const posixPath = normalizeRemotePathOnly(rawRest.startsWith("/") || rawRest.startsWith("\\") ? rawRest : `/${rawRest}`);
    const posixLower = posixPath.toLowerCase();

    const keys = new Set([
        `wsl://${distroLower}${posixPath}`,
        `//wsl.localhost/${distroLower}${posixPath}`,
        `//wsl$/${distroLower}${posixPath}`
    ]);

    if (posixLower !== posixPath) {
        keys.add(`//wsl.localhost/${distroLower}${posixLower}`);
        keys.add(`//wsl$/${distroLower}${posixLower}`);
    }

    return Array.from(keys);
}

/**
 * Normalizes a local path or remote URI for index comparison against `projects_index.json`.
 */
export function normalizeForIndexCompare(rawOrCanonical, isRemote) {
    if (typeof rawOrCanonical !== "string") return "";
    let s = rawOrCanonical.trim();
    if (!s) return "";

    const remote = typeof isRemote === "boolean" ? isRemote : isRemoteUri(s);
    if (remote) {
        s = s.replace(/\\/g, "/");
        const match = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/]+)(.*)$/);
        if (match) {
            const schemePrefix = match[1].toLowerCase();
            const authority = match[2].toLowerCase();
            const normPath = match[3] ? normalizeRemotePathOnly(match[3]) : "";
            return `${schemePrefix}${authority}${normPath}`;
        }
        return s.length > 1 ? s.replace(/\/+$/, "") : s;
    }

    if (s.startsWith("file://")) {
        try {
            s = fileURLToPath(s);
            if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(s)) {
                s = s.slice(1);
            }
        } catch {
            // Fall back to raw string normalization
        }
    }

    s = s.replace(/\\/g, "/");
    s = s.startsWith("//")
        ? "//" + s.slice(2).replace(/\/+/g, "/")
        : s.replace(/\/+/g, "/");

    if (s.length > 1) {
        s = s.replace(/\/+$/, "");
    }
    return process.platform === "win32" ? s.toLowerCase() : s;
}
