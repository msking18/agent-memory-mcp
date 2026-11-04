---
name: agent-memory
description: Guide and workflow reference for agent-memory-mcp v3.1 — per-project SQLite + FTS5 architectural memory, centralized global knowledge graph, two-tier dead-end taxonomy, token budgeting middleware, and legacy .ag-memory.json JIT migration.
---

# Agent Memory (`agent-memory-mcp` v3.1)

`agent-memory-mcp` provides persistent, ACID-safe, full-text searchable memory for AI coding agents. Backed by Node 22.5+/24+ native `node:sqlite` (`WAL` + `FTS5`), it features per-project databases, a centralized cross-project global knowledge graph, a two-tier anti-loop dead-end registry, and token budgeting middleware.

## Storage Architecture
- **Per-Project Live Stores:** `~/.ag-memory-mcp/stores/<project-slug>-<hash>.db` (keeps repository trees 100% clean).
- **Central Global Knowledge Graph:** `~/.ag-memory-mcp/global.db` (cross-project patterns, library quirks, and token audit logs).
- **Configuration:** `~/.ag-memory-mcp/config.json` (or `AG_MEMORY_MAX_RESPONSE_TOKENS` environment variable).
- **Zero-Loss JIT Migration:** Automatically detects, verifies, and archives legacy `<project_path>/.ag-memory.json` (`v2.0`) to `~/.ag-memory-mcp/backups/`.

## Tool Quick Reference (15 Tools)

### Project-Scoped Memory Tools (1–10)
| Tool | Mode | Best Used For |
| :--- | :--- | :--- |
| `check_memory_status` | Read-only | 1-shot check returning initialization state, architecture TOC, dead-end count, and top 5 timeline logs. |
| `get_session_timeline` | Read-only | Chronological feed filterable by `category` (`session`, `architecture`, `decision`, `note`, `all`), `tag`, and `since`. |
| `save_project_memory` | Write/Upsert | Single or atomic batch (`entries: [...]`) save; auto-upserts matching `id` or `slug` while archiving prior revisions. |
| `search_project_memory` | Read-only | Weighted `FTS5` BM25 search across `title`, `tags`, `files`, and `summary` (plus matching dead-ends) with snippets. |
| `read_memory_node` | Read-only | Reads single `id` or batch `ids: [...]` (supports slugs like `"tech-stack"` or `"g-..."` global IDs), checking `files[]` disk `mtime` for staleness. |
| `update_memory_node` | Write | Partial update to `title`, `summary`, `tags`, `category`, or `files` with automatic revision backup. |
| `delete_memory_node` | Write | Soft-archives obsolete memories (`hard_delete: false` default) or permanently deletes (`hard_delete: true`). |
| `record_dead_end` | Write | Logs `{ error_pattern, attempted_solution, root_cause, files, kind, constraints }` (`error_loop` vs `architectural`). |
| `check_dead_ends` | Read-only | Searches recorded dead-ends by error message, keyword, or `file_path`, filterable by `kind`. |
| `get_file_memories` | Read-only | Returns all memories and dead-ends anchored to `file_paths: [...]` (or parent directories) before refactoring. |

### Global Knowledge & Taxonomy Tools (11–15)
| Tool | Mode | Best Used For |
| :--- | :--- | :--- |
| `save_global_knowledge` | Write | Saves cross-project patterns or library quirks to `global.db` (auto-generates `g-` prefixed IDs). |
| `search_global_knowledge` | Read-only | BM25 ranked FTS5 search across global patterns, filterable by `tech_stack` and `category`. |
| `promote_to_global` | Write | Promotes a validated project-specific memory node into the machine-wide global knowledge graph. |
| `reopen_dead_end` | Write | Reopens a past dead-end when external constraints, library updates, or requirements change. |
| `get_token_metrics` | Read-only | Retrieves machine-wide token efficiency statistics and audit logs from `global.db`. |

## Canonical Bootstrap Pattern (Single Atomic Call)

When initializing a new project workspace, save all 3 core architectural nodes in **one** atomic transaction:

```json
{
  "project_path": "C:/Projects/MyApp",
  "entries": [
    {
      "slug": "tech-stack",
      "title": "Tech Stack & Ecosystem",
      "category": "architecture",
      "tags": ["architecture", "stack"],
      "summary": "..."
    },
    {
      "slug": "project-structure",
      "title": "Project Structure & Architecture",
      "category": "architecture",
      "tags": ["architecture", "structure"],
      "files": ["src/index.ts"],
      "summary": "..."
    },
    {
      "slug": "build-run",
      "title": "Build & Run Instructions",
      "category": "architecture",
      "tags": ["architecture", "build"],
      "files": ["package.json"],
      "summary": "..."
    }
  ]
}
```
