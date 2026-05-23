// stdio-transport.ts
import { spawn, ChildProcess } from "node:child_process";
import readline from "node:readline";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeLog } from "./logger.js";

const SIGKILL_GRACE_PERIOD_MS = 3_000;

/**
 * Callbacks that a transport fires to notify the upper {@link SimpleMcpClient} layer.
 */
export interface TransportHooks {
  /** A JSON-RPC response (or notification) arrived from the server */
  onMessage: (response: any) => void;
  /** The underlying connection terminated unexpectedly */
  onExit: (reason: string) => void;
}

/**
 * Resolve npx binary directly from npm cache to avoid npm parent process overhead.
 */
function resolveNpxBinary(packageSpec: string): { binPath: string; isJs: boolean } | null {
  try {
    const npxCacheDir = join(homedir(), ".npm", "_npx");
    if (!existsSync(npxCacheDir)) return null;

    const hashDirs = readdirSync(npxCacheDir);
    for (const hashDir of hashDirs) {
      const nodeModulesPath = join(npxCacheDir, hashDir, "node_modules");
      if (!existsSync(nodeModulesPath)) continue;

      const targetPackagePath = join(nodeModulesPath, packageSpec);
      if (!existsSync(targetPackagePath)) continue;

      const pkgJsonPath = join(targetPackagePath, "package.json");
      if (!existsSync(pkgJsonPath)) continue;

      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const binField = pkg.bin;
      if (!binField) continue;

      let binRel: string | undefined;
      if (typeof binField === "string") {
        binRel = binField;
      } else if (typeof binField === "object") {
        const baseName = packageSpec.includes("/") ? packageSpec.split("/")[1] : packageSpec;
        binRel = binField[baseName] || Object.values(binField)[0];
      }

      if (binRel) {
        const fullBinPath = resolve(targetPackagePath, binRel);
        if (existsSync(fullBinPath)) {
          const isJs = fullBinPath.endsWith(".js") || fullBinPath.endsWith(".cjs") || fullBinPath.endsWith(".mjs");
          return { binPath: fullBinPath, isJs };
        }
      }
    }
  } catch (err) {
    writeLog(`Error in resolveNpxBinary: ${err}`, "DEBUG");
  }
  return null;
}

/**
 * MCP transport over a local child process (stdin/stdout JSON-RPC).
 *
 * Spawns the configured command, parses newline-delimited JSON on stdout,
 * writes JSON-RPC payloads to stdin, and handles process lifecycle events.
 *
 * Includes an npx cache resolver that skips the npm parent process when
 * the target package is already installed globally.
 */
export class StdioTransport {
  private child: ChildProcess | null = null;
  private hooks: TransportHooks | null = null;
  private stderrBuffer: string[] = [];
  private isClosed = false;
  private serverName: string;
  private command: string;
  private args: string[];
  private env?: Record<string, string>;
  private cwd?: string;
  private debug: boolean;

  constructor(
    serverName: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
    cwd?: string,
    debug = false,
  ) {
    this.serverName = serverName;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.debug = debug;
  }

  async connect(hooks: TransportHooks): Promise<any> {
    this.hooks = hooks;
    this.isClosed = false;
    this.stderrBuffer = [];

    const finalEnv = { ...process.env, ...this.env };

    let spawnCmd = this.command;
    let spawnArgs = [...this.args];

    // npx resolution: try to resolve directly from npm cache
    if (spawnCmd === "npx") {
      const resolved = this.resolveNpxToDirect(spawnArgs);
      if (resolved) {
        spawnCmd = resolved.cmd;
        spawnArgs = resolved.args;
      }
    }

    this.child = spawn(spawnCmd, spawnArgs, {
      env: finalEnv,
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdin!.on("error", (err) => {
      writeLog(`[${this.serverName}] stdin stream error: ${err.message}`, "WARN");
    });

    const rl = readline.createInterface({
      input: this.child.stdout!,
      terminal: false,
    });

    rl.on("line", (line) => {
      if (this.isClosed) return;
      try {
        const response = JSON.parse(line);
        this.hooks?.onMessage(response);
      } catch (err) {
        writeLog(`[${this.serverName}] Failed to parse stdout line: ${line}. Error: ${err}`, "ERROR");
      }
    });

    // Stderr logging
    const stderrRl = readline.createInterface({
      input: this.child.stderr!,
      terminal: false,
    });
    stderrRl.on("line", (line) => {
      const safeLine = line.length > 300 ? line.substring(0, 297) + "..." : line;
      writeLog(`[${this.serverName} stderr] ${safeLine}`, "INFO");
      if (this.debug) {
        writeLog(`[${this.serverName} debug] ${safeLine}`, "INFO");
      }
      this.stderrBuffer.push(safeLine);
      if (this.stderrBuffer.length > 20) {
        this.stderrBuffer.shift();
      }
    });

    // Process lifecycle
    this.child.on("exit", (code, signal) => {
      let crashReason = "";
      if (code !== 0 && code !== null && this.stderrBuffer.length > 0) {
        crashReason = `\nLast server outputs:\n${this.stderrBuffer.map(l => `  > ${l}`).join("\n")}`;
      }
      writeLog(`[${this.serverName}] Process exited. Code: ${code}, Signal: ${signal}`, "WARN");
      if (!this.isClosed) {
        this.isClosed = true;
        this.hooks?.onExit(`MCP server process exited unexpectedly (code ${code}, signal ${signal}).${crashReason}`);
      }
    });

    this.child.on("error", (err) => {
      writeLog(`[${this.serverName}] Process error: ${err}`, "ERROR");
      if (!this.isClosed) {
        this.isClosed = true;
        this.hooks?.onExit(err.message);
      }
    });

    // Return a placeholder — the actual init is handled by SimpleMcpClient.request()
    return null;
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    if (this.isClosed || !this.child?.stdin) {
      throw new Error(`STDIO server "${this.serverName}" is not connected.`);
    }
    const payloadStr = JSON.stringify(payload) + "\n";
    return new Promise((resolve, reject) => {
      this.child!.stdin!.write(payloadStr, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async sendNotification(payload: Record<string, unknown>): Promise<void> {
    return this.send(payload);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.child) {
      const child = this.child;
      this.child = null;

      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }

      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          resolve();
        }, SIGKILL_GRACE_PERIOD_MS);

        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  }

  private resolveNpxToDirect(args: string[]): { cmd: string; args: string[] } | null {
    let packageSpec: string | undefined;
    let argStartIndex = 0;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-y" || args[i] === "--yes") continue;
      if (!args[i].startsWith("-")) {
        packageSpec = args[i];
        argStartIndex = i + 1;
        break;
      }
    }

    if (!packageSpec) return null;

    const resolved = resolveNpxBinary(packageSpec);
    if (!resolved) {
      writeLog(`[${this.serverName}] npx-resolver bypassed: ${packageSpec} not found in cache, falling back to npx`, "INFO");
      return null;
    }

    writeLog(`[${this.serverName}] npx-resolver matched: ${packageSpec} -> ${resolved.binPath}`, "INFO");
    const extraArgs = args.slice(argStartIndex);
    if (resolved.isJs) {
      return { cmd: process.execPath || "node", args: [resolved.binPath, ...extraArgs] };
    }
    return { cmd: resolved.binPath, args: extraArgs };
  }
}
