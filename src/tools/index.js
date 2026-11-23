/**
 * @file src/tools/index.js
 * @description Central MCP tool orchestrator for agent-memory-mcp.
 * Aggregates and registers all 16 project, dead-end, workspace, and global MCP tools on the McpServer instance.
 */

import { registerProjectTools } from "./project.js";
import { registerDeadEndTools } from "./dead-ends.js";
import { registerWorkspaceTools } from "./workspace.js";
import { registerGlobalTools } from "./global.js";

export { registerProjectTools } from "./project.js";
export { registerDeadEndTools } from "./dead-ends.js";
export { registerWorkspaceTools } from "./workspace.js";
export { registerGlobalTools } from "./global.js";
export {
    READ_ONLY_ANNOTATIONS,
    WRITE_ANNOTATIONS,
    CategoryEnum,
    BatchEntrySchema,
    executeTool,
    wrapHandler,
    okText,
    errText
} from "./common.js";

/**
 * Registers all 16 agent-memory MCP tools on an McpServer instance.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server - McpServer instance.
 */
export function registerAllTools(server) {
    registerProjectTools(server);
    registerDeadEndTools(server);
    registerWorkspaceTools(server);
    registerGlobalTools(server);
}
