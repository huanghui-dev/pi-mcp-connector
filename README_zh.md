# Pi MCP Connector

为 [Pi](https://pi.dev) 打造的 Model Context Protocol (MCP) 网关连接器。

[English](./README.md)

---

## 架构

```
pi-mcp-connector/
├── index.ts                           # Pi 扩展入口 (转发至 src/index.ts)
├── src/
│   ├── types.ts                       # 协议 Schema 定义、McpError 与 McpErrorCode
│   ├── config.ts                      # 多级配置加载、环境变量展开与命令安全校验
│   ├── cache.ts                       # 元数据缓存引擎 (工具与资源列表)
│   ├── client.ts                      # SimpleMcpClient 调度器、连接池与会话恢复管理
│   ├── stdio-transport.ts             # 子进程 stdio JSON-RPC 传输 (含 npx 命令解析)
│   ├── sse-transport.ts               # SSE 协议传输及其 endpoint 发现
│   ├── streamable-http-transport.ts   # Streamable HTTP (MCP 2025-03-26) 协议传输
│   ├── proxy.ts                       # 统一工具与资源代理分发器
│   ├── logger.ts                      # 内部文件结构化日志工具
│   └── index.ts                       # 扩展注册、生命周期事件订阅与 /mcp 命令实现
├── test.ts                            # 集成测试套件 (包含 stdio, Streamable HTTP 与 SSE 测试)
├── mock-server.js                     # 用于本地测试的 Mock MCP 服务器
├── package.json                       # 扩展包清单与依赖声明
├── tsconfig.json                      # TypeScript 编译器配置
├── README.md
└── README_zh.md
```

---

## 安装

```bash
pi install /path/to/pi-mcp-connector
```

---

## 配置说明 (`~/.pi/agent/mcp.json`)

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

## 使用说明

在 Pi 终端中：

- `/mcp` — 打开交互式 TUI 控制面板进行多服务器管理。
- `/mcp <serverName>` — 切换指定配置服务器的连接与断开状态。

---

## 执行测试

运行内置的 TypeScript 集成与单元测试套件：
```bash
npm run test
```

---

## 许可证书

MIT
