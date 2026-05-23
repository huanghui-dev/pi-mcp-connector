// cache.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { MetadataCache, ServerCacheEntry, McpTool, McpResource } from "./types.js";
import { writeLog } from "./logger.js";

const CACHE_FILE_PATH = join(homedir(), ".pi", "agent", "mcp-connector-cache.json");

// In-memory cache singleton to avoid repeated disk reads
let _memoryCache: MetadataCache | null = null;

/**
 * Basic structural validation for deserialized cache data.
 * Returns true if the data looks like a valid MetadataCache.
 */
function isValidCacheStructure(data: unknown): data is MetadataCache {
  if (data === null || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (obj.servers === null || typeof obj.servers !== "object") return false;

  for (const [_, entry] of Object.entries(obj.servers as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (!Array.isArray(e.tools)) return false;
    if (typeof e.hash !== "string") return false;
    if (e.resources !== undefined && !Array.isArray(e.resources)) return false;
  }
  return true;
}

export function loadMetadataCache(): MetadataCache {
  if (_memoryCache) return _memoryCache;

  if (existsSync(CACHE_FILE_PATH)) {
    try {
      const raw = readFileSync(CACHE_FILE_PATH, "utf8");
      const parsed = JSON.parse(raw);

      if (isValidCacheStructure(parsed)) {
        _memoryCache = parsed;
        return _memoryCache;
      } else {
        writeLog("Metadata cache file has invalid structure, ignoring.", "WARN");
      }
    } catch (err) {
      writeLog(`Failed to parse metadata cache: ${err}`, "ERROR");
    }
  }
  _memoryCache = { servers: {} };
  return _memoryCache;
}

export function saveMetadataCache(cache: MetadataCache): void {
  try {
    const dir = dirname(CACHE_FILE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CACHE_FILE_PATH, JSON.stringify(cache, null, 2), "utf8");
    _memoryCache = cache;
  } catch (err) {
    writeLog(`Failed to save metadata cache: ${err}`, "ERROR");
  }
}

export function updateServerCache(
  serverName: string,
  tools: McpTool[],
  resources: McpResource[],
  hash: string
): void {
  const cache = loadMetadataCache();
  cache.servers[serverName] = {
    tools,
    resources: resources || [],
    hash,
  };
  saveMetadataCache(cache);
}
