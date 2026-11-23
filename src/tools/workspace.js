/**
 * @file src/tools/workspace.js
 * @description Multi-folder workspace policy & project identity MCP tool registration (Tool 16).
 * Registers `configure_workspace`.
 */

import { z } from "zod";
import { configureWorkspace } from "../store/index.js";
import {
    executeTool,
    WRITE_ANNOTATIONS
} from "./common.js";

/**
 * Registers multi-folder workspace and identity configuration tools (16) on an McpServer instance.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server - McpServer instance.
 */
export function registerWorkspaceTools(server) {
    // 16. configure_workspace
    server.registerTool(
        "configure_workspace",
        {
            title: "Configure Multi-Folder Workspace Policies & Project Identity",
            description:
                "Persist secondary folder policies ('independent', 'linked', 'ignored'), link or isolate project store identities across moved folders, worktrees, simultaneous clones, or remote URIs, or inspect resolved workspace store metadata without mutating user repositories.",
            inputSchema: {
                action: z
                    .enum(["set_folder_policy", "link_project_identity", "inspect"])
                    .describe("Configuration action: 'set_folder_policy', 'link_project_identity', or 'inspect'"),
                project_path: z
                    .string()
                    .optional()
                    .describe(
                        "Absolute workspace root path or remote URI (required for 'link_project_identity' and 'inspect')"
                    ),
                primary_path: z
                    .string()
                    .optional()
                    .describe("Primary workspace root path or remote URI (required for 'set_folder_policy')"),
                folder_path: z
                    .string()
                    .optional()
                    .describe("Secondary workspace folder path or remote URI (required for 'set_folder_policy')"),
                mode: z
                    .enum(["independent", "linked", "ignored"])
                    .optional()
                    .describe("Secondary folder policy mode (required for 'set_folder_policy')"),
                folder_slug: z
                    .string()
                    .optional()
                    .describe("Optional custom '@<slug>/' anchor prefix when mode is 'linked' (auto-disambiguated if omitted)"),
                source_project_path: z
                    .string()
                    .optional()
                    .describe(
                        "Previous/moved workspace path in projects_index.json to link from (does not require path to still exist on disk)"
                    ),
                git_remote: z
                    .string()
                    .optional()
                    .describe(
                        "Git remote URL (with optional '#subpath') to bind or share a project store across local/remote checkouts"
                    ),
                target_store_key: z
                    .string()
                    .optional()
                    .describe("Existing storeKey in projects_index.json to link this workspace to"),
                isolate: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true for 'link_project_identity', isolate a simultaneous clone into its own independent store"
                    ),
                workspace_paths: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "Optional list of open workspace root paths for 'inspect' to evaluate policies and reverse links"
                    )
            },
            annotations: WRITE_ANNOTATIONS
        },
        async (args) => {
            return executeTool("configure_workspace", args, () =>
                configureWorkspace(args)
            );
        }
    );
}
