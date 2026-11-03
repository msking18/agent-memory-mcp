#!/usr/bin/env node

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
    console.error(
        `Error: agent-memory-mcp requires Node.js >= 22.5.0 (current: ${process.version}).\n` +
        "Please upgrade your Node.js runtime to use the native node:sqlite and FTS5 engine."
    );
    process.exit(1);
}

import { startStdioServer } from "./src/server.js";

await startStdioServer();
