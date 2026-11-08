/**
 * @file src/db/schema.js
 * @description SQLite database DDL schemas for agent-memory-mcp.
 * Defines the tables, indexes, and FTS5 virtual tables for both per-project
 * databases and the centralized global knowledge graph.
 */

export const SCHEMA_VERSION = "3.2.0";

/**
 * SQLite DDL schema for per-project databases (`project-*.db`).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
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

CREATE INDEX IF NOT EXISTS idx_memories_status_cat_updated
    ON memories(status, category, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_slug
    ON memories(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_revisions (
    rev_id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    prev_title TEXT,
    prev_summary TEXT,
    prev_tags_json TEXT,
    changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revisions_memory_id
    ON memory_revisions(memory_id, rev_id DESC);

CREATE TABLE IF NOT EXISTS dead_ends (
    id TEXT PRIMARY KEY,
    error_pattern TEXT NOT NULL,
    attempted_solution TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    files_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_ends_created
    ON dead_ends(created_at DESC);

CREATE TABLE IF NOT EXISTS migration_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    entry_count INTEGER NOT NULL,
    backup_path TEXT NOT NULL,
    migrated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED,
    title,
    tags_text,
    files_text,
    summary,
    tokenize='porter unicode61'
);
`;

/**
 * SQLite DDL schema for the centralized machine-wide global knowledge graph (`global.db`).
 */
export const GLOBAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS global_memories (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'pattern',
    tags_json TEXT NOT NULL DEFAULT '[]',
    tech_stack TEXT NOT NULL DEFAULT 'general',
    source_project TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_global_cat_stack_updated
    ON global_memories(category, tech_stack, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS global_memories_fts USING fts5(
    id UNINDEXED,
    title,
    tags,
    tech_stack,
    summary,
    tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS token_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    project_path TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens_raw INTEGER NOT NULL,
    output_tokens_budgeted INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_token_audit_time
    ON token_audit_log(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_token_audit_tool
    ON token_audit_log(tool_name, timestamp DESC);
`;
