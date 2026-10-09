import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { installCapability, listCapabilities } from "../src/builder/capability-catalog.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("approved capability installs task-neutral UI files without overwriting", async () => {
  await withTempDir("shallow-capability-", async root => {
    await mkdir(join(root, "frontend", "src"), { recursive: true });
    const before = await listCapabilities(root);
    assert.deepEqual(before.map(item => [item.id, item.status]), [["accessible-ui", "available"]]);

    const installed = await installCapability(root, "accessible-ui");
    assert.equal(installed.status, "installed");
    assert.ok(installed.copiedFiles.includes("frontend/src/ui/Dialog.tsx"));
    assert.match(await readFile(join(root, "frontend/src/ui/Menu.tsx"), "utf8"), /role="menu"/);

    const repeated = await installCapability(root, "accessible-ui");
    assert.equal(repeated.status, "installed");
    assert.deepEqual(repeated.copiedFiles, []);

    await writeFile(join(root, "frontend/src/ui/Button.tsx"), "export const Button = 'custom';\n", "utf8");
    await assert.rejects(installCapability(root, "accessible-ui"), /would overwrite existing files: Button\.tsx/);
    assert.equal(await readFile(join(root, "frontend/src/ui/Button.tsx"), "utf8"), "export const Button = 'custom';\n");
  });
});

test("approved capability rejects unknown ids and missing React source layouts", async () => {
  await withTempDir("shallow-capability-invalid-", async root => {
    await assert.rejects(installCapability(root, "unknown"), /Approved ids: accessible-ui/);
    await assert.rejects(installCapability(root, "accessible-ui"), /requires an existing frontend\/src/);
  });
});
