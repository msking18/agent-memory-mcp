# Validated Design Specification: Global Knowledge, Token Guardrails & Dead-End Taxonomy

## 1. Understanding Summary
- **What is being built:** 
  1. A central, machine-wide knowledge base (`~/.ag-memory-mcp/global.db`) for generalized cross-project solution patterns, queried strictly on-demand (zero startup token bloat).
  2. A user-configurable token budgeting system with an internal SQLite audit log (`token_audit_log`) and inspection tool (`get_token_metrics`).
  3. A dead-end taxonomy distinguishing `"error_loop"` (hard failures) from `"architectural"` (conditional trade-offs) plus a `reopen_dead_end` tool to reactivate abandoned approaches.
- **Why it exists:** Prevents agents from repeatedly reinventing solutions across projects, protects context windows and API token costs from silent inflation, and removes the frustration of agents stubbornly refusing to revisit architectural paths when constraints change.
- **Who it is for:** Developers using AI coding agents across multiple repositories and editors (Google Antigravity, Claude Code, Cursor, Windsurf, Cline).
- **Key constraints:** Zero cloud dependencies, 100% backwards-compatible with v3.0 databases, sub-25ms response latency, user-controlled token limits.

---

## 2. Decision Log

| Decision | Alternatives Considered | Why This Option Was Chosen |
| :--- | :--- | :--- |
| **D-1: Storage Architecture** | Dedicated `global.db` vs. monolithic single DB partition | Dedicated `global.db` eliminates cross-project database locking, preserves isolation, and requires zero migration of existing project databases. |
| **D-2: Global Retrieval Strategy** | On-demand fallback vs. automatic startup injection | On-demand fallback ensures 0 token cost at startup and keeps the context window focused exclusively on the active project unless cross-project insights are needed. |
| **D-3: Token Budgeting & Auditing** | Passive audit + configurable output caps vs. aggressive output pruning only | Configurable limits (`max_response_tokens`) prevent arbitrary cutoffs from breaking complex outputs while giving users full visibility into token consumption per tool. |
| **D-4: Dead-End Classification** | Explicit `kind` + `constraints` vs. simple status toggling | Explicit classification allows the model to receive hard negative constraints on bugs while understanding the context of strategic architectural trade-offs that can be reconsidered. |

---

## 3. Data Architecture & Schema Evolution

### A. Dead-Ends Upgrade (`stores/*.db`)
Automatically updated on boot via idempotent `ALTER TABLE` checks:
```sql
ALTER TABLE dead_ends ADD COLUMN kind TEXT NOT NULL DEFAULT 'error_loop';
ALTER TABLE dead_ends ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE dead_ends ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE dead_ends ADD COLUMN reopened_reason TEXT NULL;
ALTER TABLE dead_ends ADD COLUMN updated_at TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_dead_ends_kind_status ON dead_ends(kind, status, created_at DESC);
```

### B. Global Store & Audit Log (`~/.ag-memory-mcp/global.db`)
```sql
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
    tags_text,
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
```

---

## 4. Key Refinements Incorporated

1. **Full CRUD on Global Memories via `g-` IDs**: `readMemoryNode`, `updateMemoryNode`, and `deleteMemoryNode` transparently route IDs starting with `g-` to `global.db`.
2. **`promote_to_global` Tool**: Easily promotes project-level memory or solution pattern to machine-wide `global.db`.
3. **`full_content: true` Option**: Added to `readMemoryNode` to bypass sentence-boundary token trimming when agents explicitly need full payloads.
4. **`kind: "error_loop" | "architectural" | "all"` Filtering**: In `check_dead_ends` to distinguish hard failure loops from conditional trade-offs.

---

## 5. Token Budgeting Middleware
- Configurable via `~/.ag-memory-mcp/config.json` (`max_response_tokens`, default 1,000; `enable_audit_logging`, default true; `max_audit_log_entries`, default 2,000).
- Overridable via environment variable `AG_MEMORY_MAX_RESPONSE_TOKENS`.
- Sentence-boundary trimming on `. `, `! `, `? `, `\n\n`, `\n` to prevent JSON/markdown syntax corruption.
- Non-blocking audit logging to `token_audit_log` in `global.db` with rolling retention.
