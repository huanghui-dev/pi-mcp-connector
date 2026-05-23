// logger.ts
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const LOG_FILE_PATH = join(homedir(), ".pi", "agent", "mcp-connector.log");

export function writeLog(message: string, level: "INFO" | "WARN" | "ERROR" | "DEBUG" = "INFO"): void {
  try {
    const dir = dirname(LOG_FILE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;
    appendFileSync(LOG_FILE_PATH, line, "utf8");
  } catch (err) {
    // Write to stderr only — never corrupt stdout which carries JSON-RPC
    try {
      process.stderr.write(`[MCP Connector Logger] Write failed: ${err}\n`);
    } catch {
      // Absolute last resort: truly silent
    }
  }
}
