# Privacy Policy for agent-memory-mcp

**Last Updated:** November 8, 2026  
**Package:** `@getsugatension/agent-memory-mcp`  
**Maintainer:** [Manveer Singh Kahlon](https://github.com/msking18)

---

## Overview

`agent-memory-mcp` is an open-source Model Context Protocol (MCP) server providing persistent architectural memory, cross-project pattern discovery, and anti-loop dead-end tracking for AI coding agents.

Privacy and data isolation are core architectural invariants of this project. **All memory storage, indexing, and search operations execute 100% locally on your machine.**

---

## Data Collection & Storage

1. **Local SQLite Databases Only:**
   - Project-scoped memories and anti-loop dead-ends are stored locally on your filesystem in SQLite databases under `~/.ag-memory-mcp/projects/` (or in `<project>/.ag-memory/` when configured).
   - Global architectural patterns and token audit records are stored in `~/.ag-memory-mcp/global.db`.
2. **Zero Remote Transmission:**
   - The server communicates exclusively via local standard input/output (`stdio`) JSON-RPC with your AI assistant or client (e.g. Google Antigravity, Claude Code, Cursor, Windsurf, Cline).
   - No data stored in or processed by `agent-memory-mcp` is ever transmitted to remote servers, external APIs, or cloud providers.
3. **No Telemetry or Tracking:**
   - `agent-memory-mcp` contains zero tracking pixels, telemetry probes, or analytics hooks.
   - Diagnostic and audit metrics recorded by the token budgeting middleware (`get_token_metrics`) remain stored solely within your local `global.db`.

---

## Third-Party Services & Dependencies

- `agent-memory-mcp` does not integrate with any third-party marketing, analytics, or behavioral tracking SDKs.
- Its runtime dependencies are strictly limited to official, audited open-source libraries (`@modelcontextprotocol/sdk` and `zod`), with zero external database daemons required.

---

## User Control & Data Retention

You have complete ownership and control over all data created by `agent-memory-mcp`:
- **Read & Export:** You can inspect or query your local databases at any time using SQLite client tools or through the MCP tools (`read_memory_node`, `search_project_memory`, `search_global_knowledge`).
- **Deletion:** You can soft-archive or permanently delete individual nodes using `delete_memory_node` with `hard_delete: true`.
- **Complete Erasure:** Deleting the `~/.ag-memory-mcp` directory permanently removes all stored memories, global patterns, and audit logs from your system.

---

## Contact & Compliance

If you have questions, feedback, or concerns regarding security or privacy, please open an issue on the official GitHub repository:
- **Repository:** https://github.com/msking18/agent-memory-mcp
- **Issues:** https://github.com/msking18/agent-memory-mcp/issues
