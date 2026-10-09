import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createBashToolDefinition, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toolEnvironment } from "../process-lifecycle.js";
import { PROGRESS_DIR_NAME } from "../progress-journal.js";
import { createBrowserTool } from "./pi-browser-tool.js";
import { createTestTool } from "./pi-test-tool.js";
import { createAppTool } from "./pi-app-tool.js";
import { installCapability, listCapabilities } from "./capability-catalog.js";

export async function assertToolPath(root: string, input: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const path = resolve(canonicalRoot, input);
  const contained = (value: string) => {
    const rel = relative(canonicalRoot, value);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || rel.split(/[\\/]/).some(part => part.toLowerCase() === ".arc" || part.toLowerCase() === PROGRESS_DIR_NAME)) {
      throw new Error("Tool path is outside the application or accesses private controller evidence");
    }
  };
  contained(path);
  let parent = path;
  while (true) {
    try { contained(await realpath(parent)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  return path;
}

export function assertToolCommand(command: string): void {
  // Defense in depth, not an OS sandbox. Deployment controls filesystem visibility.
  if (/\.arc|run-ledger|run-log|shallow-progress|\/workspace\/tests|\.codex|\.pi[\\/]|(?:^|[\s"'])\.\.[\\/]/i.test(command)) {
    throw new Error("Command accesses controller/private or external paths");
  }
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const BINARY_RUNNERS = new Set(["npx", "pnpx", "bunx"]);

/**
 * Test execution goes through run_tests so suite concurrency stays memory-bounded;
 * ad-hoc test commands in shell bypass that bound and are rejected deterministically.
 * Each pipeline segment is tokenized and anchored on the executable/subcommand, so
 * searches (`grep vitest`) and unrelated scripts (`npm run build -- --mode test`)
 * still work. This is a guard, not a sandbox.
 */
export function assertNotTestCommand(command: string): void {
  if (pipelineSegments(command).some(isTestSegment)) {
    throw new Error("Test commands are not allowed in shell; use the run_tests tool instead: run_tests { target: 'frontend' | 'backend' | 'all', filter?: string }");
  }
}

function pipelineSegments(command: string): string[][] {
  return command.split(/\|\||&&|\||;|\r?\n/).map(segment =>
    (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/, "$2")));
}

function stripAssignments(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  return tokens.slice(index);
}

function executableName(token: string): string {
  const name = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return name.replace(/\.(?:cmd|exe|mjs|cjs|js)$/i, "").replace(/@[^/]*$/, "").toLowerCase();
}

/** Arguments before `--`; everything after is forwarded to the script, not interpreted. */
function leadingArguments(args: string[]): string[] {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

function isTestSegment(raw: string[]): boolean {
  const tokens = stripAssignments(raw);
  if (!tokens.length) return false;
  const executable = executableName(tokens[0]);
  const args = tokens.slice(1);
  if (executable === "vitest") return true;
  if (executable === "node") return nodeRunsTests(args);
  if (PACKAGE_MANAGERS.has(executable)) return packageManagerRunsTests(args);
  if (BINARY_RUNNERS.has(executable)) return binaryRunnerRunsTests(args);
  return false;
}

function nodeRunsTests(args: string[]): boolean {
  if (args.some(arg => arg === "--test")) return true;
  return args.some(arg => /(?:^|\/)vitest(?:\.mjs|\.cjs|\.js)?$/i.test(arg.replace(/\\/g, "/")));
}

function packageManagerRunsTests(args: string[]): boolean {
  const argumentsBeforeForwarding = leadingArguments(args).filter(token => token.length > 0);
  const nonFlags = argumentsBeforeForwarding.filter(token => !token.startsWith("-"));
  const execIndex = nonFlags.findIndex(token => ["exec", "dlx", "x"].includes(token.toLowerCase()));
  if (execIndex !== -1) return nonFlags.slice(execIndex + 1).some(token => executableName(token) === "vitest");
  const runIndex = nonFlags.findIndex(token => ["run", "run-script"].includes(token.toLowerCase()));
  if (runIndex !== -1) {
    const script = nonFlags[runIndex + 1];
    return script !== undefined && scriptNameIsTest(script);
  }
  const first = nonFlags[0];
  if (first !== undefined && (first.toLowerCase() === "t" || first.toLowerCase() === "test")) return true;
  if (first !== undefined && executableName(first) === "vitest") return true;
  // Flag values can precede the subcommand (e.g. `npm --prefix frontend test`).
  const last = nonFlags.at(-1);
  return last !== undefined && (last.toLowerCase() === "t" || last.toLowerCase() === "test");
}

function binaryRunnerRunsTests(args: string[]): boolean {
  const tokens = leadingArguments(args);
  const first = tokens.find(token => !token.startsWith("-"));
  if (first !== undefined && executableName(first) === "vitest") return true;
  return tokens.slice(1).includes("--test");
}

function scriptNameIsTest(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized === "test" || normalized === "tests") return true;
  return normalized.split(/[:.\-]/).some(part => part === "test" || part === "tests");
}

export function createPiTools(cwd: string, managedApp = false): ToolDefinition[] {
  const read = createReadToolDefinition(cwd) as unknown as ToolDefinition;
  const guardedRead = { ...read, execute: async (...args: Parameters<typeof read.execute>) => {
    const params = args[1] as { path: string };
    await assertToolPath(cwd, params.path);
    return (read.execute as ToolDefinition["execute"])(args[0], args[1], args[2], args[3], args[4]);
  } } as ToolDefinition;
  const writable = [createEditToolDefinition(cwd), createWriteToolDefinition(cwd)] as unknown as ToolDefinition[];
  const guardedWritable = writable.map(tool => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
    const params = args[1] as { path: string };
    await assertToolPath(cwd, params.path);
    return (tool.execute as ToolDefinition["execute"])(args[0], args[1], args[2], args[3], args[4]);
  } })) as ToolDefinition[];
  const shell = createBashToolDefinition(cwd, { operations: {
    exec: async (command, directory, { onData, signal, timeout }) => {
      assertToolCommand(command);
      assertNotTestCommand(command);
      await assertToolPath(cwd, directory);
      signal?.throwIfAborted();
      const windows = process.platform === "win32";
      const child = spawn(windows ? "powershell.exe" : "/bin/bash",
        windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["--noprofile", "--norc", "-c", command],
        { cwd: directory, env: toolEnvironment(), windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", onData); child.stderr.on("data", onData);
      let timer: NodeJS.Timeout | undefined;
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      if (timeout && timeout > 0) timer = setTimeout(() => { timedOut = true; abort(); }, timeout * 1000);
      try {
        const exitCode = await new Promise<number | null>((res, rej) => { child.once("error", rej); child.once("exit", res); });
        signal?.throwIfAborted();
        if (timedOut) throw new Error("Command timed out");
        return { exitCode };
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.stdout.destroy(); child.stderr.destroy();
      }
    },
  } });
  // Retain the SDK schema and output truncation, replace only the execution backend.
  shell.name = "shell";
  shell.description = `Run a short ${process.platform === "win32" ? "PowerShell" : "Bash"} command in the application. Use this for file searches, builds and type checks; run tests with the run_tests tool instead. ${managedApp ? "Use the app tool to start and stop the application for browser checks." : "Do not start persistent servers; briefly starting the app in the background for a browser-tool check is allowed when instructed."}`;
  const listCapabilityParameters = Type.Object({});
  const installCapabilityParameters = Type.Object({
    id: Type.String({ description: "Approved capability id returned by list_capabilities" }),
  });
  const listCapabilityTool: ToolDefinition<typeof listCapabilityParameters> = {
    name: "list_capabilities",
    label: "List approved capabilities",
    description: "List controller-approved, task-neutral capability packs and whether each is already installed. The catalog never exposes business code or arbitrary packages.",
    promptSnippet: "list_capabilities: inspect approved task-neutral component packs",
    parameters: listCapabilityParameters,
    executionMode: "sequential",
    async execute() {
      await assertToolPath(cwd, "frontend/src/ui");
      const capabilities = await listCapabilities(cwd);
      return { content: [{ type: "text" as const, text: JSON.stringify(capabilities, null, 2) }], details: { capabilities } };
    },
  };
  const installCapabilityTool: ToolDefinition<typeof installCapabilityParameters> = {
    name: "install_capability",
    label: "Install approved capability",
    description: "Install one controller-approved, task-neutral capability pack. Existing differing files are never overwritten; arbitrary npm/git sources are not accepted.",
    promptSnippet: "install_capability: install an approved component pack without overwriting existing files",
    parameters: installCapabilityParameters,
    executionMode: "sequential",
    async execute(_toolCallId, { id }) {
      await assertToolPath(cwd, "frontend/src/ui");
      const result = await installCapability(cwd, id);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
  return [guardedRead, ...guardedWritable, shell as unknown as ToolDefinition, createTestTool(cwd), createBrowserTool(),
    listCapabilityTool, installCapabilityTool, ...(managedApp ? [createAppTool()] : [])];
}
