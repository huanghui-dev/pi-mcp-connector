// config.ts
import { existsSync, readFileSync, writeFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import type { McpConfig, ServerDefinition, ConfigSource } from "./types.js";
import { writeLog } from "./logger.js";

const GLOBAL_CONFIG_PATHS = [
  join(homedir(), ".pi", "agent", "mcp.json"),
  join(homedir(), ".config", "mcp", "mcp.json"),
];

export const LOCAL_CONFIG_NAMES = [
  ".pi/mcp.json",
  ".mcp.json",
];

// 第三方 IDE 配置扫描路径（Cursor, Claude Code, Claude Desktop）
const THIRD_PARTY_IDE_PATHS: { name: string; path: string }[] = [
  { name: "Cursor", path: join(homedir(), ".cursor", "mcp.json") },
  { name: "Claude Code", path: join(homedir(), ".claude", "mcp.json") },
  { name: "Claude Desktop", path: join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json") },
];

const TRUST_FILE_PATH = join(homedir(), ".pi", "agent", "mcp-trusted-workspaces.json");

// --- Security: Command allowlist for local & third-party configurations ---
const ALLOWED_LOCAL_COMMANDS = new Set([
  "npx", "node", "deno", "bun", "python", "python3", "uvx", "docker",
]);

// --- Security: Environment variable blocklist ---
const BLOCKED_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "SHELL",
  "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS", "NODE_PATH",
]);

// --- Security: Header blocklist ---
const BLOCKED_HEADER_NAMES = new Set([
  "host", "cookie", "authorization", "proxy-authorization",
  "set-cookie", "x-forwarded-for", "x-real-ip",
]);

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Validates a server definition from a local/custom config source.
 * Throws if the definition contains disallowed commands, env vars, or headers.
 *
 * @param allowedCommands User-configured extra commands from global settings (trusted)
 */
function validateServerDefinition(
  serverName: string,
  def: ServerDefinition,
  source: ConfigSource,
  allowedCommands?: string[],
): void {
  // Global Pi config is fully trusted (hardcoded + user-configured allowlist)
  if (source === "global") return;

  // #1: Command allowlist (hardcoded safe list for local/custom configs)
  if (def.command) {
    const cmdBasename = basename(def.command);
    const isAllowed = ALLOWED_LOCAL_COMMANDS.has(cmdBasename) ||
      (allowedCommands && allowedCommands.includes(def.command));
    if (!isAllowed) {
      throw new Error(
        `[Security] ${source} config server "${serverName}": command "${def.command}" is not in the allowlist. ` +
        `Allowed commands: ${[...ALLOWED_LOCAL_COMMANDS].join(", ")}` +
        (allowedCommands?.length ? `, ${allowedCommands.join(", ")}` : "")
      );
    }
  }

  // #2: Environment variable blocklist
  if (def.env) {
    for (const key of Object.keys(def.env)) {
      if (BLOCKED_ENV_KEYS.has(key)) {
        throw new Error(
          `[Security] ${source} config server "${serverName}": overriding sensitive env var "${key}" is forbidden.`
        );
      }
    }
  }

  // #3: Header blocklist
  if (def.headers) {
    for (const key of Object.keys(def.headers)) {
      if (BLOCKED_HEADER_NAMES.has(key.toLowerCase())) {
        throw new Error(
          `[Security] ${source} config server "${serverName}": setting sensitive header "${key}" is forbidden.`
        );
      }
    }
  }
}

function tagAndValidateServers(
  servers: Record<string, ServerDefinition>,
  source: ConfigSource,
  allowedCommands?: string[],
): Record<string, ServerDefinition> {
  const result: Record<string, ServerDefinition> = {};
  if (!servers || typeof servers !== "object") return result;

  for (const [name, def] of Object.entries(servers)) {
    try {
      validateServerDefinition(name, def, source, allowedCommands);
      result[name] = { ...def, _source: source };
    } catch (err: any) {
      writeLog(err.message, "ERROR");
    }
  }
  return result;
}

// --- Trust management ---

export function getTrustedWorkspaces(): string[] {
  if (!existsSync(TRUST_FILE_PATH)) return [];
  try {
    const raw = readFileSync(TRUST_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p: string) => safeRealpath(p));
  } catch {
    return [];
  }
}

export function addTrustedWorkspace(path: string) {
  const normalized = safeRealpath(path);
  const list = getTrustedWorkspaces();
  if (!list.includes(normalized)) {
    list.push(normalized);
    const tmpPath = TRUST_FILE_PATH + "." + Math.random().toString(36).slice(2) + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(list, null, 2), "utf8");
      renameSync(tmpPath, TRUST_FILE_PATH);
    } catch (err) {
      writeLog(`Failed to write trusted workspaces file atomically: ${err}`, "ERROR");
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {}
    }
  }
}

export function isTrustedWorkspace(cwd: string): boolean {
  const normalizedCwd = safeRealpath(cwd);
  return getTrustedWorkspaces().includes(normalizedCwd);
}

// --- Config loading with Auto-Discovery ---

export function loadMcpConfig(customPath?: string, cwd = process.cwd()): McpConfig {
  const mergedConfig: McpConfig = { mcpServers: {} };
  const normalizedCwd = safeRealpath(cwd);

  // 1. Load global configs (fully trusted)
  for (const globalPath of GLOBAL_CONFIG_PATHS) {
    if (existsSync(globalPath)) {
      try {
        const raw = readFileSync(globalPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.mcpServers) {
          const tagged = tagAndValidateServers(parsed.mcpServers, "global");
          mergedConfig.mcpServers = { ...mergedConfig.mcpServers, ...tagged };
        }
        if (parsed.settings) {
          mergedConfig.settings = { ...mergedConfig.settings, ...parsed.settings };
        }
        break; // Stop at first found global config
      } catch (err) {
        writeLog(`Failed to parse global config at ${globalPath}: ${err}`, "ERROR");
      }
    }
  }

  // Collect user-configured allowed commands from global settings (for non-global config validation)
  const globalAllowedCommands = mergedConfig.settings?.allowedCommands;

  // 2. Auto-discover third-party IDE configs (Cursor, Claude, etc.)
  // Treated as untrusted ("custom") to apply command and env allow/blocklists
  for (const { name, path } of THIRD_PARTY_IDE_PATHS) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.mcpServers) {
          const tagged = tagAndValidateServers(parsed.mcpServers, "custom", globalAllowedCommands);
          // Merge discovered servers. Skip duplicates if already defined in user global.
          for (const [serverName, def] of Object.entries(tagged)) {
            if (!mergedConfig.mcpServers[serverName]) {
              mergedConfig.mcpServers[serverName] = def;
              writeLog(`Discovered and imported ${name} server config: "${serverName}"`, "INFO");
            }
          }
        }
      } catch (err) {
        // Silent recovery to prevent breaking the startup process
        writeLog(`Skipped auto-discover for ${name} configuration: ${err}`, "DEBUG");
      }
    }
  }

  // 3. Load local project config ONLY IF enabled in global settings AND CWD is trusted
  const enableLocal = mergedConfig.settings?.enableLocalConfig === true;
  if (enableLocal) {
    const trustedList = getTrustedWorkspaces();
    if (trustedList.includes(normalizedCwd)) {
      for (const localName of LOCAL_CONFIG_NAMES) {
        const localPath = resolve(normalizedCwd, localName);
        if (existsSync(localPath)) {
          try {
            const raw = readFileSync(localPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.mcpServers) {
              const tagged = tagAndValidateServers(parsed.mcpServers, "local", globalAllowedCommands);
              mergedConfig.mcpServers = { ...mergedConfig.mcpServers, ...tagged };
            }
            if (parsed.settings) {
              mergedConfig.settings = { ...mergedConfig.settings, ...parsed.settings };
            }
            break;
          } catch (err) {
            writeLog(`Failed to parse local config at ${localPath}: ${err}`, "ERROR");
          }
        }
      }
    }
  }

  // 4. Load custom config if specified (highest precedence, validated)
  if (customPath && existsSync(customPath)) {
    try {
      const raw = readFileSync(customPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.mcpServers) {
        const tagged = tagAndValidateServers(parsed.mcpServers, "custom", globalAllowedCommands);
        mergedConfig.mcpServers = { ...mergedConfig.mcpServers, ...tagged };
      }
      if (parsed.settings) {
        mergedConfig.settings = { ...mergedConfig.settings, ...parsed.settings };
      }
    } catch (err) {
      writeLog(`Failed to parse custom config at ${customPath}: ${err}`, "ERROR");
    }
  }

  // 5. Expand environment variables in config values (${VAR_NAME} → process.env[VAR_NAME])
  mergedConfig.mcpServers = expandEnvVars(mergedConfig.mcpServers);

  return mergedConfig;
}

/**
 * 递归展开字符串中的 ${VAR_NAME} 占位符为 process.env 对应值。
 * 未找到的环境变量保持原样（避免静默替换为空字符串）。
 */
function expandEnvVars<T>(obj: T): T {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? _match;
    }).replace(/\$env:(\w+)/g, (_match, varName: string) => {
      return process.env[varName] ?? _match;
    }) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandEnvVars(value);
    }
    return result as unknown as T;
  }
  return obj;
}
