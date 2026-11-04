/**
 * @file src/tools/index.js
 * @description Central MCP tool orchestrator for agent-memory-mcp.
 * Aggregates and registers all 15 project and global MCP tools on the McpServer instance.
 */

import { registerProjectTools } from "./project.js";
import { registerGlobalTools } from "./global.js";

export { registerProjectTools } from "./project.js";
export { registerGlobalTools } from "./global.js";
export {
    READ_ONLY_ANNOTATIONS,
    WRITE_ANNOTATIONS,
    CategoryEnum,
    BatchEntrySchema,
    wrapHandler,
    okText,
    errText
} from "./common.js";

/**
 * Registers all 15 agent-memory MCP tools on an McpServer instance.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server - McpServer instance.
 */
export function registerAllTools(server) {
    registerProjectTools(server);
    registerGlobalTools(server);
}
