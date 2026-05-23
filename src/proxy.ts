// proxy.ts
import { McpClientPool } from "./client.js";
import type { McpConfig, McpProxyArgs } from "./types.js";
import { writeLog } from "./logger.js";

/**
 * Core proxy dispatcher: routes tool calls to the correct MCP server.
 *
 * Automatically resolves server prefixes (`serverName_toolName` or
 * `serverName-toolName`), lazily starts server processes via the pool,
 * and wraps results in Pi-compatible `{ content: [...] }` format.
 *
 * @param proxyArgs `{ server, tool, args }` — the server, tool name, and parameters
 * @param config Full MCP configuration (server definitions)
 * @param debug Enable verbose logging
 * @returns Pi-compatible tool result
 */
export async function handleMcpProxy(
  proxyArgs: McpProxyArgs,
  config: McpConfig,
  debug = false
): Promise<any> {
  const { server, tool, args = {} } = proxyArgs;

  if (!server) {
    throw new Error("Missing 'server' field in MCP proxy call.");
  }
  if (!tool) {
    throw new Error("Missing 'tool' field in MCP proxy call.");
  }

  // 1. 获取服务器定义
  const serverDef = config.mcpServers[server];
  if (!serverDef) {
    const available = Object.keys(config.mcpServers).join(", ") || "none";
    throw new Error(
      `MCP server "${server}" is not configured. Available servers: ${available}`
    );
  }

  try {
    // 2. 从极轻量连接池中获取客户端（如果没启动，这里会执行秒连，并自带并发 Promise 锁防止重复拉起）
    const pool = McpClientPool.getInstance();
    const client = await pool.getClient(server, serverDef, debug);

    // 3. 执行工具调用
    writeLog(`[Proxy] Routing tool call "${tool}" to server "${server}"...`, "INFO");
    const response = await client.callTool(tool, args);

    // 4. 对齐 Pi Agent 宿主扩展规范，输出 { content: Array }
    if (response && Array.isArray(response.content)) {
      return response;
    }
    
    // 如果返回的不是标准格式，自动包装为规范文本形式
    return {
      content: [
        {
          type: "text",
          text: typeof response === "object" ? JSON.stringify(response, null, 2) : String(response)
        }
      ]
    };
  } catch (err: any) {
    writeLog(`[Proxy] Failed to execute "${tool}" on "${server}": ${err.message}`, "ERROR");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `[MCP Error on "${server}"] ${err.message}`
        }
      ]
    };
  }
}

/**
 * 资源代理分发处理器。
 */
export async function handleMcpResourceProxy(
  proxyArgs: McpProxyArgs,
  config: McpConfig,
  debug = false
): Promise<any> {
  const { server, resourceList, resourceRead } = proxyArgs;

  if (!server) {
    throw new Error("Missing 'server' field in MCP proxy call.");
  }

  const serverDef = config.mcpServers[server];
  if (!serverDef) {
    const available = Object.keys(config.mcpServers).join(", ") || "none";
    throw new Error(
      `MCP server "${server}" is not configured. Available servers: ${available}`
    );
  }

  try {
    const pool = McpClientPool.getInstance();
    const client = await pool.getClient(server, serverDef, debug);

    if (resourceList) {
      writeLog(`[Proxy] Listing resources on server "${server}"...`, "INFO");
      const resources = await client.listResources();
      return {
        content: [],
        details: { status: "success", server, resources }
      };
    }

    if (resourceRead) {
      writeLog(`[Proxy] Reading resource "${resourceRead}" from server "${server}"...`, "INFO");
      const response = await client.readResource(resourceRead);
      
      if (response && Array.isArray(response.contents)) {
        return {
          content: response.contents.map((item: any) => ({
            type: "text",
            text: item.text || (item.blob ? Buffer.from(item.blob, 'base64').toString('utf-8') : "")
          })),
          details: { status: "success", server, resource: resourceRead, response }
        };
      }

      return {
        content: [
          {
            type: "text",
            text: typeof response === "object" ? JSON.stringify(response, null, 2) : String(response)
          }
        ],
        details: { status: "success", server, resource: resourceRead, response }
      };
    }

    throw new Error("Invalid resource proxy call: neither 'resourceList' nor 'resourceRead' specified.");
  } catch (err: any) {
    writeLog(`[Proxy] Resource operation failed on "${server}": ${err.message}`, "ERROR");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `[MCP Resource Error on "${server}"] ${err.message}`
        }
      ]
    };
  }
}

