// client.ts
import type { McpTool, ServerDefinition } from "./types.js";
import { McpError, McpErrorCode } from "./types.js";
import { StdioTransport } from "./stdio-transport.js";
import { SseTransport } from "./sse-transport.js";
import { StreamableHttpTransport } from "./streamable-http-transport.js";
import { writeLog } from "./logger.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 5;
const MAX_CONNECT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 10_000;
/** Absolute upper bound for a full session recovery cycle (close + reconnect). */
const RECOVERY_ABSOLUTE_TIMEOUT_MS = 30_000;

/** Resolve bearer token from server definition */
function resolveBearerToken(def: ServerDefinition): string | undefined {
  if (def.bearerToken) return def.bearerToken;
  if (def.bearerTokenEnv) return process.env[def.bearerTokenEnv];
  return undefined;
}

type McpTransport = StdioTransport | SseTransport | StreamableHttpTransport;

/**
 * Generic MCP client: manages JSON-RPC request/response matching,
 * concurrency, timeouts, and session recovery.
 *
 * Delegates transport-specific I/O to one of {@link StdioTransport},
 * {@link SseTransport}, or {@link StreamableHttpTransport}.
 *
 * **Lifecycle:**
 * 1. Instantiate with server config (command or url)
 * 2. `await client.connect()` — performs MCP initialize handshake
 * 3. `await client.callTool(name, args)` or `listTools()` etc.
 * 4. `await client.close()`
 *
 * **Session recovery:** Streamable HTTP servers that return 404
 * (session expired) trigger automatic reconnect + retry.
 *
 * @example
 * ```ts
 * const client = new SimpleMcpClient("my-server", "npx", ["-y", "my-package"]);
 * await client.connect();
 * const tools = await client.listTools();
 * const result = await client.callTool("search", { query: "hello" });
 * await client.close();
 * ```
 */
export class SimpleMcpClient {
  /** Human-readable server identifier (shown in logs and debug output) */
  public readonly name: string;

  /**
   * Callback invoked when the underlying process or connection
   * terminates unexpectedly. The {@link McpClientPool} uses this
   * to remove stale entries from its internal map.
   */
  public onExit?: () => void;

  private transport: McpTransport | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private isClosed = false;
  private inFlight = 0;
  private maxConcurrentRequests: number;

  // Stored for session recovery on 404
  private _recovering = false;
  private _command?: string;
  private _args: string[] = [];
  private _env?: Record<string, string>;
  private _cwd?: string;
  private _url?: string;
  private _headers?: Record<string, string>;
  private _debug = false;
  private _type?: "sse" | "streamable-http";

  constructor(
    name: string,
    command?: string,
    args: string[] = [],
    env?: Record<string, string>,
    url?: string,
    headers?: Record<string, string>,
    debug = false,
    type?: "sse" | "streamable-http",
    initTimeoutMs?: number,
    cwd?: string,
    maxConcurrentRequests?: number,
  ) {
    this.name = name;
    this.maxConcurrentRequests = maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;

    // Store for session recovery
    this._command = command;
    this._args = args;
    this._env = env;
    this._cwd = cwd;
    this._url = url;
    this._headers = headers;
    this._debug = debug;
    this._type = type;

    this.transport = this._createTransport();
  }

  /** Create the appropriate transport based on stored config */
  private _createTransport(): McpTransport {
    const resolvedHeaders = this._headers ? { ...this._headers } : undefined;
    if (this._url) {
      if (this._type === "streamable-http") {
        return new StreamableHttpTransport(this.name, this._url, resolvedHeaders, this._debug);
      }
      return new SseTransport(this.name, this._url, resolvedHeaders, this._debug);
    }
    if (this._command) {
      return new StdioTransport(this.name, this._command, this._args, this._env, this._cwd, this._debug);
    }
    throw new McpError(`Cannot create transport: no url or command configured`, McpErrorCode.CONNECTION_FAILED);
  }

  /** Inject bearer token after construction (called by pool). Persists for session recovery. */
  setBearerToken(token: string): void {
    // Store in _headers for recovery
    if (!this._headers) this._headers = {};
    this._headers["Authorization"] = `Bearer ${token}`;

    // Apply to current transport if HTTP-based
    if (this.transport instanceof SseTransport || this.transport instanceof StreamableHttpTransport) {
      const t = this.transport as any;
      if (!t.headers) t.headers = {};
      t.headers["Authorization"] = `Bearer ${token}`;
    }
  }

  async connect(): Promise<any> {
    if (!this.transport) {
      throw new McpError(
        `MCP Server "${this.name}" has neither "command" nor "url" configured.`,
        McpErrorCode.CONNECTION_FAILED,
      );
    }

    this.isClosed = false;
    this.inFlight = 0;

    await this.transport.connect({
      onMessage: (response: any) => this.handleResponse(response),
      onExit: (reason: string) => {
        if (this.isClosed) return;
        this.isClosed = true;
        const err = new McpError(reason, McpErrorCode.SERVER_CRASHED);
        this.cleanupPendingRequests(err);
        if (this.onExit) {
          try { this.onExit(); } catch { /* intentionally swallow */ }
        }
      },
    });

    // Perform MCP handshake (transport is now fully connected)
    const initTimeout = (this as any)._initTimeoutMs ?? 60_000;
    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-mcp-connector", version: "1.0.0" },
    }, initTimeout);

    await this.notification("notifications/initialized", {});
    return initResult;
  }

  private handleResponse(response: any) {
    if (response.id !== undefined && response.id !== null) {
      const handler = this.pendingRequests.get(response.id);
      if (handler) {
        clearTimeout(handler.timer);
        this.pendingRequests.delete(response.id);
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (response.error) {
          handler.reject(new Error(response.error.message || "Unknown MCP Error"));
        } else {
          handler.resolve(response.result);
        }
      }
    }
  }

  request(method: string, params: any, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<any> {
    return this._requestWithRetry(method, params, timeoutMs, /*isRetry*/ false);
  }

  private _requestWithRetry(
    method: string,
    params: any,
    timeoutMs: number,
    isRetry: boolean,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.isClosed || !this.transport) {
        return reject(new McpError(`MCP server "${this.name}" is closed.`, McpErrorCode.CONNECTION_FAILED));
      }

      // Concurrency guard
      if (this.inFlight >= this.maxConcurrentRequests) {
        return reject(new McpError(
          `MCP server "${this.name}" has reached max concurrent requests (${this.maxConcurrentRequests}).`,
          McpErrorCode.CONCURRENCY_LIMIT,
        ));
      }

      const id = ++this.requestId;
      this.inFlight++;

      const timer = setTimeout(() => {
        const handler = this.pendingRequests.get(id);
        if (handler) {
          this.pendingRequests.delete(id);
          this.inFlight = Math.max(0, this.inFlight - 1);
          handler.reject(new McpError(
            `Request "${method}" (id=${id}) on server "${this.name}" timed out after ${timeoutMs}ms`,
            McpErrorCode.CONNECTION_TIMEOUT,
          ));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const payload = { jsonrpc: "2.0", id, method, params };

      this.transport.send(payload).then((syncResponse) => {
        // If transport returned a sync response, resolve immediately
        if (syncResponse) {
          const handler = this.pendingRequests.get(id);
          if (handler) {
            clearTimeout(handler.timer);
            this.pendingRequests.delete(id);
            this.inFlight = Math.max(0, this.inFlight - 1);
            if (syncResponse.error) {
              handler.reject(new Error(syncResponse.error.message || "Unknown MCP Error"));
            } else {
              handler.resolve(syncResponse.result);
            }
          }
        }
      }).catch(async (err) => {
        const handler = this.pendingRequests.get(id);
        if (!handler) return;

        const errMsg = err.message || "";

        // Session expiry recovery: reconnect and retry once
        if (!isRetry && errMsg.includes("[SESSION_EXPIRED]") && !this._recovering) {
          clearTimeout(handler.timer);
          this.pendingRequests.delete(id);
          this.inFlight = Math.max(0, this.inFlight - 1);

          try {
            await this._recoverSession();
            // Retry with fresh session
            this._requestWithRetry(method, params, timeoutMs, /*isRetry*/ true)
              .then(resolve)
              .catch(reject);
          } catch (recoveryErr) {
            reject(new McpError(
              `Session recovery failed for "${this.name}": ${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`,
              McpErrorCode.SESSION_EXPIRED,
            ));
          }
          return;
        }

        clearTimeout(handler.timer);
        this.pendingRequests.delete(id);
        this.inFlight = Math.max(0, this.inFlight - 1);
        handler.reject(err);
      });
    });
  }

  notification(method: string, params: any): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isClosed || !this.transport) {
        return reject(new McpError(`MCP server "${this.name}" is closed.`, McpErrorCode.CONNECTION_FAILED));
      }

      const payload = { jsonrpc: "2.0", method, params };
      this.transport.sendNotification(payload)
        .then(() => resolve())
        .catch((err) => reject(err));
    });
  }

  /**
   * Retrieve the list of tools available on this server.
   * @returns Array of tool definitions (name, description, inputSchema)
   */
  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    return result.tools || [];
  }

  /**
   * Invoke a tool on the server.
   * @param name Tool name as reported by {@link listTools}
   * @param args Tool arguments (key-value object)
   * @returns Tool execution result (typically `{ content: [...] }`)
   */
  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    return await this.request("tools/call", { name, arguments: args });
  }

  /**
   * List resources exposed by this server.
   * @returns Array of resource descriptors (uri, name, mimeType)
   */
  async listResources(): Promise<any[]> {
    const result = await this.request("resources/list", {});
    return result.resources || [];
  }

  /**
   * Read a single resource by URI.
   * @param uri Resource URI (e.g. `"file:///settings"`)
   * @returns Resource contents (typically `{ contents: [...] }`)
   */
  async readResource(uri: string): Promise<any> {
    return await this.request("resources/read", { uri });
  }

  /**
   * Recover from an expired session (404 on Streamable HTTP POST).
   * Closes old transport, creates a fresh one, and re-handshakes.
   * Only one recovery runs at a time (_recovering guard).
   */
  private async _recoverSession(): Promise<void> {
    if (this._recovering) {
      // Another recovery is already in progress; wait for it
      for (let i = 0; i < 50 && this._recovering; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (this._recovering) {
        throw new McpError(`Session recovery for "${this.name}" timed out waiting for another recovery`, McpErrorCode.SESSION_EXPIRED);
      }
      return;
    }

    this._recovering = true;
    const recoveryTimer = setTimeout(() => {
      // Absolute safety valve: if recovery hangs (e.g. connect() stalls),
      // force-clear the recovering flag so future requests aren't blocked.
      this._recovering = false;
      writeLog(`[${this.name}] Session recovery timed out after ${RECOVERY_ABSOLUTE_TIMEOUT_MS}ms — releasing lock`, "ERROR");
    }, RECOVERY_ABSOLUTE_TIMEOUT_MS);

    try {
      writeLog(`[${this.name}] Session expired (404), reconnecting...`, "WARN");

      // Clear pending requests — they'll fail anyway on old transport
      this.cleanupPendingRequests(
        new McpError("Session expired, reconnecting...", McpErrorCode.SESSION_EXPIRED),
      );

      // Close old transport
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }

      // Create fresh transport and reconnect
      this.isClosed = false;
      this.transport = this._createTransport();
      await this.connect();

      writeLog(`[${this.name}] Session recovery complete`, "INFO");
    } finally {
      clearTimeout(recoveryTimer);
      this._recovering = false;
    }
  }

  private cleanupPendingRequests(error: Error) {
    for (const handler of this.pendingRequests.values()) {
      clearTimeout(handler.timer);
      handler.reject(error);
    }
    this.pendingRequests.clear();
    this.inFlight = 0;
  }

  /**
   * Close client connection.
   * Pool removes client from map BEFORE calling close(),
   * so onExit only fires on unexpected process termination.
   */
  async close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cleanupPendingRequests(new McpError("Connection closed.", McpErrorCode.UNKNOWN));
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }
}

/**
 * Singleton connection pool with lazy spawning and automatic idle cleanup.
 *
 * **Key behaviors:**
 * - **Lazy spawn:** Servers are started on first use, not at extension load
 * - **Promise dedup:** Concurrent calls to {@link getClient} for the same
 *   server share a single connection attempt
 * - **Exponential backoff:** Retries timed-out connections with 1s→2s→4s delays
 * - **Idle timeout:** Servers unused for `idleTimeout` minutes are auto-closed
 * - **Session recovery:** Streamable HTTP 404 triggers automatic reconnect
 *
 * @example
 * ```ts
 * const pool = McpClientPool.getInstance();
 * const client = await pool.getClient("my-server", serverDef);
 * await client.callTool("search", { query: "..." });
 * await pool.closeAll();
 * ```
 */
export class McpClientPool {
  private static instance: McpClientPool | null = null;
  private clients = new Map<string, SimpleMcpClient>();
  private activePromises = new Map<string, Promise<SimpleMcpClient>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor() {}

  /** @returns The singleton pool instance */
  static getInstance(): McpClientPool {
    if (!McpClientPool.instance) {
      McpClientPool.instance = new McpClientPool();
    }
    return McpClientPool.instance;
  }

  /**
   * Get or lazily create a client for `serverName`.
   *
   * Reuses existing connections, deduplicates concurrent connection
   * attempts, and retries on timeout with exponential backoff.
   *
   * @param serverName Unique server identifier
   * @param def Server configuration (command/url/headers/etc.)
   * @param debug Enable stderr passthrough for debugging
   * @returns Connected and initialized client
   */
  async getClient(serverName: string, def: ServerDefinition, debug = false): Promise<SimpleMcpClient> {
    if (this.clients.has(serverName)) {
      this.resetIdleTimer(serverName, def);
      return this.clients.get(serverName)!;
    }

    if (this.activePromises.has(serverName)) {
      return this.activePromises.get(serverName)!;
    }

    const connectPromise = (async () => {
      let lastError: Error | undefined;
      try {
        for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
          try {
            if (attempt > 0) {
              const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
              writeLog(`[Pool] Retrying "${serverName}" (attempt ${attempt}) after: ${lastError?.message}. Waiting ${delay}ms...`, "WARN");
              await new Promise(r => setTimeout(r, delay));
            }
            writeLog(`[Pool] Lazy-spawning server "${serverName}"...`, "INFO");

            const client = new SimpleMcpClient(
              serverName,
              def.command,
              def.args,
              def.env,
              def.url,
              def.headers,
              def.debug || debug,
              def.type,
              def.initTimeout,
              def.cwd,
              def.maxConcurrentRequests,
            );

            if (def.auth === "bearer") {
              const token = resolveBearerToken(def);
              if (token) client.setBearerToken(token);
            }

            client.onExit = () => {
              this.clients.delete(serverName);
              this.clearIdleTimer(serverName);
            };

            await client.connect();
            this.clients.set(serverName, client);
            this.resetIdleTimer(serverName, def);
            return client;
          } catch (err: any) {
            lastError = err;
            if (!err.message?.includes("timed out") &&
                !(err instanceof McpError && err.code === McpErrorCode.CONNECTION_TIMEOUT)) {
              break;
            }
          }
        }
        throw lastError ?? new McpError(`Failed to connect to "${serverName}"`, McpErrorCode.CONNECTION_FAILED);
      } finally {
        this.activePromises.delete(serverName);
      }
    })();

    this.activePromises.set(serverName, connectPromise);
    return connectPromise;
  }

  async closeClient(serverName: string): Promise<void> {
    this.clearIdleTimer(serverName);
    const client = this.clients.get(serverName);
    if (client) {
      this.clients.delete(serverName);
      writeLog(`[Pool] Auto-closing idle server "${serverName}"...`, "INFO");
      await client.close();
    }
  }

  async closeAll(): Promise<void> {
    for (const name of Array.from(this.idleTimers.keys())) {
      this.clearIdleTimer(name);
    }
    const names = Array.from(this.clients.keys());
    await Promise.all(names.map(name => this.closeClient(name)));
  }

  getActiveClients(): string[] {
    return Array.from(this.clients.keys());
  }

  touch(serverName: string, def?: ServerDefinition) {
    if (this.clients.has(serverName) && def) {
      this.resetIdleTimer(serverName, def);
    }
  }

  private resetIdleTimer(serverName: string, def: ServerDefinition) {
    this.clearIdleTimer(serverName);
    const idleMinutes = def.idleTimeout !== undefined ? def.idleTimeout : 10;
    if (idleMinutes <= 0) return;

    const timer = setTimeout(() => {
      this.closeClient(serverName).catch((err) => {
        writeLog(`[Pool] Failed to auto-close "${serverName}": ${err}`, "ERROR");
      });
    }, idleMinutes * 60 * 1000);

    this.idleTimers.set(serverName, timer);
  }

  private clearIdleTimer(serverName: string) {
    if (this.idleTimers.has(serverName)) {
      clearTimeout(this.idleTimers.get(serverName));
      this.idleTimers.delete(serverName);
    }
  }
}
