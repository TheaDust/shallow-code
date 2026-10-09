import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CommandAppLifecycle, CandidatePreparationError, runCommand } from "./final-verifier.js";
import { runGit } from "./git-ops.js";
import { sharedMemoryGate, type MemoryGate } from "./memory-gate.js";
import { PROGRESS_DIR_NAME, isProgressPath } from "./progress-journal.js";
import { copyInheritedData } from "./inherited-data.js";
import type { AppLifecycle } from "./pipeline.js";
import type { CandidateEvidence, PlatformContract, RunEvent } from "./types.js";

/** Headroom reserved before candidate dependency installs and production builds. */
const CANDIDATE_INSTALL_HEADROOM_BYTES = 600 * 1_048_576;
const CANDIDATE_BUILD_HEADROOM_BYTES = 500 * 1_048_576;

type Snapshot = Map<string, { digest: string; mode: number }>;
type RunningApp = Awaited<ReturnType<AppLifecycle["start"]>>;
type Build = Omit<CandidateEvidence, "runtimeId"> & { dependencyState: string };

/** One private build workspace per run. No Judge input is stored here or exposed by the tools. */
export class CandidateRuntime {
  readonly directory: string;
  private build?: Build;
  private installedKey?: string;
  private installedState?: string;
  private acceptedInputDigest?: string;
  private application?: RunningApp;
  private dataDirectory?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private recorder?: (event: RunEvent) => Promise<void>;
  private commandAbort?: AbortController;

  constructor(
    private readonly outputDir: string,
    private readonly workspace: string,
    private readonly contract: PlatformContract,
    private readonly lifecycle: AppLifecycle = new CommandAppLifecycle(),
    private readonly memoryGate: MemoryGate = sharedMemoryGate(),
  ) {
    this.directory = join(resolve(workspace), "app");
    if (inside(resolve(outputDir), resolve(workspace)) || inside(resolve(workspace), resolve(outputDir))) {
      throw new Error("Candidate workspace must be separate from output directory");
    }
  }

  setRecorder(recorder: (event: RunEvent) => Promise<void>): void { this.recorder = recorder; }

  async prepare(): Promise<void> {
    await this.serial(async () => { await this.stop(); await this.prepareBuild(); });
  }

  async start(_outputDir: string, _contract: PlatformContract): Promise<RunningApp> {
    await this.prepare();
    return this.launch();
  }

  async assertCurrent(evidence: CandidateEvidence): Promise<void> {
    if (!this.build || this.build.candidateId !== evidence.candidateId || this.build.buildId !== evidence.buildId ||
      this.build.applicationDigest !== evidence.applicationDigest || this.build.inputDigest !== evidence.inputDigest ||
      !await this.matches(this.build)) {
      this.build = undefined;
      throw new CandidatePreparationError("candidate", "Candidate files or build changed; verification evidence is invalid");
    }
  }

  recordAccepted(evidence: CandidateEvidence): void { this.acceptedInputDigest = evidence.inputDigest; }

  async assertAcceptedInput(): Promise<void> {
    if (this.acceptedInputDigest && await restorableInputDigest(this.outputDir) !== this.acceptedInputDigest) {
      throw new CandidatePreparationError("candidate", "Accepted candidate changed before delivery; verification evidence is invalid");
    }
  }

  async stop(): Promise<void> {
    const application = this.application;
    if (application) {
      await application.stop();
      this.application = undefined;
    }
    if (this.dataDirectory) {
      await rm(this.dataDirectory, { recursive: true, force: true });
      this.dataDirectory = undefined;
    }
  }

  async close(): Promise<void> {
    this.commandAbort?.abort();
    await this.queue.catch(() => {});
    await this.stop();
  }

  /** Close the runtime, then delete its private build workspace (audit artifacts live outside it). */
  async dispose(): Promise<void> {
    await this.close();
    await rm(resolve(this.workspace), { recursive: true, force: true });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  private async emit(type: "candidate_prepared" | "candidate_prepare_failed", detail: Record<string, unknown>): Promise<void> {
    await this.recorder?.({ at: new Date().toISOString(), type, detail } as RunEvent);
  }

  private async prepareBuild(): Promise<void> {
    const started = Date.now();
    let stage: "install" | "build" | "candidate" = "candidate";
    this.commandAbort = new AbortController();
    const signal = this.commandAbort.signal;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const sourceRoot = await realpath(this.outputDir);
      const buildRoot = await realpath(this.directory);
      if ((await lstat(this.directory)).isSymbolicLink() || !inside(await realpath(this.workspace), buildRoot)) {
        throw new Error("Candidate application directory must remain inside its private workspace");
      }
      if (inside(sourceRoot, buildRoot) || inside(buildRoot, sourceRoot)) throw new Error("Candidate workspace resolves into output directory");
      if (this.build && await this.matches(this.build)) {
        await this.emit("candidate_prepared", { ...this.publicBuild(this.build), reused: true, installed: false,
          durationMs: Date.now() - started, installMs: 0, buildMs: 0 });
        return;
      }
      this.build = undefined;
      const inputs = await snapshot(this.outputDir);
      const fullInputDigest = digestSnapshot(inputs);
      const inputDigest = await restorableInputDigest(this.outputDir);
      const installKey = await dependencyKey(this.outputDir, inputs, this.contract);
      const dependencies = await dependencyState(this.directory);
      const reuseInstall = this.installedKey === installKey && this.installedState === dependencies;
      // Clear every previous application file, including old ignored build output; retain only owned dependencies.
      await clearApplication(this.directory, reuseInstall);
      for (const [path] of inputs) {
        const target = join(this.directory, path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(this.outputDir, path), target);
      }
      if (digestSnapshot(await snapshot(this.directory)) !== fullInputDigest ||
        digestSnapshot(await snapshot(this.outputDir)) !== fullInputDigest) {
        throw new Error("Candidate changed while copying build inputs");
      }
      signal.throwIfAborted();
      stage = "install";
      let installMs = 0;
      if (!reuseInstall) {
        this.installedKey = undefined;
        this.installedState = undefined;
        const at = Date.now();
        await this.memoryGate.waitForHeadroom(CANDIDATE_INSTALL_HEADROOM_BYTES, signal);
        for (const command of this.contract.installCommands) {
          await runCommand(this.directory, command, this.contract.buildTimeoutMs, signal);
        }
        installMs = Date.now() - at;
      }
      stage = "build";
      const buildAt = Date.now();
      await this.memoryGate.waitForHeadroom(CANDIDATE_BUILD_HEADROOM_BYTES, signal);
      for (const command of this.contract.buildCommands) {
        await runCommand(this.directory, command, this.contract.buildTimeoutMs, signal);
      }
      const buildMs = Date.now() - buildAt;
      signal.throwIfAborted();
      stage = "candidate";
      if (digestSnapshot(await snapshot(this.outputDir)) !== fullInputDigest) throw new Error("Candidate changed during preparation");
      const applicationDigest = digestSnapshot(await snapshot(this.directory));
      const currentDependencies = await dependencyState(this.directory);
      this.installedKey = installKey;
      this.installedState = currentDependencies;
      this.build = { candidateId: randomUUID(), buildId: randomUUID(), inputDigest, applicationDigest,
        dependencyState: currentDependencies };
      await this.emit("candidate_prepared", { ...this.publicBuild(this.build), reused: false, installed: !reuseInstall,
        durationMs: Date.now() - started, installMs, buildMs });
    } catch (error) {
      this.build = undefined;
      this.installedKey = undefined;
      this.installedState = undefined;
      const message = error instanceof Error ? error.message : String(error);
      await this.emit("candidate_prepare_failed", { stage, message, durationMs: Date.now() - started });
      throw new CandidatePreparationError(stage, message);
    } finally { this.commandAbort = undefined; }
  }

  private publicBuild(build: Build): Omit<CandidateEvidence, "runtimeId"> {
    const { dependencyState: _state, ...identity } = build;
    return identity;
  }

  private async matches(build: Build): Promise<boolean> {
    const inputs = await snapshot(this.outputDir);
    return await restorableInputDigest(this.outputDir) === build.inputDigest &&
      await dependencyKey(this.outputDir, inputs, this.contract) === this.installedKey &&
      digestSnapshot(await snapshot(this.directory)) === build.applicationDigest &&
      await dependencyState(this.directory) === build.dependencyState;
  }

  private async launch(): Promise<RunningApp> {
    const build = this.build!;
    const dataRoot = join(resolve(this.workspace), "data");
    await mkdir(dataRoot, { recursive: true });
    if (!inside(await realpath(this.workspace), await realpath(dataRoot)) || (await lstat(dataRoot)).isSymbolicLink()) {
      throw new Error("Candidate data directory must remain inside its private workspace");
    }
    const dataDirectory = await mkdtemp(join(dataRoot, "execution-"));
    this.dataDirectory = dataDirectory;
    let application: RunningApp;
    try {
      await copyInheritedData(this.directory, dataDirectory);
      application = await this.lifecycle.start(this.directory, { ...this.contract, dataDirectory });
    }
    catch (error) { await this.stop(); throw error; }
    this.application = application;
    const candidate: CandidateEvidence = { ...this.publicBuild(build), runtimeId: randomUUID() };
    try { await this.assertCurrent(candidate); } catch (error) { await this.stop(); throw error; }
    return { baseUrl: application.baseUrl, candidate,
      assertUnchanged: async () => { await application.assertUnchanged?.(); await this.assertCurrent(candidate); }, stop: () => this.stop() };
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../"));
}

async function snapshot(root: string): Promise<Snapshot> {
  const files: Snapshot = new Map();
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.name === "node_modules" || (!prefix && [".git", ".arc", PROGRESS_DIR_NAME].includes(entry.name))) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Application links are not supported: ${path}`);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) {
        const before = await lstat(absolute);
        const content = await readFile(absolute);
        const after = await lstat(absolute);
        if (after.isSymbolicLink() || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error("Application changed while hashing");
        files.set(path, { digest: hash(content), mode: before.mode & 0o111 });
      } else throw new Error(`Unsupported application file: ${path}`);
    }
  }
  await visit(root);
  return files;
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function digestSnapshot(files: Snapshot): string { return hash(JSON.stringify([...files])); }

/**
 * On Windows Git may re-checkout tracked text files with CRLF (core.autocrlf),
 * Normalize only paths for which Git enables text conversion. Binary assets and
 * -text paths retain their exact bytes. Copy integrity remains byte-exact too.
 */
function hashApplicationContent(content: Buffer, normalize: boolean): string {
  if (!normalize || !content.includes(0x0d)) return hash(content);
  const normalized = Buffer.allocUnsafe(content.length);
  let length = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0d && content[index + 1] === 0x0a) continue;
    normalized[length++] = content[index];
  }
  return hash(normalized.subarray(0, length));
}

function normalizesLineEndings(info: string, autoCrlf: boolean): boolean {
  const match = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*)$/.exec(info);
  if (!match) throw new Error("Unexpected git ls-files --eol output");
  const [, indexed, working, rawAttributes] = match;
  const attributes = rawAttributes.trim();
  if (working === "-text" || attributes === "-text") return false;
  if (/^text(?: |$)/.test(attributes)) return true;
  // Auto conversion preserves files already committed with CRLF.
  return (attributes.startsWith("text=auto") || autoCrlf) && indexed !== "crlf" && indexed !== "mixed";
}

/**
 * Digest over exactly the files a Git rollback can restore: tracked files plus
 * untracked-but-not-ignored files. Ignored runtime/build artifacts (dist, data,
 * dependencies) cannot be rolled back, so they must not be part of acceptance
 * evidence; otherwise a failed repair leaves drift the rollback cannot clear.
 * Falls back to the full snapshot when the output directory is not its own
 * repository root (unit-test fixtures).
 */
async function restorableInputDigest(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    const toplevel = await runGit(canonical, ["rev-parse", "--show-toplevel"], true);
    if (toplevel.code === 0 && samePathish(await realpath(toplevel.stdout.trim()), canonical)) {
      const listed = await runGit(canonical, ["ls-files", "-c", "-o", "--exclude-standard", "--eol", "-z"], true);
      if (listed.code === 0) {
        const config = await runGit(canonical, ["config", "--type=bool-or-str", "--get", "core.autocrlf"], true);
        const autoCrlf = /^(true|input)$/.test(config.stdout.trim());
        const paths = new Map<string, boolean>();
        for (const entry of listed.stdout.split("\0").filter(Boolean)) {
          const separator = entry.indexOf("\t");
          if (separator < 0) throw new Error("Unexpected git ls-files --eol output");
          const path = entry.slice(separator + 1);
          if (path === ".arc" || path.startsWith(".arc/") || isProgressPath(path)) continue;
          paths.set(path, normalizesLineEndings(entry.slice(0, separator), autoCrlf));
        }
        const files: Snapshot = new Map();
        for (const path of [...paths.keys()].sort()) {
          const absolute = join(canonical, path);
          const before = await lstat(absolute).catch(() => undefined);
          if (!before?.isFile()) continue;
          const content = await readFile(absolute);
          const after = await lstat(absolute).catch(() => undefined);
          if (!after || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
            throw new Error("Application changed while hashing");
          }
          files.set(path, { digest: hashApplicationContent(content, paths.get(path)!), mode: before.mode & 0o111 });
        }
        return digestSnapshot(files);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Application changed while hashing") throw error;
  }
  return digestSnapshot(await snapshot(root));
}

function samePathish(left: string, right: string): boolean {
  return left.replace(/[\\/]$/, "").toLowerCase() === right.replace(/[\\/]$/, "").toLowerCase();
}

async function clearApplication(directory: string, keepDependencies: boolean): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === "node_modules" && keepDependencies) continue;
    if (entry.isDirectory() && entry.name !== "node_modules") {
      await clearApplication(path, keepDependencies);
      if ((await readdir(path)).length === 0) await rm(path, { recursive: true });
    } else await rm(path, { recursive: true, force: true });
  }
}

async function dependencyKey(root: string, inputs: Snapshot, contract: PlatformContract): Promise<string> {
  const entries: unknown[] = [process.version, process.platform, process.arch, process.execPath, process.env, contract];
  let sourceSensitive = false;
  for (const [path, value] of inputs) {
    const name = path.split("/").at(-1)!;
    if (["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc", "yarn.lock", "pnpm-lock.yaml"].includes(name)) entries.push([path, value]);
    if (name === "package.json") {
      const pkg = JSON.parse(await readFile(join(root, path), "utf8"));
      if (pkg.workspaces || ["preinstall", "install", "postinstall", "prepare"].some((key) => pkg.scripts?.[key]) ||
        Object.values({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).some((value) =>
          typeof value === "string" && /^(?:file:|link:|workspace:|\.|\/)/.test(value))) sourceSensitive = true;
    }
  }
  const config = process.env.NPM_CONFIG_USERCONFIG ?? process.env.npm_config_userconfig ?? join(homedir(), ".npmrc");
  try { entries.push(hash(await readFile(config))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (sourceSensitive) entries.push(digestSnapshot(inputs));
  return hash(JSON.stringify(entries));
}

/** Detect normal mutation/removal of owned installed packages without rehashing all dependency bytes. */
async function dependencyState(root: string): Promise<string> {
  const entries: unknown[] = [];
  async function visit(directory: string, prefix: string, dependency: boolean): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      const included = dependency || entry.name === "node_modules";
      if (included) {
        const stat = await lstat(absolute);
        entries.push([path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.ino,
          entry.isSymbolicLink() ? await readlink(absolute) : ""]);
      }
      if (entry.isDirectory()) await visit(absolute, path, included);
    }
  }
  await visit(root, "", false);
  return hash(JSON.stringify(entries));
}
