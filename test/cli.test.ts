import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { discoverRequirementsDir, parseCliArgs } from "../src/cli.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Build is the only development command", () => {
  for (const command of ["resume", "apply"]) {
    assert.throws(() => parseCliArgs([command]), /Unknown argument/);
  }
});

test("CLI resolves required paths and parses a positive budget", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--output-dir",
    "C:/fixture/output",
    "--budget-ms",
    "600000",
  ]);

  assert.deepEqual(parsed, {
    requirementsDir: resolve("C:/fixture/requirements"),
    outputDir: resolve("C:/fixture/output"),
    budgetMs: 600_000,
  });
});

test("CLI applies the configured default output directory when --output-dir is omitted", () => {
  const parsed = parseCliArgs(
    ["--requirements-dir", "C:/fixture/requirements", "--budget-ms", "600000"],
    { defaultOutputDir: "C:/fixture/default-output" },
  );

  assert.equal(parsed.outputDir, resolve("C:/fixture/default-output"));
});

test("CLI prefers an explicit --output-dir over the configured default", () => {
  const parsed = parseCliArgs(
    [
      "--requirements-dir",
      "C:/fixture/requirements",
      "--output-dir",
      "C:/fixture/output",
    ],
    { defaultOutputDir: "C:/fixture/default-output" },
  );

  assert.equal(parsed.outputDir, resolve("C:/fixture/output"));
});

test("CLI rejects a missing --output-dir when no default is configured", () => {
  assert.throws(
    () =>
      parseCliArgs(["--requirements-dir", "C:/fixture/requirements", "--budget-ms", "600000"]),
    /--output-dir/,
  );
});

test("CLI treats an omitted budget as unlimited", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--output-dir",
    "C:/fixture/output",
  ]);

  assert.deepEqual(parsed, {
    requirementsDir: resolve("C:/fixture/requirements"),
    outputDir: resolve("C:/fixture/output"),
    budgetMs: 0,
  });
});

test("CLI accepts an explicit zero budget as unlimited", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--output-dir",
    "C:/fixture/output",
    "--budget-ms",
    "0",
  ]);

  assert.equal(parsed.budgetMs, 0);
});

test("CLI rejects a negative or non-integer budget", () => {
  for (const budget of ["-1", "2.5", "nope"]) {
    assert.throws(
      () =>
        parseCliArgs([
          "--requirements-dir",
          "C:/fixture/requirements",
          "--output-dir",
          "C:/fixture/output",
          "--budget-ms",
          budget,
        ]),
      /--budget-ms/,
    );
  }
});

test("CLI takes over an existing project with --project", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--project",
    "C:/projects/existing-web",
  ]);

  assert.deepEqual(parsed, {
    requirementsDir: resolve("C:/fixture/requirements"),
    outputDir: resolve("C:/projects/existing-web"),
    budgetMs: 0,
    projectDir: resolve("C:/projects/existing-web"),
  });
});

test("CLI rejects naming the run directory twice", () => {
  assert.throws(
    () =>
      parseCliArgs([
        "--requirements-dir",
        "C:/fixture/requirements",
        "--project",
        "C:/projects/existing-web",
        "--output-dir",
        "C:/fixture/output",
      ]),
    /either --project or --output-dir/,
  );
});

test("CLI rejects unknown arguments", () => {
  assert.throws(
    () =>
      parseCliArgs([
        "--requirements-dir",
        "C:/fixture/requirements",
        "--output-dir",
        "C:/fixture/output",
        "--budget-ms",
        "600000",
        "--mystery",
        "value",
      ]),
    /--mystery/,
  );
});

test("CLI resolves the requirements directory from the discovery default only when the flag is absent", () => {
  let discoveries = 0;
  const options = {
    defaultOutputDir: "C:/fixture/output",
    defaultRequirementsDir: () => {
      discoveries += 1;
      return "C:/fixture/requirements";
    },
  };

  assert.deepEqual(parseCliArgs(["--budget-ms", "0"], options), {
    requirementsDir: resolve("C:/fixture/requirements"),
    outputDir: resolve("C:/fixture/output"),
    budgetMs: 0,
  });
  assert.equal(discoveries, 1);

  const explicit = parseCliArgs(
    ["--requirements-dir", "C:/fixture/other", "--output-dir", "C:/fixture/output"],
    options,
  );
  assert.equal(explicit.requirementsDir, resolve("C:/fixture/other"));
  assert.equal(discoveries, 1, "显式 --requirements-dir 不应触发默认发现");
});

test("CLI still requires --requirements-dir without a discovery default", () => {
  assert.throws(
    () => parseCliArgs(["--output-dir", "C:/fixture/output"]),
    /--requirements-dir/,
  );
});

test("Default requirements discovery finds a single requirements.yaml below the root", async () => {
  await withTempDir("shallow-cli-discovery-", async (directory) => {
    const ignored = join(directory, "node_modules", "fixture");
    await mkdir(ignored, { recursive: true });
    await writeFile(join(ignored, "requirements.yaml"), "id: ROOT\n");
    assert.throws(() => discoverRequirementsDir(directory), /No requirements\.yaml/);

    const requirementsDir = join(directory, "nested", "requirements");
    await mkdir(requirementsDir, { recursive: true });
    await writeFile(join(requirementsDir, "requirements.yaml"), "id: ROOT\n");
    assert.equal(discoverRequirementsDir(directory), requirementsDir);
  });
});

test("Default requirements discovery rejects several candidates", async () => {
  await withTempDir("shallow-cli-discovery-", async (directory) => {
    for (const name of ["a", "b"]) {
      const requirementsDir = join(directory, name, "requirements");
      await mkdir(requirementsDir, { recursive: true });
      await writeFile(join(requirementsDir, "requirements.yaml"), "id: ROOT\n");
    }
    assert.throws(() => discoverRequirementsDir(directory), /Multiple requirements\.yaml/);
  });
});
