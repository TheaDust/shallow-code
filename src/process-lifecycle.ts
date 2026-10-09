import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Attach before allowing the child to execute tools. Windows jobs retain orphans. */
export async function ownProcessTree(child: ChildProcess): Promise<{ stop(): Promise<void> }> {
  if (!child.pid) throw new Error("Child process did not start");
  const pid = child.pid;
  let closeJob: (() => void) | undefined;
  if (process.platform === "win32") {
    const { default: koffi } = await import("koffi");
    const kernel = koffi.load("kernel32.dll");
    const create = kernel.func("void * __stdcall CreateJobObjectW(void *, void *)");
    const configure = kernel.func("int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)");
    const open = kernel.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)");
    const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *, void *)");
    const close = kernel.func("int __stdcall CloseHandle(void *)");
    const terminate = kernel.func("int __stdcall TerminateJobObject(void *, uint32_t)");
    const query = kernel.func("int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)");
    if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("Windows job layout requires a 64-bit runtime");
    const job = create(null, null);
    if (!job) throw new Error("CreateJobObject failed");
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    const handle = open(0x0101, 0, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    try {
      if (!configure(job, 9, limits, limits.length) || !handle || !assign(job, handle)) {
        throw new Error("Cannot assign Builder to an owned Windows job");
      }
    } catch (error) { close(job); throw error; }
    finally { if (handle) close(handle); }
    closeJob = () => { close(job); };
    return { async stop() {
      if (!closeJob) return;
      if (!terminate(job, 1)) throw new Error("Cannot terminate Windows job");
      const end = Date.now() + 5_000;
      const accounting = Buffer.alloc(48);
      while (true) {
        if (!query(job, 1, accounting, accounting.length, null)) throw new Error("Cannot inspect Windows job cleanup");
        if (accounting.readUInt32LE(40) === 0) break;
        if (Date.now() >= end) throw new Error("Windows job cleanup timed out");
        await delay(25);
      }
      closeJob(); closeJob = undefined;
    } };
  }
  return { async stop() {
    // The Worker is a group leader; shell tools deliberately inherit its group.
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise<void>(r => child.once("exit", () => r())), delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) throw new Error("Worker cleanup timed out");
    }
  } };
}

/** Tools inherit runtime basics, never model credentials or arbitrary host configuration. */
export function toolEnvironment(): NodeJS.ProcessEnv {
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|localappdata|appdata|lang|lc_all|term|npm_config_cache|npm_config_registry|playwright_download_host|playwright_browsers_path|playwright_skip_browser_gc|shallow_data_dir)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
}

/**
 * Credential-shaped keys the controller must never hand to the candidate, its
 * install/build scripts, or its runtime process. Mirrors the redaction
 * vocabulary used for diagnostics; npm config keys can contain `.` and `/`,
 * so the marker is matched anywhere in the name.
 */
const CREDENTIAL_ENV_KEY = /openai_|api[_-]?key|token|secret|password|credential/i;

/**
 * Environment for candidate processes: the host environment is inherited so
 * npm, Node and platform tooling keep working (proxies, registry settings,
 * temp paths), minus gateway credentials the application has no use for.
 */
export function runtimeEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || CREDENTIAL_ENV_KEY.test(key)) continue;
    environment[key] = value;
  }
  return { ...environment, ...extra };
}
