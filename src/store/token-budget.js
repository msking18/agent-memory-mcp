/**
 * @file src/store/token-budget.js
 * @description Output token estimation, sentence boundary trimming, and audit metrics.
 * Protects agent context windows from massive payloads by capping responses at natural
 * linguistic boundaries while logging savings into `global.db`.
 */

import { loadConfig } from "../paths.js";
import { openGlobalDatabase, logTokenAudit, queryTokenMetrics } from "../db/index.js";

/**
 * Fast character-to-token ratio heuristic for LLMs (~3.8 characters per token).
 *
 * @param {string} str - Raw text string.
 * @returns {number} Estimated token count.
 */
export function estimateTokens(str) {
    if (!str || typeof str !== "string") return 0;
    return Math.ceil(str.length / 3.8);
}

/**
 * Trims text cleanly at the nearest natural boundary (paragraphs, sentence endings, or words).
 * Avoids mid-word cuts and preserves readability for LLMs.
 *
 * @param {string} text - Raw text string to trim.
 * @param {number} maxChars - Maximum allowed characters.
 * @returns {string} Cleanly trimmed text.
 */
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
    if (lastBoundary >= maxChars * 0.5) {
        return slice.slice(0, lastBoundary + 1).trim();
    }
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace >= maxChars * 0.5) {
        return slice.slice(0, lastSpace).trim();
    }
    return slice.trim();
}

/**
 * Enforces output token budget, appending a clear truncation banner when exceeded,
 * and records token consumption in `~/.ag-memory-mcp/global.db:token_audit_log`.
 *
 * @param {string} rawText - Uncapped response text.
 * @param {string} toolName - MCP tool identifier.
 * @param {string|null} [projectPath=null] - Project path if applicable.
 * @param {Object} [options] - Budgeting options.
 * @param {number} [options.maxTokens] - Custom max token threshold.
 * @param {boolean} [options.bypass=false] - When true, bypasses capping.
 * @param {number} [options.inputTokens=50] - Estimated input tokens for audit logging.
 * @returns {{ text: string, rawTokens: number, cappedTokens: number, tokensSaved: number, truncated: boolean }}
 */
export function applyTokenBudget(rawText, toolName, projectPath = null, options = {}) {
    const safeText = typeof rawText === "string" ? rawText : (rawText != null ? String(rawText) : "");
    const config = loadConfig();
    const maxTokens = typeof options.maxTokens === "number" ? options.maxTokens : config.max_response_tokens;
    const bypass = options.bypass === true || maxTokens === 0;

    const rawTokenEst = estimateTokens(safeText);
    const inputTokenEst = typeof options.inputTokens === "number" ? options.inputTokens : 50;

    let budgetedText = safeText;
    let truncated = false;

    if (!bypass && rawTokenEst > maxTokens) {
        const targetChars = Math.floor(maxTokens * 3.8);
        const trimmed = trimToSentenceBoundary(safeText, targetChars);
        budgetedText = `${trimmed}\n\n[TRUNCATED: Output exceeded token budget of ~${maxTokens} tokens (~${rawTokenEst} raw tokens). Configure max_response_tokens in ~/.ag-memory-mcp/config.json or pass full_content: true / bypass]`;
        truncated = true;
    }

    const finalTokenEst = estimateTokens(budgetedText);
    const tokensSaved = Math.max(0, rawTokenEst - finalTokenEst);

    logTokenAudit({
        toolName,
        projectPath,
        rawTokens: rawTokenEst,
        cappedTokens: finalTokenEst,
        tokensSaved
    });

    return {
        text: budgetedText,
        rawTokens: rawTokenEst,
        cappedTokens: finalTokenEst,
        tokensSaved,
        truncated
    };
}

/**
 * Retrieves aggregate token efficiency metrics and recent audit log events from `global.db`.
 *
 * @param {Object} [args] - Arguments.
 * @param {number} [args.timeframe_hours=24] - History window in hours.
 * @param {number} [args.limit=50] - Max recent entries to return.
 * @returns {{ timeframeHours: number, totalRawTokens: number, totalCappedTokens: number, totalTokensSaved: number, count: number, recentLogs: Array<Object>, text: string }}
 */
export function getTokenMetrics(args = {}) {
    const timeframeHours = typeof args.timeframe_hours === "number" ? args.timeframe_hours : 24;
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const globalDb = openGlobalDatabase();
    const stats = queryTokenMetrics(globalDb, { timeframeHours, limit });

    const formattedLines = [
        `# Token Efficiency & Audit Metrics (Last ${timeframeHours} Hours)`,
        ``,
        `- **Total Requests Monitored:** ${stats.total_calls}`,
        `- **Raw Tokens Estimated:** ${stats.total_output_tokens_raw.toLocaleString()}`,
        `- **Capped Tokens Returned:** ${stats.total_output_tokens_budgeted.toLocaleString()}`,
        `- **Tokens Saved from Context Bloat:** ${stats.tokens_saved.toLocaleString()}`,
        `- **Overall Savings Ratio:** ${stats.total_output_tokens_raw > 0 ? Math.round((stats.tokens_saved / stats.total_output_tokens_raw) * 100) : 0}%`,
        ``,
        `### Recent Audit Events (Top ${stats.recent_logs.length})`
    ];

    if (stats.recent_logs.length === 0) {
        formattedLines.push(`_No token audit events recorded in this timeframe._`);
    } else {
        formattedLines.push(`| Timestamp | Tool | Raw | Capped | Saved | Project |`);
        formattedLines.push(`| :--- | :--- | :--- | :--- | :--- | :--- |`);
        for (const log of stats.recent_logs) {
            const shortProj = log.project_path ? log.project_path.split(/[\\/]/).pop() : "global";
            const shortTime = log.timestamp.split("T")[1]?.slice(0, 8) || log.timestamp;
            formattedLines.push(
                `| ${shortTime} | \`${log.tool_name}\` | ${log.output_tokens_raw} | ${log.output_tokens_budgeted} | ${Math.max(0, log.output_tokens_raw - log.output_tokens_budgeted)} | \`${shortProj}\` |`
            );
        }
    }

    return {
        ...stats,
        text: formattedLines.join("\n")
    };
}
