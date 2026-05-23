// mock-server.js
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  try {
    const request = JSON.parse(line);
    const { id, method, params } = request;

    if (method === "initialize") {
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "mock-mcp-server",
            version: "1.0.0",
          },
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (method === "notifications/initialized") {
      // Handshake complete, nothing to reply
    } else if (method === "tools/list") {
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "greet",
              description: "Greet a user by name",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
                required: ["name"],
              },
            },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments || {};
      let resultText = "";

      if (name === "greet") {
        resultText = `Hello, ${args.name || "World"}!`;
      } else {
        resultText = `Unknown tool ${name}`;
      }

      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: resultText,
            },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (method === "resources/list") {
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: "mock://settings",
              name: "Mock System Settings",
              description: "Mock key-value pairs representing configurations"
            }
          ]
        }
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (method === "resources/read") {
      const uri = params.uri;
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: uri,
              mimeType: "application/json",
              text: JSON.stringify({ theme: "dark", version: "1.0.0" }, null, 2)
            }
          ]
        }
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    console.error("Mock Server error:", err);
  }
});
