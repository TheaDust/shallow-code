import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../index.js";
import { readEnvFile } from "../src/runtime-config.js";
import { withTempDir } from "./helpers/temp-dir.js";

for (const [name, value] of Object.entries(await readEnvFile(".env"))) {
  if (!(name in process.env)) process.env[name] = value;
}
const enabled = process.env.RUN_CREDENTIAL_SMOKE === "1" && ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL"].every(name => process.env[name]);
test("credential smoke uses real Pi Builder and Checker with independent Web evidence", {
  skip: enabled ? false : "set RUN_CREDENTIAL_SMOKE=1 and gateway credentials",
}, async () => {
  await withTempDir("shallow-credential-", async directory => {
    const requirements = join(directory, "requirements"), output = join(directory, "app"), runs = join(directory, "runs");
    await mkdir(requirements);
    await writeFile(join(requirements, "requirements.yaml"), JSON.stringify({ id: "ROOT", name: "Profile", type: "ROOT", children: [{
      id: "PROFILE", name: "Save profile", type: "ATOMIC", dependencies: [],
      description: "Provide a visibly labelled Profile name input and Save button. Save the name persistently.",
      scenarios: [{ id: "save", name: "Save and refresh", steps: [
        { keyword: "GIVEN", content: "The profile page is open." },
        { keyword: "WHEN", content: "Enter Ada in Profile name and click Save, then refresh." },
        { keyword: "THEN", content: "Profile name contains Ada." },
      ] }],
    }] }));
    const code = await main(["--requirements-dir", requirements, "--output-dir", output], { ...process.env, SHALLOW_RUN_DIR: runs }, undefined, null);
    assert.equal(code, 0);
    const result = JSON.parse(await readFile(join(runs, (await readdir(runs))[0], "result.json"), "utf8"));
    assert.deepEqual(result.verifiedRequirementIds, ["PROFILE"]);
    assert.equal(result.checker.mode, "active");
  });
});
