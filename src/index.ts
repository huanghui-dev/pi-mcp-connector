// index.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList, Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadMcpConfig, LOCAL_CONFIG_NAMES, isTrustedWorkspace, addTrustedWorkspace } from "./config.js";
import { loadMetadataCache, saveMetadataCache } from "./cache.js";
import { McpClientPool } from "./client.js";
import { handleMcpProxy } from "./proxy.js";
import { writeLog } from "./logger.js";

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[90m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function cleanDescription(desc?: string): string {
  if (!desc) return "No description available";
  let firstLine = desc.split("\n")[0].trim();
  const bloatTerms = ["error responses", "http status", "response codes", "unauthorized", "internal server error", "errors:"];
  for (const term of bloatTerms) {
    const idx = firstLine.toLowerCase().indexOf(term);
    if (idx !== -1) {
      firstLine = firstLine.substring(0, idx).trim();
    }
  }
  firstLine = firstLine.replace(/[:\-,\s]+$/, "").trim();
  if (firstLine.length > 80) {
    return firstLine.substring(0, 77) + "...";
  }
  return firstLine || "No description available";
}

function getSimilarity(s1: string, s2: string): number {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const c1 = clean(s1);
  const c2 = clean(s2);
  if (c1 === c2) return 1.0;
  if (c1.includes(c2) || c2.includes(c1)) return 0.8;
  
  const len = Math.max(c1.length, c2.length);
  if (len === 0) return 1.0;
  
  let dist = 0;
  for (let i = 0; i < Math.min(c1.length, c2.length); i++) {
    if (c1[i] !== c2[i]) dist++;
  }
  dist += Math.abs(c1.length - c2.length);
  return (len - dist) / len;
}

function formatMcpToolResultSummary(content: any[], theme: any): string {
  if (!content || content.length === 0) {
    return theme.fg("dim", "No output returned.");
  }

  const textItem = content.find(item => item.type === "text");
  if (!textItem || !textItem.text) {
    return theme.fg("dim", `Returned non-text content (${content.length} items)`);
  }

  const rawText = textItem.text;
  const successPrefix = theme.fg("success", "Success") + theme.fg("text", " | ");
  
  try {
    const parsed = JSON.parse(rawText);
    const sizeStr = theme.fg("syntaxComment", `(${(rawText.length / 1024).toFixed(2)} KB)`);
    
    if (Array.isArray(parsed)) {
      return successPrefix + theme.fg("text", "Returned array with ") + theme.fg("accent", `${parsed.length}`) + theme.fg("text", " items ") + sizeStr;
    } else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.data)) {
        const itemsCount = parsed.data.length;
        const names = parsed.data.map((item: any) => item.name || item.title || item.id).filter(Boolean).slice(0, 3).join(", ");
        const namesStr = names ? ` (${names}${parsed.data.length > 3 ? "..." : ""})` : "";
        return successPrefix + theme.fg("text", "Returned ") + theme.fg("accent", `${itemsCount}`) + theme.fg("text", ` items${namesStr} `) + sizeStr;
      } else if (parsed.content && Array.isArray(parsed.content)) {
        return successPrefix + theme.fg("text", "Returned ") + theme.fg("accent", `${parsed.content.length}`) + theme.fg("text", " sub-items ") + sizeStr;
      }
      const keysCount = Object.keys(parsed).length;
      return successPrefix + theme.fg("text", "Returned JSON object with ") + theme.fg("accent", `${keysCount}`) + theme.fg("text", " keys ") + sizeStr;
    }
  } catch (e) {
    // Non-JSON
  }

  const lineCount = rawText.split("\n").length;
  const sizeKb = (rawText.length / 1024).toFixed(2);
  return successPrefix + theme.fg("text", `Returned text: `) + theme.fg("accent", `${lineCount}`) + theme.fg("text", ` lines `) + theme.fg("syntaxComment", `(${sizeKb} KB)`);
}

export default function mcpConnector(pi: ExtensionAPI) {
  const config = loadMcpConfig();
  const cache = loadMetadataCache();
  const serverNames = Object.keys(config.mcpServers);

  // Proactive self-healing cache pruning: automatically delete orphaned servers from disk cache on startup
  let cacheDirty = false;
  for (const cachedName of Object.keys(cache.servers)) {
    if (!serverNames.includes(cachedName)) {
      delete cache.servers[cachedName];
      cacheDirty = true;
    }
  }
  if (cacheDirty) {
    saveMetadataCache(cache);
    writeLog("Pruned orphaned server entries from metadata cache successfully.", "INFO");
  }

  const cacheSummary = serverNames
    .map((name) => {
      const entry = cache.servers[name];
      const count = entry ? entry.tools.length : "0";
      return `  ${COLOR.cyan}${name}${COLOR.reset}: ${count} tools cached`;
    })
    .join("\n");

  const gatewayDescription = `MCP Gateway Tool - Execute tools from configured servers:
${serverNames.map(s => `- ${s}`).join(", ")}

${COLOR.bold}Currently Cached Tools Summary:${COLOR.reset}
${cacheSummary || "  (No cache available. Connect once to discover tools.)"}`;

  // 智能生成极其详尽的工具 Manifest 注入提示词，让模型告别盲猜，如同内置原生工具般精确调用
  // 仅对配置中存在的服务器进行遍历，严密过滤历史/孤立的幽灵缓存条目，实现完备的边界防御
  let toolManifest = "";
  for (const serverName of serverNames) {
    const entry = cache.servers[serverName];
    if (entry && entry.tools && entry.tools.length > 0) {
      toolManifest += `\n[Server: ${serverName}]\n`;
      for (const t of entry.tools) {
        const desc = cleanDescription(t.description);
        const paramsList = t.inputSchema?.properties 
          ? Object.entries(t.inputSchema.properties)
              .map(([k, v]: [string, any]) => `${k}${t.inputSchema.required?.includes(k) ? " (required)" : ""}: ${v.type || "any"}`)
              .join(", ")
          : "none";
        const recommendedName = `${serverName}-${t.name}`;
        toolManifest += `- "${recommendedName}" (or "${t.name}") (parameters: { ${paramsList} }) - ${desc}\n`;
      }
    }
  }

  const detailedPromptSnippet = `MCP connector - communicate with lightweight local servers: ${serverNames.join(", ")}.
You have direct access to these external servers. Below is the EXACT manifest of available MCP tools and their required parameters.
To prevent naming collisions when multiple servers are configured, ALWAYS prefer using the prefixed name format (e.g. "serverName-toolName" or "serverName_toolName") when calling 'mcp'.
The gateway will automatically strip the prefix and route to the correct server.

${toolManifest || "(No tools cached yet. Run mcp connect to sync tools.)"}`;

  // 1. Session Start
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    let cwd: string;
    try {
      cwd = realpathSync(ctx.cwd);
    } catch {
      cwd = ctx.cwd;
    }
    
    const activeConfig = loadMcpConfig(undefined, cwd);
    const enableLocal = activeConfig.settings?.enableLocalConfig === true;

    if (enableLocal) {
      const hasLocalConfig = LOCAL_CONFIG_NAMES.some(name => existsSync(resolve(cwd, name)));
      
      if (hasLocalConfig && !isTrustedWorkspace(cwd)) {
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "Security Warning",
            `This directory contains local MCP servers (.mcp.json). Do you trust this workspace and want to load its local MCP configurations?`
          );
          if (ok) {
            addTrustedWorkspace(cwd);
            ctx.ui.notify("Workspace trusted. Local MCP configurations loaded successfully.", "info");
            writeLog(`Workspace ${cwd} trusted. Ready to connect local servers.`, "INFO");
            return;
          } else {
            ctx.ui.notify("Bypassed untrusted local MCP configuration for safety. Only using global configuration.", "warning");
          }
        } else {
          writeLog(`Untrusted local MCP configuration found at ${cwd}. Bypassed automatically for security.`, "WARN");
        }
      }
    }
    writeLog(`Session started in CWD: ${cwd}. Initialized connector pool.`, "INFO");
  });

  // 2. Session Shutdown
  pi.on("session_shutdown", async () => {
    const pool = McpClientPool.getInstance();
    await pool.closeAll();
    writeLog("Session shutdown. Cleaned up connector connection pool.", "INFO");
  });

  // 3. Register Gateway Tool (mcp)
  (pi.registerTool as any)({
    name: "mcp",
    label: "MCP Connector",
    description: gatewayDescription,
    promptSnippet: detailedPromptSnippet,
    parameters: Type.Object({
      tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'API-list-spaces')" })),
      // 史诗级优化：声明为 Any 类型，从而允许大模型免转义直接传递标准 JSON 对象！完美向下兼容 String 形式。
      args: Type.Optional(Type.Any({ description: "Arguments object or JSON string (e.g. {'query': '...'} or '{\\'query\\': \\'...\\'}')" })),
      connect: Type.Optional(Type.String({ description: "Server name to manually connect / refresh tool metadata" })),
      search: Type.Optional(Type.String({ description: "Search tools in cache by keyword" })),
      status: Type.Optional(Type.Boolean({ description: "Get connection status of all configured servers" })),
      resourceList: Type.Optional(Type.Boolean({ description: "List resources on specified server (requires 'server')" })),
      resourceRead: Type.Optional(Type.String({ description: "Read resource by URI on specified server (requires 'server')" })),
      server: Type.Optional(Type.String({ description: "Target server name (required for resourceList/resourceRead)" })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        tool?: string;
        args?: any;
        connect?: string;
        search?: string;
        status?: boolean;
        resourceList?: boolean;
        resourceRead?: string;
        server?: string;
      },
      _signal: any,
      onUpdate: (msg: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: ExtensionContext
    ) {
      const pool = McpClientPool.getInstance();
      const currentCwd = safeCwd(ctx.cwd);
      const activeConfig = loadMcpConfig(undefined, currentCwd);

      // Action: Connect / Force Refresh
      if (params.connect) {
        const serverName = params.connect;
        const serverDef = activeConfig.mcpServers[serverName];
        if (!serverDef) {
          return {
            content: [{ type: "text", text: `Server "${serverName}" is not configured.` }],
            details: { error: "not_configured" }
          };
        }

        try {
          if (onUpdate) onUpdate({ content: [{ type: "text", text: `Connecting to "${serverName}"...` }] });
          
          // 获取或拉起进程
          const client = await pool.getClient(serverName, serverDef, activeConfig.settings?.debug);
          const tools = await client.listTools();
          
          let resources: any[] = [];
          try {
            resources = await client.listResources();
          } catch {}
          
          // 同步缓存
          const { updateServerCache } = await import("./cache.js");
          // 计算配置 Hash 用以刷新校验
          const hash = JSON.stringify(serverDef);
          updateServerCache(serverName, tools, resources, hash);

          return {
            content: [], // 聊天对话流中不刷屏展示冗余连接信息
            details: { status: "connected", serverName, toolsCount: tools.length, tools },
          };
        } catch (err: any) {
          return {
            content: [],
            details: { error: "connect_failed", message: err.message },
          };
        }
      }

      // Action: Search Cache
      if (params.search) {
        const keyword = params.search.toLowerCase();
        const activeCache = loadMetadataCache();
        const matchedTools: any[] = [];

        for (const [serverName, entry] of Object.entries(activeCache.servers)) {
          const matched = entry.tools.filter(
            (t) => t.name.toLowerCase().includes(keyword) || (t.description && t.description.toLowerCase().includes(keyword))
          );
          if (matched.length > 0) {
            matchedTools.push({
              server: serverName,
              tools: matched
            });
          }
        }

        return {
          content: [], // 对话流中不打印搜索结果文本
          details: { matchedTools, count: matchedTools.reduce((acc, curr) => acc + curr.tools.length, 0) },
        };
      }

      // Action: Status
      if (params.status) {
        const activeCache = loadMetadataCache();
        const activeClients = pool.getActiveClients();
        const statuses = Object.keys(activeConfig.mcpServers).map((name) => {
          const isLive = activeClients.includes(name);
          const entry = activeCache.servers[name];
          const cachedCount = entry ? entry.tools.length : 0;
          return {
            name,
            status: isLive ? "LIVE" : "LAZY",
            cachedToolsCount: cachedCount
          };
        });

        return {
          content: [], // 彻底隐蔽！模型后台感知，聊天界面零刷屏输出
          details: { activeClients, statuses },
        };
      }

      // Action: Resource List / Resource Read
      if (params.resourceList || params.resourceRead) {
        if (!params.server) {
          return {
            content: [{ type: "text", text: "Error: 'server' is required when listing or reading resources." }],
            details: { error: "missing_server" }
          };
        }

        const { handleMcpResourceProxy } = await import("./proxy.js");
        return await handleMcpResourceProxy(
          {
            server: params.server,
            resourceList: params.resourceList,
            resourceRead: params.resourceRead
          },
          activeConfig,
          activeConfig.settings?.debug
        );
      }

      // Action: Tool Execution (With transparent lazy connect and parameter auto-parsing)
      if (params.tool) {
        const toolName = params.tool;
        const activeCache = loadMetadataCache();
        
        let targetServerName: string | null = null;
        let realToolName = toolName;

        // 1. 优先解析显式前缀: serverName_toolName 或 serverName-toolName
        for (const serverName of Object.keys(activeConfig.mcpServers)) {
          if (toolName.startsWith(serverName + "_")) {
            targetServerName = serverName;
            realToolName = toolName.substring(serverName.length + 1);
            break;
          } else if (toolName.startsWith(serverName + "-")) {
            targetServerName = serverName;
            realToolName = toolName.substring(serverName.length + 1);
            break;
          }
        }

        // 2. 如果没有匹配到前缀，在缓存中寻找与原 toolName 完全相同的真实工具
        if (!targetServerName) {
          for (const [serverName, entry] of Object.entries(activeCache.servers)) {
            if (entry.tools.some((t) => t.name === toolName)) {
              targetServerName = serverName;
              realToolName = toolName;
              break;
            }
          }
        }

        // 3. 智能自愈：如果上面没有直接匹配成功，开始模糊匹配和相似度计算纠错
        if (!targetServerName) {
          let bestMatch: { server: string; tool: string; score: number; isPrefixed: boolean } | null = null;

          for (const [serverName, entry] of Object.entries(activeCache.servers)) {
            for (const t of entry.tools) {
              const originalName = t.name;
              const prefixedDash = `${serverName}-${t.name}`;
              const prefixedUnderscore = `${serverName}_${t.name}`;

              const scores = [
                { name: originalName, isPref: false },
                { name: prefixedDash, isPref: true },
                { name: prefixedUnderscore, isPref: true }
              ].map(item => ({
                name: item.name,
                isPref: item.isPref,
                score: getSimilarity(toolName, item.name)
              }));

              for (const s of scores) {
                if (!bestMatch || s.score > bestMatch.score) {
                  bestMatch = { server: serverName, tool: originalName, score: s.score, isPrefixed: s.isPref };
                }
              }
            }
          }

          // 如果找到了置信度非常高的唯一工具，自动为大模型纠错并重路由
          if (bestMatch && bestMatch.score >= 0.85) {
            targetServerName = bestMatch.server;
            realToolName = bestMatch.tool;
            const correctedName = bestMatch.isPrefixed ? `${bestMatch.server}-${bestMatch.tool}` : bestMatch.tool;
            writeLog(`[Auto-Correct] Tool "${toolName}" not found. Best match is "${correctedName}" with score ${(bestMatch.score * 100).toFixed(0)}%. Auto-routing...`, "INFO");
            
            if (onUpdate) {
              try {
                onUpdate({ content: [{ type: "text", text: `⚠️ Tool "${toolName}" not found. Auto-correcting and routing to "${bestMatch.server}-${bestMatch.tool}" (Similarity: ${(bestMatch.score * 100).toFixed(0)}%)...` }] });
              } catch {}
            }
          } else if (bestMatch && bestMatch.score >= 0.5) {
            // 相似度中等，提供友好拼写提示
            const candidates: string[] = [];
            for (const [serverName, entry] of Object.entries(activeCache.servers)) {
              for (const t of entry.tools) {
                const prefixedDash = `${serverName}-${t.name}`;
                if (getSimilarity(toolName, prefixedDash) >= 0.5) {
                  candidates.push(`- "${prefixedDash}" (${cleanDescription(t.description)})`);
                }
              }
            }
            const suggestionText = candidates.length > 0
              ? `\nDid you mean one of these available tools?\n${candidates.slice(0, 3).join("\n")}`
              : "";

            return {
              content: [
                {
                  type: "text",
                  text: `Error: Tool "${toolName}" not found in cache.${suggestionText}\nPlease run mcp with { connect: "serverName" } to sync tools.`,
                },
              ],
              details: { error: "tool_not_found", tool: toolName },
            };
          }
        }

        if (!targetServerName) {
          return {
            content: [
              {
                type: "text",
                text: `Tool "${toolName}" not found in cache. Please run mcp with { connect: "serverName" } to sync.`,
              },
            ],
            details: { error: "tool_not_found", tool: toolName },
          };
        }

        // 双向适配：如果 args 传来的是 String，自动执行解析；如果是 Object，直接传入
        let parsedArgs: Record<string, any> = {};
        if (params.args) {
          if (typeof params.args === "string") {
            try {
              parsedArgs = JSON.parse(params.args);
            } catch (err: any) {
              return {
                content: [{ type: "text", text: `Invalid arguments JSON for tool "${toolName}": ${err.message}` }],
                details: { error: "invalid_arguments", message: err.message },
              };
            }
          } else if (typeof params.args === "object") {
            parsedArgs = params.args;
          }
        }

        if (onUpdate) {
          try {
            onUpdate({ content: [{ type: "text", text: `Routing "${toolName}" to server "${targetServerName}" (tool: "${realToolName}")...` }] });
          } catch {}
        }

        // 统一交给 proxy 层，自动完成懒拉起、参数打包和响应分发！
        return await handleMcpProxy(
          {
            server: targetServerName,
            tool: realToolName,
            args: parsedArgs
          },
          activeConfig,
          activeConfig.settings?.debug
        );
      }

      return {
        content: [{ type: "text", text: "Ready. Specify a { tool: '...', args: {} } to invoke or { search: '...' } to list." }],
        details: {},
      };
    },
    renderCall(args: any, theme: any, _context: any) {
      let text = theme.fg("toolTitle", theme.bold("mcp "));
      if (args.tool) {
        text += theme.fg("muted", `call `) + theme.fg("accent", args.tool);
        if (args.args) {
          const rawArgs = typeof args.args === "object" ? JSON.stringify(args.args) : String(args.args);
          const trimmedArgs = rawArgs.length > 60 ? rawArgs.substring(0, 57) + "..." : rawArgs;
          text += ` ${theme.fg("dim", trimmedArgs)}`;
        }
      } else if (args.connect) {
        text += theme.fg("muted", `connect `) + theme.fg("accent", args.connect);
      } else if (args.search) {
        text += theme.fg("muted", `search `) + theme.fg("accent", `"${args.search}"`);
      } else if (args.status) {
        text += theme.fg("muted", `status`);
      } else if (args.resourceList) {
        text += theme.fg("muted", `resources `) + theme.fg("accent", args.server || "unknown");
      } else if (args.resourceRead) {
        text += theme.fg("muted", `read-resource `) + theme.fg("accent", args.resourceRead);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
      const args = context.args || {};

      if (result.details?.error) {
        return new Text(theme.fg("error", `Error: ${result.details.message || result.details.error}`), 0, 0);
      }

      if (args.connect) {
        const text = result.content?.[0]?.text || "";
        return new Text(text, 0, 0);
      }

      if (args.search) {
        const keyword = args.search.toLowerCase();
        const activeCache = loadMetadataCache();
        let listText = "";
        let first = true;

        for (const [serverName, entry] of Object.entries(activeCache.servers)) {
          const matched = entry.tools.filter(
            (t) => t.name.toLowerCase().includes(keyword) || (t.description && t.description.toLowerCase().includes(keyword))
          );
          if (matched.length > 0) {
            if (!first) listText += "\n";
            first = false;
            
            listText += theme.fg("accent", theme.bold(`[${serverName}]`));
            matched.forEach((t) => {
              const cleanedDesc = cleanDescription(t.description);
              listText += `\n  ${theme.fg("success", "•")} ${theme.fg("toolTitle", t.name)} - ${theme.fg("syntaxComment", cleanedDesc)}`;
            });
          }
        }
        
        if (!listText) {
          listText = theme.fg("muted", `No cached tools matching "${args.search}". Try manual sync first.`);
        }
        return new Text(listText, 0, 0);
      }

      if (args.status) {
        const text = result.content?.[0]?.text || "";
        return new Text(text, 0, 0);
      }

      if (args.tool) {
        const textItem = result.content?.find((item: any) => item.type === "text");
        const rawText = textItem?.text || "";

        if (!expanded) {
          const summary = formatMcpToolResultSummary(result.content || [], theme);
          const hint = keyHint("app.tools.expand", "to expand");
          return new Text(summary + ` ${theme.fg("syntaxComment", `(${hint})`)}`, 0, 0);
        } else {
          if (!rawText) {
            return new Text(theme.fg("dim", "No output returned."), 0, 0);
          }

          let displayText = rawText;
          try {
            const parsed = JSON.parse(rawText);
            displayText = JSON.stringify(parsed, null, 2);
          } catch (e) {
            // Keep plain
          }

          const lines = displayText.split("\n");
          if (lines.length > 100) {
            displayText = lines.slice(0, 100).join("\n") + `\n\n${theme.fg("warning", `... Truncated ${lines.length - 100} lines of output. ...`)}`;
          }

          return new Text(displayText, 0, 0);
        }
      }

      if (args.resourceList) {
        const serverName = args.server || "unknown";
        const resources = result.details?.resources || [];
        if (!expanded) {
          const successPrefix = theme.fg("success", "Success") + theme.fg("text", " | ");
          const hint = keyHint("app.tools.expand", "to expand");
          return new Text(
            successPrefix +
            theme.fg("text", `Returned `) +
            theme.fg("accent", `${resources.length}`) +
            theme.fg("text", ` resources on server "${serverName}" `) +
            theme.fg("syntaxComment", `(${hint})`),
            0,
            0
          );
        } else {
          if (resources.length === 0) {
            return new Text(theme.fg("dim", `No resources available on server "${serverName}".`), 0, 0);
          }
          let listText = theme.fg("accent", theme.bold(`[${serverName}] Resources:`));
          resources.forEach((r: any) => {
            const cleanedDesc = cleanDescription(r.description);
            listText += `\n  ${theme.fg("success", "•")} ${theme.fg("toolTitle", r.name)} ${theme.fg("muted", `(${r.uri})`)}`;
            if (r.description) {
              listText += `\n    ${theme.fg("syntaxComment", cleanedDesc)}`;
            }
          });
          return new Text(listText, 0, 0);
        }
      }

      if (args.resourceRead) {
        const serverName = args.server || "unknown";
        const resourceUri = args.resourceRead;
        const textItem = result.content?.find((item: any) => item.type === "text");
        const rawText = textItem?.text || "";
        
        if (!expanded) {
          const successPrefix = theme.fg("success", "Success") + theme.fg("text", " | ");
          const sizeKb = ((rawText || "").length / 1024).toFixed(2);
          const hint = keyHint("app.tools.expand", "to expand");
          return new Text(
            successPrefix +
            theme.fg("text", `Successfully read resource `) +
            theme.fg("accent", `"${resourceUri}"`) +
            theme.fg("text", ` on "${serverName}" `) +
            theme.fg("syntaxComment", `(${sizeKb} KB) (${hint})`),
            0,
            0
          );
        } else {
          if (!rawText) {
            return new Text(theme.fg("dim", "Resource is empty or has no text content."), 0, 0);
          }
          
          let displayText = rawText;
          const lines = displayText.split("\n");
          if (lines.length > 100) {
            displayText = lines.slice(0, 100).join("\n") + `\n\n${theme.fg("warning", `... Truncated ${lines.length - 100} lines of resource content. ...`)}`;
          }
          return new Text(displayText, 0, 0);
        }
      }

      const text = result.content?.[0]?.text || "";
      return new Text(text, 0, 0);
    },
  });

  // 4. Command /mcp (Interactive Terminal Control Panel)
  pi.registerCommand("mcp", {
    description: "Manage Pi MCP Connector Connections",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const trimmed = prefix.trim().toLowerCase();
      const pool = McpClientPool.getInstance();
      const activeClients = pool.getActiveClients();
      
      const matches = serverNames
        .filter((name) => name.toLowerCase().startsWith(trimmed))
        .map((name) => {
          const isLive = activeClients.includes(name);
          return {
            value: name,
            label: isLive ? `${name}  ✓` : name
          };
        });
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string | undefined, ctx: any) => {
      const pool = McpClientPool.getInstance();
      const argv = args?.trim().split(/\s+/) || [];
      const subcommand = argv[0] || "";

      if (subcommand === "help") {
        const helpMsg = `Pi MCP Connector Commands:
  /mcp                         - Open interactive MCP server control panel (TUI)
  /mcp <serverName>            - Toggle connect/disconnect for specific server`;
        if (ctx.hasUI) ctx.ui.notify(helpMsg, "info");
        else console.log(helpMsg);
        return;
      }

      if (serverNames.includes(subcommand)) {
        const target = subcommand;
        const activeClients = pool.getActiveClients();
        const isCurrentlyLive = activeClients.includes(target);
        const currentCwd = safeCwd(ctx.cwd);
        const activeConfig = loadMcpConfig(undefined, currentCwd);
        const targetDef = activeConfig.mcpServers[target];

        try {
          if (isCurrentlyLive) {
            if (ctx.hasUI) {
              ctx.ui.setStatus("mcp", `Closing "${target}"...`);
              ctx.ui.notify(`Closing connection to "${target}"...`, "info");
            } else {
              console.log(`Closing connection to "${target}"...`);
            }

            await pool.closeClient(target);

            if (ctx.hasUI) {
              ctx.ui.setStatus("mcp", "");
              ctx.ui.notify(`Closed connection to "${target}"`, "info");
            } else {
              console.log(`Closed connection to "${target}"`);
            }
          } else {
            if (ctx.hasUI) {
              ctx.ui.setStatus("mcp", `Connecting to "${target}"...`);
              ctx.ui.notify(`Connecting to "${target}" and refreshing tools...`, "info");
            } else {
              console.log(`Connecting to "${target}"...`);
            }

            const client = await pool.getClient(target, targetDef, activeConfig.settings?.debug);
            await client.listTools(); 

            if (ctx.hasUI) {
              ctx.ui.setStatus("mcp", "");
              ctx.ui.notify(`Connected and synced "${target}" successfully!`, "info");
            } else {
              console.log(`Connected and synced "${target}" successfully!`);
            }
          }
        } catch (err: any) {
          if (ctx.hasUI) {
            ctx.ui.setStatus("mcp", "");
            ctx.ui.notify(`Connection failed for "${target}": ${err.message}`, "error");
          } else {
            console.error(`Connection failed for "${target}": ${err.message}`);
          }
        }
        return;
      }

      if (ctx.hasUI && subcommand === "") {
        await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
          const activeCache = loadMetadataCache();

          const getItems = (): SettingItem[] => {
            const activeClients = pool.getActiveClients();
            const currentCwd = safeCwd(ctx.cwd);
            const activeConfig = loadMcpConfig(undefined, currentCwd);
            const currentNames = Object.keys(activeConfig.mcpServers);

            return currentNames.map((name) => {
              const isLive = activeClients.includes(name);
              const entry = activeCache.servers[name];
              const cachedCount = entry ? entry.tools.length : 0;
              const cmd = activeConfig.mcpServers[name]?.command || activeConfig.mcpServers[name]?.url || "unknown";
              
              return {
                id: name,
                label: name,
                description: `Cached: ${cachedCount} tools. Service: ${cmd}`,
                currentValue: isLive ? `\x1b[32m✓\x1b[0m` : "",
                values: isLive ? ["close", "reconnect", "✓"] : ["connect", ""],
              };
            });
          };

          const items = getItems();

          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 12),
            getSettingsListTheme(),
            async (id: string, newValue: any) => {
              const currentCwd = safeCwd(ctx.cwd);
              const activeConfig = loadMcpConfig(undefined, currentCwd);
              const targetDef = activeConfig.mcpServers[id];

              try {
                if (newValue === "connect" || newValue === "reconnect") {
                  await pool.closeClient(id);
                  if (targetDef) {
                    const client = await pool.getClient(id, targetDef, activeConfig.settings?.debug);
                    await client.listTools();
                    ctx.ui.notify(`Connected to "${id}" successfully.`, "info");
                  }
                } else if (newValue === "close") {
                  await pool.closeClient(id);
                  ctx.ui.notify(`Closed server "${id}" connection.`, "info");
                }
              } catch (err: any) {
                ctx.ui.notify(`Action failed on "${id}": ${err.message}`, "error");
              } finally {
                const refreshedItems = getItems();
                refreshedItems.forEach((refItem, index) => {
                  if (items[index]) {
                    items[index].currentValue = refItem.currentValue;
                    items[index].values = refItem.values;
                    items[index].description = refItem.description;
                  }
                });
                tui.requestRender();
              }
            },
            () => {
              done(undefined);
            },
            { enableSearch: true }
          );

          return {
            render(width: number) {
              const listLines = settingsList.render(width);
              const borderLine = theme.fg("border", "─".repeat(width));
              const titleLines = [
                borderLine,
                "",
                " " + theme.fg("accent", theme.bold("MCP Server Configuration")),
                ""
              ];
              return [...titleLines, ...listLines, "", borderLine];
            },
            invalidate() {
              settingsList.invalidate?.();
            },
            handleInput(data: string) {
              settingsList.handleInput?.(data);
              tui.requestRender();
            },
          };
        });
        return;
      }

      if (subcommand === "") {
        const helpMsg = `Pi MCP Connector:\n  Please run /mcp in UI to open interactive control panel.\n  Or run /mcp <serverName> to toggle connection.`;
        console.log(helpMsg);
        return;
      }

      const errorMsg = `Unknown subcommand "${subcommand}".\nUse "/mcp help" to see available commands.`;
      if (ctx.hasUI) ctx.ui.notify(errorMsg, "error");
      else console.log(errorMsg);
    },
  });
}

function safeCwd(cwd?: string): string {
  if (!cwd) return process.cwd();
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}
