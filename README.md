# Pi MCP Connector

Model Context Protocol (MCP) Gateway for [Pi](https://pi.dev).

[简体中文](./README_zh.md)

---

## Architecture

```
pi-mcp-connector/
├── index.ts                           # Pi extension entry point (re-exports src/index.ts)
├── src/
│   ├── types.ts                       # Protocol schemas, McpError, and McpErrorCode
│   ├── config.ts                      # Configuration loading, environment expansion & security validation
│   ├── cache.ts                       # Metadata caching engine (tools & resources)
│   ├── client.ts                      # SimpleMcpClient scheduler, recovery & pool manager
│   ├── stdio-transport.ts             # Child process stdio JSON-RPC transport (with npx resolution)
│   ├── sse-transport.ts               # SSE transport with discovery endpoints
│   ├── streamable-http-transport.ts   # Streamable HTTP (MCP 2025-03-26) transport
│   ├── proxy.ts                       # Unified tool/resource proxy dispatchers
│   ├── logger.ts                      # Internal file structured logging utility
│   └── index.ts                       # Extension registration, lifecycle events & /mcp command
├── test.ts                            # Integration test suite (stdio, Streamable HTTP & SSE)
├── mock-server.js                     # Mock MCP server for local testing
├── package.json                       # Extension package manifest
├── tsconfig.json                      # TypeScript configuration
├── README.md
└── README_zh.md
```

---

## Installation

```bash
pi install /path/to/pi-mcp-connector
```

---

## Configuration (`~/.pi/agent/mcp.json`)

```json
{
  "settings": {
    "idleTimeout": 10,
    "allowedCommands": ["go", "/usr/local/bin/my-mcp"]
  },
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db", "/path/to/dev.db"],
      "idleTimeout": 10
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "type": "streamable-http",
      "auth": "bearer",
      "bearerTokenEnv": "MY_API_TOKEN",
      "initTimeout": 60000,
      "maxConcurrentRequests": 5
    }
  }
}
```

---

## Usage

In the Pi terminal:

- `/mcp` — Interactive TUI control panel for server management.
- `/mcp <serverName>` — Toggle connection state for a specific configured server.

---

## Testing

Run the native TypeScript integration test suite:
```bash
npm run test
```

---

## License

MIT
