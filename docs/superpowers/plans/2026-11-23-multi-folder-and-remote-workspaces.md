# Multi-Folder Workspace Policies & Remote/Git-Aware Project Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement index-backed git/worktree identity, remote URI virtual path mode, prompt-first multi-folder workspace policies, cross-folder file write guardrails, and the `configure_workspace` MCP tool in `agent-memory-mcp` v3.3.0.

**Architecture:** Modularize `src/paths.js` into a barrel facade over `src/paths/{git,remote,registry,files,index}.js` matching the existing `src/{db,migrate,store,tools}/` pattern, persist v4 project aliases and `(primary, secondary)` workspace policies in a lock-protected `projects_index.json`, enforce cross-folder and clone-disambiguation guardrails across `src/store/*` and `src/session-start-hook.js`, and expose Tool #16 (`configure_workspace`) plus backward-compatible optional parameters on existing tools.

**Tech Stack:** Node.js `>=22.5.0` (ESM), native `node:sqlite` (`DatabaseSync`), `node:test` + `node:assert/strict`, `@modelcontextprotocol/sdk` (`^1.32.2`), `zod` (`^4.6.7`), zero new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-23-multi-folder-and-remote-workspaces-design.md`

---

## Global Constraints

- Node.js `>=22.5.0`, native `node:sqlite`, zero new npm dependencies.
- Zero dotfiles or config files written inside user repositories; all registry and store state stays under `getDataRoot()` (`~/.ag-memory-mcp/`).
- Cross-platform parity on Windows (`win32`) and POSIX (`linux`/`darwin`); `npm test` must pass on all 3 OSes in `.github/workflows/ci.yml` without shell globbing (explicit file paths in `package.json` `"test"` script).
- 100% backward compatibility with existing v3.0–v3.2 SQLite `.db` files and legacy `projects_index.json` entries (including entries missing `storeKey` or `firstSeenAt`).
- Strict local path validation preserved: `./` and `relative/folder` throw `/relative paths/i`; non-existent local paths throw `/does not exist/i`.
- Zero `git` child processes spawned on hot tool paths; bounded file reads (`MAX_GIT_FILE_BYTES = 262144` bytes; `logs/HEAD` read capped at `4096` bytes); never store or hash credentials from git remote URLs.
- `src/session-start-hook.js` must never throw, must isolate failures per workspace folder, and must complete well within its `3500ms` safety timer.
- All `projects_index.json` mutations use locked read-modify-write (`updateProjectsIndex`) with stale-lock eviction and Windows `EPERM`/`EBUSY`/`EACCES` rename retries.

## Review Focus

1. Corrupt/unreadable `.git` pointer file or oversized `.git/config` (>256 KB) -> `detectGitIdentity` falls back cleanly to `null` without throwing. *(Pinned in Task 1)*
2. Percent-encoded spaces in remote URIs (`vscode-remote://ssh-remote+host/home/dev/My%20App`) vs. encoded path traversal (`%2e%2e`) -> valid encoded spaces canonicalize cleanly while encoded traversal is rejected. *(Pinned in Task 2)*
3. Corrupt/truncated `projects_index.json` or stale `projects_index.json.lock` left by a dead PID -> `readProjectsIndex` recovers safely and `updateProjectsIndex` evicts the dead-PID lock without hanging. *(Pinned in Task 3)*
4. Windows cross-drive file paths (`D:\Other\file.ts` against `C:\Primary\app`) and in-workspace scoped package paths (`node_modules/@types/node/index.d.ts`) -> cross-drive paths flag as external, while nested `/@scope/` paths are never mistaken for linked-folder `@<slug>/` anchors. *(Pinned in Task 4)*
5. Mixed valid + unreachable/deleted secondary folders in `workspacePaths` and >4 initialized secondaries -> per-folder fault isolation keeps primary and remaining secondaries hydrated, while >4 initialized secondaries cap auto-hydration at 4 and list the overflow as on-demand. *(Pinned in Task 6)*

---

## File Structure

- Create `src/paths/git.js`: Zero-process `.git`/`commondir`/bare-worktree discovery, bounded `.git/config` INI remote parser, URL credential-stripping normalizer, and `logs/HEAD` root-commit SHA fallback.
- Create `src/paths/remote.js`: Remote URI scheme validator/canonicalizer (`vscode-remote:`, `ssh:`, `wsl:`, `devcontainer:`, `remote:`), Windows WSL UNC fallback + bidirectional WSL aliasing, and strict local path validation.
- Create `src/paths/registry.js`: Lock-protected `projects_index.json` v4 store, 4-step `getProjectStoreInfo` resolution, `gitIdentity` upgrade lifecycle + collision detection, simultaneous clone guard, and workspace policy / identity-linking operations.
- Create `src/paths/files.js`: Remote/POSIX-aware `normalizeWorkspaceRelativePath` and `classifyWorkspaceFiles` (`file://` unwrapping, symlink/junction `realpathSync` fallback, `@<folderSlug>/` mapping, external owner detection).
- Create `src/paths/index.js`: Root data/config path helpers (`getDataRoot`, `loadConfig`, etc.) and barrel exports for `git`, `remote`, `registry`, and `files`.
- Modify `src/paths.js`: Thin barrel facade (`export * from "./paths/index.js"`) preserving all existing imports.
- Create `src/store/workspace.js`: Store-layer controller implementing `configureWorkspace` (`set_folder_policy`, `link_project_identity`, `inspect`) and `resolveStoreLinkedFolders`.
- Modify `src/store/helpers.js`: Remote-safe `prepareStore`, linked-folder `@<slug>/` & remote-safe `checkEntryFileStaleness`, and shared `resolveAndGuardFiles` helper.
- Modify `src/store/crud.js`, `src/store/dead-ends.js`, `src/store/file-memories.js`, `src/store/timeline.js`, `src/store/index.js`: Wire cross-folder write guardrails (including batch `entries[]` pre-validation), clone-disambiguation guard, `git_remote` pass-through, `@<folderSlug>/` read normalization, and `[CONFLICT]` reporting.
- Modify `src/session-start-hook.js`: Multi-root deduplication, submodule-safe collapsing, per-folder fault isolation, secondary hydration (capped at 4), and action notices (`MULTI-FOLDER ACTION REQUIRED`, `REMOTE WORKSPACE`, `CLONE DISAMBIGUATION REQUIRED`, `LINKED-ORDER NOTICE`).
- Modify `src/tools/project.js`, `src/server.js`: Register Tool #16 `configure_workspace`, extend tool schemas (`git_remote`, `allow_external_files`, `force_isolate`), and update `SERVER_INSTRUCTIONS`.
- Modify `rules/AGENTS.md`, `skills/agent-memory/SKILL.md`: Document multi-folder prompt-first rules, `configure_workspace`, and remote URI + `git_remote` workflow (and sync installed plugin copy).
- Create `test/workspaces.test.js`, Modify `test/memory.test.js`, `package.json`: Comprehensive unit + MCP stdio integration coverage across all new behaviors and Review Focus edge cases.

---

### Task 1: Zero-Process Git, Worktree, Bare-Repo & Root-Commit Identity

**Files:**
- Create: `src/paths/git.js`
- Create: `test/workspaces.test.js`
- Modify: `package.json:20-23`

**Interfaces:**
- Consumes: Node built-ins (`node:fs`, `node:path`)
- Produces (`src/paths/git.js`):
  - `MAX_GIT_FILE_BYTES` (`262144`)
  - `normalizeGitRemoteUrl(rawUrl: string) -> string | null`
  - `parseGitConfigRemoteUrl(configText: string) -> string | null`
  - `detectGitIdentity(canonicalPath: string) -> { gitIdentity: string, gitCommonDir: string, gitWorkTreeRoot: string, isWorktree: boolean, repoSubpath: string } | null`

- [ ] **Step 1: Update `package.json` test script and write failing tests in `test/workspaces.test.js`**

Update `"test"` in `package.json` to `"node --no-warnings --test test/memory.test.js test/workspaces.test.js"`.
Create `test/workspaces.test.js` with tests:
1. `"1.1 Normalizes SCP, HTTPS, SSH, credentialed, custom-port, and SSH-alias git URLs"` — asserts `normalizeGitRemoteUrl` maps `git@github.com:Owner/Repo.git`, `https://user:tok@github.com:443/Owner/Repo/`, and `ssh://git@github.com:22/owner/repo.git` all to `"github.com/owner/repo"`, keeps custom port (`"ssh://git@git.corp.local:2222/team/app.git"` -> `"git.corp.local:2222/team/app"`), and preserves SSH host alias (`"git@github-work:Org/App.git"` -> `"github-work/org/app"`).
2. `"1.2 Parses .git/config with tabs, inline comments, case-insensitive sections, and remote fallback"` — asserts `parseGitConfigRemoteUrl` prefers `[remote "origin"]` over `[remote "upstream"]`, handles `\turl = https://github.com/a/b.git # comment` and `[REMOTE "ORIGIN"]`, and falls back to first remote when `origin` is absent.
3. `"1.3 Detects normal repo, monorepo #subpath, standard worktree, and bare-repo sibling worktrees"` — creates temp repos on disk verifying:
   - root repo -> `gitIdentity === "github.com/org/mono"`, `isWorktree === false`, `repoSubpath === ""`
   - `packages/api` subdir -> `gitIdentity === "github.com/org/mono#packages/api"`
   - `.git` pointer file + `commondir` worktree -> same `gitCommonDir` and `gitIdentity`, `isWorktree === true`
   - bare repo + two sibling worktrees -> both worktrees resolve identical `gitCommonDir`, `repoSubpath === ""`, `isWorktree === true`
4. `"1.4 Falls back to root-commit SHA in logs/HEAD (surviving folder moves) and commonDir before first commit"` — creates a remote-less `.git` with `logs/HEAD` starting `0000000000000000000000000000000000000000 abcdef1234567890abcdef1234567890abcdef12 ...`, verifies `local-git-root:abcdef1234567890abcdef1234567890abcdef12` stays identical after `fs.renameSync` to a new folder; verifies repo with no `logs/HEAD` returns `local-git:<normalizedCommonDir>`.
5. `"1.5 Review Focus #1: Returns null safely on corrupt .git pointer or oversized >256KB .git/config"` — tests `.git` file with garbage text and `.git/config` > 300 KB; asserts `detectGitIdentity` returns `null` without throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/workspaces.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/paths/git.js`.

- [ ] **Step 3: Implement `src/paths/git.js`**

Implement bounded reads (`readFileBounded(filePath, maxBytes = MAX_GIT_FILE_BYTES)` checking `stat.size <= maxBytes` before reading):
- `normalizeGitRemoteUrl(rawUrl)`: strip `user:pass@` / `user@` credentials, handle SCP (`host:path`) and URL schemes (`https:`, `http:`, `ssh:`, `git:`), strip default ports (`:22`, `:80`, `:443`), strip trailing `/` and `.git`, lowercase host and path.
- `parseGitConfigRemoteUrl(configText)`: line-by-line INI parser stripping unquoted `#`/`;` inline comments, tracking `[remote "<name>"]` case-insensitively, returning `origin` url or first remote url.
- `detectGitIdentity(canonicalPath)`: walk up max 64 levels for `.git`, resolve `.git` file `gitdir:` + optional `commondir` (bounded read), normalize `gitCommonDir` (`fs.realpathSync` fallback to `path.resolve`), extract remote or `logs/HEAD` root-commit SHA (`4096` byte cap, `/^0{40}\s+([0-9a-f]{40})\b/i`) or `local-git:<normCommonDir>`, compute `repoSubpath` (`path.relative(gitWorkTreeRoot, canonicalPath).replace(/\\/g, "/")`, lowercased on `win32`), append `#<repoSubpath>` when non-empty.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --no-warnings --test test/workspaces.test.js` and `npm test`
Expected: PASS (all Task 1 tests + existing `test/memory.test.js` green).

- [ ] **Step 5: Commit**

```bash
git add package.json src/paths/git.js test/workspaces.test.js
git commit -m "feat(paths): add zero-process git, worktree, bare-repo, and root-commit identity detection"
```

---

### Task 2: Remote URI Parsing, Validation, & Bidirectional WSL Aliasing

**Files:**
- Create: `src/paths/remote.js`
- Modify: `test/workspaces.test.js`

**Interfaces:**
- Consumes: Node built-ins (`node:fs`, `node:path`, `node:url`)
- Produces (`src/paths/remote.js`):
  - `REMOTE_SCHEMES` (`Set(["vscode-remote:", "ssh:", "wsl:", "devcontainer:", "remote:"])`)
  - `isRemoteUri(rawPath: string) -> boolean`
  - `getWslEquivalentKeys(canonicalOrNormalized: string) -> string[]`
  - `normalizeForIndexCompare(rawOrCanonical: string, isRemote?: boolean) -> string`
  - `validateOrParseProjectPath(rawPath: string) -> { canonicalPath: string, normalizedForHash: string, slug: string, isRemote: boolean, remoteScheme: string | null }`
  - `validateProjectPath(rawPath: string) -> string`

- [ ] **Step 1: Add failing remote & WSL tests to `test/workspaces.test.js`**

Add tests:
1. `"2.1 Parses and canonicalizes vscode-remote, ssh, wsl, devcontainer, and remote URIs"` — asserts `isRemote === true`, trailing slashes stripped, `slug` extracted from last segment (`"my-app"`), and `remoteScheme` matches scheme without colon.
2. `"2.2 Review Focus #2: Allows valid percent-encoded spaces while rejecting null bytes, empty authority, raw '..', and encoded '%2e%2e' traversal"` — asserts `"vscode-remote://ssh-remote+dev/home/user/My%20App/"` succeeds cleanly with `slug: "my-app"` (or sanitized `"my-20app"` / decoded `"my-app"` — assert canonicalization without throwing and valid `slug`), while `"ssh://host/home/%2e%2e/etc"`, `"ssh://host/home/../etc"`, `"ssh:///home/app"`, and `"ssh://host/app\0"` throw `Error`.
3. `"2.3 Handles Windows WSL UNC fallback and bidirectional getWslEquivalentKeys"` — asserts unreachable `"\\\\wsl.localhost\\Ubuntu\\home\\dev\\app"` and `"\\\\wsl$\\Ubuntu\\home\\dev\\app"` fall back to `isRemote: true`, `canonicalPath: "wsl://ubuntu/home/dev/app"`, and `getWslEquivalentKeys("wsl://ubuntu/home/dev/app")` includes `"//wsl.localhost/ubuntu/home/dev/app"`, `"//wsl$/ubuntu/home/dev/app"`, and `"wsl://ubuntu/home/dev/app"`.
4. `"2.4 Preserves strict local validation errors for relative and missing local paths"` — asserts `"./"`, `"relative/dir"` throw `/relative paths/i` and missing local path throws `/does not exist/i` with remote URI hint.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/workspaces.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/paths/remote.js`.

- [ ] **Step 3: Implement `src/paths/remote.js`**

Implement:
- `isRemoteUri(rawPath)`: checks trimmed lowercase prefix against `REMOTE_SCHEMES`.
- `validateOrParseProjectPath(rawPath)`:
  - Reject non-string/empty, null bytes (`\0`), or ASCII control chars (`[\x00-\x1f\x7f]`).
  - If remote URI: validate `<scheme>//<authority>/<path>`, reject empty authority, reject `.` / `..` segments both before and after `decodeURIComponent` (reject malformed percent-encoding too), normalize slashes, strip trailing `/` (keep root `/`), lowercase scheme & authority, preserve path casing, derive `slug` (decode `%20` for slug sanitization).
  - If WSL UNC (`^(\\\\|\/\/)wsl(\.localhost|\$)[\\/]([^\\/]+)(.*)$` case-insensitive): try `fs.statSync` first (returning `isRemote: false` if accessible directory); on `ENOENT`/`EACCES`/`ENOTFOUND`/network error, fall back to canonical `wsl://<distro_lower>/<posix_path>` (`isRemote: true`).
  - Otherwise local path: unwrap `file://` via `fileURLToPath`, reject relative paths (`/relative paths/i`), `fs.statSync` (append remote URI hint to `ENOENT` error while keeping `directory does not exist.` text), `isDirectory()` check, `realpathSync.native`.
- `validateProjectPath(rawPath)`: returns `validateOrParseProjectPath(rawPath).canonicalPath`.
- `getWslEquivalentKeys(key)`: returns normalized bidirectional keys across `wsl://`, `//wsl.localhost/`, and `//wsl$/` forms when matching any WSL prefix, else `[key]`.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --no-warnings --test test/workspaces.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths/remote.js test/workspaces.test.js
git commit -m "feat(paths): add remote URI validation, WSL UNC fallback, and bidirectional WSL aliases"
```

---

### Task 3: Locked `projects_index.json` v4 Registry, 4-Step Resolution, Upgrade Lifecycle & Clone Disambiguation

**Files:**
- Create: `src/paths/registry.js`
- Create: `src/paths/index.js`
- Modify: `src/paths.js`
- Modify: `test/workspaces.test.js`

**Interfaces:**
- Consumes: Task 1 (`detectGitIdentity`, `normalizeGitRemoteUrl`), Task 2 (`validateOrParseProjectPath`, `validateProjectPath`, `getWslEquivalentKeys`, `normalizeForIndexCompare`, `isRemoteUri`)
- Produces (`src/paths/registry.js` & re-exported via `src/paths/index.js` -> `src/paths.js`):
  - `readProjectsIndex() -> { version: number, projects: Record<string, Object>, workspacePolicies: Record<string, Record<string, Object>> }`
  - `updateProjectsIndex(mutatorFn: (index) => any) -> any`
  - `getProjectStoreInfo(rawPath: string, options?: { gitRemote?: string }) -> StoreInfo` (includes `isRemote`, `remoteScheme`, `gitIdentity`, `gitCommonDir`, `resolvedVia`, `duplicateCloneCandidate`, `gitIdentityConflict`)
  - `registerProjectInIndex(storeInfo: StoreInfo) -> Object`
  - `setWorkspaceFolderPolicy({ primaryPath: string, folderPath: string, mode: "independent" | "linked" | "ignored", folderSlug?: string }) -> Object`
  - `getWorkspacePoliciesForPrimary(primaryNormalizedKey: string) -> Record<string, Object>`
  - `findReverseLinkedPrimary(targetNormalizedKey: string, openNormalizedKeys: string[]) -> { primaryKey: string, folderSlug: string, targetStoreKey: string } | null`
  - `linkProjectIdentity({ projectPath: string, sourceProjectPath?: string, targetStoreKey?: string, gitRemote?: string, isolate?: boolean }) -> Object`
  - `inspectWorkspace({ projectPath: string, workspacePaths?: string[] }) -> Object`
- Preserved exports in `src/paths/index.js` -> `src/paths.js`: `getDataRoot`, `getStoresDir`, `getBackupsDir`, `getProjectsIndexPath`, `getGlobalDbPath`, `getConfigPath`, `DEFAULT_CONFIG`, `loadConfig`, `normalizeWorkspaceRelativePath` (stubbed until Task 4 or imported from `files.js` once Task 4 lands — keep existing `normalizeWorkspaceRelativePath` working in `src/paths/index.js` until Task 4 moves it to `files.js` so `npm test` stays green on Task 3!).

- [ ] **Step 1: Add failing registry, resolution, upgrade, collision, clone-guard & policy tests to `test/workspaces.test.js`**

Add tests:
1. `"3.1 Review Focus #3: Reads v3 legacy index, recovers from corrupt JSON, and evicts stale dead-PID lock"` — seeds a v3 index entry missing `storeKey` & `firstSeenAt`, verifies `readProjectsIndex()` normalizes `workspacePolicies: {}` and preserves fields; writes invalid JSON to `projects_index.json` -> recovers empty v4; writes `projects_index.json.lock` with dead PID (`999999`) -> `updateProjectsIndex` evicts it and completes cleanly.
2. `"3.2 Reuses existing legacy v3.2 path-hash .db on disk even without index entry"` — creates `<slug>-<pathhash>.db` on disk with empty `projects_index.json`, asserts `getProjectStoreInfo(dir).resolvedVia === "legacy_path_db"` and exact matching `dbPath`.
3. `"3.3 Upgrades gitIdentity monotonically (null -> local-git -> local-git-root -> remote) and tracks gitIdentityAliases"` — simulates adding `.git`, committing (`logs/HEAD`), adding remote `origin`, then changing remote URL; verifies storeKey stays stable, `gitIdentity` upgrades at each stage, and old remote moves to `gitIdentityAliases`.
4. `"3.4 Detects duplicate gitIdentity collision without overwriting existing store ownership"` — creates `S1` (pre-git) and `S2` (owning `github.com/org/app`), then attaches `github.com/org/app` to `S1`; verifies `S1` keeps its own DB, `S2` keeps `gitIdentity`, and `S1`'s `storeInfo.gitIdentityConflict` flags `S2`.
5. `"3.5 Shares store silently for worktrees and moved folders, but flags duplicateCloneCandidate for two live clones; isolate:true resolves"` — creates live `clone1` + worktree `wt1` (same `gitCommonDir` -> auto-shares `resolvedVia === "git_identity"`); creates second live clone `clone2` (`clone1` still on disk -> `duplicateCloneCandidate` set); deletes `clone1` and re-checks `clone2` (`!fs.existsSync(clone1)` -> auto-shares as moved folder); restores `clone1`, runs `linkProjectIdentity({ projectPath: clone2, isolate: true })` -> `duplicateCloneCandidate` cleared and `isolatedGitIdentity` persisted.
6. `"3.6 Links deleted/moved source_project_path, pre-registers new remote git_remote without empty DB, and matches WSL bidirectional aliases"` — tests `linkProjectIdentity` with deleted `source_project_path` and with brand-new `git_remote` (verifies `fs.existsSync(dbPath) === false`), plus WSL `wsl://` <-> `//wsl.localhost/` index match.
7. `"3.7 Persists workspacePolicies with auto-disambiguated folderSlug and rejects duplicate explicit folderSlug"` — sets `linked` policy for `frontend/docs` and `backend/docs` under `primary`, asserts slugs `"docs"` and `"backend-docs"` (unique); asserts explicit duplicate `folderSlug: "docs"` throws; verifies `findReverseLinkedPrimary`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/workspaces.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/paths/registry.js`.

- [ ] **Step 3: Implement `src/paths/registry.js`, `src/paths/index.js`, and convert `src/paths.js` to barrel facade**

Key details:
- Keep `getDataRoot`, `getStoresDir`, `getBackupsDir`, `getProjectsIndexPath`, `getGlobalDbPath`, `getConfigPath`, `DEFAULT_CONFIG`, `loadConfig` in `src/paths/index.js` (or `src/paths/config.js` re-exported) and temporarily retain the existing `normalizeWorkspaceRelativePath` in `src/paths/index.js` until Task 4 replaces it with `files.js`.
- In `src/paths/registry.js`:
  - `acquireIndexLock` / `updateProjectsIndex(mutatorFn)`: same dead-PID/30s-age eviction pattern as `src/migrate/lock.js` plus 3x brief retry on `EPERM`/`EBUSY`/`EACCES` during `fs.renameSync`.
  - 4-step `getProjectStoreInfo(rawPath, { gitRemote } = {})`:
    - Always sets `storeInfo.canonicalPath`, `storeInfo.normalizedForHash`, and `storeInfo.isRemote` to the **caller's** validated path (so relative file normalization and staleness checks run against the active worktree or remote URI), while reusing the matched `storeKey` and `dbPath`.
    - Step 1: exact `canonicalPath`, `aliases[]`, or `getWslEquivalentKeys` match in `projects_index.json` (`resolvedVia: "index_alias"`).
    - Step 2: existing `${slug}-${pathHash}.db` (and WSL equivalents) on disk (`resolvedVia: "legacy_path_db"`).
    - Step 3: `gitIdentity` match against `entry.gitIdentity` / `entry.gitIdentityAliases[]` (ignoring entries whose `isolatedGitIdentity` opted out): auto-share on `isRemote || gitCommonDir === entry.gitCommonDir || !fs.existsSync(entry.canonicalPath)`, otherwise populate `duplicateCloneCandidate`.
    - Step 4: allocate new storeKey (`git:${gitIdentity}` hash or `normalizedForHash` hash).
  - `registerProjectInIndex(storeInfo)`:
    - Preserve an existing entry's `canonicalPath` unless the previous path was a local directory that no longer exists on disk (`!existing.isRemote && !fs.existsSync(existing.canonicalPath)`). Whenever `storeInfo.normalizedForHash` differs from the kept `canonicalPath` (e.g., a git worktree or bound remote URI), append `storeInfo.normalizedForHash` to `entry.aliases[]` instead of overwriting `entry.canonicalPath` (and keep `entry.isRemote = existing.isRemote && storeInfo.isRemote`).
    - Enforce 4-tier monotonic `gitIdentity` upgrade (`0: null`, `1: local-git:`, `2: local-git-root:`, `3: remote`) and duplicate `gitIdentity` collision protection (surfaces `gitIdentityConflict` without overwriting another store's ownership).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS (all Task 1–3 tests + all existing `test/memory.test.js` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/paths.js src/paths/index.js src/paths/registry.js test/workspaces.test.js
git commit -m "feat(paths): add locked v4 projects_index registry, git upgrade lifecycle, and clone guard"
```

---

### Task 4: Workspace File Classification, Symlink/`file://` Resolution, & Remote/Linked Normalization

**Files:**
- Create: `src/paths/files.js`
- Modify: `src/paths/index.js`
- Modify: `test/workspaces.test.js`

**Interfaces:**
- Consumes: Task 2 (`isRemoteUri`, `normalizeForIndexCompare`), Task 3 (`readProjectsIndex`, `getWorkspacePoliciesForPrimary`)
- Produces (`src/paths/files.js`, re-exported from `src/paths/index.js`):
  - `normalizeWorkspaceRelativePath(canonicalProjectPath: string, targetFile: string, options?: { isRemote?: boolean }) -> string | null`
  - `classifyWorkspaceFiles(storeInfo: StoreInfo, files: string[], options?: { linkedFolders?: Array<{ folderSlug: string, canonicalPath: string, normalizedKey: string, isRemote?: boolean }> }) -> { inWorkspace: string[], linkedNormalized: string[], externalFiles: Array<{ input: string, resolvedPath: string, ownerCandidate: { storeKey: string, canonicalPath: string } | null }>, allNormalized: string[] }`

- [ ] **Step 1: Add failing file classification & remote normalization tests to `test/workspaces.test.js`**

Add tests:
1. `"4.1 Normalizes remote URI and POSIX paths in normalizeWorkspaceRelativePath without Windows C:\\ corruption"` — passes `canonicalProjectPath = "ssh://dev/workspaces/app"` with `"ssh://dev/workspaces/app/src/index.ts"`, `"/workspaces/app/src/index.ts"`, and `"./src/lib/db.ts"`; asserts `"src/index.ts"` and `"src/lib/db.ts"` (no drive letter).
2. `"4.2 Unwraps file:// URIs and resolves symlinks/junctions inside workspace without flagging external"` — creates symlink (or skips gracefully if OS forbids symlink creation, plus tests `fs.realpathSync` ancestor resolution with a non-existent new file under a symlinked dir) and `file:///...` URI input; asserts classified into `inWorkspace` with zero `externalFiles`.
3. `"4.3 Auto-prefixes linked folder files to @<folderSlug>/<relPath> and preserves explicit @<folderSlug>/ anchors"` — passes absolute path inside linked folder `B` (`folderSlug: "tool-b"`) and explicit `"@tool-b/src/x.js"`; asserts `linkedNormalized` contains `"@tool-b/..."` and `externalFiles` is empty.
4. `"4.4 Detects external files with deepest matching ownerCandidate from projects_index.json"` — registers `B` and `B/sub` in index, classifies `"B/sub/file.ts"` against `A`; asserts `externalFiles[0].ownerCandidate.canonicalPath` points to `B/sub`.
5. `"4.5 Review Focus #4: Flags Windows cross-drive paths as external while keeping node_modules/@types/node/index.d.ts inWorkspace"` — classifies `"node_modules/@types/node/index.d.ts"` (stays in `inWorkspace`, not treated as `@types/` linked anchor) and cross-drive / out-of-root `"../outside/file.ts"` or `"D:/Other/file.ts"` (flagged in `externalFiles`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/workspaces.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/paths/files.js`.

- [ ] **Step 3: Implement `src/paths/files.js` and re-export in `src/paths/index.js`**

Implement:
- `normalizeWorkspaceRelativePath`: use `path.posix` when `isRemote || isRemoteUri(canonicalProjectPath)` (stripping matching `scheme://authority` prefix if `targetFile` is a remote URI, or extracting POSIX path if `targetFile` starts with `/`), unwrap `file://` URIs (and `/c:/` on `win32`).
- `classifyWorkspaceFiles`:
  - Only treat a leading `@<slug>/<rest>` (where `<slug>` matches an active `linkedFolders` entry) as an explicit linked anchor (so `node_modules/@types/...` and non-matching `@...` paths resolve normally inside workspace).
  - Unwrap `file://` URIs and resolve `realpathSyncSafe(abs)` (walk up to deepest existing ancestor dir + join remaining tail) before concluding a local file is outside `storeInfo.canonicalPath`.
  - Check `linkedFolders` by normalized prefix match -> format `@<folderSlug>/<rel>`.
  - Otherwise push to `externalFiles` with deepest-prefix `ownerCandidate` scanned from `readProjectsIndex().projects` (`canonicalPath` + `aliases`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths/files.js src/paths/index.js test/workspaces.test.js
git commit -m "feat(paths): add remote/POSIX path normalization and workspace file classifier"
```

---

### Task 5: Store Guardrails, Remote-Safe Prep/Staleness, & `configureWorkspace` Controller

**Files:**
- Create: `src/store/workspace.js`
- Modify: `src/store/helpers.js`
- Modify: `src/store/crud.js`
- Modify: `src/store/dead-ends.js`
- Modify: `src/store/file-memories.js`
- Modify: `src/store/timeline.js`
- Modify: `src/store/index.js`
- Modify: `test/workspaces.test.js`

**Interfaces:**
- Consumes: Task 3 (`getProjectStoreInfo`, `registerProjectInIndex`, `getWorkspacePoliciesForPrimary`, `setWorkspaceFolderPolicy`, `linkProjectIdentity`, `inspectWorkspace`), Task 4 (`classifyWorkspaceFiles`)
- Produces (`src/store/workspace.js` & `src/store/*` re-exported via `src/store/index.js`):
  - `configureWorkspace({ action, project_path?, primary_path?, folder_path?, mode?, folder_slug?, source_project_path?, git_remote?, target_store_key?, isolate?, workspace_paths? }) -> { isError: boolean, text: string, ... }`
  - `resolveStoreLinkedFolders(storeInfo: StoreInfo) -> Array<{ folderSlug: string, canonicalPath: string, normalizedKey: string, isRemote: boolean }>`
  - Extended `prepareStore(projectPath, { createIfMissing?, gitRemote? })`
  - Extended `checkEntryFileStaleness(canonicalProjectPath, files, updatedAtIso, { isRemote?, linkedFoldersBySlug? })`
  - Extended `checkMemoryStatus(projectPath, { include_timeline?, timeline_limit?, git_remote? })`
  - Extended `saveProjectMemory(projectPath, { ..., git_remote?, allow_external_files?, force_isolate? })`
  - Extended `updateMemoryNode(projectPath, { ..., allow_external_files? })`
  - Extended `recordDeadEnd(projectPath, { ..., allow_external_files? })`
  - Extended `checkDeadEnds(projectPath, { query?, file_path?, limit?, kind? })` & `getFileMemories(projectPath, { file_paths, include_dead_ends? })` (normalizing linked folder queries to `@<folderSlug>/...`)

- [ ] **Step 1: Add failing store guardrail, remote-safe prep/staleness, and `configureWorkspace` tests to `test/workspaces.test.js`**

Add tests:
1. `"5.1 Remote store skips legacy migration and returns skippedRemote: true from staleness check"` — saves & reads a memory node on `"ssh://dev/home/app"` with `git_remote: "https://github.com/org/app.git"`; asserts no `.ag-memory.json` crash, `staleFiles: []`, `missingFiles: []`, `skippedRemote: true`.
2. `"5.2 Staleness check stats linked @<slug>/ files on disk and skips unlinked/unknown @<slug>/ anchors"` — sets `linked` policy for `B` (`slug: "tool-b"`), saves memory in `A` referencing `B/src/b.ts` (stored as `"@tool-b/src/b.ts"`) + an unlinked `"@removed-slug/old.ts"`; touches `B/src/b.ts` later mtime -> `readMemoryNode` flags `"@tool-b/src/b.ts"` stale while skipping `"@removed-slug/old.ts"` without false missingFiles warning.
3. `"5.3 Cross-folder write guardrail aborts single save, batch entries[] atomically, updateMemoryNode, and recordDeadEnd; allow_external_files: true overrides"` — calls `saveProjectMemory` on `A` with batch `[validEntry, externalBFileEntry]`; asserts `res.isError === true` with `res.text` naming `B` as owner and **zero** rows written to `A` (batch atomicity!); repeats for `updateMemoryNode` & `recordDeadEnd` (`res.isError === true`); retries with `allow_external_files: true` and succeeds.
4. `"5.4 Linked-folder read queries normalize B paths to @<folderSlug>/ in getFileMemories and checkDeadEnds"` — saves memory & dead-end anchored to `B/src/b.ts` in `A` (`linked`), queries `getFileMemories(A, { file_paths: [path.join(B, "src", "b.ts")] })` and `checkDeadEnds(A, { file_path: path.join(B, "src", "b.ts") })` -> matches both!
5. `"5.5 Clone-disambiguation guardrail blocks accidental bootstrap unless force_isolate: true or configureWorkspace; checkMemoryStatus surfaces [CONFLICT]"` — verifies simultaneous clone write returns `res.isError === true` with disambiguation prompt until `force_isolate: true` or `configureWorkspace({ action: "link_project_identity", isolate: true })`, and verifies `checkMemoryStatus` includes `[CONFLICT]` when `gitIdentityConflict` is present.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/workspaces.test.js`
Expected: FAIL (`configureWorkspace` / guardrail behavior not implemented).

- [ ] **Step 3: Implement `src/store/workspace.js` and update `src/store/{helpers,crud,dead-ends,file-memories,timeline,index}.js`**

Key details:
- In `src/store/helpers.js`:
  - `prepareStore(projectPath, { createIfMissing = true, gitRemote } = {})`: pass `{ gitRemote }` to `getProjectStoreInfo`; skip `ensureMigratedIfLegacyExists` when `storeInfo.isRemote === true`. When `gitRemote` is explicitly provided, call `registerProjectInIndex(storeInfo)` even when `createIfMissing === false` and `storeInfo.dbPath` does not exist yet so passing `git_remote` once to `check_memory_status` persists the remote URI -> `gitIdentity` binding without creating an empty `.db` file.
  - `checkEntryFileStaleness`: return `{ staleFiles: [], missingFiles: [], skippedRemote: true }` when `isRemote`; resolve `@<slug>/<rel>` via `linkedFoldersBySlug` map, skipping unknown `@<slug>/` anchors cleanly.
  - Shared `resolveAndGuardFiles(storeInfo, files, { allowExternal = false } = {})` helper used by `crud.js`, `dead-ends.js`, and `index.js` (`updateMemoryNode`). When any external file is detected and `allowExternal !== true` (or when `storeInfo.duplicateCloneCandidate` is present and `force_isolate !== true`), `saveProjectMemory`, `updateMemoryNode`, and `recordDeadEnd` all **return `{ isError: true, text: "..." }`** before opening a transaction (never throw), matching `executeTool` in `src/tools/common.js`.
- In `src/store/workspace.js`:
  - `resolveStoreLinkedFolders(storeInfo)`: look up `workspacePolicies` across `storeInfo.normalizedForHash` as well as the normalized `canonicalPath` and `aliases[]` of `projects[storeInfo.storeKey]` so linked-folder policies work across primary worktrees and aliases.
  - Implement `configureWorkspace` delegating to Task 3 registry functions (`setWorkspaceFolderPolicy`, `linkProjectIdentity`, `inspectWorkspace`) and returning clean MCP-ready `{ isError, text, ... }`.
- In `src/store/crud.js` (`saveProjectMemory`): accept `git_remote`, `allow_external_files`, `force_isolate`; check `storeInfo.duplicateCloneCandidate` (unless `force_isolate`) and run `resolveAndGuardFiles` across **all** `entries[]` *before* opening `withTransaction`.
- In `src/store/index.js` (`readMemoryNode`, `updateMemoryNode`) and `src/store/dead-ends.js` (`recordDeadEnd`, `checkDeadEnds`) and `src/store/file-memories.js` (`getFileMemories`): wire `resolveStoreLinkedFolders`, `resolveAndGuardFiles`, and `isRemote` / `linkedFoldersBySlug`.
- In `src/store/timeline.js` (`checkMemoryStatus`): accept `git_remote`, surface `[CONFLICT]` if `storeInfo.gitIdentityConflict`, surface `[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED]` if `storeInfo.duplicateCloneCandidate`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/workspace.js src/store/helpers.js src/store/crud.js src/store/dead-ends.js src/store/file-memories.js src/store/timeline.js src/store/index.js test/workspaces.test.js
git commit -m "feat(store): add cross-folder write guardrails, remote staleness handling, and configureWorkspace"
```

---

### Task 6: Multi-Folder & Remote-Aware `SessionStart` Hook

**Files:**
- Modify: `src/session-start-hook.js`
- Modify: `test/workspaces.test.js`

**Interfaces:**
- Consumes: Task 1 (`detectGitIdentity`), Task 3 (`getProjectStoreInfo`, `getWorkspacePoliciesForPrimary`, `findReverseLinkedPrimary`), Task 5 (`checkMemoryStatus`)
- Produces (`src/session-start-hook.js`): Updated `runSessionStartPayload(payload)` supporting multi-root `workspacePaths`

- [ ] **Step 1: Add failing multi-folder & remote `SessionStart` tests to `test/workspaces.test.js`**

Add tests:
1. `"6.1 Hydrates initialized primary + secondary folders and prompts on uninitialized secondary"` — runs `runSessionStartPayload({ workspacePaths: [A, B, C] })` where `A` & `B` are initialized and `C` is uninitialized; asserts output contains `A` (`AGENT-MEMORY AUTO-HYDRATED`), `Secondary Workspace` for `B`, and `[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]` naming `C` with `independent`, `linked`, `ignored` + `configure_workspace`.
2. `"6.2 Collapses plain nested subfolder, preserves initialized subfolder store, and preserves git submodule with distinct gitCommonDir"` — tests `[P, P/sub, P/init-sub, P/submodule]` -> `P/sub` collapsed, `P/init-sub` and `P/submodule` kept!
3. `"6.3 Respects ignored and linked policies on secondary without suppressing standalone primary open"` — sets `B` to `ignored` under `A` and `C` to `linked` under `A`: `[A, B, C]` omits `B` hydration (`Ignored secondary`), notes `C` linked (`@<slug>/`); `[B]` standalone hydrates `B` normally!
4. `"6.4 Emits LINKED-ORDER NOTICE on reordered [B, A], REMOTE WORKSPACE on uninitialized remote URI, and CLONE DISAMBIGUATION on duplicate live clone"` — asserts each of the three notice banners in `systemMessage`.
5. `"6.5 Review Focus #5: Isolates invalid/missing secondary path and caps secondary hydration at 4 folders"` — passes `[A, missingDir, s1, s2, s3, s4, s5]` (6 valid initialized secondaries + 1 missing dir); asserts hook does not throw, `A` and `s1..s4` hydrate, `s5` is listed as on-demand, and `missingDir` does not crash startup.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/workspaces.test.js`
Expected: FAIL (current `SessionStart` only inspects `workspacePaths[0]`).

- [ ] **Step 3: Update `src/session-start-hook.js`**

Implement multi-root `runSessionStartPayload`:
- Deduplicate normalized entries in `workspacePaths`.
- Collapse nested subfolder `S` inside `P` only when `S` has neither its own initialized `.db` store nor a `.git` with `gitCommonDir !== P.gitCommonDir`.
- Isolate each folder's check in its own `try/catch`.
- Hydrate primary (`timeline_limit: 5`), emit `[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED]` / `[AGENT-MEMORY REMOTE WORKSPACE]` / `[AGENT-MEMORY LINKED-ORDER NOTICE]` as applicable.
- Process secondary folders per `workspacePolicies[primaryNorm]`: `ignored` (footer note), `linked` (prefix note), `independent` or initialized (hydrate `timeline_limit: 3`, cap at 4, list overflow on-demand), uninitialized with no policy (collect into `[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-start-hook.js test/workspaces.test.js
git commit -m "feat(hook): add multi-folder hydration, submodule-safe collapsing, and prompt-first notices to SessionStart"
```

---

### Task 7: MCP Tool #16 Registration, Server Metadata, Rules/Skill Sync & End-to-End Verification

**Files:**
- Modify: `src/tools/project.js`
- Modify: `src/server.js`
- Modify: `rules/AGENTS.md`
- Modify: `skills/agent-memory/SKILL.md`
- Modify: `test/memory.test.js:333-348`
- Modify: `test/workspaces.test.js`
- Also sync live plugin files (`C:\Users\mskah\.gemini\config\plugins\agent-memory\rules\AGENTS.md` and `C:\Users\mskah\.gemini\config\plugins\agent-memory\skills\agent-memory\SKILL.md`)

**Interfaces:**
- Consumes: Task 5 (`configureWorkspace`, extended store methods)
- Produces: Registered MCP Tool #16 `configure_workspace`, updated tool input schemas, updated `SERVER_INSTRUCTIONS`, updated `rules/AGENTS.md` and `skills/agent-memory/SKILL.md`

- [ ] **Step 1: Update `test/memory.test.js` tool count and add MCP stdio integration tests to `test/workspaces.test.js`**

- In `test/memory.test.js` line 333 & 346: update `15 tools` -> `16 tools` (`assert.equal(tools.length, 16)`) and assert `tools.some((t) => t.name === "configure_workspace")`.
- In `test/workspaces.test.js`: add `"7.1 End-to-end MCP stdio verification of configure_workspace, remote git_remote binding, cross-folder guardrail, and v4 memory://projects resource"` connecting via `StdioClientTransport` to `index.js`:
  - Call `configure_workspace` (`set_folder_policy`, `link_project_identity`, `inspect`)
  - Call `check_memory_status` + `save_project_memory` on `"ssh://dev/home/app"` with `git_remote`
  - Call `save_project_memory` on `A` referencing `B`'s file -> assert `isError: true`, then retry with `allow_external_files: true` -> assert success
  - Read `memory://projects` resource -> assert `version === 4` and `workspacePolicies` present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL (`tools.length` is 15 instead of 16, `configure_workspace` not found).

- [ ] **Step 3: Register `configure_workspace`, extend tool schemas, update `SERVER_INSTRUCTIONS`, `rules/AGENTS.md`, and `skills/agent-memory/SKILL.md`**

- In `src/tools/project.js`:
  - Register #16 `configure_workspace` (`action`, `project_path`, `primary_path`, `folder_path`, `mode`, `folder_slug`, `source_project_path`, `git_remote`, `target_store_key`, `isolate`, `workspace_paths`).
  - Add optional `git_remote` to `check_memory_status` & `save_project_memory`; optional `force_isolate` to `save_project_memory`; optional `allow_external_files` to `save_project_memory`, `update_memory_node`, `record_dead_end`.
- In `src/server.js`: update `SERVER_INSTRUCTIONS` (mentioning multi-folder prompt-first rules, `configure_workspace`, and remote URIs + `git_remote`).
- In `rules/AGENTS.md` and `skills/agent-memory/SKILL.md` (plus live plugin copies under `C:\Users\mskah\.gemini\config\plugins\agent-memory\`): document multi-folder prompt-first rules (`independent`/`linked`/`ignored`, always pass primary `project_path` for `linked` folders, ask user on cross-folder edits), remote URIs + `[AGENT-MEMORY REMOTE WORKSPACE]` Rule 2 exception, clone disambiguation, and Tool #16 `configure_workspace`.

- [ ] **Step 4: Run full test suite & verify plugin sync**

Run: `npm test`
Expected: PASS (100% of `test/memory.test.js` and `test/workspaces.test.js` green).

- [ ] **Step 5: Commit**

```bash
git add src/tools/project.js src/server.js rules/AGENTS.md skills/agent-memory/SKILL.md test/memory.test.js test/workspaces.test.js
git commit -m "feat: register configure_workspace tool, extend MCP schemas, and update rules/docs for v3.3.0"
```
