import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const CMD_METACHARACTERS = /[&|<>^"%!\r\n]/;

export function spawnProcess(
  executable: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(executable)) {
    return spawn(executable, args, options);
  }
  for (const token of [executable, ...args]) {
    if (CMD_METACHARACTERS.test(token)) {
      throw new Error(
        `Refusing to run "${executable}" through cmd.exe: argument ${JSON.stringify(token)} contains shell metacharacters`,
      );
    }
  }
  const command = /\s/.test(executable) ? `"${executable}"` : executable;
  const quotedArgs = args.map((arg) => `"${arg.replace(/(\\+)$/, "$1$1")}"`);
  const line = [command, ...quotedArgs].join(" ");
  return spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}
