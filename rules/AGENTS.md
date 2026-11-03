### Rule: Universal Project Memory & Bootstrapping (v3.0)
You act as the persistent intelligence for the active project workspace via `agent-memory-mcp`.

1. **Workspace Guard (Skip When No Project Is Open):**
   - Only run `agent-memory-mcp` tools when an active project workspace directory is open (or when the user explicitly provides a project directory to work on).
   - If there is no active workspace, or if the user asks a standalone question / reviews tooling outside a project codebase, skip project memory calls completely.
   - Always pass an **absolute** directory path as `project_path` (never `"./"`).

2. **Startup Check & Zero-Turn Auto-Hydration:**
   - If the `SessionStart` hook already injected `[AGENT-MEMORY AUTO-HYDRATED]` for the active workspace, **do NOT redundantly re-run** `check_memory_status` or `get_session_timeline`—proceed directly to task-specific retrieval.
   - Otherwise, run `check_memory_status` with the absolute `project_path` (which hydrates initialization status, core architecture index, dead-end count, and the top 5 recent session timeline entries in a single call).

3. **Universal Auto-Bootstrapping (If `UNINITIALIZED`):**
   - If `check_memory_status` (or the `SessionStart` message) reports `UNINITIALIZED` on a real project workspace, pause the user's request and map the project architecture first:
     - **Identify Ecosystem:** Scan the root folder for package managers and config files (e.g., `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, `docker-compose.yml`).
     - **Find Entry Points:** Locate primary source directories (`src/`, `cmd/`, `app/`, `lib/`) and main execution files.
     - **Analyze Architecture:** Determine project type (REST API, Frontend SPA, CLI tool, Monolith, Microservice) and key patterns (routing, ORM, state management).
     - **Atomic Batch Save:** Call `save_project_memory` once using the `entries` array to save all 3 foundational nodes atomically:
       1. `"Tech Stack & Ecosystem"` (`slug: "tech-stack"`, `category: "architecture"`)
       2. `"Project Structure & Architecture"` (`slug: "project-structure"`, `category: "architecture"`)
       3. `"Build & Run Instructions"` (`slug: "build-run"`, `category: "architecture"`)
     - **Notify User:** Output `"I have initialized the project memory for this [insert tech stack] project,"` then proceed with their task.

4. **Task & File-Anchored Retrieval:**
   - Use `search_project_memory` (FTS5 ranked search across titles, tags, files, and summaries) and `read_memory_node` (`ids: [...]` batch supported) to load relevant context before modifying code.
   - Before modifying any core utility, hook, or shared component, call `get_file_memories` with the target `file_paths` to surface anchored architectural invariants and past dead-ends.
   - If `read_memory_node` emits a `[STALE WARNING]`, verify the note against current code on disk and update it if needed.

5. **Continuous Learning & Clean Lifecycle:**
   - When you implement a new architectural pattern, add a database table, integrate/replace a core library, or change build steps, update the existing node via `save_project_memory` (using its `id` or canonical `slug`) or `update_memory_node`—never leave contradictory duplicate architectural nodes behind. Use `delete_memory_node` to archive obsolete notes.

### Rule: Session Timelines & Anti-Looping (v3.0)
1. **Anti-Loop Dead-End Checks & Recording:**
   - Review the recent session timeline and active dead-ends at task start so you never repeat completed tasks or re-attempt failed fixes.
   - Before retrying a compiler error, test failure, or unexpected runtime bug, call `check_dead_ends` with the error pattern or file path.
   - Whenever an attempted fix fails (and especially before stopping on the 3-Strike Rule), call `record_dead_end` with `error_pattern`, `attempted_solution`, `root_cause`, and `files` so future turns and sessions never repeat that dead-end.

2. **End of Task / Implementation Plan Session Log:**
   - Before completing a project coding task or implementation plan (ask the user if unsure whether the task is complete), call `save_project_memory` with:
     - `title`: `"Session Log: [Task Name]"`
     - `category`: `"session"`
     - `tags`: `["changelog", "session"]`
     - `files`: workspace-relative paths of key files added, modified, or removed
     - `summary`: A concise bulleted summary of changes made and any gotchas discovered.
