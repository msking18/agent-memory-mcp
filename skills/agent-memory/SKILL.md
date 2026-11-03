---
name: agent-memory
description: Guide and workflow reference for agent-memory-mcp v3.0 — per-project SQLite + FTS5 architectural memory, atomic bootstrapping, file-anchored invariants, dead-end anti-loop tracking, and legacy .ag-memory.json JIT migration.
---

# Agent Memory (`agent-memory-mcp` v3.0)

`agent-memory-mcp` provides persistent, ACID-safe, full-text searchable memory for every project workspace, backed by Node 22.5+/24+ built-in `node:sqlite` (`WAL` + `FTS5`).

## Storage & Legacy Migration Architecture
- **Central Live Stores:** `~/.ag-memory-mcp/stores/<project-slug>-<hash>.db` (keeps target git repositories 100% clean).
- **Zero-Loss JIT Migration:** Any workspace still containing a legacy `<project_path>/.ag-memory.json` (`v2.0`) is automatically migrated into SQLite + `FTS5` on first tool or `SessionStart` hook access, verified row-by-row, and archived to `~/.ag-memory-mcp/backups/`.

## Tool Quick Reference (10 Tools)

| Tool | Mode | Best Used For |
| :--- | :--- | :--- |
| `check_memory_status` | Read-only | 1-shot check returning initialization state, architecture TOC, dead-end count, and top 5 timeline logs. |
| `get_session_timeline` | Read-only | Chronological feed filterable by `category` (`session`, `architecture`, `decision`, `note`, `all`), `tag`, and `since`. |
| `save_project_memory` | Write/Upsert | Single or atomic batch (`entries: [...]`) save; auto-upserts matching `id` or `slug` while saving prior revisions. |
| `search_project_memory` | Read-only | Weighted `FTS5` BM25 search across `title`, `tags`, `files`, and `summary` (plus matching dead-ends) with snippets. |
| `read_memory_node` | Read-only | Reads single `id` or batch `ids: [...]` (supports slugs like `"tech-stack"`), checking `files[]` disk `mtime` for staleness. |
| `update_memory_node` | Write | Partial update to `title`, `summary`, `tags`, `category`, or `files` with automatic revision backup. |
| `delete_memory_node` | Write | Soft-archives obsolete memories (`hard_delete: false` default) or permanently deletes (`hard_delete: true`). |
| `record_dead_end` | Write | Logs `{ error_pattern, attempted_solution, root_cause, files }` to prevent repeating failed debugging paths. |
| `check_dead_ends` | Read-only | Searches recorded dead-ends by error message, keyword, or `file_path` before attempting a fix. |
| `get_file_memories` | Read-only | Returns all memories and dead-ends anchored to `file_paths: [...]` (or parent directories) before refactoring. |

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
