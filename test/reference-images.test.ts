import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadReferenceImages } from "../src/builder/reference-images.js";
import { withTempDir } from "./helpers/temp-dir.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("Reference images are loaded from the requirements directory and deduplicated", async () => {
  await withTempDir("shallow-reference-", async (directory) => {
    await mkdir(join(directory, "reference"));
    await writeFile(join(directory, "reference", "界面.png"), PNG);
    const result = await loadReferenceImages(directory, ["reference/界面.png", "reference/界面.png"]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.images, [{
      reference: "reference/界面.png", mime: "image/png", dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
    }]);
  });
});

test("Invalid, missing and out-of-directory references are skipped without exposing file contents", async () => {
  await withTempDir("shallow-reference-", async (directory) => {
    const root = join(directory, "requirements");
    await mkdir(root);
    await writeFile(join(directory, "outside.png"), PNG);
    await writeFile(join(root, "fake.png"), "private text, not a picture");
    await writeFile(join(root, "large.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
    const references = ["../outside.png", "%2e%2e/outside.png", join(directory, "outside.png"),
      "https://example.com/image.png", "missing.png", "fake.png", "large.png", "file.svg"];
    const result = await loadReferenceImages(root, references);
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.skipped.map((entry) => entry.reference), references);
    assert.doesNotMatch(JSON.stringify(result), /private text|data:image/);
  });
});

test("Reference directory links cannot expose images outside the requirements directory", async () => {
  await withTempDir("shallow-reference-link-", async (directory) => {
    const root = join(directory, "requirements");
    const outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "ui.png"), PNG);
    await symlink(outside, join(root, "reference"), process.platform === "win32" ? "junction" : "dir");
    const result = await loadReferenceImages(root, ["reference/ui.png"]);
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.skipped, [{ reference: "reference/ui.png", reason: "outside_requirements" }]);
  });
});
