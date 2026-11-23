### Rule: Universal Project Memory & Bootstrapping (v3.3)
You act as the persistent intelligence for the active project workspace and cross-project knowledge via `agent-memory-mcp`.

1. **Workspace Guard, Remote URIs & Global Scoping:**
   - Run project-scoped tools (`check_memory_status`, `save_project_memory`, `search_project_memory`, etc.) with an **absolute** local directory path or **remote workspace URI** (`vscode-remote://`, `ssh://`, `wsl://`, `devcontainer://`, `remote://`, or Windows WSL UNC `\\wsl.localhost\...` / `\\wsl$\...`) as `project_path` (never `"./"`).
   - For remote/virtual workspaces backed by git, pass optional `git_remote` to `check_memory_status` / `save_project_memory` (or bind via `configure_workspace(action: "link_project_identity", ...)`) so the remote URI shares the repository's git-identity store.
   - Global knowledge tools (`search_global_knowledge`, `save_global_knowledge`, `get_token_metrics`) do not require a project path and query the machine-wide `~/.ag-memory-mcp/global.db`.
   - If there is no active workspace, or if the user asks a standalone question / reviews tooling outside a project codebase, skip project memory calls completely.

2. **Startup Check & Zero-Turn Auto-Hydration (with Prompt-First Exceptions):**
   - If the `SessionStart` hook already injected `[AGENT-MEMORY AUTO-HYDRATED]` for the active workspace, **do NOT redundantly re-run** `check_memory_status` or `get_session_timeline` for that hydrated workspace—proceed directly to task-specific retrieval.
   - **Rule 2 Exceptions:**
     - **`[AGENT-MEMORY REMOTE WORKSPACE]`:** When `SessionStart` emits `[AGENT-MEMORY REMOTE WORKSPACE]` for an uninitialized remote URI, inspect the workspace's git origin remote URL (if it is a git repo) and re-run `check_memory_status(project_path, { git_remote })` (or `configure_workspace(action: "link_project_identity", project_path, git_remote)`) **before** bootstrapping so it resolves to any existing repository store.
     - **`[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED]` / `[CONFLICT]`:** When `SessionStart` or `check_memory_status` flags simultaneous live clones sharing a `gitIdentity` or a `[CONFLICT]` on `gitIdentity` ownership, do NOT guess or force-bootstrap. Ask the user whether to isolate (`configure_workspace(action: "link_project_identity", project_path, isolate: true)` or `save_project_memory(..., { force_isolate: true })`) or share the existing store (`configure_workspace(action: "link_project_identity", project_path, target_store_key)`).
     - **`[AGENT-MEMORY LINKED-ORDER NOTICE]`:** If an uninitialized primary root is already configured as `linked` (`@<folderSlug>/`) under another open workspace folder, route memory calls using that owning primary workspace's `project_path`.
     - **On-Demand Overflow Secondaries:** If `SessionStart` lists additional initialized secondary workspaces beyond the 4-folder auto-hydration cap, call `check_memory_status` for an overflow folder only if your task touches it.
   - Otherwise (if `SessionStart` did not hydrate the workspace), run `check_memory_status` with `project_path` (which hydrates initialization status, core architecture index, dead-end count, and the top 5 recent session timeline entries in a single call).

3. **Universal Auto-Bootstrapping (If `UNINITIALIZED`):**
   - If `check_memory_status` (or the `SessionStart` message) reports `UNINITIALIZED` on a real project workspace (and no unresolved `[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]`, `[AGENT-MEMORY REMOTE WORKSPACE]`, or `[AGENT-MEMORY CLONE DISAMBIGUATION REQUIRED]` action applies), pause the user's request and map the project architecture first:
     - **Identify Ecosystem:** Scan the root folder for package managers and config files (e.g., `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, `docker-compose.yml`).
     - **Find Entry Points:** Locate primary source directories (`src/`, `cmd/`, `app/`, `lib/`) and main execution files.
     - **Analyze Architecture:** Determine project type (REST API, Frontend SPA, CLI tool, Monolith, Microservice) and key patterns (routing, ORM, state management).
     - **Atomic Batch Save:** Call `save_project_memory` once using the `entries` array to save all 3 foundational nodes atomically:
       1. `"Tech Stack & Ecosystem"` (`slug: "tech-stack"`, `category: "architecture"`)
       2. `"Project Structure & Architecture"` (`slug: "project-structure"`, `category: "architecture"`)
       3. `"Build & Run Instructions"` (`slug: "build-run"`, `category: "architecture"`)
     - **Notify User:** Output `"I have initialized the project memory for this [insert tech stack] project,"` then proceed with their task.

4. **Multi-Folder Workspace Policies & Cross-Folder Guardrails:**
   - **Prompt-First Secondary Policies (`[AGENT-MEMORY MULTI-FOLDER ACTION REQUIRED]`):** Never auto-bootstrap or guess a policy for an uninitialized secondary workspace folder. Ask the user to classify each folder as:
     1. `independent` — create and bootstrap its own separate project memory store,
     2. `linked` — store its memories and `@<folderSlug>/` file anchors inside the primary workspace's store, or
     3. `ignored` — reference-only; skip project memory and auto-hydration in this multi-folder workspace (never suppresses standalone opening of that folder).
     Persist the user's choice immediately via `configure_workspace(action: "set_folder_policy", primary_path, folder_path, mode, folder_slug?)`.
   - **Linked Folders:** For any folder configured as `linked`, **always pass the primary workspace's `project_path`** (never the secondary folder's path) to `save_project_memory`, `search_project_memory`, `get_file_memories`, `check_dead_ends`, `record_dead_end`, etc. File paths inside linked folders normalize automatically to `@<folderSlug>/<relPath>`.
   - **Cross-Folder Edits & Write Guardrail:** When accessing/modifying files in another workspace folder—or when `save_project_memory`, `update_memory_node`, or `record_dead_end` triggers the cross-folder write guardrail naming an owning store—**ask the user** whether to: (1) save to the owning folder's `project_path`, (2) save to the current `project_path` with `allow_external_files: true`, or (3) save to both (or configure a `linked` policy via `configure_workspace`).
   - **Workspace Inspection & Relinking (`configure_workspace`):** Use Tool #16 `configure_workspace` with `action: "inspect"` to check resolved stores/policies/conflicts, `"set_folder_policy"` for secondary roles, and `"link_project_identity"` for moved/renamed folders (`source_project_path`), remote git binding (`git_remote`), store sharing (`target_store_key`), or clone isolation (`isolate: true`).

5. **Task & File-Anchored Retrieval:**
   - Use `search_project_memory` (FTS5 ranked search across titles, tags, files, and summaries) and `read_memory_node` (`ids: [...]` batch supported, including `"g-..."` global IDs) to load relevant context before modifying code.
   - Before modifying any core utility, hook, or shared component, call `get_file_memories` with the target `file_paths` to surface anchored architectural invariants and past dead-ends.
   - When adopting a library or diagnosing third-party framework quirks, search machine-wide memory via `search_global_knowledge` with the tech stack name.
   - If `read_memory_node` emits a `[STALE WARNING]`, verify the note against current code on disk and update it if needed (remote URIs and unlinked `@<slug>/` anchors automatically skip disk `mtime` checks).

6. **Continuous Learning & Global Promotion:**
   - When you implement a new architectural pattern, add a database table, integrate/replace a core library, or change build steps, update the existing node via `save_project_memory` (using its `id` or canonical `slug`) or `update_memory_node`—never leave contradictory duplicate architectural nodes behind. Use `delete_memory_node` to archive obsolete notes.
   - When a project-specific solution or architectural pattern proves broadly reusable across projects, promote it to the machine-wide global knowledge graph via `promote_to_global`.

### Rule: Session Timelines & Anti-Looping (v3.3)
1. **Anti-Loop Dead-End Checks & Taxonomy:**
   - Review the recent session timeline and active dead-ends at task start so you never repeat completed tasks or re-attempt failed fixes.
   - Before retrying a compiler error, test failure, or unexpected runtime bug, call `check_dead_ends` with the error pattern or file path.
   - Whenever an attempted fix fails (and especially before stopping on the 3-Strike Rule), call `record_dead_end` with:
     - `error_pattern`: The exact compiler error, test failure, or symptom.
     - `attempted_solution`: What was tried and failed.
     - `root_cause`: Why it failed.
     - `files`: Workspace-relative paths (or `@<folderSlug>/...` anchors for linked folders) involved.
     - `kind`: `"error_loop"` for code/test bug fixes, or `"architectural"` for intentional architectural constraints / rejected trade-offs.
     - `constraints`: Invariants or preconditions forbidding this approach.
   - If external dependencies, platform versions, or requirements change such that a previous dead-end is now viable, call `reopen_dead_end` with the record ID and reason.

2. **End of Task / Implementation Plan Session Log:**
   - Before completing a project coding task or implementation plan (ask the user if unsure whether the task is complete), call `save_project_memory` with:
     - `title`: `"Session Log: [Task Name]"`
     - `category`: `"session"`
     - `tags`: `["changelog", "session"]`
     - `files`: workspace-relative paths (or `@<folderSlug>/...` anchors) of key files added, modified, or removed
     - `summary`: A concise bulleted summary of changes made and any gotchas discovered.
