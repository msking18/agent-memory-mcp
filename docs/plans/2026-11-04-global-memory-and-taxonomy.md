# Centralized Global Knowledge Graph & Dead-End Taxonomy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a centralized cross-project knowledge graph (`global.db`), a two-tier dead-end taxonomy (`error_loop` vs. `architectural` with `reopen_dead_end`), and a machine-wide token budget guardrail and audit logger (`token_audit_log`) in `agent-memory-mcp`.

**Architecture:** SQLite WAL + FTS5 with separation of concerns: project-specific notes remain isolated in `stores/*.db`, while machine-wide patterns, library quirks, and token audit logs reside in `~/.ag-memory-mcp/global.db`. Unified store functions route `g-` prefixed IDs automatically to the global database, and output from every MCP tool passes through a configurable sentence-boundary token budgeter.

**Tech Stack:** Node.js 22.5+/24+ native `node:sqlite` (DatabaseSync), `@modelcontextprotocol/sdk` (v1.29+), `zod` (v4+), native `node:test` + `node:assert/strict`.

---

### Task 1: Path Helpers & Config Loader (`src/paths.js`)

**Files:**
- Modify: `src/paths.js`
- Test: `test/memory.test.js`

**Step 1: Write the failing test**
In `test/memory.test.js`, add assertions for `getGlobalDbPath()`, `getConfigPath()`, and `loadConfig()`:
```javascript
import { getGlobalDbPath, getConfigPath, loadConfig } from "../src/paths.js";

// Inside beforeEach setup:
assert.equal(getGlobalDbPath(), path.join(dataDir, "global.db"));
assert.equal(getConfigPath(), path.join(dataDir, "config.json"));

const defaultConfig = loadConfig();
assert.equal(defaultConfig.max_response_tokens, 1000);
assert.equal(defaultConfig.enable_audit_logging, true);
assert.equal(defaultConfig.max_audit_log_entries, 2000);
```

**Step 2: Run test to verify it fails**
Run:
```powershell
npm test
```
Expected: FAIL with `getGlobalDbPath is not a function` or `loadConfig is not a function`.

**Step 3: Write minimal implementation**
In `src/paths.js`:
```javascript
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
```

**Step 4: Run test to verify it passes**
Run:
```powershell
npm test
```
Expected: PASS

**Step 5: Commit**
```powershell
git add src/paths.js test/memory.test.js
git commit -m "feat(paths): add global DB path and config loader"
```

---

### Task 2: Schema Migrations, Global DB, FTS5 & Audit Logging (`src/db.js`)

**Files:**
- Modify: `src/db.js`
- Test: `test/memory.test.js`

**Step 1: Write the failing test**
In `test/memory.test.js`, add assertions verifying:
1. `openGlobalDatabase()` initializes tables `global_memories`, `global_memories_fts`, and `token_audit_log`.
2. Existing project `dead_ends` table receives migration columns `kind`, `constraints_json`, `status`, `reopened_reason`, `updated_at`.
3. `logTokenAudit()` records entry and prunes log when exceeding `max_audit_log_entries`.

**Step 2: Run test to verify it fails**
Run:
```powershell
npm test
```
Expected: FAIL with `openGlobalDatabase is not a function`.

**Step 3: Write minimal implementation**
In `src/db.js`:
1. Add `GLOBAL_SCHEMA_SQL`:
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
2. In `initializeDatabaseInstance(db)` for project stores, add idempotent schema migration for `dead_ends`:
```javascript
const existingCols = db.prepare("PRAGMA table_info(dead_ends)").all().map((c) => c.name);
if (!existingCols.includes("kind")) {
    db.exec("ALTER TABLE dead_ends ADD COLUMN kind TEXT NOT NULL DEFAULT 'error_loop'");
}
if (!existingCols.includes("constraints_json")) {
    db.exec("ALTER TABLE dead_ends ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]'");
}
if (!existingCols.includes("status")) {
    db.exec("ALTER TABLE dead_ends ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}
if (!existingCols.includes("reopened_reason")) {
    db.exec("ALTER TABLE dead_ends ADD COLUMN reopened_reason TEXT");
}
if (!existingCols.includes("updated_at")) {
    db.exec("ALTER TABLE dead_ends ADD COLUMN updated_at TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_dead_ends_kind_status ON dead_ends(kind, status, created_at DESC)");
```
3. Implement `openGlobalDatabase({ cache = true })`:
```javascript
export function openGlobalDatabase({ cache = true } = {}) {
    const globalPath = path.resolve(getGlobalDbPath());
    if (cache && dbCache.has(globalPath)) {
        return dbCache.get(globalPath);
    }
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    const db = new DatabaseSync(globalPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
    `);
    db.exec(GLOBAL_SCHEMA_SQL);
    if (cache) {
        dbCache.set(globalPath, db);
    }
    return db;
}
```
4. Implement `syncGlobalMemoryFts`, `removeGlobalMemoryFts`, `searchGlobalFts`, `logTokenAudit`, and `queryTokenMetrics`.

**Step 4: Run test to verify it passes**
Run:
```powershell
npm test
```
Expected: PASS

**Step 5: Commit**
```powershell
git add src/db.js test/memory.test.js
git commit -m "feat(db): add global.db schema, FTS5, token audit log, and dead_ends migrations"
```

---

### Task 3: Token Budgeting Engine & Audit Metrics (`src/store.js`)

**Files:**
- Modify: `src/store.js`
- Test: `test/memory.test.js`

**Step 1: Write the failing test**
In `test/memory.test.js`:
1. Test token estimation heuristic `estimateTokens(text)`.
2. Test `applyTokenBudget(text, toolName, projectPath, { maxTokens })` with text below limit (unmodified) and text above limit (trimmed at sentence boundary with truncation note).
3. Test `getTokenMetrics({ timeframe_hours, limit })` returns structured aggregated metrics and records in `token_audit_log`.

**Step 2: Run test to verify it fails**
Run:
```powershell
npm test
```
Expected: FAIL with `applyTokenBudget is not a function`.

**Step 3: Write minimal implementation**
In `src/store.js`:
```javascript
export function estimateTokens(str) {
    if (!str || typeof str !== "string") return 0;
    return Math.ceil(str.length / 3.8);
}

export function trimToSentenceBoundary(text, maxChars) {
    if (text.length <= maxChars) return text;
    const slice = text.slice(0, maxChars);
    const lastBoundary = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("! "),
        slice.lastIndexOf("? ")
    );
    if (lastBoundary > maxChars * 0.6) {
        return slice.slice(0, lastBoundary + 1).trim();
    }
    return slice.trim();
}

export function applyTokenBudget(rawText, toolName, projectPath = null, options = {}) {
    const config = loadConfig();
    const maxTokens = typeof options.maxTokens === "number" ? options.maxTokens : config.max_response_tokens;
    const bypass = options.bypass === true || maxTokens === 0;

    const rawTokenEst = estimateTokens(rawText);
    const inputTokenEst = typeof options.inputTokens === "number" ? options.inputTokens : 50;

    let budgetedText = rawText;
    let truncated = false;

    if (!bypass && rawTokenEst > maxTokens) {
        const targetChars = Math.floor(maxTokens * 3.8);
        const trimmed = trimToSentenceBoundary(rawText, targetChars);
        budgetedText = `${trimmed}\n\n[TRUNCATED: Output exceeded token budget of ~${maxTokens} tokens (~${rawTokenEst} raw tokens). Configure max_response_tokens in ~/.ag-memory-mcp/config.json or pass full_content: true / bypass]`;
        truncated = true;
    }

    const budgetedTokenEst = estimateTokens(budgetedText);

    if (config.enable_audit_logging) {
        try {
            const globalDb = openGlobalDatabase();
            logTokenAudit(globalDb, {
                timestamp: new Date().toISOString(),
                tool_name: toolName,
                project_path: projectPath,
                input_tokens: inputTokenEst,
                output_tokens_raw: rawTokenEst,
                output_tokens_budgeted: budgetedTokenEst,
                truncated: truncated ? 1 : 0
            }, config.max_audit_log_entries);
        } catch {
            // Non-blocking error handling for audit logging
        }
    }

    return {
        text: budgetedText,
        rawTokens: rawTokenEst,
        budgetedTokens: budgetedTokenEst,
        truncated
    };
}

export function getTokenMetrics({ timeframe_hours = 24, limit = 50 } = {}) {
    const globalDb = openGlobalDatabase();
    return queryTokenMetrics(globalDb, { timeframeHours: timeframe_hours, limit });
}
```

**Step 4: Run test to verify it passes**
Run:
```powershell
npm test
```
Expected: PASS

**Step 5: Commit**
```powershell
git add src/store.js test/memory.test.js
git commit -m "feat(store): add token budget trimming and audit log metrics"
```

---

### Task 4: Global Knowledge CRUD & Promotion (`src/store.js`)

**Files:**
- Modify: `src/store.js`
- Test: `test/memory.test.js`

**Step 1: Write the failing test**
In `test/memory.test.js`:
1. Test `saveGlobalKnowledge` saves entry with `g-` ID prefix and indexes in `global_memories_fts`.
2. Test `searchGlobalKnowledge` finds match by keywords and stems, ranked by BM25.
3. Test `promoteToGlobal(projectPath, { memory_id, tech_stack })` reads project note and copies to `global.db`.
4. Test `readMemoryNode`, `updateMemoryNode`, `deleteMemoryNode` handle `g-` prefixed IDs seamlessly without needing a valid project path.
5. Test `full_content: true` in `readMemoryNode` bypasses preview/token budget trimming.

**Step 2: Run test to verify it fails**
Run:
```powershell
npm test
```
Expected: FAIL with `saveGlobalKnowledge is not a function`.

**Step 3: Write minimal implementation**
In `src/store.js`:
1. Implement `saveGlobalKnowledge({ id, title, summary, category, tags, tech_stack, source_project })`.
2. Implement `searchGlobalKnowledge({ query, category, tech_stack, limit })`.
3. Implement `promoteToGlobal(projectPath, { memory_id, tech_stack, category })`.
4. Update `readMemoryNode`, `updateMemoryNode`, and `deleteMemoryNode` to route `g-` IDs to `global.db`.

**Step 4: Run test to verify it passes**
Run:
```powershell
npm test
```
Expected: PASS

**Step 5: Commit**
```powershell
git add src/store.js test/memory.test.js
git commit -m "feat(store): add global knowledge CRUD, g- prefix routing, and promote_to_global"
```

---

### Task 5: Dead-End Taxonomy & Reopening (`src/store.js`)

**Files:**
- Modify: `src/store.js`
- Test: `test/memory.test.js`

**Step 1: Write the failing test**
In `test/memory.test.js`:
1. Test `recordDeadEnd` with `kind: "architectural"` and `constraints: ["Must not add Redis"]`.
2. Test `checkDeadEnds` filtering with `kind: "error_loop"`, `kind: "architectural"`, and `kind: "all"`.
3. Verify distinct formatting: `[DEAD-END ERROR LOOP]` vs. `[ARCHITECTURAL CONSTRAINT / TRADE-OFF]`.
4. Test `reopenDeadEnd(projectPath, { id, reason })` transitions status to `'reopened'` and suppresses it from subsequent active dead-end queries.

**Step 2: Run test to verify it fails**
Run:
```powershell
npm test
```
Expected: FAIL with `reopenDeadEnd is not a function`.

**Step 3: Write minimal implementation**
In `src/store.js`:
1. In `recordDeadEnd`: accept `kind` and `constraints`.
2. In `checkDeadEnds`: filter by `status = 'active'` and `kind`, format output cleanly.
3. Implement `reopenDeadEnd(projectPath, { id, reason })`.

**Step 4: Run test to verify it passes**
Run:
```powershell
npm test
```
Expected: PASS

**Step 5: Commit**
```powershell
git add src/store.js test/memory.test.js
git commit -m "feat(store): add dead-end taxonomy, constraints tracking, and reopen_dead_end"
```

---

### Task 6: MCP Server Tool Registration & Token Budget Middleware (`src/server.js`)

**Files:**
- Modify: `src/server.js`
- Test: `test/memory.test.js`

**Step 1: Write the failing test**
In `test/memory.test.js`:
1. Test server registration of all 15 tools.
2. Call `search_global_knowledge`, `save_global_knowledge`, `promote_to_global`, `reopen_dead_end`, `get_token_metrics` via MCP client.
3. Verify that tool responses respect token budget and output formatting.

**Step 2: Run test to verify it fails**
Run:
```powershell
npm test
```
Expected: FAIL with missing tool registrations or schema mismatches.

**Step 3: Write minimal implementation**
In `src/server.js`:
1. Update `wrapHandler` to pass every tool execution result through `applyTokenBudget(res.text, toolName, args?.project_path)`.
2. Register 5 new tools (`save_global_knowledge`, `search_global_knowledge`, `promote_to_global`, `reopen_dead_end`, `get_token_metrics`).
3. Update existing tool schemas (`record_dead_end`, `check_dead_ends`, `read_memory_node`, `update_memory_node`, `delete_memory_node`).
4. Update server instructions and version to `3.1.0`.

**Step 4: Run test to verify it passes**
Run:
```powershell
npm test
```
Expected: PASS

**Step 5: Commit**
```powershell
git add src/server.js test/memory.test.js
git commit -m "feat(server): register 15 MCP tools and wire token budget middleware"
```

---

### Task 7: Comprehensive Automated Tests (`test/memory.test.js`)

**Files:**
- Modify: `test/memory.test.js`

**Step 1: Expand test coverage**
Add distinct test blocks:
- Test 8: Global knowledge CRUD (save, FTS search with BM25, update, delete via `g-` IDs).
- Test 9: Memory promotion (`promote_to_global`) from project store to `global.db`.
- Test 10: Dead-end taxonomy (`error_loop` vs `architectural` with `constraints`) and `reopen_dead_end`.
- Test 11: Token budget capping, sentence trimming, `full_content` bypass, and `token_audit_log` rolling rotation (capped at limit).
- Test 12: Full MCP Stdio JSON-RPC protocol with 15 registered tools and tool calls.

**Step 2: Run all tests to verify 100% pass**
Run:
```powershell
npm test
```
Expected: PASS with 12/12 tests passing.

**Step 3: Commit**
```powershell
git add test/memory.test.js
git commit -m "test: add comprehensive test suite for global memory, taxonomy, and token metrics"
```

---

### Task 8: Documentation, Plugin Rules & Bump (`README.md`, `rules/AGENTS.md`, `package.json`, `plugin.json`)

**Files:**
- Modify: `README.md`
- Modify: `rules/AGENTS.md`
- Modify: `package.json`
- Modify: `plugin.json`
- Copy to active plugin: `C:/Users/mskah/.gemini/config/plugins/agent-memory/`

**Step 1: Update documentation and rules**
1. In `README.md`: document 15 tools, global memory, dead-end taxonomy, token budget.
2. In `rules/AGENTS.md`: guidelines for global search, promotion, architectural dead-ends.
3. Bump version to `3.1.0`.
4. Sync updated files to local active Antigravity plugin.

**Step 2: Verify git status and run test suite**
Run:
```powershell
npm test
git status
```
Expected: PASS and clean working tree.

**Step 3: Commit and Push**
```powershell
git add .
git commit -m "docs: document global knowledge graph, taxonomy, token audit, and bump to v3.1.0"
git push origin main
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-11-04-global-memory-and-taxonomy.md`. Two execution options:

1. **Subagent-Driven (this session)** - Dispatch fresh subagent per task, review between tasks, fast iteration.
2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints.

Which approach?
