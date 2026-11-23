/**
 * @file src/paths/files.js
 * @description Remote/POSIX-aware workspace relative path normalization, file:// URI unwrapping,
 * WSL UNC URI conversion, and deepest-ancestor symlink/junction resolution.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    isRemoteUri,
    isWslUncPath
} from "./remote.js";

const WSL_UNC_PARSE_RE = /^(?:\\\\|\/\/)wsl(?:\.localhost|\$)[\\/]([^\\/]+)(.*)$/i;
const REMOTE_URI_PARTS_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)(.*)$/;

export function unwrapFileUri(rawPath) {
    let cleaned = rawPath.trim();
    if (/^file:\/\//i.test(cleaned)) {
        try {
            cleaned = fileURLToPath(cleaned);
        } catch {
            // Keep raw string if fileURLToPath rejects malformed URI
        }
    }
    if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(cleaned)) {
        cleaned = cleaned.slice(1);
    }
    return cleaned;
}

export function wslUncToUri(rawPath) {
    const match = rawPath.trim().match(WSL_UNC_PARSE_RE);
    if (!match) return rawPath;
    const distro = match[1].toLowerCase();
    const rawRest = (match[2] || "/").replace(/\\/g, "/");
    const norm = path.posix.normalize(rawRest.startsWith("/") ? rawRest : `/${rawRest}`);
    const posixPath = norm.length > 1 ? norm.replace(/\/+$/, "") : norm;
    return `wsl://${distro}${posixPath}`;
}

export function normalizePosixPath(rawPosix) {
    const withLeading = rawPosix.startsWith("/") ? rawPosix : `/${rawPosix}`;
    const norm = path.posix.normalize(withLeading);
    return norm.length > 1 ? norm.replace(/\/+$/, "") : norm;
}

export function parseRemoteParts(remoteUri) {
    const match = remoteUri.replace(/\\/g, "/").match(REMOTE_URI_PARTS_RE);
    if (!match) return null;
    const prefix = match[1].toLowerCase();
    const posixPath = normalizePosixPath(match[2] || "/");
    return { prefix, posixPath };
}

export function resolveRemoteCandidate(rootCanonical, rootParts, unwrapped) {
    const rootPosix = rootParts ? rootParts.posixPath : normalizePosixPath(rootCanonical.replace(/\\/g, "/"));
    const rootPrefix = rootParts ? rootParts.prefix : "";
    const cleanedForward = unwrapped.replace(/\\/g, "/");

    if (isRemoteUri(cleanedForward)) {
        const targetParts = parseRemoteParts(cleanedForward);
        if (targetParts && rootParts && targetParts.prefix === rootPrefix) {
            const rel = path.posix.relative(rootPosix, targetParts.posixPath);
            if (!rel || rel === ".") {
                return { isRootSelf: true, inWorkspaceRel: null, resolvedTarget: cleanedForward, resolvedTargetIsRemote: true };
            }
            if (!isOutsideRelative(rel, true)) {
                return { isRootSelf: false, inWorkspaceRel: rel, resolvedTarget: cleanedForward, resolvedTargetIsRemote: true };
            }
        }
        const resolvedTarget = targetParts ? `${targetParts.prefix}${targetParts.posixPath}` : cleanedForward;
        return { isRootSelf: false, inWorkspaceRel: null, resolvedTarget, resolvedTargetIsRemote: true };
    }

    if (/^[a-zA-Z]:[\\/]/.test(unwrapped)) {
        const resolvedTarget =
            process.platform === "win32"
                ? realpathSyncSafe(path.win32.resolve(unwrapped))
                : path.win32.resolve(unwrapped).replace(/\\/g, "/");
        return {
            isRootSelf: false,
            inWorkspaceRel: null,
            resolvedTarget,
            resolvedTargetIsRemote: false
        };
    }

    let targetPosix;
    if (cleanedForward.startsWith("/")) {
        targetPosix = normalizePosixPath(cleanedForward);
    } else {
        const relInput = cleanedForward.startsWith("./") ? cleanedForward.slice(2) : cleanedForward;
        targetPosix = normalizePosixPath(path.posix.resolve(rootPosix, relInput));
    }

    const rel = path.posix.relative(rootPosix, targetPosix);
    if (!rel || rel === ".") {
        return { isRootSelf: true, inWorkspaceRel: null, resolvedTarget: `${rootPrefix}${targetPosix}`, resolvedTargetIsRemote: true };
    }
    if (!isOutsideRelative(rel, true)) {
        return { isRootSelf: false, inWorkspaceRel: rel, resolvedTarget: `${rootPrefix}${targetPosix}`, resolvedTargetIsRemote: true };
    }
    return {
        isRootSelf: false,
        inWorkspaceRel: null,
        resolvedTarget: `${rootPrefix}${targetPosix}`,
        resolvedTargetIsRemote: true
    };
}

export function isOutsideRelative(rel, isPosix) {
    if (!rel) return false;
    const forward = rel.replace(/\\/g, "/");
    if (forward === ".." || forward.startsWith("../")) {
        return true;
    }
    if (isPosix) {
        return path.posix.isAbsolute(forward);
    }
    return path.isAbsolute(rel) || /^[a-zA-Z]:/.test(forward);
}

/**
 * Resolves realpath on local paths without ever probing remote URIs or Windows WSL UNC paths.
 * When the leaf path does not exist yet, walks up to the deepest existing ancestor directory
 * and rejoins the remaining tail segments.
 */
export function realpathSyncSafe(targetPath) {
    if (!targetPath || isRemoteUri(targetPath) || isWslUncPath(targetPath)) {
        return targetPath;
    }
    const resolveNative = (p) => (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p));
    try {
        return resolveNative(targetPath);
    } catch {
        const tail = [];
        let cur = path.resolve(targetPath);
        while (true) {
            const parent = path.dirname(cur);
            if (parent === cur) {
                return path.resolve(targetPath);
            }
            tail.unshift(path.basename(cur));
            cur = parent;
            try {
                const realAncestor = resolveNative(cur);
                return path.join(realAncestor, ...tail);
            } catch {
                // Keep walking up
            }
        }
    }
}

/**
 * Normalizes a file path (remote URI, file:// URI, absolute path, or workspace-relative path)
 * into a clean forward-slash workspace-relative path without Windows C:\ corruption on remote roots.
 *
 * @param {string} canonicalProjectPath
 * @param {string} targetFile
 * @param {{ isRemote?: boolean }} [options]
 * @returns {string | null}
 */
export function normalizeWorkspaceRelativePath(canonicalProjectPath, targetFile, options = {}) {
    if (typeof targetFile !== "string" || !targetFile.trim()) return null;
    if (typeof canonicalProjectPath !== "string" || !canonicalProjectPath.trim()) return null;

    let unwrapped = unwrapFileUri(targetFile);
    if (isWslUncPath(unwrapped)) {
        unwrapped = wslUncToUri(unwrapped);
    }

    let canonical = canonicalProjectPath.trim();
    if (isWslUncPath(canonical)) {
        canonical = wslUncToUri(canonical);
    }

    const remote = Boolean(options?.isRemote) || isRemoteUri(canonical);

    if (remote) {
        const rootParts = parseRemoteParts(canonical);
        const res = resolveRemoteCandidate(canonical, rootParts, unwrapped);
        if (res.isRootSelf) return null;
        if (res.inWorkspaceRel) return res.inWorkspaceRel;
        return unwrapped.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    }

    if (isRemoteUri(unwrapped)) {
        return unwrapped.replace(/\\/g, "/").replace(/^\/+/, "");
    }

    if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(unwrapped)) {
        return path.win32.resolve(unwrapped).replace(/\\/g, "/");
    }

    let cleanedForward = unwrapped.replace(/\\/g, "/");
    if (cleanedForward.startsWith("./")) {
        cleanedForward = cleanedForward.slice(2);
    }

    const candidateAbs = path.isAbsolute(unwrapped)
        ? path.resolve(unwrapped)
        : path.resolve(canonical, cleanedForward);

    const directRel = path.relative(canonical, candidateAbs).replace(/\\/g, "/");
    if (!directRel || directRel === ".") return null;
    if (!isOutsideRelative(directRel, false)) {
        return directRel;
    }

    const realCandidate = realpathSyncSafe(candidateAbs);
    const realRoot = realpathSyncSafe(canonical);
    const realRel = path.relative(realRoot, realCandidate).replace(/\\/g, "/");
    if (!realRel || realRel === ".") return null;
    if (!isOutsideRelative(realRel, false)) {
        return realRel;
    }

    return cleanedForward.replace(/^\/+/, "");
}
