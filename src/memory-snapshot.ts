import { readFile } from "node:fs/promises";
import { posix } from "node:path";

export interface CgroupMemoryMount {
  version: 1 | 2;
  directory: string;
}

/** Resolve the process's actual cgroup mount, including container mount namespaces. */
export async function resolveCgroupMemoryMount(): Promise<CgroupMemoryMount | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const groups = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n");
    const mounts = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n");
    for (const line of mounts) {
      const [fields, filesystem] = line.split(" - ");
      const version = filesystem.startsWith("cgroup2 ") ? 2 : filesystem.startsWith("cgroup ") && filesystem.split(" ")[2]?.split(",").includes("memory") ? 1 : 0;
      if (!version) continue;
      const group = groups.find(value => version === 2 ? value.startsWith("0::") : value.split(":")[1].split(",").includes("memory"));
      if (!group) continue;
      const parts = fields.split(" ").map(value => value.replace(/\\040/g, " "));
      const subpath = posix.relative(parts[3], group.split(":").slice(2).join(":"));
      const directory = posix.join(parts[4], subpath.startsWith("..") ? "" : subpath);
      return { version: version as 1 | 2, directory };
    }
  } catch { /* Resource counters are diagnostic, never a reason to skip behavior. */ }
  return undefined;
}
