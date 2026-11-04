/**
 * @file src/tools/common.js
 * @description Common Zod validation schemas, annotations, and MCP tool response wrappers.
 * Integrates transparent output token budgeting middleware across all tool execution paths.
 */

import { z } from "zod";
import { applyTokenBudget } from "../store/index.js";

/** MCP annotations for read-only query tools. */
export const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

/** MCP annotations for mutating write tools. */
export const WRITE_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
};

/** Zod enum for permissible memory categories. */
export const CategoryEnum = z.enum(["architecture", "decision", "session", "dead_end", "note", "pattern"]);

/** Zod schema for batch memory entry objects in `save_project_memory`. */
export const BatchEntrySchema = z.object({
    id: z.string().optional().describe("Optional existing ID to update in-place"),
    slug: z
        .string()
        .optional()
        .describe("Optional canonical slug (e.g., 'tech-stack', 'project-structure', 'build-run')"),
    title: z.string().min(1).describe("Short descriptive title"),
    summary: z.string().min(1).describe("Full markdown/text context or session changelog"),
    category: CategoryEnum.optional().describe(
        "Category ('architecture', 'decision', 'session', 'note'); auto-inferred if omitted"
    ),
    tags: z.array(z.string()).optional().default([]).describe("Keyword tags"),
    files: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Optional workspace-relative file paths anchored to this memory")
});

/**
 * Creates standard MCP successful text content payload.
 *
 * @param {string} text - Payload text.
 * @returns {{ content: Array<{ type: "text", text: string }> }}
 */
export function okText(text) {
    return { content: [{ type: "text", text }] };
}

/**
 * Creates standard MCP error text content payload.
 *
 * @param {string} message - Error message.
 * @returns {{ content: Array<{ type: "text", text: string }>, isError: true }}
 */
export function errText(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps an internal tool handler function with exception handling, standard formatting,
 * and automatic output token budgeting middleware.
 *
 * @param {(args: any) => Promise<any>|any} fn - Internal implementation function.
 * @param {string} toolName - Name of the MCP tool for audit logging.
 * @returns {(args: any) => Promise<{ content: Array<{ type: "text", text: string }>, isError?: boolean }>}
 */
export function wrapHandler(fn, toolName) {
    return async (args) => {
        try {
            const res = await fn(args);
            if (res?.isError) {
                const errMsg = typeof res.text === "string" ? res.text : (res.message || "Unknown error");
                return errText(errMsg);
            }
            const rawText =
                typeof res?.text === "string"
                    ? res.text
                    : typeof res === "string"
                    ? res
                    : JSON.stringify(res, null, 2);
            const budgeted = applyTokenBudget(rawText, toolName, args?.project_path, {
                bypass: args?.full_content === true
            });
            return okText(budgeted.text);
        } catch (err) {
            return errText(`Error: ${err.message}`);
        }
    };
}
