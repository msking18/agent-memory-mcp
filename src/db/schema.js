/**
 * @file src/db/schema.js
 * @description SQLite database DDL schemas for agent-memory-mcp.
 * Defines the tables, indexes, and FTS5 virtual tables for both per-project
 * databases and the centralized global knowledge graph.
 */

/**
 * SQLite DDL schema for per-project databases (`project-*.db`).
 * Includes:
 * - `memories`: Primary storage for architecture, decisions, and session logs.
 * - `memories_fts`: FTS5 full-text search index with Porter stemming and BM25 ranking.
 * - `revisions`: Historical version archives for rollbacks and audit trails.
 * - `dead_ends`: Two-tier registry for failed debugging attempts and architectural constraints.
 * - `migrations`: Migration audit ledger.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    files_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED,
    title,
    summary,
    tags,
    files,
    tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    files_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_revisions_memory_id ON revisions(memory_id, version DESC);

CREATE TABLE IF NOT EXISTS dead_ends (
    id TEXT PRIMARY KEY,
    error_pattern TEXT NOT NULL,
    attempted_solution TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    files_json TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL DEFAULT 'error_loop',
    constraints_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    reopened_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_ends_status ON dead_ends(status);
CREATE INDEX IF NOT EXISTS idx_dead_ends_kind ON dead_ends(kind);
CREATE INDEX IF NOT EXISTS idx_dead_ends_created_at ON dead_ends(created_at DESC);

CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
`;

/**
 * SQLite DDL schema for the centralized machine-wide global knowledge graph (`global.db`).
 * Includes:
 * - `global_memories`: Machine-wide patterns, conventions, and library quirks.
 * - `global_memories_fts`: FTS5 virtual table for BM25-ranked global search.
 * - `token_audit_log`: Audit log tracking token budget capping efficiency.
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

CREATE INDEX IF NOT EXISTS idx_global_memories_category ON global_memories(category);
CREATE INDEX IF NOT EXISTS idx_global_memories_tech_stack ON global_memories(tech_stack);
CREATE INDEX IF NOT EXISTS idx_global_memories_updated_at ON global_memories(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS global_memories_fts USING fts5(
    id UNINDEXED,
    title,
    summary,
    tags,
    tech_stack,
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

CREATE INDEX IF NOT EXISTS idx_token_audit_tool ON token_audit_log(tool_name);
CREATE INDEX IF NOT EXISTS idx_token_audit_timestamp ON token_audit_log(timestamp DESC);
`;
