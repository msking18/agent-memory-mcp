# Multi-Folder Workspace Policies & Remote/Git-Aware Project Identity

- **Status:** Draft (Pending Approval)
- **Date:** 2026-11-23
- **Target Package:** `@getsugatension/agent-memory-mcp` (`v3.2.0` -> `v3.3.0`)
- **Scope Size:** Full Project — touches `src/paths.js`, `src/session-start-hook.js`, `src/store/helpers.js`, `src/store/crud.js`, `src/store/dead-ends.js`, `src/store/index.js`, `src/tools/project.js`, `src/server.js`, `rules/AGENTS.md`, `skills/agent-memory/SKILL.md` (if present/mirrored), and `test/memory.test.js`.

---

## 1. Intent & Why

Two real-world workspace patterns break or misroute project memory in `agent-memory-mcp` today:

1. **Multi-Folder Workspaces (Cross-Project & Split-Root Workspaces):**
   - Users commonly open Project `A` and add Project `B`'s folder to `A`'s workspace settings (for example, to give the agent file access to a companion tool or library without repetitive permission prompts), or start a new Project `C` with two root folders (`[C1, C2]`).
   - Today, `src/session-start-hook.js` inspects only `workspacePaths[0]` (`A` or `C1`). Secondary folders with existing memory stores are not auto-hydrated, and uninitialized secondary folders are ignored.
   - More dangerously, when an agent working in Project `A` makes an edit in Project `B`'s folder and calls `save_project_memory`, `update_memory_node`, or `record_dead_end` with `project_path: A`, `normalizeWorkspaceRelativePath` stores `../` paths inside `A`'s database (which `checkEntryFileStaleness` silently skips) while `B`'s own database becomes stale and misses architectural invariants/dead-ends.
   - **Core product rule:** Never silently guess how a secondary folder should be initialized or where cross-folder edits should be saved. **Prompt the user**, and persist their decision so they are not asked repeatedly on every new conversation.

2. **Remote Workspaces, Dev Containers, WSL, & Git Worktrees (Pattern 1):**
   - When a workspace resides on an SSH remote, Dev Container, Codespace, or unreachable WSL path—or when an agent/developer opens a local `git worktree` or moves a cloned directory—two failures occur:
     - `validateProjectPath()` in `src/paths.js` runs `fs.statSync()` and fails immediately with `directory does not exist` for remote URIs or non-local paths.
     - Store keys in `getProjectStoreInfo()` are computed solely from `sha256(canonicalPath)`, so git worktrees, moved folders, and identical repos checked out under different mount paths lose access to their existing SQLite store and start `UNINITIALIZED`.
   - **Core scope decision:** Prioritize **Pattern 1** (remote/virtual path tolerance + git/worktree-aware project identity) now, while deferring multi-machine/team DB syncing (Patterns 2–4: cloud DBs, HTTP MCP transport, or git-branch sync) to a future phase.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Multi-root startup hydration:** Inspect all folders in `workspacePaths` during `SessionStart`, collapsing nested subfolders that sit inside another listed root (unless they already own a distinct initialized store), and hydrate initialized stores cleanly.
- **Prompt-once secondary folder policies:** When an uninitialized secondary folder is present, prompt the user to classify it (`independent`, `linked`, or `ignored`) and persist the choice in `projects_index.json` scoped to the `(primary, secondary)` workspace pair.
- **Cross-folder write guardrail:** Prevent `save_project_memory`, `update_memory_node`, and `record_dead_end` from silently storing external/sibling-project file paths in the wrong database; surface the owning store and prompt the user on where to save (`B`, `A`, or both).
- **Zero-process git & worktree identity:** Automatically resolve local git worktrees and moved/renamed clones of the same repository to the same SQLite database by reading `.git` metadata directly with `node:fs` (no `git` child processes).
- **Remote / virtual workspace tolerance:** Accept remote workspace URIs (`vscode-remote://`, `ssh://`, `wsl://`, `devcontainer://`, `remote://`, and unreachable Windows `\\wsl.localhost\...` / `\\wsl$\...` UNC paths) in virtual mode without crashing, while optionally binding them to a normalized `git_remote` identity.
- **100% backward compatibility:** Existing v3.0–v3.2 `.db` files under `~/.ag-memory-mcp/stores/` and existing `projects_index.json` entries (including legacy entries missing `storeKey` or `firstSeenAt`) must continue resolving to the exact same stores without data loss or forced re-indexing.

### Non-Goals (Deferred)
- Real-time synchronization of `.db` files across separate machines or team members via cloud databases, HTTP/SSE transport, or automated git-branch syncing (Patterns 2–4).
- Merged cross-database FTS5 queries across two independent project stores in a single `search_project_memory` call (agents query each independent store explicitly or use `global.db`).
- Watching IDE workspace config files for mid-session folder additions via filesystem daemons (covered via prompt rules + `configure_workspace`).

### Anti-Goals (Failure Conditions Even If Code "Works")
- **Polluting user repositories:** Writing `.ag-workspace.json` or any metadata/config dotfiles inside user project directories. All registry state stays under `getDataRoot()` (`~/.ag-memory-mcp/`).
- **Silent phantom stores from local typos:** Disabling `fs.statSync` `ENOENT` validation for ordinary local paths (`C:\Projects\typo` must still fail loudly).
- **Global suppression from a local ignore:** Treating a folder marked `"ignored"` inside Workspace `A` as ignored when that folder (`B`) is opened standalone as its own primary workspace.
- **Spawning subprocesses or leaking credentials:** Running `git` CLI commands on hot tool paths or storing/hashing `user:token@` credentials from git remote URLs.
- **Nagging the user:** Re-asking how to handle a secondary folder on every new conversation after the user already chose a policy.

---

## 3. Constraints & Existing Invariants

- **Runtime & Dependencies:** Node.js `>=22.5.0`, native `node:sqlite` (`DatabaseSync`), zero new npm dependencies.
- **Cross-Platform Parity:** Must work identically on Windows (`win32`) and POSIX (`linux`/`darwin`), including case-insensitive Windows drive/path normalization vs case-sensitive POSIX paths.
- **Existing Test Contract:** All existing assertions in `test/memory.test.js` must remain green—specifically rejecting relative paths (`./`, `relative/folder`) and non-existent local paths (`/does not exist/i`).
- **Hook Reliability & Budget:** `src/session-start-hook.js` must never throw or exit non-zero on bad input/unreachable secondary folders, and must complete well inside its `3500ms` safety timeout.
- **Atomic & Concurrent-Safe Index Persistence:** All `projects_index.json` mutations must route through a locked read-modify-write helper (`updateProjectsIndex(mutatorFn)`) using a short-lived lockfile (`projects_index.json.lock` with stale-lock eviction mirroring `src/migrate/lock.js`), temp-file-then-rename (`writeFileSync` + `renameSync`) with brief Windows `EPERM`/`EBUSY`/`EACCES` retries, and safe preservation of unknown/existing fields across concurrent Antigravity windows and subagent swarms.

---

## 4. Approaches Considered

| Dimension | Option A: Relaxed `statSync` + Prompt-Only Rules | Option B: Index-Backed Git Identity + Workspace Role Registry (Selected) | Option C: In-Repo `.ag-workspace.json` Manifest |
| :--- | :--- | :--- | :--- |
| **Complexity** | Low | Medium | Medium |
| **Reversibility** | High (Two-Way Door) | High (Two-Way Door; 100% v3.2 backward-compatible) | Low (Leaves dotfiles in user repos) |
| **Maintenance Burden** | Minimal code, high prompt fragility | Low (Pure `node:fs` + `projects_index.json`, zero external deps) | Medium |
| **Primary Failure Mode** | Local typos create ghost DBs; worktrees lose memory; users get re-prompted every session about ignored folders | Slightly richer path/index resolution logic in `src/paths.js` | Violates "keep repository trees 100% clean" invariant by dirtying `git status` |

**Decision:** **Option B** was selected. Option A fails the anti-nagging and typo-safety goals and leaves git worktrees orphaned; Option C violates repository cleanliness.

---

## 5. Detailed Design (Option B)

### 5.1 Zero-Process Git & Worktree Identity (`src/paths.js`)

For any locally accessible directory (`isRemote === false`), `detectGitIdentity(canonicalPath)` resolves repository identity using bounded filesystem reads (`MAX_GIT_FILE_BYTES = 262144` / 256 KB) without spawning any child processes, returning `{ gitIdentity, gitCommonDir, gitWorkTreeRoot, isWorktree, repoSubpath }` (or `null` for non-git folders):

1. **Upward `.git` discovery:**
   - Walk upward from `canonicalPath` to the filesystem root (bounded to 64 levels) checking `path.join(dir, ".git")`.
   - Record `gitWorkTreeRoot = dir`.
2. **Directory vs. Worktree/Submodule pointer (including bare-repo worktrees):**
   - If `.git` is a **directory**: `gitDir = dotGitPath`, `gitCommonDir = dotGitPath`, `isWorktree = false`.
   - If `.git` is a **file** (used by `git worktree`, bare-repo sibling worktrees via `git clone --bare`, and submodules): read its contents and parse `gitdir:\s*(.+)`. Resolve relative to `gitWorkTreeRoot` to get `gitDir`.
   - Inside `gitDir`, check for a `commondir` file; if present, read it and resolve relative to `gitDir` to obtain `gitCommonDir` (for both standard worktrees and `git clone --bare` sibling worktrees pointing into `<bare>/worktrees/<name>`, this resolves to the shared repo `.git` / bare root directory; `isWorktree = gitCommonDir !== gitDir` and `gitWorkTreeRoot` remains the worktree folder so `repoSubpath === ""` across all sibling worktrees).
3. **Remote extraction from `<gitCommonDir>/config` & Root-Commit Fallback:**
   - Read `<gitCommonDir>/config` (up to 256 KB) and parse INI `[remote "<name>"]` sections (handling tabs/whitespace, inline `#`/`;` comments, and case-insensitive section header types).
   - Prefer `[remote "origin"]` `url = ...`; if `origin` does not exist, fall back to the first `[remote "..."]` section with a `url` entry.
   - Normalize the URL with `normalizeGitRemoteUrl(rawUrl)`:
     - Strip credentials (`https://user:pass@github.com/...` -> `https://github.com/...`, `ssh://git@host/...` -> `ssh://host/...`).
     - Normalize SCP-style SSH syntax (`git@github.com:Owner/Repo.git` or `host:org/repo`) and scheme URLs (`https://`, `http://`, `ssh://`, `git://`) into canonical `<host>/<owner>/<repo>` form. Note: custom SSH host aliases (e.g., `git@github-work:org/repo.git`) normalize cleanly as `github-work/org/repo` without parsing `~/.ssh/config`, and switching between HTTPS and an SSH alias in the same checkout preserves both via `gitIdentityAliases[]`.
     - Drop default ports (`:22` for ssh, `:80` for http, `:443` for https; preserve non-standard ports like `:2222`).
     - Strip trailing slashes and trailing `.git`, and lowercase `<host>` and `<path>`.
   - If no remote URL exists in `<gitCommonDir>/config` (local-only git repo), perform a bounded read (4 KB) of line 1 of `<gitCommonDir>/logs/HEAD`: if it matches `/^0{40}\s+([0-9a-f]{40})\b/i`, derive `local-git-root:<sha>` (which survives moving or renaming a local-only git repo before pushing to cloud). Only if no commits exist yet (missing/empty `logs/HEAD`), fall back to `local-git:<normalizedGitCommonDir>` (normalized forward-slash path, lowercased on `win32`).
4. **Monorepo Subdirectory Disambiguation:**
   - Compute `repoSubpath = path.relative(gitWorkTreeRoot, canonicalPath).replace(/\\/g, "/")`.
   - If `repoSubpath` is non-empty (and not `.`), append `#<repoSubpath>` (lowercased on `win32` for local paths) to the identity: `<normalizedRemote>#<repoSubpath>`.
   - Result: Opening `packages/api` in a monorepo keeps a separate store from `packages/web`, while a `git worktree` of `packages/api` or the repo root resolves to the exact same `gitIdentity`.

### 5.2 Remote / Virtual Path Parsing & Validation (`src/paths.js`)

`validateOrParseProjectPath(rawPath)` classifies inputs into local vs. remote paths while preserving strict validation for typos and relative paths:

1. **Recognized remote URI schemes:** `vscode-remote:`, `ssh:`, `wsl:`, `devcontainer:`, `remote:`.
   - Note: `file://` continues to be unwrapped to a local path via `fileURLToPath` as before (unless it carries a non-local remote authority).
2. **Windows WSL UNC paths & bidirectional WSL aliasing `(Agent's call)`:**
   - Detect `\\wsl.localhost\<distro>\...` and `\\wsl$\<distro>\...` (or forward-slash equivalents) via `isWslUncPath`.
   - Canonicalize directly to virtual mode (`isRemote: true`, `remoteScheme: "wsl"`, normalized canonical form `wsl://<distro>/<posix-path>`) **without** calling `fs.statSync` or `fs.existsSync` (avoiding Windows 11's `wsl.exe` installer pop-up or cold-booting stopped WSL VMs). Guard legacy WSL UNC entries in `projects_index.json` against `fs.existsSync` during Step 3 / canonical-path checks.
   - **Bidirectional WSL alias matching:** Compute deterministic WSL equivalents (`wsl://<distro>/<posix-path>`, `//wsl.localhost/<distro>/<posix-path>`, `//wsl$/<distro>/<posix-path>`) during Steps 1–3 of store lookup so any `wsl://` virtual URI or WSL UNC path automatically resolves to the same store even when no `gitIdentity` is present.
3. **Remote URI validation & canonicalization:**
   - Reject null bytes (`\0`), ASCII control characters, empty scheme authority/host, or path traversal segments (`..` or `.` after splitting on `/`).
   - Normalize repeated slashes and strip trailing slashes (preserving root `/`).
   - Extract `slug` from the last non-empty POSIX path segment (fallback to authority name, then `"remote-project"`).
   - Return `{ canonicalPath: normalizedRemoteUri, normalizedForHash: normalizedRemoteUri, isRemote: true, remoteScheme }`.
4. **Local path validation (unchanged error contract):**
   - Relative paths (`./`, `relative/folder`) continue throwing `/relative paths/i`.
   - Non-existent local paths continue throwing `Invalid project_path "<resolved>": directory does not exist.` (matching existing `/does not exist/i` tests), enhanced with a short hint: `(If this workspace is on a remote host/container, pass a remote URI such as ssh://host/path or vscode-remote://... instead.)`.
5. **POSIX normalization for remote `files[]` (`normalizeWorkspaceRelativePath`):**
   - `normalizeWorkspaceRelativePath(canonicalProjectPath, targetFile, { isRemote = false } = {})` uses `path.posix` when `isRemote === true` (or when `canonicalProjectPath` matches a remote scheme).
   - If `targetFile` is a remote URI sharing the same scheme/authority prefix, strip that prefix cleanly; if it is a POSIX absolute path (e.g., `/workspaces/app/src/index.ts`) and `canonicalProjectPath` ends with `/workspaces/app`, compute `path.posix.relative` so `src/index.ts` is stored cleanly without Windows `path.resolve` prepending `C:\`.
6. **Enriched `storeInfo` return shape from `getProjectStoreInfo(rawPath, options)`:**
   - Preserves all existing properties (`canonicalPath`, `normalizedForHash`, `hashKey`, `slug`, `storeKey`, `dbFileName`, `dbPath`, `lockPath`, `backupDir`, `legacyJsonPath`) and adds:
     - `isRemote: boolean`
     - `remoteScheme: string | null`
     - `gitIdentity: string | null`
     - `resolvedVia: "index_alias" | "legacy_path_db" | "git_identity" | "new_git_identity" | "new_path_hash"`

### 5.3 `projects_index.json` v4 Schema & Resolution Order (`src/paths.js`)

#### Schema (`version: 4`)
```json
{
  "version": 4,
  "projects": {
    "<storeKey>": {
      "storeKey": "<storeKey>",
      "canonicalPath": "C:\\Users\\mskah\\my-app",
      "aliases": ["C:\\Users\\mskah\\my-app-worktree"],
      "gitIdentity": "github.com/owner/my-app",
      "gitIdentityAliases": [],
      "gitCommonDir": "c:/users/mskah/my-app/.git",
      "isolatedGitIdentity": null,
      "isRemote": false,
      "dbFile": "<storeKey>.db",
      "firstSeenAt": "2026-11-04T07:14:09.188Z",
      "lastAccessedAt": "2026-11-23T19:00:00.000Z"
    }
  },
  "workspacePolicies": {
    "<normalizedPrimaryKey>": {
      "<normalizedSecondaryKey>": {
        "mode": "independent | linked | ignored",
        "targetStoreKey": "<storeKey-of-primary-when-linked>",
        "folderSlug": "tool-b",
        "updatedAt": "2026-11-23T19:00:00.000Z"
      }
    }
  }
}
```

- **Backward-compatible reader (`readProjectsIndex`):**
  - Accepts `version: 3` or `version: 4` files seamlessly, defaulting `workspacePolicies` to `{}` and missing `aliases` to `[]`.
  - Handles legacy entries that lack `storeKey` (falls back to the object key) or `firstSeenAt` (falls back to `updatedAt` or `now`).
- **Workspace policy key normalization:**
  - `<normalizedPrimaryKey>` and `<normalizedSecondaryKey>` use `normalizedForHash` (forward slashes, no trailing slash, lowercased on `win32` for local paths; canonical URI for remote paths) so policy lookups are deterministic regardless of slash style or casing on Windows.

#### Deterministic Store Resolution Order (`getProjectStoreInfo(rawPath, { gitRemote } = {})`)
*(Agent's call: Project-scoped MCP tools do **not** add a `primary_path` parameter; for `linked` secondary folders, agents always pass the primary workspace folder as `project_path`, and read/write helpers normalize paths inside linked folders to `@<folderSlug>/...`.)*

1. **Exact `canonicalPath`, `aliases[]`, or WSL-equivalent match in `projects_index.json`:**
   - Compare `normalizedForHash` (and any WSL-equivalent aliases) against `normalizeForIndexCompare(entry.canonicalPath)` and `entry.aliases`. If matched, reuse that `entry.storeKey` (`resolvedVia: "index_alias"`).
2. **Existing legacy path-hash `.db` on disk:**
   - Compute `legacyPathHashKey = ${slug}-${sha256(normalizedForHash).slice(0, 12)}` (and check WSL equivalents if applicable). If `${storesDir}/${legacyPathHashKey}.db` exists on disk, reuse it (`resolvedVia: "legacy_path_db"`). This guarantees zero-breakage for every existing v3.0–v3.2 database, even if `projects_index.json` was cleared or missing `gitIdentity`.
3. **Git identity match in `projects_index.json` (with Starter Template / Simultaneous Clone Guard):**
   - Determine git context: for local paths use `detectGitIdentity(canonicalPath)` (`{ gitIdentity, gitCommonDir }`); if `gitRemote` option is explicitly provided (e.g., for remote workspaces), normalize `gitRemote` via `normalizeGitRemoteUrl` (respecting any subpath if provided).
   - If `gitIdentity` is non-null, find an existing `projects` entry whose `gitIdentity` or `gitIdentityAliases[]` matches (skipping any entry whose `isolatedGitIdentity` intentionally opted out of sharing unless `canonicalPath` matches directly).
   - **Auto-share silently (`resolvedVia: "git_identity"`) only when:**
     - `isRemote === true`, **OR**
     - `gitCommonDir` matches `entry.gitCommonDir` (true `git worktree` / bare-repo sibling worktree sharing the same `.git` common dir), **OR**
     - `!fs.existsSync(entry.canonicalPath)` (moved/renamed folder — update `entry.canonicalPath` to the new path and preserve the old path in `aliases[]`).
   - **Simultaneous independent local clones (e.g., starter template reuse `git clone next-starter app-1` & `app-2`):**
     - When **both** `canonicalPath` and `entry.canonicalPath` currently exist on disk with **different** `gitCommonDir`s, do **NOT** auto-attach to `entry.storeKey`.
     - Populate `storeInfo.duplicateCloneCandidate = { existingStoreKey: entry.storeKey, existingPath: entry.canonicalPath, gitIdentity }` and resolve provisionally to an uninitialized path-hash store.
     - Surface `[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED]` in `SessionStart` and `check_memory_status` (and guard `save_project_memory` until resolved, unless `force_isolate: true` or configured), instructing the agent to prompt the user: share `entry.storeKey` via `configure_workspace(action: "link_project_identity", project_path, target_store_key)` **or** isolate as a new project via `configure_workspace(action: "link_project_identity", project_path, isolate: true)`.
4. **New store allocation:**
   - If `gitIdentity` is non-null (and not an isolated template clone), hash `"git:" + gitIdentity` (`resolvedVia: "new_git_identity"`); otherwise hash `normalizedForHash` (`resolvedVia: "new_path_hash"`).
   - Format `storeKey = ${slug}-${hashKey}`.

*(Note: `resolvedVia` values: `"index_alias" | "legacy_path_db" | "git_identity" | "new_git_identity" | "new_path_hash"`.)*

- **`gitIdentity` Upgrade Lifecycle & Collision Protection (`registerProjectInIndex` via locked `updateProjectsIndex`):**
  - **Monotonic 4-tier upgrade:** Upgrade `gitIdentity` automatically whenever a stronger live identity is detected: `null` -> `local-git:<commonDir>` -> `local-git-root:<sha>` -> `<normalized-remote-url>` (never freeze an existing entry on `local-git:...` or `local-git-root:...` after a cloud remote is added). If a remote URL later changes (e.g., repo transfer/rename or switching HTTPS <-> SSH alias), update `gitIdentity` to the new normalized remote and preserve the prior non-local value in `gitIdentityAliases[]` (matched during Step 3 lookup).
  - **Duplicate `gitIdentity` collision protection:** Before assigning a `gitIdentity` to store `S1`, check whether a different store `S2` already owns that `gitIdentity`. Never silently overwrite `S2`'s ownership or merge two databases; keep `S1` bound to its `canonicalPath`, record/surface a non-blocking conflict (`gitIdentityConflict: { gitIdentity, conflictingStoreKey }`), and emit a clear `[CONFLICT]` warning in `check_memory_status` and `configure_workspace(action: "inspect")` so the user can decide which store should own that identity.
  - Keep `aliases[]` and `gitIdentityAliases[]` deduplicated and bounded (ignoring duplicates of `canonicalPath` or `gitIdentity`).

### 5.4 Remote-Safe Store Prep & Staleness Checks (`src/store/helpers.js`)

- **`prepareStore(projectPath, { createIfMissing = true, gitRemote } = {})`:**
  - Calls `getProjectStoreInfo(projectPath, { gitRemote })`.
  - When `storeInfo.isRemote === true`: skip `ensureMigratedIfLegacyExists(storeInfo)` and return `migration = { action: "none" }` (no `.ag-memory.json` disk probes on remote URIs).
  - Opens/creates the local SQLite DB at `storeInfo.dbPath` (under `~/.ag-memory-mcp/stores/`) and calls `registerProjectInIndex(storeInfo)` only when the DB exists or `createIfMissing === true`.
- **`checkEntryFileStaleness(canonicalProjectPath, files, updatedAtIso, options = {})`:**
  - If `options.isRemote === true` (or `canonicalProjectPath` is a remote URI), return `{ staleFiles: [], missingFiles: [], skippedRemote: true }` immediately without touching local `fs.statSync`.
  - For linked secondary folder anchors formatted as `@<folderSlug>/<relPath>`: resolve `<folderSlug>` against `options.linkedFoldersBySlug` (looked up from `workspacePolicies` for `canonicalProjectPath`) to stat against the linked folder's local path if accessible; if the linked folder is remote, unavailable locally, or its `<folderSlug>` is no longer present in active `linked` policies (e.g., later unlinked or removed), skip staleness checking for that anchor cleanly rather than joining `@<folderSlug>/...` onto `canonicalProjectPath` and falsely reporting `missingFiles`.

### 5.5 Multi-Folder `SessionStart` Hook (`src/session-start-hook.js`)

Update `runSessionStartPayload(payload)` to handle `payload.workspacePaths`:

1. **Deduplication & Nested Subfolder Collapsing:**
   - Trim non-empty entries and deduplicate using normalized path keys.
   - If `workspacePaths` contains both a parent folder `P` and a subfolder `S` inside `P` (`S` starts with `P + "/"`), collapse `S` **unless**:
     - `S` already has its own distinct initialized store in `projects_index.json` (or on disk), **OR**
     - `S` has its own `.git` directory/pointer file resolving to a distinct `gitCommonDir` from `P` (e.g., a git submodule or nested independent repository) — never swallow separate git repos silently; keep `S` as a real secondary root and prompt the user.
2. **Per-Folder Fault Isolation:**
   - Wrap each folder's resolution/hydration in its own `try/catch` block so one invalid, unmounted, or missing secondary folder never aborts primary hydration or crashes the hook.
3. **Primary Folder (`workspacePaths[0]`):**
   - Hydrate via `checkMemoryStatus(primary, { include_timeline: true, timeline_limit: 5 })` with `[AGENT-MEMORY AUTO-HYDRATED]` or `[AGENT-MEMORY STATUS]`.
   - **Clone disambiguation notice:** If `status.storeInfo.duplicateCloneCandidate` is present, emit `[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED]` listing the existing matching clone (`existingPath` / `existingStoreKey`) and instructing the agent to prompt the user to share or isolate before bootstrapping.
   - **Reverse linked-folder check (Reordered Workspace `[B, A]`):** When any `UNINITIALIZED` root `X` (primary or secondary) is opened alongside another root `Y` in `workspacePaths` where `workspacePolicies[Y][X]?.mode === "linked"`, emit `[AGENT-MEMORY LINKED-ORDER NOTICE]` alerting the user/agent that `X` is already configured as `linked` into `Y`'s store (`@<folderSlug>/...`) rather than prompting from scratch as an unknown folder.
   - **Remote `UNINITIALIZED` hint `(Agent's call)`:** If `status.storeInfo.isRemote === true && !status.initialized && status.storeInfo.resolvedVia === "new_path_hash"`, emit a `[AGENT-MEMORY REMOTE WORKSPACE]` notice instructing the agent to inspect the remote workspace's git origin URL (if it is a git repo) and re-run `check_memory_status(project_path, { git_remote })` (or `configure_workspace(action: "link_project_identity", ...)`) **before** bootstrapping—so an already-memorized repository opened over SSH/container binds to its existing `gitIdentity` store instead of creating a duplicate empty path-hashed store.
4. **Secondary Folders (`workspacePaths[1..n]`):**
   - Read `workspacePolicies[primaryNorm][secNorm]` from `projects_index.json`:
     - **`mode === "ignored"`:** Do not hydrate and do not prompt. (Include a single concise line in a footer: `Ignored secondary folder(s): <path>` so the agent knows it is intentionally excluded.)
     - **`mode === "linked"`:** Note that `<secPath>` is linked to primary's store (`project_path: <primary>`, file anchors prefixed with `@<folderSlug>/`). No separate DB hydration needed.
     - **`mode === "independent"` OR (no policy yet AND folder already has an initialized DB):**
       - Auto-hydrate under a clearly labeled `Secondary Workspace "<canonicalPath>"` section with a compact budget (`timeline_limit: 3`).
       - Cap automatic secondary hydration at **4 secondary folders** per `SessionStart` output to keep initial system prompt size bounded; if more than 4 initialized secondaries exist, list the remaining paths with a note to call `check_memory_status` on demand.
     - **No policy yet AND folder is `UNINITIALIZED`:**
       - Do **NOT** auto-bootstrap and do **NOT** guess.
       - Emit a `[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]` block listing each uninitialized secondary folder and instructing the agent to **ask the user** how to treat it:
         1. `independent` — create & bootstrap its own separate project memory store,
         2. `linked` — store its memories/file anchors in the primary workspace's store (prefixed with `@<folderSlug>/`), or
         3. `ignored` — reference-only / skip project memory in this workspace,
         and persist the user's answer via `configure_workspace(action: "set_folder_policy", ...)`.

### 5.6 Cross-Folder File Guardrail (`src/paths.js`, `src/store/crud.js`, `src/store/dead-ends.js`, `src/store/index.js`)

1. **`classifyWorkspaceFiles(storeInfo, files, { linkedFolders = [] } = {})` in `src/paths.js`:**
   - **Pre-normalization for URIs, drive casing, & symlinks/junctions:**
     - Unwrap `file://` URIs (including Windows `/c:/...` URI prefixes) on input file paths before classification.
     - Compare Windows drive letters case-insensitively on `win32`.
     - If an absolute local path initially resolves outside `storeInfo.canonicalPath`, resolve `fs.realpathSync.native` on the file (or on its deepest existing ancestor directory + remaining relative tail) before classifying it as external—preventing symlinks, Windows NTFS junctions, and macOS `/tmp` -> `/private/tmp` from falsely triggering the guardrail.
   - For each normalized file entry in `files`:
     - If it is already a `@<folderSlug>/<relPath>` anchor matching a configured `linked` folder for `storeInfo`, normalize and keep it under `linkedNormalized`.
     - If it resolves inside `storeInfo.canonicalPath` (relative path does not start with `..` and is not on a different drive/root), normalize via `normalizeWorkspaceRelativePath` into `inWorkspace`.
     - Otherwise (resolves outside `storeInfo.canonicalPath`, e.g., `../B/src/foo.js` or `C:\Projects\B\src\foo.js`), check whether it falls inside a `linked` folder for `storeInfo`:
       - If inside a `linked` folder (`folderSlug`), auto-prefix as `@<folderSlug>/<relToLinkedFolder>` (`linkedNormalized`).
       - Otherwise record it in `externalFiles: [{ input, resolvedPath, ownerCandidate }]`, where `ownerCandidate` scans `projects_index.json` (`canonicalPath` + `aliases`) for the deepest matching tracked project root owning that file path.
2. **Enforcement in Write Paths (`saveProjectMemory`, `updateMemoryNode`, `recordDeadEnd`) & Normalization in Read/Query Paths (`getFileMemories`, `checkDeadEnds`) `(Agent's call)`:**
   - **Read/Query Normalization:** `getFileMemories` (`src/store/file-memories.js`) and `checkDeadEnds` (`src/store/dead-ends.js`) also use `classifyWorkspaceFiles(..., { linkedFolders })` so querying an absolute or relative path inside a `linked` secondary folder (when called with `project_path: <primary>`) normalizes it to `@<folderSlug>/<relPath>` and matches the stored anchors seamlessly.
   - **Batch Atomicity & Write Guardrail:** Add optional `allow_external_files: boolean = false` to `saveProjectMemory`, `updateMemoryNode`, and `recordDeadEnd`.
     - For `saveProjectMemory` batch `entries[]`, validate **all** entries through `classifyWorkspaceFiles` *before* opening the SQLite `BEGIN IMMEDIATE` transaction so the batch either succeeds atomically or fails cleanly with zero partial writes.
     - If `storeInfo.duplicateCloneCandidate` is present and the store has not yet been disambiguated via `configure_workspace` (unless `force_isolate: true`), block accidental bootstrap/writes and prompt the user to link or isolate.
     - If `externalFiles.length > 0` and `allow_external_files !== true`:
       - Abort the write **before** opening a transaction and return `{ isError: true, text: ... }` explaining:
         - Which file path(s) fall outside `project_path`,
         - Which existing project store(s) own those file(s) (if found in `projects_index.json`), and
         - That the agent must **ask the user** whether to save this memory/dead-end to the owning folder's `project_path`, to the current `project_path` (retrying with `allow_external_files: true`), or to both.
   - Note: `cleanFiles()` continues to work identically when `allow_external_files: true` or for in-workspace files, preserving backward compatibility.

### 5.7 New MCP Tool #16 (`configure_workspace`) & Parameter Extensions (`src/tools/project.js`, `src/server.js`)

1. **Tool #16: `configure_workspace` (`WRITE_ANNOTATIONS`):**
   - `action`: `z.enum(["set_folder_policy", "link_project_identity", "inspect"])`
   - Parameters:
     - `project_path` (optional string — used by `inspect` and `link_project_identity`)
     - `primary_path` (optional string — required for `set_folder_policy`)
     - `folder_path` (optional string — required for `set_folder_policy`)
     - `mode` (`z.enum(["independent", "linked", "ignored"])` — required for `set_folder_policy`)
     - `folder_slug` (optional string — custom `@slug` prefix when `mode === "linked"`, defaults to sanitized basename)
     - `source_project_path` (optional string — for `link_project_identity`, looks up an existing store in `projects_index.json` by normalized path without requiring `fs.statSync` so moved/deleted local draft folders can still be carried over)
     - `git_remote` (optional string — for `link_project_identity`)
     - `target_store_key` (optional string — for `link_project_identity`)
     - `isolate` (optional boolean — for `link_project_identity`, marks a simultaneous clone as an independent new project rather than sharing the matching `gitIdentity` store)
     - `workspace_paths` (optional `string[]` — for `inspect`)
   - Behavior:
     - **`set_folder_policy`:** Validates both `primary_path` and `folder_path`, ensures `primary !== folder`, resolves `primary` store (creating index entry if needed, or finding existing), writes `workspacePolicies[primaryNorm][folderNorm]` via locked `updateProjectsIndex`, and returns the saved policy:
       - **Unique `folder_slug` enforcement:** Enforce unique `folder_slug` across all `linked` folders under `workspacePolicies[primaryNorm]`. When `folder_slug` is omitted and the sanitized basename collides (e.g., `frontend/docs` and `backend/docs`), auto-disambiguate deterministically (`<parent-basename>-<basename>`, then `-2`, `-3`, ...). When an explicit `folder_slug` collides with another `linked` folder under the same primary, return an explicit error.
     - **`link_project_identity`:** Validates `project_path`, and accepts `isolate: true` or one of `source_project_path`, `target_store_key`, or `git_remote`:
       - When `isolate: true`: register a new isolated path-hashed store entry in `projects_index.json` for `project_path` with `isolatedGitIdentity` set to the detected git identity (without creating an empty `.db` file on disk) so starter-template clones get their own independent store and never re-trigger clone disambiguation prompts.
       - When `source_project_path` is provided: look up the source entry in `projects_index.json` by normalized path string (**without** requiring `fs.statSync` on `source_project_path`, so moved or deleted old folders can still be linked), append `project_path`'s `normalizedForHash` to that store's `aliases[]`, and upgrade its `gitIdentity` if `project_path` has a detected local git remote or `git_remote` was provided (subject to collision protection).
       - When `target_store_key` is provided: look up that store in `projects_index.json` (error if missing), append `normalizedForHash` to its `aliases[]`, and upgrade `gitIdentity` if applicable.
       - When only `git_remote` is provided: normalize via `normalizeGitRemoteUrl`; if it matches an existing store's `gitIdentity` (or `gitIdentityAliases[]`), append `normalizedForHash` to its `aliases[]` and return that existing `storeKey`. If it matches **no** existing store (brand-new remote repository), pre-register the new `git:`-hashed store entry in `projects_index.json` (with `gitIdentity` and `aliases: [normalizedForHash]`, **without** creating an empty `.db` file on disk so `check_memory_status` still accurately reports `UNINITIALIZED` until bootstrapped) and return `{ storeKey, initialized: false }`.
     - **`inspect`:** Non-mutating read of resolved `storeInfo` (`storeKey`, `isRemote`, `remoteScheme`, `gitIdentity`, `gitCommonDir`, `resolvedVia`, `dbPath`, `duplicateCloneCandidate`), any `gitIdentityConflict`, and active `workspacePolicies` for `project_path` / `workspace_paths`.
2. **Existing Tool Extensions (backward-compatible optional fields):**
   - `check_memory_status` & `save_project_memory`: add optional `git_remote?: string` so agents working on a remote workspace URI can bind/resolve the repo's git remote identity on the very first call.
   - `save_project_memory`: add optional `force_isolate?: boolean` (default `false`) to allow explicit user-approved bootstrap on a simultaneous clone without pre-calling `configure_workspace`.
   - `save_project_memory`, `update_memory_node`, `record_dead_end`: add optional `allow_external_files?: boolean` (default `false`).
3. **Server Metadata (`src/server.js`):**
   - Update `SERVER_INSTRUCTIONS` to document multi-folder prompt-first rules, `configure_workspace`, and remote URI support.
   - `memory://projects` resource automatically reflects v4 `projects_index.json` (including `aliases`, `gitIdentity`, `isRemote`, and `workspacePolicies`).

### 5.8 Rules & Documentation Sync (`rules/AGENTS.md`, `skills/agent-memory/SKILL.md`)

- Update `rules/AGENTS.md`:
  - **Multi-Folder Workspaces:** Clarify that when `SessionStart` flags `[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]` or when files in another workspace folder are accessed/modified, the agent must **ask the user** rather than guessing, persist folder roles via `configure_workspace`, and route edits to the owning `project_path` (or as directed by the user). For folders marked `linked`, always pass the **primary** workspace folder as `project_path`.
  - **Remote Workspaces:** Document passing remote workspace URIs (`vscode-remote://`, `ssh://`, `wsl://`, `devcontainer://`) and optional `git_remote` when working in remote/container environments, and add an explicit Rule 2 note that when `SessionStart` emits `[AGENT-MEMORY REMOTE WORKSPACE]`, the agent should check `git remote` and re-run `check_memory_status(..., { git_remote })` before bootstrapping.
- Sync `C:\Users\mskah\.gemini\config\plugins\agent-memory\rules\AGENTS.md` and `skills/agent-memory/SKILL.md` during implementation so the live installed plugin matches the repository.

---

## 6. What's Left to the Builder

The builder has full discretion over:
- Internal modularization of `src/paths.js` (keeping all existing exported symbols intact, or splitting git/remote/index helpers into `src/paths/*.js` with a re-exporting `src/paths.js` barrel).
- Exact formatting/wording of `SessionStart` secondary workspace headers and `[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]` text, provided the headers clearly distinguish primary vs. secondary paths and surface the 3 policy options (`independent`, `linked`, `ignored`).
- Exact helper decomposition inside `src/store/crud.js`, `src/store/dead-ends.js`, and `src/store/index.js` for the `classifyWorkspaceFiles` guardrail.
- Structure and organization of new unit/integration tests in `test/memory.test.js` (covering local git worktrees, bare-repo sibling worktrees, `.git/config` tabs/comments & SSH aliases, local-only repo moves via root-commit SHA, starter-template simultaneous clone disambiguation vs. moved folders, git submodules not being auto-collapsed, reordered `[B, A]` linked-order notices, duplicate linked folder basenames, unlinked `@slug` staleness skipping, symlinks/junctions & `file://` URIs in `files[]`, batch `entries[]` atomicity, concurrent `projects_index.json` locking, remote URIs, bidirectional WSL fallback, v3->v4 index compatibility, multi-folder `SessionStart` collapsing & policies, and cross-folder write guardrails).
