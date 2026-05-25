// sse-transport.ts
import { writeLog } from "./logger.js";
import type { TransportHooks } from "./stdio-transport.js";

/** Extract JSON-RPC response from an SSE text body */
function parseSseText(sseText: string): any {
  const events = sseText.split("\n\n");
  for (const event of events) {
    const lines = event.split("\n");
    let dataContent = "";
    for (const line of lines) {
      // Skip event: lines to avoid picking up non-message events
      if (line.startsWith("event:") && !line.includes("message")) {
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
 * MCP transport over Server-Sent Events (legacy MCP HTTP).
 *
 * Opens a GET SSE stream, discovers the POST endpoint via the `endpoint` event,
 * then sends JSON-RPC requests via POST to that endpoint. Responses may arrive
 * synchronously on the POST response or asynchronously on the SSE stream.
 *
 * This is the older MCP HTTP transport; prefer {@link StreamableHttpTransport}
 * for new servers.
 */
export class SseTransport {
  private postUrl: string | null = null;
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
    this.postUrl = null;
    this.abortController = new AbortController();

    writeLog(`[${this.serverName}] Establishing SSE connection to: ${this.url}`, "INFO");

    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, 8000);

    const response = await fetch(this.url, {
      headers: {
        "Accept": "text/event-stream",
        ...this.headers,
      },
      signal: this.abortController.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`SSE HTTP error: ${response.status} ${response.statusText}`);
    }

    // Start reading SSE stream in background
    this.readSseStream(response.body!.getReader());

    // Wait for 'endpoint' event to discover POST URL
    let attempts = 0;
    while (!this.postUrl && attempts < 100) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    if (!this.postUrl) {
      throw new Error(`SSE Handshake timeout: No 'endpoint' event received from ${this.url}`);
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
            this.hooks?.onExit("SSE stream ended");
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const chunk of parts) {
          if (chunk.trim()) {
            this.parseSseEvent(chunk);
          }
        }
      }
    } catch (err: any) {
      if (!this.isClosed) {
        writeLog(`[${this.serverName}] SSE stream closed with error: ${err.message}`, "WARN");
        this.isClosed = true;
        this.hooks?.onExit(`SSE stream error: ${err.message}`);
      }
    }
  }

  private parseSseEvent(chunk: string) {
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

    const dataContent = dataLines.join("\n");

    if (eventName === "endpoint") {
      try {
        this.postUrl = new URL(dataContent, this.url).toString();
        writeLog(`[${this.serverName}] Discovered SSE POST endpoint: ${this.postUrl}`, "INFO");
      } catch {
        this.postUrl = dataContent;
      }
    } else if (eventName === "message" && dataContent) {
      try {
        const response = JSON.parse(dataContent);
        this.hooks?.onMessage(response);
      } catch (err) {
        writeLog(`[${this.serverName}] Failed to parse JSON message from SSE: ${err}`, "ERROR");
      }
    }
  }

  async send(payload: Record<string, unknown>): Promise<any | null> {
    if (!this.postUrl) throw new Error("No SSE POST endpoint available.");

    const res = await fetch(this.postUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 200) {
      const contentType = res.headers.get("content-type") ?? "";
      const contentLengthHeader = res.headers.get("content-length");
      if (contentLengthHeader) {
        const length = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(length) && length > 10 * 1024 * 1024) { // 10MB safety limit
          throw new Error("PAYLOAD_TOO_LARGE: HTTP response Content-Length exceeds the 10MB safety limit.");
        }
      }
      const text = await res.text();
      if (!text) return null;

      // JSON response
      if (contentType.includes("application/json")) {
        try {
          return JSON.parse(text);
        } catch {
          writeLog(`[${this.serverName}] Failed to parse JSON from POST response`, "ERROR");
          return null;
        }
      }

      // SSE body response (server sent response inline instead of via stream)
      if (contentType.includes("text/event-stream")) {
        return parseSseText(text);
      }

      // Unknown content-type: try JSON first, then SSE
      try {
        return JSON.parse(text);
      } catch {
        return parseSseText(text);
      }
    }

    if (res.status === 202) {
      return null; // Accepted, response via SSE stream
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(`[UNAUTHORIZED] ${res.status} ${res.statusText}`);
    }

    return null;
  }

  async sendNotification(payload: Record<string, unknown>): Promise<void> {
    await this.send(payload);
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
