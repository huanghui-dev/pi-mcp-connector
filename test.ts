// test.ts
import test from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { SimpleMcpClient } from "./src/client.js";
import { loadMcpConfig } from "./src/config.js";
import { loadMetadataCache, updateServerCache } from "./src/cache.js";

test("SimpleMcpClient - Mock Server Handshake, listTools and callTool", async () => {
  const mockServerPath = join(import.meta.dirname, "mock-server.js");
  const client = new SimpleMcpClient(
    "mock-test-server",
    "node",
    [mockServerPath]
  );

  console.log("Connecting client to mock server...");
  const initResult = await client.connect();

  // 1. Assert Handshake init is correct
  assert.ok(initResult);
  assert.strictEqual(initResult.serverInfo.name, "mock-mcp-server");
  assert.strictEqual(initResult.protocolVersion, "2024-11-05");

  // 2. Assert listTools retrieves mock tool definitions
  console.log("Listing tools...");
  const tools = await client.listTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, "greet");
  assert.strictEqual(tools[0].description, "Greet a user by name");

  // 3. Assert callTool works as expected with params
  console.log("Calling tool 'greet'...");
  const response = await client.callTool("greet", { name: "Alice" });
  assert.ok(response);
  assert.ok(Array.isArray(response.content));
  assert.strictEqual(response.content[0].type, "text");
  assert.strictEqual(response.content[0].text, "Hello, Alice!");

  // 4. Assert listResources works
  console.log("Listing resources...");
  const resources = await client.listResources();
  assert.strictEqual(resources.length, 1);
  assert.strictEqual(resources[0].uri, "mock://settings");
  assert.strictEqual(resources[0].name, "Mock System Settings");

  // 5. Assert readResource works
  console.log("Reading resource...");
  const readRes = await client.readResource("mock://settings");
  assert.ok(readRes);
  assert.ok(Array.isArray(readRes.contents));
  assert.strictEqual(readRes.contents[0].uri, "mock://settings");
  const parsedRes = JSON.parse(readRes.contents[0].text);
  assert.strictEqual(parsedRes.theme, "dark");

  // Close connection cleanly
  console.log("Closing connection...");
  await client.close();
});

test("Metadata Cache - Save and Load", () => {
  const serverName = "cache-test-server";
  const mockTools = [
    {
      name: "test-tool",
      description: "A tool to test caching",
    },
  ];
  const hash = "test-hash-123";

  updateServerCache(serverName, mockTools, [], hash);

  const cache = loadMetadataCache();
  assert.ok(cache.servers[serverName]);
  assert.strictEqual(cache.servers[serverName].hash, hash);
  assert.strictEqual(cache.servers[serverName].tools[0].name, "test-tool");
});

test("Config Loader - Defaults and Load", () => {
  const config = loadMcpConfig();
  assert.ok(config);
  assert.ok(typeof config.mcpServers === "object");
});

test("SimpleMcpClient - Streamable HTTP transport handshake, listTools and callTool (Sync & Async)", async () => {
  const { createServer, ServerResponse } = await import("node:http");
  let sseResponse: any = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    
    if (req.method === "GET" && url.pathname === "/mcp") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Mcp-Session-Id": "mock-session-123"
      });
      res.write("event: message\ndata: {}\n\n");
      sseResponse = res;
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        const reqSessionId = req.headers["mcp-session-id"];

        if (payload.method === "initialize") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "mock-session-123"
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "mock-streamable-http-server", version: "1.0.0" }
            }
          }));
          return;
        }

        if (payload.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }

        if (payload.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              tools: [
                {
                  name: "search-any",
                  description: "Search tool",
                  inputSchema: {}
                }
              ]
            }
          }));
          return;
        }

        if (payload.method === "tools/call") {
          assert.strictEqual(reqSessionId, "mock-session-123");
          res.writeHead(202);
          res.end();

          if (sseResponse) {
            sseResponse.write(`event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Search results for ${payload.params.arguments.query}`
                  }
                ]
              }
            })}\n\n`);
          }
          return;
        }

        res.writeHead(404);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as any;
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}/mcp`;

  console.log(`Mock Streamable HTTP server listening on ${serverUrl}`);

  const client = new SimpleMcpClient(
    "streamable-http-test-server",
    undefined,
    [],
    undefined,
    serverUrl,
    undefined,
    true,
    "streamable-http"
  );

  console.log("Connecting Streamable HTTP client...");
  const initResult = await client.connect();

  assert.ok(initResult);
  assert.strictEqual(initResult.serverInfo.name, "mock-streamable-http-server");

  console.log("Listing tools via Streamable HTTP (Sync)...");
  const tools = await client.listTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, "search-any");

  console.log("Calling tool via Streamable HTTP (Async)...");
  const response = await client.callTool("search-any", { query: "banana" });
  assert.ok(response);
  assert.strictEqual(response.content[0].text, "Search results for banana");

  console.log("Closing Streamable HTTP client...");
  await client.close();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("Mock Streamable HTTP server stopped.");
});

test("SimpleMcpClient - Streamable HTTP session recovery on 404", async () => {
  const { createServer } = await import("node:http");

  let sessionCounter = 0;
  let sseResponse: any = null;
  let requestCount = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/mcp") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Mcp-Session-Id": `session-${++sessionCounter}`,
      });
      res.write("event: message\ndata: {}\n\n");
      sseResponse = res;
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const payload = JSON.parse(body);

        if (payload.method === "initialize") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": `session-${sessionCounter}`,
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "mock-recovery-server", version: "1.0.0" },
            },
          }));
          return;
        }

        if (payload.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }

        if (payload.method === "tools/call") {
          requestCount++;
          // First request: simulate session expiry
          if (requestCount === 1) {
            res.writeHead(404);
            res.end();
            return;
          }
          // Second request (after recovery): succeed
          res.writeHead(202);
          res.end();
          if (sseResponse) {
            sseResponse.write(`event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: { content: [{ type: "text", text: "Recovered!" }] },
            })}\n\n`);
          }
          return;
        }

        res.writeHead(404);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as any;

  const client = new SimpleMcpClient(
    "recovery-test-server",
    undefined,
    [],
    undefined,
    `http://127.0.0.1:${port}/mcp`,
    undefined,
    false,
    "streamable-http",
  );

  await client.connect();

  // First call triggers 404, client auto-recovers and retries
  const response = await client.callTool("search", { query: "test" });
  assert.strictEqual(response.content[0].text, "Recovered!");

  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("SimpleMcpClient - concurrency limit rejection", async () => {
  const { createServer } = await import("node:http");

  let sseResponse: any = null;
  // Promise to control when the server responds to the first tools/call
  let releaseResponse: any = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/mcp") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Mcp-Session-Id": "sess-concurrency",
      });
      res.write("event: message\ndata: {}\n\n");
      sseResponse = res;
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const payload = JSON.parse(body);

        if (payload.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-concurrency" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock-concurrency-server", version: "1.0.0" } },
          }));
          return;
        }

        if (payload.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }

        if (payload.method === "tools/call") {
          // Hold the response until explicitly released
          const id = payload.id;
          const respond = () => {
            res.writeHead(202);
            res.end();
            if (sseResponse) {
              sseResponse.write(`event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: "ok" }] },
              })}\n\n`);
            }
          };
          if (!releaseResponse) {
            releaseResponse = respond;
          } else {
            respond();
          }
          return;
        }

        res.writeHead(404);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as any;

  const client = new SimpleMcpClient(
    "concurrency-test-server",
    undefined,
    [],
    undefined,
    `http://127.0.0.1:${port}/mcp`,
    undefined,
    false,
    "streamable-http",
    undefined,
    undefined,
    1, // maxConcurrentRequests = 1
  );

  await client.connect();

  let p1Completed = false;
  let p2Completed = false;

  // First call fills the only slot (server holds the response)
  const p1 = client.callTool("hang", {}).then(() => { p1Completed = true; });
  // Give time for the request to be dispatched
  await new Promise(r => setTimeout(r, 200));

  // Second call should be queued instead of rejected (FIFO queueing)
  const p2 = client.callTool("hang", {}).then(() => { p2Completed = true; });
  await new Promise(r => setTimeout(r, 200));

  // Assert that neither is completed yet because p1 is hung and p2 is queued
  assert.strictEqual(p1Completed, false);
  assert.strictEqual(p2Completed, false);

  // Release the first response
  releaseResponse?.();

  // Wait for both to finish
  await Promise.all([p1, p2]);

  // Assert that both successfully finished (due to queueing)
  assert.strictEqual(p1Completed, true);
  assert.strictEqual(p2Completed, true);

  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("StdioTransport - NDJSON Garbage Filtering", async () => {
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const tempServerPath = join(import.meta.dirname, "temp-garbage-server.js");

  // Write a server script that outputs a garbage warning line first, then behaves normally
  const serverCode = `
    import readline from "node:readline";
    console.log("Warning: Debugger attached."); // Garbage non-JSON line
    console.log(" "); // Empty line
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      if (req.method === "initialize") {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "garbage-mock", version: "1.0.0" } }
        }));
      } else if (req.method === "notifications/initialized") {
        // handshake done
      } else if (req.method === "tools/list") {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: [] }
        }));
      }
    });
  `;
  writeFileSync(tempServerPath, serverCode, "utf8");

  const client = new SimpleMcpClient("garbage-test-server", "node", [tempServerPath]);

  try {
    const initResult = await client.connect();
    assert.ok(initResult);
    assert.strictEqual(initResult.serverInfo.name, "garbage-mock");

    const tools = await client.listTools();
    assert.strictEqual(tools.length, 0);
  } finally {
    await client.close();
    try { unlinkSync(tempServerPath); } catch {}
  }
});

test("SimpleMcpClient - Bidirectional Server Request Interception", async () => {
  const { writeFileSync, unlinkSync, existsSync, readFileSync } = await import("node:fs");
  const tempServerPath = join(import.meta.dirname, "temp-bidir-server.js");
  const replyFilePath = join(import.meta.dirname, "bidir-reply.json");

  try { if (existsSync(replyFilePath)) unlinkSync(replyFilePath); } catch {}

  const serverCode = `
    import readline from "node:readline";
    import fs from "node:fs";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      if (req.method === "initialize") {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "bidir-mock", version: "1.0.0" } }
        }));
      } else if (req.method === "notifications/initialized") {
        // Handshake done, trigger a request from Server to Client
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: 999,
          method: "sampling/createMessage",
          params: { messages: [] }
        }));
      } else if (req.id === 999) {
        fs.writeFileSync("${replyFilePath.replace(/\\/g, "\\\\")}", JSON.stringify(req), "utf8");
      }
    });
  `;
  writeFileSync(tempServerPath, serverCode, "utf8");

  const client = new SimpleMcpClient("bidir-test-server", "node", [tempServerPath]);

  try {
    await client.connect();
    // Wait for the bidirectional request/response roundtrip to complete
    for (let i = 0; i < 50; i++) {
      if (existsSync(replyFilePath)) break;
      await new Promise(r => setTimeout(r, 50));
    }

    assert.ok(existsSync(replyFilePath));
    const replyRaw = readFileSync(replyFilePath, "utf8");
    const reply = JSON.parse(replyRaw);

    assert.strictEqual(reply.jsonrpc, "2.0");
    assert.strictEqual(reply.id, 999);
    assert.ok(reply.error);
    assert.strictEqual(reply.error.code, -32601);
    assert.ok(reply.error.message.includes("not supported"));
  } finally {
    await client.close();
    try { unlinkSync(tempServerPath); } catch {}
    try { if (existsSync(replyFilePath)) unlinkSync(replyFilePath); } catch {}
  }
});
