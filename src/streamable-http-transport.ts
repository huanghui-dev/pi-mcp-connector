// streamable-http-transport.ts
import { writeLog } from "./logger.js";
import type { TransportHooks } from "./stdio-transport.js";

/** Extract JSON-RPC response from an SSE text body */
function parseSseResponse(sseText: string): any {
  const events = sseText.split("\n\n");
  for (const event of events) {
    const lines = event.split("\n");
    let dataContent = "";
    for (const line of lines) {
      // Skip non-message events (e.g. endpoint announcements)
      if (line.startsWith("event:") && !line.toLowerCase().includes("message")) {
        dataContent = "";
        break;
      }
      if (line.startsWith("data:")) {
        dataContent += line.substring(5).trim();
      }
    }
    if (dataContent) {
      try {
        return JSON.parse(dataContent);
      } catch {
        // try next event
      }
    }
  }
  return null;
}

/**
 * MCP transport over Streamable HTTP (MCP spec 2025-03-26).
 *
 * **Protocol flow:**
 * 1. Optional GET to establish an SSE stream for server→client notifications
 * 2. All JSON-RPC exchanges happen via POST to the same URL
 * 3. Responses come back either inline (200 + JSON/SSE body) or asynchronously
 *    on the SSE stream (202 Accepted)
 * 4. 405 on GET → server is POST-only (stateless mode)
 * 5. 404 on POST with session ID → session expired (triggers recovery)
 *
 * **Session recovery:** When a POST returns 404 and the transport has a
 * session ID, it throws `[SESSION_EXPIRED]`. {@link SimpleMcpClient} catches
 * this, calls {@link _recoverSession}, and retries the request once.
 */
export class StreamableHttpTransport {
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private hooks: TransportHooks | null = null;
  private isClosed = false;

  private serverName: string;
  private url: string;
  private headers?: Record<string, string>;
  private debug: boolean;

  constructor(
    serverName: string,
    url: string,
    headers?: Record<string, string>,
    debug = false,
  ) {
    this.serverName = serverName;
    this.url = url;
    this.headers = headers;
    this.debug = debug;
  }

  async connect(hooks: TransportHooks): Promise<any> {
    this.hooks = hooks;
    this.isClosed = false;
    this.abortController = new AbortController();

    writeLog(`[${this.serverName}] Establishing Streamable HTTP connection to: ${this.url}`, "INFO");

    // Try GET for SSE streaming (MCP 2025-03-26 spec: servers MAY support this)
    try {
      const timeoutId = setTimeout(() => this.abortController?.abort(), 8000);

      const sseHeaders: Record<string, string> = {
        "Accept": "text/event-stream",
        ...this.headers,
      };
      if (this.sessionId) {
        sseHeaders["Mcp-Session-Id"] = this.sessionId;
      }

      const response = await fetch(this.url, {
        headers: sseHeaders,
        signal: this.abortController.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 405) {
        writeLog(`[${this.serverName}] GET returned 405, falling back to POST-only stateless mode`, "INFO");
      } else if (response.ok) {
        const getSessionId = response.headers.get("Mcp-Session-Id");
        if (getSessionId) {
          this.sessionId = getSessionId;
          writeLog(`[${this.serverName}] Discovered Mcp-Session-Id from GET: ${this.sessionId}`, "INFO");
        }

        // Start reading SSE stream in background (if body is present)
        if (response.body) {
          this.readSseStream(response.body.getReader());
        } else {
          writeLog(`[${this.serverName}] GET returned 200 but no body, SSE streaming disabled`, "WARN");
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Connection timeout: failed to reach ${this.url} within 8 seconds.`);
      }
      // Non-fatal: server may not support GET, we'll rely on POST responses
      writeLog(`[${this.serverName}] GET attempt failed: ${err.message}. Proceeding POST-only.`, "WARN");
    }

    return null; // actual init result comes via request()
  }

  private async readSseStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.isClosed) {
        const { value, done } = await reader.read();
        if (done) {
          if (!this.isClosed) {
            this.isClosed = true;
            this.hooks?.onExit("Streamable HTTP GET stream ended");
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const chunk of parts) {
          if (chunk.trim()) {
            this.parseEvent(chunk);
          }
        }
      }
    } catch (err: any) {
      if (!this.isClosed) {
        writeLog(`[${this.serverName}] Streamable HTTP stream error: ${err.message}`, "WARN");
        this.isClosed = true;
        this.hooks?.onExit(`Streamable HTTP stream error: ${err.message}`);
      }
    }
  }

  private parseEvent(chunk: string) {
    const lines = chunk.split("\n");
    let eventName = "message";
    let dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.substring(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.substring(5).trim());
      }
    }

    if (eventName === "message" && dataLines.length > 0) {
      const dataContent = dataLines.join("\n");
      try {
        const response = JSON.parse(dataContent);
        this.hooks?.onMessage(response);
      } catch (err) {
        writeLog(`[${this.serverName}] Failed to parse JSON from Streamable HTTP event: ${err}`, "ERROR");
      }
    }
  }

  async send(payload: Record<string, unknown>): Promise<any | null> {
    const postHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) {
      postHeaders["Mcp-Session-Id"] = this.sessionId;
    }

    const res = await fetch(this.url, {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify(payload),
    });

    // Update session ID from response
    const postSessionId = res.headers.get("Mcp-Session-Id");
    if (postSessionId && postSessionId !== this.sessionId) {
      this.sessionId = postSessionId;
      writeLog(`[${this.serverName}] Updated Mcp-Session-Id from POST: ${this.sessionId}`, "INFO");
    }

    if (res.status === 200) {
      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (!text) return null;

      if (contentType.includes("application/json")) {
        try {
          return JSON.parse(text);
        } catch {
          writeLog(`[${this.serverName}] Failed to parse JSON response`, "ERROR");
          return null;
        }
      }

      if (contentType.includes("text/event-stream")) {
        return parseSseResponse(text);
      }

      // Unknown content-type: try JSON first, then SSE
      try {
        return JSON.parse(text);
      } catch {
        return parseSseResponse(text);
      }
    }

    if (res.status === 202) {
      return null; // Accepted, response will come via SSE stream
    }

    // Session expired — caller should recover and retry
    if (res.status === 404 && this.sessionId) {
      throw new Error(`[SESSION_EXPIRED] ${res.status} ${res.statusText}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(`[UNAUTHORIZED] ${res.status} ${res.statusText}`);
    }

    throw new Error(`Streamable HTTP POST error: ${res.status} ${res.statusText}`);
  }

  async sendNotification(payload: Record<string, unknown>): Promise<void> {
    const postHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    };
    if (this.sessionId) {
      postHeaders["Mcp-Session-Id"] = this.sessionId;
    }

    const res = await fetch(this.url, {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify(payload),
    });

    const postSessionId = res.headers.get("Mcp-Session-Id");
    if (postSessionId && postSessionId !== this.sessionId) {
      this.sessionId = postSessionId;
    }

    // 202 Accepted or 200 OK — no body needed for notifications
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
