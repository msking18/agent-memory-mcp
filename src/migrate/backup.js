/**
 * @file src/migrate/backup.js
 * @description Backup archiving, git-tracking detection, and quarantine handlers for legacy `.ag-memory.json` files.
 * Guarantees zero data loss by computing cryptographic hashes before removing or archiving legacy memory files.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Checks whether a relative file path is tracked by git in the target repository.
 * If tracked by git, the legacy file is preserved on disk to avoid triggering unexpected git diffs.
 *
 * @param {string} canonicalProjectPath - Absolute canonical path to the repository root.
 * @param {string} relFileName - File name or relative path to check (e.g., '.ag-memory.json').
 * @returns {boolean} True if the file is tracked in git index, false otherwise.
 */
export function isGitTracked(canonicalProjectPath, relFileName) {
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

/**
 * Safely copies an unparseable or corrupt legacy file to the project's backup directory for inspection.
 * Leaves the original file on disk untouched.
 *
 * @param {Object} storeInfo - Project store metadata.
 * @param {Buffer} rawBuffer - Raw unparsed buffer of the corrupt file.
 * @param {string} parseErrMessage - Detailed JSON parse error message.
 * @returns {{ action: string, warning: string, quarantinePath: string }}
 */
export function quarantineCorruptLegacyFile(storeInfo, rawBuffer, parseErrMessage) {
    fs.mkdirSync(storeInfo.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = path.join(storeInfo.backupDir, `corrupt-${stamp}.ag-memory.json`);
    fs.writeFileSync(quarantinePath, rawBuffer);
    return {
        action: "corrupt_quarantined",
        warning: `Legacy .ag-memory.json has invalid JSON (${parseErrMessage}). Original left untouched; copy saved to ${quarantinePath}.`,
        quarantinePath
    };
}

/**
 * Archives a verified legacy memory JSON file to `~/.ag-memory-mcp/backups/<storeKey>/`.
 * Performs a SHA-256 byte integrity check to guarantee the archive is complete before deleting the original.
 *
 * @param {Object} storeInfo - Project store metadata.
 * @param {Buffer} rawBuffer - Raw byte buffer of the legacy file.
 * @param {string} sourceSha256 - Expected SHA-256 hex digest.
 * @param {number} entryCount - Number of memory entries migrated.
 * @param {string} actionLabel - Migration action label (e.g. 'initial_migration' or 'delta_merge').
 * @returns {{ backupFilePath: string, gitTracked: boolean }}
 * @throws {Error} If SHA-256 verification fails.
 */
export function archiveVerifiedLegacyFile(storeInfo, rawBuffer, sourceSha256, entryCount, actionLabel) {
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
