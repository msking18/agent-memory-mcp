/**
 * @file src/paths/index.js
 * @description Unified barrel and config/path facade for workspace canonicalization,
 * zero-process git identity, remote URI parsing, and `projects_index.json` v4 registry.
 */

import fs from "node:fs";
import path from "node:path";

import { getDataRoot } from "./registry.js";

export * from "./git.js";
export * from "./remote.js";
export * from "./registry.js";
export * from "./files.js";

export function getGlobalDbPath() {
    return path.join(getDataRoot(), "global.db");
}

export function getConfigPath() {
    return path.join(getDataRoot(), "config.json");
}

export const DEFAULT_CONFIG = {
    max_response_tokens: 1000,
    enable_audit_logging: true,
    max_audit_log_entries: 2000
};

export function loadConfig() {
    const configPath = getConfigPath();
    let fileConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, "utf8");
            fileConfig = JSON.parse(raw);
        }
    } catch {
        fileConfig = {};
    }

    const envTokens = process.env.AG_MEMORY_MAX_RESPONSE_TOKENS
        ? parseInt(process.env.AG_MEMORY_MAX_RESPONSE_TOKENS, 10)
        : null;

    return {
        max_response_tokens:
            !isNaN(envTokens) && envTokens !== null
                ? envTokens
                : typeof fileConfig.max_response_tokens === "number"
                ? fileConfig.max_response_tokens
                : DEFAULT_CONFIG.max_response_tokens,
        enable_audit_logging:
            typeof fileConfig.enable_audit_logging === "boolean"
                ? fileConfig.enable_audit_logging
                : DEFAULT_CONFIG.enable_audit_logging,
        max_audit_log_entries:
            typeof fileConfig.max_audit_log_entries === "number"
                ? fileConfig.max_audit_log_entries
                : DEFAULT_CONFIG.max_audit_log_entries
    };
}
