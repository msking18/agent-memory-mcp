/**
 * @file src/migrate/lock.js
 * @description Cross-process atomic file locking for SQLite JIT migrations.
 * Prevents concurrent server instances or hooks from simultaneously migrating
 * the same project repository.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Synchronous millisecond sleep helper using Atomics.wait or busy fallback.
 *
 * @param {number} ms - Milliseconds to sleep.
 */
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

/**
 * Checks if a process with the specified PID is currently running.
 *
 * @param {number} pid - Process ID to check.
 * @returns {boolean} True if the process exists or permission is denied, false otherwise.
 */
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

/**
 * Acquires an exclusive file-based lock for migrating a project database.
 * Detects and automatically cleans up stale locks left by terminated processes.
 *
 * @param {string} lockPath - File path to the `.migration.lock` lockfile.
 * @param {number} [timeoutMs=10000] - Maximum time to wait in milliseconds before timing out.
 * @returns {() => void} Release callback function to remove the lockfile.
 * @throws {Error} If the lock cannot be acquired within the timeout window.
 */
export function acquireMigrationLock(lockPath, timeoutMs = 10000) {
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
