# Contributing to agent-memory-mcp

Thank you for your interest in contributing! This project provides persistent memory, FTS5 search, and anti-loop dead-end tracking for AI coding agents.

---

## 🛠️ Development Setup

### Prerequisites
- **Node.js**: `>= 22.5.0` (or Node.js 24+) to support built-in `node:sqlite` and `FTS5`.
- **npm**: `>= 10.0.0`

### Setup Steps
1. Fork and clone the repository:
   ```bash
   git clone https://github.com/<your-username>/agent-memory-mcp.git
   cd agent-memory-mcp
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

---

## 🧪 Running Tests

We use Node's built-in native test runner (`node:test`):

```bash
npm test
```

The test suite covers:
- Relative path rejection & store key hashing.
- Lossless JIT migration from legacy `.ag-memory.json` files and backup verification.
- Non-destructive corruption quarantine.
- Atomic batch operations, FTS5 searches, and multi-word OR fallbacks.
- File staleness warnings, dead-end registries, and file-anchored memories.
- Multi-folder workspace policies (`independent`, `linked`, `ignored`), remote URIs, and zero-process git identity linking.
- `SessionStart` hook I/O contracts.
- Stdio MCP JSON-RPC protocol compliance and tool annotations.

---

## 📐 Project Structure

```text
agent-memory-mcp/
├── index.js                  # CLI & MCP stdio entrypoint (Node >= 22.5 check)
├── package.json              # npm package manifest & bin declaration
├── plugin.json               # Google Antigravity Plugin manifest
├── mcp_config.json           # Antigravity MCP server configuration
├── hooks.json                # Antigravity SessionStart hook registration
├── assets/logo.svg           # High-contrast plugin icon
├── rules/AGENTS.md           # Antigravity scoped rules
├── skills/agent-memory/      # Skill reference for AI agents
├── src/
│   ├── paths.js              # Re-export barrel for src/paths/
│   ├── paths/                # Git identity, remote URIs, file classifier & registry/
│   ├── db.js                 # Re-export barrel for src/db/
│   ├── db/                   # SQLite WAL connection, FTS5 search & schema migrations
│   ├── migrate.js            # Re-export barrel for src/migrate/
│   ├── migrate/              # Zero-data-loss JIT legacy migrator & lock manager
│   ├── store.js              # Re-export barrel for src/store/
│   ├── store/                # Business logic for all 16 MCP tools
│   ├── tools/                # McpServer tool registrations (project, dead-ends, workspace, global)
│   ├── server.js             # McpServer instance & transport initialization
│   └── session-start-hook.js # Multi-folder SessionStart context injector
└── test/
    ├── helpers/              # Shared test fixtures & MCP client helpers
    ├── core/                 # Core v3.0–v3.2 memory, FTS5, global & token budget suites
    └── workspaces/           # Multi-folder workspace, git identity & remote URI suites
```

---

## 📜 Pull Request Guidelines

1. Make sure all automated tests pass (`npm test`).
2. If adding or modifying an MCP tool, add corresponding test cases under `test/core/` or `test/workspaces/` (and ensure they are executed by `npm test`).
3. Keep runtime dependencies to an absolute minimum (the engine relies on standard Node APIs and `@modelcontextprotocol/sdk`).
4. Keep every `.js` file at or below 500 physical lines and follow the existing code style conventions.
