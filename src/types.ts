/**
 * Core type definitions for the pi-mcp-connector gateway.
 *
 * @module types
 */

/** Tracks which configuration file a server definition originated from. */
export type ConfigSource = "global" | "local" | "custom";

/**
 * Configuration for a single MCP server.
 *
 * Servers can be stdio-based (command + args) or HTTP-based (url + headers).
 *
 * @example
 * ```json
 * {
 *   "command": "npx",
 *   "args": ["-y", "@modelcontextprotocol/server-example"],
 *   "env": { "API_KEY": "${MY_API_KEY}" }
 * }
 * ```
 *
 * @example
 * ```json
 * {
 *   "url": "https://api.example.com/mcp",
 *   "type": "streamable-http",
 *   "headers": { "Authorization": "Bearer ${TOKEN}" }
 * }
 * ```
 */
export interface ServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "bearer" | "oauth";
  bearerToken?: string;
  bearerTokenEnv?: string;
  idleTimeout?: number; // In minutes, optional override
  initTimeout?: number; // In milliseconds, optional initialization timeout override
  debug?: boolean; // If true, logs all stderr streams inline
  type?: "sse" | "streamable-http";
  maxConcurrentRequests?: number; // Per-server concurrency limit, defaults to 5
  _source?: ConfigSource; // Internal: tracks which config file this definition came from
}

/**
 * Top-level MCP configuration structure.
 *
 * Loaded from `~/.pi/agent/mcp.json` (global), `.pi/mcp.json` (local),
 * and auto-discovered from third-party IDE configs.
 */
export interface McpConfig {
  /** Map of server name → server definition */
  mcpServers: Record<string, ServerDefinition>;
  /** Global settings overrides */
  settings?: {
    /** Minutes of inactivity before auto-closing a connection (default: 10, 0 = never) */
    idleTimeout?: number;
    /** Prefix style for tool names: `"server"` → `serverName_toolName`, `"none"` → `toolName` */
    toolPrefix?: "server" | "none";
    /** Enable stderr passthrough for all servers */
    debug?: boolean;
    /** Enable scanning of local workspace `.mcp.json` files (requires trust API) */
    enableLocalConfig?: boolean;
    /** Additional commands allowed beyond the built-in allowlist (`npx`, `node`, etc.) */
    allowedCommands?: string[];
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any; // JSON Schema
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}


export interface ServerCacheEntry {
  tools: McpTool[];
  resources: McpResource[];
  hash: string;
}

export interface MetadataCache {
  servers: Record<string, ServerCacheEntry>;
}

/**
 * Structured error codes for all MCP connector failures.
 *
 * Used with {@link McpError} to enable programmatic error handling
 * (e.g. session recovery on `SESSION_EXPIRED`).
 */
export const McpErrorCode = {
  UNKNOWN: "UNKNOWN",
  CONNECTION_FAILED: "CONNECTION_FAILED",
  CONNECTION_TIMEOUT: "CONNECTION_TIMEOUT",
  UNAUTHORIZED: "UNAUTHORIZED",
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  SERVER_CRASHED: "SERVER_CRASHED",
  CONCURRENCY_LIMIT: "CONCURRENCY_LIMIT",
  SESSION_EXPIRED: "SESSION_EXPIRED",
} as const;

export type McpErrorCode = (typeof McpErrorCode)[keyof typeof McpErrorCode];

/**
 * Structured error with a machine-readable {@link McpErrorCode}.
 *
 * Thrown by all client operations; pools and proxies inspect `code`
 * to decide whether to retry (timeout), recover (session expired),
 * or fast-fail (unauthorized).
 *
 * @example
 * ```ts
 * try {
 *   await client.callTool("search", { query: "..." });
 * } catch (err) {
 *   if (err instanceof McpError && err.code === McpErrorCode.SESSION_EXPIRED) {
 *     // trigger recovery
 *   }
 * }
 * ```
 */
export class McpError extends Error {
  /** Machine-readable error category */
  public readonly code: McpErrorCode;

  /**
   * @param message Human-readable error description
   * @param code Error category (defaults to `UNKNOWN`)
   */
  constructor(message: string, code: McpErrorCode = McpErrorCode.UNKNOWN) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/**
 * Unified proxy call arguments for tool execution and resource access.
 *
 * Supports auto-escape-free object arguments:
 * ```ts
 * { server: "bigquery", tool: "execute_sql", args: { sql: "SELECT 1" } }
 * ```
 */
export interface McpProxyArgs {
  server: string;
  tool?: string;
  args?: Record<string, any>; // 声明为 Record 键值对，无需嵌套 JSON string
  resourceList?: boolean;     // 列出服务器暴露的资源
  resourceRead?: string;      // 读取指定的资源 URI
}

